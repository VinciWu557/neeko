/**
 * 通知点击回流：插件 `onAction` → `extra.deepLink` → reflow 路由表（R3.2 精确回流）。
 *
 * 前提（tauri-plugin-notification 2.6.0 实测）：存在 JS `onAction` 监听时，桌面端投递走
 * `show_tracked`，点击通知以 `actionPerformed` 回传完整载荷（含 Rust 侧 `dispatch.rs`
 * 写入的 `extra.deepLink`，键名 `EXTRA_DEEP_LINK_KEY` 双端同步）。
 * 插件不可用 / 无监听窗口期 → 静默降级（旁路语义，错误点击行为不变）。
 */

import { onAction } from '@tauri-apps/plugin-notification';
import { useEffect } from 'react';

import { reflowFromDeepLink } from '../reflow';

/** 插件回传载荷的本地窄化（JS 包类型未覆盖 `extra`，按 Rust `NotificationData` 取用）。 */
interface NotificationTapAction {
  notification?: { extra?: Record<string, unknown> };
}

/** `extra` 深链键名 —— 与 `src-tauri/src/notification/dispatch.rs::EXTRA_DEEP_LINK_KEY` 同步。 */
const EXTRA_DEEP_LINK_KEY = 'deepLink';

export function useNotificationReflow(): void {
  useEffect(() => {
    let disposed = false;
    let listener: { unregister: () => void } | undefined;

    onAction((action) => {
      const link = (action as NotificationTapAction).notification?.extra?.[EXTRA_DEEP_LINK_KEY];
      if (typeof link === 'string') {
        reflowFromDeepLink(link);
      }
    })
      .then((off) => {
        if (disposed) void off.unregister();
        else listener = off;
      })
      .catch(() => {
        // 浏览器 dev 模式 / 插件缺失 → 回流静默失效，不影响其他功能。
      });

    return () => {
      disposed = true;
      listener?.unregister();
    };
  }, []);
}
