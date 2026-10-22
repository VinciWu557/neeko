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
    expect(result.current.availability).toBe('pending');
  });

  /** `session_config` + 有选项 = ready。 */
  it('should become ready once options arrive', () => {
    const { result } = setup();
    act(() => result.current.setCapability('session_config'));
    act(() => result.current.replace(OPTIONS));
    expect(result.current.availability).toBe('ready');
    expect(result.current.availability).toBe('ready');
    expect(result.current.options).toHaveLength(1);
  });

  /**
   * `none` / `per_turn` 都是 unsupported，**即便有残留选项**。
   *
   * 这是 R3（写路径必须显式失败）的 UI 侧保证：不能出现「显示了控件、
   * 点选静默无操作」的组合。
   */
  it.each(['none', 'per_turn'] as const)('should ignore stale options for capability %s', (cap) => {
    const { result } = setup();
    act(() => result.current.replace(OPTIONS));
    act(() => result.current.setCapability(cap));
    // `none` → `no-config`；`per_turn` → `per-turn`。**都不是** `ready` ——
    // 残留的会话内选项不影响传输能力。
    expect(result.current.availability).toBe(cap === 'none' ? 'no-config' : 'per-turn');
  });

  /**
   * **握手完成但 agent 没下发配置项** → `ready`（空列表），不是永久 `loading`。
   *
   * `session_start` 只来一次。若把「空 options」一直当成「还没到」，
   * 模型列表会永远灰着、提示永远说 "Models are loading…"。
   *
   * 后端契约（`capability_probe`）要求声明 `SessionConfig` 就必须带配置项，
   * 但前端不能依赖后端永远正确 —— 那正是 P1/P8 的教训。
   *
   * 变异验证：去掉 `setHandshaken(true)` → 本用例变红。
   */
  it('should become ready when the handshake arrived without config options', () => {
    const { result } = setup();
    act(() => result.current.applySessionStart('session_config', []));
    expect(result.current.availability).toBe('ready');
  });

  /** 握手前仍是 `loading` —— 不能因为「还没收到」就断言 `ready`。 */
  it('should stay loading before the handshake arrives', () => {
    const { result } = setup();
    expect(result.current.availability).toBe('pending');
    act(() => result.current.setCapability('session_config'));
    expect(result.current.availability).toBe('pending');
  });

  /**
   * `reset` 必须回到 `loading` 而不是 `unsupported`。
   *
   * `reset` 的语义是「换会话了」，新会话能力还没到 —— 此时断言 `none`
   * 会让切换 agent 时控件先消失、再在 `session_start` 后出现。
   */
  it('should return to loading on reset, not to unsupported', () => {
    const { result } = setup();
    act(() => result.current.setCapability('none'));
    expect(result.current.availability).toBe('no-config');

    act(() => result.current.reset());
    expect(result.current.availability).toBe('pending');
    expect(result.current.options).toEqual([]);
  });

  /**
   * 能力位原值必须透出：`per_turn` 与 `none` 在消费侧要能区分 ——
   * 前者仍要显示模型选择器（走每轮请求参数），后者整个隐藏。
   */
  it('should expose the composed availability for the composer', () => {
    const { result } = setup();
    act(() => result.current.setCapability('per_turn'));
    // `per_turn` 与就绪度无关 —— 它永远走每轮请求参数（serve 没有配置项通道）。
    expect(result.current.availability).toBe('per-turn');
  });
});
