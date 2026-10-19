/**
 * 重建（纯函数）—— 译文段 + 原标记 → 可渲染行。
 *
 * ## 为什么必须逐行按原前缀补齐
 *
 * 译文行数与原文行数**通常不同**（中文比英文短，常一译一、二译一）。若不按原前缀补齐：
 * - 行注释多行译文会丢掉 `//` → 渲染成裸文本，读者分不清是注释还是代码
 * - 块注释会丢掉 ` * ` → JSDoc 结构被破坏，IDE 文档解析失败
 * - docstring 缩进错乱 → 无法分辨正文边界
 *
 * ## docstring 的缩进规则（D8-Docstring，用户已定案）
 *
 * **首行锚定**：译文多行时，首行沿用原文首行缩进，后续行对齐到「内容起始列」
 * （= 缩进 + 前缀长度 + 引号长度），**不逐行照搬原文缩进** ——
 * 因为译文行数与原文不同，逐行照搬会产生参差。
 *
 * ```
 * 原文（缩进 4，内容列 7）:      译文:
 *     """Run it.                      """运行它。
 *                                     继续说明。
 *     """                              """
 * ```
 *
 * 引号与前缀（`r` / `b` / `u`）原样保留 —— `r"""..."""` 的反斜杠语义与普通字符串不同。
 */
import type { Segment } from './segmentBlock';

/** docstring 形态（由 `extractComments` 提供）。 */
export interface DocstringShape {
  quote: string;
  prefix: string;
  indentWidth: number;
  contentColumn: number;
  closingOnOwnLine: boolean;
}

/** 重建输入。 */
export interface RebuildInput {
  /** 组形态。 */
  shape: 'line' | 'block' | 'docstring';
  /** 行前缀（`// ` / `/// ` / ` * `）；docstring 忽略。 */
  prefix: string;
  /** 组的行首缩进（行注释用；块注释与 docstring 用 `docstring`/`prefix` 自带缩进）。 */
  indent: string;
  /** docstring 形态（仅 `shape === 'docstring'`）。 */
  docstring?: DocstringShape;
  /** 分段（含译文）。`text` 为空表示无译文，回退原文行。 */
  segments: ReadonlyArray<Pick<Segment, 'kind' | 'lines' | 'text'>>;
}

/** 段是否有可用译文。 */
function hasTranslation(segment: Pick<Segment, 'kind' | 'lines' | 'text'>): boolean {
  return segment.text.trim() !== '';
}

/** 行注释 / 块注释：按前缀逐行输出。 */
function rebuildPrefixed(input: RebuildInput): string[] {
  const out: string[] = [];

  // 块注释：先输出开标记
  if (input.shape === 'block') {
    out.push(`${input.indent}/**`);
  }

  for (const segment of input.segments) {
    // 代码 / 围栏：**原样回写**（这些行根本没进请求）
    if (segment.kind === 'code' || segment.kind === 'fence') {
      out.push(...segment.lines);
      continue;
    }

    // 空行：只输出前缀（`//` / ` *`）
    if (segment.kind === 'blank') {
      out.push(`${input.indent}${input.prefix.trimEnd()}`);
      continue;
    }

    // 无译文 → 回退原文行（不丢内容）
    if (!hasTranslation(segment)) {
      out.push(...segment.lines);
      continue;
    }

    for (const line of segment.text.split('\n')) {
      out.push(`${input.indent}${input.prefix}${line}`);
    }
  }

  // 块注释：最后输出闭标记
  if (input.shape === 'block') {
    out.push(`${input.indent} */`);
  }

  return out;
}

/**
 * docstring：首行锚定 + 后续行对齐内容列。
 *
 * 单行译文 → 保持单行（`"""text"""`）；
 * 多行译文 → 首行接在开引号后，后续行缩进到内容列，闭引号按原形态收尾。
 */
function rebuildDocstring(input: RebuildInput): string[] {
  // `shape === 'docstring'` 时调用方必然提供 `docstring` 形态（RebuildInput 的契约），
  // 故用 `!` 断言而不是判空返回 —— 后者是不可达分支。
  const shape = input.docstring!;

  const prose = input.segments.find((s) => hasTranslation(s));
  const translation = prose ? prose.text : '';

  // 无译文 → 回退原文行
  if (!translation.trim()) {
    return input.segments.flatMap((s) => s.lines);
  }

  const open = `${input.indent}${shape.prefix}${shape.quote}`;
  const lines = translation.split('\n');
  const out: string[] = [];

  if (lines.length === 1) {
    out.push(`${open}${lines[0]}${shape.quote}`);
    return out;
  }

  // 多行：首行接开引号，后续行对齐 contentColumn
  const pad = ' '.repeat(Math.max(0, shape.contentColumn));
  out.push(`${open}${lines[0]}`);
  for (const line of lines.slice(1)) {
    out.push(`${pad}${line}`);
  }
  out.push(`${input.indent}${shape.quote}`);
  return out;
}

/**
 * 重建为可渲染行列表。
 *
 * 返回的是「每行的完整文本」（含标记与缩进），由呈现层决定怎么画。
 */
export function rebuildBlock(input: RebuildInput): string[] {
  if (input.segments.length === 0) return [];
  if (input.shape === 'docstring') return rebuildDocstring(input);
  return rebuildPrefixed(input);
}
