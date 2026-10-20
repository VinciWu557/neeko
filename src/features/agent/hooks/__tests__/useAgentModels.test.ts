/**
 * `useAgentModels` 的行为测试。
 *
 * 两件核心的事：
 * 1. **竞态** —— agent 往返切换时先发的请求可能后到，没有取消判据会让旧列表盖在
 *    新选择上（表现为「换了 agent，模型下拉还是上一个的」）。
 * 2. **四种处境可区分** —— 有列表 / 会话内可选 / 不支持 / 拉取失败。把它们压成空
 *    数组就无法给出正确措辞（旧实现正是如此，用户只看到永久禁用的 "No models"）。
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listAgentModels = vi.fn();

vi.mock('@/features/agent/api/agentApi', () => ({
  listAgentModels: (...args: unknown[]) => listAgentModels(...args),
}));

const { useAgentModels } = await import('../useAgentModels');

const model = (id: string) => ({ id, name: id });
const available = (ids: string[]) => ({
  kind: 'available' as const,
  models: ids.map(model),
});

beforeEach(() => {
  listAgentModels.mockReset();
});

describe('useAgentModels', () => {
  it('should treat a missing agent as unsupported', () => {
    const { result } = renderHook(() => useAgentModels(null));
    expect(result.current.state.kind).toBe('unsupported');
    expect(listAgentModels).not.toHaveBeenCalled();
  });

  it('should load models for the given agent', async () => {
    listAgentModels.mockResolvedValue(available(['a', 'b']));
    const { result } = renderHook(() => useAgentModels('claude-code'));

    await waitFor(() => expect(result.current.models).toHaveLength(2));
    expect(result.current.state.kind).toBe('available');
    expect(listAgentModels).toHaveBeenCalledWith('claude-code');
  });

  /** ACP agent：列表只能在会话内取，这不是错误。 */
  it('should expose session-scoped capability without models', async () => {
    listAgentModels.mockResolvedValue({ kind: 'session-scoped' });
    const { result } = renderHook(() => useAgentModels('claude-code'));

    await waitFor(() => expect(result.current.state.kind).toBe('session-scoped'));
    expect(result.current.models).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('should expose unsupported capability', async () => {
    listAgentModels.mockResolvedValue({ kind: 'unsupported' });
    const { result } = renderHook(() => useAgentModels('plain-cli'));

    await waitFor(() => expect(result.current.state.kind).toBe('unsupported'));
    expect(result.current.models).toEqual([]);
  });

  /**
   * 拉取失败必须可见。静默降级会让「后端报错」看起来像「这个 agent 本来就没有模型」，
   * 用户因此不会去重试也不会报告问题。
   */
  it('should surface a fetch failure as an error state', async () => {
    listAgentModels.mockRejectedValue(new Error('ipc broke'));
    const { result } = renderHook(() => useAgentModels('x'));

    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    expect(result.current.state).toMatchObject({ message: 'ipc broke' });
  });

  /** `reload` 用于错误态下的「重试」。 */
  it('should refetch when reload is called', async () => {
    listAgentModels.mockRejectedValueOnce(new Error('boom'));
    listAgentModels.mockResolvedValueOnce(available(['a']));

    const { result } = renderHook(() => useAgentModels('x'));
    await waitFor(() => expect(result.current.state.kind).toBe('error'));

    result.current.reload();
    await waitFor(() => expect(result.current.state.kind).toBe('available'));
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
      .mockResolvedValueOnce(available(['b-only']));

    const { result, rerender } = renderHook(({ id }: { id: string }) => useAgentModels(id), {
      initialProps: { id: 'agent-a' },
    });

    rerender({ id: 'agent-b' });
    await waitFor(() => expect(result.current.models.map((m) => m.id)).toEqual(['b-only']));

    // A 的响应晚到 —— 必须被丢弃
    resolveA(available(['a-only']));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.models.map((m) => m.id)).toEqual(['b-only']);
  });
});
