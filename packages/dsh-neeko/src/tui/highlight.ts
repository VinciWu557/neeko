/**
 * A small syntax highlighter for code blocks.
 *
 * ## Why hand-rolled instead of a real tokenizer
 *
 * A full parser (tree-sitter, shiki) is megabytes of grammar data for a terminal
 * that renders one screen of code. The job here is only *visual separation*:
 * comments, strings and keywords must be distinguishable at a glance, so the
 * reader can find the prose inside the code. A lexical scan over a handful of
 * pattern classes gets that, stays dependency-free, and never throws on the
 * fragments a stream can produce.
 *
 * The classes map onto pi's `syntax*` theme tokens, so a pi theme colours code
 * the same way in both TUIs. Unknown languages still get string / number /
 * comment colouring — those three are near-universal.
 *
 * @module dsh-neeko/tui/highlight
 */

import type { ThemeToken } from './theme-tokens.ts'

/** One coloured span of a line. */
interface Span {
  readonly start: number
  readonly end: number
  readonly token: ThemeToken
}

/** Keyword sets per language family; a missing family gets none. */
const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  ts: [
    'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
    'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally',
    'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface',
    'is', 'keyof', 'let', 'new', 'null', 'of', 'private', 'protected', 'public', 'readonly', 'return',
    'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined',
    'var', 'void', 'while', 'yield',
  ],
  rust: [
    'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern',
    'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub',
    'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe',
    'use', 'where', 'while',
  ],
  python: [
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
    'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
    'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'try', 'while',
    'with', 'yield',
  ],
  shell: [
    'case', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for', 'function', 'if', 'in',
    'local', 'return', 'then', 'until', 'while',
  ],
  json: ['true', 'false', 'null'],
  css: ['important', 'media', 'import', 'keyframes', 'from', 'to'],
  sql: [
    'select', 'from', 'where', 'insert', 'into', 'update', 'delete', 'create', 'table', 'alter',
    'drop', 'join', 'left', 'right', 'inner', 'outer', 'on', 'group', 'by', 'order', 'having',
    'limit', 'offset', 'as', 'and', 'or', 'not', 'null', 'values', 'set',
  ],
}

/** Alias → the family whose keyword set applies. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ts: 'ts', typescript: 'ts', tsx: 'ts', jsx: 'ts', js: 'ts', javascript: 'ts', mjs: 'ts', cjs: 'ts',
  rs: 'rust', rust: 'rust',
  py: 'python', python: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'css', less: 'css',
  sql: 'sql',
}

/** Resolve a fence language to its keyword family, if it has one. */
function familyOf(language: string | undefined): string | undefined {
  if (language === undefined) return undefined
  return LANGUAGE_ALIASES[language.trim().toLowerCase()]
}

/** Keywords for one fence language, empty when unknown. */
function keywordsOf(language: string | undefined): readonly string[] {
  const family = familyOf(language)
  return family === undefined ? [] : KEYWORDS[family] ?? []
}

/** Comment syntax per family: `line` prefixes and `block` delimiters. */
const COMMENTS: Readonly<Record<string, { line: readonly string[]; block?: readonly [string, string] }>> = {
  python: { line: ['#'] },
  shell: { line: ['#'] },
  sql: { line: ['--'] },
  css: { line: [], block: ['/*', '*/'] },
  json: { line: [] },
  ts: { line: ['//'], block: ['/*', '*/'] },
  rust: { line: ['//'], block: ['/*', '*/'] },
}

/** Locate the comment start on a line, honouring quoted strings. */
function commentStart(line: string, language: string | undefined): number {
  const family = familyOf(language)
  if (family === undefined) return -1
  const spec = COMMENTS[family]
  if (spec === undefined) return -1
  let quote: string | undefined
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quote !== undefined) {
      if (char === '\\') i += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue }
    for (const prefix of spec.line) {
      if (prefix !== '' && line.startsWith(prefix, i)) return i
    }
    if (spec.block !== undefined && line.startsWith(spec.block[0], i)) return i
  }
  return -1
}

/**
 * Compute the coloured spans of one line.
 *
 * Spans are non-overlapping and returned in order; a later class never rewrites
 * an earlier one, which keeps the colouring stable instead of flickering between
 * two plausible readings of the same character.
 *
 * @param line - one source line.
 * @param language - the fence's language tag, if any.
 * @returns spans to paint, in source order.
 */
export function lineSpans(line: string, language: string | undefined): readonly Span[] {
  // A comment owns the rest of the line: nothing inside it is a keyword.
  const stop = commentStart(line, language)
  const limit = stop === -1 ? line.length : stop
  const spans: Span[] = []
  const taken: boolean[] = Array.from({ length: line.length }, () => false)

  const claim = (start: number, end: number, token: ThemeToken): void => {
    if (end <= start || start < 0) return
    for (let i = start; i < end; i += 1) {
      if (taken[i] === true) return
    }
    for (let i = start; i < end; i += 1) taken[i] = true
    spans.push({ start, end, token })
  }

  if (stop !== -1) claim(stop, line.length, 'syntaxComment')

  // Strings before keywords: `"if"` is a string, not a keyword.
  const stringPattern = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/gu
  for (const match of line.matchAll(stringPattern)) {
    const start = match.index
    if (start >= limit) break
    claim(start, start + match[0].length, 'syntaxString')
  }

  const keywords = keywordsOf(language)
  if (keywords.length > 0) {
    const wordPattern = /[A-Za-z_$][\w$]*/gu
    for (const match of line.matchAll(wordPattern)) {
      if (keywords.includes(match[0])) claim(match.index, match.index + match[0].length, 'syntaxKeyword')
    }
  }

  // Numbers last: a digit inside an identifier (`a1`) stays uncoloured.
  const numberPattern = /\b\d+(?:\.\d+)?\b/gu
  for (const match of line.matchAll(numberPattern)) {
    if (match.index >= limit) break
    claim(match.index, match.index + match[0].length, 'syntaxNumber')
  }

  return spans.sort((a, b) => a.start - b.start)
}

/**
 * Highlight one code block, line by line.
 *
 * Returns plain strings (already ANSI-wrapped) in the shape
 * `MarkdownTheme.highlightCode` expects.
 *
 * @param code - the fence body.
 * @param language - the fence language tag.
 * @param paint - colours text with one theme token.
 * @returns one string per line.
 */
export function highlightCodeFence(
  code: string,
  language: string | undefined,
  paint: (token: ThemeToken, text: string) => string,
): string[] {
  return code.split('\n').map((line) => {
    const spans = lineSpans(line, language)
    if (spans.length === 0) return line
    let out = ''
    let cursor = 0
    for (const span of spans) {
      out += line.slice(cursor, span.start)
      out += paint(span.token, line.slice(span.start, span.end))
      cursor = span.end
    }
    return out + line.slice(cursor)
  })
}
