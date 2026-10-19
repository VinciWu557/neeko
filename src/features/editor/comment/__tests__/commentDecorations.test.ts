// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { buildCommentDecorations, type DecorationRange } from '../commentDecorations';
import type { CommentDisplayMode, CommentTranslationEntry } from '../commentTranslations';

/**
 * AC14：呈现只装饰**可视区**（`visibleRanges` 裁剪）。
 *
 * 为什么必须裁剪：5000 行文件里 400 条注释，若全量建 DOM widget，滚动会卡；
 * widget 的 `toDOM` 产物常驻也吃内存。裁剪是必需项，不是优化。
 *
 * 本模块是**纯函数**（输入条目 + ranges + mode → 装饰规格），
 * 因此可在 node 环境断言，不需要真实 EditorView。
 */

function entry(from: number, to: number, text: string): CommentTranslationEntry {
  return { from, to, text };
}

function ranges(...pairs: Array<[number, number]>): DecorationRange[] {
  return pairs.map(([from, to]) => ({ from, to }));
}

const build = (
  entries: CommentTranslationEntry[],
  visible: DecorationRange[],
  mode: CommentDisplayMode,
) => buildCommentDecorations({ entries, visibleRanges: visible, mode });

describe('commentDecorations / AC14 可视区裁剪', () => {
  it('should only decorate entries inside the visible ranges', () => {
    const entries = [entry(0, 10, '甲'), entry(100, 110, '乙'), entry(200, 210, '丙')];
    const result = build(entries, ranges([90, 120]), 'below');

    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('乙');
  });

  it('should decorate entries spanning multiple visible ranges', () => {
    const entries = [entry(0, 10, '甲'), entry(500, 510, '乙')];
    const result = build(entries, ranges([0, 20], [490, 520]), 'below');
    expect(result).toHaveLength(2);
  });

  it('should decorate nothing when no range covers any entry', () => {
    const result = build([entry(0, 10, '甲')], ranges([100, 200]), 'below');
    expect(result).toEqual([]);
  });

  it('should decorate all entries when the range covers the whole document', () => {
    const entries = [entry(0, 10, '甲'), entry(100, 110, '乙')];
    const result = build(entries, ranges([0, 10_000]), 'below');
    expect(result).toHaveLength(2);
  });

  it('should include an entry that partially overlaps a visible range', () => {
    // 组的一部分在视口内 → 必须渲染（否则滚动时半条注释会闪）
    const result = build([entry(0, 100, '甲')], ranges([50, 60]), 'below');
    expect(result).toHaveLength(1);
  });

  it('should handle empty ranges (nothing visible)', () => {
    expect(build([entry(0, 10, '甲')], [], 'below')).toEqual([]);
  });
});

describe('commentDecorations / 四种显示模式', () => {
  const entries = [entry(0, 10, '甲'), entry(20, 30, '乙')];
  const visible = ranges([0, 100]);

  it('should emit block widgets for below mode', () => {
    const result = build(entries, visible, 'below');
    expect(result.every((item) => item.kind === 'block-widget')).toBe(true);
    // below 挂在组的**结束位置**
    expect(result[0]?.at).toBe(10);
  });

  it('should emit inline widgets for inline mode', () => {
    const result = build(entries, visible, 'inline');
    expect(result.every((item) => item.kind === 'inline-widget')).toBe(true);
    expect(result[0]?.at).toBe(10);
  });

  it('should emit hover anchors for hover mode', () => {
    const result = build(entries, visible, 'hover');
    expect(result.every((item) => item.kind === 'hover-anchor')).toBe(true);
    // hover 锚在组的起始位置（用于判定悬停命中）
    expect(result[0]?.at).toBe(0);
  });

  it('should emit nothing for off mode', () => {
    expect(build(entries, visible, 'off')).toEqual([]);
  });
});

describe('commentDecorations / 失败条目', () => {
  it('should still render an entry that has a failure reason', () => {
    const failed: CommentTranslationEntry = {
      from: 0,
      to: 10,
      text: '',
      reason: 'placeholder lost',
    };
    const result = build([failed], ranges([0, 100]), 'below');
    expect(result).toHaveLength(1);
    expect(result[0]?.reason).toBe('placeholder lost');
    expect(result[0]?.text).toBe('');
  });

  it('should render the failure chip in inline mode too', () => {
    const failed: CommentTranslationEntry = {
      from: 0,
      to: 10,
      text: '',
      reason: 'code span altered',
    };
    const result = build([failed], ranges([0, 100]), 'inline');
    expect(result[0]?.kind).toBe('inline-widget');
    expect(result[0]?.reason).toContain('code span');
  });
});

describe('commentDecorations / 稳定性与顺序', () => {
  it('should return entries in document order', () => {
    const entries = [entry(200, 210, '丙'), entry(0, 10, '甲'), entry(100, 110, '乙')];
    const result = build(entries, ranges([0, 1000]), 'below');
    expect(result.map((item) => item.text)).toEqual(['甲', '乙', '丙']);
  });

  it('should be deterministic for the same input', () => {
    const entries = [entry(0, 10, '甲')];
    const a = build(entries, ranges([0, 100]), 'below');
    const b = build(entries, ranges([0, 100]), 'below');
    expect(a).toEqual(b);
  });

  it('should skip entries with empty text and no reason', () => {
    const result = build([entry(0, 10, '')], ranges([0, 100]), 'below');
    expect(result).toEqual([]);
  });

  it('should handle duplicate positions without dropping any', () => {
    const entries = [entry(0, 10, '甲'), entry(0, 10, '乙')];
    expect(build(entries, ranges([0, 100]), 'below')).toHaveLength(2);
  });
});

describe('commentDecorations / 大文件性能语义（只建可视区 widget）', () => {
  it('should build a bounded number of widgets for a large file (AC9 性能断言)', () => {
    // 构造 400 条注释（模拟 5000 行文件），只让其中 5 条在视口内
    const entries: CommentTranslationEntry[] = [];
    for (let i = 0; i < 400; i++) {
      entries.push(entry(i * 100, i * 100 + 50, `译文 ${i}`));
    }
    // 每条占 [i*100, i*100+50]。用「相交」语义**精确算**期望值，而不是手数 ——
    // 端点相接（550 与 [500,550]）也算相交，手数容易差一（实测踩过）。
    const visible = ranges([0, 550]);
    const expected = entries.filter((e) => e.from <= 550 && e.to >= 0).length;
    const result = build(entries, visible, 'below');

    expect(result).toHaveLength(expected);
    // 若未裁剪，这里会是 400
    expect(result.length).toBeLessThan(entries.length / 10);
  });
});

describe('commentDecorations / groupKey 透传（R6.6 单组重试的定位依据）', () => {
  /**
   * 规格层是 entry → 装饰规格的**唯一**通道。`groupKey` 必须一起过去，
   * 否则 widget 拿不到组标识 → chip 渲染正常但点击无处可定位（无报错，无类型错）。
   */
  it('should carry the group key onto the decoration spec', () => {
    const failed: CommentTranslationEntry = {
      from: 0,
      to: 10,
      text: '',
      reason: 'placeholder lost',
      groupKey: 12,
    };
    const result = build([failed], ranges([0, 100]), 'below');
    expect(result[0]?.groupKey).toBe(12);
  });

  it('should carry the group key for successful entries as well', () => {
    const ok: CommentTranslationEntry = { from: 0, to: 10, text: '译文', groupKey: 4 };
    const result = build([ok], ranges([0, 100]), 'inline');
    expect(result[0]?.groupKey).toBe(4);
  });

  it('should omit the key entirely when the entry has none', () => {
    const result = build([entry(0, 10, '译文')], ranges([0, 100]), 'below');
    expect(Object.prototype.hasOwnProperty.call(result[0], 'groupKey')).toBe(false);
  });
});
