import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelInfo } from '@/features/agent/api/agentApi';

const updateTab = vi.hoisted(() => vi.fn());
vi.mock('@/shared/store/editorStore', () => ({
  useEditorStore: { getState: () => ({ updateTab }) },
}));

import { useSelectedModel } from '../useSelectedModel';

const MODEL = { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' } as ModelInfo;

/**
 * 选中模型的状态 + 跨 tab 持久化。
 *
 * 两条都是**实测事故**的钉子：
 * 1. 切走再切回来，模型必须还是用户上次选的那个（组件会卸载重挂）。
 * 2. 两个写入来源（用户点选 / 会话主动换模型）都必须落盘 —— 否则「UI 显示 A、
 *    实际跑 B」。
 */
describe('useSelectedModel', () => {
  beforeEach(() => updateTab.mockClear());

  it('should seed the selection from the persisted tab data', () => {
    const { result } = renderHook(() => useSelectedModel('k', 't1', 'deepseek-v4-pro'));
    expect(result.current.selectedModel?.id).toBe('deepseek-v4-pro');
  });

  it('should start empty when the tab has no persisted model', () => {
    const { result } = renderHook(() => useSelectedModel('k', 't1', undefined));
    expect(result.current.selectedModel).toBeNull();
  });

  it('should persist every selection change to the tab data', () => {
    const { result } = renderHook(() => useSelectedModel('k', 't1', undefined));

    act(() => result.current.setSelectedModel(MODEL));

    expect(updateTab).toHaveBeenCalledWith('k', 't1', { modelId: 'deepseek-v4-pro' });
  });

  /**
   * 无选择时**也要写**一次 `modelId: undefined`。
   *
   * 这条曾经断言「不该有任何写入」，但那个预期是错的：挂载时若不把 tab data
   * 对齐到当前状态，切 agent 清空后残留的旧 id 会在下次挂载时被当初值复活。
   * 写一次 `undefined` 是幂等的，代价可忽略。
   */
  it('should clear the tab data when mounted with no selection', () => {
    renderHook(() => useSelectedModel('k', 't1', undefined));
    expect(updateTab).toHaveBeenCalledWith('k', 't1', { modelId: undefined });
  });

  /**
   * **切换 agent 必须丢掉旧 agent 的模型选择。**
   *
   * 旧 agent 的模型 id 对新 agent 可能根本不存在（Pi 的 `deepseek-v4-pro` 与
   * opencode 的 `anthropic/claude-sonnet-4-5` 毫无交集）。留着它有两个后果：
   *
   * 1. `useAgentSessionLifecycle` 会把它当 `modelId` 传给 `agent_chat_open`，
   *    ACP 在 `create()` 里预切模型 → 新 agent 收到一个不认识的模型 id；
   * 2. UI 显示一个列表里根本没有的模型名（`useSelectedModelSync` 的
   *    `models.find` 找不到 → 回落到 `models[0]`，但持久化值仍是旧的）。
   *
   * 变异验证：去掉 `clear()` 里的 `setSelectedModel(null)` → 本用例变红。
   */
  it('should drop the selection when the agent changes', () => {
    const { result } = renderHook(() => useSelectedModel('k', 't1', 'pi-only-model'));
    expect(result.current.selectedModel?.id).toBe('pi-only-model');

    act(() => result.current.clear());

    expect(result.current.selectedModel).toBeNull();
  });

  /** 清空后 tab data 也要同步清掉，否则切回来又会被旧 id 顶回去。 */
  it('should persist the cleared selection so a remount does not resurrect it', () => {
    const { result } = renderHook(() => useSelectedModel('k', 't1', 'pi-only-model'));
    updateTab.mockClear();

    act(() => result.current.clear());

    expect(updateTab).toHaveBeenCalledWith('k', 't1', { modelId: undefined });
  });
});
