/**
 * `useAgentModels` 的行为测试。
 *
 * 重点是**竞态**：agent 往返切换时，先发的请求可能后到。没有取消判据的话，
 * 旧列表会盖在新选择上 —— 表现为「换了 agent，模型下拉还是上一个的」。
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listAgentModels = vi.fn();

vi.mock('@/features/agent/api/agentApi', () => ({
  listAgentModels: (...args: unknown[]) => listAgentModels(...args),
}));

const { useAgentModels } = await import('../useAgentModels');

const model = (id: string) => ({
  id,
  name: id,
  supported_reasoning_efforts: [],
  is_free: false,
});

beforeEach(() => {
  listAgentModels.mockReset();
});

describe('useAgentModels', () => {
  it('should return an empty list when there is no agent', () => {
    const { result } = renderHook(() => useAgentModels(null));
    expect(result.current.models).toEqual([]);
    expect(listAgentModels).not.toHaveBeenCalled();
  });

  it('should load models for the given agent', async () => {
    listAgentModels.mockResolvedValue([model('a'), model('b')]);
    const { result } = renderHook(() => useAgentModels('claude-code'));

    await waitFor(() => expect(result.current.models).toHaveLength(2));
    expect(listAgentModels).toHaveBeenCalledWith('claude-code');
  });

  /** 失败必须静默降级为空列表：模型列表是便利项，不是功能前提。 */
  it('should degrade to an empty list when the call fails', async () => {
    listAgentModels.mockRejectedValue(new Error('not supported'));
    const { result } = renderHook(() => useAgentModels('x'));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.models).toEqual([]);
  });

  /**
   * 竞态：agent A 的慢响应不得覆盖 agent B 的列表。
   * 这是本 hook 存在的核心理由（三处重复实现都各自踩过）。
   */
  it('should ignore a stale response after the agent changes', async () => {
    let resolveA: (v: unknown) => void = () => {};
    listAgentModels
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveA = r;
          }),
      )
      .mockResolvedValueOnce([model('b-only')]);

    const { result, rerender } = renderHook(({ id }: { id: string }) => useAgentModels(id), {
      initialProps: { id: 'agent-a' },
    });

    rerender({ id: 'agent-b' });
    await waitFor(() => expect(result.current.models.map((m) => m.id)).toEqual(['b-only']));

    // A 的响应晚到 —— 必须被丢弃
    resolveA([model('a-only')]);
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.models.map((m) => m.id)).toEqual(['b-only']);
  });
});
