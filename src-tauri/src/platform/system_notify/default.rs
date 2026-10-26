//! 非 macOS 平台：无专用后端 —— 调用方使用 `tauri-plugin-notification`
//! （Windows toast / Linux zbus 均为其官方实现路径）。
//!
//! stub 与 macOS 实现同签名（红线 10：门面完整性）。

use tauri::AppHandle;

use super::types::ClickHandler;

/// 非 macOS 平台：无专用后端 —— 调用方使用 `tauri-plugin-notification`
/// （Windows toast / Linux zbus 均为其官方实现路径）。
///
/// 与 macOS 实现同签名（红线 10：门面完整性），恒返回 `None`。
/// `deep_link` 在本平台由插件 `extra` 承载，不经此参数。
#[must_use]
pub const fn try_deliver(
    _app: &AppHandle,
    _title: &str,
    _subtitle: &str,
    _body: &str,
    _deep_link: &str,
) -> Option<()> {
    None
}

/// 注册点击回流回调：非 macOS 由插件 `onAction` 承担（前端 `useNotificationReflow`），
/// 本平台无原生点击通道，注册即丢弃。
///
/// 与 macOS 实现同签名（红线 10），恒返回 `false` = 「本平台不消费该回调」。
///
/// **不得改成 `const fn`**：`ClickHandler` 是 `Box<dyn Fn>`，函数作用域末端要跑 `Drop`，
/// 而 const fn 不能求值析构 → 非 macOS 编译报 `E0493`（本文件在 macOS 本地不编译，
/// 属不可见失败域，只有 CI 平台矩阵能拦住）。即：红线 10 的「stub 必须 const」
/// 与「const fn 参数不得带析构」在这里相交，后者胜出 —— clippy `missing_const_for_fn`
/// 不会对此报错（它知道这个签名不可能为 const）。详见
/// `.trellis/spec/backend/quality-guidelines.md`「平台差异集中化」的 `const fn` 约束。
#[must_use]
pub fn set_click_handler(_handler: ClickHandler) -> bool {
    false
}
