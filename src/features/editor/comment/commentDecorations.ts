/**
 * 译文装饰的**规格层**（纯函数）—— 条目 + 可视区 + 模式 → 装饰规格。
 *
 * ## 为什么规格层与渲染层分离
 *
 * 「哪些条目该画、画在哪、画成什么」是**可测的纯逻辑**；「怎么生成 DOM」依赖
 * CodeMirror 运行时。分开后，裁剪与模式逻辑能在 node 环境断言（AC14 的性能断言
 * 需要构造 400 条注释），不必启动真实 `EditorView`。
 *
 * ## 为什么必须按可视区裁剪（AC14）
 *
 * 5000 行文件里 400 条注释，全量建 DOM widget 会让滚动卡顿，且 widget 的 `toDOM`
 * 产物常驻吃内存。裁剪是**必需项**：`view.visibleRanges` 之外不建 widget，
 * 滚动时由 reconciler 重算。
 *
 * 判定用「区间相交」而非「完全包含」：组的一部分在视口内也必须渲染，
 * 否则滚动时半条注释会突然消失/出现（闪烁）。
 */
import type { CommentDisplayMode, CommentTranslationEntry } from './commentTranslations';

/** 可视区（与 `EditorView.visibleRanges` 同形）。 */
export interface DecorationRange {
  from: number;
  to: number;
}

/** 装饰种类（渲染层据此生成具体 Decoration）。 */
export type DecorationKind = 'block-widget' | 'inline-widget' | 'hover-anchor';

/** 一条装饰规格。 */
export interface CommentDecoration {
  kind: DecorationKind;
  /** 挂载位置（widget 的插入点 / hover 锚点）。 */
  at: number;
  /** 组范围（hover 判定与 mark 用）。 */
  from: number;
  to: number;
  /** 译文（多行以 `\n` 连接；失败条目为空）。 */
  text: string;
  /** 失败原因（有值则画 reason chip）。 */
  reason?: string;
  /** 失败类型（决定 chip 措辞与重试是否可用）。 */
  failureKind?: 'validation' | 'transport';
  /** 所属组标识（`CommentGroup.startLine`）—— 失败 chip 的单组重试据此定位（R6.6）。 */
  groupKey?: number;
}

/** 构建参数。 */
export interface BuildOptions {
  entries: readonly CommentTranslationEntry[];
  visibleRanges: readonly DecorationRange[];
  mode: CommentDisplayMode;
}

/** 两个区间是否相交（含端点相接）。 */
function overlaps(a: { from: number; to: number }, b: DecorationRange): boolean {
  return a.from <= b.to && a.to >= b.from;
}

/** 条目是否落在任一可视区内。 */
function isVisible(
  entry: CommentTranslationEntry,
  visibleRanges: readonly DecorationRange[],
): boolean {
  return visibleRanges.some((range) => overlaps(entry, range));
}

/**
 * 生成装饰规格。
 *
 * 模式与挂载点的对应关系：
 *
 * | mode | kind | at | 理由 |
 * | --- | --- | --- | --- |
 * | `below` | block-widget | 组结束位置 | 译文块紧跟注释之后 |
 * | `inline` | inline-widget | 组结束位置 | 行尾追加 |
 * | `hover` | hover-anchor | 组起始位置 | 悬停命中判定以组开头为准 |
 * | `off` | — | — | 不产生装饰 |
 */
export function buildCommentDecorations(options: BuildOptions): CommentDecoration[] {
  const { entries, visibleRanges, mode } = options;

  if (mode === 'off') return [];
  if (visibleRanges.length === 0) return [];

  const kind: DecorationKind =
    mode === 'below' ? 'block-widget' : mode === 'inline' ? 'inline-widget' : 'hover-anchor';

  const out: CommentDecoration[] = [];
  for (const entry of entries) {
    // 既无译文也无失败原因 → 没有可画的内容
    if (!entry.text.trim() && !entry.reason) continue;
    if (!isVisible(entry, visibleRanges)) continue;

    out.push({
      kind,
      at: kind === 'hover-anchor' ? entry.from : entry.to,
      from: entry.from,
      to: entry.to,
      text: entry.text,
      ...(entry.reason ? { reason: entry.reason } : {}),
      ...(entry.failureKind ? { failureKind: entry.failureKind } : {}),
      // `groupKey` 必须一同下发：chip 是纯 DOM 产物，点击时只能从 DOM 上读回定位信息。
      // 漏拷这一字段的表现是「chip 渲染正常但点击无任何反应」，无报错。
      ...(entry.groupKey === undefined ? {} : { groupKey: entry.groupKey }),
    });
  }

  // 文档顺序（entries 可能来自不同文件的合并结果，顺序无保证）
  out.sort((a, b) => a.from - b.from || a.to - b.to);
  return out;
}
