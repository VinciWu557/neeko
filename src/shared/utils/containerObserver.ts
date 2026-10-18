/**
 * xterm 容器观察器：ResizeObserver 断自激形态 + rAF 合帧。
 *
 * **为什么存在**：xterm 的 `fit()` 会改写 canvas / 容器尺寸，而 canvas 尺寸变化
 * 又会被 RO 观测到 → 无条件 fit 形成反馈环（WebKit 报
 * "ResizeObserver loop completed with undelivered notifications" + 布局风暴 +
 * WebContent 内存上升，Jetsam 实锤）。此前三处终端视图各自抄了一份守卫副本
 * （TerminalViewBase / TaskConsoleOutput / 历史 SplitLayout），守卫语义一致却
 * 无法单点修正 —— 收敛到此处。
 *
 * **守卫形态**：
 * 1. contentRect 差 < 1px → 直接忽略（子元素噪声，断反馈环）；
 * 2. 存活期以 rAF 合帧 → 尺寸稳定后循环自然终止。
 *
 * 调用方把「尺寸变化后要做什么」交给 `onResize`（如 `fitAddon.fit()`），
 * **不要**自行再抄一份 RO。
 */

/** RO contentRect 的最小变化阈值：低于它的变化判为子元素噪声。 */
export const CONTAINER_OBSERVE_EPSILON = 1;

export interface ContainerObserverOptions {
  /** 尺寸变化（超过阈值，rAF 内）时回调。 */
  onResize: () => void;
  /** 注入测试替身（默认全局 ResizeObserver）。 */
  ResizeObserverCtor?: typeof ResizeObserver;
  /** 注入 rAF 替身（默认全局 requestAnimationFrame）。 */
  requestAnimationFrameFn?: (cb: FrameRequestCallback) => number;
  /** 注入 cancelAnimationFrame 替身（默认全局 cancelAnimationFrame）。 */
  cancelAnimationFrameFn?: (handle: number) => void;
}

export interface ContainerObserver {
  observe: (target: Element) => void;
  disconnect: () => void;
}

/**
 * 建立断自激的容器观察器。
 *
 * 调用方负责在 effect cleanup 中 `disconnect()`；句柄本身无副作用。
 */
export function observeContainerSize(options: ContainerObserverOptions): ContainerObserver {
  const {
    onResize,
    ResizeObserverCtor = ResizeObserver,
    requestAnimationFrameFn = requestAnimationFrame,
    cancelAnimationFrameFn = cancelAnimationFrame,
  } = options;

  let lastW = -1;
  let lastH = -1;
  let rafId: number | null = null;

  const ro = new ResizeObserverCtor((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const { width, height } = entry.contentRect;
    // 容器自身尺寸变化不足 1px（多为子元素噪声）→ 直接忽略，断反馈环
    if (
      Math.abs(width - lastW) < CONTAINER_OBSERVE_EPSILON &&
      Math.abs(height - lastH) < CONTAINER_OBSERVE_EPSILON
    ) {
      return;
    }
    lastW = width;
    lastH = height;
    if (rafId !== null) cancelAnimationFrameFn(rafId);
    rafId = requestAnimationFrameFn(() => {
      rafId = null;
      onResize();
    });
  });

  return {
    observe: (target) => ro.observe(target),
    disconnect: () => {
      if (rafId !== null) cancelAnimationFrameFn(rafId);
      rafId = null;
      ro.disconnect();
    },
  };
}
