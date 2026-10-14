//! `agent::hooks` 域的唯一启动入口（与 `session` / `agent` / `library` / `lsp` 四域对称）。
//!
//! 组合根只负责顺序与失败策略（`src-tauri/AGENTS.md`「主链路」），所以源 B 的两件启动事务
//! 收在本文件：① 发布 loopback ingest 坐标（endpoint 文件）；② 收敛「设置意图 → hook 文件事实」。
//! 两者都是旁路能力：失败只降级外部 CLI 的通知，绝不阻断 Neeko 启动 —— 因此本函数不返回
//! Result，错误就地记日志。

use std::path::PathBuf;
use std::sync::Arc;

use tauri::AppHandle;

use crate::common::runtime::AppRuntime;

use super::{server, writers};

/// 启动 CLI hook 摄入并补齐安装态。
///
/// 入参由组合根给到"具体事实"（应用句柄、`~/.neeko` 根、用户的 cliHooks 意图、
/// Scheme C 执行器），本域不反向依赖 `AppStateWrapper`。
pub fn boot(app: AppHandle, neeko_dir: PathBuf, want_cli_hooks: bool, runtime: Arc<AppRuntime>) {
    if let Err(err) = server::spawn(app, neeko_dir, runtime) {
        log::warn!("[boot] start agent-hooks ingest failed: {err}");
    }
    reconcile(want_cli_hooks);
}

/// 开机收敛：意图与文件不一致时单向对齐。
///
/// install / uninstall 都幂等且只触碰带自家标记的文件，因此直接执行，不需要二次确认。
fn reconcile(want_cli_hooks: bool) {
    let statuses = writers::status_all();
    let Some(action) = writers::reconcile_action(want_cli_hooks, &statuses) else {
        return;
    };
    let (name, outcomes) = match action {
        writers::ReconcileAction::Install => ("install", writers::install_all()),
        writers::ReconcileAction::Uninstall => ("uninstall", writers::uninstall_all()),
    };
    let summary = outcomes
        .iter()
        .map(|o| format!("{}:{:?}", o.source, o.status))
        .collect::<Vec<_>>()
        .join(" ");
    log::info!("[agent-hooks] reconciling {name}: {summary}");
}
