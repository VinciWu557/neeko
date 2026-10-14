/**
 * notification 域后端命令的 feature API 门面（AGENTS.md：前端不直接 import invoke）。
 *
 * 与 `src-tauri/src/notification/commands.rs` 的 `#[tauri::command]` 一一对应。
 */

import { invoke } from '@tauri-apps/api/core';

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type HookApplyOutcome,
  type HookInstallStatus,
  type NotificationSettings,
} from '@/shared/types/notification';

/** 读取用户通知设置。失败回默认值（设置页渲染不被读盘故障阻塞）。 */
export async function getNotificationSettings(): Promise<NotificationSettings> {
  try {
    return await invoke<NotificationSettings>('notification_settings_get');
  } catch {
    return DEFAULT_NOTIFICATION_SETTINGS;
  }
}

/** 保存用户通知设置（后端持久化 + 刷新内存快照，单一事实源）。 */
export function saveNotificationSettings(settings: NotificationSettings): Promise<void> {
  return invoke<void>('notification_settings_set', { settings });
}

/**
 * 发送测试通知（R4.5）：走与真实投递完全相同的通道。
 * 返回 false 仅表示命令层失败；系统权限弹窗由原生投递自然触发（首次点击即授权探测）。
 */
export async function sendTestNotification(): Promise<boolean> {
  try {
    await invoke('notification_test_send');
    return true;
  } catch {
    return false;
  }
}

/**
 * 应用「外部 Agent CLI hooks」开关（R6.5）：true 安装 / false 卸载 pi、opencode 上报文件。
 * 返回逐 CLI 的机器可读回执（status + detail），由设置页按 status 分类呈现。
 * 命令在 agent 域（`agent_hooks_apply`）—— 业务知识依赖方向，见 `agent/hooks/commands.rs`。
 */
export function applyCliHooks(enabled: boolean): Promise<HookApplyOutcome[]> {
  return invoke<HookApplyOutcome[]>('agent_hooks_apply', { enabled });
}

/** 查询各 CLI hook 安装状态（设置页数据行）。失败回空列表（未初始化配置目录的 CLI 不展示）。 */
export async function getCliHookStatus(): Promise<HookInstallStatus[]> {
  try {
    return await invoke<HookInstallStatus[]>('agent_hooks_status');
  } catch {
    return [];
  }
}
