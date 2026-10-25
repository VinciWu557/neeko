//! git 元数据监听：合并进主 watcher 的**判定**与**回调构造**。
//!
//! **背景**：每个 workspace 原本有两条 FSEvents 流 —— 主 watcher 与 git_meta
//! watcher。macOS 的 `SubtreeExclusion` 后端递归订阅整个 root，而
//! `WatchManifest::compute` 跳过 `.git` 且**不放入 `ignored_roots`** ⇒ `.git`
//! 事件**已经送达**主 watcher，只是在回调层被 `is_hard_noise_path` 丢弃。
//! 因此合并 = 在丢弃前加一个分类分支，流数从 2N 降到 N。
//!
//! **为什么单独成模块**：合并判定是**规则**（哪些前置条件成立才允许合并），
//! 不是组装顺序。`manager/core.rs` 只应回答「按什么顺序调用谁」，故把规则
//! 下沉到这里，`core.rs` 拿到的只是一个 `Option<GitMetaCallbacks>`。
//!
//! **与独立流的关系**：`git_meta/watcher.rs` 仍保留独立流实现（Linux 等
//! 非递归后端必须用它）。两条路径共用同一套语义常量与判定函数，避免分叉。

use super::super::git_meta::resolve_git_meta_paths;
use super::callbacks::GitMetaCallbacks;
use crate::common::file::watcher::git_meta::GitMetaPaths;
use crate::common::file::watcher::sink::{WatcherEvent, WatcherEventSink};
use crate::common::file::watcher::types::GitChangedEvent;
use crate::common::git::WorkspaceRef;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};

/// git 元数据合并的运行时回滚开关。
///
/// 与 `NEEKO_DISABLE_FSEVENT_EXCLUSION` **刻意分离**：后者禁用物理排除（回退到
/// 纯回调过滤），本开关只禁用「git 元数据并入主 watcher」（回退到独立流）。
/// 两者失效面不同，共用一个开关会让排查时分不清是哪个机制出了问题。
const DISABLE_GIT_META_MERGE_ENV: &str = "NEEKO_DISABLE_GIT_META_MERGE";

fn merge_disabled() -> bool {
    std::env::var_os(DISABLE_GIT_META_MERGE_ENV).is_some()
}

/// 合并可行性判定结果。
pub(super) struct MergeDecision {
    /// 解析出的 git 元数据路径（`None` = 非 git 单元或解析失败）。
    pub(super) paths: Option<GitMetaPaths>,
    /// 是否合并进主 watcher。
    pub(super) merge: bool,
}

/// 判定是否可以把 git 元数据监听并入主 watcher。
///
/// 五个前置条件**全部成立**才合并：
///
/// 1. **git 项目且能解析出元数据路径** —— 否则无从监听；
/// 2. **后端是递归型**（`can_exclude_subtrees`）—— 只有它订阅整个 root，`.git`
///    事件才会送达。Linux 的 `SelectiveRegistration` 逐可见目录注册，`.git` 不在
///    `visible_dirs` 里，合并即丢失功能；
/// 3. **git 元数据目录位于订阅根之下** —— 决定性条件。`linked worktree` 不满足：
///    它的 `.git` 是指针文件，真实 gitdir 在主仓库的 `.git/worktrees/<name>/`，
///    位于工作树之外，事件**永远不会**出现在主 watcher 里。误判为可合并 →
///    不建独立流 → 该 worktree 的 HEAD/index/refs 变化永久丢失。
///
///    ⚠️ **不能用「路径含 `.git` 组件」判定** —— linked worktree 的真实 gitdir
///    虽含 `.git`，却不在订阅根内；
/// 4. **`.git` 不在 exclusion 列表中** —— 否则事件被内核排除，合并即静默失效。
///    当前 `WatchManifest::compute` 跳过 `.git` 且不放入 `ignored_roots`，故恒成立；
///    此处显式求值，把「结构假设」变成「可运行期验证的谓词」；
/// 5. **未设回滚开关** `NEEKO_DISABLE_GIT_META_MERGE`。
pub(super) fn decide(
    root: &Path,
    git_repo: bool,
    exclusions: &[PathBuf],
    backend_can_exclude: bool,
    workspace: &str,
) -> MergeDecision {
    let paths = if git_repo {
        resolve_git_meta_paths(root)
    } else {
        None
    };
    let Some(meta) = paths.as_ref() else {
        return MergeDecision {
            paths: None,
            merge: false,
        };
    };

    // ⚠️ **必须用归一化后的 root 比较**：`resolve_git_meta_paths` 内部对 git_dir
    // 做了 `canonicalize()`（notify 上报的是 realpath，macOS 上 `/var` →
    // `/private/var`）。若这里拿未归一的 `root` 做 `starts_with`，在符号链接路径
    // （`/var`、`/tmp`、外接盘、云同步目录）下**恒为 false** —— 合并会静默失效，
    // 表现为「无论怎么配都还是 2N 条流」。
    // 归一失败（罕见权限/删除竞态）退回原值：与 git_dir 的归一策略对称。
    let root_normalized = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let within_root = meta.git_dir.starts_with(&root_normalized);
    // 同理：`exclusions` 来自 `build_exclusion_paths(manifest.ignored_roots())`，
    // 而 `ignored_roots` 由 `read_dir` 产生、**未经 canonicalize**（见 manifest.rs）。
    // 与已归一的 `meta.git_dir` 直接比较在符号链接路径下恒为 false ⇒ 会误判
    // 「未被排除」而允许合并，结果事件被内核排除、合并静默失效。
    // 故两侧都归一到同一形态再比较。
    let excluded = exclusions.iter().any(|ex| {
        let ex_normalized = ex.canonicalize().unwrap_or_else(|_| ex.clone());
        meta.git_dir == ex_normalized || meta.git_dir.starts_with(&ex_normalized)
    });
    let env_off = merge_disabled();
    let merge = backend_can_exclude && within_root && !excluded && !env_off;

    if !merge {
        // 逐条打印否决原因：合并与否直接影响「流数 2N→N」的收益，
        // 静默降级会让「为什么还是 2N 条流」无从排查。
        log::debug!(
            "[Watcher:{}] keeping separate git-meta stream \
             (within_root={within_root} excluded={excluded} \
             backend_recursive={backend_can_exclude} env_off={env_off})",
            workspace
        );
    }

    MergeDecision {
        paths: paths.clone(),
        merge,
    }
}

/// 构造合并路径用的三条回调（语义与独立流 `create_git_meta_watcher` 一致）。
///
/// **单一构造点**：无论合并与否都由 `core.rs` 调本函数构造一次，再决定是
/// 塞进主回调还是丢弃。这样「index/refs 只发信号、head 才 emit 事实」这条
/// 语义只存在一处，不会在两条路径间分叉。
#[allow(clippy::too_many_arguments)]
pub(super) fn build_callbacks(
    workspace: &str,
    repo: &WorkspaceRef,
    paths: &GitMetaPaths,
    sink: Arc<dyn WatcherEventSink>,
    scheduler_tx: Option<mpsc::Sender<()>>,
) -> GitMetaCallbacks {
    let git_changed = GitChangedEvent::new(repo);

    let unit_index = workspace.to_string();
    let tx_index = scheduler_tx.clone();
    let unit_head = workspace.to_string();
    let tx_head = scheduler_tx.clone();
    let unit_refs = workspace.to_string();
    let tx_refs = scheduler_tx;

    GitMetaCallbacks {
        paths: paths.clone(),
        // 公理 1（信号≠事实）：index 写入只作为查询调度提示，交由 worker
        // 查询-比较后决定是否通知 —— 不无条件触发全量刷新（会与 git 命令写
        // index 形成自反馈回路）。
        on_index_changed: Box::new(move || {
            log::debug!(
                "[Watcher:{}] git index changed, hinting git status check",
                unit_index
            );
            if let Some(tx) = &tx_index {
                let _ = tx.send(());
            }
        }),
        // HEAD 变化 = 「分支已切换」这一事实本身，需 emit 驱动前端刷新。
        on_head_changed: Box::new(move || {
            log::debug!(
                "[Watcher:{}] HEAD changed, triggering git status",
                unit_head
            );
            if let Some(tx) = &tx_head {
                let _ = tx.send(());
            }
            sink.emit(WatcherEvent::GitChanged(&git_changed));
        }),
        // refs 变更（外部 push / fetch / 本地 commit）只发**信号**，不 emit 事实、
        // 不新增事件名（红线 5）—— 事实一律由 `git-status-snapshot` 携带。
        on_refs_changed: Box::new(move || {
            log::debug!(
                "[Watcher:{}] git refs changed, hinting git status check",
                unit_refs
            );
            if let Some(tx) = &tx_refs {
                let _ = tx.send(());
            }
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 判定谓词的核心：git 元数据目录是否在订阅根之下。
    ///
    /// 单独抽出为测试锚点 —— 这是 linked worktree 回归的唯一防线。
    fn within_root(git_dir: &Path, root: &Path) -> bool {
        git_dir.starts_with(root)
    }

    #[test]
    fn linked_worktree_git_dir_is_outside_root() {
        let tmp = tempfile::tempdir().unwrap();
        let main_root = tmp.path().join("main");
        let worktree_root = tmp.path().join("feat");
        // 实测布局：feat/.git 是指针文件，真实 gitdir 在主仓库内
        let worktree_git_dir = main_root.join(".git").join("worktrees").join("feat");

        assert!(
            !within_root(&worktree_git_dir, &worktree_root),
            "linked worktree 的 gitdir 在订阅根之外 → 必须拒绝合并"
        );
    }

    #[test]
    fn normal_repo_git_dir_is_inside_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        assert!(within_root(&root.join(".git"), &root));
    }

    #[test]
    fn non_git_unit_yields_no_paths_and_no_merge() {
        let tmp = tempfile::tempdir().unwrap();
        let d = decide(tmp.path(), false, &[], true, "ws");
        assert!(d.paths.is_none());
        assert!(!d.merge);
    }

    #[test]
    fn non_recursive_backend_never_merges() {
        // Linux 的 SelectiveRegistration 拿不到 `.git` 事件
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let d = decide(root, true, &[], false, "ws");
        assert!(d.paths.is_some(), "路径应能解析");
        assert!(!d.merge, "非递归后端必须保留独立流");
    }

    #[test]
    fn excluded_git_dir_blocks_merge() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let exclusions = vec![root.join(".git")];
        let d = decide(root, true, &exclusions, true, "ws");
        assert!(!d.merge, "`.git` 被物理排除时合并会静默失效");
    }

    /// 符号链接路径回归：`/var` → `/private/var`（macOS 上 tempdir 就是这种）。
    ///
    /// `resolve_git_meta_paths` 对 git_dir 做了 canonicalize，而 `root` /
    /// `exclusions` 都可能是未归一的原始形态。若比较时不归一，`starts_with`
    /// 恒为 false ⇒ 合并静默失效（表现：永远是 2N 条流）。
    /// 符号链接路径回归（unix）：`/var` → `/private/var`（macOS tempdir 即此形态）。
    ///
    /// 整测试级门控（红线 10）：符号链接本身是 unix 语义，Windows 无对应形态，
    /// 故整条测试按平台门控，而不是在函数体内做 fragment 级 `#[cfg]`。
    #[cfg(unix)]
    #[test]
    fn symlinked_root_still_merges_on_unix() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path();
        std::fs::create_dir_all(real.join(".git")).unwrap();
        std::fs::write(real.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();

        // 构造一条含符号链接的等价路径：<real>/link -> <real>
        let link = real.join("link");
        std::os::unix::fs::symlink(real, &link).unwrap();

        // 用未归一的 link 作为 root（模拟用户配了符号链接路径）
        let d = decide(&link, true, &[], true, "ws");
        assert!(d.paths.is_some(), "git 元数据应能从符号链接路径解析出来");
        assert!(
            d.merge,
            "root 与 git_dir 归一化后应判定为可合并（否则符号链接用户永远 2N 条流）"
        );
    }

    #[test]
    fn normal_repo_merges() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();

        let d = decide(root, true, &[], true, "ws");
        assert!(d.paths.is_some());
        assert!(d.merge, "普通仓库 + 递归后端 + 未排除 → 应合并");
    }
}
