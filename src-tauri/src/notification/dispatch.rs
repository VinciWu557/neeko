//! 通知投递层 —— Draft → 系统通知 + 应用内回流记录（design.md §2.1 / R3）。
//!
//! 平台差异按红线 10 落 `platform/system_notify/`：macOS 走 `UNUserNotificationCenter`
//! （官方插件的 macOS 底座 `NSUserNotificationCenter` 已被 Apple 移除并静默失效），
//! Windows / Linux 由 `try_deliver` 返回 `None` 回退 `tauri-plugin-notification`
//! （toast / zbus 均为其活路径）。本域自身零 `#[cfg]` —— 只调统一门面。
//! 投递失败静默降级：warn 日志，绝不影响业务主链路（R3.3）。
//!
//! 点击回流（仅插件路径，2.6.0 实测）：存在 JS `onAction` 监听时插件走 `show_tracked`，
//! 点击通知会以 `actionPerformed` 事件回传**完整 NotificationData**（含 `extra`）—— 我们把
//! `deep_link` 放进 `extra.deepLink`，前端 [`crate::notification`] 的 reflow hook 据此精确聚焦
//! （design D9）。无监听时插件退化为普通 show（不追踪），行为无害。macOS 专用后端暂未附带
//! userInfo（回流由应用内列表兜底），补齐计划见 task implement.md 遗留项。

use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use super::types::{deep_link_for, NotificationClass, NotificationDraft, SourceRef};

/// 通知投递事件（双端常量，红线 5）：Rust 投递系统通知的同时 emit 本事件，
/// 前端据此写入 in-app 通知列表并缓存 deep link 映射。
/// 与 `src/shared/events.ts` `NOTIFICATION_DELIVERED_EVENT` 同步（tests 钉死）。
pub const NOTIFICATION_DELIVERED_EVENT: &str = "notification-delivered";

/// `extra` 载荷中深链的键名（前端 reflow hook 读取同名字符串 —— 单一常量源，tests 钉死）。
pub const EXTRA_DEEP_LINK_KEY: &str = "deepLink";

/// 异步投递入口（门面在裁决后调用）：
/// 1. 同步 emit 投递事件给前端（旁路，失败忽略）；
/// 2. spawn 阻塞线程执行原生投递（插件 `show()` 是同步 IPC，红线 3），失败只记日志。
pub fn deliver(app: AppHandle, draft: NotificationDraft) {
    // 应用内通道先行：即使原生投递失败，前端列表/映射仍有记录（降级可观测）。
    let _ = app.emit(NOTIFICATION_DELIVERED_EVENT, &draft);

    tauri::async_runtime::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            // 平台专用后端优先（macOS 的 NSUserNotification 底座已在 macOS 26+ 静默失效，
            // 见 platform/system_notify）；返回 None 表示该平台无专用后端，走官方插件。
            if crate::platform::system_notify::try_deliver(
                &app,
                &draft.title,
                &draft.subtitle,
                &draft.body,
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

/// 测试通知样本（R4.5）：与真实投递同通道（emit + 原生 show + extra），
/// 让「发得出来吗 / 点击回得来吗」在设置页一键可验证。构造下沉在本层，
/// 命令层保持一行调度（红线 6）。
pub fn deliver_test_sample(app: AppHandle) {
    let draft = NotificationDraft {
        title: "Neeko 通知已就绪".into(),
        subtitle: String::new(), // 自检样本无会话主题（副标题是会话级信息）
        body: "任务等待审批 / 完成 / 异常时将在此提醒你".into(),
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

    #[test]
    fn delivered_event_name_matches_frontend_mirror() {
        const FRONTEND_EVENTS: &str = include_str!("../../../src/shared/events.ts");
        assert_eq!(NOTIFICATION_DELIVERED_EVENT, "notification-delivered");
        let needle = format!("'{NOTIFICATION_DELIVERED_EVENT}'");
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
