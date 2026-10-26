//! git 元数据 watcher 集成与注入测试：真实 FS 事件送达、失败分支、自愈补挂。

use super::super::paths::{resolve_git_meta_paths, GitMetaPaths};
use super::super::watcher::create_git_meta_watcher_with;
use notify::{RecommendedWatcher, RecursiveMode};

// ── 真实文件系统集成测试：验证 notify 事件送达（方案 B 修复的核心假设） ────
//
// 这些测试使用真实 notify::RecommendedWatcher + 真实临时 git 仓库，验证：
// 1. `.git/index` 的原子写（lock + rename，git 真实行为）能被捕获 → on_index_changed
// 2. `.git/HEAD` 的原子写能被捕获 → on_head_changed
// 3. worktree 区域事件经 rearm 递归监听送达（自愈补挂）
//
// 确定性约定（完整规则见 .trellis/spec/unit-test/real-source-determinism.md）：
// - 真实源只承诺「至少一次」可达，故只做正向可达断言（CallbackProbe::wait_reached）；
// - 不设注册预热 / 观察窗口 sleep，不用墙钟窗口做负向 / 分类断言；
// - 负向分类属性（index / HEAD / refs 互斥，config / ORIG_HEAD → Nothing）由 units.rs
//   纯函数测试确定性覆盖，不在真实 FS 上做「某回调计数不得增长」的绝对零断言。

// ── 事件分发语义（纯函数，零 IO）────────────────────────────────────────
//
// 这 4 条原先建真实 `RecommendedWatcher` + 真实写入，验证「notify 能把
// `.git/index` 的 lock+rename 投递到回调」。但实际被测的是
// `dispatch_git_meta_event`：**一批路径 → 分类 → 三条出口**。那是纯逻辑。
//
// 建真实流的代价：macOS 每次 `FSEventStreamStart` 触发 fseventsd 全树扫描，
// 实测单条流即 97% CPU、持续约 2s（4 条串行 ≈ 看似持续满载）。
// 现在直接喂路径数组，零流零写零 sleep。

use super::super::watcher::dispatch_git_meta_event;

/// 收集三条出口的命中次数。
#[derive(Default)]
struct DispatchSpy {
    index: usize,
    head: usize,
    refs: usize,
}

impl DispatchSpy {
    fn dispatch(&mut self, meta: &GitMetaPaths, paths: &[std::path::PathBuf]) {
        // 拆分借用：三个闭包同时捕获 self 的不同字段，用局部计数器规避
        let mut i = 0;
        let mut h = 0;
        let mut r = 0;
        dispatch_git_meta_event(paths, meta, &mut || i += 1, &mut || h += 1, &mut || r += 1);
        self.index += i;
        self.head += h;
        self.refs += r;
    }
}

/// 真实现场形态的 linked worktree：主仓 `.git` + 私有 gitdir（`worktrees/<name>`，
/// 含 `commondir` 指针）+ `wt/.git` 指针文件。`refs` / `packed-refs` 在**公共 gitdir**。
/// 返回 `(tmp, worktree_path)`；`tmp` 必须随返回保持存活。
fn linked_worktree_repo() -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let main = tmp.path().join("repo");
    let git = main.join(".git");
    std::fs::create_dir_all(git.join("refs").join("heads")).unwrap();
    std::fs::create_dir_all(git.join("refs").join("remotes")).unwrap();
    std::fs::write(git.join("packed-refs"), "# pack-refs\n").unwrap();
    std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    let private = git.join("worktrees").join("dev");
    std::fs::create_dir_all(&private).unwrap();
    std::fs::write(private.join("HEAD"), "ref: refs/heads/feature\n").unwrap();
    std::fs::write(private.join("index"), "\0TREE-WT").unwrap();
    std::fs::write(private.join("commondir"), "../..\n").unwrap();
    let wt = tmp.path().join("wt-dev");
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(wt.join(".git"), format!("gitdir: {}\n", private.display())).unwrap();
    (tmp, wt)
}

fn meta_fixture() -> (tempfile::TempDir, GitMetaPaths) {
    let tmp = tempfile::tempdir().unwrap();
    let git_dir = tmp.path().join(".git");
    std::fs::create_dir_all(git_dir.join("refs").join("heads")).unwrap();
    std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::write(git_dir.join("index"), "\0").unwrap();
    let meta = resolve_git_meta_paths(tmp.path()).expect("tempdir repo must resolve");
    (tmp, meta)
}

#[test]
fn git_meta_dispatch_reports_index_change() {
    let (_tmp, meta) = meta_fixture();
    let mut spy = DispatchSpy::default();
    spy.dispatch(&meta, std::slice::from_ref(&meta.index));
    assert_eq!(
        (spy.index, spy.head, spy.refs),
        (1, 0, 0),
        "index 只走 index 出口"
    );
}

#[test]
fn git_meta_dispatch_reports_head_change() {
    let (_tmp, meta) = meta_fixture();
    let mut spy = DispatchSpy::default();
    spy.dispatch(&meta, std::slice::from_ref(&meta.head));
    assert_eq!(
        (spy.index, spy.head, spy.refs),
        (0, 1, 0),
        "HEAD 只走 head 出口"
    );
}

#[test]
fn git_meta_dispatch_reports_refs_change() {
    let (_tmp, meta) = meta_fixture();
    let mut spy = DispatchSpy::default();
    spy.dispatch(&meta, &[meta.refs_dir.join("heads").join("dev")]);
    assert_eq!(
        (spy.index, spy.head, spy.refs),
        (0, 0, 1),
        "refs/** 只走 refs 出口"
    );
}

/// `packed-refs` 落在**公共 gitdir 根**下（linked worktree 时私有 gitdir 的兄弟），
/// 必须也归入 refs —— 否则 `git gc` / `pack-refs` 后 ahead/behind 无界陈旧。
#[test]
fn git_meta_dispatch_reports_packed_refs_change() {
    let (_tmp, meta) = meta_fixture();
    let mut spy = DispatchSpy::default();
    spy.dispatch(&meta, std::slice::from_ref(&meta.packed_refs));
    assert_eq!(
        (spy.index, spy.head, spy.refs),
        (0, 0, 1),
        "packed-refs 归 refs 出口"
    );
}

/// `.git/objects/**` 是高频 churn（`git gc`、对象落盘），必须归 Nothing ——
/// 误判成 refs 会让每次对象写入都触发 ahead/behind 重算。
#[test]
fn git_meta_dispatch_ignores_objects_and_config() {
    let (_tmp, meta) = meta_fixture();
    let mut spy = DispatchSpy::default();
    spy.dispatch(
        &meta,
        &[
            meta.git_dir.join("objects").join("ab").join("cdef"),
            meta.git_dir.join("config"),
            meta.git_dir.join("ORIG_HEAD"),
        ],
    );
    assert_eq!(
        (spy.index, spy.head, spy.refs),
        (0, 0, 0),
        "无关路径必须全部 Nothing"
    );
}

// ── create_git_meta_watcher 失败分支（确定性注入，跨平台安全） ─────────────

/// 核心 `git_dir` 监听失败 = watcher 无意义 → 返回 `None`。
///
/// 通过 `create_git_meta_watcher_with` 注入 watch_fn 模拟失败：不依赖 notify
/// 对「不存在路径」的报错行为（macOS FSEvents 惰性不报错，真实触发会跨平台
/// flaky），失败分支得以在任意平台确定性覆盖。
#[test]
fn create_git_meta_watcher_returns_none_when_git_dir_watch_fails() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    let git_dir = repo.join(".git");
    std::fs::create_dir_all(&git_dir).unwrap();
    std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::write(git_dir.join("index"), "\0").unwrap();
    let meta = resolve_git_meta_paths(repo).unwrap();

    // 注入：核心 git_dir 监听一律失败（模拟权限/删除竞态）
    let result = create_git_meta_watcher_with(
        "test".to_string(),
        &meta,
        || {},
        || {},
        || {},
        |_watcher: &mut RecommendedWatcher, _path, _mode| {
            Err(notify::Error::generic("simulated watch failure"))
        },
    );
    assert!(
        result.is_none(),
        "核心 git_dir 监听失败 → watcher 无意义 → None"
    );
}

/// 新增的 `refs_dir` 监听失败只告警，不得使整条 watcher 失效 —— HEAD/index 仍有效
/// （对应用户可见契约 R3.3：现有 HEAD / index 触发语义不变）。
#[test]
fn create_git_meta_watcher_survives_refs_watch_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    let git_dir = repo.join(".git");
    std::fs::create_dir_all(git_dir.join("refs").join("heads")).unwrap();
    std::fs::write(git_dir.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::write(git_dir.join("index"), "\0").unwrap();
    let meta = resolve_git_meta_paths(repo).unwrap();
    assert!(
        meta.refs_dir.is_dir(),
        "夹具前提：refs 目录存在，递归监听会被尝试"
    );

    // 注入：git_dir（NonRecursive）成功，refs（Recursive）失败
    let result = create_git_meta_watcher_with(
        "test".to_string(),
        &meta,
        || {},
        || {},
        || {},
        |_watcher: &mut RecommendedWatcher, _path, mode| {
            if mode == RecursiveMode::Recursive {
                Err(notify::Error::generic("simulated refs watch failure"))
            } else {
                Ok(())
            }
        },
    );
    assert!(
        result.is_some(),
        "refs 监听失败不得使整条 watcher 失效（HEAD/index 仍有效）"
    );
}

/// Fix 1 的失败兼容契约：linked worktree 额外的公共 gitdir 监听失败同样只告警，
/// 不得使整条 watcher 失效（HEAD/index/refs 仍有效）。
#[test]
fn create_git_meta_watcher_survives_common_git_dir_watch_failure() {
    let (_tmp, wt) = linked_worktree_repo();
    let meta = resolve_git_meta_paths(&wt).expect("linked worktree must resolve");
    let common_dir = meta.packed_refs.parent().unwrap().to_path_buf();
    assert_ne!(
        common_dir, meta.git_dir,
        "夹具前提：公共 gitdir 与私有 gitdir 不同"
    );
    let fail_dir = common_dir.clone();

    // 注入：只让公共 gitdir（NonRecursive）监听失败
    let result = create_git_meta_watcher_with(
        "test".to_string(),
        &meta,
        || {},
        || {},
        || {},
        move |_watcher: &mut RecommendedWatcher, path: &std::path::Path, mode| {
            if path == fail_dir && mode == RecursiveMode::NonRecursive {
                Err(notify::Error::generic(
                    "simulated common gitdir watch failure",
                ))
            } else {
                Ok(())
            }
        },
    );
    assert!(
        result.is_some(),
        "公共 gitdir 监听失败不得使整条 watcher 失效（HEAD/index/refs 仍有效）"
    );
}
