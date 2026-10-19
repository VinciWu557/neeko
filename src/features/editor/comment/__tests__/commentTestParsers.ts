/**
 * **测试专用**的 parser 加载器 —— 源码字符串 → {@link RawUnit}[]。
 *
 * ## 为什么它不在生产模块里
 *
 * 生产路径的语法树来自 `syntaxTree(state)`（CodeMirror 已经解析好的增量树），
 * 从来不需要「从字符串现造一棵树」。把 7 个语言包的动态 import 放在
 * `extractComments.ts` 里，等于让生产模块背着零调用的测试设施：
 *
 * - 模块体积与「懒加载边界」被测试需求污染；
 * - 谁看见 `extractFromSource` 导出都会以为它是生产入口（误用即双解析）。
 *
 * 所以它搬到了 `__tests__/commentTestParsers.ts`。**生产代码不要 import 本文件**
 * （它在 `__tests__/` 下且不是 `*.test.ts`，不在 vitest 的用例匹配模式里）。
 *
 * ## 为什么每个用例都真的解析
 *
 * 注释节点名的方言分裂（`LineComment` / `Comment` / `comment`）是实测出来的，
 * 不是能凭直觉猜的。mock 语法树会让测试与真实树形状脱钩 —— 已因此误过两次。
 */
import type { LanguageFamily } from '../commentSyntax';
import { detectFamily } from '../commentSyntax';
import { extractComments, type RawUnit, type TreeLike } from '../extractComments';

/** family → 取 parser 的加载器（动态 import，避免把 7 个语言包拖进测试启动）。 */
const PARSER_LOADERS: Record<string, () => Promise<{ parse(input: string): unknown }>> = {
  ts: async () => (await import('@codemirror/lang-javascript')).javascriptLanguage.parser,
  rust: async () => (await import('@codemirror/lang-rust')).rustLanguage.parser,
  go: async () => (await import('@codemirror/lang-go')).goLanguage.parser,
  java: async () => (await import('@codemirror/lang-java')).javaLanguage.parser,
  python: async () => (await import('@codemirror/lang-python')).pythonLanguage.parser,
  css: async () => (await import('@codemirror/lang-css')).cssLanguage.parser,
  stream: async () => {
    const { StreamLanguage } = await import('@codemirror/language');
    const { yaml } = await import('@codemirror/legacy-modes/mode/yaml');
    return StreamLanguage.define(yaml).parser;
  },
};

/** 从**源码字符串**提取（解析一次真实树 → `extractComments`）。 */
export async function extractFromSource(params: {
  family: LanguageFamily;
  source: string;
}): Promise<RawUnit[]> {
  const loader = PARSER_LOADERS[params.family];
  if (!loader) return [];
  const parser = await loader();
  const tree = parser.parse(params.source) as TreeLike;
  return extractComments({ family: params.family, tree, source: params.source });
}

/** 便捷：从文件路径提取（family 由 `languageForPath` 归一得出）。 */
export function extractFromPath(params: { filePath: string; source: string }): Promise<RawUnit[]> {
  return extractFromSource({ family: detectFamily(params.filePath), source: params.source });
}
