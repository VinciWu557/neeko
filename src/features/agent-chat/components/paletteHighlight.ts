import { triggerStartAt } from './paletteTrigger';
import type { PaletteKind } from './paletteTrigger';

/**
 * 输入框内高亮层的纯函数侧（design §10）。
 *
 * token 判据与弹层触发**同源**：复用 `paletteTrigger::triggerStartAt` 的同一
 * 语法（行首/空白后的 `@token` 与 `/token`），禁止第二套正则 —— 两套判据漂移
 * 后会出现「高亮了但弹层不认」（或反过来）的矛盾形态。护栏测试
 * （`__tests__/paletteHighlight.test.ts`）对 `findTrigger` 可触发的每个位置
 * 断言 tokenize 产出覆盖区间。
 *
 * 全部函数无 React / 无 IPC，可被密集单测。
 */

/** 一个高亮 token 在文本中的区间（`[start, end)`，end 不含）。 */
export interface HighlightRange {
  start: number;
  end: number;
  kind: PaletteKind;
}

/** 镜像层渲染片段：`kind` 为 null 的是普通文字。 */
export interface HighlightSegment {
  text: string;
  kind: PaletteKind | null;
}

/**
 * 扫描整段文本，产出全部 token 区间。
 *
 * token 与 `findTrigger` 的过滤词同一形状：从触发符起连续吞掉非空白字符，
 * 遇空白或文本结束即止 —— 所以 token 永不跨空白，`src/foo` 永不命中。
 */
export function tokenizeHighlights(text: string): HighlightRange[] {
  const ranges: HighlightRange[] = [];
  let i = 0;
  while (i < text.length) {
    const kind = triggerStartAt(text, i);
    if (!kind) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < text.length && !/\s/.test(text[end])) end++;
    ranges.push({ start: i, end, kind });
    i = end;
  }
  return ranges;
}

/**
 * 把文本按区间切成渲染片段（普通文字与 token 交替），拼回必等于原文 ——
 * 镜像层必须逐字渲染全部内容，与透明文字的 textarea 逐字对齐。
 */
export function segmentHighlights(
  text: string,
  ranges: readonly HighlightRange[],
): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const { start, end, kind } of ranges) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), kind: null });
    segments.push({ text: text.slice(start, end), kind });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), kind: null });
  return segments;
}
