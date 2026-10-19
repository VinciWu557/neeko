import { describe, expect, it } from 'vitest'
import { highlightCodeFence, lineSpans } from '../src/tui/highlight.ts'

/**
 * Code-block highlighting.
 *
 * The highlighter exists for *visual separation*, not semantic accuracy: a
 * reader must be able to find comments and strings inside a page of code. These
 * cases pin that, plus the two ways a naive scanner breaks — colouring inside a
 * string, and claiming the same characters twice.
 */

const paint = (token: string, text: string): string => `<${token}>${text}</>`

/** The tokens a line's spans use, in order. */
const tokens = (line: string, language?: string): string[] =>
  lineSpans(line, language).map((span) => span.token)

describe('lineSpans', () => {
  it('colours keywords, strings and trailing comments', () => {
    expect(highlightCodeFence('const a = "hi" // why', 'ts', paint)).toEqual([
      '<syntaxKeyword>const</> a = <syntaxString>"hi"</> <syntaxComment>// why</>',
    ])
  })

  it('does not colour a keyword inside a string', () => {
    // `"if"` is data; colouring it as syntax would be actively misleading.
    const spans = lineSpans('x = "if not for"', 'python')
    expect(spans).toHaveLength(1)
    expect(spans[0]?.token).toBe('syntaxString')
  })

  it('gives the comment the rest of the line', () => {
    // Once a comment starts, `const` inside it is prose.
    const spans = lineSpans('// const a = "x"', 'ts')
    expect(spans).toEqual([{ start: 0, end: 16, token: 'syntaxComment' }])
  })

  it('handles a shell comment', () => {
    expect(tokens('# build it', 'bash')).toEqual(['syntaxComment'])
  })

  it('colours numbers but not digits inside identifiers', () => {
    expect(tokens('const a1 = 42', 'ts')).toEqual(['syntaxKeyword', 'syntaxNumber'])
  })

  it('leaves an unknown language with strings and numbers only', () => {
    // `const` is not a keyword without a known grammar, but the quoting still is.
    expect(tokens('const x = "s"', 'brainfuck')).toEqual(['syntaxString'])
  })

  it('leaves plain text untouched', () => {
    expect(lineSpans('just words', undefined)).toEqual([])
  })

  it('never produces overlapping spans', () => {
    // Two claims for one character would emit the text twice.
    const spans = lineSpans('const s = "a const b"', 'ts')
    for (let i = 1; i < spans.length; i += 1) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end)
    }
  })
})

describe('highlightCodeFence', () => {
  it('returns one string per line', () => {
    expect(highlightCodeFence('a\nb\nc', undefined, paint)).toHaveLength(3)
  })

  it('preserves the source text exactly when colouring is stripped', () => {
    const code = 'const a = "x" // note\n  b = 2'
    const stripped = highlightCodeFence(code, 'ts', paint)
      .join('\n')
      .replace(/<[^>]+>/gu, '')
    expect(stripped).toBe(code)
  })

  it('colours a Rust function signature', () => {
    const out = highlightCodeFence('pub fn run(a: u32) -> bool', 'rust', paint).join('')
    expect(out).toContain('<syntaxKeyword>pub</>')
    expect(out).toContain('<syntaxKeyword>fn</>')
  })

  it('colours a JSON literal without inventing keywords', () => {
    const out = highlightCodeFence('{"a": true}', 'json', paint).join('')
    expect(out).toContain('<syntaxKeyword>true</>')
  })
})
