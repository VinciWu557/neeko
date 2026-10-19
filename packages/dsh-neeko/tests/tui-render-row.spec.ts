import { describe, expect, it } from 'vitest'
import { Container, Text } from '@earendil-works/pi-tui'
import type { TranscriptRow, TranscriptState } from '../src/tui/transcript.ts'
import { cardBackgroundToken, isExpanded, renderOptionsFor, renderRow } from '../src/tui/transcript-view.ts'
import type { RenderContext } from '../src/tui/transcript-view.ts'
import { Theme, findBuiltin, resolveTheme } from '../src/tui/theme.ts'
import { TuiApp } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'
import { foldText } from '../src/tui/tool-present.ts'

/**
 * Row → component rendering.
 *
 * The interesting behaviour is the **tool card**: it must name the tool and what
 * it acted on, carry a status pill, and only dump the result body when expanded.
 * Folding is what keeps a long session readable, so it is pinned here.
 */

/** Render a component tree to plain text, so assertions read the layout. */
function flat(component: { render(width: number): string[] }, width = 100): string {
  return component.render(width)
    .join('\n')
    // pi-tui emits fake-cursor markers and color escapes; strip both.
    .replace(/\x1b_pi:[^\\]*\\/gu, '')
    .replace(/\x1b\[[0-9;]*m/gu, '')
}

const tool = (over: Partial<Extract<TranscriptRow, { kind: 'tool' }>> = {}): TranscriptRow => ({
  kind: 'tool',
  taskId: 'c1',
  name: 'read',
  args: { path: '/work/src/a.ts' },
  status: 'success',
  result: 'line one\nline two',
  turn: 1,
  images: [],
  ...over,
})

/** Narrow to a component that accepts mouse events. */
function clickable(component: unknown): { handleMouse?(e: unknown): unknown } {
  return component as { handleMouse?(e: unknown): unknown }
}

const assistant = (over: Partial<Extract<TranscriptRow, { kind: 'assistant' }>> = {}): TranscriptRow => ({
  kind: 'assistant',
  turn: 1,
  step: 1,
  attemptId: 'a1',
  text: 'answer',
  thinking: '',
  done: true,
  ...over,
})

describe('renderRow — tool cards', () => {
  it('names the tool, its subject and its status on one header line', () => {
    const text = flat(renderRow(tool(), undefined, undefined, { cwd: '/work' }))
    expect(text).toContain('📖')
    expect(text).toContain('Read')
    // The path is relativized: the workspace root itself is noise.
    expect(text).toContain('src/a.ts')
    expect(text).not.toContain('/work/src/a.ts')
    expect(text).toContain('[ok]')
  })

  it('does not dump JSON arguments into the header', () => {
    // `{"path":"a.ts"}` is what the old renderer printed; a card shows the value.
    const text = flat(renderRow(tool(), undefined, undefined, { cwd: '/work' }))
    expect(text).not.toContain('{"path"')
  })

  it('reports failure and running distinctly', () => {
    expect(flat(renderRow(tool({ status: 'failed' })))).toContain('[error]')
    expect(flat(renderRow(tool({ status: 'running', result: undefined })))).toContain('[running]')
  })

  it('shows the result body when expanded', () => {
    const text = flat(renderRow(tool(), undefined, undefined, { boundary: 0 }))
    expect(text).toContain('line one')
    expect(text).toContain('line two')
  })

  it('folds to one bounded line when the turn is old', () => {
    const text = flat(renderRow(tool({ turn: 1 }), undefined, undefined, { boundary: 5 }))
    // Still identifiable …
    expect(text).toContain('Read')
    expect(text).toContain('[ok]')
    // … but it is exactly one line, which is the point of folding.
    expect(text.split('\n')).toHaveLength(1)
  })

  it('shows only the path for a folded file read', () => {
    // Quoting a slice of a file tells the reader less than the filename does.
    const text = flat(renderRow(
      tool({ name: 'read', args: { path: '/work/src/a.ts' }, result: 'x'.repeat(500), turn: 1 }),
      undefined, undefined, { boundary: 5, cwd: '/work' },
    ))
    expect(text).toContain('src/a.ts')
    expect(text).not.toContain('xxxx')
  })

  it('still previews a folded non-file tool', () => {
    const text = flat(renderRow(
      tool({ name: 'bash', args: { command: 'ls' }, result: 'drwxr-xr-x lots of output', turn: 1 }),
      undefined, undefined, { boundary: 9 },
    ))
    expect(text).toContain('drwxr-xr-x')
  })

  it('re-opens an old card the user expanded', () => {
    const row = tool({ turn: 1 })
    const text = flat(renderRow(row, undefined, undefined, { boundary: 5, expanded: new Set([row]) }))
    expect(text.split('\n').length).toBeGreaterThan(1)
    expect(text).toContain('line two')
  })

  it('shows the raw call while running', () => {
    const text = flat(renderRow(tool({ status: 'running', result: undefined }), undefined, undefined, { boundary: 0 }))
    expect(text).toContain('path')
  })
})

describe('renderRow — assistant', () => {
  it('renders the text as markdown', () => {
    const text = flat(renderRow(assistant({ text: '# Title' })))
    expect(text).toContain('Title')
  })

  it('does not put a glyph above the answer', () => {
    // The answer is the answer: a decorative icon above it just consumes a row.
    const text = flat(renderRow(assistant({ text: 'plain answer' })))
    expect(text.trim()).toBe('plain answer')
  })

  it('spins while the reasoning is still streaming', () => {
    const text = flat(renderRow(
      assistant({ text: '', thinking: 'a thought', done: false }),
      undefined, undefined, { spinnerFrame: '⠹' },
    ))
    expect(text).toContain('⠹')
  })

  it('stops spinning once the turn settles', () => {
    // A settled block is static text: a spinner would claim work is happening.
    const text = flat(renderRow(
      assistant({ thinking: 'a thought', done: true }),
      undefined, undefined, { spinnerFrame: '⠹' },
    ))
    expect(text).not.toContain('⠹')
    expect(text).not.toContain('⠋')
  })

  it('shows the newest reasoning line while streaming', () => {
    const text = flat(renderRow(
      assistant({ text: '', thinking: 'older\nnewest', done: false }),
      undefined, undefined, { spinnerFrame: '⠋' },
    ))
    expect(text).toContain('newest')
    expect(text).not.toContain('older')
  })

  it('keeps a live reasoning stream on one line even when expanded', () => {
    // Mid-stream the text is still being written: expanding it would push the
    // answer off screen and grow a wall the user cannot read anyway.
    const text = flat(renderRow(
      assistant({ text: '', thinking: 'full reasoning', done: false }),
      undefined, undefined, { boundary: 0, spinnerFrame: '⠹' },
    ))
    expect(text).toContain('⠹')
    // One line for the reasoning itself: the whole block is collapsed to a
    // preview, so no line of the source text survives as its own row.
    const reasoningLines = text.split('\n').filter((line) => line.includes('reasoning'))
    expect(reasoningLines).toHaveLength(1)
  })

  it('expands a settled reasoning block without a spinner', () => {
    const text = flat(renderRow(
      assistant({ thinking: 'full reasoning', done: true }),
      undefined, undefined, { boundary: 0, spinnerFrame: '⠹' },
    ))
    expect(text).toContain('full reasoning')
    expect(text).not.toContain('⠹')
  })

  it('folds settled reasoning to one line with the expand hint', () => {
    const text = flat(renderRow(
      assistant({ thinking: 'first thought\nsecond thought' }),
      undefined, undefined, { boundary: 9 },
    ))
    expect(text).toContain('first thought')
    expect(text).toContain('ctrl+o to expand')
    expect(text).not.toContain('second thought')
  })

  it('marks an empty settled turn instead of rendering nothing', () => {
    expect(flat(renderRow(assistant({ text: '', thinking: '' })))).toContain('(no content)')
  })
})

describe('renderRow — user', () => {
  it('prefixes the message with a prompt glyph', () => {
    expect(flat(renderRow({ kind: 'user', messageId: 'm1', content: 'hi', images: [] })).trim()).toBe('❯ hi')
  })
})

describe('isExpanded', () => {
  it('folds by default when no boundary is given', () => {
    // Folded is the default state; a row opens by click, not by omission.
    expect(isExpanded(tool({ turn: 1 }), {})).toBe(false)
  })

  it('expands everything for boundary: 0', () => {
    // The explicit "show the raw transcript" switch.
    expect(isExpanded(tool({ turn: 1 }), { boundary: 0 })).toBe(true)
  })

  it('folds rows before the boundary', () => {
    expect(isExpanded(tool({ turn: 1 }), { boundary: 2 })).toBe(false)
    expect(isExpanded(tool({ turn: 2 }), { boundary: 2 })).toBe(true)
  })

  it('lets an explicit expansion win', () => {
    const row = tool({ turn: 1 })
    expect(isExpanded(row, { boundary: 2, expanded: new Set([row]) })).toBe(true)
  })

  it('never folds a user row', () => {
    // A folded user message would hide what the conversation was asked to do.
    expect(isExpanded({ kind: 'user', messageId: 'm', content: 'x', images: [] }, { boundary: 99 })).toBe(true)
  })
})

describe('renderRow — images', () => {
  const image = { attachmentId: 'att-1', mediaType: 'image/png', name: 'shot.png' }

  it('names an image that has not been read yet', () => {
    // Rendering must never block on I/O, so an unresolved attachment shows a
    // labelled placeholder instead of nothing.
    const row = { kind: 'user' as const, messageId: 'm', content: 'look', images: [image] }
    const text = flat(renderRow(row, undefined, undefined, { expanded: new Set([row]) }))
    expect(text).toContain('shot.png')
    expect(text).toContain('image/png')
  })

  it('renders the image once its bytes are available', () => {
    const row = { kind: 'user' as const, messageId: 'm', content: 'look', images: [image] }
    const text = flat(renderRow(
      row, undefined, undefined,
      { expanded: new Set([row]), imageData: () => ({ base64: 'AAAA', mediaType: 'image/png' }) },
    ))
    // The placeholder is gone: a component was built from the bytes.
    expect(text).not.toContain('(image/png)')
  })

  it('shows images attached to a tool result', () => {
    const text = flat(renderRow(
      tool({ images: [image] }),
      undefined, undefined, { boundary: 0 },
    ))
    expect(text).toContain('shot.png')
  })

  it('keeps the caption above the image', () => {
    const row = { kind: 'user' as const, messageId: 'm', content: 'look', images: [image] }
    const text = flat(renderRow(row, undefined, undefined, { expanded: new Set([row]) }))
    expect(text.indexOf('look')).toBeLessThan(text.indexOf('shot.png'))
  })
})

describe('visual separation', () => {
  it('fills a tool card with a background band', () => {
    // Without a band a card is indistinguishable from prose.
    const bg = (text: string): string => `<bg>${text}</bg>`
    const text = flat(renderRow(tool(), undefined, undefined, {
      boundary: 0,
      cardBackground: () => bg,
    }))
    expect(text).toContain('<bg>')
  })

  it('asks for a band matching the status', () => {
    // The colour must say pending / done / failed before any word is read.
    const asked: string[] = []
    renderRow(tool({ status: 'failed' }), undefined, undefined, {
      cardBackground: (status) => { asked.push(status); return undefined },
    })
    expect(asked).toEqual(['failed'])
  })

  it('renders without a band when the owner supplies none', () => {
    const text = flat(renderRow(tool(), undefined, undefined, { boundary: 0 }))
    expect(text).toContain('Read')
  })

  it('gives reasoning its own band so it is not the answer', () => {
    const bg = (text: string): string => `<think>${text}</think>`
    const text = flat(renderRow(
      assistant({ thinking: 'a thought' }),
      undefined, undefined, { thinkingBackground: bg },
    ))
    expect(text).toContain('<think>')
    // The answer itself is never inside the reasoning band.
    expect(text.indexOf('<think>')).toBeLessThan(text.indexOf('</think>'))
  })

  it('keeps the answer outside the reasoning band', () => {
    const bg = (text: string): string => `<think>${text}</think>`
    const text = flat(renderRow(
      assistant({ thinking: 'thought', text: 'ANSWER' }),
      undefined, undefined, { thinkingBackground: bg },
    ))
    const close = text.indexOf('</think>')
    expect(text.indexOf('ANSWER')).toBeGreaterThan(close)
  })
})

describe('click to expand', () => {
  const click = (): { type: 'click'; button: 'left'; x: number; y: number; screenX: number; screenY: number; width: number; height: number; shift: boolean; alt: boolean; ctrl: boolean } => ({
    type: 'click', button: 'left', x: 3, y: 0, screenX: 3, screenY: 0,
    width: 80, height: 1, shift: false, alt: false, ctrl: false,
  })

  it('reports a click on a tool card to the owner', () => {
    const clicked: TranscriptRow[] = []
    const row = tool({ turn: 1 })
    const component = renderRow(row, undefined, undefined, {
      boundary: 5,
      onToggle: (target) => { clicked.push(target) },
    })
    clickable(component).handleMouse?.(click())
    expect(clicked).toEqual([row])
  })

  it('ignores a click when no handler is wired', () => {
    // Without an owner there is nothing to toggle; the card must not crash.
    const component = renderRow(tool(), undefined, undefined, { boundary: 5 })
    expect(clickable(component).handleMouse?.(click())).toBeUndefined()
  })

  it('ignores a wheel event on a card', () => {
    const clicked: TranscriptRow[] = []
    const component = renderRow(tool(), undefined, undefined, {
      boundary: 5,
      onToggle: (target) => { clicked.push(target) },
    })
    clickable(component).handleMouse?.({ ...click(), button: 'none', wheelDelta: -3 })
    expect(clicked).toEqual([])
  })

  it('makes a user row clickable too', () => {
    // Every row folds, so every row must be openable by a click.
    const clicked: TranscriptRow[] = []
    const component = renderRow({ kind: 'user', messageId: 'm', content: 'hi' }, undefined, undefined, {
      onToggle: (target) => { clicked.push(target) },
    })
    clickable(component).handleMouse?.(click())
    expect(clicked).toHaveLength(1)
  })
})

describe('renderRow — component shape', () => {
  it('returns a container so a card can hold several lines', () => {
    expect(renderRow(tool())).toBeInstanceOf(Container)
    expect(renderRow({ kind: 'user', messageId: 'm', content: 'x', images: [] })).toBeInstanceOf(Text)
  })
})

describe('spinner frame contract', () => {
  /**
   * The owner advances one frame per repaint, so a single frame must be
   * consistent across rows. A callback that computed the glyph itself would let
   * two rows disagree inside one paint.
   */
  it('uses the frame it was given', () => {
    const text = flat(renderRow(
      assistant({ text: '', thinking: 'x', done: false }),
      undefined, undefined, { spinnerFrame: '⠼' },
    ))
    expect(text).toContain('⠼')
  })

  it('falls back to a static glyph when no frame is supplied', () => {
    // Tests and one-off renders pass no frame; the row must still render.
    expect(flat(renderRow(assistant({ text: '', thinking: 'x', done: false })))).toContain('🐳')
  })
})

describe('fold is the default the app renders with', () => {
  /**
   * The renderer defaults to folded, but the *app* must pass the state too —
   * this is the seam where a missing option silently re-expanded everything.
   */
  it('renders a long prompt folded through the app seam', () => {
    const app = new TuiApp({
      getSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp/w',
      getSessionId: () => 's',
      onSubmit: () => {},
      onExit: () => {},
      version: '0',
      statusFacts: () => ({ cwd: '/tmp/w' }),
      modelPicker: async () => ({ models: [], current: '' }),
      selectModel: () => {},
      terminal: new FakeTerminal(),
    })
    const long = 'This is a very long user prompt that definitely exceeds twenty characters by a lot'
    const state: TranscriptState = { attachTime: 0, rows: [{ kind: 'user', messageId: 'u', content: long }] }
    app.mountTranscript(state)
    const out = (app as unknown as { messages: { render(w: number): string[] } }).messages
      .render(80).join('\n').replace(/\x1b\[[0-9;]*m/gu, '').replace(/\x1b_pi:[^\\]*\\/gu, '')
    const line = out.split('\n').find((candidate) => candidate.includes('❯'))?.trim() ?? ''
    expect(line).toContain('…')
    expect(line.length).toBeLessThan(long.length)
  })
})

describe('renderOptionsFor', () => {
  /**
   * The options are a pure projection of theme + owner view state. Keeping that
   * construction here (not in the app) means a colour decision never sits in the
   * orchestration layer.
   */
  const theme = resolveTheme(findBuiltin('dark')!)
  const context = (over: Partial<RenderContext> = {}): RenderContext => ({
    theme,
    expanded: new Set<TranscriptRow>(),
    cwd: '/w',
    spinnerFrame: '⠋',
    imageData: () => undefined,
    onToggle: () => {},
    ...over,
  })

  it('derives a background band per status from the theme tokens', () => {
    const options = renderOptionsFor(context())
    const running = options.cardBackground?.('running')
    const success = options.cardBackground?.('success')
    const failed = options.cardBackground?.('failed')
    expect(running?.('x')).toContain(theme.ansiOf('toolPendingBg').replace('38;', '48;'))
    expect(success?.('x')).toContain(theme.ansiOf('toolSuccessBg').replace('38;', '48;'))
    expect(failed?.('x')).toContain(theme.ansiOf('toolErrorBg').replace('38;', '48;'))
  })

  it('omits a band the theme does not define', () => {
    // A sparse pi theme must render, not throw.
    const sparse = new Theme('raw', { name: 'raw', colors: { accent: 'okhsl(83 88% 67%)' } })
    const options = renderOptionsFor(context({ theme: sparse }))
    expect(options.cardBackground?.('success')).toBeUndefined()
    expect(options.thinkingBackground).toBeUndefined()
  })

  it('carries the owner view state straight through', () => {
    const expanded = new Set<TranscriptRow>()
    const options = renderOptionsFor(context({ expanded, cwd: '/repo', spinnerFrame: '⠼' }))
    expect(options.expanded).toBe(expanded)
    expect(options.cwd).toBe('/repo')
    expect(options.spinnerFrame).toBe('⠼')
  })
})

describe('cardBackgroundToken', () => {
  it('maps each status to its own band', () => {
    expect(cardBackgroundToken('running')).toBe('toolPendingBg')
    expect(cardBackgroundToken('success')).toBe('toolSuccessBg')
    expect(cardBackgroundToken('failed')).toBe('toolErrorBg')
  })
})
