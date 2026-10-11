//! LSP (Language Server Protocol) integration: session management, transport, and diagnostics.

/// 会话启动尝试的键控诊断证据（P1：证据宿主 = 身份键，见任务 design）。
pub(crate) mod attempt_diagnostics;
/// 启动期接线（句柄注入 + 设置应用）：组合根只调这一个入口。
pub mod boot;
/// Tauri command handlers for LSP operations.
pub mod commands;
/// Diagnostic pub/sub event bus.
pub mod diag_bus;
/// didOpen 唯一入口（见模块头注释）。
pub mod document_open;
pub mod inflight;
pub mod installer;
pub mod java_debug_bundle;
pub mod java_debug_probe;
pub mod java_source_materializer;
pub mod manager;
pub mod plugin;
pub mod plugin_manager;

/// Pre-authorized external reads for definition targets.
pub mod preauth;
pub mod process;
pub mod profile;
pub mod server_request;
pub mod session;
/// Session assembly port (transport + live session construction).
pub mod session_factory;
pub mod session_store;
/// 「在哪执行」的唯一事实源：探测 / 启动 / 安装共用（P2a）。
pub(crate) mod spawn_spec;
pub mod symbol;
pub mod transport;
/// Serializable types for LSP IPC with the frontend.
pub mod types;

pub use java_debug_bundle::{ensure_bundle_blocking, existing_bundle};
pub use java_debug_probe::LspJavaDebugCapability;
pub use java_source_materializer::LspJavaSourcePath;
pub use manager::LspManager;
pub use plugin::{
    CustomLspServerConfig, LspAutoStart, LspExtensionConflict, LspExtensionMapEntry, LspPlugin,
    LspPluginRegistry, LspSettings,
};
pub use plugin_manager::LspPluginManager;
pub use profile::{detect_project_profile, ProjectLanguageProfile};
pub use session_store::LspSessionStore;
pub use types::*;
