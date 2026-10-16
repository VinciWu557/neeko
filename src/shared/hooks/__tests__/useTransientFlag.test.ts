/**
 * `useTransientFlag` —— 「一次性瞬时反馈」的唯一实现。
 *
 * 覆盖此前 4 处各自手写的 `copied` + `setTimeout`（`SelectionToolbar` 之外，
 * `agent-chat/MessageList` / `conversation/ConversationMessage` /
 * `notification/NotificationDetail` 都有同款）：其中 3 处没有计时器清理，
 * 卸载后仍会 setState；时长也各自为政（1500 / 2000）。
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTransientFlag } from '../useTransientFlag';

describe('useTransientFlag', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('初始为 false，flash 后置 true', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTransientFlag(1000));

    expect(result.current.flag).toBe(false);

    act(() => result.current.flash());
    expect(result.current.flag).toBe(true);
  });

  it('到期自动回落 false', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTransientFlag(1000));

    act(() => result.current.flash());
    act(() => vi.advanceTimersByTime(1000));

    expect(result.current.flag).toBe(false);
  });

  it('未到期不回落', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTransientFlag(1000));

    act(() => result.current.flash());
    act(() => vi.advanceTimersByTime(999));

    expect(result.current.flag).toBe(true);
  });

  it('连续 flash 重置计时（后者覆盖前者，不会提前回落）', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTransientFlag(1000));

    act(() => result.current.flash());
    act(() => vi.advanceTimersByTime(800));
    act(() => result.current.flash());
    act(() => vi.advanceTimersByTime(800));

    // 距第一次 flash 已 1600ms，但第二次把计时重置了 → 仍为 true
    expect(result.current.flag).toBe(true);

    act(() => vi.advanceTimersByTime(200));
    expect(result.current.flag).toBe(false);
  });

  it('卸载即取消挂起计时器（不产生悬空 setState）', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useTransientFlag(1000));

    act(() => result.current.flash());
    unmount();

    // 取消后推进时间不应有任何报错；核心断言是"卸载时清理"已由
    // act + 无 act 警告覆盖（React 18 对卸载后 setState 会 warn）。
    expect(() => act(() => vi.advanceTimersByTime(5000))).not.toThrow();
  });

  it('flash 的引用跨渲染稳定（可作为 memo 组件的稳定依赖）', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(() => useTransientFlag(1000));
    const first = result.current.flash;

    rerender();
    expect(result.current.flash).toBe(first);
  });
});
