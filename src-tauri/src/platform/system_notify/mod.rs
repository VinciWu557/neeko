//! 系统通知投递的平台后端选择（Platform Adapter，红线 10）。
//!
//! 背景（2026-10-12 实测）：`tauri-plugin-notification` 2.6.0 的 macOS 底座是 notify-rust 的
//! **`NSUserNotificationCenter`** 路径 —— 该 API 已被 Apple 废弃并在 macOS 26+ 静默失效
//! （show() 不报错但横幅不出现）。macOS 必须改走现代 `UNUserNotificationCenter`；
//! Windows（toast）与 Linux（zbus Desktop Notifications）的插件底座仍是活的官方实现，保持插件。
//!
//! 门面契约：业务侧（`notification/dispatch.rs`）只调 [`try_deliver`] ——
//! `None` = 本平台无专用后端，调用方回退插件；`Some(())` = 已由平台 API 消费
//! （异步 fire-and-forget，内部失败自记日志，调用方不得重复投递）。

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::try_deliver;

#[cfg(not(target_os = "macos"))]
mod default;
#[cfg(not(target_os = "macos"))]
pub use default::try_deliver;
