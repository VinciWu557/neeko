//! 平台差异集中化门面（Platform Adapter）。
//!
//! 将跨平台（macOS / Linux / Windows）的差异逻辑按「主题优先、平台次之」集中于此，
//! 每个主题一个目录，目录内每平台一个实现文件，`mod.rs` 用 `#[cfg]` 选择平台实现。
//! 目标：遗漏某平台实现时编译器立即报错（而非换平台构建才暴露）。
//!
//! 各主题对外只暴露统一接口，业务代码不得在函数体内平铺多平台 `#[cfg]` 块。
//!
//! # 主题索引
//!
//! | 主题 | 统一接口 | 主要来源 |
//! |------|---------|---------|
//! | `reveal` | `build_reveal_command` / `normalize_path` | `file/commands.rs` |
//! | `private_file` | `write_private_atomic` | `agent/hooks/ingest/endpoint.rs`（0600 + 原子替换） |
//! | `process_tree` | `snapshot_process_tree` | `terminal/process_reaper.rs` |
//! | `process_memory` | `sample_process_memory_mb` | `lsp/session/utils.rs` |
//! | `host_path` | `resolve_host_path` | `core/exec_env.rs` |
//! | `devtools` | `ensure_detached_devtools` / `needs_side_effect_compensation` / `configure_inspector` | `browser/devtools.rs` + `webview_ops.rs` |
//! | `git_credential` | `platform_default` | `common/git/credential.rs` |
//! | `shell_launch` | `build_task_command` / `apply_locale_env` / `posix_sh` | `terminal/mod.rs` |
//! | `process_spawn` | `apply_child_flags` / `apply_detached_flags` / `kill_process_tree` | `common/executor/local.rs` |
//! | `ide_launch` | `launch_ide_with_fallback` / `spawn_ide_process` | `project/commands_ide.rs` |
//! | `menu` | `build_edit_submenu` | `app_menu.rs` |
//! | `file_url` | `file_url_to_path` | `lsp/session/root.rs` |
//! | `notify_base` | `notify_base` | `browser/scripts.rs` |
//! | `path_identity` | `portable_render` / `posix_render` | `common/git/checkout_path.rs` |
//! | `watch_backend` | `watch_backend` / `create_file_watcher` / `PlatformWatcher` | `common/file/watcher/registration/strategy.rs` + `manager/core.rs` |
//! | `fonts` | `get_system_fonts` | `common/utils/fonts.rs` |
//! | `close_tab` | `CloseTabFlag`（`mark` / `take`） | `app/close.rs` |
//! | `system_notify` | `try_deliver` / `set_click_handler` | `notification/dispatch.rs`（macOS=UNUserNotificationCenter，含 `didReceive` 点击回流；其余同签名 stub 回退官方插件） |
//! | `hook_command` | `render_report_command` / `resolve_node` | `agent/hooks/install/shape/*`（写进 CLI 配置的 shim 启动命令） |

pub mod close_tab;
pub mod devtools;
pub mod file_url;
pub mod fonts;
pub mod git_credential;
/// hook shim 启动命令的平台渲染（CLI 配置里的 `command` 字段）。
pub mod hook_command;
pub mod host_path;
pub mod ide_launch;
pub mod menu;
pub mod notify_base;
pub mod path_identity;
pub mod private_file;
pub mod process_memory;
pub mod process_spawn;
pub mod process_tree;
pub mod reveal;
pub mod shell_launch;
/// 系统通知投递的平台后端（macOS=UNUserNotificationCenter，含点击回流；其余回退官方插件）。
pub mod system_notify;
pub mod watch_backend;
