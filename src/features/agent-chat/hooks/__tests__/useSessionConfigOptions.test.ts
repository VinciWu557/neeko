/**
 * `useSessionConfigOptions` 的状态契约。
 *
 * 两件事：**整体替换**（协议语义，不是合并）与 **reset**（切 agent / 会话结束必须清空）。
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../api/agentChatApi', () => ({
  setAgentConfigOption: vi.fn(() => Promise.resolve()),
}));

const { useSessionConfigOptions } = await import('../useSessionConfigOptions');
const { setAgentConfigOption } = await import('../../api/agentChatApi');

const modelOption = (id: string, current: string) => ({
  id,
  name: 'Model',
  category: 'model',
  type: 'select',
  current_value: current,
  options: [{ value: current, name: current }],
});

describe('useSessionConfigOptions', () => {
  it('should start empty', () => {
    const { result } = renderHook(() => useSessionConfigOptions(() => 's1'));
    expect(result.current.options).toEqual([]);
  });

  /** 协议规定响应/通知都是全量 —— 局部合并会留下陈旧选项。 */
  it('should replace wholesale rather than merge', () => {
    const { result } = renderHook(() => useSessionConfigOptions(() => 's1'));

    act(() => result.current.replace([modelOption('model', 'a')]));
    expect(result.current.options).toHaveLength(1);

    act(() => result.current.replace([modelOption('other', 'b')]));
    expect(result.current.options.map((o) => o.id)).toEqual(['other']);
  });

  /**
   * 切 agent / 会话结束必须清空：上一个 ACP 会话的 model_config 控件残留在界面上，
   * 改它们等于朝不存在的 configId 发请求。
   */
  it('should clear everything on reset', () => {
    const { result } = renderHook(() => useSessionConfigOptions(() => 's1'));

    act(() => result.current.replace([modelOption('model', 'a')]));
    expect(result.current.options).toHaveLength(1);

    act(() => result.current.reset());
    expect(result.current.options).toEqual([]);
  });

  it('should forward the option change to the backend', () => {
    const { result } = renderHook(() => useSessionConfigOptions(() => 'sess-1'));

    act(() => result.current.setOption('effort', 'high'));
    expect(setAgentConfigOption).toHaveBeenCalledWith('sess-1', 'effort', 'high');
  });

  /** 没有会话时静默忽略 —— 不朝空 id 发请求。 */
  it('should ignore setOption when there is no session', () => {
    vi.mocked(setAgentConfigOption).mockClear();
    const { result } = renderHook(() => useSessionConfigOptions(() => undefined));

    act(() => result.current.setOption('effort', 'high'));
    expect(setAgentConfigOption).not.toHaveBeenCalled();
  });
});
