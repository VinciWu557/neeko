//! 远端（WSL / SSH）读路径：从 `git ls-files -u` + `git cat-file blob` 取三侧，再按需调
//! `git merge-file` 产出 diff3 区域。
//!
//! 与 `local.rs` 同契约（`design.md` §2.4）：真值来自 index stages，绝不使用工作区文件做
//! merge 输入。`ls-files -u -z` 用 **NUL 分隔**避免路径 C 转义（`git-domain.md` §8）。
//! rename/rename 的归组复用 `probe::group_conflicts`（重命名映射由 `git diff -M` 得到）。

use anyhow::{bail, Context, Result};
use git2::Oid;

use crate::common::git::transport::{GitExecOptions, GitTransport};

use super::probe::{
    assemble_stages, attach_regions, group_conflicts, needs_rename_maps, probe_bytes,
    ConflictGroup, ConflictSides, RawConflictEntry, RenameMap,
};
use super::types::{ConflictSide, ConflictStages};

/// 读一个冲突文件的三个 stage（shell 实现，WSL / SSH）。
pub async fn read(
    transport: &dyn GitTransport,
    work_dir: &str,
    file_path: &str,
) -> Result<ConflictStages> {
    let output = transport
        .run_git(&["ls-files", "-u", "-z"], work_dir)
        .await?;
    let entries = parse_unmerged(&output);
    if entries.is_empty() {
        bail!("path `{file_path}` has no unmerged entries");
    }
    let (our_rename, their_rename) = if needs_rename_maps(&entries, file_path) {
        rename_maps(transport, work_dir).await
    } else {
        // 三侧同路径（常见 UU）⇒ 两侧都没重命名，全仓 tree diff 是白跑（判据见
        // `probe::needs_rename_maps`：跳错方向只多跑一次 diff，不会分类错）。
        (RenameMap::default(), RenameMap::default())
    };
    let group = group_conflicts(entries, &our_rename, &their_rename)
        .into_iter()
        .find(|g| g.contains_path(file_path))
        .with_context(|| format!("path `{file_path}` is not conflicted"))?;

    // 形态与 `local::assemble` 逐句对应：取三侧字节（传输相关）→ `assemble_stages`
    // （共用语义）→ 可区域合并时取 merge 文本并 `attach_regions`（共用）。
    let sides = ConflictSides {
        ancestor: side_of(transport, work_dir, group.ancestor.as_ref()).await?,
        ours: side_of(transport, work_dir, group.ours.as_ref()).await?,
        theirs: side_of(transport, work_dir, group.theirs.as_ref()).await?,
    };
    let mut stages = assemble_stages(file_path, &group, sides);
    if stages.region_mergeable {
        attach_regions(&mut stages, merge_group(transport, work_dir, &group).await?);
    }

    Ok(stages)
}

/// 解析 `git ls-files -u -z`：每条 `<mode> <oid> <stage>\t<path>\0`。
fn parse_unmerged(output: &str) -> Vec<RawConflictEntry> {
    let mut out = Vec::new();
    for record in output.split('\0') {
        if record.is_empty() {
            continue;
        }
        let Some((meta, path)) = record.split_once('\t') else {
            continue;
        };
        let mut fields = meta.split_whitespace();
        let (Some(mode), Some(oid), Some(stage)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let Ok(mode) = u32::from_str_radix(mode, 8) else {
            continue;
        };
        let Ok(stage) = stage.parse::<u8>() else {
            continue;
        };
        out.push(RawConflictEntry {
            stage,
            path: path.to_string(),
            oid: oid.to_string(),
            mode,
        });
    }
    out
}

/// 逐 side 读 blob 字节并探测（缺失 stage → `None`）。
///
/// `size` 必须报**原始字节数**（与 `local.rs` 的 `blob.content().len()` 同口径）：
/// `run_git` 只返回 lossy `String`，含非法 UTF-8 的 blob 其 lossy 长度会膨胀
/// （实测 `\x00\xff\x01` 侧 lossy=9 / 原始=7），直接 `output.len()` 会让两 transport 报出
/// 不同 `size`。故原始长度另经 `git cat-file -s <oid>` 取（只返回十进制字节数，不走解码）。
async fn side_of(
    transport: &dyn GitTransport,
    work_dir: &str,
    entry: Option<&RawConflictEntry>,
) -> Result<Option<ConflictSide>> {
    let Some(entry) = entry else {
        return Ok(None);
    };
    let output = transport
        .run_git(&["cat-file", "blob", &entry.oid], work_dir)
        .await
        .with_context(|| format!("Failed to read blob `{}`", entry.oid))?;
    let size = blob_size(transport, work_dir, &entry.oid).await?;
    let (is_binary, content) = probe_bytes(output.as_bytes());
    Ok(Some(ConflictSide {
        path: Some(entry.path.clone()),
        content,
        size,
        is_binary,
        truncated: false,
    }))
}

/// `git cat-file -s <oid>`：blob 的原始字节数（不受 lossy 解码影响）。
async fn blob_size(transport: &dyn GitTransport, work_dir: &str, oid: &str) -> Result<u64> {
    let out = transport
        .run_git(&["cat-file", "-s", oid], work_dir)
        .await
        .with_context(|| format!("Failed to read blob size for `{oid}`"))?;
    out.trim()
        .parse::<u64>()
        .with_context(|| format!("invalid blob size `{}` for `{oid}`", out.trim()))
}

/// merge-base 两侧的重命名映射（best-effort：无 merge 在途 / 命令失败 → 空映射）。
async fn rename_maps(transport: &dyn GitTransport, work_dir: &str) -> (RenameMap, RenameMap) {
    let Some(base) = merge_base(transport, work_dir).await else {
        return (RenameMap::default(), RenameMap::default());
    };
    let Some(other) = other_commit(transport, work_dir).await else {
        return (RenameMap::default(), RenameMap::default());
    };
    let our = rename_map_for(transport, work_dir, &base, "HEAD").await;
    let their = rename_map_for(transport, work_dir, &base, &other).await;
    (our, their)
}

async fn merge_base(transport: &dyn GitTransport, work_dir: &str) -> Option<String> {
    let other = other_commit(transport, work_dir).await?;
    let out = transport
        .run_git(&["merge-base", "HEAD", &other], work_dir)
        .await
        .ok()?;
    let trimmed = out.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// merge 的另一侧：MERGE_HEAD → CHERRY_PICK_HEAD → REVERT_HEAD（取第一个可解析者）。
///
/// 逐个按 `if let Ok` 探测：不存在的 ref 会让 `rev-parse --verify --quiet` 以非零退出（`Err`），
/// 必须**继续尝试下一个**候选。用 `?`/`.ok()?` 会在第一个缺失的 ref 上直接返回 `None`，
/// 于是 cherry-pick / revert 场景（无 MERGE_HEAD）永远取不到另一侧 → 重命名映射为空 →
/// rename/rename 冲突退化成 modify_delete（实测：两 transport 分叉）。
async fn other_commit(transport: &dyn GitTransport, work_dir: &str) -> Option<String> {
    for name in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"] {
        if let Ok(out) = transport
            .run_git(&["rev-parse", "--verify", "--quiet", name], work_dir)
            .await
        {
            let trimmed = out.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

async fn rename_map_for(
    transport: &dyn GitTransport,
    work_dir: &str,
    base: &str,
    side: &str,
) -> RenameMap {
    let mut map = RenameMap::default();
    let Ok(out) = transport
        .run_git(&["diff", "--name-status", "-z", "-M", base, side], work_dir)
        .await
    else {
        return map;
    };
    let records: Vec<&str> = out.split('\0').collect();
    let mut i = 0usize;
    while i < records.len() {
        let status = records[i];
        if status.starts_with('R') && i + 2 < records.len() {
            map.insert(records[i + 1].to_string(), records[i + 2].to_string());
            i += 3;
        } else if !status.is_empty() && i + 1 < records.len() {
            i += 2;
        } else {
            i += 1;
        }
    }
    map
}

/// `git merge-file -p --object-id --diff3`：**exit code = 冲突数，非零不是错误**。
async fn merge_group(
    transport: &dyn GitTransport,
    work_dir: &str,
    group: &ConflictGroup,
) -> Result<String> {
    let ours = group.ours.as_ref().context("ours stage missing")?;
    let theirs = group.theirs.as_ref().context("theirs stage missing")?;
    let base_oid = match group.ancestor.as_ref() {
        Some(base) => base.oid.clone(),
        None => empty_blob_oid(transport, work_dir).await?,
    };
    match transport
        .run_git(
            &[
                "merge-file",
                "-p",
                "--object-id",
                "--diff3",
                "-L",
                "HEAD",
                "-L",
                "BASE",
                "-L",
                "THEIRS",
                &ours.oid,
                &base_oid,
                &theirs.oid,
            ],
            work_dir,
        )
        .await
    {
        Ok(text) => Ok(text),
        // 非零退出 = 冲突数（merge 未自动合并）。仅当输出含冲突 marker 才视为「有冲突」；
        // 真正错误（oid 缺失 / 参数非法）无 marker，上抛。
        Err(err) => {
            if let Some(git_err) = err.downcast_ref::<crate::common::git::transport::GitExecError>()
            {
                // marker 知识只在 `regions.rs`（护栏 A1）；此处只问「是不是冲突输出」。
                if super::regions::has_conflict_markers(&git_err.stdout) {
                    return Ok(git_err.stdout.clone());
                }
            }
            Err(err).context("Failed to run git merge-file")
        }
    }
}

/// 空 blob 的 oid（AA 的空 base 占位；不落 object DB）。
///
/// **用 `--stdin` 喂零字节，不用 `/dev/null`**：后者是 POSIX 设备名，Windows 上根本不存在，
/// `git hash-object -t blob /dev/null` 会直接失败 —— 而 shell 分支的 CI 矩阵含
/// windows-latest（`.github/workflows/ci.yml` 的 backend-test），AA 冲突因此会在 Windows
/// 上读不出三侧。仓内同形先例：`transport/tests.rs::run_git_with_stdin`、`credential.rs`。
/// 护栏 A5（`check_conflict_read_contract`）钉住本目录不得再现 `/dev/null` 字面量。
async fn empty_blob_oid(transport: &dyn GitTransport, work_dir: &str) -> Result<String> {
    let out = transport
        .run_git_with_stdin(
            &["hash-object", "-t", "blob", "--stdin"],
            work_dir,
            GitExecOptions::default(),
            b"",
        )
        .await
        .context("Failed to hash empty blob")?;
    let oid = out.trim().to_string();
    // 校验 hex（防止把错误输出当 oid 传递）。
    Oid::from_str(&oid).context("empty blob oid is not a valid git oid")?;
    Ok(oid)
}
