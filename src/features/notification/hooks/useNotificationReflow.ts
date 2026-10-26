/** 通知点击回流：native 点击 → deep link → reflow 路由表（R3.2 精确回流）。
 *
 * 两条原生通道，同一个路由入口：
 *
 * 1. **插件路径（Windows / Linux）**：存在 JS `onAction` 监听时投递走 `show_tracked`，
 *    点击以 `actionPerformed` 回传完整载荷（含 Rust 侧 `dispatch.rs` 写入的
 *    `extra.deepLink`，键名 `EXTRA_DEEP_LINK_KEY` 三端同步）。
 * 2. **macOS 原生委托**：后端直写 `UNUserNotificationCenter`，插件的 `extra` + `onAction`
 *    完全不经手；点击由 `platform/system_notify/macos.rs` 的 `didReceive` 从 `userInfo`
 *    取回同一个键，经 `notification-refocus` 事件送到这里。
 *
 * **推送 + 拉取两条腿**：事件订阅覆盖「应用已在跑」的场景；冷启动（用户先点通知、
 * 应用后起来）时后端会把点击记入暂存槽（且**不发事件** —— 那时没人听），订阅生效后用
 * `notification_claim_reflow_ready` 一次拿回。
 *
 * **顺序是硬契约**：必须在 `listen()` resolve 之后才调认领 —— 它同时把后端切成「已就绪」
 * 并取回旧点击，早于订阅生效就等于把状态标错了（后端注释里有详细的两类丢点击推导）。
 *
 * 两通道都只做一次路由 —— 系统默认已把应用带到前台，这里补的是「定位到具体会话」。
 * 插件不可用 / 无监听窗口期 → 静默降级（旁路语义，错误点击行为不变）。
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { onAction } from '@tauri-apps/plugin-notification';
import { useCallback, useEffect } from 'react';

import { NOTIFICATION_REFOCUS_EVENT } from '@/shared/events';
import { safeUnlisten } from '@/shared/utils/safeUnlisten';

import { claimNotificationReflowReady } from '../api/notificationApi';
import { reflowFromDeepLink } from '../reflow';

/** 插件回传载荷的本地窄化（JS 包类型未覆盖 `extra`，按 Rust `NotificationData` 取用）。 */
interface NotificationTapAction {
  notification?: { extra?: Record<string, unknown> };
}

/** `extra` 深链键名 —— 与 `src-tauri/src/notification/dispatch.rs::EXTRA_DEEP_LINK_KEY` 同步。
 * macOS 原生路径写进 `userInfo` 的是同名键，但那份常量在 `platform/system_notify/macos.rs`
 * （平台层不得反向 import 通知域），三处同值由 Rust 侧两个 `include_str!` 测试钉住。 */
const EXTRA_DEEP_LINK_KEY = 'deepLink';

export function useNotificationReflow(): void {
  // macOS 原生委托通道：这里刻意**不用** `useTauriEvent` ——
  // 它不暴露 `listen()` 的 Promise，而「认领就绪」必须发生在那条 Promise resolve 之后
  //（提前置位会丢点击，见下）。自己写订阅才能把两步排序：先订阅生效，再告诉后端。
  const handleRefocus = useCallback((payload: unknown) => {
    // 事件通道是弱契约（未来可能扩展到对象载荷），非字符串一律忽略而非当 truthy 用。
    if (typeof payload === 'string' && payload) reflowFromDeepLink(payload);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;

    listen<string>(NOTIFICATION_REFOCUS_EVENT, (e) => handleRefocus(e.payload))
      .then(async (off) => {
        if (cancelled) {
          safeUnlisten(off)();
          return;
        }
        unlisten = safeUnlisten(off);
        // 顺序铁律：订阅已生效后才认领。该调用同时做两件事（后端一次锁内完成）：
        // 把通道切成 Ready，并交回在此之前到达的点击（那时后端不发事件，只能暂存）。
        const link = await claimNotificationReflowReady();
        if (!cancelled && link) reflowFromDeepLink(link);
      })
      .catch(() => {
        // 浏览器 dev / 事件桥缺失 → 不认领就绪（后端继续暂存），行为安全。
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleRefocus]);

  // 插件通道（Windows / Linux）。
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
