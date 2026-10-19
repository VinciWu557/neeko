/**
 * 块内分段（纯函数）—— `CommentGroup` → `SegmentBlock`。
 *
 * ## 这一层为什么存在（U2）
 *
 * 用户决策：**注释中的代码一律不翻译，不管死代码还是非死代码**。
 * 而注释块内部经常混排散文与代码：
 *
 * ```
 * // Replace the legacy call:                    ← prose（翻）
 * //   const raw = await legacyFetch(segments);  ← code（不翻）
 * // with the single-turn path.                  ← prose（翻）
 * ```
 *
 * 若只能「整组翻」或「整组跳」，两种都会错：整组翻会把代码翻坏（照抄即报错），
 * 整组跳会让用户读不到说明。所以必须**按行分段**并各自分类。
 *
 * ## 误判方向（design.md D2）
 *
 * `code` 判定**偏宽**（宁可把散文误判成代码）：
 * - 判错成 code → 用户看到原文未翻，可手动处理，**代码安全**
 * - 判错成 prose → 代码被翻坏，**照抄即报错**
 *
 * 但「偏宽」不等于乱判：判 code 必须有**明确信号**（代码起始词 / 代码符号组合 /
 * 示例引导行后的缩进块）。单靠「含某个符号」会误杀 `See \`cacheKey\` for details.`
 * 这类正常句子 —— 那属于误杀散文，同样是坏结果。
 *
 * ## 本文件只留**状态机**
 *
 * 「像代码 / 像标签 / 像句子」的文本启发式在 `commentHeuristics.ts`。两者变化节奏不同：
 * 启发式随「某句被误判」而动，状态机随 fence / 示例引导 / tag 的流转而定。
 * 拆开后改正则不必在状态机里翻找，也能单独回归启发式（纯搬迁，行为零变化）。
 *
 * ## 段种类
 *
 * | kind | 处置 |
 * | --- | --- |
 * | `prose` | 送翻译 |
 * | `tag` | 送翻译（标签名与字段名由校验保护） |
 * | `code` | **原样保留，不进请求** |
 * | `fence` | **整块原样保留**（含开闭标记） |
 * | `blank` | 原样保留（段落分隔，参与重建） |
 */
import {
  argsFieldHasDescription,
  DOC_SECTION_HEADER,
  EXAMPLE_LEAD,
  FENCE_MARK,
  indentWidth,
  looksLikeArgsField,
  looksLikeCode,
  looksLikeDocTag,
} from './commentHeuristics';
import type { CommentGroup } from './groupComments';

/** 段种类。 */
export type SegmentKind = 'prose' | 'code' | 'fence' | 'blank' | 'tag';

/** 一个段（可含多行，如多行代码 / 整块围栏）。 */
export interface Segment {
  kind: SegmentKind;
  /** 1-based 起始行。 */
  startLine: number;
  /** 1-based 结束行。 */
  endLine: number;
  /** 送翻译的正文（多行以 `\n` 连接）。code/fence/blank 段保留原文。 */
  text: string;
  /** 逐行原文（重建用）。 */
  lines: string[];
  /** 行前缀（`// ` / `# ` / ` * `），重建时逐行补齐。 */
  prefix: string;
  /** 是否应送模型翻译。 */
  translatable: boolean;
}

/** 一个组的全部分段。 */
export interface SegmentBlock {
  /** 组形态（透传，重建时区分行注释 / 块注释 / docstring）。 */
  shape: CommentGroup['shape'];
  segments: Segment[];
}

/**
 * 组的行 → 分段。
 *
 * 规则顺序即优先级：围栏 → 空行 → doc 标签 → 代码 → 散文。
 * 围栏最先，因为围栏内的任何内容都不能被单独判成 code 或 tag（整块保护）。
 */
export function segmentBlock(group: CommentGroup): SegmentBlock {
  const segments: Segment[] = [];

  // 全空组（`//` 单行无内容）→ 无段可翻
  const allBlank = group.lines.every((line) => line.body.trim() === '');
  if (allBlank) return { shape: group.shape, segments };

  let current: Segment | null = null;
  let inFence = false;
  let fenceMarker = '';
  /** 上一条 prose 是否是示例引导行（决定后续缩进块判 code）。 */
  let afterExampleLead = false;

  const flush = () => {
    if (!current) return;
    segments.push(current);
    current = null;
  };

  const push = (kind: SegmentKind, line: GroupLineLike, translatable: boolean, text: string) => {
    if (current && current.kind === kind) {
      current.lines.push(line.raw);
      current.endLine = line.lineNumber;
      current.text = current.text ? `${current.text}\n${text}` : text;
      return;
    }
    flush();
    current = {
      kind,
      startLine: line.lineNumber,
      endLine: line.lineNumber,
      text,
      lines: [line.raw],
      prefix: line.prefix,
      translatable,
    };
  };

  group.lines.forEach((line, index) => {
    const lineNumber = group.startLine + index;
    const body = line.body;
    const trimmed = body.trim();

    // ── 围栏：整块保护（含开闭标记）───────────────────────────
    if (inFence) {
      push(
        'fence',
        { raw: line.raw, lineNumber, prefix: linePrefixOf(line.raw, body) },
        false,
        body,
      );
      if (FENCE_MARK.test(trimmed) && trimmed.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = '';
      }
      return;
    }
    if (FENCE_MARK.test(trimmed)) {
      flush();
      inFence = true;
      fenceMarker = trimmed.slice(0, 3);
      push(
        'fence',
        { raw: line.raw, lineNumber, prefix: linePrefixOf(line.raw, body) },
        false,
        body,
      );
      afterExampleLead = false;
      return;
    }

    // ── 空行：参与重建，不翻 ──────────────────────────────
    if (!trimmed) {
      push('blank', { raw: line.raw, lineNumber, prefix: linePrefixOf(line.raw, body) }, false, '');
      afterExampleLead = false;
      return;
    }

    const prefix = linePrefixOf(line.raw, body);

    // ── doc 标签行（含结构块字段）──────────────────────────
    //
    // `Example:` / `Examples:` 有形态歧义：在 `/** */` doc 块里它是**结构块标题**（tag），
    // 在 `//` 行注释里它是**示例引导行**（prose，其后缩进块判 code）。
    // 用组形态区分，而不是二选一 —— 否则 doc 里的 Example 段会被当引导行，
    // 行注释里的 Example 会被当 tag 而不送翻。
    const exampleSectionInDoc = group.shape !== 'line' && DOC_SECTION_HEADER.test(trimmed);
    if (exampleSectionInDoc || (group.shape === 'line' ? false : looksLikeDocTag(trimmed))) {
      const isSectionHeader = DOC_SECTION_HEADER.test(trimmed);
      // **结构标题与字段行不能合并**：`Args:` 无内容可翻（translatable=false），
      // 若与下一行 `x: the value` 合并成同一个 tag 段，整段都会被标成不可翻 ——
      // 字段说明随之丢失（实测 bug）。故标题行先 flush 成独立段。
      if (isSectionHeader) flush();
      push('tag', { raw: line.raw, lineNumber, prefix }, !isSectionHeader, body);
      if (isSectionHeader) flush();
      afterExampleLead = false;
      return;
    }
    if (looksLikeArgsField(line.raw, body)) {
      // D9-Args：字段行归 tag；说明为空不送翻。
      // 空说明字段也 flush 隔离，避免它把可翻字段串成一段后污染 translatable。
      const hasDescription = argsFieldHasDescription(trimmed);
      if (!hasDescription) flush();
      push('tag', { raw: line.raw, lineNumber, prefix }, hasDescription, body);
      if (!hasDescription) flush();
      return;
    }

    // ── 代码：三条明确信号 ──────────────────────────────
    //
    // `afterExampleLead` **不在这里重置**：示例块通常是连续多行缩进，
    // 若第一条 code 行后立刻清标志，第二条会退化成 prose（实测 bug：
    // `// Usage:` + 两行缩进 → 第一行 code、第二行 prose）。
    // 标志由「缩进是否延续」自然终止：不缩进的行会走到下面的散文分支并重置。
    const indentedAfterExample = afterExampleLead && indentWidth(body) >= 2;
    if (looksLikeCode(trimmed) || indentedAfterExample) {
      push('code', { raw: line.raw, lineNumber, prefix }, false, body);
      return;
    }

    // ── 散文（兜底）───────────────────────────────────
    push('prose', { raw: line.raw, lineNumber, prefix }, true, body);
    afterExampleLead = EXAMPLE_LEAD.test(trimmed);
  });

  flush();
  return { shape: group.shape, segments };
}

/** `segmentBlock` 内部用的最小行形态。 */
interface GroupLineLike {
  raw: string;
  lineNumber: number;
  prefix: string;
}

/**
 * 从原文行推断「去掉正文后剩下的前缀」（`// ` / `# ` / ` * `）。
 *
 * 用途：重建时逐行补齐。取 `raw` 去掉 `body` 的前缀片段；
 * 若 `body` 不在 `raw` 里（块注释剥过 `*`），退化为「缩进 + 标记」。
 */
function linePrefixOf(raw: string, body: string): string {
  if (body && raw.endsWith(body)) {
    return raw.slice(0, raw.length - body.length);
  }
  // 块注释行形如 ` * text`：前缀是缩进 + `*` + 一个空格
  const match = /^([ \t]*(?:\/\*\*?|\*\/|\*)?[ \t]?)/.exec(raw);
  return match ? match[1] : '';
}
