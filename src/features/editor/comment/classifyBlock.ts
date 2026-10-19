/**
 * 组级分类（纯函数）—— `CommentGroup` → {@link BlockVerdict}。
 *
 * ## 这是翻译前的**硬门禁**，不是提示
 *
 * 分类错 = 静默破坏工具链（比翻错更严重）：`//go:build linux` 被翻译 → 构建失败，
 * 而没人会想到是翻译干的。因此分类结果必须进 UI（用户能看懂为什么某段没翻）。
 *
 * ## 误判方向**不对称**（design.md D2）
 *
 * | 类别 | 判定宽度 | 理由 |
 * | --- | --- | --- |
 * | `shebang` / `directive` / `license` | 判**宽**（宁可多跳过） | 跳过多了用户能看到原文；翻错了静默失效 |
 * | `doc` / `prose` | 落 prose 兜底 | 判不出 doc 只是少一层标签校验，仍然翻译 |
 *
 * ## 为什么 Go 的 doc 判定要看语法树（D7-Go）
 *
 * Go 没有 `///` 标记，只能靠「紧邻声明」。实测两件事：
 * 1. 顶层注释与声明是**兄弟节点**（`nextSibling` 直接就是声明）；
 * 2. 但 `nextSibling` **不受空行影响** —— `// doc\n\n\nfunc A()` 里结构仍然连着。
 *
 * 所以必须**双条件**：结构上下一兄弟是声明类 **且** 中间空行 ≤ 1。
 * 只靠结构会误判（把飘在远处的注释当成 doc），只靠行距则退化成文本猜测。
 */
import { createLineStarts } from '@/features/runner';

import { docRuleOf, type LanguageFamily } from './commentSyntax';
import type { TreeNode, TreeLike } from './extractComments';
import type { CommentGroup } from './groupComments';

/** 组级分类结果。 */
export type BlockKind = 'shebang' | 'directive' | 'license' | 'doc' | 'prose';

/** 分类结论。 */
export interface BlockVerdict {
  kind: BlockKind;
  /** 是否应送模型翻译。 */
  translatable: boolean;
  /** 不可翻译时的可读原因（进 UI）。 */
  reason?: string;
}

/** 不可翻译类别的固定原因文案（UI 直接用，避免各处自造）。 */
const SKIP_REASON: Record<Exclude<BlockKind, 'doc' | 'prose'>, string> = {
  shebang: '解释器指令，翻译后无法执行',
  directive: '工具链按字面读取，翻译会静默失效',
  license: '法律文本，不由模型改写',
};

/**
 * 工具链指令模式。
 *
 * 判**宽**：宁可多跳过。但要有边界 —— 「提到 eslint 的普通说明」不应被跳过，
 * 所以每条模式都锚定**指令语法**（`disable` / `ignore` / `noqa:` 等），
 * 而不是裸词 `eslint`。
 */
const DIRECTIVE_PATTERNS: readonly RegExp[] = [
  /^\s*eslint-disable(?:-next-line|-line)?\b/,
  /^\s*eslint-enable\b/,
  /^\s*prettier-ignore\b/,
  /^\s*biome-ignore\b/,
  /^\s*oxlint-disable\b/,
  /^\s*@ts-(?:ignore|expect-error|nocheck|check)\b/,
  /^\s*type:\s*ignore\b/,
  /^\s*noqa\b/,
  /^\s*pylint:\s*disable\b/,
  /^\s*mypy:/,
  /^\s*ruff:/,
  /^\s*go:build\b/,
  /^\s*\+build\b/,
  /^\s*nolint\b/,
  /^\s*lint:ignore\b/,
  /^\s*noinspection\b/,
  /^\s*#pragma\b/,
  /^\s*#region\b/,
  /^\s*#endregion\b/,
  /^\s*cargo:/,
  /^\s*istanbul\s+ignore\b/,
  /^\s*coverage:\s*ignore\b/,
  /^\s*v8\s+ignore\b/,
  /^\s*TODO\([^)]*\):\s*(?:keep|do not translate)/i,
];

/** 许可证模式（只在文件头窗口内生效）。 */
const LICENSE_PATTERNS: readonly RegExp[] = [
  /copyright\s+(?:\(c\)\s*)?\d{4}/i,
  /spdx-license-identifier/i,
  /licensed\s+under\b/i,
  /all\s+rights\s+reserved/i,
  /\bMIT\s+License\b/i,
  /\bApache\s+License\b/i,
  /\bGNU\s+(?:General|Lesser)\s+Public\s+License\b/i,
];

/**
 * license 判定的文件头窗口（行数）。
 *
 * 位置语义：同样的文本出现在文件深处是引用/说明，应当翻译。
 */
const LICENSE_HEAD_WINDOW = 10;

/** Go 的「声明类」节点名（D7-Go 条件①）。 */
const GO_DECL_NODE_NAMES: ReadonlySet<string> = new Set([
  'FunctionDecl',
  'MethodDecl',
  'TypeDecl',
  'VarDecl',
  'ConstDecl',
  'PackageClause',
]);

/** Go doc 允许的最大空行数（D7-Go 条件②）。 */
const GO_DOC_MAX_BLANK_LINES = 1;

/** 组的完整正文（逐行 body 拼接，用于模式匹配）。 */
function bodyText(group: CommentGroup): string {
  return group.lines.map((line) => line.body).join('\n');
}

/** 组是否全为空白（没有可翻译内容）。 */
function isBlankGroup(group: CommentGroup): boolean {
  return group.lines.every((line) => line.body.trim() === '');
}

/** 是否 shebang：文件**首行**以 `#!` 开头。 */
function isShebang(group: CommentGroup, source: string): boolean {
  if (group.startLine !== 1) return false;
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  return firstLine.startsWith('#!');
}

/** 是否工具链指令：组内**任一行**命中即算（判宽）。 */
function isDirective(group: CommentGroup): boolean {
  return group.lines.some((line) => {
    const body = line.body.trim();
    if (!body) return false;
    return DIRECTIVE_PATTERNS.some((pattern) => pattern.test(body));
  });
}

/** 是否许可证文本（仅文件头窗口内）。 */
function isLicense(group: CommentGroup): boolean {
  if (group.startLine > LICENSE_HEAD_WINDOW) return false;
  const text = bodyText(group);
  return LICENSE_PATTERNS.some((pattern) => pattern.test(text));
}

/** 是否文档性注释（不需要语法树的那些判据）。 */
function isDocByMarkup(group: CommentGroup): boolean {
  if (group.shape === 'docstring') return true;
  // 单元层已判过 `/**` 与 `///` / `//!`
  return group.units.some((unit) => unit.isDoc);
}

/**
 * 分类器的预建上下文（**性能关键**：所有索引只建一次）。
 *
 * ## 为什么由调用方传索引而不是分类器自己算
 *
 * 第一版在每个组的分类里都 `computeLineStarts(source)` 全量扫源 + 对全树 DFS
 * 找「下一兄弟声明」，二者都在**每组**的循环里 -> 实测 O(n²)：
 * 100 组 2.8ms -> 400 组 22.1ms -> 1600 组 215.6ms。
 * 行索引由调用方（`useCommentTranslation`）建一次经此传入，树侧索引由
 * {@link createDeclIndex} 建一次后在组循环里共享。
 *
 * 两个字段都可省：不传行索引时退化为「按需建一份」（语义不变），
 * 树索引不传时 `classifyBlock` 会自己建（纯函数测试的便捷路径）。
 */
export interface ClassifyContext {
  source: string;
  family: LanguageFamily;
  tree?: TreeLike | null;
  /** 行首位置表（0-based 行号 -> 字符位置）；不传则按需建一份。 */
  lineStarts?: readonly number[];
  /** 声明节点索引；不传则按需建一份。 */
  declIndex?: DeclIndex | null;
}

/** 声明节点索引：按 `from` 升序的「具名节点」表，供二分查找。 */
export interface DeclIndex {
  /** 按 `from` 升序。 */
  nodes: readonly TreeNode[];
}

/**
 * 一次遍历把所有**具名**节点收成按 `from` 升序的表。
 *
 * 排序键是 `(from 升序, to 降序)`：同起点时**外层节点在前**。这不是细节而是正确性要求 ——
 * `package m` 里 `PackageClause(26,35)` 与它的关键字子节点 `package(26,33)` 同起点，
 * 若让子节点排在前，二分命中的会是关键字而不是声明，Go doc 判定直接失效（实测）。
 *
 * 为什么用全局表而不是「只看直接子节点」：判据只需回答「组之后第一个具名节点是谁」，
 * 而「同一父下的第一具名兄弟」在全局有序表里就是「`from >= to` 的首个具名节点」——
 * 嵌套节点不会抢在祖先之前（祖先 `from` 相同或更小、`to` 更大）。
 * 一条全局有序表 + 二分就能回答，不必为每个组重新 DFS。
 */
export function createDeclIndex(tree: TreeLike | null): DeclIndex | null {
  if (!tree) return null;
  const nodes: TreeNode[] = [];
  const stack: TreeNode[] = [tree.topNode];
  while (stack.length > 0) {
    const node = stack.pop() as TreeNode;
    if (isNamedNode(node)) nodes.push(node);
    const children: TreeNode[] = [];
    for (let c = node.firstChild; c; c = c.nextSibling) children.push(c);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  nodes.sort((a, b) => a.from - b.from || b.to - a.to);
  return { nodes };
}

/** 节点名是否标识符形态（= 具名节点；`type.isNamed` 在 Lezer 上恒为 `undefined`）。 */
function isNamedNode(node: TreeNode): boolean {
  return /^[A-Za-z_]/.test(node.type.name);
}

/** 在有序表中二分找首个 `from >= pos` 的节点下标。 */
function lowerBound(nodes: readonly TreeNode[], pos: number): number {
  let lo = 0;
  let hi = nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid].from < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Go 的 doc 判定（D7-Go 双条件）。
 *
 * 条件① 「下一具名兄弟是声明类」由 {@link DeclIndex} 二分得到；
 * 条件② 「空行 ≤ 1」由行号索引（由调用方建一次）给出。
 */
function isStructuralDoc(group: CommentGroup, ctx: ClassifyContext): boolean {
  const declIndex = ctx.declIndex ?? createDeclIndex(ctx.tree ?? null);
  if (!declIndex || declIndex.nodes.length === 0) return false;

  const lineStarts = ctx.lineStarts ?? createLineStarts(ctx.source);

  // 组覆盖的字符范围：首行起始 → **末行结束**（不含换行符）。
  //
  // `lineStarts[group.endLine]` 是「末行的下一行」起始，直接当 `to` 会把换行符一起算进
  // 「组之后」，于是 `between` 少一个换行、空行数少 1（实测把 2 个空行算成 1 个，
  // 使 ≥2 空行被判成 doc）。故 `to` 取下一行起始减一。
  const nextLineStart = lineStarts[group.endLine] ?? ctx.source.length;
  const to = nextLineStart > 0 ? nextLineStart - 1 : 0;

  const index = lowerBound(declIndex.nodes, to);
  const decl = declIndex.nodes[index];
  if (!decl) return false;
  if (!GO_DECL_NODE_NAMES.has(decl.type.name)) return false;

  // 条件②：组末尾到声明起始之间的空行数 ≤ 1
  const between = ctx.source.slice(to, decl.from);
  return countBlankLines(between) <= GO_DOC_MAX_BLANK_LINES;
}

/** 家族 → 结构式 doc 判据（数据表的 `docRule === 'structural'` 项）。 */
const STRUCTURAL_DOC_RULE: (group: CommentGroup, ctx: ClassifyContext) => boolean = isStructuralDoc;

/**
 * 统计两个位置之间的**空行数**。
 *
 * `text` 是从「组末行结束」到「声明起始」的切片，形如：
 * - `"\n"`     → 紧邻（0 个空行）
 * - `"\n\n"`   → 1 个空行
 * - `"\n\n\n"` → 2 个空行
 *
 * 即空行数 = 换行符个数 − 1。用换行计数而不是 `split` 切片：
 * 后者在首尾片段处理上容易差一（实测把 2 个空行算成 1 个，导致「≥2 空行」用例误判成 doc）。
 */
function countBlankLines(text: string): number {
  if (!text) return 0;
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) newlines++;
  }
  // 切片可能含缩进空白（声明前的缩进），它们不算空行；只有纯换行序列才是空行
  const onlyWhitespace = text.trim() === '';
  if (!onlyWhitespace) {
    // 中间夹了非空内容（理论上不该发生：注释与声明之间只有空白）
    return 0;
  }
  return Math.max(0, newlines - 1);
}

/**
 * 组级分类。
 *
 * 优先级（硬门禁在前）：`shebang` → `directive` → `license` → `doc` → `prose`。
 */
export function classifyBlock(group: CommentGroup, ctx: ClassifyContext): BlockVerdict {
  if (isShebang(group, ctx.source)) {
    return { kind: 'shebang', translatable: false, reason: SKIP_REASON.shebang };
  }
  if (isDirective(group)) {
    return { kind: 'directive', translatable: false, reason: SKIP_REASON.directive };
  }
  if (isLicense(group)) {
    return { kind: 'license', translatable: false, reason: SKIP_REASON.license };
  }

  // doc 判定：策略从**数据表**查（R1.3，禁止 `if (family === 'go')`）。
  const docRule = docRuleOf(ctx.family);
  const isStructural = docRule === 'structural' ? STRUCTURAL_DOC_RULE(group, ctx) : false;
  const kind: BlockKind = isDocByMarkup(group) || isStructural ? 'doc' : 'prose';

  // 空注释没有可翻译内容 → 不送模型（但它不是「跳过类别」，reason 单独说明）
  if (isBlankGroup(group)) {
    return { kind, translatable: false, reason: '注释没有可翻译内容' };
  }

  return { kind, translatable: true };
}
