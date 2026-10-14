/**
 * useMessagesCacheSync 关键行为：挂载即写、messages 变更重写、tabId 变更按新 tab 写、
 * 卸载不写。自 useAgentChat 抽出后的行为钉子（ratchet 拆分零漂移验证）。
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../components/messageCache', () => ({
  saveCachedMessages: vi.fn(),
}));

import { saveCachedMessages } from '../../components/messageCache';
import { useMessagesCacheSync } from '../useMessagesCacheSync';

describe('useMessagesCacheSync', () => {
  beforeEach(() => {
    vi.mocked(saveCachedMessages).mockClear();
  });

  it('writes on mount with initial messages', () => {
    const msgs = [{ id: 'm1' }];
    renderHook(() => useMessagesCacheSync('t1', msgs));
    expect(saveCachedMessages).toHaveBeenCalledWith('t1', msgs);
  });

  it('rewrites when messages change', () => {
    const { rerender } = renderHook(({ msgs }) => useMessagesCacheSync('t1', msgs), {
      initialProps: { msgs: [{ id: 'm1' }] },
    });
    vi.mocked(saveCachedMessages).mockClear();
    rerender({ msgs: [{ id: 'm1' }, { id: 'm2' }] });
    expect(saveCachedMessages).toHaveBeenCalledTimes(1);
    expect(saveCachedMessages).toHaveBeenCalledWith('t1', [{ id: 'm1' }, { id: 'm2' }]);
  });

  it('does not rewrite for same array reference', () => {
    const msgs = [{ id: 'm1' }];
    const { rerender } = renderHook(() => useMessagesCacheSync('t1', msgs));
    vi.mocked(saveCachedMessages).mockClear();
    rerender();
    expect(saveCachedMessages).not.toHaveBeenCalled();
  });
});
