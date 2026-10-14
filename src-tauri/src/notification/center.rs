//! 应用级通知门面 —— 业务域的唯一入口（design.md §2.2）。
//!
//! 依赖方向：业务域（agent，未来 git/terminal/import…）→ 本门面；核心域永不反向
//! import 业务域。业务侧只投影 [`NotificationSignal`] 并调 [`NotificationCenter::observe`]，
//! 裁决、节流、投递全部由核心域负责。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;

use tauri::AppHandle;

use super::policy::NotificationPolicy;
use super::types::{DecisionEnv, NotificationSettings, NotificationSignal};

/// 窗口焦点态追踪 —— [`DecisionEnv::app_focused`] 的事实来源。
///
/// 挂在 app 域既有 `on_window_event`（`WindowEvent::Focused`）上，不新开事件通道。
#[derive(Debug, Default)]
pub struct FocusTracker(AtomicBool);

impl FocusTracker {
    /// 由窗口事件回调置位。
    pub fn set(&self, focused: bool) {
        self.0.store(focused, Ordering::Relaxed);
    }

    /// 读取当前焦点态。
    #[must_use]
    pub fn get(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// 通知中心门面：注册进 `AppStateWrapper`，全应用共享一个实例。
///
/// 并发约定：`policy` 锁内只跑同步纯函数（微秒级），投递 spawn 异步且在锁外触发 ——
/// 不跨 await 持锁（后端并发规范）。
pub struct NotificationCenter {
    policy: Mutex<NotificationPolicy>,
    settings: RwLock<Arc<NotificationSettings>>,
    focus: FocusTracker,
}

impl NotificationCenter {
    /// 以初始设置快照构造门面（boot 阶段从 config 域读取）。
    #[must_use]
    pub fn new(settings: NotificationSettings) -> Self {
        Self {
            policy: Mutex::new(NotificationPolicy::new()),
            settings: RwLock::new(Arc::new(settings)),
            focus: FocusTracker::default(),
        }
    }

    /// 焦点态写入端（app 域窗口事件回调持有）。
    #[must_use]
    pub const fn focus_tracker(&self) -> &FocusTracker {
        &self.focus
    }

    /// 更新设置快照（settings 命令保存成功后与 boot 加载时调用）。
    pub fn update_settings(&self, settings: NotificationSettings) {
        *self
            .settings
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::new(settings);
    }

    /// 当前设置快照（Arc 克隆，读侧零拷贝成本）。
    #[must_use]
    pub fn settings_snapshot(&self) -> Arc<NotificationSettings> {
        self.settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// 业务域唯一调用的入口：同步裁决 + 异步投递，任何一步失败都不反压业务主链路。
    pub fn observe(&self, app: &AppHandle, signal: NotificationSignal, instance_visible: bool) {
        let env = DecisionEnv {
            app_focused: self.focus.get(),
            instance_visible,
            now: Instant::now(),
        };
        let settings = self.settings_snapshot();
        let draft = self
            .policy
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .observe(&signal, &env, &settings);
        if let Some(draft) = draft {
            super::dispatch::deliver(app.clone(), draft);
        }
    }

    /// 实例生命周期结束（agent 域 = SessionDone）→ 回收节流记忆。
    pub fn release_instance(&self, domain: &str, instance_id: &str) {
        self.policy
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .release_instance(domain, instance_id);
    }
}

// ── TDD：不依赖 Tauri 运行时的路径 ─────────────────────────────────────────────
//
// `observe` 需要真实 `AppHandle`（全仓无 `tauri::test` 先例，投递路径由 dispatch 的
// 单测与真机验证覆盖）；其余三条是门面自身的状态契约，可直测。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focus_tracker_round_trips() {
        let tracker = FocusTracker::default();
        assert!(!tracker.get(), "默认未聚焦");
        tracker.set(true);
        assert!(tracker.get());
        tracker.set(false);
        assert!(!tracker.get());
    }

    /// 设置快照的写-读往返：`update_settings` 后 `settings_snapshot` 必须看到新值。
    ///
    /// 这是「决策层与磁盘单一事实源」的门面半边 —— 若这里断链，UI 改了开关但裁决仍用旧值，
    /// 表现为「设置不生效」类故障。
    #[test]
    fn settings_snapshot_reflects_update() {
        let center = NotificationCenter::new(NotificationSettings::default());
        assert!(center.settings_snapshot().enabled);

        center.update_settings(NotificationSettings {
            enabled: false,
            body_max_chars: 42,
            ..Default::default()
        });

        let snap = center.settings_snapshot();
        assert!(!snap.enabled);
        assert_eq!(snap.body_max_chars, 42);
    }

    /// `settings_snapshot` 返回 `Arc` 克隆：调用方改不到内部状态（读侧零拷贝且不可变）。
    #[test]
    fn settings_snapshot_is_isolated_from_later_updates() {
        let center = NotificationCenter::new(NotificationSettings::default());
        let held = center.settings_snapshot();

        center.update_settings(NotificationSettings {
            enabled: false,
            ..Default::default()
        });

        assert!(held.enabled, "已持有的快照不应被后续更新改写");
        assert!(!center.settings_snapshot().enabled, "新快照必须看到新值");
    }
}
