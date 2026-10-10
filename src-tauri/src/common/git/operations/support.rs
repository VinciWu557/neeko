//! `operations` 各子模块共享的常量与 helpers（原先平铺在 `mod.rs`）。
//!
//! **只读 git 语义不在此处声明** —— 它由执行层单点注入（`common::executor::env_defaults.rs`，
//! 经 `core::exec` facade + `common::git::transport` 三端），业务代码禁止逐点补 opts /
//! CLI 标志；依据与护栏见 `.trellis/spec/backend/git-domain.md` §9。

use crate::common::git::transport::{GitExecError, GitTransport};
use anyhow::Result;

/// 写操作成功后失效该仓库的全部内存缓存（AGENTS.md：缓存失效不得散落调用点遗漏）。
pub(crate) fn invalidate_caches(work_dir: &str) {
    crate::common::git::cache::invalidate_repo_caches(std::path::Path::new(work_dir));
}

/// 仓库是否有可解析的 HEAD（unborn 分支 → `false`）。
///
/// 探测用 `rev-parse --verify --quiet HEAD`：ref 无法解析时以 **exit 1** 退出
/// （git 源码 `die_no_single_rev` 的稳定行为：`--quiet` 走 1，报错版走 128）。
/// exit 1 → 无 HEAD；其余错误（非仓库 / 权限 / 网络等）一律传播，不误判为 unborn。
/// 行为分支一律走确定性 exit code（`git-domain.md` §11），禁止 stderr 嗅探。
///
/// 复用方：`discard::unstage`（reset 兜底）、`diff::get_file_diff_shell`（HEAD 基线降级）。
pub(crate) async fn has_head(transport: &dyn GitTransport, work_dir: &str) -> Result<bool> {
    match transport
        .run_git(&["rev-parse", "--verify", "--quiet", "HEAD"], work_dir)
        .await
    {
        Ok(_) => Ok(true),
        Err(e) => match e.downcast_ref::<GitExecError>() {
            Some(ge) if ge.exit_code == 1 => Ok(false),
            _ => Err(e),
        },
    }
}

/// 解析 worktree_path：空字符串视为「未指定 worktree」，回落项目根目录。
#[must_use]
pub fn resolve_worktree_path<'a>(worktree_path: &'a Option<String>, wd: &'a str) -> &'a str {
    match worktree_path.as_deref() {
        Some(p) if !p.trim().is_empty() => p,
        _ => wd,
    }
}
