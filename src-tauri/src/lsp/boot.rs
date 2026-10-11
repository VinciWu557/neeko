//! 启动期接线：把运行时句柄交给 LSP 管理器，并应用持久化设置。
//!
//! 边界：本模块拥有「LSP 在启动期需要什么、以什么顺序拿到」这条规则；**读盘归组合根**
//! （`config` 由调用方传入，本模块不碰存储）—— 与 `session::boot` / `agent::boot` /
//! `library::boot` 同款：每个域在启动期只暴露**一个**入口，组合根只负责顺序与失败策略。
//!
//! 顺序不可交换：管理器必须先拿到 `AppHandle` 才能把会话事件送到前端；设置只在配置
//! 可用时应用（配置读失败 ⇒ 无设置可应用，但句柄注入照旧）。
//!
//! 可测性说明：本函数是**框架接线**（`AppHandle` 是具体类型、不可在单测里伪造），其两个
//! 半段各自在生产路径被覆盖 —— 句柄用于会话事件出口（`IpcTransport`），设置应用另有
//! 两个落点（`lsp/commands.rs` 保存设置、`session/commands.rs` 保存配置后即时生效）。

use crate::lsp::LspManager;

/// 启动期接线：注入运行时句柄 + 应用持久化设置。
///
/// `config = None` 表示配置不可用（读盘失败）：跳过设置应用，不跳过句柄注入。
pub fn attach(
    manager: &LspManager,
    app_handle: tauri::AppHandle,
    config: Option<&serde_json::Value>,
) {
    manager.set_app_handle(app_handle);
    if let Some(config) = config {
        manager.apply_settings_from_json(config);
    }
}
