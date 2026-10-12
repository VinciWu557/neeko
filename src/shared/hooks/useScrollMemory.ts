import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { dropScrollMemory, readScrollMemory, writeScrollMemory } from '@/shared/utils/scrollMemory';

/** 位置判定阈值：差值 < 1px 视为已到位（亚像素噪声）。 */
const EPSILON = 1;
/** 异步内容追平窗口：diff / PR / 会话回放等内容在网络返回后才撑开滚动高度。 */
const SETTLE_TIMEOUT_MS = 2000;
/** 用户主动滚动信号：出现即放弃未完成的恢复，绝不与用户抢滚动条。 */
const USER_INTENT_EVENTS = ['wheel', 'touchstart', 'keydown'] as const;

export interface UseScrollMemoryOptions {
  /**
   * false = 本次不参与记忆，并作废既有记忆。
   * 用于「本次挂载已有显式滚动意图」的场景（如携带 scrollToPath 的 diff tab）——
   * 不清掉的话，意图解除后旧位置会反扑。
   */
  enabled?: boolean;
}

/**
 * 把一个 DOM 滚动容器的位置挂到逻辑身份 `key` 上，覆盖四种生命周期边界：
 *   ① (重)挂载         → 读快照恢复（clamp 到可达范围）；
 *   ② 可见滚动中        → 采集（隐藏期间 / 恢复在途不采信 DOM 值）；
 *   ③ display:none 恢复 → 引擎已丢位置时写回（WKWebView 已知行为）；
 *   ④ 卸载前            → 固化（恢复未完成时保留目标意图）。
 * 内容异步到达时以「有界窗口 + DOM 变化信号」持续追平；用户一操作立即让位。
 *
 * `key = null`：只做进程内镜像（③ 仍生效），不读写 KV、不跨卸载 ——
 * 供暂不做记忆持久化的容器复用同一套机制（如 VirtualList）。
 *
 * 用法：
 *   const scrollRef = useScrollMemory<HTMLDivElement>(buildScrollKey('dock.projects'));
 *   <div ref={scrollRef} className="overflow-y-auto">…</div>
 */
export function useScrollMemory<T extends HTMLElement>(
  key: string | null,
  options: UseScrollMemoryOptions = {},
): (node: T | null) => void {
  const enabled = options.enabled ?? true;
  const [el, setEl] = useState<T | null>(null);
  /**
   * 显示恢复的落位代数：RO 检出隐藏→显示后自增，由**被动 effect** 执行写回。
   * 为什么必须是被动 effect：同一提交里可能存在 layout-effect 阶段的竞争写入者
   * （如 tanstack 在 `enabled` 恢复时写 initialOffset=0）—— 被动 effect 在其后执行，
   * 写回最终生效（该约束最初由 VirtualList 内联实现验证）。
   */
  const [restoreTick, setRestoreTick] = useState(0);
  /** 由 layout effect 每次重挂时刷新，指向当前元素的「落位写回」。 */
  const restoreRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (restoreTick === 0) return;
    restoreRef.current();
  }, [restoreTick]);

  // 回调 ref：元素可能在数据到达后才挂载 —— 用 state 触发 effect 重挂，
  // 规避 ref.current 在 effect 首次运行时仍为 null 的时序坑。
  const ref = useCallback((node: T | null) => setEl(node), []);

  useLayoutEffect(() => {
    if (!enabled) {
      if (key !== null) dropScrollMemory(key);
      return;
    }
    if (!el) return;

    /** KV 读写出口（key=null = 纯进程内镜像，不落缓存）。 */
    const readCached = (): number | undefined => (key === null ? undefined : readScrollMemory(key));
    const writeCached = (top: number): void => {
      if (key !== null) writeScrollMemory(key, top);
    };

    let disposed = false;
    /** 内存镜像：最后一次可信位置；隐藏期间不被 DOM 的 0 值污染。 */
    let mirror: number | null = readCached() ?? null;
    /** 未完成的恢复目标（异步内容未撑开高度 / 显示恢复在途时保留）。 */
    let pending: number | null = mirror;
    let hidden = el.offsetHeight === 0;
    let rafId = 0;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let mutationObserver: MutationObserver | null = null;

    const isHidden = () => el.offsetHeight === 0;

    const disarmSettle = () => {
      if (settleTimer !== null) {
        clearTimeout(settleTimer);
        settleTimer = null;
      }
      if (mutationObserver !== null) {
        mutationObserver.disconnect();
      }
    };

    const finishRestore = (applied: number) => {
      pending = null;
      mirror = applied;
      writeCached(applied);
      disarmSettle();
    };

    /** 幂等：内容还没长够时挂上等待（DOM 变化信号 + 有界超时）。 */
    const armSettle = () => {
      if (disposed || settleTimer !== null) return;
      if (mutationObserver === null) {
        mutationObserver = new MutationObserver(() => {
          if (pending !== null) trySettle();
        });
      }
      mutationObserver.observe(el, { childList: true, subtree: true });
      settleTimer = setTimeout(() => {
        // 窗口耗尽：放弃追平（保留镜像），交给用户最新操作。
        settleTimer = null;
        pending = null;
        if (mutationObserver !== null) mutationObserver.disconnect();
      }, SETTLE_TIMEOUT_MS);
    };

    /**
     * @param holdUntilFrame 显示恢复路径专用：写入后**不结束恢复**（保持 pending），
     *   由下一帧的复核决定结束 —— 同帧内可能存在 layout-effect 阶段的竞争写入者
     *   （如 tanstack 在 `enabled` 恢复时写 initialOffset=0）会覆盖同步写；
     *   pending 保持期间 scroll 事件被忽略，镜像不被竞争写入污染。
     */
    const trySettle = (holdUntilFrame = false) => {
      if (disposed || isHidden()) return;
      const target = pending ?? mirror;
      if (target === null) {
        disarmSettle();
        return;
      }
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      const applied = Math.min(target, max);
      if (Math.abs(el.scrollTop - applied) >= EPSILON) el.scrollTo({ top: applied });
      if (pending === null) return; // 仅「恢复显示写回」，不进入追平语义
      if (max >= target - EPSILON) {
        if (holdUntilFrame) return;
        finishRestore(applied);
      } else {
        armSettle(); // 内容未长够：保持等待
      }
    };

    /** 用户主动滚动 → 立即放弃恢复，绝不与用户抢。 */
    const cancelPending = () => {
      pending = null;
      disarmSettle();
    };

    const onScroll = () => {
      // 隐藏期间（引擎可能已归零）与恢复在途（DOM 值可能是 clamp 中间态
      // 或被竞争写入清零）都不采信 DOM 值，避免把镜像污染成 0。
      if (hidden || pending !== null) return;
      mirror = el.scrollTop;
      writeCached(el.scrollTop);
    };

    /** 隐藏瞬间：快照恢复目标（此后引擎 / 竞争写入者的写入不得改变目标）。 */
    const snapshotRestoreTarget = () => {
      if (pending === null && mirror !== null) pending = mirror;
    };

    /**
     * 恢复显示：写回由被动 effect 落位（见 restoreTick 注释）——
     * 晚于同提交的 layout-effect 竞争写入。随后一帧复核：既完
     * 成恢复记账（finishRestore），也修复晚于提交发生的清零。
     */
    const restoreOnShow = () => {
      if (mirror === null) return;
      snapshotRestoreTarget();
      setRestoreTick((tick) => tick + 1);
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => trySettle());
    };

    restoreRef.current = () => trySettle(true);

    // 可见性探测：复用 VirtualList 已验证的 RO 模式（display:none 时报 0 高度）。
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        const nowHidden = isHidden();
        if (nowHidden === hidden) return;
        hidden = nowHidden;
        if (hidden) snapshotRestoreTarget();
        else restoreOnShow();
      });
      resizeObserver.observe(el);
    }

    el.addEventListener('scroll', onScroll, { passive: true });
    for (const ev of USER_INTENT_EVENTS) {
      el.addEventListener(ev, cancelPending, { passive: true });
    }

    if (mirror !== null) {
      trySettle(); // 同步内容：layoutEffect 阶段一次到位
      // 兜底再对一帧（首帧后布局才稳定）。仅在恢复仍被需要时执行 ——
      // 用户已接管（wheel 取消 pending）后旧镜像不得反扑。
      rafId = requestAnimationFrame(() => {
        if (pending !== null) trySettle();
      });
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      disarmSettle();
      el.removeEventListener('scroll', onScroll);
      for (const ev of USER_INTENT_EVENTS) el.removeEventListener(ev, cancelPending);
      // 卸载前固化：恢复未完成则保留目标意图；否则取内存镜像。
      // 不在隐藏态读 el.scrollTop —— 隐藏期间引擎可能已把 DOM 归零。
      const top = pending ?? mirror;
      if (top !== null) writeCached(top);
    };
  }, [el, key, enabled]);

  return ref;
}
