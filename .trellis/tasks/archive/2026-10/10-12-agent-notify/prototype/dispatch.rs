//! 原型 —— 应用级通知门面 + 投递层 + 接线示意
//! （实施落点：`src-tauri/src/notification/{center,dispatch}.rs` + agent 桥一行挂接）。
//!
//! ⚠️ 集成形态示意，非可独立编译单元：`tauri-plugin-notification` 尚未引入（实施 Step 0），
//! 插件 API 签名以实施时官方文档为准。
//! 设计约束：官方插件即平台层（红线 10）、失败静默降级（R3.3）、薄命令（红线 6）、
//! 不新增自定义 Tauri 事件名（红线 5 / D4）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

use super::policy::{DecisionEnv, NotificationDraft, NotificationPolicy, NotificationSignal, NotificationSettings};

// ── 1. 应用级门面：NotificationCenter ───────────────────────────────────────────
//
// 全应用唯一的通知入口，注册进 AppStateWrapper。业务域（agent，未来 git/terminal/import…）
// 只依赖这一个门面：投影出 NotificationSignal 后调 observe()，其余全部由核心域负责。
// 业务域之间、业务域与投递通道之间互相零感知。

pub struct NotificationCenter {
    policy: Mutex<NotificationPolicy>, // 锁内只跑同步纯函数（微秒级），不跨 await 持锁
    focus: FocusTracker,
}

impl NotificationCenter {
    pub fn new() -> Self {
        Self { policy: Mutex::default(), focus: FocusTracker::default() }
    }

    pub fn focus_tracker(&self) -> &FocusTracker {
        &self.focus
    }

    /// 业务域唯一调用的入口。同步裁决 + 异步投递：任何一步失败都不反压业务主链路。
    pub fn observe(
        &self,
        app: &AppHandle,
        signal: NotificationSignal,
        instance_visible: bool,
        settings: &NotificationSettings,
    ) {
        let env = DecisionEnv {
            app_focused: self.focus.get(),
            instance_visible,
            now: std::time::Instant::now(),
        };
        // poison 不传播：通知是旁路，锁中毒只降级自身。
        let Ok(mut policy) = self.policy.lock() else { return };
        if let Some(draft) = policy.observe(&signal, &env, settings) {
            drop(policy); // 投递前释放锁
            dispatch::deliver(app.clone(), draft);
        }
    }

    /// 实例生命周期结束（agent 域 = SessionDone）→ 回收节流记忆。
    pub fn release_instance(&self, domain: &str, instance_id: &str) {
        if let Ok(mut policy) = self.policy.lock() {
            policy.release_instance(domain, instance_id);
        }
    }
}

// ── 2. 焦点态追踪（DecisionEnv.app_focused 的事实来源，应用级共享）───────────────

#[derive(Default)]
pub struct FocusTracker(AtomicBool);

impl FocusTracker {
    /// 挂在 app 域既有 `on_window_event`：`WindowEvent::Focused(f) => tracker.set(f)`。
    pub fn set(&self, focused: bool) {
        self.0.store(focused, Ordering::Relaxed);
    }
    pub fn get(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

// ── 3. 投递通道：draft → 系统通知，失败只记日志 ─────────────────────────────────
//
// 通道集合已知且固定（System / 未来 Sound / Webhook）→ 按仓库 OCP 指引用模块内分支，
// 不上 Box<dyn Trait>。新通道 = dispatch 内加一个函数，核心裁决零改动。

pub mod dispatch {
    use super::*;

    /// 异步投递，绝不阻塞调用方。
    /// 任何失败（权限拒绝 / Linux 无通知守护 / Windows AUMID 问题）→ warn 日志 + 吞掉（R3.3）。
    pub fn deliver(app: AppHandle, draft: NotificationDraft) {
        tauri::async_runtime::spawn(async move {
            if let Err(err) = deliver_system(&app, &draft).await {
                log::warn!("[notify] delivery failed ({}): {err}", draft.deep_link);
            }
        });
    }

    async fn deliver_system(app: &AppHandle, draft: &NotificationDraft) -> Result<(), String> {
        let notification = app.notification();

        // 权限：未决定 → 请求；被拒 → 降级放弃（设置页有引导入口，R4.5）。
        if !notification.is_permission_granted().map_err(|e| e.to_string())? {
            let granted = notification.request_permission().await.map_err(|e| e.to_string())?;
            if !granted {
                return Err("permission denied by user".into());
            }
        }

        notification
            .notify()
            .title(&draft.title)
            .body(&draft.body)
            // deep_link 随点击回调回传（R3.2）；
            // 平台差异（macOS userInfo / Windows toast XML / Linux hints）由插件内部处理。
            .show()
            .map_err(|e| e.to_string())
    }
}

// ── 4. agent 域接线示意（唯一挂点，业务侧改动收敛到这一处）──────────────────────
//
// 实施位置：`src-tauri/src/agent/chat/commands.rs` 的 `spawn_session_pipeline`
// 事件转发循环处（现有代码已将每个 StreamEvent emit 到 AGENT_CHAT_EVENT，旁路加一段）。
// 未来新业务接入 = 在自己域内做同样三行：投影 → observe → release。
//
// ```rust
// // 既有主链路（不动）：
// app.emit(AGENT_CHAT_EVENT, &sequenced)?;
//
// // 新增旁路（agent 域知识：投影；核心域职责：裁决+投递）：
// if let Some(signal) = agent::chat::notify::project(&event, &session_ctx) {
//     let instance_visible = state.visible_agent_session() == Some(signal.source.instance_id.as_str());
//     let settings = state.config_service().notification_settings(); // 既有 config 域
//     state.notification_center().observe(&app, signal, instance_visible, &settings);
// }
// // SessionDone 时回收：center.release_instance("agent", &session_id)
// ```
//
// instance_visible 的取值：优先复用 session_store / 前端既有上报路径，禁止新增轮询（implement.md Step 3）。

// ── 5. 设置命令（红线 6：薄命令，逻辑全在 settings.rs / config 域）────────────────

#[tauri::command]
pub async fn notification_settings_get(
    state: tauri::State<'_, AppStateWrapper>,
) -> Result<NotificationSettings, AppError> {
    state.config_service().get_notification_settings().map_err(AppError::from)
}

#[tauri::command]
pub async fn notification_settings_set(
    settings: NotificationSettings,
    state: tauri::State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    state.config_service().set_notification_settings(settings).map_err(AppError::from)
}

// 注册：两个命令路径加入 lib.rs 的 `neeko_invoke_handler!`（唯一事实源）。
