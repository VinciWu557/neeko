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
 * 应用 hook 开关（R6.5）：`enabled=false` 卸载全部；`enabled=true` 按 `enabledSources` 安装。
 *
 * 返回逐 CLI 的机器可读回执（status + detail），由设置页按 status 分类呈现。
 * 命令在 agent 域（`agent_hooks_apply`）—— 业务知识依赖方向，见 `agent/hooks/commands.rs`。
 *
 * `enabledSources` 为 `null` = 全部启用（向后兼容）；给集合时，集合外的已装 CLI 会被卸载
 * （「单独关掉某一个」的路径）。
 */
export function applyCliHooks(
  enabled: boolean,
  enabledSources?: string[] | null,
): Promise<HookApplyOutcome[]> {
  return invoke<HookApplyOutcome[]>('agent_hooks_apply', {
    enabled,
    enabledSources: enabledSources ?? null,
  });
}

/** 查询各 CLI hook 安装状态（设置页数据行）。失败回空列表（未初始化配置目录的 CLI 不展示）。 */
export async function getCliHookStatus(): Promise<HookInstallStatus[]> {
  try {
    return await invoke<HookInstallStatus[]>('agent_hooks_status');
  } catch {
    return [];
  }
}

/**
 * 认领「回流监听已生效」，并取回在此之前到达的点击深链（无则 `null`）。
 *
 * 两件事必须是一个命令：后端把它们放在同一把锁里，拆开就会出现「已就绪但没人监听」
 * 与「取走了但点击还没写入」两类丢点击窗口（详见后端 `notification/boot.rs` 模块头）。
 *
 * **必须在 `listen()` 的 Promise resolve 之后调用**，不能放在挂载时 —— 早于订阅生效
 * 就等于把状态标错了。后端幂等：重复调用恒 `null`。
 *
 * 失败回 `null`（旁路能力）：最坏结果是后端保持「未就绪」继续暂存，下次挂载再拉，不丢。
 */
export async function claimNotificationReflowReady(): Promise<string | null> {
  try {
    return await invoke<string | null>('notification_claim_reflow_ready');
  } catch {
    return null;
  }
}
