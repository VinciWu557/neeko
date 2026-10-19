import { describe, expect, it } from 'vitest'
import {
  FOLDED_CHARS,
  classifyTool,
  foldText,
  isFileRead,
  deriveSummary,
  firstLine,
  latestLine,
  relativizeToCwd,
  toolEmoji,
  toolHeader,
} from '../src/tui/tool-present.ts'

/**
 * Tool presentation: name → variant → header/emoji, plus the fold boundary that
 * keeps long sessions readable.
 *
 * The variant table is the extension point: a newly registered tool must render
 * correctly with **no change here**, which is what the `others` cases pin.
 */

describe('classifyTool', () => {
  it('maps known tools to their variant', () => {
    expect(classifyTool('bash')).toBe('bash')
    expect(classifyTool('read')).toBe('read')
    expect(classifyTool('grep')).toBe('search')
    expect(classifyTool('write')).toBe('write')
    expect(classifyTool('edit')).toBe('edit')
    expect(classifyTool('run_code')).toBe('code')
  })

  it('sends an unknown tool to `others` instead of failing', () => {
    // A plugin registering a new tool must not need a UI change.
    expect(classifyTool('some_future_tool')).toBe('others')
    expect(classifyTool('')).toBe('others')
  })
})

describe('deriveSummary', () => {
  it('prefers the variant-specific key', () => {
    expect(deriveSummary('read', { path: '/a/b.ts', other: 'x' })).toBe('/a/b.ts')
    expect(deriveSummary('bash', { command: 'ls', description: 'List files' })).toBe('List files')
  })

  it('falls back to any string argument', () => {
    expect(deriveSummary('others', { whatever: 'shown' })).toBe('shown')
  })

  it('keeps only the first line', () => {
    // A multi-line command would otherwise flood the row.
    expect(deriveSummary('bash', { command: 'line1\nline2' })).toBe('line1')
  })

  it('accepts raw JSON as well as parsed arguments', () => {
    expect(deriveSummary('read', '{"path":"/x/y.ts"}')).toBe('/x/y.ts')
  })

  it('degrades to empty text on malformed input', () => {
    expect(deriveSummary('read', 'not json')).toBe('not json')
    expect(deriveSummary('read', undefined)).toBe('')
  })
})

describe('relativizeToCwd', () => {
  it('strips only the workspace root prefix', () => {
    expect(relativizeToCwd('/work/a/b.ts', '/work')).toBe('a/b.ts')
    expect(relativizeToCwd('/other/a.ts', '/work')).toBe('/other/a.ts')
  })

  it('tolerates a trailing separator on the root', () => {
    expect(relativizeToCwd('/work/a.ts', '/work/')).toBe('a.ts')
  })

  it('leaves text alone without a root', () => {
    expect(relativizeToCwd('/work/a.ts', undefined)).toBe('/work/a.ts')
  })
})

describe('toolEmoji', () => {
  it('gives each variant its own glyph', () => {
    expect(toolEmoji('read')).toBe('📖')
    expect(toolEmoji('grep')).toBe('🔍')
    expect(toolEmoji('bash')).toBe('🖥️')
  })

  it('marks a slash command as a control action', () => {
    expect(toolEmoji('/compact')).toBe('🎛️')
  })
})

describe('toolHeader', () => {
  it('titles a known tool from its variant', () => {
    const header = toolHeader('read', { path: '/w/a.ts' }, '/w')
    expect(header.title).toBe('Read')
    expect(header.summary).toBe('a.ts')
    expect(header.emoji).toBe('📖')
  })

  it('keeps the tool name for an unknown tool so the row stays identifiable', () => {
    const header = toolHeader('mystery_tool', { x: 'y' })
    expect(header.title).toBe('Tool call')
    expect(header.summary).toBe('mystery_tool · y')
  })

  it('uses a tool-owned title when one is registered', () => {
    expect(toolHeader('pwsh', { command: 'dir' }).title).toBe('Pwsh')
    expect(toolHeader('shell', { command: 'ls' }).title).toBe('Shell')
  })

  it('drops the slash from a command name', () => {
    expect(toolHeader('/compact', {}).title).toBe('compact')
  })
})

describe('foldText', () => {
  it('keeps a short text whole', () => {
    expect(foldText('short message')).toBe('short message')
  })

  it('cuts at twenty characters with an ellipsis', () => {
    // 20 chars is enough to tell two messages apart, and short enough that the
    // fold actually buys vertical space.
    const long = 'a'.repeat(100)
    const out = foldText(long)
    expect(out).toHaveLength(FOLDED_CHARS + 1)
    expect(out.endsWith('…')).toBe(true)
  })

  it('collapses newlines so a folded row stays one line', () => {
    expect(foldText('line one\nline two')).toBe('line one line two')
  })

  it('trims surrounding whitespace', () => {
    expect(foldText('  padded  ')).toBe('padded')
  })
})

describe('isFileRead', () => {
  it('recognises the file reader', () => {
    expect(isFileRead('read')).toBe(true)
    expect(isFileRead('web_fetch')).toBe(true)
  })

  it('does not treat a command as a file read', () => {
    expect(isFileRead('bash')).toBe(false)
    expect(isFileRead('grep')).toBe(false)
  })
})

describe('line helpers', () => {
  it('reads the first and last lines', () => {
    expect(firstLine('a\nb')).toBe('a')
    expect(latestLine('a\nb\n')).toBe('b')
    expect(firstLine('single')).toBe('single')
  })
})

