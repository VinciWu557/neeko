//! 通知投递层 —— 裁决好的 Draft → 系统通知（design.md §2.1 / R3）。
//!
//! 平台差异按红线 10 落 `platform/system_notify/`：macOS 走 `UNUserNotificationCenter`
//! （官方插件的 macOS 底座 `NSUserNotificationCenter` 已被 Apple 移除并静默失效），
//! Windows / Linux 由 `try_deliver` 返回 `None` 回退 `tauri-plugin-notification`
//! （toast / zbus 均为其活路径）。本域自身零 `#[cfg]` —— 只调统一门面。
//! 投递失败静默降级：warn 日志，绝不影响业务主链路（R3.3）。
//!
//! **只有系统通知一个出口**：Agent 通知不进应用内列表。这是一项有意的边界：
//! status-bar 铃铛/列表/toast 服务于**应用自身的操作反馈**（文件保存失败、LSP 异常等，
//! 经 `notificationStore` 直写，与本链路零交叠）；把 Agent 事件也抬进去只会让
//! 「看一眼就过去的提示」和「需要注意的会话事件」挤在同一个会攒 100 条的无读列表里。
//!
//! **两条点击回流通道**（点击通知 → 回到对应会话）：
//! - Windows / Linux（插件路径）：存在 JS `onAction` 监听时插件走 `show_tracked`，
//!   点击以 `actionPerformed` 回传完整 NotificationData（含 `extra`）—— 我们把
//!   `deep_link` 放进 `extra.deepLink`，前端 reflow hook 据此精确聚焦（design D9）。
//! - macOS（UN 路径）：插件的 `extra` + `onAction` **不经过这里**，回流靠原生委托
//!   `didReceiveNotificationResponse` 从 `userInfo` 取回同名字符串，由 [`super::boot`]
//!   注册的回调转成 [`NOTIFICATION_REFOCUS_EVENT`] 交给前端。
//!   两通道在核心域汇成一处：前端只认一个事件、一张路由表。
//!
//! **本文件不含任何接线/装配**：点击回调的注册在 [`super::boot::attach`]（应用生命周期级），
//! 本文件只负责「一条已经裁决好的通知怎么发出去」。

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use super::types::{deep_link_for, NotificationClass, NotificationDraft, SourceRef};

/// `extra` 载荷中深链的键名（前端 reflow hook 读取同名字符串 —— 单一常量源，tests 钉死）。
///
/// 插件路径写进 `extra`；macOS 原生路径写进 `userInfo` 的**同名键**，但那份是
/// `platform/system_notify/macos.rs` 自己的常量（平台层不得反向 import 本域，否则破
/// `check_notification_core_direction` 的分层）。两处同值靠 `macos.rs` 的
/// `user_info_key_matches_dispatcher_and_frontend` 测试钉住 —— 分属不同层，只能这样交叉验证。
pub const EXTRA_DEEP_LINK_KEY: &str = "deepLink";

/// 点击回流事件（**仅 macOS 原生委托使用**）：委托只能拿到 `deep_link` 字符串，
/// 没有完整 draft。与「投递」分开是语义要求：本事件只触发路由，不是「新增一条通知」。
pub const NOTIFICATION_REFOCUS_EVENT: &str = "notification-refocus";

/// 异步投递入口（门面在裁决后调用）：
///
/// spawn 阻塞线程执行原生投递（插件 `show()` 是同步 IPC，红线 3），失败只记日志。
pub fn deliver(app: AppHandle, draft: NotificationDraft) {
    tauri::async_runtime::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            // 平台专用后端优先（macOS 的 NSUserNotification 底座已在 macOS 26+ 静默失效，
            // 见 platform/system_notify）；返回 None 表示该平台无专用后端，走官方插件。
            if crate::platform::system_notify::try_deliver(
                &app,
                &draft.title,
                &draft.subtitle,
                &draft.body,
                &draft.deep_link,
            )
            .is_some()
            {
                return Ok(());
            }
            // 插件路径（Windows toast / Linux zbus）没有 subtitle 概念 —— 降级为正文前缀，
            // 保证主题信息不丢（R7.3；与正文既有的 `[origin_label]` 前缀同一种拼法）。
            let body = degraded_body(&draft.subtitle, &draft.body);
            app.notification()
                .builder()
                .title(draft.title.as_str())
                .body(body.as_str())
                .extra(EXTRA_DEEP_LINK_KEY, draft.deep_link.as_str())
                .show()
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                log::warn!("[notify] native delivery failed (Linux 无守护/权限拒绝?): {err}");
            }
            Err(err) => {
                log::warn!("[notify] delivery task join failed: {err}");
            }
        }
    });
}

/// 无 subtitle 能力的平台的正文降级：主题非空时前置 `[{主题}] `（R7.3）。
///
/// 纯函数，便于单测钉住「有空/无空都不产生 `[] ` 噪声」这条边界（空主题是常态，
/// 每个没有原生标题且拿不到首条消息的会话都会走到这里）。
fn degraded_body(subtitle: &str, body: &str) -> String {
    if subtitle.is_empty() {
        body.to_string()
    } else {
        format!("[{subtitle}] {body}")
    }
}

/// 测试通知样本（R4.5）：与真实投递同通道（原生 show + extra/userInfo），
/// 让「发得出来吗」在设置页一键可验证。构造下沉在本层，命令层保持一行调度（红线 6）。
///
/// **它验证什么、不验证什么**（措辞必须诚实，否则又是一种功能谎言）：
/// - 验证：系统通知能弹（含 macOS 授权链路）、点击能把应用带到前台、
///   macOS 的 `didReceive` 被调用（深链走完 `userInfo` 写入→取回的往返）。
/// - **不**验证：点击后定位到具体会话 —— 样本的 domain 是 `notification`，而路由表
///   （前端 `reflow.ts`）只认 `agent`，故 `reflowFromDeepLink` 会返回 false 并静默降级。
///   这是有意的：为一条自检样本新增「通知域 → 设置页定位」的通道，会把诊断用途
///   升格成导航特性（还有一条跨 feature 写 nav 的耦合），YAGNI。
pub fn deliver_test_sample(app: AppHandle) {
    let draft = NotificationDraft {
        title: "Neeko notifications are ready".into(),
        subtitle: String::new(), // 自检样本无会话主题（副标题是会话级信息）
        body: "You'll be notified here when a task needs approval, completes, or fails".into(),
        class: NotificationClass::Completed,
        deep_link: deep_link_for(&SourceRef {
            domain: "notification",
            instance_id: "self-test".into(),
            origin_label: String::new(),
            group_label: "Neeko".into(),
        }),
    };
    deliver(app, draft);
}

// ── 双端同源（红线 5）：仿 app/close.rs 模式，只钉本侧字面量挡不住单边改名 ──

#[cfg(test)]
mod tests {
    use super::*;

    /// R7.3 降级：无 subtitle 能力的平台把主题前置进正文；空主题不得留下 `[] ` 噪声
    /// （空主题是常态 —— 每个既无原生标题又拿不到首条消息的会话都会走到这里）。
    #[test]
    fn degraded_body_prefixes_topic_only_when_present() {
        assert_eq!(degraded_body("修复登录", "任务完成"), "[修复登录] 任务完成");
        assert_eq!(degraded_body("", "任务完成"), "任务完成");
    }

    /// macOS 原生点击回流事件名双端同步（红线 5）：本侧 emit、前端 `useNotificationReflow` 订阅。
    #[test]
    fn refocus_event_name_matches_frontend_mirror() {
        const FRONTEND_EVENTS: &str = include_str!("../../../src/shared/events.ts");
        assert_eq!(NOTIFICATION_REFOCUS_EVENT, "notification-refocus");
        let needle = format!("'{NOTIFICATION_REFOCUS_EVENT}'");
        assert!(
            FRONTEND_EVENTS.contains(&needle),
            "前端 events.ts 缺少 {needle}（改动事件名必须双端同步）"
        );
    }

    /// `extra` 深链键名双端同步：Rust 写入方（本文件）与 JS 读取方（reflow hook）
    /// 是跨语言常量对，任何一侧改名必须同改另一侧。
    #[test]
    fn deep_link_extra_key_matches_frontend_mirror() {
        const FRONTEND_REFLOW: &str =
            include_str!("../../../src/features/notification/hooks/useNotificationReflow.ts");
        assert_eq!(EXTRA_DEEP_LINK_KEY, "deepLink");
        let needle = format!("'{EXTRA_DEEP_LINK_KEY}'");
        assert!(
            FRONTEND_REFLOW.contains(&needle),
            "前端 useNotificationReflow.ts 缺少 EXTRA_DEEP_LINK_KEY 镜像 {needle}"
        );
    }
}
