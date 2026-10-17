/**
 * 原型 —— 前端侧：设置类型 + 通知点击回流（按 domain 路由）+ 授权引导。
 * 实施落点：`src/features/notification/`（已落地：api/notificationApi.ts、
 * hooks/useNotificationDelivered.ts、hooks/useNotificationReflow.ts、reflow.ts、
 * shared/types/notification.ts + features/settings/NotificationSettingsSection）。
 *
 * ⚠️ 偏差注记（实施期定稿）：本原型的单一 `attachNotificationReflow` 已拆为两个 hook
 * （delivered 事件 → in-app 列表；onAction → 回流），且点击回流载荷路径钉死为
 * `action.notification.extra.deepLink`（tauri-plugin-notification 2.6.0 实测能力，
 * Rust dispatch 写入 `EXTRA_DEEP_LINK_KEY`，双端镜像测试）。生产实现为准。
 *
 * 设计约束（design.md §2.2 / D4 / D6）：
 * - 不新增自定义 Tauri 事件名（红线 5）：点击回调走通知插件自身的 JS API。
 * - 设置读写走薄命令 `notification_settings_get/set`（红线 6）。
 * - 回流 deep link 是核心域通用格式 `neeko://{domain}/{instanceId}`，
 *   前端按 domain 查路由表 → 新业务接入回流 = 路由表加一行（开闭原则）。
 * - 类型与 Rust `NotificationSettings` 一一对应；serde 命名（camel/snake）实施期
 *   与既有 config 域约定对齐后钉死，此处以 camelCase 占位。
 */

import { invoke } from '@tauri-apps/api/core';
// 实施期引入：import { isPermissionGranted, requestPermission, onAction } from '@tauri-apps/plugin-notification';

/** 与 Rust NotificationSettings 对齐（三层开关：全局 → 类别 → 事件覆盖）。 */
export interface NotificationSettings {
  enabled: boolean;
  /** 类别开关（闭集，与 NotificationClass 对应）。 */
  actionRequired: boolean;
  completed: boolean;
  failed: boolean;
  /** 事件级覆盖，键 = `{domain}.{eventKey}`（如 "agent.turn_completed": false）。 */
  eventOverrides: Record<string, boolean>;
  /** 仅在窗口失焦时通知（默认 true）。 */
  suppressWhenFocused: boolean;
  /** 节流与合并窗口（秒）——UI 只读展示，高级项。 */
  throttleSecs: number;
  mergeWindowSecs: number;
  bodyMaxChars: number;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  actionRequired: true,
  completed: true,
  failed: true,
  eventOverrides: {},
  suppressWhenFocused: true,
  throttleSecs: 2,
  mergeWindowSecs: 3,
  bodyMaxChars: 200,
};

/**
 * 设置页的事件清单（数据驱动）：每行 = 一个可开关的事件。
 * 新业务/新事件接入 = 在此加一行数据（domain + eventKey + 展示名），组件逻辑零改动。
 * agent 域的 eventKey 与后端 `agent::chat::notify::event_keys` 常量一一对应，
 * 实施期评估是否经共享常量源同步（红线 5 精神：双端不各自硬编码字符串）。
 */
export const NOTIFIABLE_EVENTS = [
  { domain: 'agent', eventKey: 'approval_requested', label: 'Agent 等待审批' },
  { domain: 'agent', eventKey: 'input_requested', label: 'Agent 等待输入' },
  { domain: 'agent', eventKey: 'turn_completed', label: 'Agent 任务完成' },
  { domain: 'agent', eventKey: 'session_failed', label: 'Agent 会话异常' },
] as const;

export const overrideKey = (domain: string, eventKey: string) => `${domain}.${eventKey}`;

export async function loadNotificationSettings(): Promise<NotificationSettings> {
  // 失败降级为默认值：设置读取失败不应阻塞设置页渲染。
  try {
    return await invoke<NotificationSettings>('notification_settings_get');
  } catch {
    return DEFAULT_NOTIFICATION_SETTINGS;
  }
}

export async function saveNotificationSettings(settings: NotificationSettings): Promise<void> {
  await invoke('notification_settings_set', { settings });
}

// ── 通知点击回流 ────────────────────────────────────────────────────────────────

const DEEP_LINK_RE = /^neeko:\/\/([a-z-]+)\/(.+)$/;

/**
 * 回流路由表：domain → 聚焦动作。
 * agent 域复用前端**既有**的会话切换路径（agent-chat 域的 select/focus action），
 * 禁止新造第二套「打开会话」逻辑（状态管理红线：同一事实唯一产出点）。
 * 未来业务（git/terminal…）接入 = 注册一行路由。
 */
export type ReflowRoutes = Record<string, (instanceId: string) => void>;

/**
 * 在 App 初始化期挂载一次（useAppShell 或 notification 域 hook），返回卸载函数。
 * 未知 domain / 畸形 deep link → 忽略并记日志，绝不 throw（旁路降级精神）。
 */
export function attachNotificationReflow(routes: ReflowRoutes): () => void {
  let unlisten: (() => void) | undefined;
  let disposed = false;

  void (async () => {
    const { onAction } = await import('@tauri-apps/plugin-notification');
    const off = await onAction((action) => {
      const link = (action.notification as { deepLink?: string } | undefined)?.deepLink;
      const match = link ? DEEP_LINK_RE.exec(link) : null;
      if (!match) {
        return;
      }
      const [, domain, instanceId] = match;
      const route = routes[domain];
      if (route) {
        route(instanceId);
      } else {
        console.warn(`[notify] no reflow route for domain "${domain}"`);
      }
    });
    if (disposed) {
      off();
    } else {
      unlisten = off;
    }
  })().catch((err) => {
    // 插件不可用（如 Linux 缺库）→ 回流静默失效，不影响主功能。
    console.warn('[notify] reflow unavailable:', err);
  });

  return () => {
    disposed = true;
    unlisten?.();
  };
}

// 使用示意（App 初始化期）：
// attachNotificationReflow({ agent: (sessionId) => focusAgentSession(sessionId) });

/**
 * 授权引导（R4.5）：设置页「发送测试通知」按钮。
 * macOS 首次调用触发系统授权弹窗；被拒时返回 false，UI 展示各平台授权指引文案。
 */
export async function sendTestNotification(): Promise<boolean> {
  const { isPermissionGranted, requestPermission, sendNotification } = await import(
    '@tauri-apps/plugin-notification'
  );
  let granted = await isPermissionGranted();
  if (!granted) {
    granted = (await requestPermission()) === 'granted';
  }
  if (granted) {
    sendNotification({ title: 'Neeko 通知已就绪', body: '任务等待审批 / 完成 / 异常时将在此提醒你' });
  }
  return granted;
}
