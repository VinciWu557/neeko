//! git2 读路径：从 index unmerged stages 组装 [`ConflictStages`]。
//!
//! **必须在 `spawn_blocking` 内调用**（红线 3）：`Repository::open` / `find_blob` /
//! `merge_file_from_index` 全是同步 I/O 与 CPU。派发缝在 `operations::conflict`。
//!
//! 真值来源是 index stages，**不是工作区字节**（`design.md` §0）。rename/rename 的三条
//! unmerged 条目在 index 里没有关联，必须经 merge-base 两侧的重命名映射重新归组
//! （libgit2 的 `conflict_get(path)` 对 rename/rename 只能取到单侧，见 `probe.rs` 模块注释）。

use std::path::Path;

use anyhow::{bail, Context, Result};
use git2::{Delta, DiffFindOptions, IndexEntry, IndexTime, MergeFileOptions, Oid, Repository};

use super::probe::{
    assemble_stages, attach_regions, group_conflicts, needs_rename_maps, probe_bytes,
    ConflictGroup, ConflictSides, RawConflictEntry, RenameMap,
};
use super::types::{ConflictSide, ConflictStages};

/// 读一个冲突文件的三个 stage（git2 实现）。
///
/// 契约（与单文件 diff 三态契约同族，`design.md` §2.4）：
/// ① 该 path 无 unmerged 条目 → `Err`（语义 = 调用方应回退普通 diff，不是空冲突）；
/// ② 有 unmerged 条目 → 返回三侧现状，缺失 stage 以 `content: None` 表达；
/// ③ binary → `kind = Binary`，三侧不解码内容。
pub fn read(repo_path: &Path, file_path: &str) -> Result<ConflictStages> {
    let repo = Repository::open(repo_path).context("Failed to open git repository")?;
    let index = repo.index().context("Failed to read git index")?;
    if !index.has_conflicts() {
        bail!("path `{file_path}` has no unmerged entries");
    }

    let entries = collect_raw_entries(&index)?;
    // 重命名映射来自全仓 tree diff，只对 rename 系冲突有意义 —— 三侧同路径（常见 UU）时
    // 跳过（判据是纯函数 `needs_rename_maps`，跳错方向只会多跑一次 diff，不会分类错）。
    let (our_rename, their_rename) = if needs_rename_maps(&entries, file_path) {
        rename_maps(&repo)
    } else {
        (RenameMap::default(), RenameMap::default())
    };
    let groups = group_conflicts(entries, &our_rename, &their_rename);
    let group = groups
        .into_iter()
        .find(|g| g.contains_path(file_path))
        .with_context(|| format!("path `{file_path}` is not conflicted"))?;

    assemble(&repo, file_path, &group)
}

/// 从 index 收集全部 unmerged 条目（flatten libgit2 的关联分组，随后自行按重命名归组）。
fn collect_raw_entries(index: &git2::Index) -> Result<Vec<RawConflictEntry>> {
    let mut out = Vec::new();
    let mut conflicts = index
        .conflicts()
        .context("Failed to iterate index conflicts")?;
    for conflict in &mut conflicts {
        let conflict = conflict.context("Failed to read index conflict")?;
        push_entry(&mut out, 1, conflict.ancestor.as_ref());
        push_entry(&mut out, 2, conflict.our.as_ref());
        push_entry(&mut out, 3, conflict.their.as_ref());
    }
    Ok(out)
}

fn push_entry(out: &mut Vec<RawConflictEntry>, stage: u8, entry: Option<&IndexEntry>) {
    if let Some(entry) = entry {
        out.push(RawConflictEntry {
            stage,
            path: String::from_utf8_lossy(&entry.path).to_string(),
            oid: entry.id.to_string(),
            mode: entry.mode,
        });
    }
}

/// merge-base 两侧的重命名映射（best-effort：无 merge 在途 / 计算失败 → 空映射）。
fn rename_maps(repo: &Repository) -> (RenameMap, RenameMap) {
    let (Some(head), Some(other)) = (head_commit(repo), other_commit(repo)) else {
        return (RenameMap::default(), RenameMap::default());
    };
    let Ok(base) = repo.merge_base(head.id(), other.id()) else {
        return (RenameMap::default(), RenameMap::default());
    };
    let (Ok(base_commit), Ok(head_tree), Ok(other_tree)) =
        (repo.find_commit(base), head.tree(), other.tree())
    else {
        return (RenameMap::default(), RenameMap::default());
    };
    let Ok(base_tree) = base_commit.tree() else {
        return (RenameMap::default(), RenameMap::default());
    };
    (
        rename_map_for(repo, &base_tree, &head_tree),
        rename_map_for(repo, &base_tree, &other_tree),
    )
}

fn head_commit(repo: &Repository) -> Option<git2::Commit<'_>> {
    repo.head().ok()?.peel_to_commit().ok()
}

/// merge 的另一侧（MERGE_HEAD / CHERRY_PICK_HEAD / REVERT_HEAD，取第一个可解析者）。
fn other_commit(repo: &Repository) -> Option<git2::Commit<'_>> {
    ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]
        .into_iter()
        .find_map(|name| repo.revparse_single(name).ok()?.peel_to_commit().ok())
}

fn rename_map_for(
    repo: &Repository,
    base_tree: &git2::Tree<'_>,
    side_tree: &git2::Tree<'_>,
) -> RenameMap {
    let mut map = RenameMap::default();
    let Ok(mut diff) = repo.diff_tree_to_tree(Some(base_tree), Some(side_tree), None) else {
        return map;
    };
    let mut find = DiffFindOptions::new();
    find.renames(true);
    if diff.find_similar(Some(&mut find)).is_err() {
        return map;
    }
    for delta in diff.deltas() {
        if delta.status() != Delta::Renamed {
            continue;
        }
        if let (Some(old), Some(new)) = (delta.old_file().path(), delta.new_file().path()) {
            map.insert(
                old.to_string_lossy().to_string(),
                new.to_string_lossy().to_string(),
            );
        }
    }
    map
}

/// 把一个逻辑冲突组组装为 [`ConflictStages`]。
///
/// 形态与 `shell::read` 逐句对应：取三侧字节（传输相关）→ `assemble_stages`（共用语义）→
/// 可区域合并时取 merge 文本并 `attach_regions`（共用）。
fn assemble(repo: &Repository, file_path: &str, group: &ConflictGroup) -> Result<ConflictStages> {
    let sides = ConflictSides {
        ancestor: side_of(repo, group.ancestor.as_ref())?,
        ours: side_of(repo, group.ours.as_ref())?,
        theirs: side_of(repo, group.theirs.as_ref())?,
    };
    let mut stages = assemble_stages(file_path, group, sides);
    if stages.region_mergeable {
        attach_regions(&mut stages, merge_group(repo, group)?);
    }
    Ok(stages)
}

/// 逐侧读 blob 并探测（缺失 stage → `None`，**绝不归一为空串**）。
fn side_of(repo: &Repository, entry: Option<&RawConflictEntry>) -> Result<Option<ConflictSide>> {
    let Some(entry) = entry else {
        return Ok(None);
    };
    let oid = Oid::from_str(&entry.oid)
        .with_context(|| format!("invalid blob oid `{}` for `{}`", entry.oid, entry.path))?;
    let blob = repo
        .find_blob(oid)
        .with_context(|| format!("missing blob `{}` for `{}`", entry.oid, entry.path))?;
    let bytes = blob.content();
    let (is_binary, content) = probe_bytes(bytes);
    Ok(Some(ConflictSide {
        path: Some(entry.path.clone()),
        content,
        size: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
        is_binary,
        truncated: false,
    }))
}

/// 调 git2 merge 引擎产出 diff3 文本。
///
/// base 缺失（AA）时用**字面量构造的空 `IndexEntry`** 提交 merge（实测可用，`design.md` §0.2）：
/// 空占位只在 read 内部提交给引擎，**绝不泄漏到 wire**（API 层缺失 stage 报 `None`）。
fn merge_group(repo: &Repository, group: &ConflictGroup) -> Result<String> {
    let ours = group.ours.as_ref().context("ours stage missing")?;
    let theirs = group.theirs.as_ref().context("theirs stage missing")?;

    let base_entry = match group.ancestor.as_ref() {
        Some(base) => index_entry(repo, &base.path, &base.oid, base.mode)?,
        None => {
            let empty = repo.blob(b"").context("Failed to write empty blob")?;
            make_index_entry(&ours.path, empty, 0o100_644)
        }
    };
    let our_entry = index_entry(repo, &ours.path, &ours.oid, ours.mode)?;
    let their_entry = index_entry(repo, &theirs.path, &theirs.oid, theirs.mode)?;

    let mut opts = MergeFileOptions::new();
    opts.style_diff3(true);
    opts.ancestor_label("BASE");
    opts.our_label("HEAD");
    opts.their_label("THEIRS");

    let result = repo
        .merge_file_from_index(&base_entry, &our_entry, &their_entry, Some(&mut opts))
        .context("Failed to merge conflict stages")?;
    Ok(String::from_utf8_lossy(result.content()).to_string())
}

fn index_entry(repo: &Repository, path: &str, oid_hex: &str, mode: u32) -> Result<IndexEntry> {
    let oid = Oid::from_str(oid_hex)
        .with_context(|| format!("invalid blob oid `{oid_hex}` for `{path}`"))?;
    // 校验 blob 存在（与 side_of 同判据）。
    repo.find_blob(oid)
        .with_context(|| format!("missing blob `{oid_hex}` for `{path}`"))?;
    Ok(make_index_entry(path, oid, mode))
}

fn make_index_entry(path: &str, oid: Oid, mode: u32) -> IndexEntry {
    IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode,
        uid: 0,
        gid: 0,
        file_size: 0,
        id: oid,
        flags: 0,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
}
