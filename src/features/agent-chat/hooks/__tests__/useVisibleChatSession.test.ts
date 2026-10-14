/**
 * useVisibleChatSession 关键行为：挂载即上报、切换会话重报、卸载/清空上报 null。
 * （通知焦点抑制 R2.1 的事实源链路钉子；api 门面 mock，不触真实 invoke。）
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/agentChatApi', () => ({
  setVisibleChatSession: vi.fn(() => Promise.resolve()),
}));

import { setVisibleChatSession } from '../../api/agentChatApi';
import { useVisibleChatSession } from '../useVisibleChatSession';

describe('useVisibleChatSession', () => {
  beforeEach(() => {
    vi.mocked(setVisibleChatSession).mockClear();
  });

  it('reports the session on mount and clears on unmount', () => {
    const { unmount } = renderHook(() => useVisibleChatSession('s1'));
    expect(setVisibleChatSession).toHaveBeenCalledWith('s1');
    unmount();
    expect(setVisibleChatSession).toHaveBeenCalledWith(null);
  });

  /** 会话 id 未就绪（尚未发起 stream）→ 不产生上报。 */
  it('does not report when sessionId is undefined', () => {
    renderHook(() => useVisibleChatSession(undefined));
    expect(setVisibleChatSession).not.toHaveBeenCalled();
  });

  /** 同 tab 内切换会话：先清旧再报新（effect 重跑语义）。 */
  it('re-reports on session change', () => {
    const { rerender } = renderHook(({ sid }) => useVisibleChatSession(sid), {
      initialProps: { sid: 's1' as string | undefined },
    });
    vi.mocked(setVisibleChatSession).mockClear();
    act(() => {
      rerender({ sid: 's2' });
    });
    const calls = vi.mocked(setVisibleChatSession).mock.calls;
    expect(calls).toContainEqual([null]);
    expect(calls).toContainEqual(['s2']);
  });

  /** 会话清空（undefined）→ 上报 null 而非残留旧值。 */
  it('reports null when session cleared', () => {
    const { rerender } = renderHook(({ sid }) => useVisibleChatSession(sid), {
      initialProps: { sid: 's1' as string | undefined },
    });
    vi.mocked(setVisibleChatSession).mockClear();
    act(() => {
      rerender({ sid: undefined });
    });
    expect(setVisibleChatSession).toHaveBeenCalledWith(null);
  });
});
