import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolCard } from '../../types';
import { useWorkingStatus } from '../useWorkingStatus';

/**
 * 回合指示器的数据源（已进行时长 + 活动工具）。
 *
 * # 为什么这个 hook 必须直测
 *
 * 它有三个易错点，且都只在**时间推进**时才暴露：
 *
 * | 点 | 错的后果 |
 * | --- | --- |
 * | `turnStart === null` | 除零 / 显示一个假的时长 |
 * | 「最近一个 running」的方向 | 同时跑两个工具时显示**旧**的那个 |
 * | `streaming` 开启那一拍 | 首拍是上一轮遗留值，最长 1s 后才跳变 |
 *
 * 时间用 fake timers 控制 —— 真实 `setInterval` 会让单测依赖墙钟
 * （`check_long_git_op_wall_clock` 的同类理由）。
 */

function tool(name: string, status: ToolCard['status']): ToolCard {
  return { callId: `c-${name}`, name, title: name, status };
}

function setup(streaming: boolean, turnStart: number | null, tools: ToolCard[]) {
  const turnStartRef = { current: turnStart };
  const turnToolsRef = { current: tools };
  const hook = renderHook(() => useWorkingStatus(streaming, turnStartRef, turnToolsRef));
  return { ...hook, turnStartRef, turnToolsRef };
}

describe('useWorkingStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should report zero duration and no tool before a turn starts', () => {
    const { result } = setup(false, null, []);
    expect(result.current.durationMs).toBe(0);
    expect(result.current.activeTool).toBeNull();
  });

  it('should derive the duration from the turn start ref', () => {
    const start = Date.now();
    vi.setSystemTime(new Date(start + 3000));
    const { result } = setup(false, start, []);
    expect(result.current.durationMs).toBe(3000);
  });

  it('should pick the most recent still-running tool', () => {
    // 两个工具都在跑 → 显示**后开始**的那个（数组末尾）
    const { result } = setup(false, Date.now(), [
      tool('read_file', 'running'),
      tool('bash', 'running'),
    ]);
    expect(result.current.activeTool).toBe('bash');
  });

  it('should ignore tools that already settled', () => {
    const { result } = setup(false, Date.now(), [
      tool('read_file', 'done'),
      tool('bash', 'failed'),
    ]);
    expect(result.current.activeTool).toBeNull();
  });

  it('should refresh once per second while streaming', () => {
    const start = Date.now();
    const { result } = setup(true, start, [tool('bash', 'running')]);

    expect(result.current.durationMs).toBe(0);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.durationMs).toBe(2000);
  });

  it('should not keep a timer when not streaming', () => {
    const { result } = setup(false, Date.now(), [tool('bash', 'running')]);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    // 未开启 → 不刷新（值停在渲染期算的那一拍）
    expect(result.current.durationMs).toBe(0);
  });

  /**
   * **开启流式的那一拍必须立即采样。**
   *
   * 场景：上一轮结束把 ref 重置成 0；用户在 3s 前就点了发送（`handleSend` 先写
   * `turnStartRef`，`streaming` 随后才变 true）。若只在 interval 里刷新，首拍
   * 会显示 **0s**，最长 1s 后才跳成真实值 —— 用户看到时长「卡住不动」。
   *
   * 变异验证：删掉 effect 里的 `setStatus(snapshot(...))` → 本用例变红。
   */
  it('should sample immediately when streaming turns on', () => {
    const turnStartRef: { current: number | null } = { current: null };
    const turnToolsRef: { current: ToolCard[] } = { current: [] };

    // 挂载时上一轮已结束：时长 0、无活动工具
    const { result, rerender } = renderHook(
      ({ streaming }) => useWorkingStatus(streaming, turnStartRef, turnToolsRef),
      { initialProps: { streaming: false } },
    );
    expect(result.current.durationMs).toBe(0);
    expect(result.current.activeTool).toBeNull();

    // 用户在 3s 前就点了发送（`handleSend` 先写 ref），随后 `streaming` 才变 true
    const start = Date.now() - 3000;
    turnStartRef.current = start;
    turnToolsRef.current = [tool('read_file', 'running')];
    rerender({ streaming: true });

    // 开启那一拍就该是真实值，而不是上一轮遗留的 0
    expect(result.current.durationMs).toBe(3000);
    expect(result.current.activeTool).toBe('read_file');
  });
});
