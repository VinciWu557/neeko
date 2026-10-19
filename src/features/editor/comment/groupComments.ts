/**
 * 逻辑注释块分组（纯函数）—— `RawUnit[]` → `CommentGroup[]`。
 *
 * ## 为什么需要这一层（U2 的必要前置）
 *
 * 实测事实：连续行注释在语法树里是**每个一行一个独立节点**。
 * 例：Rust 的 `/// A\n///\n/// # Example` = **7 个 `LineComment`**；
 * JS 的「4 行说明 + 3 行示例」= **10 个 `LineComment`**。
 *
 * 逐节点翻译会：打散段落结构、请求数 ×N、且无法表达「块内某些行是代码」（U2）。
 * 所以必须在节点之上建一层「逻辑块」，作为**翻译请求的单位**（组内仍按 segment 分段）。
 *
 * ## 分组判据（只认行邻接）
 *
 * `下一单元的起始行 == 上一单元的结束行 + 1` → 同组。
 *
 * - 空行 → 行号跳空 → 断开 ✅
 * - 代码行 → 行号跳空 → 断开 ✅
 * - 缩进续行 → 行号仍然相邻 → **不断开** ✅（续行是同一段落的示例代码，由 segment 判 code）
 *
 * 为什么不用「缩进相同才合并」之类的启发式：续行缩进本来就可能不同（示例代码比说明深），
 * 用它分组会把同一段落切碎。行邻接是唯一与「视觉上是否连续」同构的判据。
 *
 * ## 三类边界形态**强制**自成一组
 *
 * | 形态 | 理由 |
 * | --- | --- |
 * | `block`（`/* *``/） | 自带显式边界，不需要邻接启发式；两个相邻块注释是两段话 |
 * | `docstring` | 是字符串表达式，与相邻注释没有排版连续性 |
 * | 尾随注释（`code; // x`） | 附着在代码行上，与下一行的独立注释语义不同 |
 */
import type { LanguageFamily } from './commentSyntax';
import { lineMarkersOf } from './commentSyntax';
import { stripMarkers, type RawUnit } from './extractComments';

/** 组的排版形态。 */
export type GroupShape = 'line' | 'block' | 'docstring';

/** 组内的一行（按源文件顺序）。 */
export interface GroupLine {
  /** 剥掉标记后的正文（块注释已剥 ` * ` 前缀）。 */
  body: string;
  /** 原始行文本（含标记与缩进），重建时按它还原。 */
  raw: string;
  /** 该行所属单元在本组内的下标。 */
  unitIndex: number;
  /** 是否行尾注释行。 */
  isTrailing: boolean;
}

/** 一个逻辑注释块。 */
export interface CommentGroup {
  shape: GroupShape;
  /** 1-based 起始行。 */
  startLine: number;
  /** 1-based 结束行。 */
  endLine: number;
  /** 组内首行的行首缩进（`''` / `'  '` / `'\t'`）。 */
  indent: string;
  /** 组内逐行内容（源文件顺序）。 */
  lines: GroupLine[];
  /** 组内单元（源文件顺序）—— segment 阶段需要它们的 `isDoc` / `docstring` 元信息。 */
  units: RawUnit[];
}

/** 是否可作为「行邻接合并」候选：只有非块、非 docstring、非尾随的注释才行。 */
function isMergeable(unit: RawUnit): boolean {
  return unit.kind === 'comment' && !unit.isBlock && !unit.isTrailing;
}

/** 单元 → 组形态。 */
function shapeOf(unit: RawUnit): GroupShape {
  if (unit.kind === 'docstring') return 'docstring';
  if (unit.isBlock) return 'block';
  return 'line';
}

/**
 * 把一个单元展开成组内的行。
 *
 * 行切分口径与 `RawUnit.body` 一致：块注释逐行剥 ` * ` 前缀；行注释逐行剥标记。
 * 这里直接切 `raw`（源文本）而不是用已合并的 `body`，因为需要**逐行**对应关系
 * （重建要按行回写）。
 */
function linesOf(
  unit: RawUnit,
  source: string,
  unitIndex: number,
  family: LanguageFamily,
): GroupLine[] {
  const raw = source.slice(unit.from, unit.to);
  const rawLines = raw.split(/\r?\n/);

  // body 的逐行版本：复用单元已算好的整体 body 会丢逐行对齐，故按同一口径重算。
  // 口径必须与 extractComments 保持一致（同一事实一个算法，不写第二份规则）：
  //   - 行注释：剥标记（含最长优先）
  //   - 块注释：剥开闭标记后逐行剥 ` * `
  let bodies: string[];
  if (unit.isBlock && unit.blockOpen && unit.blockClose) {
    const inner = raw.slice(unit.blockOpen.length, raw.length - unit.blockClose.length);
    // 开闭标记只是被**从首尾切掉**，`inner` 的换行数不变 —— 所以 `bodies` 与 `rawLines`
    // 天然等长，不需要补位。（首版这里写过 `if (bodies.length < rawLines.length)` 的补位，
    // 那是基于错误假设的死代码：`/* one */` 与多行块都实测等长。）
    bodies = inner.split(/\r?\n/).map((line) => line.replace(/^[ \t]*\*?[ \t]?/, ''));
  } else if (unit.kind === 'docstring') {
    // docstring：`body` 是 cleandoc 后的文本（已折叠开闭引号行与空行），与 `rawLines`
    // **不是**一一对应。组内的行仍按原文行结构保留（空行也是组的一部分，重建需要它们），
    // body 只用于送翻译。故这里按 raw 行剥掉引号，得到逐行近似文本。
    // `kind === 'docstring'` 的单元必然带 `docstring` 元信息（`extractComments` 的构造契约），
    // 故用 `!` 断言而不是 `? :` 兜底 —— 后者是不可达分支，会给覆盖率留下填不平的洞。
    const docInfo = unit.docstring!;
    const quote = docInfo.quote;
    const prefixLen = docInfo.prefix.length;
    bodies = rawLines.map((line, index) => {
      let text = line;
      if (index === 0) text = text.slice(prefixLen + quote.length);
      if (index === rawLines.length - 1 && text.endsWith(quote)) {
        text = text.slice(0, text.length - quote.length);
      }
      return text;
    });
  } else {
    // 行注释：逐行剥标记。标记集合从单元自身推断（`//` / `///` / `//!` / `#`）
    // 复用 `extractComments.stripMarkers`（同一规则不写第二份），
    // 标记集合取自家族数据表（`///` 先于 `//` 的顺序由表保证）。
    const markers = lineMarkersOf(family);
    bodies = rawLines.map((line) => stripMarkers(line, markers));
  }

  return rawLines.map((line, index) => ({
    // 三个分支的 `bodies` 都按 `rawLines` 映射，故等长（无 `?? ''` 兜底）
    body: bodies[index].replace(/\r$/, ''),
    raw: line.replace(/\r$/, ''),
    unitIndex,
    isTrailing: unit.isTrailing,
  }));
}

/**
 * 单元序列 → 逻辑组序列。
 *
 * 输入应已按 `from` 升序（`extractComments` 保证）；这里仍做一次防御性排序，
 * 因为「顺序错 → 组错」是静默失败（组看起来正常，只是边界不对）。
 */
export function groupComments(
  units: readonly RawUnit[],
  ctx: { source: string; family: LanguageFamily },
): CommentGroup[] {
  const { source, family } = ctx;
  if (units.length === 0) return [];

  const ordered = [...units].sort((a, b) => a.from - b.from);
  const groups: CommentGroup[] = [];

  let current: { shape: GroupShape; units: RawUnit[] } | null = null;

  const flush = () => {
    if (!current) return;
    const lines: GroupLine[] = [];
    current.units.forEach((unit, unitIndex) => {
      lines.push(...linesOf(unit, source, unitIndex, family));
    });
    const first = current.units[0];
    const last = current.units[current.units.length - 1];
    groups.push({
      shape: current.shape,
      startLine: first.startLine,
      endLine: last.endLine,
      indent: first.lineIndent,
      lines,
      units: current.units,
    });
    current = null;
  };

  for (const unit of ordered) {
    const mergeable = isMergeable(unit);

    if (current && mergeable && current.shape === 'line') {
      const prev = current.units[current.units.length - 1];
      // 行邻接：后一单元起始行 == 前一单元结束行 + 1
      //
      // 同时要求**前一个**单元也可合并：尾随注释（`code; // x`）是组的**唯一**成员，
      // 不能被下面的独立注释吞并 —— 两者语义不同（一个描述该行代码，一个描述下面的代码）。
      const adjacent = unit.startLine === prev.endLine + 1;
      if (adjacent && isMergeable(prev)) {
        current.units.push(unit);
        continue;
      }
    }

    flush();
    current = { shape: shapeOf(unit), units: [unit] };
  }

  flush();
  return groups;
}
