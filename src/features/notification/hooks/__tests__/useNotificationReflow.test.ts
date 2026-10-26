/**
 * 点击回流 hook 测试：三条入口 → 同一个 reflow 路由入口。
 * - 插件通道（Win/Linux）：`onAction` → `extra.deepLink`（onAction 由 src/testing/setup.ts 全局 mock）；
 * - macOS 原生委托通道：`notification-refocus` 事件 → 深链字符串；
 * - 冷启动补拉：订阅生效后拉一次 `getPendingNotificationDeepLink()`。
 *
 * 另有**顺序契约**：`listen()` resolve → 认领就绪 → 拉取。三者乱序就会丢点击（见 hook 头注释）。
 */
import { listen } from '@tauri-apps/api/event';
import { onAction } from '@tauri-apps/plugin-notification';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NOTIFICATION_REFOCUS_EVENT } from '@/shared/events';

vi.mock('../../reflow', () => ({
  reflowFromDeepLink: vi.fn(),
}));

// api 门面整体 mock：本文件关注「入口都通向同一个路由函数」与调用顺序，不触真实 invoke
// （与 NotificationSettingsSection.test 同型）。
vi.mock('../../api/notificationApi', () => ({
  claimNotificationReflowReady: vi.fn(),
}));

import { claimNotificationReflowReady } from '../../api/notificationApi';
import { reflowFromDeepLink } from '../../reflow';
import { useNotificationReflow } from '../useNotificationReflow';

function registeredActionHandler(): (event: unknown) => void {
  const call = vi.mocked(onAction).mock.calls.at(-1);
  if (!call) throw new Error('onAction not subscribed');
  return call[0] as (event: unknown) => void;
}

/** 取 `notification-refocus` 的事件处理器（`listen` 在 setup.ts 里全局 mock）。 */
function refocusHandler(): (event: { payload: string }) => void {
  const call = vi.mocked(listen).mock.calls.find(([ev]) => ev === NOTIFICATION_REFOCUS_EVENT);
  if (!call) throw new Error(`no listener for ${NOTIFICATION_REFOCUS_EVENT}`);
  return call[1] as (event: { payload: string }) => void;
}

/** flush 微任务链（listen().then → markReady → getPending → reflow）。 */
async function flush() {
  await act(async () => {});
}

describe('useNotificationReflow', () => {
  beforeEach(() => {
    vi.mocked(onAction).mockClear();
    vi.mocked(reflowFromDeepLink).mockReset();
    vi.mocked(claimNotificationReflowReady).mockReset();
    vi.mocked(claimNotificationReflowReady).mockResolvedValue(null);
  });

  it('subscribes to the macOS refocus event', () => {
    renderHook(() => useNotificationReflow());
    expect(vi.mocked(listen)).toHaveBeenCalledWith(
      NOTIFICATION_REFOCUS_EVENT,
      expect.any(Function),
    );
  });

  /** macOS 原生委托通道：后端直写 UN，插件 `onAction` 完全不经手。 */
  it('routes the macOS native refocus event', () => {
    renderHook(() => useNotificationReflow());
    refocusHandler()({ payload: 'neeko://agent/s9' });
    expect(reflowFromDeepLink).toHaveBeenCalledWith('neeko://agent/s9');
  });

  /** 空深链 / 非字符串（事件通道是弱契约）→ 不调用路由。 */
  it('ignores empty and non-string refocus payloads', () => {
    renderHook(() => useNotificationReflow());
    const handler = refocusHandler();
    handler({ payload: '' });
    handler({ payload: { deepLink: 'neeko://agent/s1' } as unknown as string });
    expect(reflowFromDeepLink).not.toHaveBeenCalled();
  });

  it('subscribes to plugin onAction', () => {
    renderHook(() => useNotificationReflow());
    expect(onAction).toHaveBeenCalled();
  });

  /** 点击带 deepLink 的通知 → 路由表消费同一链接。 */
  it('routes tapped notification deep link', () => {
    renderHook(() => useNotificationReflow());
    const handler = registeredActionHandler();
    handler({ notification: { extra: { deepLink: 'neeko://agent/s1' }, title: 't', body: 'b' } });
    expect(reflowFromDeepLink).toHaveBeenCalledWith('neeko://agent/s1');
  });

  /** 载荷缺 extra / 非字符串 → 静默忽略（不 throw，旁路语义）。 */
  it('ignores taps without a usable deep link', () => {
    renderHook(() => useNotificationReflow());
    const handler = registeredActionHandler();
    handler({ notification: {} });
    handler({});
    handler({ notification: { extra: { deepLink: 42 } } });
    expect(reflowFromDeepLink).not.toHaveBeenCalled();
  });

  /**
   * 冷启动补拉：用户先点通知、应用后启，后端的 emit 打在还没人监听的通道上 ——
   * 订阅生效后必须补拉一次，否则那次点击永久丢。
   */
  it('claims readiness and takes the pending click after subscribing', async () => {
    vi.mocked(claimNotificationReflowReady).mockResolvedValue('neeko://agent/s7');
    renderHook(() => useNotificationReflow());
    await flush();
    expect(reflowFromDeepLink).toHaveBeenCalledWith('neeko://agent/s7');
  });

  /** 无待处理点击是常态（绝大多数启动）→ 不得凭空路由。 */
  it('does not route when nothing is pending', async () => {
    renderHook(() => useNotificationReflow());
    await flush();
    expect(reflowFromDeepLink).not.toHaveBeenCalled();
  });

  /**
   * 顺序铁律：必须先 `listen` resolve、再认领就绪、最后拉取。
   *
   * 认领先于订阅生效 = 点击落进「后端以为能送达、实际没人听」的空洞（永久丢）；
   * 完全不认领 = 运行中的每次点击都在后端留残留、重挂载时重放旧路由。
   */
  it('claims readiness only after the listener is live', async () => {
    renderHook(() => useNotificationReflow());
    // 同步阶段：只发出 listen，尚未 resolve —— 此时不得认领（否则状态标错）。
    expect(vi.mocked(listen)).toHaveBeenCalled();
    expect(claimNotificationReflowReady).not.toHaveBeenCalled();

    await flush();
    expect(claimNotificationReflowReady).toHaveBeenCalledTimes(1);
  });

  /**
   * 认领是「切状态 + 取旧点击」的单个原子调用。
   *
   * 拆成两个后端命令会重新引入两类丢点击窗口（详见后端 boot.rs 模块头），
   * 故这里钉住「只有一个调用」这个形状，而不只是「两边都调了」。
   */
  it('uses a single atomic claim call (not two commands)', async () => {
    renderHook(() => useNotificationReflow());
    await flush();
    expect(claimNotificationReflowReady).toHaveBeenCalledTimes(1);
  });
});
