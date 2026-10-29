import { describe, expect, it } from 'vitest';

import {
  clampScale,
  computePageSlots,
  contentHeight,
  fitWidthScale,
  MAX_SCALE,
  MIN_SCALE,
  pageIndexAtScrollTop,
  scrollTopOfPage,
  visiblePageRange,
  type PageMetrics,
} from '@/features/editor/components/pdf/pdfPageLayout';

const metrics: PageMetrics = { width: 800, height: 1000, gap: 10 };
const step = metrics.height + metrics.gap; // 1010

describe('computePageSlots / contentHeight', () => {
  it('按统一高度铺开页面，top 逐页递增', () => {
    const slots = computePageSlots(3, metrics);
    expect(slots).toEqual([
      { top: 0, height: 1000 },
      { top: step, height: 1000 },
      { top: step * 2, height: 1000 },
    ]);
  });

  it('内容高度包含底部间距', () => {
    expect(contentHeight(3, metrics)).toBe(step * 3);
    expect(contentHeight(0, metrics)).toBe(0);
  });
});

describe('visiblePageRange', () => {
  it('顶部时只渲染前几页 + 缓冲', () => {
    // viewport 1000 ⇒ 可见 0..0（第 0 页占 0..1000），overscan 1 ⇒ [0, 1]
    expect(visiblePageRange(0, 1000, 100, metrics, 1)).toEqual([0, 1]);
  });

  it('滚动到中部时窗口跟随平移', () => {
    // scrollTop = 5*step ⇒ 可见 5..5（+1000 = 5*step+1000 落在第 5 页）
    expect(visiblePageRange(5 * step, 1000, 100, metrics, 1)).toEqual([4, 6]);
  });

  it('末端不越界（页数上限夹取）', () => {
    const [, last] = visiblePageRange(99 * step, 1000, 100, metrics, 3);
    expect(last).toBe(99);
  });

  it('起点不为负', () => {
    const [first] = visiblePageRange(0, 1000, 100, metrics, 3);
    expect(first).toBe(0);
  });

  it('空文档返回空区间', () => {
    expect(visiblePageRange(0, 1000, 0, metrics)).toEqual([0, -1]);
  });

  it('视口比内容还高时只返回真实存在的页', () => {
    expect(visiblePageRange(0, 999_999, 3, metrics, 2)).toEqual([0, 2]);
  });

  it('零高度度量退化为全量（避免除零导致空窗口）', () => {
    expect(visiblePageRange(0, 500, 4, { width: 1, height: 0, gap: 0 })).toEqual([0, 3]);
  });
});

describe('pageIndexAtScrollTop / scrollTopOfPage', () => {
  it('滚动位置映射到主导页索引', () => {
    expect(pageIndexAtScrollTop(0, 10, metrics)).toBe(0);
    expect(pageIndexAtScrollTop(step - 1, 10, metrics)).toBe(0);
    expect(pageIndexAtScrollTop(step, 10, metrics)).toBe(1);
    expect(pageIndexAtScrollTop(step * 3 + 5, 10, metrics)).toBe(3);
  });

  it('越界夹取到合法范围', () => {
    expect(pageIndexAtScrollTop(-100, 10, metrics)).toBe(0);
    expect(pageIndexAtScrollTop(step * 99, 10, metrics)).toBe(9);
  });

  it('页码 → scrollTop 往返一致', () => {
    for (const page of [0, 1, 7, 42]) {
      expect(pageIndexAtScrollTop(scrollTopOfPage(page, metrics), 100, metrics)).toBe(page);
    }
  });
});

describe('缩放', () => {
  it('clampScale 夹在上下限内', () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
    expect(clampScale(1.5)).toBe(1.5);
    expect(clampScale(Number.NaN)).toBe(1);
  });

  it('fitWidthScale 扣掉内边距后适配容器宽度', () => {
    expect(fitWidthScale(832, 800, 32)).toBe(1);
    expect(fitWidthScale(432, 800, 32)).toBeCloseTo(0.5);
  });

  it('fitWidthScale 对退化输入返回 1 而不是 0 / Infinity', () => {
    expect(fitWidthScale(0, 800)).toBe(1);
    expect(fitWidthScale(100, 0)).toBe(1);
  });
});
