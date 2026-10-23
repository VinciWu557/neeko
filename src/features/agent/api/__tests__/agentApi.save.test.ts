import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '@/shared/types';

/**
 * 写路径的唯一出口：`saveAgent` / `resetAgent`。
 *
 * 判据：**落盘成功后才刷新缓存**。反过来的话，落盘失败时界面已经显示新值，
 * 用户会以为保存成功 —— 那正是本轮要消灭的失败模式。
 */

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
const refresh = vi.fn<() => Promise<void>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  convertFileSrc: (p: string) => p,
}));

vi.mock('@/shared/store/agentStore', () => ({
  setAgentLoader: () => {},
  useAgentStore: {
    getState: () => ({ refresh }),
  },
}));

const { saveAgent, resetAgent } = await import('../agentApi');

function agent(id: string, patch: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    name: id,
    enabled: true,
    command: id,
    args: [],
    env: {},
    ...patch,
  } as AgentConfig;
}

describe('saveAgent', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
    refresh.mockReset().mockResolvedValue(undefined);
  });

  it('persists through add_agent', async () => {
    await saveAgent(agent('custom'));

    expect(invoke).toHaveBeenCalledWith('add_agent', { agent: agent('custom') });
  });

  /** 刷新发生在落盘**之后** —— 先刷新会读到旧值，界面短暂回退。 */
  it('refreshes the cache only after the write succeeds', async () => {
    const order: string[] = [];
    invoke.mockImplementation(async () => {
      order.push('invoke');
    });
    refresh.mockImplementation(async () => {
      order.push('refresh');
    });

    await saveAgent(agent('custom'));

    expect(order).toEqual(['invoke', 'refresh']);
  });

  /**
   * 落盘失败时**不刷新**。
   *
   * 刷新会用一个「与用户刚提交的值不同」的快照覆盖界面 —— 看起来像保存成功
   * 了但值没变，或者像被回滚了。正确行为是抛错让调用方提示。
   */
  it('does not refresh when the write fails', async () => {
    invoke.mockRejectedValue(new Error('disk full'));

    await expect(saveAgent(agent('custom'))).rejects.toThrow('disk full');
    expect(refresh).not.toHaveBeenCalled();
  });

  /**
   * 内置 agent 保存时保留 `is_builtin`。
   *
   * 丢了它后端会把它当自定义 agent 写进 `customAgents`，产生一份内置副本，
   * 且 Reset 按钮消失（`BuiltInAgentsSection` 按它判断）。
   */
  it('keeps is_builtin for built-in agents', async () => {
    await saveAgent(agent('opencode', { is_builtin: true }));

    const [, payload] = invoke.mock.calls[0] as [string, { agent: AgentConfig }];
    expect(payload.agent.is_builtin).toBe(true);
  });

  /** 自定义 agent 不得被伪造成内置。 */
  it('does not fabricate is_builtin for custom agents', async () => {
    await saveAgent(agent('mine'));

    const [, payload] = invoke.mock.calls[0] as [string, { agent: AgentConfig }];
    expect(payload.agent.is_builtin).toBeFalsy();
  });
});

describe('resetAgent', () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
    refresh.mockReset().mockResolvedValue(undefined);
  });

  it('clears the override through remove_agent', async () => {
    await resetAgent('opencode');

    expect(invoke).toHaveBeenCalledWith('remove_agent', { agentId: 'opencode' });
  });

  it('refreshes after the reset succeeds', async () => {
    const order: string[] = [];
    invoke.mockImplementation(async () => {
      order.push('invoke');
    });
    refresh.mockImplementation(async () => {
      order.push('refresh');
    });

    await resetAgent('opencode');

    expect(order).toEqual(['invoke', 'refresh']);
  });

  it('does not refresh when the reset fails', async () => {
    invoke.mockRejectedValue(new Error('nope'));

    await expect(resetAgent('opencode')).rejects.toThrow('nope');
    expect(refresh).not.toHaveBeenCalled();
  });
});
