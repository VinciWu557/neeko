/**
 * 注释语法的**数据表**（唯一事实源）—— 把「语言 → 注释节点名 / 标记 / docstring 路径」
 * 收成一张表，提取逻辑里禁止出现 `if (lang === 'python')` 这类分支（R1.3）。
 *
 * ## 为什么需要这张表
 *
 * 实测（`@codemirror/lang-*` 的真实 parser）发现注释节点名**三方分裂**：
 *
 * | 语言 | 注释节点名 |
 * | --- | --- |
 * | TS/JS / Rust / Go / Java（Lezer） | `LineComment` / `BlockComment` |
 * | Python / CSS（Lezer） | `Comment` |
 * | YAML/Shell 等 `legacy-modes`（StreamLanguage） | `comment`（**小写**） |
 *
 * 凭直觉统一成一个名字必错（我自己就先把 Python 猜成了 `LineComment`）。同理，
 * Python 的 docstring **不是注释节点**而是 `ExpressionStatement > String`，
 * 只能按「语法位置」识别（见 {@link DocstringSpec}）。
 *
 * ## 扩展方式
 *
 * 新增语言 = 加一行 `SYNTAX_BY_FAMILY` + 在 `FAMILY_BY_LANGUAGE_ID` 里登记语言 id。
 * 两处都是数据，不需要改任何提取/分类逻辑。
 *
 * **doc 规则也是数据**：{@link CommentSyntax.docRule} 声明「这家的 doc 怎么判」
 * （`markup` = 标记已在单元层判过；`structural` = 靠语法位置 + 行距）。
 * 曾经分类器里写的是 `ctx.family === 'go'`，那是 R1.3 明令禁止的形态 ——
 * 有了这个字段，新语言的 doc 语义也只需改表。
 *
 * ## 扩展名归属
 *
 * **不在这张表里**：文件路径 → 语言 id 一律走 `shared/utils/languageRegistry` 的
 * `languageForPath`（全仓扩展名归属的唯一事实源）。本模块只做「语言 id → 注释语法家族」
 * 的后半段映射，避免出现第二张会漂移的扩展名表（R8.4）。
 */
import { languageForPath } from '@/shared/utils/languageRegistry';

/** 注释语法家族 —— 同一家族内的节点名/标记完全相同。 */
export type LanguageFamily =
  | 'ts'
  | 'rust'
  | 'go'
  | 'java'
  | 'python'
  | 'css'
  | 'stream'
  | 'unknown';

/** doc 判据策略（R1.3：必须是**数据**，不能是 `if (lang === 'go')`）。 */
export type DocRule =
  /** 单元层已用标记判过（`/** */
  | `、` ///`、`//!`、docstring）—— 组层只汇总裁定。 */
  | 'markup'
  /** 无标记，靠**语法位置 + 行距**判（Go：D7-Go）。 */
  | 'structural'
  /** 该家族不区分 doc / prose。 */
  | null;

/** docstring 的语法位置（U3：Python docstring 是字符串表达式，不是注释节点）。 */
export interface DocstringSpec {
  /** 包裹节点名（`ExpressionStatement`）。 */
  wrapperNodeName: string;
  /**
   * 内层字符串节点名。**只能是 `String`** —— 不能包含 `FormatString`：
   * 实测 `f"""..."""` 解析为 `FormatString`（带插值语义），翻它会改变程序行为，
   * 因此结构性排除比「文本判 f 前缀」更可靠。
   */
  valueNodeName: string;
  /** 合法引号（原样保留，见 D8-Docstring）。 */
  quotes: readonly string[];
  /**
   * 字符串前缀（如 `r` / `b` / `u` / `rb`），按长度降序。
   *
   * 实测保留前缀是对的：`r"""x"""` 的节点文本含 `r`，重建时必须原样回写，
   * 否则会改变字符串语义（raw 会处理反斜杠）。
   */
  prefixes: readonly string[];
}

export interface CommentSyntax {
  /** 注释节点名候选集合（精确匹配，不做大小写模糊）。 */
  nodeNames: readonly string[];
  /**
   * 行注释标记，**按长度降序**。
   *
   * 顺序有语义：`///` 必须先于 `//` 匹配，否则剥标记时会留下一个多余的 `/`
   * （`///doc` → `/doc`）。同理 `//!` 必须先于 `//`。
   */
  lineMarkers: readonly string[];
  /** 块注释起止标记；无块注释的语言为 `null`。 */
  blockOpen: string | null;
  blockClose: string | null;
  /** 文档性注释的行标记（如 Rust `///`/`//!`）；为 `null` 表示该家族没有行式 doc 注释。 */
  docLineMarkers: readonly string[] | null;
  /** docstring 语法位置；`null` 表示该家族没有 docstring 形态。 */
  docstring: DocstringSpec | null;
  /**
   * 结构式 / 标记式 doc 判据（{@link DocRule}）。
   *
   * 这是「新增语言 = 加一行数据表」的最后一环：在它之前，doc 判定还需要在分类器里写
   * `ctx.family === 'go'` 这类分支（违反 R1.3），新语言无论怎么加都要动逻辑代码。
   */
  docRule: DocRule;
}

const C_FAMILY_BLOCK: Pick<CommentSyntax, 'blockOpen' | 'blockClose'> = {
  blockOpen: '/*',
  blockClose: '*/',
};

/**
 * 家族 → 注释语法。**这是唯一的节点名事实源**。
 *
 * 每个条目的 `nodeNames` 都与 AC1 的真实 parser 断言一一对应：表里多写一个真实树里
 * 不存在的名字，AC1 的反向断言会失败（防止「表与事实漂移」）。
 */
const SYNTAX_BY_FAMILY: Readonly<Record<Exclude<LanguageFamily, 'unknown'>, CommentSyntax>> = {
  ts: {
    nodeNames: ['LineComment', 'BlockComment'],
    // `///` 必须在前：TS 的三斜线指令（`/// <reference ... />`）是真实语法。
    // 若只有 `//`，剥标记会留下一个 `/` 污染正文（实测：`/// @ts-expect-error` →
    // `/ @ts-expect-error`，于是指令模式匹配失败、被误判成 prose 而送翻译）。
    lineMarkers: ['///', '//'],
    ...C_FAMILY_BLOCK,
    docLineMarkers: null,
    docstring: null,
    // 三斜线指令是 TS 语法，但**不是** doc 标记；doc 由 `/** */`（单元层 `isDoc`）给出。
    docRule: 'markup',
  },
  rust: {
    nodeNames: ['LineComment', 'BlockComment'],
    // `///` / `//!` 都是 LineComment 节点，但剥标记时必须最长优先。
    lineMarkers: ['///', '//!', '//'],
    ...C_FAMILY_BLOCK,
    docLineMarkers: ['///', '//!'],
    docstring: null,
    docRule: 'markup',
  },
  go: {
    nodeNames: ['LineComment', 'BlockComment'],
    lineMarkers: ['///', '//'],
    ...C_FAMILY_BLOCK,
    // Go 的 doc 判定不靠标记（没有 `///`），靠语法位置 + 行距（D7-Go），故此处为 null。
    docLineMarkers: null,
    docstring: null,
    docRule: 'structural',
  },
  java: {
    nodeNames: ['LineComment', 'BlockComment'],
    lineMarkers: ['///', '//'],
    ...C_FAMILY_BLOCK,
    docLineMarkers: null,
    docstring: null,
    docRule: 'markup',
  },
  python: {
    // 注意：Python 的注释节点名是 `Comment`，不是 `LineComment`。
    nodeNames: ['Comment'],
    lineMarkers: ['#'],
    blockOpen: null,
    blockClose: null,
    docLineMarkers: null,
    docstring: {
      wrapperNodeName: 'ExpressionStatement',
      valueNodeName: 'String',
      quotes: ['"""', "'''"],
      // 实测：r/b/u/rb 前缀都会出现在 String 节点文本里；f 前缀是 FormatString。
      prefixes: ['rb', 'br', 'r', 'b', 'u'],
    },
    // docstring 在单元层已被标 `isDoc`，组层只需汇总。
    docRule: 'markup',
  },
  css: {
    nodeNames: ['Comment'],
    lineMarkers: [],
    ...C_FAMILY_BLOCK,
    docLineMarkers: null,
    docstring: null,
    // CSS 无 doc 概念；`/** */` 也会被标 `isDoc`（与 `/* */` 的区分由 `blockOpenOf` 给出）。
    docRule: 'markup',
  },
  stream: {
    // StreamLanguage（legacy-modes）的节点名是**小写** `comment`。
    nodeNames: ['comment'],
    lineMarkers: ['#'],
    ...C_FAMILY_BLOCK,
    docLineMarkers: null,
    docstring: null,
    // legacy-modes 无 doc 标记 → 单元层 `isDoc` 恒为 false。
    docRule: 'markup',
  },
};

/**
 * 规范语言 id（`languageRegistry` 的值域）→ 家族。
 *
 * 只登记**确有注释语义**且本任务支持的语言；未登记一律 `unknown`（不翻译，UI 说明原因）。
 * 这是有意的保守：宁可功能不可用，也不按猜测的节点名去翻（Wrong comment extraction
 * 比不翻危险得多）。
 */
const FAMILY_BY_LANGUAGE_ID: Readonly<Record<string, LanguageFamily>> = {
  typescript: 'ts',
  typescriptreact: 'ts',
  javascript: 'ts',
  javascriptreact: 'ts',
  rust: 'rust',
  go: 'go',
  java: 'java',
  python: 'python',
  css: 'css',
  // legacy-modes 家族：节点名统一是小写 comment（与 Lezer 解析器不同）
  yaml: 'stream',
  shell: 'stream',
};

const UNKNOWN_SYNTAX: CommentSyntax = {
  nodeNames: [],
  lineMarkers: [],
  blockOpen: null,
  blockClose: null,
  docLineMarkers: null,
  docstring: null,
  docRule: null,
};

/**
 * 文件路径 → 注释语法家族。
 *
 * 扩展名归属交给 `languageForPath`（全仓唯一事实源），本函数只做语言 id → 家族的后半段。
 */
export function detectFamily(filePath: string): LanguageFamily {
  const languageId = languageForPath(filePath);
  if (!languageId) return 'unknown';
  return FAMILY_BY_LANGUAGE_ID[languageId] ?? 'unknown';
}

/** 家族 → 完整注释语法（未支持家族返回静态空语法，调用方无需判空）。 */
export function syntaxFor(family: LanguageFamily): CommentSyntax {
  if (family === 'unknown') return UNKNOWN_SYNTAX;
  return SYNTAX_BY_FAMILY[family];
}

/** 家族 → 注释节点名候选集合（`unknown` 为空数组）。 */
export function commentNodeNames(family: LanguageFamily): readonly string[] {
  return syntaxFor(family).nodeNames;
}

/** 家族 → 行注释标记（已按长度降序，剥标记时可直接顺序匹配）。 */
export function lineMarkersOf(family: LanguageFamily): readonly string[] {
  return syntaxFor(family).lineMarkers;
}

/** 家族 → docstring 语法位置；无 docstring 形态返回 `null`。 */
export function docstringSpecOf(family: LanguageFamily): DocstringSpec | null {
  return syntaxFor(family).docstring;
}

/** 家族 → doc 判据策略（`unknown` 为 `null`，即不判 doc）。 */
export function docRuleOf(family: LanguageFamily): DocRule {
  return syntaxFor(family).docRule;
}
