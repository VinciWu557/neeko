//! 非 macOS 平台：无专用后端 —— 调用方使用 `tauri-plugin-notification`
//! （Windows toast / Linux zbus 均为其官方实现路径）。
//!
//! stub 与 macOS 实现同签名（红线 10：门面完整性）。

use tauri::AppHandle;

/// 非 macOS 平台：无专用后端 —— 调用方使用 `tauri-plugin-notification`
/// （Windows toast / Linux zbus 均为其官方实现路径）。
///
/// 与 macOS 实现同签名（红线 10：门面完整性），恒返回 `None`。
#[must_use]
pub const fn try_deliver(
    _app: &AppHandle,
    _title: &str,
    _subtitle: &str,
    _body: &str,
) -> Option<()> {
    None
}
