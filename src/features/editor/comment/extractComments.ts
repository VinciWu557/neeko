/**
 * 注释单元提取（纯函数）—— 语法树 → {@link RawUnit}[]。
 *
 * ## 为什么要区分「注释节点」与「docstring」
 *
 * 注释节点（`LineComment` / `BlockComment` / `Comment` / `comment`）是**语法上的注释**；
 * 而 Python docstring 是**字符串表达式**（`ExpressionStatement > String` 且位于 body 首个
 * 语句）。两者的翻译处理相同（都要翻），但重建方式完全不同（注释要回写 `//` 标记，
 * docstring 要回写引号与缩进），所以单元上必须携带足够信息，不能抹平。
 *
 * ## 为什么不用正则
 *
 * `const url = "http://x"` 里的 `//` 不是注释。正则无法区分，AST 天然可以。
 *
 * ## 不完整树
 *
 * CodeMirror 按工作预算惰性解析，大文件的树可能被截断。截断范围内找不到的注释就是
 * 「不存在」，本模块不抛错、不补偿 —— 编辑中漏几条不影响使用，卡住编辑器才是灾难。
 *
 * ## 行号走二分索引（与 runner 共用同一实现）
 *
 * 「`line = 数 pos 之前有几个 \n`」单次是 O(pos)，而提取过程要为**每个**单元求行号 →
 * 聚合 O(文件大小 × 单元数) = 二次方。`runner/syntax/lezer.ts` 记录了同一教训
 * （实测 179KB 文件近 200ms）。
 *
 * 行索引只能有**一份实现**（R8.3）：本模块经 `@/features/runner` 门面复用
 * `createLineLookup` / `createLineStarts`。门面已导出它们 —— 本模块**不得**再写第二份。
 */
import { createLineLookup } from '@/features/runner';

import type { LanguageFamily } from './commentSyntax';
import { docstringSpecOf, syntaxFor } from './commentSyntax';

/**
 * 语法树节点（结构子集）。
 *
 * **不直接 import `@lezer/common`**：pnpm 严格 node_modules 下它是传递依赖，
 * 根 node_modules 里没有（与 `runner/syntax/lezer.ts` 同一约束）。
 */
export interface TreeNode {
  type: { name: string };
  from: number;
  to: number;
  firstChild: TreeNode | null;
  nextSibling: TreeNode | null;
}

/** 语法树（结构子集）。 */
export interface TreeLike {
  topNode: TreeNode;
}

/** docstring 的形态信息（D8-Docstring 重建用）。 */
export interface DocstringInfo {
  /** 引号（`"""` / `'''`）。 */
  quote: string;
  /** 字符串前缀（`r` / `b` / `u` / `rb`），无前缀为 `''`。 */
  prefix: string;
  /** 缩进宽度（列）。 */
  indentWidth: number;
  /** 内容起始列（= indentWidth + prefix.length + quote.length）。 */
  contentColumn: number;
  /** closing 引号是否独占一行（决定重建末行形态）。 */
  closingOnOwnLine: boolean;
}

/**
 * 一个可翻译单元。
 *
 * 字段分三组：**身份**（`kind`/`isDoc`）、**位置**（`from`/`to`/`startLine`/`endLine`）、
 * **重建信息**（`lineIndent`/`isTrailing`/`isBlock`/`blockOpen`/`blockClose`/`docstring`）。
 */
export interface RawUnit {
  kind: 'comment' | 'docstring';
  /** 是否文档性注释（JSDoc 块 / `///` / `//!` / docstring）—— 决定是否启用 doc 标签校验。 */
  isDoc: boolean;
  /** 节点在 doc 中的起止位置（含标记本身）。 */
  from: number;
  to: number;
  /** 1-based 起始行（组分组用）。 */
  startLine: number;
  /** 1-based 结束行（块注释 / 多行 docstring 可跨行）。 */
  endLine: number;
  /** 剥掉标记后的正文（docstring 为引号内文本）。 */
  body: string;
  /** 该节点起始行的行首缩进（`''` / `'  '` / `'\t'`）。 */
  lineIndent: string;
  /** 是否行尾注释（同一行前面有代码）。 */
  isTrailing: boolean;
  /** 是否块注释。 */
  isBlock: boolean;
  /** 块注释开标记（`/*` / `/**`）；行注释为 `null`。 */
  blockOpen: string | null;
  /** 块注释闭标记；行注释为 `null`。 */
  blockClose: string | null;
  /** docstring 形态；非 docstring 为 `null`。 */
  docstring: DocstringInfo | null;
}

/**
 * 剥掉行注释标记。
 *
 * `markers` **必须按长度降序**（`commentSyntax.lineMarkers` 已保证）：
 * 否则 `///doc` 会被 `//` 先匹配成 `/doc`。
 *
 * 只剥掉标记后的**一个**空格（若有）—— 再多剥会吃掉有意的缩进
 * （`//   code sample` 的缩进是代码块语义）。
 */
export function stripMarkers(line: string, markers: readonly string[]): string {
  for (const marker of markers) {
    if (line.startsWith(marker)) {
      const rest = line.slice(marker.length);
      return rest.startsWith(' ') ? rest.slice(1) : rest;
    }
  }
  return line;
}

/** 块注释开标记：`/**` 优先于 `/*`（doc 判定依赖这个差别）。 */
function blockOpenOf(raw: string): string {
  return raw.startsWith('/**') ? '/**' : '/*';
}

/**
 * 节点名是否属于「具名节点」。
 *
 * 判据：标识符形态（字母/下划线开头）。Lezer 把匿名标点作为节点插入且 `name` 就是标点本身
 * （`:` / `(` / `,` / `=>`），而具名节点一律是标识符（`ExpressionStatement` / `String`）。
 *
 * 不用 `type.isNamed`：实测该属性在 Lezer 节点上是 `undefined`（见 `tryDocstring` 注释）。
 */
function isNamedNodeName(name: string): boolean {
  return /^[A-Za-z_]/.test(name);
}

/** 该行是否以某个「行式 doc 标记」开头（Rust `///` / `//!`）。 */
function isDocLineMarker(line: string, docMarkers: readonly string[] | null): boolean {
  if (!docMarkers) return false;
  for (const marker of docMarkers) {
    if (line.startsWith(marker)) return true;
  }
  return false;
}

interface ExtractContext {
  source: string;
  family: LanguageFamily;
  lineOf: (pos: number) => number;
}

/** 行首偏移（`pos` 之前的最后一个 `\n` 之后）。 */
function lineStartOf(source: string, pos: number): number {
  const idx = source.lastIndexOf('\n', pos - 1);
  return idx === -1 ? 0 : idx + 1;
}

/** 该位置所在行的行首缩进。 */
function indentAt(source: string, pos: number): string {
  const start = lineStartOf(source, pos);
  // `^[ \t]*` 可匹配空串，`exec` 必然非 null —— 无需 `?? ''`（那是不可达分支）
  return LEADING_BLANK.exec(source.slice(start, pos))![0];
}

/**
 * 行首空白（**可匹配空串**）。
 *
 * 因为可匹配空串，`exec` 恒返回非 null —— 调用点用 `!` 断言而非 `?? ''`：
 * 后者是不可达分支，会给覆盖率留下永远填不平的洞。
 */
const LEADING_BLANK = /^[ \t]*/;

/** 把注释节点转成单元。 */
function toCommentUnit(node: TreeNode, ctx: ExtractContext): RawUnit {
  const { source, family, lineOf } = ctx;
  const syntax = syntaxFor(family);
  const raw = source.slice(node.from, node.to);
  const startOfLine = lineStartOf(source, node.from);
  const beforeOnLine = source.slice(startOfLine, node.from);
  const lineIndent = LEADING_BLANK.exec(beforeOnLine)![0];
  const isTrailing = beforeOnLine.trim() !== '';
  const isBlock = syntax.blockOpen !== null && raw.startsWith(syntax.blockOpen);

  let body: string;
  let blockOpen: string | null = null;
  let blockClose: string | null = null;
  let isDoc = false;

  if (isBlock) {
    blockOpen = blockOpenOf(raw);
    blockClose = syntax.blockClose as string;
    // 去开闭标记，再逐行剥前导 ` * `（块注释的常见排版）
    const inner = raw.slice(blockOpen.length, raw.length - blockClose.length);
    body = inner
      .split(/\r?\n/)
      .map((line) => line.replace(/^[ \t]*\*?[ \t]?/, ''))
      .join('\n')
      .trim();
    isDoc = blockOpen === '/**';
  } else {
    const firstLine = raw.split(/\r?\n/, 1)[0];
    isDoc = isDocLineMarker(firstLine, syntax.docLineMarkers);
    body = raw
      .split(/\r?\n/)
      .map((line) => stripMarkers(line, syntax.lineMarkers))
      .join('\n')
      .trim();
  }

  return {
    kind: 'comment',
    isDoc,
    from: node.from,
    to: node.to,
    startLine: lineOf(node.from),
    endLine: lineOf(node.to),
    body,
    lineIndent,
    isTrailing,
    isBlock,
    blockOpen,
    blockClose,
    docstring: null,
  };
}

/**
 * 剥掉 docstring 的引号与前缀，返回正文 + 形态信息。
 *
 * 前缀（`r` / `b` / `u` / `rb`）出现在 String 节点文本里，必须保留：
 * `r"""..."""` 里的反斜杠语义与普通字符串不同。
 */
function parseDocstring(
  raw: string,
  spec: { quotes: readonly string[]; prefixes: readonly string[] },
  indentWidth: number,
): { body: string; info: DocstringInfo } | null {
  let prefix = '';
  for (const candidate of spec.prefixes) {
    if (raw.startsWith(candidate)) {
      prefix = candidate;
      break;
    }
  }
  const afterPrefix = raw.slice(prefix.length);

  let quote = '';
  for (const candidate of spec.quotes) {
    if (afterPrefix.startsWith(candidate)) {
      quote = candidate;
      break;
    }
  }
  if (!quote) return null;

  const afterOpen = afterPrefix.slice(quote.length);
  if (!afterOpen.endsWith(quote)) return null;
  const inner = afterOpen.slice(0, afterOpen.length - quote.length);

  const innerLines = inner.split(/\r?\n/);
  const closingOnOwnLine = innerLines.length > 1 && innerLines[innerLines.length - 1].trim() === '';
  const bodyLines = closingOnOwnLine ? innerLines.slice(0, -1) : innerLines;

  // PEP 257 的 inspect.cleandoc 简化版。
  //
  // **缩进基准必须取「首个非空行」**，不能取 `bodyLines[0]`：多行 docstring 的
  // `bodyLines[0]` 因开引号后紧跟换行而恒为空串，基准会退化成 `''`，
  // 于是 `line.startsWith('')` 恒真 —— 缩进剥离静默失效，正文带着原文缩进。
  // （这是首版实现的真 bug，靠「续行缩进更浅」的用例暴露出来。）
  // 首行与开引号同行时（`"""Summary.`），它没有缩进语义 → 单独 trim，
  // 且**不能**作为缩进基准。基准取「首个独立成行的非空行」。
  const firstLineInline = bodyLines[0].trim() !== '';
  let baseIndent = '';
  for (let i = firstLineInline ? 1 : 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (line.trim() !== '') {
      baseIndent = LEADING_BLANK.exec(line)![0];
      break;
    }
  }

  const cleaned = bodyLines.map((line, index) => {
    if (index === 0 && firstLineInline) return line.trim();
    if (baseIndent && line.startsWith(baseIndent)) return line.slice(baseIndent.length);
    return line;
  });
  // 只丢掉「开引号独占一行」带来的**首行**空行（`"""\ntext` 形态）。
  //
  // 不能顺手折叠第二行空行：docstring 里的空行是**段落分隔**（`Summary.\n\nArgs:`），
  // 吃掉它会把摘要与参数块粘在一起。首版实现折了第二行，靠「首行同行 + 后续段落」
  // 的用例暴露。
  while (cleaned.length > 1 && cleaned[0].trim() === '') cleaned.shift();

  return {
    body: cleaned.join('\n').trim(),
    info: {
      quote,
      prefix,
      indentWidth,
      contentColumn: indentWidth + prefix.length + quote.length,
      closingOnOwnLine,
    },
  };
}

/**
 * 在语法树中收集注释节点与 docstring（按 `from` 升序）。
 *
 * 遍历用**显式栈**（非递归）：语法树深度由源码决定，长链表达式可上千层，递归会撞栈上限。
 */
export function extractComments(ctx: {
  family: LanguageFamily;
  tree: TreeLike | null;
  source: string;
}): RawUnit[] {
  if (!ctx.tree || ctx.family === 'unknown') return [];

  const syntax = syntaxFor(ctx.family);
  const docSpec = docstringSpecOf(ctx.family);
  const nodeNames = new Set(syntax.nodeNames);
  const lineOf = createLineLookup(ctx.source);
  const extractCtx: ExtractContext = { source: ctx.source, family: ctx.family, lineOf };
  const units: RawUnit[] = [];

  const stack: Array<{ node: TreeNode; parent: TreeNode | null }> = [
    { node: ctx.tree.topNode, parent: null },
  ];

  while (stack.length > 0) {
    const { node, parent } = stack.pop() as { node: TreeNode; parent: TreeNode | null };

    if (nodeNames.has(node.type.name)) {
      units.push(toCommentUnit(node, extractCtx));
    } else if (docSpec && node.type.name === docSpec.wrapperNodeName) {
      const docUnit = tryDocstring(node, parent, docSpec, extractCtx);
      if (docUnit) units.push(docUnit);
    }

    const children: Array<{ node: TreeNode; parent: TreeNode }> = [];
    for (let c = node.firstChild; c; c = c.nextSibling) children.push({ node: c, parent: node });
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }

  units.sort((a, b) => a.from - b.from);
  return units;
}

/**
 * 尝试把一个 `ExpressionStatement` 解释为 docstring。
 *
 * 判据（实测确认）：它必须是所在 body 的**第一个具名子节点**。
 * `x = "..."` 走 `AssignStatement`，结构上就不会进到这里（不是误判，而是类型不符）。
 */
function tryDocstring(
  wrapper: TreeNode,
  parent: TreeNode | null,
  docSpec: {
    wrapperNodeName: string;
    valueNodeName: string;
    quotes: readonly string[];
    prefixes: readonly string[];
  },
  ctx: ExtractContext,
): RawUnit | null {
  if (!parent) return null;

  // 必须是 body 的首个**具名**子节点。
  //
  // 为什么不用 `type.isNamed`：实测 Lezer 节点上该属性恒为 `undefined`（NodeType 未暴露
  // isNamed），拿它判会永远不进入 skip 分支 —— `def f():` 的 `:` 会被当成首子节点，
  // 于是所有 docstring 都被误拒（这正是本函数第一版的 bug）。
  // 可靠判据是**节点名是否是标识符**：匿名节点的 name 就是标点本身（`:` / `(` / `,`）。
  //
  // **注释节点必须跳过**：它们不是语句。模块级 `# leading note` 会让 `Script` 的首个具名
  // 子节点变成 `Comment`，若把它算作「首语句」，紧随其后的模块 docstring 会被误拒
  // （实测：`# note\n"""doc"""` 的 docstring 完全提取不到）。
  const commentNodeNames = new Set(syntaxFor(ctx.family).nodeNames);
  let firstNamed: TreeNode | null = null;
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (!isNamedNodeName(c.type.name)) continue;
    if (commentNodeNames.has(c.type.name)) continue;
    firstNamed = c;
    break;
  }
  // 用**位置**比较而非对象身份：实测 Lezer 的 `firstChild`/`nextSibling` 每次访问
  // 返回新的游标包装对象，`firstNamed === wrapper` 恒为 false（与位置相同的节点也不相等）。
  // 这条是「所有 docstring 都被误拒」的第二个根因。
  if (!firstNamed || firstNamed.from !== wrapper.from || firstNamed.to !== wrapper.to) return null;

  // 内层必须是 String（**不是** FormatString —— f-string 带插值语义，不能翻）
  let value: TreeNode | null = null;
  for (let c = wrapper.firstChild; c; c = c.nextSibling) {
    if (c.type.name === docSpec.valueNodeName) {
      value = c;
      break;
    }
  }
  if (!value) return null;

  const lineIndent = indentAt(ctx.source, wrapper.from);
  const parsed = parseDocstring(ctx.source.slice(value.from, value.to), docSpec, lineIndent.length);
  if (!parsed) return null;

  return {
    kind: 'docstring',
    isDoc: true,
    from: value.from,
    to: value.to,
    startLine: ctx.lineOf(value.from),
    endLine: ctx.lineOf(value.to),
    body: parsed.body,
    lineIndent,
    isTrailing: false,
    isBlock: false,
    blockOpen: null,
    blockClose: null,
    docstring: parsed.info,
  };
}

/**
 * 测试入口：直接验证 docstring 形态解析的拒绝分支。
 *
 * 生产代码里这两条拒绝分支只能通过「parser 产出异常节点」触发，纯源码用例难以构造，
 * 故导出一个显式测试入口（而非把内部函数暴露成公共 API）。
 */
export function parseDocstringForTest(
  raw: string,
  spec: { quotes: readonly string[]; prefixes: readonly string[] },
  indentWidth: number,
): { body: string; info: DocstringInfo } | null {
  return parseDocstring(raw, spec, indentWidth);
}
