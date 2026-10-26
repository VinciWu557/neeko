//! 系统通知投递的平台后端选择（Platform Adapter，红线 10）。
//!
//! 背景（2026-10-12 实测）：`tauri-plugin-notification` 2.6.0 的 macOS 底座是 notify-rust 的
//! **`NSUserNotificationCenter`** 路径 —— 该 API 已被 Apple 废弃并在 macOS 26+ 静默失效
//! （show() 不报错但横幅不出现）。macOS 必须改走现代 `UNUserNotificationCenter`；
//! Windows（toast）与 Linux（zbus Desktop Notifications）的插件底座仍是活的官方实现，保持插件。
//!
//! 门面契约分两个方向，**都是平台无关的**（业务侧无条件调用，不认识平台）：
//!
//! - **出站** [`try_deliver`]：`None` = 本平台无专用后端，调用方回退插件；`Some(())` = 已由平台
//!   API 消费（异步 fire-and-forget，内部失败自记日志，调用方不得重复投递）。
//! - **入站** [`set_click_handler`]：用户点击系统通知时的回流入口。macOS 交给 UN 委托的
//!   `didReceiveNotificationResponse`；其余平台的回流走插件 `onAction`（前端订阅），
//!   本门面不参与 —— 故 stub 恒忽略注册。
//!
//! 两条腿的类型来自 [`types`]（唯一来源，避免 `cfg` 二选一导致的签名漂移）。

/// 两条平台腿共享的类型（`ClickHandler`）。
pub mod types;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::{set_click_handler, try_deliver};

#[cfg(not(target_os = "macos"))]
mod default;
#[cfg(not(target_os = "macos"))]
pub use default::{set_click_handler, try_deliver};
