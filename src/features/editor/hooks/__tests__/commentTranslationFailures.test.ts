/**
 * 失败上报策略的单元测试。
 *
 * 这里锁住的是「哪类失败该打扰用户」这个产品判断，不是实现细节：
 * 把校验失败也上报会淹没通知中心，把传输失败漏报会让用户以为翻译正常跑完了。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useNotificationStore } from '@/shared/store/notificationStore';

import { notifyTransportFailures, summarizeTransportFailures } from '../commentTranslationFailures';

beforeEach(() => {
  useNotificationStore.getState().clearAll();
});

describe('summarizeTransportFailures', () => {
  it('returns null when every failure is a validation failure', () => {
    const report = summarizeTransportFailures({
      failureKinds: { a: 'validation', b: 'validation' },
      failureReasons: { a: 'placeholder mismatch', b: 'too short (0.08)' },
    });

    expect(report).toBeNull();
  });

  it('counts only transport failures and reports the first reason', () => {
    const report = summarizeTransportFailures({
      failureKinds: { a: 'validation', b: 'transport', c: 'transport' },
      failureReasons: { a: 'placeholder mismatch', b: 'agent exited with code 1', c: 'timeout' },
    });

    expect(report).toEqual({ count: 2, detail: 'agent exited with code 1' });
  });

  it('falls back to a readable detail when no reason was recorded', () => {
    const report = summarizeTransportFailures({
      failureKinds: { a: 'transport' },
      failureReasons: {},
    });
    expect(report).toEqual({ count: 1, detail: 'unknown error' });
  });
});

describe('notifyTransportFailures', () => {
  it('puts one error notification in the store', () => {
    notifyTransportFailures({ count: 3, detail: 'agent exited with code 1' });

    const { notifications } = useNotificationStore.getState();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe('error');
    expect(notifications[0]?.title).toBe('注释翻译失败');
    expect(notifications[0]?.message).toContain('3 处未翻译');
    expect(notifications[0]?.message).toContain('agent exited');
  });

  /** 一批同因失败只该产生**一条**通知，而不是每条失败一条。 */
  it('does not fan out one notification per failed segment', () => {
    const spy = vi.spyOn(useNotificationStore.getState(), 'addNotification');
    notifyTransportFailures({ count: 274, detail: 'network unreachable' });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
