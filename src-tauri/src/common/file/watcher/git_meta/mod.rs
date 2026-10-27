//! git 元数据监听与分类：每个Workspace一条，只看自己的 HEAD / index。
//! - [`paths`]：监听路径解析（HEAD / index / git_dir，含 linked worktree 的 gitdir 指针）；
//! - [`classify`]：事件分类（HEAD / index / 无关）；
//! - [`watcher`]：watcher 组装与回调分派。

mod classify;
mod paths;
mod watcher;

#[cfg(test)]
mod tests;

// `classify_git_meta_event` / `GitMetaChange` 的外部消费点是测试（`manager/tests.rs`
// 直接断言分类结果）；生产路径一律经 `dispatch_git_meta_event`，不自行 match。
#[cfg(test)]
pub(super) use classify::{classify_git_meta_event, GitMetaChange};
pub(super) use paths::{resolve_git_meta_paths, GitMetaPaths};
pub(super) use watcher::{create_git_meta_watcher, dispatch_git_meta_event, GitMetaWatcherHandle};
