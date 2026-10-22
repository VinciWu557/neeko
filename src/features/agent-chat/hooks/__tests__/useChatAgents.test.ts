import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', command: 'claude', chat: 'acp' },
  { id: 'pi', name: 'Pi', command: 'pi', chat: 'pi-rpc' },
];

vi.mock('@/features/agent/api/agentApi', () => ({
  listChatAgents: vi.fn(() => Promise.resolve(AGENTS)),
}));

import { useChatAgents } from '../useChatAgents';

describe('useChatAgents — selectedAgent 派生', () => {
  /** 命中的 agent 用它的真实数据（名字 / 图标）。 */
  it('should use the real agent when the id matches the list', async () => {
    const { result } = renderHook(() => useChatAgents('pi'));
    await waitFor(() => expect(result.current.chatAgents).toHaveLength(2));
    expect(result.current.selectedAgent).toEqual({ id: 'pi', name: 'Pi', icon: undefined });
  });

  /**
   * **`agentId` 未落定时取列表首项，不硬编码 mockAgent。**
   *
   * 旧实现返回 `AGENT_IDS.mockAgent`，于是首帧永远显示 "mockAgent" ——
   * 与用户实际选的 agent 无关，且会让用户以为选中了它。
   *
   * 变异验证：把 fallback 改回 `AGENT_IDS.mockAgent` → 本用例变红。
   */
  it('should fall back to the first real agent when no id is settled', async () => {
    const { result } = renderHook(() => useChatAgents(undefined));
    await waitFor(() => expect(result.current.chatAgents).toHaveLength(2));
    expect(result.current.selectedAgent.id).toBe('claude-code');
    expect(result.current.selectedAgent.name).toBe('Claude Code');
    // 绝不出现 mockAgent
    expect(result.current.selectedAgent.id).not.toBe('mockAgent');
  });

  /** `agentId` 不在列表里（如已被禁用/删除）→ 同样落到首项，而不是显示一个裸 id。 */
  it('should fall back to the first agent when the id is not in the list', async () => {
    const { result } = renderHook(() => useChatAgents('removed-agent'));
    await waitFor(() => expect(result.current.chatAgents).toHaveLength(2));
    expect(result.current.selectedAgent.id).toBe('claude-code');
  });

  /** 列表还没到 → 空壳（渲染方用占位图标），不假装是某个 agent。 */
  it('should return an empty shell before the list arrives', () => {
    const { result } = renderHook(() => useChatAgents(undefined));
    expect(result.current.chatAgents).toHaveLength(0);
    expect(result.current.selectedAgent.id).toBe('');
    expect(result.current.selectedAgent.icon).toBeNull();
  });
});
