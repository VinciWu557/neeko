import { describe, expect, it } from 'vitest'
import {
  COLLAPSED_ARGS_CHARS,
  FOLDED_CHARS,
  firstLine,
  foldText,
  formatToolHeader,
  latestLine,
  toolOutputLines,
} from '../src/tui/tool-present.ts'

/**
 * Tool presentation, following pi's own renderer.
 *
 * pi has no tool-specific styling: `formatToolCallWithArgs` renders every tool
 * as a bold name plus `key=value` pairs on one line (cut at
 * `COLLAPSED_ARGS_CHARS`), and expanded turns those pairs into `key: value`
 * lines. Length is what the length limits apply to, not meaning.
 *
 * This replaces an earlier variant table (read/search/bash/write/edit/code/
 * others, each with an emoji, a title and a summary heuristic). That layering
 * came from `@xmoon76/dsh-pi-tui`, not from pi, and it is what made a row read as
 * three competing labels — `🖥️ Bash List src/tui [ok]` — instead of one.
 *
 * The only DSH-specific concern kept here is the length limit: a tool result is
 * unbounded, and a row must stay one line while folded.
 */

const paint = (token: string, text: string): string => `<${token}>${text}</${token}>`

describe('formatToolHeader', () => {
  it('renders a bold tool name even with no arguments', () => {
    expect(formatToolHeader('bash', undefined, paint)).toBe('<toolTitle>bash</toolTitle>')
  })

  it('appends the arguments as key=value pairs on the same line', () => {
    // pi: `${header} ${muted(pairs)}` — the name is bold, the arguments muted.
    const header = formatToolHeader('bash', { command: 'ls -la' }, paint)
    expect(header).toContain('<toolTitle>bash</toolTitle>')
    expect(header).toContain('<muted>command="ls -la"</muted>')
  })

  it('joins several arguments on one line', () => {
    const header = formatToolHeader('read', { path: 'a.ts', limit: 10 }, paint)
    expect(header).toContain('path="a.ts"')
    expect(header).toContain('limit=10')
    expect(header.split('\n')).toHaveLength(1)
  })

  it('cuts a long argument list instead of wrapping it', () => {
    // A row stays one line; the rest is behind the expander.
    const long = { command: 'x'.repeat(300) }
    const header = formatToolHeader('bash', long, paint)
    expect(header.split('\n')).toHaveLength(1)
    expect(header).toContain('...')
    // The *preview* is bounded; "<toolTitle>" markers are the assertion's own
    // scaffolding, so the bound is checked on the painted text alone.
    const preview = /<muted>(.*)<\/muted>/u.exec(header)?.[1] ?? ''
    expect(preview.length).toBeLessThanOrEqual(COLLAPSED_ARGS_CHARS)
  })

  it('names a non-object argument as `args`', () => {
    // A tool can be called with a bare string; pi does the same.
    expect(formatToolHeader('tool', 'plain string', paint)).toContain('args="plain string"')
  })

  it('renders the expanded form as key: value lines', () => {
    // Expanded, pi puts each argument on its own line below the name.
    const header = formatToolHeader('bash', { command: 'ls' }, paint, true)
    const lines = header.split('\n')
    expect(lines[0]).toBe('<toolTitle>bash</toolTitle>')
    expect(lines[1]).toContain('command: ls')
  })

  it('keeps an empty object as a bare name', () => {
    expect(formatToolHeader('bash', {}, paint)).toBe('<toolTitle>bash</toolTitle>')
  })
})

describe('toolOutputLines', () => {
  const output = (count: number): string => Array.from({ length: count }, (_, i) => `l${i}`).join('\n')

  it('returns the whole body when expanded', () => {
    expect(toolOutputLines(output(30), true, paint)).toHaveLength(30)
  })

  it('keeps a folded body to the preview plus one marker line', () => {
    // pi's `FALLBACK_PREVIEW_LINES` is 10.
    const lines = toolOutputLines(output(30), false, paint)
    expect(lines).toHaveLength(11)
    expect(lines.at(-1)).toContain('20 more lines')
  })

  it('does not add a marker when nothing is hidden', () => {
    expect(toolOutputLines(output(3), false, paint)).toHaveLength(3)
    expect(toolOutputLines(output(3), false, paint).join('')).not.toContain('more lines')
  })

  it('names the key that opens the rest', () => {
    // pi: `... (N more lines, ctrl+o to expand)`.
    expect(toolOutputLines(output(30), false, paint).at(-1)).toContain('ctrl+o')
  })

  it('is empty for an empty body', () => {
    expect(toolOutputLines('', false, paint)).toEqual([])
  })
})

describe('text helpers (tool-independent)', () => {
  it('collapses text to one bounded line', () => {
    expect(foldText('a\nb   c')).toBe('a b c')
    expect(foldText('x'.repeat(FOLDED_CHARS + 10))).toHaveLength(FOLDED_CHARS + 1)
    expect(foldText('x'.repeat(FOLDED_CHARS + 10)).endsWith('…')).toBe(true)
  })

  it('reads the first and last line of a block', () => {
    expect(firstLine('one\ntwo')).toBe('one')
    expect(latestLine('one\ntwo')).toBe('two')
  })
})
