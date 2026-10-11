//! 关闭协议：`CloseRequested` 的决策、确认退出命令、`Destroyed` 清理。
//!
//! 三级路径（顺序不可交换）：
//! 1. **任何**关闭请求（macOS 红点 / Cmd+W、Windows·Linux Alt+F4 / 原生关闭按钮 /
//!    自绘标题栏 X）先 `prevent_close`；
//! 2. 按 [`decide_close_action`] 决策 —— 「关闭标签页」静默阻止（标签页已由前端
//!    关闭），原生关闭则通知前端弹「确认退出」对话框；
//! 3. 用户确认后由 `commands::confirm_app_exit`（本协议的命令入口）`destroy` 窗口
//!    （跳过 `CloseRequested`，避免与确认弹框循环），`Destroyed` 事件触发
//!    `shutdown_background_and_exit`。
//!
//! 「关闭标签页」的判别由 [`CloseTabFlag`] 承担 —— 平台差异（macOS 的 Cmd+W 双通道）
//! 集中在 `platform/close_tab`，本模块零 `#[cfg]`（红线 10）。

use tauri::{Emitter, Manager};

use crate::app_state::AppStateWrapper;
use crate::platform::close_tab::CloseTabFlag;

/// 应用关闭请求事件名（阻止关闭后通知前端弹「确认退出」框），
/// 与前端 `src/shared/events.ts` `APP_CLOSE_REQUESTED_EVENT` 同步。
const APP_CLOSE_REQUESTED_EVENT: &str = "app-close-requested";

/// 窗口关闭请求的处理决策。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloseRequestAction {
    /// 「关闭标签页」：静默阻止窗口关闭（标签页已由前端关闭）。
    PreventSilently,
    /// 原生关闭（macOS 红点 / Windows·Linux Alt+F4 / 自绘标题栏 X）：阻止并询问确认退出。
    PreventAndAsk,
}

/// 根据「本次关闭请求是否来自关闭标签页」决定处理方式。
const fn decide_close_action(is_close_tab: bool) -> CloseRequestAction {
    if is_close_tab {
        CloseRequestAction::PreventSilently
    } else {
        CloseRequestAction::PreventAndAsk
    }
}

/// 窗口事件入口：`CloseRequested` 决策 + `Destroyed` 清理。
pub(crate) fn on_window_event(
    window: &tauri::Window,
    event: &tauri::WindowEvent,
    close_tab: &CloseTabFlag,
) {
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if decide_close_action(close_tab.take()) == CloseRequestAction::PreventAndAsk {
                let _ = window.emit(APP_CLOSE_REQUESTED_EVENT, ());
            }
        }
        tauri::WindowEvent::Destroyed => {
            window
                .state::<AppStateWrapper>()
                .shutdown_background_and_exit();
        }
        _ => {}
    }
}

/// 用户确认退出：见 `commands::confirm_app_exit`（命令层的唯一入口，本文件只保留
/// 决策与窗口事件处理）。
#[cfg(test)]
mod tests {
    use super::*;

    /// 事件名双端同源（红线 5）：Rust 常量必须逐字出现在前端镜像
    /// `src/shared/events.ts` —— 只钉本侧字面量挡不住「单边改名」。
    #[test]
    fn close_request_event_name_matches_frontend_mirror() {
        const FRONTEND_EVENTS: &str = include_str!("../../../src/shared/events.ts");
        assert_eq!(APP_CLOSE_REQUESTED_EVENT, "app-close-requested");
        let needle = format!("'{APP_CLOSE_REQUESTED_EVENT}'");
        assert!(
            FRONTEND_EVENTS.contains(&needle),
            "前端 events.ts 缺少 {needle}（改动事件名必须双端同步）"
        );
    }

    #[test]
    fn close_tab_prevents_window_close_silently() {
        assert_eq!(
            decide_close_action(true),
            CloseRequestAction::PreventSilently
        );
    }

    #[test]
    fn native_close_prevents_and_asks_user() {
        assert_eq!(
            decide_close_action(false),
            CloseRequestAction::PreventAndAsk
        );
    }
}
