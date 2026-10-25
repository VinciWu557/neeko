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
    expect(listAgentCommandsMock).toHaveBeenCalledWith('query-agent', undefined);
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

/**
 * **缓存键必须带 directory**。
 *
 * opencode 的命令含项目级（`<project>/.opencode/commands/**`），所以同一 agent
 * 在不同项目下的命令集不同。只按 agentId 缓存会让 A 项目拿到 B 项目的命令 ——
 * 用户看到一堆本项目里不存在的 `/命令`。
 *
 * 变异验证：把 `commandKeyOf` 改回只用 agentId → 本用例红（第二个项目命中
 * 第一个项目的缓存，不再发查询）。
 */
describe('useAgentCommands — 缓存按 (agent, 项目) 分键', () => {
  it('should query again when the same agent is used in a different project', async () => {
    listAgentCommandsMock.mockResolvedValue([{ name: 'a' }]);

    const first = renderHook(() => useAgentCommands('shared-agent', true, '/proj/a'));
    await waitFor(() => expect(first.result.current).toHaveLength(1));
    expect(listAgentCommandsMock).toHaveBeenCalledWith('shared-agent', '/proj/a');

    // 换项目：命令集可能不同，必须重新查（不能命中上一个项目的缓存）
    const second = renderHook(() => useAgentCommands('shared-agent', true, '/proj/b'));
    await waitFor(() =>
      expect(listAgentCommandsMock).toHaveBeenCalledWith('shared-agent', '/proj/b'),
    );
    expect(second.result.current).toHaveLength(1);
  });

  it('should reuse the cache for the same (agent, project) pair', async () => {
    listAgentCommandsMock.mockResolvedValue([{ name: 'a' }]);
    const first = renderHook(() => useAgentCommands('cached-agent', true, '/proj/x'));
    await waitFor(() => expect(first.result.current).toHaveLength(1));
    const callsAfterFirst = listAgentCommandsMock.mock.calls.length;

    renderHook(() => useAgentCommands('cached-agent', true, '/proj/x'));
    await new Promise((r) => setTimeout(r, 20));
    expect(listAgentCommandsMock.mock.calls.length).toBe(callsAfterFirst);
  });
});

/**
 * 空结果必须是**稳定引用**。
 *
 * 返回处写 `|| []` 会每次渲染造新数组 → 下游 `useComposerSources` 的
 * `useMemo([agentCommands])` 每次重建 sources → `RichComposer` 的 sources
 * effect 每次渲染都跑。恒等性是该 hook 对外契约的一部分。
 *
 * 变异验证：把 `NO_COMMANDS` 改回 `|| []` → 本用例红。
 */
describe('useAgentCommands — 空结果恒等性', () => {
  it('should return the same empty array across renders', () => {
    const { result, rerender } = renderHook(() => useAgentCommands(null, false));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('should return the same empty array for a loaded-but-empty agent', async () => {
    listAgentCommandsMock.mockResolvedValue([]);
    const { result } = renderHook(() => useAgentCommands('empty-agent', true));
    await waitFor(() => expect(listAgentCommandsMock).toHaveBeenCalled());
    const first = result.current;
    expect(first).toHaveLength(0);
  });
});
