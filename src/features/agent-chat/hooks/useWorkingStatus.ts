import { useEffect, useState } from 'react';

import type { ToolCard } from '../types';

/**
 * 流式回合指示器的数据源：已进行多久 + 正在跑哪个工具。
 *
 * # 为什么是一个 hook 而不是组件内 useState
 *
 * 时长需要每秒重渲（`Date.now() - turnStart`），活动工具要从 ref 账本里读
 * 「最近一个还在 running 的工具」—— 两者都是**派生状态**，不该由调用方各自维护。
 *
 * # 时间源
 *
 * `turnStartRef` 由 `useTurnStream` 在 `turn_start` 时写入（`Date.now()`）。
 * 这里只读它 —— 自己另存一份会在 reset 时漂移（ref 是唯一权威）。
 * 这里只读它 —— 自己另存一份会在 reset 时漂移（ref 是唯一权威）。
 *
 * # 为什么 `streaming` 翻转时也要重算快照
 *
 * 本 hook 不会因 `streaming` 而重挂（调用方没传 `key`）。若只在挂载时算初值，
 * 那么「上一轮结束已重置为 0」→ 新一刚开始 → 首拍会显示 **0s** 且活动工具为空，
 * 直到第一个 interval 触发才跳变（最多 1s 的谎报）。所以 effect 在 `streaming`
 * 变为 `true` 的那一刻同步采样一次。
 */
export interface WorkingStatus {
  /** 本回合已进行的毫秒数；未开始（`turnStart === null`）为 `0`。 */
  durationMs: number;
  /** 最近一个仍在 running 的工具名；没有则 `null`。 */
  activeTool: string | null;
}

/** 读一拍「时长 + 活动工具」（渲染期与 interval 共用）。 */
function snapshot(
  turnStartRef: React.MutableRefObject<number | null>,
  turnToolsRef: React.MutableRefObject<ToolCard[]>,
): { durationMs: number; activeTool: string | null } {
  const start = turnStartRef.current;
  const running = [...turnToolsRef.current].reverse().find((t) => t.status === 'running');
  return {
    durationMs: start === null ? 0 : Date.now() - start,
    activeTool: running?.name ?? null,
  };
}

export function useWorkingStatus(
  streaming: boolean,
  turnStartRef: React.MutableRefObject<number | null>,
  turnToolsRef: React.MutableRefObject<ToolCard[]>,
): WorkingStatus {
  /**
   * 只用来「每秒重渲一次」的计数器 —— 值本身没人读。
   *
   * # 为什么不需要把快照存成 state
   *
   * 快照是**纯派生值**（只读 ref + `Date.now()`）。存成 state 就要额外把 ref
   * 的变化同步进去，而 ref 不进依赖数组 → 两份真相不同步。
   *
   * 直接在渲染期算之后：
   * - `streaming` 翻转本身就是一次渲染 → **开启那一拍自然是新值**（不需 effect）；
   * - interval 每秒 bump `tick` → 重渲染 → 重新算。
   *
   * 也避开了 `react-hooks/set-state-in-effect`（在 effect 里同步 setState 会
   * 触发级联渲染）。
   */
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
    // ref 是可变容器，读的是最新值，不进依赖（有意如此）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streaming]);

  return snapshot(turnStartRef, turnToolsRef);
}
