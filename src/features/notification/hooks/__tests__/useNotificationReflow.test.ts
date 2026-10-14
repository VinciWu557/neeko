/**
 * 点击回流 hook 测试：onAction → extra.deepLink → reflow 路由表。
 * （onAction 由 src/testing/setup.ts 全局 mock，这里取注册的处理器回放点击。）
 */
import { onAction } from '@tauri-apps/plugin-notification';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../reflow', () => ({
  reflowFromDeepLink: vi.fn(),
}));

import { reflowFromDeepLink } from '../../reflow';
import { useNotificationReflow } from '../useNotificationReflow';

function registeredActionHandler(): (event: unknown) => void {
  const call = vi.mocked(onAction).mock.calls.at(-1);
  if (!call) throw new Error('onAction not subscribed');
  return call[0] as (event: unknown) => void;
}

describe('useNotificationReflow', () => {
  beforeEach(() => {
    vi.mocked(onAction).mockClear();
    vi.mocked(reflowFromDeepLink).mockReset();
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
});
