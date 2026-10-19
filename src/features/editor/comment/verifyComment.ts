/**
 * 注释译文的**后置条件校验**（纯函数，规则表驱动）。
 *
 * ## 注释的失效模式与文档不同
 *
 * 文档翻译坏了是「排版难看」；注释翻译坏了是**破语义**：
 *
 * | 丢了什么 | 后果 |
 * | --- | --- |
 * | 占位符 `{0}` / `%s` | 程序运行时报错或静默错位 |
 * | doc 标签名 `@param` / 字段名 `sessionId` | IDE 跳转与文档生成失效 |
 * | 行内代码跨度 `` `cacheKey` `` | 读者照抄拼错的标识符 |
 * | URL | 链接 404 |
 * | 回吐了代码段 | 读者以为那是可执行内容 |
 *
 * ## 规则表而非分支
 *
 * 每条规则是 `(input) => Verdict`，新增校验 = push 一个函数，引擎与调用点零改动（AC17）。
 * 规则抛异常时降级为「未通过」并带原因，**不杀整批** —— 一条规则的 bug 不该让整个文件翻不了。
 */

/** 校验输入。 */
export interface VerifyInput {
  /** 原文（segment 的 `text`）。 */
  source: string;
  /** 模型返回的译文。 */
  translation: string;
  /**
   * 禁止出现在译文里的文本（代码段 / 围栏内容原文）。
   *
   * 这些内容**根本没进请求**（`segmentBlock` 已排除），若出现在译文里说明模型在幻觉复述。
   */
  forbiddenTexts?: readonly string[];
}

/** 单条规则的判定。 */
export interface Verdict {
  ok: boolean;
  /** 未通过原因（进 UI，可作重试提示）。 */
  reason?: string;
}

/** 校验规则。 */
export type VerifyRule = (input: VerifyInput) => Verdict;

/** 占位符模式（覆盖主流模板语法）。 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\{\d+\}/g, // {0}
  /\{\{[\w.]+\}\}/g, // {{user}}
  /\$\{[\w.]+\}/g, // ${x}
  /%\d+\$[sd]/g, // %1$s
  /%[sd]/g, // %s %d
  /\{[a-zA-Z_][\w.]*\}/g, // {name}
];

/** 提取全部占位符（排序后用于多重集比较）。 */
function placeholdersIn(text: string): string[] {
  const found: string[] = [];
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const matches = text.match(new RegExp(pattern.source, 'g'));
    if (matches) found.push(...matches);
  }
  return found.sort();
}

/** 行内代码跨度内容。 */
const CODE_SPAN = /`([^`]+)`/g;

/** URL。 */
const URL_PATTERN = /https?:\/\/[^\s)>\]"']+/g;

/**
 * doc 标签及其**参数名**：`@param name` / `:param name:`。
 *
 * 只有 `param` 类标签后面跟的是名字；`@returns` / `@throws` 后面跟的是**说明文本**
 * （`@returns the id` 里的 `the` 不是名字）。把它们一起抓会误判
 * 「doc tag name lost: the」（实测 bug：正常译文被拒）。
 */
const DOC_TAG_WITH_NAME = /(?:@param|:param)\s+([A-Za-z_][\w.]*)/g;

/** Args 结构块字段名：缩进的 `name:` 或 `name (int):`。 */
const ARGS_FIELD_NAME = /^[ \t]+([A-Za-z_][\w.]*)\s*(?:\([^)]*\))?\s*:/gm;

/** 收集匹配到的捕获组（去重排序）。 */
function captures(pattern: RegExp, text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const value = match[1];
    if (value) out.push(value);
  }
  return out.sort();
}

/** 多重集相等（顺序无关，但重复计数敏感）。 */
function sameMultiset(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** 空产出 / 拒答检测。 */
const notEmptyOrRefusal: VerifyRule = ({ translation }) => {
  const text = translation.trim();
  if (!text) return { ok: false, reason: 'empty translation' };
  if (/^(sorry|i can(?:no|')?t|unable to|i'm sorry|抱歉|无法|我不能)/i.test(text)) {
    return { ok: false, reason: 'model refused' };
  }
  return { ok: true };
};

/**
 * 占位符多重集必须相等。
 *
 * 用**多重集**而不是「全部包含」：模型多编一个 `{1}` 同样是错误（下游会 KeyError）。
 */
const preservesPlaceholders: VerifyRule = ({ source, translation }) => {
  const src = placeholdersIn(source);
  const dst = placeholdersIn(translation);
  if (sameMultiset(src, dst)) return { ok: true };
  const missing = src.filter((token) => !dst.includes(token));
  const invented = dst.filter((token) => !src.includes(token));
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`lost ${missing.join(' ')}`);
  if (invented.length > 0) parts.push(`invented ${invented.join(' ')}`);
  return { ok: false, reason: `placeholder mismatch (${parts.join('; ') || 'set differs'})` };
};

/**
 * doc 标签名与参数名必须存活。
 *
 * `@param sessionId 说明` → 只有「说明」该被翻译；标签名与参数名是可被工具解析的标识。
 */
const preservesDocTags: VerifyRule = ({ source, translation }) => {
  // 标签名本身（@param / :param）
  const tagNames =
    source.match(
      /(?:@(?:param|returns?|throws?|type|yields)\b|:(?:param|returns?|type|raises?|yields)\b)/g,
    ) ?? [];
  for (const tag of tagNames) {
    if (!translation.includes(tag)) {
      return { ok: false, reason: `doc tag lost: ${tag}` };
    }
  }
  // 标签后的名字（参数名 / 返回名）
  const names = captures(DOC_TAG_WITH_NAME, source);
  for (const name of names) {
    if (!translation.includes(name)) {
      return { ok: false, reason: `doc tag name lost: ${name}` };
    }
  }
  return { ok: true };
};

/**
 * Args 结构块字段名必须存活（D9-Args）。
 *
 * 只对「源文里确实有结构块」的情况生效 —— 否则会把普通 `key: value` 散文误判。
 */
const preservesArgsFieldNames: VerifyRule = ({ source, translation }) => {
  if (!/^[ \t]*(?:Args|Arguments|Parameters)[:：]\s*$/m.test(source)) return { ok: true };
  const names = captures(ARGS_FIELD_NAME, source);
  for (const name of names) {
    if (!translation.includes(name)) {
      return { ok: false, reason: `Args field name lost: ${name}` };
    }
  }
  return { ok: true };
};

/** 行内代码跨度内容多重集相等。 */
const preservesCodeSpans: VerifyRule = ({ source, translation }) => {
  const src = captures(CODE_SPAN, source);
  const dst = captures(CODE_SPAN, translation);
  if (sameMultiset(src, dst)) return { ok: true };
  return {
    ok: false,
    reason: `code span altered (${src.join(',') || 'none'} → ${dst.join(',') || 'none'})`,
  };
};

/** URL 多重集相等（链接文字可译，目标不可改）。 */
const preservesUrls: VerifyRule = ({ source, translation }) => {
  const src = (source.match(URL_PATTERN) ?? []).sort();
  const dst = (translation.match(URL_PATTERN) ?? []).sort();
  if (sameMultiset(src, dst)) return { ok: true };
  return { ok: false, reason: `url altered (${src.length} → ${dst.length})` };
};

/**
 * 禁止回吐代码（AC9）。
 *
 * 代码段/围栏内容**根本没进请求**，若出现在译文里说明模型在幻觉复述 —— 必须拦下，
 * 否则读者会把那段当成译文照抄。
 */
const rejectsCodeEcho: VerifyRule = ({ translation, forbiddenTexts }) => {
  if (!forbiddenTexts || forbiddenTexts.length === 0) return { ok: true };
  for (const text of forbiddenTexts) {
    const needle = text.trim();
    if (!needle) continue;
    if (translation.includes(needle)) {
      return { ok: false, reason: 'code echoed into translation' };
    }
  }
  return { ok: true };
};

/**
 * 长度比例异常（截断 / 复读）。
 *
 * 阈值**保守**：宁可放过可疑，不可误杀正确译文（误杀会让用户看到莫名失败）。
 */
const plausibleLength: VerifyRule = ({ source, translation }) => {
  const srcLength = source.trim().length;
  const dstLength = translation.trim().length;
  if (srcLength < 12) return { ok: true }; // 短源不判
  const ratio = dstLength / Math.max(srcLength, 1);
  if (ratio < 0.15) return { ok: false, reason: `too short (${ratio.toFixed(2)})` };
  if (ratio > 6) return { ok: false, reason: `too long (${ratio.toFixed(2)})` };
  return { ok: true };
};

/**
 * 译文与原文完全相同 → 模型没翻（复读原文）。
 *
 * 只对「源文含英文单词」的情况生效：纯符号 / 纯数字的源文译文相同是合理的。
 */
const notUnchanged: VerifyRule = ({ source, translation }) => {
  if (!/[A-Za-z]{3,}/.test(source)) return { ok: true };
  if (source.trim() === translation.trim()) {
    return { ok: false, reason: 'translation unchanged from source' };
  }
  return { ok: true };
};

/**
 * 默认规则集（顺序即优先级，首个失败即返回）。
 *
 * 顺序理由：先排除「模型根本没翻」（空/拒答/复读），再查语义破坏（占位符/标签/代码），
 * 最后查长度异常 —— 长度异常最容易误判，放在最后避免掩盖更具体的原因。
 */
export const DEFAULT_COMMENT_RULES: readonly VerifyRule[] = [
  notEmptyOrRefusal,
  notUnchanged,
  rejectsCodeEcho,
  preservesPlaceholders,
  preservesDocTags,
  preservesArgsFieldNames,
  preservesCodeSpans,
  preservesUrls,
  plausibleLength,
];

/**
 * 执行校验。
 *
 * 规则抛异常 → 降级为「未通过」并带原因（**不向外抛**）：一条规则的 bug 不该让整批翻不了。
 */
export function verifyComment(input: VerifyInput & { rules?: readonly VerifyRule[] }): Verdict {
  const rules = input.rules ?? DEFAULT_COMMENT_RULES;
  for (const rule of rules) {
    let verdict: Verdict;
    try {
      verdict = rule(input);
    } catch (error) {
      return { ok: false, reason: `rule threw: ${String(error)}` };
    }
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}
