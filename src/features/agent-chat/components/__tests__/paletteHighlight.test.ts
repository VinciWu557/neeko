import { describe, expect, it } from 'vitest';

import { segmentHighlights, tokenizeHighlights } from '../paletteHighlight';
import { findTrigger } from '../paletteTrigger';

describe('tokenizeHighlights', () => {
  it('should not highlight a slash inside a path suffix (src/foo)', () => {
    // 变异验证：tokenize 改成「文本含 @// 就高亮」→ 本用例必须红
    expect(tokenizeHighlights('src/foo')).toEqual([]);
    expect(tokenizeHighlights('a/b')).toEqual([]);
    expect(tokenizeHighlights('look at src/foo/bar.ts')).toEqual([]);
  });

  it('should highlight a slash command at line start', () => {
    expect(tokenizeHighlights('/cmd')).toEqual([{ start: 0, end: 4, kind: 'slash' }]);
  });

  it('should highlight a mention after whitespace', () => {
    expect(tokenizeHighlights('see @src/app.ts next')).toEqual([
      { start: 4, end: 15, kind: 'mention' },
    ]);
  });

  it('should highlight multiple tokens across lines', () => {
    expect(tokenizeHighlights('/a x\nb @f')).toEqual([
      { start: 0, end: 2, kind: 'slash' },
      { start: 7, end: 9, kind: 'mention' },
    ]);
  });

  it('should not let a token cross whitespace', () => {
    expect(tokenizeHighlights('/cmd more text')).toEqual([{ start: 0, end: 4, kind: 'slash' }]);
  });

  it('should highlight a bare trigger char (the palette opens on it)', () => {
    expect(tokenizeHighlights('hi @')).toEqual([{ start: 3, end: 4, kind: 'mention' }]);
    expect(tokenizeHighlights('@')).toEqual([{ start: 0, end: 1, kind: 'mention' }]);
  });

  it('should return no ranges for empty text', () => {
    expect(tokenizeHighlights('')).toEqual([]);
  });

  /**
   * 护栏：`findTrigger` 可触发的**每个**位置，tokenize 必须产出覆盖区间
   * `[index, index + 1 + query.length)` —— 高亮判据与弹层触发判据同源
   * （design §10），两套判据漂移会出现「高亮了但弹层不认」的矛盾形态。
   * 本护栏是防第二套正则的结构性防线：任何独立的触发实现几乎必然在
   * 行首/空白/路径段等边角上漂移。
   */
  it('should cover every position findTrigger can trigger on', () => {
    const corpus = [
      '/',
      '/cmd',
      'hi /',
      'hi /tr ',
      '@',
      '@src',
      '@src/fo',
      'see @',
      'line1\n/',
      'a /cmd b @path ',
      '/a\n@b',
      '  /x',
      '@ x',
      'no trigger src/foo a/b',
    ];
    for (const text of corpus) {
      const ranges = tokenizeHighlights(text);
      for (let cursor = 1; cursor <= text.length; cursor++) {
        const match = findTrigger(text, cursor);
        if (!match) continue;
        const covered = ranges.some(
          (r) => r.start <= match.index && r.end >= match.index + 1 + match.query.length,
        );
        // vitest/valid-expect 不允许 expect 的第二参消息 —— 把上下文编进被断言值
        expect(`${JSON.stringify(text)}@${cursor} covered=${covered}`).toBe(
          `${JSON.stringify(text)}@${cursor} covered=true`,
        );
      }
    }
  });
});

describe('segmentHighlights', () => {
  it('should split text into plain and token segments covering everything', () => {
    const ranges = tokenizeHighlights('run /cmd now');
    expect(segmentHighlights('run /cmd now', ranges)).toEqual([
      { text: 'run ', kind: null },
      { text: '/cmd', kind: 'slash' },
      { text: ' now', kind: null },
    ]);
  });

  it('should return a single plain segment when there are no tokens', () => {
    expect(segmentHighlights('src/foo', [])).toEqual([{ text: 'src/foo', kind: null }]);
  });

  it('should concatenate back to the original text (mirror renders every char)', () => {
    const text = 'a /cmd b @path c';
    const joined = segmentHighlights(text, tokenizeHighlights(text))
      .map((s) => s.text)
      .join('');
    expect(joined).toBe(text);
  });
});
