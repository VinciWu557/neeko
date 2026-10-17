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

use super::ingest::server;
use super::install::config::settings;
use super::install::selection;

/// 启动 CLI hook 摄入并补齐安装态。
///
/// 入参由组合根给到"具体事实"（应用句柄、`~/.neeko` 根、用户的 cliHooks 主开关、
/// `config.json` 快照（供逐 CLI 覆盖）、Scheme C 执行器），boot 本身不依赖 `AppStateWrapper`（但 `ingest::server` 的外圈投递点需要它来 emit）。
pub fn boot(
    app: AppHandle,
    neeko_dir: PathBuf,
    want_cli_hooks: bool,
    config: &serde_json::Value,
    runtime: Arc<AppRuntime>,
) {
    if let Err(err) = server::spawn(app, neeko_dir, runtime) {
        log::warn!("[boot] start agent-hooks ingest failed: {err}");
    }
    reconcile(want_cli_hooks, config);
}

/// 开机收敛：意图与文件不一致时单向对齐。
///
/// 与设置页保存走**同一个收敛入口**（[`selection::apply_selection`]）—— 此前这里先算
/// `reconcile_action` 再二选一执行，缺了「装该装的 + 卸不该装的」中的卸那一半，
/// 使「关掉某个 CLI 后重启又装回来」。统一入口后两个调用方语义必然一致。
///
/// install / uninstall 都幂等且只触碰带自家标记的文件，因此直接执行，不需要二次确认。
fn reconcile(want_cli_hooks: bool, config: &serde_json::Value) {
    let overrides = settings::hook_source_overrides(config);
    let outcomes = selection::apply_selection(want_cli_hooks, |source| {
        settings::hook_enabled_for(source, want_cli_hooks, &overrides)
    });
    // 只记**有实际动作**的行：`Unchanged` / `Removed`（无痕迹）是常态，全量打日志会淹没
    // 真正的变更（开机日志的价值在于「这次启动改了什么」）。
    let changed: Vec<String> = outcomes
        .iter()
        .filter(|o| {
            matches!(
                o.status,
                crate::agent::hooks::install::outcome::HookApplyStatus::Applied
                    | crate::agent::hooks::install::outcome::HookApplyStatus::Removed
                    | crate::agent::hooks::install::outcome::HookApplyStatus::Failed
                    | crate::agent::hooks::install::outcome::HookApplyStatus::Skipped
            )
        })
        .map(|o| format!("{}:{:?}", o.source, o.status))
        .collect();
    if !changed.is_empty() {
        log::info!("[agent-hooks] reconcile: {}", changed.join(" "));
    }
}
