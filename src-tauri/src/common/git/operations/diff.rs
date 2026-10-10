// Git operations — diff sub-module (split from operations.rs God File).

use super::has_head;
use crate::common::executor::factory::ExecTarget;
use crate::common::git::transport::GitTransport;
use crate::common::git::types::{DiffHunk, DiffLine, DiffResult};
use crate::core::exec::collect;
use crate::project::types::FileDiffStats;
use anyhow::Result;

/// 返回指定文件相对 HEAD 的 unified diff（超行数上限时截断并附 `--stat` 摘要）。
pub async fn get_diff_for_files(
    transport: &dyn GitTransport,
    work_dir: &str,
    file_paths: &[String],
    line_limit: usize,
) -> Result<String> {
    if file_paths.is_empty() {
        return Ok(String::new());
    }
    let mut args = vec!["diff", "HEAD", "--"];
    args.extend(file_paths.iter().map(|s| s.as_str()));
    let diff_text = transport.run_git(&args, work_dir).await?;
    let lines: Vec<&str> = diff_text.lines().collect();
    if lines.len() <= line_limit {
        Ok(diff_text)
    } else {
        let truncated: String = lines[..line_limit].join("\n");
        let stat_args = {
            let mut sa = vec!["diff", "HEAD", "--stat", "--"];
            sa.extend(file_paths.iter().map(|s| s.as_str()));
            sa
        };
        let stat = transport.run_git(&stat_args, work_dir).await?;
        Ok(format!(
            "{}\n\n[diff truncated at {} lines]\n\nFile change summary:\n{}",
            truncated,
            line_limit,
            stat.trim()
        ))
    }
}

/// Get staged diff: `git diff --cached`
pub async fn get_staged_diff(
    transport: &dyn GitTransport,
    work_dir: &str,
    line_limit: usize,
) -> Result<String> {
    // 只读语义由执行层单点注入（见 `common::executor::env_defaults`），此处不再逐点补 opts
    // （`.trellis/spec/backend/git-domain.md` §9）；测试护栏见 `transport/tests.rs`。
    let diff_text = transport.run_git(&["diff", "--cached"], work_dir).await?;
    let lines: Vec<&str> = diff_text.lines().collect();
    if lines.len() <= line_limit {
        Ok(diff_text)
    } else {
        let truncated: String = lines[..line_limit].join("\n");
        let stat = transport
            .run_git(&["diff", "--cached", "--stat"], work_dir)
            .await?;
        Ok(format!(
            "{}\n\n[diff truncated at {} lines]\n\nFile change summary:\n{}",
            truncated,
            line_limit,
            stat.trim()
        ))
    }
}

// ─── Info operations (shell-based, works for all transports) ─────────────────

/// Get file diff for a worktree path (shell-based)
///
/// 与 local（git2）分支同语义：**工作区 vs HEAD**（含 staged + unstaged）。
/// 未跟踪文件不出现在 `git diff HEAD` 中，必须靠 `git ls-files --others` 显式判定后
/// 才补 `Added` 行 —— 禁止再把「hunks 为空」当成「新文件」（已跟踪且干净同样为空）。
pub(crate) async fn get_file_diff_shell(
    transport: &dyn GitTransport,
    work_dir: &str,
    file_path: &str,
    collapse: bool,
) -> Result<DiffResult> {
    // ctx/flags + `--` + path 与「是否带 HEAD」无关，抽成 tail 供两条基线复用
    // （unborn HEAD 时 `git diff HEAD` 报错，退回工作区 vs index，与 local 的
    // `diff_index_to_workdir(None)` 同义）。
    let mut tail: Vec<String> = Vec::new();
    if collapse {
        tail.push("-U3".to_string());
    } else {
        // 全量护栏：按文件字节数生成 -U 参数，防止 IPC JSON 超 2MB
        let file_bytes = tokio::fs::metadata(std::path::Path::new(work_dir).join(file_path))
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        tail.push(crate::common::git::parsers::full_diff_context_arg(
            file_bytes,
        ));
    }
    tail.push("--".to_string());
    tail.push(file_path.to_string());

    let head_args: Vec<&str> = std::iter::once("diff")
        .chain(std::iter::once("HEAD"))
        .chain(tail.iter().map(String::as_str))
        .collect();
    let output = match transport.run_git(&head_args, work_dir).await {
        Ok(output) => output,
        Err(head_err) => {
            // 只有确认 HEAD 不存在（unborn）才降级 index 基线；其余错误（认证 / 超时 /
            // 权限）原样上抛，不得吞成空 diff。判定走确定性 exit code（§11），不嗅探 stderr。
            if has_head(transport, work_dir).await? {
                return Err(head_err);
            }
            let no_head_args: Vec<&str> = std::iter::once("diff")
                .chain(tail.iter().map(String::as_str))
                .collect();
            transport.run_git(&no_head_args, work_dir).await?
        }
    };

    let mut result = crate::common::git::parsers::parse_unified_diff(&output);
    if result.hunks.is_empty() {
        maybe_add_untracked_hunk(transport, work_dir, file_path, &mut result).await;
    }
    if collapse {
        crate::common::git::parsers::collapse_diff_context(&mut result.hunks, 12);
    }
    Ok(result)
}

/// 仅当 `file_path` 确为**未跟踪**（`git ls-files --others` 命中）时，读工作区字节补一个全 `Added` hunk。
///
/// 已跟踪但相对 HEAD 干净的文件 diff 同样为空，此处必须保持 `result` 不动 —— 这是
/// 「已提交代码仍显示全绿边」的根因修复点。本函数**不可能失败**（探测失败即静默放弃，
/// 宁缺不伪），故返回 `()`。读取是阻塞 I/O，隔离到 OS 阻塞线程池（规则 #3）。
async fn maybe_add_untracked_hunk(
    transport: &dyn GitTransport,
    work_dir: &str,
    file_path: &str,
    result: &mut DiffResult,
) {
    // 无法确认「未跟踪」就不补 Added（宁缺不伪）：ls-files 失败时静默降级，
    // 不让一次探测失败把已经成功的 diff 结果变成整条命令报错。
    let Ok(untracked) = transport
        .run_git(
            &[
                "ls-files",
                "--others",
                "--exclude-standard",
                "--",
                file_path,
            ],
            work_dir,
        )
        .await
    else {
        return;
    };
    if untracked.trim().is_empty() {
        return;
    }

    let path = std::path::Path::new(work_dir).join(file_path);
    let content = crate::common::runtime::run_blocking(move || {
        if path.is_file() {
            std::fs::read_to_string(&path).ok()
        } else {
            None
        }
    })
    .await
    .ok()
    .flatten();
    let Some(content) = content else {
        return;
    };

    let lines: Vec<DiffLine> = content
        .lines()
        .map(|line| DiffLine::Added(line.to_string()))
        .collect();
    if lines.is_empty() {
        return;
    }
    #[allow(clippy::cast_possible_truncation)]
    result.hunks.push(DiffHunk {
        old_start: 0,
        old_lines: 0,
        new_start: 1,
        new_lines: lines.len() as u32,
        lines,
    });
}

/// Get changed files diff stats (additions/deletions) for local
pub async fn get_changed_files_diff_stats_local(work_dir: &str) -> Result<Vec<FileDiffStats>> {
    let unstaged = collect(
        &ExecTarget::Local,
        "git",
        &["diff", "--numstat"],
        Some(work_dir),
    )
    .await?;
    let staged = collect(
        &ExecTarget::Local,
        "git",
        &["diff", "--cached", "--numstat"],
        Some(work_dir),
    )
    .await?;

    let mut stats: Vec<FileDiffStats> = Vec::new();
    let mut tracked_paths: std::collections::HashSet<String> = std::collections::HashSet::new();

    for line in String::from_utf8_lossy(&unstaged.stdout).lines() {
        if let Some((add, del, path)) = crate::common::git::parsers::parse_numstat_line(line) {
            tracked_paths.insert(path.clone());
            stats.push(FileDiffStats {
                path: std::path::PathBuf::from(&path),
                additions: add,
                deletions: del,
            });
        }
    }

    for line in String::from_utf8_lossy(&staged.stdout).lines() {
        if let Some((add, del, path)) = crate::common::git::parsers::parse_numstat_line(line) {
            if let Some(existing) = stats.iter_mut().find(|s| s.path.to_string_lossy() == path) {
                existing.additions += add;
                existing.deletions += del;
            } else {
                tracked_paths.insert(path.clone());
                stats.push(FileDiffStats {
                    path: std::path::PathBuf::from(&path),
                    additions: add,
                    deletions: del,
                });
            }
        }
    }

    let untracked = collect(
        &ExecTarget::Local,
        "git",
        &["ls-files", "--others", "--exclude-standard"],
        Some(work_dir),
    )
    .await?;
    for file_path in String::from_utf8_lossy(&untracked.stdout).lines() {
        let file_path = file_path.trim();
        if file_path.is_empty() || tracked_paths.contains(file_path) {
            continue;
        }
        let path = std::path::Path::new(work_dir).join(file_path);
        // `exists` / 逐行计数都是阻塞 I/O —— 隔离到 OS 阻塞线程池（规则 #3）。
        let line_count = crate::common::runtime::run_blocking(move || {
            if !path.is_file() {
                return 0;
            }
            std::fs::read_to_string(&path)
                .map(|c| c.lines().count())
                .unwrap_or(0)
        })
        .await
        .unwrap_or(0);
        stats.push(FileDiffStats {
            path: std::path::PathBuf::from(file_path),
            additions: line_count,
            deletions: 0,
        });
    }

    Ok(stats)
}

// ── Optimized dispatch: git2 when available, shell fallback ────────────────

/// Get git info. Uses git2 for local transports, shell fallback otherwise.
pub async fn get_changed_files_diff_stats(
    transport: &dyn GitTransport,
    work_dir: &str,
) -> Result<Vec<FileDiffStats>> {
    if transport.open_repo_async(work_dir).await.is_some() {
        let work_dir_owned = work_dir.to_string();
        tokio::task::spawn_blocking(move || {
            crate::common::git::local::get_changed_files_diff_stats(std::path::Path::new(
                &work_dir_owned,
            ))
        })
        .await
        .map_err(|e| anyhow::anyhow!("git diff stats task join error: {e}"))?
    } else {
        get_changed_files_diff_stats_local(work_dir).await
    }
}

/// Get file diff for a worktree path. Uses git2 for local transports,
/// shell fallback otherwise.
///
/// **单文件 diff 三态契约**（`git-domain.md` §5，与 transport / 实现无关，新增实现必须遵守）：
/// ① 已跟踪且相对 HEAD 无改动 → `hunks` 为空；② 已跟踪且有改动 → 对应 hunk；
/// ③ 未跟踪 / 新文件 → 全部 `Added`。**空 hunk 只表示 ①，绝不等于 ③**。
/// 两条实现（`local::get_file_diff` / `get_file_diff_shell`）必须行为一致。
pub async fn get_file_diff(
    transport: &dyn GitTransport,
    work_dir: &str,
    file_path: &str,
    collapse: bool,
) -> Result<DiffResult> {
    let result = match transport.open_repo_async(work_dir).await {
        Some(_repo) => {
            let work_dir_owned = work_dir.to_string();
            let file_path_owned = file_path.to_string();
            tokio::task::spawn_blocking(move || {
                crate::common::git::local::get_file_diff(
                    std::path::Path::new(&work_dir_owned),
                    &file_path_owned,
                    collapse,
                )
            })
            .await
            .map_err(|e| anyhow::anyhow!("git file diff task join error: {e}"))??
        }
        None => get_file_diff_shell(transport, work_dir, file_path, collapse).await?,
    };
    // 红线 4：单次 IPC 载荷封顶（context 护栏不约束 added/removed 行，未跟踪新文件尤甚）。
    Ok(crate::common::git::parsers::cap_diff_payload(result))
}
