//! 冲突的**读路径 + 决议写回**派发缝（与 `operations::get_file_diff` 同形）。
//!
//! 红线 4 的**唯一封顶出口**在 `read_conflict_stages` 末尾：任何 transport 的 [`ConflictStages`]
//! 都必须过 `cap_conflict_payload` 才返回（新增 transport 自动受约束）。
//! 决议写回（`apply_conflict_resolution`）的三条原语与分派判据见 `git-domain.md` §5d。

use anyhow::{Context, Result};

use crate::common::git::conflict::types::{
    ConflictKind, ConflictResolution, ConflictStages, TakeSide,
};
use crate::common::git::conflict::validate_region_decisions;
use crate::common::git::conflict::{cap_conflict_payload, local, shell, splice_regions};
use crate::common::git::transport::GitTransport;

/// 读一个冲突文件的三个 stage。
///
/// 契约（与单文件 diff 三态契约同族，`design.md` §2.4）：
/// ① path 无 unmerged 条目 → `Err`（语义 = 调用方回退普通 diff，不是空冲突）；
/// ② 有 unmerged 条目 → 返回三侧现状，缺失 stage 以 `content: None` 表达；
/// ③ binary → `kind = Binary`，三侧不解码内容。
///
/// 路径安全（红线 8）由命令层完成；本函数只做 I/O 与语义组装。
pub async fn read_conflict_stages(
    transport: &dyn GitTransport,
    work_dir: &str,
    file_path: &str,
) -> Result<ConflictStages> {
    let stages = match transport.open_repo_async(work_dir).await {
        // 红线 3：git2 同步 + blob 探测 + merge 引擎整体隔离到阻塞池。
        Some(_repo) => {
            let work_dir_owned = work_dir.to_string();
            let file_path_owned = file_path.to_string();
            tokio::task::spawn_blocking(move || {
                local::read(std::path::Path::new(&work_dir_owned), &file_path_owned)
            })
            .await
            .map_err(|e| anyhow::anyhow!("git conflict read task join error: {e}"))??
        }
        None => shell::read(transport, work_dir, file_path).await?,
    };
    // 红线 4：三元载荷封顶（唯一出口）。
    Ok(cap_conflict_payload(stages))
}

/// 应用一处冲突决议（区域级或整文件级）。
///
/// 契约：成功后该 path 的 unmerged 条目消失（判据：`git ls-files -u -- <path>` 为空）；
/// 失败时不保证原子性（写文件与 `git add` 是两步），调用方依赖后续快照事件收敛。
///
/// 分派落点全部在此（红线 6：命令层只校验 + 调度）：
/// - `Regions`：仅 `is_region_mergeable()` 的 kind 合法；用服务端重读的 `merged` 按
///   `merged_start/end` 逆序 splice（不信前端行号）；载荷被截断时显式拒绝（半截 merged 下标不自洽）。
/// - `WholeFile`：**按该侧 stage 是否存在**分派（不是按 `content` 是否存在 —— binary 侧的
///   `content` 也是 `None`，但它是一个存在的实体）。存在 → `checkout_side`（git 直接拷完整
///   blob，字节保真、与解码/截断无关）；缺失 → `delete_path`（采用删除侧）。
/// - `RenameRename` + `WholeFile`：三侧路径各不相同，单条决议无法闭合整组 ⇒ 显式拒绝。
///
/// rebase 语义（父任务 T4）：`--ours/--theirs` 在 rebase 下含义相反；本函数按 merge 语义实现，
/// rebase 场景不在本任务范围。
pub async fn apply_conflict_resolution(
    transport: &dyn GitTransport,
    work_dir: &str,
    file_path: &str,
    resolution: ConflictResolution,
) -> Result<()> {
    // 重读 index stages（唯一真值来源；不信前端行号）。返回已过 cap。
    let stages = read_conflict_stages(transport, work_dir, file_path).await?;

    match resolution {
        ConflictResolution::Regions { decisions } if stages.kind.is_region_mergeable() => {
            if stages.truncated {
                anyhow::bail!(
                    "conflict payload truncated; resolve the whole file instead of regions"
                );
            }
            // 区域决议是全函数：id 集合必须与后端重读的 regions 恰好相等（无未知 / 无缺失 /
            // 无重复）。否则 `git add` 会把「仍含 marker 的半截文件」标成已解决（可被提交）。
            validate_region_decisions(&stages.regions, &decisions)?;
            let merged = stages
                .merged
                .as_deref()
                .context("merged text missing for a region-mergeable conflict")?;
            let text = splice_regions(merged, &stages.regions, &decisions);
            write_text(transport, work_dir, file_path, &text).await?;
        }
        ConflictResolution::Regions { .. } => {
            // 不可区域合并的 kind（modify_delete / binary / rename_rename）收到区域决议：
            // 显式拒绝，不静默降级。
            anyhow::bail!(
                "region-level resolution is not applicable to {:?}",
                stages.kind
            );
        }
        ConflictResolution::WholeFile { take } => {
            if stages.kind == ConflictKind::RenameRename {
                // 三侧路径不同，单条 path 的决议无法闭合整组（实测 unmerged 仍剩 2 条）。
                anyhow::bail!("rename/rename resolution is not supported");
            }
            match stages.side_of(take) {
                // 存在侧：git 自拷完整 blob（binary 无损、与 cap 截断无关）。
                Some(_) => checkout_side(transport, work_dir, file_path, take).await?,
                // 缺失侧 = 采用删除（不是写空文件）。
                None => delete_path(transport, work_dir, file_path).await?,
            }
        }
    }
    Ok(())
}

/// 写入**我们自己拼出的文本**（区域 splice 的产物）→ `git add -- <path>`。
///
/// 只用于「文本由我们算出」的路径。整文件决议绝不用它 —— `ConflictSide.content` 是读 API 的
/// 解码视图（binary 为 `None`、超预算被截断），拿它写回会损坏文件。
async fn write_text(
    transport: &dyn GitTransport,
    work_dir: &str,
    path: &str,
    text: &str,
) -> Result<()> {
    let target = transport.exec_target();
    crate::common::file::services::write_file_content(&target, work_dir, path, text.to_string())
        .await
        .map_err(|e| anyhow::anyhow!("failed to write conflict resolution: {e}"))?;
    stage(transport, work_dir, path).await
}

/// 「这个文件应该是该侧 stage 的字节」：`git checkout --ours|--theirs -- <path>` → `git add`。
///
/// `checkout` 单独**不**清 unmerged（实测仍留 3 条 stage），必须跟一次 `git add`。
/// **前提**：该侧 stage 存在（调用方已按 stage 存在性分派）—— 对缺失 stage 调用会报
/// `does not have our/their version`（实测）。
async fn checkout_side(
    transport: &dyn GitTransport,
    work_dir: &str,
    path: &str,
    take: TakeSide,
) -> Result<()> {
    let flag = match take {
        TakeSide::Ours => "--ours",
        TakeSide::Theirs => "--theirs",
    };
    transport
        .run_git(&["checkout", flag, "--", path], work_dir)
        .await?;
    stage(transport, work_dir, path).await
}

/// 删除该 path（同时清 index 与工作区）—— 与「写空文件」语义不同。
async fn delete_path(transport: &dyn GitTransport, work_dir: &str, path: &str) -> Result<()> {
    transport.run_git(&["rm", "--", path], work_dir).await?;
    Ok(())
}

/// 暂存该 path（`git add`，与 `useGitActions.handleStageFile` 同一条路径）。
async fn stage(transport: &dyn GitTransport, work_dir: &str, path: &str) -> Result<()> {
    crate::common::git::operations::stage_files(transport, work_dir, &[path.to_string()]).await
}
