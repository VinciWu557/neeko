/**
 * 通知投递事件监听的 hook 级关键行为测试：
 * class → toast 类型映射、deepLink 透传、载荷原样入库。
 */
import { listen } from '@tauri-apps/api/event';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NOTIFICATION_DELIVERED_EVENT } from '@/shared/events';
import { useNotificationStore } from '@/shared/store/notificationStore';
import type { NotificationDraft } from '@/shared/types/notification';

import { useNotificationDelivered } from '../hooks/useNotificationDelivered';

function deliveredHandler(): (e: { payload: NotificationDraft }) => void {
  const call = vi
    .mocked(listen)
    .mock.calls.find(([event]) => event === NOTIFICATION_DELIVERED_EVENT);
  if (!call) throw new Error(`no listener registered for ${NOTIFICATION_DELIVERED_EVENT}`);
  return call[1] as (e: { payload: NotificationDraft }) => void;
}

function draft(partial: Partial<NotificationDraft>): NotificationDraft {
  return {
    title: 'neeko · Agent turn completed',
    subtitle: '',
    body: '[pi] Task completed',
    class: 'completed',
    deep_link: 'neeko://agent/s1',
    ...partial,
  };
}

describe('useNotificationDelivered', () => {
  beforeEach(() => {
    useNotificationStore.getState().clearAll();
  });

  it('subscribes to the delivered event', () => {
    renderHook(() => useNotificationDelivered());
    expect(vi.mocked(listen)).toHaveBeenCalledWith(
      NOTIFICATION_DELIVERED_EVENT,
      expect.any(Function),
    );
  });

  /** 三类语义 → in-app 类型映射钉死（success/warning/error）。 */
  it('maps class to toast type and passes deep link through', () => {
    renderHook(() => useNotificationDelivered());
    const handler = deliveredHandler();
    handler({ payload: draft({}) });
    handler({
      payload: draft({
        class: 'action_required',
        title: '等待审批',
        deep_link: 'neeko://agent/s2',
      }),
    });
    handler({ payload: draft({ class: 'failed', title: '异常', deep_link: 'neeko://agent/s3' }) });

    const { notifications } = useNotificationStore.getState();
    // 最新在前（store 语义）
    expect(notifications[0].type).toBe('error');
    expect(notifications[1].type).toBe('warning');
    expect(notifications[2].type).toBe('success');
    expect(notifications[0].deepLink).toBe('neeko://agent/s3');
    expect(notifications[2].deepLink).toBe('neeko://agent/s1');
    expect(notifications[2].title).toBe('neeko · Agent turn completed');
    expect(notifications[2].message).toBe('[pi] Task completed');
  });

  /** 未知 class（前端镜像落后于后端时的防御路径）→ 回落 info，不崩。 */
  it('falls back to info for unknown class', () => {
    renderHook(() => useNotificationDelivered());
    const handler = deliveredHandler();
    handler({ payload: draft({ class: 'brand_new' as unknown as NotificationDraft['class'] }) });
    expect(useNotificationStore.getState().notifications[0].type).toBe('info');
  });

  /** R7 主题透传：非空 subtitle 入库；空串折叠为 undefined（渲染层不必区分两种「无」）。 */
  it('stores subtitle only when non-empty', () => {
    renderHook(() => useNotificationDelivered());
    const handler = deliveredHandler();

    handler({ payload: draft({ subtitle: '修复登录竞态', deep_link: 'neeko://agent/s1' }) });
    handler({ payload: draft({ subtitle: '', deep_link: 'neeko://agent/s2' }) });

    const { notifications } = useNotificationStore.getState();
    expect(notifications[0].subtitle).toBeUndefined(); // 空串 → 不写入
    expect(notifications[1].subtitle).toBe('修复登录竞态');
    expect('subtitle' in notifications[0]).toBe(true);
  });
});
