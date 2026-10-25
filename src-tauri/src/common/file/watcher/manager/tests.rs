//! watcher 事件路径分类的纯逻辑测试。

use super::classify::{relevant_event_paths, structure_event_paths};
use crate::common::file::watcher::gitignore::GitIgnoreFilter;
use std::path::Path;

fn gitignore_filter(root: &Path) -> GitIgnoreFilter {
    std::fs::write(root.join(".gitignore"), "*.log\n").unwrap();
    GitIgnoreFilter::new(root.to_path_buf())
}

#[test]
fn content_event_paths_drop_gitignored_and_hard_noise_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let filter = gitignore_filter(root);
    let paths = vec![
        root.join("debug.log"),
        root.join("src/main.rs"),
        root.join(".git/index"),
    ];

    let relevant = relevant_event_paths(&paths, Some(&filter));

    assert_eq!(relevant, vec![root.join("src/main.rs")]);
}

/// 非结构事件一律不触发文件树刷新（与改造前一致）。
#[test]
fn non_structure_event_paths_do_not_trigger_tree_refresh() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let filter = gitignore_filter(root);
    let paths = vec![root.join("src/main.rs")];

    assert!(structure_event_paths(&paths, false, Some(&filter)).is_empty());
}

/// 无 filter（非 git 项目）：行为与改造前一致 —— 仅排除 `.git` / `.DS_Store`
/// 硬噪声，gitignore 无从感知。
#[test]
fn structure_event_paths_without_filter_matches_legacy_hard_noise_only() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let paths = vec![
        root.join("debug.log"),
        root.join("build/output.log"),
        root.join(".git/index"),
        root.join(".DS_Store"),
    ];

    let tree_paths = structure_event_paths(&paths, true, None);

    assert_eq!(
        tree_paths,
        vec![root.join("debug.log"), root.join("build/output.log")]
    );
}

/// 硬噪声即使位于 ignored 子树内也一律丢弃（`.git` 元数据 / `.DS_Store`）。
#[test]
fn structure_event_paths_drop_hard_noise_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let filter = gitignore_filter(root);
    let paths = vec![root.join(".git/index"), root.join(".DS_Store")];

    assert!(structure_event_paths(&paths, true, Some(&filter)).is_empty());
}

/// 未被忽略的路径原样保留（含未被忽略的 build 输出目录 —— 禁止硬编码黑名单）。
#[test]
fn structure_event_paths_keep_non_ignored_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let filter = gitignore_filter(root);
    let paths = vec![
        root.join("src/new.rs"),
        root.join("build/output"),
        root.join("dist/app.js"),
    ];

    let tree_paths = structure_event_paths(&paths, true, Some(&filter));

    assert_eq!(
        tree_paths,
        vec![
            root.join("src/new.rs"),
            root.join("build/output"),
            root.join("dist/app.js"),
        ]
    );
}

/// ignored 子树**内部**路径在结构事件中一律丢弃（监听层不订阅 ignored 内部，R1/D3）：
/// `target/debug/deps/x.o` 不产生任何 tree 失效目标。
#[test]
fn structure_event_paths_drop_ignored_subtree_internal_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join("target/debug/deps")).unwrap();
    std::fs::write(root.join("target/debug/deps/x.o"), "").unwrap();
    std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
    let filter = GitIgnoreFilter::new(root.to_path_buf());

    let paths = vec![root.join("target/debug/deps/x.o")];
    let tree_paths = structure_event_paths(&paths, true, Some(&filter));

    assert!(tree_paths.is_empty());
}

/// 一批位于同一 ignored 子树内的路径全部丢弃（消除 `target/**` 构建 churn）；
/// 而 ignored 根的重复边界事件（如 remove+create）去重为一条。
#[test]
fn structure_event_paths_drop_ignored_internal_churn_and_dedupe_boundary() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join("target/debug/deps")).unwrap();
    std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
    let filter = GitIgnoreFilter::new(root.to_path_buf());

    let paths = vec![
        root.join("target/debug/a.o"),
        root.join("target/debug/deps/b.o"),
        root.join("target/release/c.o"),
    ];
    let tree_paths = structure_event_paths(&paths, true, Some(&filter));
    assert!(tree_paths.is_empty(), "ignored 内部 churn 不得产生失效目标");

    // ignored 根的重复边界事件去重为一条
    let boundary = [root.join("target"), root.join("target")];
    let deduped = structure_event_paths(&boundary, true, Some(&filter));
    assert_eq!(deduped, vec![root.join("target")]);
}

/// ignored 根**自身**的创建/删除仍保留为灰节点更新（AC2）。
#[test]
fn structure_event_paths_keep_ignored_root_boundary_change() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join("target")).unwrap();
    std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
    let filter = GitIgnoreFilter::new(root.to_path_buf());

    // 创建：ignored 根作为结构事件路径
    let created = structure_event_paths(&[root.join("target")], true, Some(&filter));
    assert_eq!(created, vec![root.join("target")]);

    // 删除：ignored 根从磁盘消失后仍保留（父目录可见监听捕获边界变化）
    std::fs::remove_dir_all(root.join("target")).unwrap();
    let removed = structure_event_paths(&[root.join("target")], true, Some(&filter));
    assert_eq!(removed, vec![root.join("target")]);
}

/// 嵌套 gitignore：子包 ignored 根的**内部**路径丢弃；
/// 子包 ignored 根**自身**的边界事件保留为其所在层级（分层剪枝语义，不误伤可见子树）。
#[test]
fn structure_event_paths_nested_ignored_root_boundary_only() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let app = root.join("packages/app");
    std::fs::create_dir_all(app.join("dist/assets")).unwrap();
    std::fs::write(root.join(".gitignore"), "/target/\n").unwrap();
    std::fs::write(app.join(".gitignore"), "dist/\n").unwrap();
    let filter = GitIgnoreFilter::new(root.to_path_buf());

    let internal = structure_event_paths(&[app.join("dist/assets/app.js")], true, Some(&filter));
    assert!(internal.is_empty());

    let boundary = structure_event_paths(&[app.join("dist")], true, Some(&filter));
    assert_eq!(boundary, vec![app.join("dist")]);
}

/// D2 用户级 `watcherExclude` 与 gitignore 走同一忽略判定：被排除子树**内部**的
/// 结构事件一律丢弃（配置后该子树零监听），ignored 根**自身**的边界事件仍保留；
/// 未被排除的可见路径不受影响。
#[test]
fn structure_event_paths_honor_user_watcher_excludes() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join("target/debug")).unwrap();
    // .gitignore 为空：命中只能来自用户排除层
    std::fs::write(root.join(".gitignore"), "").unwrap();
    let filter = GitIgnoreFilter::with_user_excludes(root.to_path_buf(), &["target/".into()]);

    let paths = vec![root.join("target/debug/x.o"), root.join("src/main.rs")];
    let tree_paths = structure_event_paths(&paths, true, Some(&filter));
    assert_eq!(
        tree_paths,
        vec![root.join("src/main.rs")],
        "用户排除子树内部 churn 不得产生失效目标"
    );

    // ignored 根自身的边界事件保留（灰节点更新）
    let boundary = structure_event_paths(&[root.join("target")], true, Some(&filter));
    assert_eq!(boundary, vec![root.join("target")]);
}

/// 非 ignored 路径仍照常保留（保证边界收窄不误伤可见子树）。
#[test]
fn structure_event_paths_keep_visible_paths_mixed_with_ignored() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    std::fs::create_dir_all(root.join("target/debug")).unwrap();
    std::fs::write(root.join(".gitignore"), "target/\n").unwrap();
    let filter = GitIgnoreFilter::new(root.to_path_buf());

    let paths = vec![
        root.join("target/debug/x.o"),
        root.join("src/main.rs"),
        root.join("README.md"),
    ];
    let tree_paths = structure_event_paths(&paths, true, Some(&filter));

    assert_eq!(
        tree_paths,
        vec![root.join("src/main.rs"), root.join("README.md")]
    );
}

// ── git 元数据合并路径（P3）──────────────────────────────────────────────
//
// 合并后 `.git` 事件由主 watcher 的分类分支处理。两条不变量必须同时成立：
//   I1 分类判定复用 `classify_git_meta_event`（不复制判定逻辑）；
//   I2 命中分类的 `.git` 路径**仍被 hard-noise 丢弃**，不得漏进前端事件。

use crate::common::file::watcher::git_meta::{classify_git_meta_event, GitMetaChange};

/// 构造一套 git 元数据路径（不落盘，只用于分类）。
fn git_meta_paths(
    root: &Path,
) -> (
    std::path::PathBuf,
    std::path::PathBuf,
    std::path::PathBuf,
    std::path::PathBuf,
) {
    let git = root.join(".git");
    (
        git.join("HEAD"),
        git.join("index"),
        git.join("refs"),
        git.join("packed-refs"),
    )
}

#[test]
fn merged_git_meta_classifies_head_index_and_refs() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let (head, index, refs, packed) = git_meta_paths(root);

    // index 优先于 HEAD（git commit 同时改两者时按 index 处理）
    assert_eq!(
        classify_git_meta_event(std::slice::from_ref(&index), &head, &index, &refs, &packed),
        GitMetaChange::IndexChanged
    );
    assert_eq!(
        classify_git_meta_event(std::slice::from_ref(&head), &head, &index, &refs, &packed),
        GitMetaChange::HeadChanged
    );
    assert_eq!(
        classify_git_meta_event(
            &[refs.join("heads").join("main")],
            &head,
            &index,
            &refs,
            &packed
        ),
        GitMetaChange::RefsChanged
    );
    assert_eq!(
        classify_git_meta_event(std::slice::from_ref(&packed), &head, &index, &refs, &packed),
        GitMetaChange::RefsChanged
    );
}

/// `.git/objects/**` 的写入（`git gc` / 对象落盘高频）**不得**被误判为 refs 变化。
#[test]
fn merged_git_meta_ignores_objects_and_config() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let (head, index, refs, packed) = git_meta_paths(root);
    let git = root.join(".git");

    for p in [
        git.join("objects").join("ab").join("cdef0123"),
        git.join("config"),
        git.join("ORIG_HEAD"),
    ] {
        assert_eq!(
            classify_git_meta_event(std::slice::from_ref(&p), &head, &index, &refs, &packed),
            GitMetaChange::Nothing,
            "{} 必须归为 Nothing",
            p.display()
        );
    }
}

/// I2：命中分类的 `.git` 路径仍被 hard-noise 丢弃（不漏进前端）。
#[test]
fn merged_git_meta_paths_still_dropped_by_hard_noise() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let filter = gitignore_filter(root);
    let (head, index, refs, _packed) = git_meta_paths(root);

    let paths = vec![head, index, refs.join("heads").join("main")];
    assert!(
        relevant_event_paths(&paths, Some(&filter)).is_empty(),
        "git 元数据路径不得进入内容事件"
    );
    assert!(
        structure_event_paths(&paths, true, Some(&filter)).is_empty(),
        "git 元数据路径不得进入结构事件"
    );
}

/// 普通源码路径 + 合并上下文存在时，不得被 git 分类吃掉（短路语义）。
#[test]
fn merged_git_meta_does_not_swallow_source_events() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let filter = gitignore_filter(root);
    let (head, index, refs, packed) = git_meta_paths(root);

    let src = root.join("src").join("main.rs");
    assert_eq!(
        classify_git_meta_event(std::slice::from_ref(&src), &head, &index, &refs, &packed),
        GitMetaChange::Nothing,
        "源码路径必须归为 Nothing"
    );
    assert_eq!(
        relevant_event_paths(std::slice::from_ref(&src), Some(&filter)),
        vec![src],
        "源码路径必须正常投递"
    );
}

// ── 合并可行性判定（P3 高危回归）────────────────────────────────────────
//
// 合并的前提是「`.git` 事件**确实会送达主 watcher**」。这要求 git 元数据目录
// 位于主 watcher 的订阅根之下。**linked worktree 不满足**：它的 `.git` 是指针
// 文件，真实 gitdir 在主仓库的 `.git/worktrees/<name>/`，位于工作树之外。
//
// 若误判为可合并 → 不建独立流 → 该 worktree 的 HEAD/index/refs 变化永久丢失。

/// 判定「git 元数据目录是否在主 watcher 订阅根之下」——合并的**结构判据**。
///
/// 不能用「路径含 `.git` 组件」这种字符串启发式：linked worktree 的真实 gitdir
/// 虽含 `.git`，却不在订阅根内。
fn git_meta_within_root(git_dir: &Path, root: &Path) -> bool {
    git_dir.starts_with(root)
}

#[test]
fn git_meta_merge_is_rejected_for_linked_worktree() {
    let tmp = tempfile::tempdir().unwrap();
    let main_root = tmp.path().join("main");
    let worktree_root = tmp.path().join("feat");
    // linked worktree：gitdir 在主仓库内，不在工作树内
    let worktree_git_dir = main_root.join(".git").join("worktrees").join("feat");

    assert!(
        !git_meta_within_root(&worktree_git_dir, &worktree_root),
        "linked worktree 的 gitdir 在订阅根之外 → 必须拒绝合并"
    );
}

#[test]
fn git_meta_merge_is_allowed_for_normal_repo() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("repo");
    let git_dir = root.join(".git");

    assert!(
        git_meta_within_root(&git_dir, &root),
        "普通仓库的 .git 在订阅根之下 → 允许合并"
    );
}
