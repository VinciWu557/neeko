/**
 * `useAgentCommands` 的行为直测。
 *
 * # 为什么能力位门控必须在这里钉住
 *
 * 「能不能弹 `/`」的唯一判据是 `SessionStart.capabilities.commands` 能力位
 * （R2 修订版）。enabled=false 时**连查询都不发** —— 不靠「试查询报错」判定
 * 能力（spec `agent-chat-transports.md` §10.1 明文修掉的 P1 缺陷形态）。
 *
 * 变异验证：把 hook 里的 `if (!enabled || !agentId)` 改成只判 agentId →
 * 「不查询」用例红。
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listAgentCommandsMock = vi.fn();

vi.mock('../../api/agentChatApi', () => ({
  listAgentCommands: (...args: unknown[]) => listAgentCommandsMock(...args),
}));

import { useAgentCommands } from '../useAgentCommands';

const PI_COMMANDS = [
  { name: 'trellis-continue', description: 'Continue Current Task', source: 'prompt' },
  { name: 'skill:code-walkthrough', description: 'walk through code', source: 'skill' },
];

describe('useAgentCommands', () => {
  beforeEach(() => {
    listAgentCommandsMock.mockReset();
  });

  it('should not query at all when the capability bit is false', () => {
    renderHook(() => useAgentCommands('pi', false));
    expect(listAgentCommandsMock).not.toHaveBeenCalled();
  });

  it('should not query without a settled agent id either', () => {
    renderHook(() => useAgentCommands(null, true));
    expect(listAgentCommandsMock).not.toHaveBeenCalled();
  });

  it('should return the command list when enabled', async () => {
    listAgentCommandsMock.mockResolvedValue(PI_COMMANDS);
    const { result } = renderHook(() => useAgentCommands('query-agent', true));
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(listAgentCommandsMock).toHaveBeenCalledWith('query-agent');
  });

  it('should cache per agent id across remounts (session-lifetime)', async () => {
    listAgentCommandsMock.mockResolvedValue(PI_COMMANDS);
    const first = renderHook(() => useAgentCommands('cache-agent', true));
    await waitFor(() => expect(first.result.current).toHaveLength(2));

    // 卸载重挂：同 agentId 命中缓存，不再发起第二次查询。
    const second = renderHook(() => useAgentCommands('cache-agent', true));
    expect(second.result.current).toHaveLength(2);
    expect(listAgentCommandsMock).toHaveBeenCalledTimes(1);

    // 不同 agentId 是独立缓存槽，必须各查各的。
    listAgentCommandsMock.mockResolvedValue([]);
    const other = renderHook(() => useAgentCommands('other-agent', true));
    await waitFor(() => expect(other.result.current).toHaveLength(0));
    expect(listAgentCommandsMock).toHaveBeenCalledTimes(2);
  });

  it('should degrade to an empty list on failure (empty state, not an error popup)', async () => {
    listAgentCommandsMock.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAgentCommands('failing-agent', true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual([]);
  });
});
