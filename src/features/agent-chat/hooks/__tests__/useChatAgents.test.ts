import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { __resetGenerationForTests, useAgentStore } from '@/shared/store/agentStore';
import type { AgentConfig } from '@/shared/types/agent';

import { useChatAgents } from '../useChatAgents';

/**
 * `useChatAgents` 是 **agentStore 的派生视图**，不是独立数据源。
 *
 * # 为什么这个契约重要
 *
 * 旧实现是「空依赖 `useEffect` + 独立 `useState`」：只在挂载时 `listChatAgents()`
 * 一次。于是用户在设置里关掉某个 agent 的 chat 并保存后，chat 页的下拉仍是旧列表
 * —— 选中那一项才由 `adapter_for` 报错，而它看起来完全正常。
 */

const AGENTS: AgentConfig[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    args: [],
    env: {},
    enabled: true,
    chat: { args: ['acp'] },
  },
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi',
    args: [],
    env: {},
    enabled: true,
    chat: { args: ['--mode', 'rpc'] },
  },
];

function seed(agents: AgentConfig[] | null) {
  act(() => {
    useAgentStore.setState({ agents, loading: false });
  });
}

describe('useChatAgents — derived from agentStore', () => {
  beforeEach(() => {
    __resetGenerationForTests();
    seed(null);
  });

  it('uses the real agent when the id matches the list', () => {
    seed(AGENTS);
    const { result } = renderHook(() => useChatAgents('pi'));
    expect(result.current.chatAgents).toHaveLength(2);
    expect(result.current.selectedAgent).toEqual({ id: 'pi', name: 'Pi', icon: undefined });
  });

  /**
   * **`agentId` 未落定时取列表首项，不硬编码 mockAgent。**
   *
   * 变异验证：把 fallback 改回 `AGENT_IDS.mockAgent` → 本用例变红。
   */
  it('falls back to the first real agent when no id is settled', () => {
    seed(AGENTS);
    const { result } = renderHook(() => useChatAgents(undefined));
    expect(result.current.selectedAgent.id).toBe('claude-code');
    expect(result.current.selectedAgent.id).not.toBe('mockAgent');
  });

  it('falls back to the first agent when the id is not in the list', () => {
    seed(AGENTS);
    const { result } = renderHook(() => useChatAgents('removed-agent'));
    expect(result.current.selectedAgent.id).toBe('claude-code');
  });

  it('returns an empty shell before the list arrives', () => {
    const { result } = renderHook(() => useChatAgents(undefined));
    expect(result.current.chatAgents).toHaveLength(0);
    expect(result.current.selectedAgent.id).toBe('');
    expect(result.current.selectedAgent.icon).toBeNull();
  });

  /**
   * **关掉 chat 后列表立即少一项** —— 这是本任务修复的核心缺陷。
   *
   * 旧实现在挂载时拉一次快照，`saveAgent()` 的 refresh 打不到它。
   */
  it('drops an agent as soon as its chat is disabled', () => {
    seed(AGENTS);
    const { result } = renderHook(() => useChatAgents('pi'));
    expect(result.current.chatAgents.map((a) => a.id)).toEqual(['claude-code', 'pi']);

    act(() => {
      useAgentStore.setState({
        agents: AGENTS.map((a) => (a.id === 'pi' ? { ...a, chat_enabled: false } : a)),
      });
    });

    expect(result.current.chatAgents.map((a) => a.id)).toEqual(['claude-code']);
    // 选中的那个已经不可聊 → 回落到首项，而不是继续指向它。
    expect(result.current.selectedAgent.id).toBe('claude-code');
  });

  /** 用户重新打开 chat → 列表恢复（不只是「能关不能开」）。 */
  it('restores the agent when chat is re-enabled', () => {
    seed(AGENTS.map((a) => (a.id === 'pi' ? { ...a, chat_enabled: false } : a)));
    const { result } = renderHook(() => useChatAgents(undefined));
    expect(result.current.chatAgents.map((a) => a.id)).toEqual(['claude-code']);

    act(() => {
      useAgentStore.setState({ agents: AGENTS });
    });

    expect(result.current.chatAgents.map((a) => a.id)).toEqual(['claude-code', 'pi']);
  });

  /** 没有 chat 出厂能力的 agent 永远不出现（`chat_enabled: true` 不能凭空造能力）。 */
  it('never lists an agent that has no chat launch at all', () => {
    seed([
      ...AGENTS,
      {
        id: 'gemini',
        name: 'Gemini',
        command: 'gemini',
        args: [],
        env: {},
        enabled: true,
        chat: null,
        chat_enabled: true,
      },
    ]);
    const { result } = renderHook(() => useChatAgents(undefined));
    expect(result.current.chatAgents.map((a) => a.id)).toEqual(['claude-code', 'pi']);
  });
});
