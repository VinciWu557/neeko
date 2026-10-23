import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '@/shared/types';

/**
 * `agentStore` —— agent 配置的**唯一**前端缓存。
 *
 * 设计背景：后端 `AgentManager` 已是唯一真相，前端曾为「改完立刻看到」另存
 * `config.agentOverrides` 与 `config.agentCommandOverrides` 两份副本，导致
 * 设置页改完终端读不到、双击命令行编辑不落盘。这里只保留一份缓存，刷新由
 * 写操作（`saveAgent` / `resetAgent`）驱动。
 */

const listAgents = vi.fn<() => Promise<AgentConfig[]>>();

const { useAgentStore, setAgentLoader, __resetGenerationForTests } = await import('../agentStore');
const resetAgentStoreGeneration = __resetGenerationForTests;

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

describe('agentStore', () => {
  beforeEach(() => {
    listAgents.mockReset();
    setAgentLoader(listAgents);
    useAgentStore.setState({ agents: null, loading: false });
    // generation 是模块级状态，跨用例必须归零 —— 否则上一例的在途请求会
    // 让本例的 refresh 被判为「陈旧」。
    resetAgentStoreGeneration();
  });

  /**
   * 初值是 `null` 而不是 `[]` —— 「还没加载」与「后端确实没有 agent」是两种
   * 不同的事实。混用会让首次渲染闪一下「无 agent」。
   *
   * 这里断言的是**模块定义的初值**，所以必须读源码：`beforeEach` 会把 store
   * 重置成同一个值，从运行期观察不到「初值被写成 `[]`」这个变异。
   */
  it('declares null as the initial value, not an empty array', () => {
    const src = readFileSync(resolve(__dirname, '../agentStore.ts'), 'utf8');
    expect(src).toContain('agents: null');
    expect(src).not.toContain('agents: [],');
  });

  it('starts unloaded', () => {
    expect(useAgentStore.getState().agents).toBeNull();
  });

  it('refresh replaces the snapshot with the backend list', async () => {
    listAgents.mockResolvedValue([agent('opencode'), agent('pi')]);

    await useAgentStore.getState().refresh();

    expect(useAgentStore.getState().agents?.map((a) => a.id)).toEqual(['opencode', 'pi']);
  });

  /**
   * 失败时保留上次成功的快照。
   *
   * 置空会让终端在瞬时网络/IPC 故障后失去全部 agent —— 比「用旧数据」更糟。
   */
  it('keeps the last good snapshot when refresh fails', async () => {
    listAgents.mockResolvedValue([agent('opencode')]);
    await useAgentStore.getState().refresh();

    listAgents.mockRejectedValue(new Error('ipc down'));
    await expect(useAgentStore.getState().refresh()).rejects.toThrow('ipc down');

    expect(useAgentStore.getState().agents?.map((a) => a.id)).toEqual(['opencode']);
  });

  it('byId returns the matching agent', async () => {
    listAgents.mockResolvedValue([agent('opencode'), agent('pi')]);
    await useAgentStore.getState().refresh();

    expect(useAgentStore.getState().byId('pi')?.id).toBe('pi');
  });

  it('byId returns undefined for an unknown id', async () => {
    listAgents.mockResolvedValue([agent('opencode')]);
    await useAgentStore.getState().refresh();

    expect(useAgentStore.getState().byId('nope')).toBeUndefined();
  });

  /** 未加载时 `byId` 不触发请求 —— 终端在 PTY 回调里同步调用它。 */
  it('byId is undefined before loading and never triggers a fetch', () => {
    expect(useAgentStore.getState().byId('opencode')).toBeUndefined();
    expect(listAgents).not.toHaveBeenCalled();
  });

  it('setAgents replaces the snapshot without touching the backend', () => {
    useAgentStore.getState().setAgents([agent('mock')]);

    expect(useAgentStore.getState().agents?.map((a) => a.id)).toEqual(['mock']);
    expect(listAgents).not.toHaveBeenCalled();
  });

  /** 空列表是「后端确实没有 agent」，必须与未加载区分。 */
  it('an empty backend list is not the same as unloaded', async () => {
    listAgents.mockResolvedValue([]);

    await useAgentStore.getState().refresh();

    expect(useAgentStore.getState().agents).toEqual([]);
    expect(useAgentStore.getState().agents).not.toBeNull();
  });

  // ── generation 守卫：陈旧响应不得覆盖新快照 ────────────────────────

  /**
   * 复现真实时序：`ensure()` 的 preload 在途 → 用户保存 → 保存的 refresh
   * 先落地 → preload 的旧响应后落地。若不丢弃旧响应，store 会回退到保存前
   * 的快照，终端随即启动旧命令 —— 正是本任务要消灭的症状。
   */
  it('discards a stale response that resolves after a newer one', async () => {
    let resolveStale: (v: AgentConfig[]) => void = () => {};
    const stale = new Promise<AgentConfig[]>((r) => {
      resolveStale = r;
    });

    // 第一次调用（preload）挂起
    listAgents.mockReturnValueOnce(stale);
    const preload = useAgentStore.getState().refresh();

    // 第二次调用（保存后）先完成
    listAgents.mockResolvedValueOnce([agent('fresh')]);
    await useAgentStore.getState().refresh();
    expect(useAgentStore.getState().agents?.map((a) => a.id)).toEqual(['fresh']);

    // 旧响应此刻才到 —— 必须被丢弃
    resolveStale([agent('stale')]);
    await preload;

    expect(useAgentStore.getState().agents?.map((a) => a.id)).toEqual(['fresh']);
  });

  it('clears loading only when the latest generation settles', async () => {
    let resolveStale: (v: AgentConfig[]) => void = () => {};
    const stale = new Promise<AgentConfig[]>((r) => {
      resolveStale = r;
    });

    listAgents.mockReturnValueOnce(stale);
    const preload = useAgentStore.getState().refresh();

    listAgents.mockResolvedValueOnce([agent('fresh')]);
    await useAgentStore.getState().refresh();
    expect(useAgentStore.getState().loading).toBe(false);

    resolveStale([agent('stale')]);
    await preload;
    // 早期响应不得把 loading 重新点亮或保持为 true
    expect(useAgentStore.getState().loading).toBe(false);
  });

  // ── ensure：幂等加载 ──────────────────────────────────────────────

  /** 每个消费方都可以调 `ensure()`，不重复请求 —— 消费方因此不需要副本。 */
  it('ensure loads once and reuses the snapshot', async () => {
    listAgents.mockResolvedValue([agent('opencode')]);

    await Promise.all([
      useAgentStore.getState().ensure(),
      useAgentStore.getState().ensure(),
      useAgentStore.getState().ensure(),
    ]);

    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().agents?.map((a) => a.id)).toEqual(['opencode']);

    // 已加载 → 后续 ensure 不再请求
    await useAgentStore.getState().ensure();
    expect(listAgents).toHaveBeenCalledTimes(1);
  });

  /** 并发 ensure 不能重复请求（否则 N 个消费方 = N 次 IPC）。 */
  it('concurrent ensure calls share one in-flight request', async () => {
    let resolve: (v: AgentConfig[]) => void = () => {};
    listAgents.mockReturnValue(
      new Promise<AgentConfig[]>((r) => {
        resolve = r;
      }),
    );

    const a = useAgentStore.getState().refresh();
    // 第二个 ensure 在第一个尚未完成时进入 —— 必须复用而非再发起
    const b = useAgentStore.getState().ensure();

    resolve([agent('x')]);
    await Promise.all([a, b]);

    expect(listAgents).toHaveBeenCalledTimes(1);
  });
});
