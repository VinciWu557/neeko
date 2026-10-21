import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { SessionConfigOption } from '@/shared/types/agentChat';

vi.mock('../../api/agentChatApi', () => ({
  setAgentConfigOption: vi.fn().mockResolvedValue(undefined),
}));

import { useSessionConfigOptions } from '../useSessionConfigOptions';

const OPTIONS: SessionConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'a',
    options: [{ value: 'a', name: 'A' }],
  },
];

function setup() {
  return renderHook(() => useSessionConfigOptions(() => 'sid'));
}

describe('useSessionConfigOptions — 三态（AC4）', () => {
  /**
   * 初值是 `loading` 而**不是** `unsupported`。
   *
   * 这是本轮修复的核心：会话还没建立时断言「不支持」会让控件在
   * `session_start` 到达前消失再出现。用户看到的是「闪一下」，
   * 而更糟的是 `loading` 该显示的骨架/禁用态根本没机会出现。
   */
  it('should start in loading, not unsupported', () => {
    const { result } = setup();
    expect(result.current.view.phase).toBe('loading');
  });

  /** `session_config` + 有选项 = ready。 */
  it('should become ready once options arrive', () => {
    const { result } = setup();
    act(() => result.current.setCapability('session_config'));
    act(() => result.current.replace(OPTIONS));
    expect(result.current.view.phase).toBe('ready');
    expect(result.current.view.supported).toBe(true);
    expect(result.current.options).toHaveLength(1);
  });

  /**
   * `none` / `per_turn` 都是 unsupported，**即便有残留选项**。
   *
   * 这是 R3（写路径必须显式失败）的 UI 侧保证：不能出现「显示了控件、
   * 点选静默无操作」的组合。
   */
  it.each(['none', 'per_turn'] as const)(
    'should report unsupported for capability %s even with stale options',
    (cap) => {
      const { result } = setup();
      act(() => result.current.replace(OPTIONS));
      act(() => result.current.setCapability(cap));
      expect(result.current.view.phase).toBe('unsupported');
      expect(result.current.view.supported).toBe(false);
    },
  );

  /**
   * `reset` 必须回到 `loading` 而不是 `unsupported`。
   *
   * `reset` 的语义是「换会话了」，新会话能力还没到 —— 此时断言 `none`
   * 会让切换 agent 时控件先消失、再在 `session_start` 后出现。
   */
  it('should return to loading on reset, not to unsupported', () => {
    const { result } = setup();
    act(() => result.current.setCapability('none'));
    expect(result.current.view.phase).toBe('unsupported');

    act(() => result.current.reset());
    expect(result.current.view.phase).toBe('loading');
    expect(result.current.options).toEqual([]);
  });

  /** 能力位原值必须透出：`per_turn` 与 `none` 在消费侧要能区分。 */
  it('should expose the raw capability for the composer', () => {
    const { result } = setup();
    act(() => result.current.setCapability('per_turn'));
    expect(result.current.view.capability).toBe('per_turn');
    expect(result.current.view.supported).toBe(false);
  });
});
