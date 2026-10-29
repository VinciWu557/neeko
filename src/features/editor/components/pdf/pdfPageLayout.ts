/**
 * PDF 连续滚动的**页面布局与虚拟化窗口**计算（纯函数，无 DOM / 无 pdf.js）。
 *
 * 为什么需要它：连续滚动模式下若把每页都渲染成 canvas，一个 500 页的 PDF 会瞬间
 * 分配 500 份位图（几百 MB～GB 级），webview 直接崩。内存有界的做法是只渲染
 * 「可视窗口 ± 缓冲」内的页，其余用等高占位块撑开滚动高度。
 *
 * 页面高度先用**首屏页的宽高比**估算（PDF 大多数场合页面尺寸一致），实际渲染时
 * 再回填真实高度 —— 这正是主流 PDF 查看器的做法：先能滚动，再逐步精确。
 */

/** 单页布局参数（单位：CSS px）。 */
export interface PageMetrics {
  /** 页面宽度（缩放后）。 */
  width: number;
  /** 页面高度（缩放后）。 */
  height: number;
  /** 页与页之间的垂直间距。 */
  gap: number;
}

/** 单页在滚动内容里的纵向位置：顶部偏移 + 高度（含间距）。 */
export interface PageSlot {
  top: number;
  height: number;
}

/**
 * 全部页的纵向槽位（用统一高度估算）。
 *
 * 返回长度 = `pageCount`，每项 `top` 递增。调用方用它撑开滚动容器高度，
 * 并据它定位可视窗口。
 */
export function computePageSlots(pageCount: number, metrics: PageMetrics): PageSlot[] {
  const slots: PageSlot[] = [];
  const step = metrics.height + metrics.gap;
  for (let i = 0; i < pageCount; i += 1) {
    slots.push({ top: i * step, height: metrics.height });
  }
  return slots;
}

/** 整个滚动内容的高度（含底部间距）。 */
export function contentHeight(pageCount: number, metrics: PageMetrics): number {
  if (pageCount <= 0) return 0;
  return pageCount * (metrics.height + metrics.gap);
}

/**
 * 可视窗口内的页索引区间 `[first, last]`（**含两端**，0 基）。
 *
 * `overscan` 是上下额外渲染的页数：滚动时若不留缓冲，边界页会在进入视口的
 * 那一帧才开始解码 → 肉眼可见的白闪。
 *
 * 退化情形：`pageCount <= 0` 返回 `[0, -1]`（空区间）；窗口比内容还高时
 * 仍只返回真实存在的页。
 */
export function visiblePageRange(
  scrollTop: number,
  viewportHeight: number,
  pageCount: number,
  metrics: PageMetrics,
  overscan = 2,
): [number, number] {
  if (pageCount <= 0) return [0, -1];
  const step = metrics.height + metrics.gap;
  if (step <= 0) return [0, pageCount - 1];

  const safeScrollTop = Math.max(0, scrollTop);
  const firstVisible = Math.floor(safeScrollTop / step);
  const lastVisible = Math.floor((safeScrollTop + Math.max(0, viewportHeight)) / step);

  const first = Math.max(0, firstVisible - overscan);
  const last = Math.min(pageCount - 1, lastVisible + overscan);
  return [first, Math.max(first, last)];
}

/** 指定滚动位置下「主导页」的 0 基索引（页码跳转 / 上一页下一页用）。 */
export function pageIndexAtScrollTop(
  scrollTop: number,
  pageCount: number,
  metrics: PageMetrics,
): number {
  if (pageCount <= 0) return 0;
  const step = metrics.height + metrics.gap;
  if (step <= 0) return 0;
  const index = Math.floor(Math.max(0, scrollTop) / step);
  return Math.min(pageCount - 1, Math.max(0, index));
}

/** 把指定页滚到顶部所需的 `scrollTop`（连续滚动模式的页码跳转）。 */
export function scrollTopOfPage(pageIndex: number, metrics: PageMetrics): number {
  const step = metrics.height + metrics.gap;
  return Math.max(0, pageIndex) * step;
}

/** 适应容器的缩放比例（「适应宽度」），并夹在合理区间内。 */
export function fitWidthScale(
  containerWidth: number,
  pageWidthAtScale1: number,
  padding = 32,
): number {
  if (pageWidthAtScale1 <= 0) return 1;
  const usable = containerWidth - padding;
  if (usable <= 0) return 1;
  return clampScale(usable / pageWidthAtScale1);
}

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

/** 缩放夹取到 `[MIN_SCALE, MAX_SCALE]`。 */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}
