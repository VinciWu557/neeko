/**
 * 注释行的**文本启发式**（纯函数，无状态）——「像代码 / 像标签 / 像句子」。
 *
 * ## 为什么与「分段状态机」分开
 *
 * `segmentBlock` 承担两件**变化节奏完全不同**的事：
 *
 * | 关注点 | 变化驱动 | 落点 |
 * | --- | --- | --- |
 * | 行级文本启发式 | 用户报「这句被误判成代码了」→ 调正则 | **本文件** |
 * | 分段状态机 | fence / 示例引导 / tag 状态流转（与文本内容无关） | `segmentBlock.ts` |
 *
 * 混在一个 435 行文件里时，改一条正则要在状态机代码里翻找，也没法单独回归启发式。
 * 本拆分是**纯搬迁**：行为零变化（所有 segmentBlock 用例原样全绿）。
 *
 * ## 误判方向（design.md D2）
 *
 * `looksLikeCode` 判**偏宽**：判错成 code → 用户看到原文未翻，可手动处理，**代码安全**；
 * 判错成 prose → 代码被翻坏，**照抄即报错**。
 *
 * 但「偏宽」不等于乱判：必须给明确信号（代码起始词 / 代码符号组合 + 行尾特征）。
 * 单靠「含某个符号」会误杀 `See \`cacheKey\` for details.` 这类正常句子 —— 那属于
 * 误杀散文，同样是坏结果。所以每条宽判据都配一个 {@link looksLikeSentence} 抑制。
 */

/**
 * 代码起始词（行首命中即判 code）。
 *
 * 偏宽：涵盖主流语言的声明/控制流关键字。判错方向是「多判 code」，安全。
 */
const CODE_KEYWORD_PREFIX = new RegExp(
  '^(' +
    [
      // 通用控制流 / 声明
      'if',
      'else',
      'for',
      'while',
      'do',
      'switch',
      'case',
      'return',
      'break',
      'continue',
      'throw',
      'try',
      'catch',
      'finally',
      // 变量 / 函数 / 类型声明
      'const',
      'let',
      'var',
      'function',
      'fn',
      'def',
      'class',
      'struct',
      'enum',
      'trait',
      'impl',
      'interface',
      'type',
      'pub',
      'async',
      'await',
      'static',
      'final',
      'public',
      'private',
      'protected',
      // 模块 / 导入
      'import',
      'from',
      'export',
      'require',
      'use',
      'mod',
      'package',
      'include',
      'using',
      'namespace',
      // 语言特有
      'func',
      'go',
      'defer',
      'select',
      'lambda',
      'yield',
      'match',
      'when',
      // 预处理 / SQL
      '#include',
      '#define',
      '#if',
      '#endif',
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'CREATE',
      'ALTER',
      'DROP',
    ].join('|') +
    ')\\b',
);

/** 代码符号组合（需与「像句子」的判据一起用，避免误杀散文）。 */
const CODE_SYMBOL_GROUPS: readonly RegExp[] = [
  /\(\);/, // 空调用
  /\)\s*;\s*$/, // 语句结束
  /=>/, // 箭头函数
  /===|!==/, // 严格比较
  /&&|\|\|/, // 逻辑运算
  /\+\+|--/, // 自增/自减
  /\+=|-=|\*=|\/=/, // 复合赋值
  /::/, // 作用域解析
  /->/, // 指针/返回类型
  /\[\]/, // 空数组
  /\w+\s*\([^)]*\)\s*[;{]?$/, // 形如 foo(a, b) 或 foo(a) {
];

/** 行尾代码特征。 */
const CODE_TAIL = /[;{}]\s*$/;

/**
 * 判断一段文本是否「像自然语言句子」。
 *
 * 用于抑制代码符号误判：`See \`cacheKey\` for details.` 含反引号但不该判 code。
 * 判据：有足够多的空格分词 + 句首是常见英文/中文散文形态。
 */
export function looksLikeSentence(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // **先排除明确的代码形态**：`total = price * qty;` 有 4 个词、小写开头，
  // 若先走「像句子」判据会被判成散文（实测 bug）。代码符号 + 行尾分号优先级更高。
  if (/;$/.test(trimmed) && /[=(]/.test(trimmed)) return false;
  if (/^[\w.$]+\s*=[^=]/.test(trimmed)) return false;

  // 中文散文（含汉字）：仅当不含代码语句特征时才算句子
  if (/[\u4e00-\u9fff]/.test(trimmed)) {
    if (/[;{}]|\w+\s*\([^)]*\)\s*;/.test(trimmed)) return false;
    return true;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  // 至少 4 个词且以句号/逗号收尾 → 句子
  if (words.length >= 4 && /[.,:;]$/.test(trimmed)) return true;
  // 首词是小写英文且无代码符号 → 句子
  if (words.length >= 3 && /^[a-z]/.test(trimmed) && !/[=(){}]/.test(trimmed)) return true;
  return false;
}

/** 示例引导行（其后缩进块视为代码）。 */
export const EXAMPLE_LEAD =
  /^(usage|example|examples|e\.g\.|for example|例如|示例|用法)\s*[:：]?\s*$/i;

/** doc 标签行（`@param` / `:param` / `Args:` 等）。 */
const DOC_TAG_LINE =
  /^@(?:param|returns?|throws?|type|deprecated|see|example|since|author|yields)\b/;
const DOC_TAG_COLON = /^:(?:param|returns?|type|raises?|yields)\s/;
export const DOC_SECTION_HEADER =
  /^(?:Args|Arguments|Returns|Raises|Yields|Attributes|Parameters|Examples?|Note|Notes|Warning|Warnings)[:：]\s*$/;

/** 围栏标记。 */
export const FENCE_MARK = /^(```|~~~)/;

/** 判定单行是否像代码（不含「示例引导行后的缩进」这条，那需要上下文）。 */
export function looksLikeCode(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // 1. 代码起始词
  if (CODE_KEYWORD_PREFIX.test(trimmed)) return true;

  // 2. 行首是 `{` / `}` / `</tag>`（JSX 收尾 / 块边界）
  if (/^[{}]/.test(trimmed)) return true;
  if (/^<\/?[A-Za-z][\w-]*(\s|\/?>)/.test(trimmed)) return true;

  // 3. 代码符号 + 行尾代码特征
  const hasSymbol = CODE_SYMBOL_GROUPS.some((pattern) => pattern.test(trimmed));
  if (hasSymbol && CODE_TAIL.test(trimmed)) return true;

  // 4. 赋值 / 调用语句（`x = ...` / `foo(...)`）且不像句子
  if (/^[\w.$]+\s*=[^=]/.test(trimmed) && !looksLikeSentence(trimmed)) return true;
  if (/^[\w.$]+\([^)]*\)\s*;?\s*$/.test(trimmed) && !looksLikeSentence(trimmed)) return true;

  // 5. 行尾代码特征 + 含括号（兜底，仍要求不像句子）
  if (CODE_TAIL.test(trimmed) && /[(){}=]/.test(trimmed) && !looksLikeSentence(trimmed)) {
    return true;
  }

  // 6. **行内代码语句**：`调用 foo(x); 即可` 这类「中文 + 代码 + 中文」混排。
  //    上面所有以 `^[\w.$]` 锚定的规则都要求代码在行首，这条覆盖代码在行中的形态。
  //    判据要求「括号调用 + 分号」同时出现（不是裸括号），避免误杀 `see the note (below)`。
  if (/\w+\s*\([^)]*\)\s*;/.test(trimmed)) return true;

  return false;
}

/** 判定 doc 标签行。 */
export function looksLikeDocTag(text: string): boolean {
  const trimmed = text.trim();
  return (
    DOC_TAG_LINE.test(trimmed) || DOC_TAG_COLON.test(trimmed) || DOC_SECTION_HEADER.test(trimmed)
  );
}

/**
 * `Args:` / `:param` 的**字段行**（结构块内的 `name: desc`）。
 *
 * 关键：必须**有缩进**。裸的 `Replace:` / `Note: use cache` 也是「词 + 冒号」形态，
 * 但它们是散文，不是结构块字段 —— 不加缩进判据会把大量散文误判成 tag
 * （实测：`// Replace:` 被判 tag，导致该行不送翻，说明直接丢失）。
 *
 * 结构块字段永远缩进在 `Args:` / `Parameters:` 之下，所以缩进是可靠区分信号。
 */
export function looksLikeArgsField(rawLine: string, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (indentWidth(rawLine) === 0) return false;
  // `x: the value` / `n (int): count` / `x:`（空说明）
  return /^[A-Za-z_][\w.]*\s*(?:\([^)]*\))?\s*:(\s|$)/.test(trimmed);
}

/** 该行是否有可翻译内容（说明非空）。 */
export function argsFieldHasDescription(text: string): boolean {
  const trimmed = text.trim();
  const colon = trimmed.indexOf(':');
  if (colon === -1) return false;
  return trimmed.slice(colon + 1).trim().length > 0;
}

/** 行首缩进宽度（空格 / tab 按 1 计）。 */
export function indentWidth(text: string): number {
  const match = /^[ \t]*/.exec(text);
  return match ? match[0].length : 0;
}
