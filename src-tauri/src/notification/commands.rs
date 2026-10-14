//! 通知设置薄命令 + 测试投递（红线 6：只做参数校验/归一 + 调度，逻辑在核心域与 config 域）。

use tauri::{AppHandle, State};

use crate::notification::dispatch;
use crate::notification::types::NotificationSettings;
use crate::{AppError, AppStateWrapper};

/// 读取用户通知设置（事实源：既有 `~/.neeko/config.json` 的 `notification` 键）。
#[tauri::command]
pub fn notification_settings_get(
    state: State<'_, AppStateWrapper>,
) -> Result<NotificationSettings, AppError> {
    Ok(state.storage_manager.notification_settings())
}

/// 写入用户通知设置：归一边界值 → 先持久化，再刷新内存快照 —— 决策层与磁盘保持单一事实源。
#[tauri::command]
pub fn notification_settings_set(
    settings: NotificationSettings,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let settings = settings.normalized();
    state
        .storage_manager
        .save_notification_settings(&settings)
        .map_err(AppError::from)?;
    state.notification.update_settings(settings);
    Ok(())
}

/// 发送一条测试通知（R4.5 授权引导）：走与真实投递完全相同的通道
/// （dispatch → 原生通知 + delivered 事件），失败可见即最佳权限探测。
#[tauri::command]
pub fn notification_test_send(app: AppHandle) -> Result<(), AppError> {
    dispatch::deliver_test_sample(app);
    Ok(())
}
