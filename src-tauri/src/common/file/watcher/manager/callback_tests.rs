//! A 层回调测试：直接喂合成 `notify::Event` 给 `build_notify_callback`。
//!
//! **为什么不走真实 FSEvents**：`build_notify_callback` 的 9 个参数全是 channel /
//! trait object / 纯值，返回 `impl FnMut(Result<Event, _>)` —— 它本身就是纯函数。
//! 原先所有测试都从「真实文件变更」进入，绕 FSEvents 投递 → 内核 → debounce 线程
//! 三层异步，只为验证这一层的行为（实测代价：27 条并发流让 fseventsd 到 95%+）。
//!
//! **本文件的约束**：
//! - 零 `std::thread::sleep` —— 同步调用回调，同步断言；
//! - 不建任何 watcher / 不碰真实 git 仓库（`GitIgnoreFilter` 只需 tempdir 里的
//!   `.gitignore` 文本，不建流）。
//!
//! 需要验证「事件确实从内核到达」的用例不在本文件（那是 C 层，见 `lifecycle_tests`）。

use super::callbacks::build_notify_callback;
use crate::common::executor::factory::ExecTarget;
use crate::common::file::watcher::gitignore::GitIgnoreFilter;
use crate::common::file::watcher::registration::WatchMaintenance;
use crate::common::file::watcher::sink::test_support::CollectingSink;
use crate::common::file::watcher::types::FILE_TREE_CHANGED_EVENT;
use crate::common::git::WorkspaceRef;
use notify::event::{CreateKind, DataChange, ModifyKind};
use notify::{Event, EventKind};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};

/// 回调测试的完整夹具：全部 channel + sink，**无 watcher**。
struct CallbackHarness {
    callback: Box<dyn FnMut(Result<Event, notify::Error>)>,
    sink: Arc<CollectingSink>,
    maintenance_rx: mpsc::Receiver<WatchMaintenance>,
    debounce_rx: mpsc::Receiver<PathBuf>,
    tree_rx: mpsc::Receiver<PathBuf>,
    scheduler_rx: mpsc::Receiver<()>,
}

impl CallbackHarness {
    fn new(root: &Path, git_repo: bool) -> Self {
        Self::with_filter(root, git_repo, true)
    }

    /// `with_filter=false` 时传 `None`，即**非 git 单元**路径 —— 此时
    /// `relevant_event_paths` 走 `is_hard_noise_path` 分支（`classify.rs:9-20`）。
    /// 这是唯一能真正验证 `classify.rs` 自身 hard-noise 判据的形态；
    /// 传 `Some(filter)` 时该判据由 `GitIgnoreFilter::should_ignore` 内部承担
    /// （`gitignore.rs:242`），测的是另一层。
    fn with_filter(root: &Path, git_repo: bool, use_filter: bool) -> Self {
        Self::with_git_meta(root, git_repo, use_filter, None)
    }

    /// 同 [`Self::with_filter`]，但启用**合并路径**的 git 元数据分支。
    ///
    /// 传 `Some(paths)` 时，回调内部会按生产顺序构造三条 git 元数据回调
    /// （`git_meta_merge::build_callbacks`，与 `core.rs` 同一构造点），
    /// 并复用本 harness 自己的 `scheduler_tx` —— 这样「index → 调度信号」
    /// 与「head → emit 事实」都能在 `scheduler_rx` / `sink` 上断言。
    fn with_git_meta(
        root: &Path,
        git_repo: bool,
        use_filter: bool,
        git_meta_paths: Option<crate::common::file::watcher::git_meta::GitMetaPaths>,
    ) -> Self {
        let repo = WorkspaceRef::resolve("p1", &root.to_string_lossy(), None, &ExecTarget::Local)
            .expect("tempdir-derived unit path must resolve");
        let sink = CollectingSink::new();
        let filter = use_filter.then(|| Arc::new(GitIgnoreFilter::new(root.to_path_buf())));

        let (maintenance_tx, maintenance_rx) = mpsc::channel();
        let (debounce_tx, debounce_rx) = mpsc::channel();
        let (tree_tx, tree_rx) = mpsc::channel();
        let (scheduler_tx, scheduler_rx) = mpsc::channel();

        let git_meta = git_meta_paths.map(|paths| {
            super::git_meta_merge::build_callbacks(
                &repo.key(),
                &repo,
                &paths,
                sink.clone(),
                Some(scheduler_tx.clone()),
            )
        });

        let cb = build_notify_callback(
            repo,
            sink.clone(),
            filter,
            maintenance_tx,
            debounce_tx,
            tree_tx,
            Some(scheduler_tx),
            git_repo,
            git_meta,
        );

        // 包一层：让调用方只喂 `Event` 而非 `Result`
        let boxed: Box<dyn FnMut(Result<Event, notify::Error>)> = Box::new(cb);

        Self {
            callback: boxed,
            sink,
            maintenance_rx,
            debounce_rx,
            tree_rx,
            scheduler_rx,
        }
    }

    fn feed(&mut self, kind: EventKind, path: &Path) {
        (self.callback)(Ok(Event::new(kind).add_path(path.to_path_buf())));
    }
}

/// 写一份 `.gitignore`（只是文本，不建流）。
fn write_gitignore(root: &Path, body: &str) {
    std::fs::write(root.join(".gitignore"), body).expect("write .gitignore");
}

// ── 内容事件过滤 ──────────────────────────────────────────────────────

#[test]
fn gitignored_path_is_dropped_before_reaching_sink() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_gitignore(root, "*.log\n");
    let mut h = CallbackHarness::new(root, false);

    h.feed(
        EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        &root.join("debug.log"),
    );

    assert!(
        h.debounce_rx.try_recv().is_err(),
        "被 .gitignore 忽略的路径不得进入 file-changed debounce"
    );
    assert!(h.sink.event_names().is_empty(), "不得投递任何前端事件");
}

#[test]
fn normal_source_path_reaches_debounce() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_gitignore(root, "*.log\n");
    let mut h = CallbackHarness::new(root, false);
    let src = root.join("src").join("main.rs");

    h.feed(
        EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        &src,
    );

    assert_eq!(
        h.debounce_rx.try_recv().ok(),
        Some(src),
        "可见源码路径必须投递给 file-changed debounce"
    );
}

/// 验证 `classify.rs` 自身的 hard-noise 判据。
///
/// **必须用 `None` filter**：传 `Some(filter)` 时 `.git` 由
/// `GitIgnoreFilter::should_ignore` 内部拦住（`gitignore.rs:242`），
/// `is_hard_noise_path` 在 `relevant_event_paths` 里根本不参与 ——
/// 那样的用例在「删掉 hard-noise 判据」时**不会变红**（已实测）。
#[test]
fn hard_noise_git_path_is_dropped_without_filter() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    // 非 git 单元：filter=None → relevant_event_paths 走 is_hard_noise_path 分支
    let mut h = CallbackHarness::with_filter(root, false, false);

    h.feed(
        EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        &root.join(".git").join("index"),
    );

    assert!(
        h.debounce_rx.try_recv().is_err(),
        ".git 路径不得进入 debounce"
    );
    assert!(
        h.sink.event_names().is_empty(),
        ".git 不是项目内容，不得投递"
    );
    assert!(h.scheduler_rx.try_recv().is_err(), "不得驱动 git worker");
}

// ── 结构事件边界 ──────────────────────────────────────────────────────

#[test]
fn structure_event_keeps_ignored_root_boundary() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_gitignore(root, "target/\n");
    let mut h = CallbackHarness::new(root, false);
    let ignored_root = root.join("target");

    h.feed(EventKind::Create(CreateKind::Folder), &ignored_root);

    assert_eq!(
        h.tree_rx.try_recv().ok(),
        Some(ignored_root),
        "ignored 根自身的边界事件必须保留（灰节点更新）"
    );
}

#[test]
fn structure_event_drops_ignored_subtree_internal() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_gitignore(root, "target/\n");
    let mut h = CallbackHarness::new(root, false);

    h.feed(
        EventKind::Create(CreateKind::File),
        &root.join("target").join("x.o"),
    );

    assert!(
        h.tree_rx.try_recv().is_err(),
        "ignored 子树内部路径必须丢弃（否则每次构建都刷整棵树）"
    );
}

#[test]
fn non_structure_event_does_not_trigger_tree_refresh() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_gitignore(root, "");
    let mut h = CallbackHarness::new(root, false);

    h.feed(
        EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        &root.join("a.txt"),
    );

    assert!(h.tree_rx.try_recv().is_err(), "内容事件不是结构事件");
}

// ── gitignore 规则热重载 ──────────────────────────────────────────────

#[test]
fn gitignore_change_triggers_reload_all() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_gitignore(root, "");
    let mut h = CallbackHarness::new(root, false);

    h.feed(
        EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        &root.join(".gitignore"),
    );

    match h.maintenance_rx.try_recv() {
        Ok(WatchMaintenance::ReloadAll) => {}
        other => panic!("`.gitignore` 变更必须投递 ReloadAll，实际 = {other:?}"),
    }
}

// ── git 元数据分类的「单元身份」边界 ──────────────────────────────────
//
// 这两条守的是原 `writes_in_unmounted_sibling_unit_leak_nothing_into_mounted_unit`
// 里**唯一可证伪**的部分（历史缺陷：`.git/worktrees/**` 的事件被广播给所有消费者）。
//
// 为什么必须下沉到这个层：那条用例改成 `without_real_fs()` 之后，兄弟单元的写入
// **不产生任何事件**是由夹具构造（watcher = `Noop` + `skip_real_fs` 跳过 git_meta 流）
// 保证的，不是代码保证的 —— 断言退化成恒真。真正属于本仓判据的是回调层的两件事：
//   1. 落在**本单元** git_dir 下的路径 → 正确分类（index / refs / head）；
//   2. 落在**别的单元** gitdir 下的路径 → `Nothing`，不得驱动本单元重算。
// 这两条喂合成事件即可确定性覆盖，零流零 sleep。

/// 本单元 `.git/index` 写入 → 只发查询调度信号，**不** emit 事实（公理 1：信号≠事实）。
#[test]
fn own_git_index_event_signals_scheduler_without_emitting_a_fact() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_gitignore(root, "");
    std::fs::create_dir_all(root.join(".git").join("refs")).unwrap();

    let paths = super::super::git_meta::resolve_git_meta_paths(root)
        .expect("tempdir-derived git repo must resolve meta paths");
    let mut h = CallbackHarness::with_git_meta(root, true, false, Some(paths.clone()));

    // `paths.index` 由 `resolve_git_meta_paths` 从**已归一**的 git_dir 派生，
    // 与真实 FSEvents 上报的 realpath 同形态，可直接喂。
    h.feed(
        EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        &paths.index,
    );

    assert!(
        h.scheduler_rx.try_recv().is_ok(),
        "本单元的 index 写入必须驱动一次查询调度"
    );
    assert!(
        h.debounce_rx.try_recv().is_err(),
        "index 是 git 元数据，不得进入 file-changed（否则与 git 写 index 形成自反馈）"
    );
    assert!(
        h.sink.event_names().is_empty(),
        "index 只发信号不发事实，实际投递了 {:?}",
        h.sink.event_names()
    );
}

/// **单元身份边界**：别的单元的 gitdir（`main/.git/worktrees/other/HEAD`）事件
/// 落在本单元的订阅范围内（同一棵树）时，必须归为 `Nothing` —— 不得驱动本单元重算。
///
/// 变异验证：把 `callbacks.rs` 里 `p.starts_with(&ctx.paths.git_dir)` 的前缀判定
/// 换成「路径含 `.git` 组件」⇒ 本用例变红（别的单元 HEAD 被当成本单元的 HEAD）。
#[test]
fn sibling_unit_gitdir_event_is_classified_as_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_gitignore(root, "");
    // 主仓私有 gitdir：`<root>/.git/`；兄弟单元的私有 gitdir 在
    // `<root>/.git/worktrees/other/`（真实 linked worktree 布局）。
    std::fs::create_dir_all(root.join(".git").join("refs")).unwrap();
    let sibling_gitdir = root.join(".git").join("worktrees").join("other");
    std::fs::create_dir_all(&sibling_gitdir).unwrap();
    // 兄弟单元的 HEAD 必须真实存在才能 `canonicalize`（见下方归一说明）。
    std::fs::write(sibling_gitdir.join("HEAD"), "ref: refs/heads/other\n").unwrap();

    let paths = super::super::git_meta::resolve_git_meta_paths(root)
        .expect("tempdir-derived git repo must resolve meta paths");
    let mut h = CallbackHarness::with_git_meta(root, true, false, Some(paths.clone()));

    // ⚠️ **必须归一后再喂**：`resolve_git_meta_paths` 对 git_dir 做了 `canonicalize`
    // （macOS 的 tempdir 在 `/var` → `/private/var` 符号链接下），未归一的路径过不了
    // 回调里的 `starts_with(&ctx.paths.git_dir)` 前缀判定 ⇒ 事件被提前判为「不碰 git_dir」
    // 而根本不进分类 —— 断言会**空过**（变异验证时抓到的正是这种假绿）。
    // 真实 FSEvents 上报的就是 realpath，故归一是忠实模拟，不是测试取巧。
    let sibling_head = root
        .join(".git")
        .join("worktrees")
        .join("other")
        .join("HEAD")
        .canonicalize()
        .expect("夹具路径必须能归一（父目录已创建）");
    h.feed(
        EventKind::Modify(ModifyKind::Data(DataChange::Content)),
        &sibling_head,
    );

    assert!(
        h.scheduler_rx.try_recv().is_err(),
        "别的单元的 HEAD 变化不得驱动本单元重算（跨单元泄漏的原始形态）"
    );
    assert!(
        h.sink.event_names().is_empty(),
        "别的单元的 HEAD 变化不得被当成本单元的 `git-changed` 广播，实际 {:?}",
        h.sink.event_names()
    );
    assert!(
        h.debounce_rx.try_recv().is_err(),
        "git 元数据路径不得进入 file-changed"
    );
}

// ── overflow / 错误事件 ───────────────────────────────────────────────

#[test]
fn error_event_emits_tree_changed_with_empty_dirs() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    write_gitignore(root, "");
    let mut h = CallbackHarness::new(root, false);

    (h.callback)(Err(notify::Error::generic("overflow")));

    // 错误事件 → 空 dirs 的 tree-changed（前端退回全树刷新）
    let names = h.sink.event_names();
    assert_eq!(
        names,
        vec![FILE_TREE_CHANGED_EVENT.to_string()],
        "overflow 必须投递一条 tree-changed，实际 = {names:?}"
    );
}
