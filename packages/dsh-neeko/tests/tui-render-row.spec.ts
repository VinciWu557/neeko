import { describe, expect, it } from 'vitest'
import { Container, Text } from '@earendil-works/pi-tui'
import type { TranscriptRow, TranscriptState } from '../src/tui/transcript.ts'
import { cardBackgroundToken, isExpanded, renderOptionsFor, renderRow } from '../src/tui/transcript-view.ts'
import type { RenderContext } from '../src/tui/transcript-view.ts'
import { Theme, findBuiltin, resolveTheme } from '../src/tui/theme.ts'
import { TuiApp } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'
import { foldText } from '../src/tui/tool-present.ts'
import { TranscriptFold } from '../src/tui/fold.ts'
import { stripAnsi } from './support/ansi.ts'

/**
 * Row → component rendering.
 *
 * The interesting behaviour is the **tool card**: it must name the tool and what
 * it acted on, carry a status pill, and only dump the result body when expanded.
 * Folding is what keeps a long session readable, so it is pinned here.
 */

/** Render a component tree to plain text, so assertions read the layout. */
function flat(component: { render(width: number): string[] }, width = 100): string {
  return stripAnsi(component.render(width).join('\n'))
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

/** A fold with every row expanded (`ctrl+o` pressed once). */
function expandedAll(): TranscriptFold {
  const fold = new TranscriptFold()
  fold.toggleAll()
  return fold
}

/** A fold where only the given rows are open, i.e. after a click. */
function expandedRows(...rows: readonly TranscriptRow[]): TranscriptFold {
  const fold = new TranscriptFold()
  for (const row of rows) fold.toggle(row)
  return fold
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
  // pi's shape: `bold(name)` then `key=value` arguments on one line. No emoji, no
  // derived summary, no status pill — the card's background carries the status.

  it('renders the tool name and its arguments on one line', () => {
    // Header only: the result body follows on its own lines.
    const text = flat(renderRow(tool({ result: undefined })))
    expect(text).toContain('read')
    expect(text).toContain('path="/work/src/a.ts"')
    expect(text.split('\n')).toHaveLength(1)
  })

  it('does not decorate the name with an emoji or a status pill', () => {
    // Three labels for one call is what the old variant table produced.
    const text = flat(renderRow(tool()))
    expect(text).not.toMatch(/[📖🔍🖥️📝✏️⚙️🛠️]/u)
    expect(text).not.toContain('[ok]')
  })

  it('carries the status in the background band instead of text', () => {
    const asked: string[] = []
    for (const status of ['running', 'success', 'failed'] as const) {
      renderRow(tool({ status }), undefined, undefined, {
        cardBackground: (value) => { asked.push(value); return undefined },
      })
    }
    expect(asked).toEqual(['running', 'success', 'failed'])
  })

  it('folds the body to a bounded preview plus a marker', () => {
    const result = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n')
    const text = flat(renderRow(tool({ name: 'bash', args: { command: 'ls' }, result })))
    expect(text.split('\n')).toHaveLength(1 + 11)
    expect(text).toContain('5 more lines')
    expect(text).toContain('ctrl+o to expand')
  })

  it('shows the whole body when expanded', () => {
    const result = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n')
    const text = flat(renderRow(tool({ name: 'bash', args: { command: 'ls' }, result }), undefined, undefined, {
      fold: expandedAll(),
    }))
    expect(text).toContain('line 14')
    expect(text).not.toContain('more lines')
  })

  it('puts each argument on its own line when expanded', () => {
    const text = flat(renderRow(tool({ result: 'body' }), undefined, undefined, { fold: expandedAll() }))
    expect(text).toContain('path: /work/src/a.ts')
  })

  it('adds no marker when the body fits the preview', () => {
    const text = flat(renderRow(tool({ name: 'bash', args: { command: 'ls' }, result: 'one\ntwo' })))
    expect(text).not.toContain('more lines')
  })

  it('renders without a band when the owner supplies none', () => {
    expect(flat(renderRow(tool(), undefined, undefined, {}))).toContain('read')
  })
})

describe('renderRow — theme capabilities', () => {
  /**
   * `bold` is an emphasis capability of the theme, exactly like `fg`.
   *
   * It used to travel as its own `RenderOptions.bold` field, threaded app →
   * context → options → header for a single call site. Both are things the theme
   * *provides*, so one parameter carries both — and a caller that supplies only
   * `fg` still gets a working (unemphasised) header.
   */
  it('uses the theme bold for the tool name when the theme provides it', () => {
    const text = flat(renderRow(
      tool({ result: undefined }),
      { fg: (_token, t) => t, bold: (t) => `**${t}**` },
      undefined,
      {},
    ))
    expect(text).toContain('**read**')
  })

  it('falls back to plain text when the theme has no bold', () => {
    const text = flat(renderRow(tool({ result: undefined }), { fg: (_t, text_) => text_ }))
    expect(text).toContain('read')
    expect(text).not.toContain('**')
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
      undefined, undefined, { fold: expandedAll(), spinnerFrame: '⠹' },
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
      undefined, undefined, { fold: expandedAll(), spinnerFrame: '⠹' },
    ))
    expect(text).toContain('full reasoning')
    expect(text).not.toContain('⠹')
  })

  it('folds settled reasoning to one line with the expand hint', () => {
    const text = flat(renderRow(
      assistant({ thinking: 'first thought\nsecond thought' }),
      undefined, undefined, {},
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
  it('folds by default', () => {
    // Folded is the default state; a row opens by click or `ctrl+o`.
    expect(isExpanded(tool({ turn: 1 }), {})).toBe(false)
  })

  it('expands every row while the global switch is on', () => {
    const fold = expandedAll()
    expect(isExpanded(tool({ turn: 1 }), { fold })).toBe(true)
    expect(isExpanded(tool({ turn: 9 }), { fold })).toBe(true)
  })

  it('folds a row the user clicked closed under the global switch', () => {
    const row = tool({ turn: 1 })
    const fold = expandedAll()
    fold.toggle(row)
    expect(isExpanded(row, { fold })).toBe(false)
    expect(isExpanded(tool({ turn: 2 }), { fold })).toBe(true)
  })

  it('expands a row the user clicked open', () => {
    const row = tool({ turn: 1 })
    expect(isExpanded(row, { fold: expandedRows(row) })).toBe(true)
  })

  it('folds a user row like every other row', () => {
    // Every row folds: a long pasted prompt would otherwise bury the answer.
    expect(isExpanded({ kind: 'user', messageId: 'm', content: 'x', images: [] }, {})).toBe(false)
  })
})

describe('renderRow — images', () => {
  const image = { attachmentId: 'att-1', mediaType: 'image/png', name: 'shot.png' }

  it('names an image that has not been read yet', () => {
    // Rendering must never block on I/O, so an unresolved attachment shows a
    // labelled placeholder instead of nothing.
    const row = { kind: 'user' as const, messageId: 'm', content: 'look', images: [image] }
    const text = flat(renderRow(row, undefined, undefined, { fold: expandedRows(row) }))
    expect(text).toContain('shot.png')
    expect(text).toContain('image/png')
  })

  it('renders the image once its bytes are available', () => {
    const row = { kind: 'user' as const, messageId: 'm', content: 'look', images: [image] }
    const text = flat(renderRow(
      row, undefined, undefined,
      { fold: expandedRows(row), imageData: () => ({ base64: 'AAAA', mediaType: 'image/png' }) },
    ))
    // The placeholder is gone: a component was built from the bytes.
    expect(text).not.toContain('(image/png)')
  })

  it('shows images attached to a tool result', () => {
    const text = flat(renderRow(
      tool({ images: [image] }),
      undefined, undefined, { fold: expandedAll() },
    ))
    expect(text).toContain('shot.png')
  })

  it('keeps the caption above the image', () => {
    const row = { kind: 'user' as const, messageId: 'm', content: 'look', images: [image] }
    const text = flat(renderRow(row, undefined, undefined, { fold: expandedRows(row) }))
    expect(text.indexOf('look')).toBeLessThan(text.indexOf('shot.png'))
  })
})

describe('visual separation', () => {
  it('fills a tool card with a background band', () => {
    // Without a band a card is indistinguishable from prose.
    const bg = (text: string): string => `<bg>${text}</bg>`
    const text = flat(renderRow(tool(), undefined, undefined, {
      fold: expandedAll(),
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
    const text = flat(renderRow(tool(), undefined, undefined, { fold: expandedAll() }))
    expect(text).toContain('read')
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
      onToggle: (target) => { clicked.push(target) },
    })
    clickable(component).handleMouse?.(click())
    expect(clicked).toEqual([row])
  })

  it('ignores a click when no handler is wired', () => {
    // Without an owner there is nothing to toggle; the card must not crash.
    const component = renderRow(tool())
    expect(clickable(component).handleMouse?.(click())).toBeUndefined()
  })

  it('ignores a wheel event on a card', () => {
    const clicked: TranscriptRow[] = []
    const component = renderRow(tool(), undefined, undefined, {
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
    const out = stripAnsi((app as unknown as { messages: { render(w: number): string[] } })
      .messages.render(80).join('\n'))
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
    fold: new TranscriptFold(),
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
    const fold = expandedAll()
    const options = renderOptionsFor(context({ fold, spinnerFrame: '⠼' }))
    expect(options.fold).toBe(fold)
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

describe('renderRow — model failures', () => {
  const failure = (over: Partial<Extract<TranscriptRow, { kind: 'failure' }>> = {}): TranscriptRow => ({
    kind: 'failure', turn: 2, text: 'Error: Invalid API key [AUTH_INVALID]', ...over,
  })

  it('prints the failure with an error marker', () => {
    const text = flat(renderRow(failure()))
    expect(text).toContain('Invalid API key')
    expect(text).toContain('AUTH_INVALID')
  })

  it('paints it with the error token', () => {
    // `flat()` strips ANSI, so assert the token through a marker painter (the
    // same trick the card-background cases use) rather than a real theme.
    const theme = { fg: (token: string, text: string): string => `<${token}>${text}` }
    const text = flat(renderRow(failure(), theme as never))
    expect(text).toContain('<error>')
  })

  it('stays visible when everything else is folded', () => {
    // Hiding the reason a reply did not arrive would return the screen to the
    // bug this row exists to fix.
    const row = failure()
    expect(isExpanded(row, { fold: new TranscriptFold() })).toBe(true)
    expect(isExpanded(row, {})).toBe(true)
  })

  it('renders a multi-line provider message without losing lines', () => {
    const text = flat(renderRow(failure({ text: 'Error: line one\nline two' })))
    expect(text).toContain('line one')
    expect(text).toContain('line two')
  })
})

describe('vertical rhythm', () => {
  /**
   * Reported from a real session: consecutive user rows had a blank line between
   * them (looking like a huge gap), and the reasoning block sat flush against the
   * answer so the two read as one paragraph.
   */
  it('gives a user row no vertical padding', () => {
    // `new Text(...)` defaults to paddingY = 1, which adds an empty line above
    // *and* below — two blank lines between adjacent rows.
    const text = flat(renderRow({ kind: 'user', messageId: 'm', content: 'hello', images: [] }))
    expect(text.split('\n')).toHaveLength(1)
  })

  it('separates a folded reasoning block from the answer by one blank line', () => {
    const text = flat(renderRow(
      assistant({ thinking: 'a thought', text: 'the answer', done: true }),
    ))
    const lines = text.split('\n')
    const thinking = lines.findIndex((line) => line.includes('a thought'))
    const answer = lines.findIndex((line) => line.includes('the answer'))
    expect(thinking).toBeGreaterThanOrEqual(0)
    expect(answer).toBe(thinking + 2)
    expect(lines[thinking + 1]?.trim()).toBe('')
  })

  it('opens every message with one blank line, reasoning or not', () => {
    // pi: `hasVisibleContent → contentContainer.addChild(new Spacer(1))`. The
    // blank line separates messages; padding each row internally is not the same
    // thing and was removed earlier for exactly that reason.
    const lines = renderRow(assistant({ thinking: '', text: 'just the answer' })).render(40)
      .map((line) => stripAnsi(line).trimEnd())
    expect(lines[0]).toBe('')
    expect(lines[1]?.trim()).toBe('just the answer')
  })
})

describe('left margin (pi outputPad)', () => {
  /**
   * pi keeps transcript content one column off the left edge: `outputPad`
   * (default 1, `settings-defaults.js`) is passed as `paddingX` to EVERY chat
   * component — assistant markdown, thinking, user message, tool output, errors.
   *
   * Ours was inconsistent: `Box(1, 0, bg)` gave tool cards and the reasoning band
   * a column, while the user row and the assistant markdown started at column 0.
   * So prose hugged the terminal edge and cards did not.
   */
  /**
   * The line that carries the row's content.
   *
   * @param component - the rendered row.
   * @param offset - rows to skip; an assistant message opens with a blank line.
   * @param width - render width.
   */
  const pad = (component: { render(w: number): string[] }, offset = 0, width = 60): string =>
    component.render(width)[offset] ?? ''

  it('indents a user row by one column', () => {
    const line = pad(renderRow({ kind: 'user', messageId: 'm', content: 'hi', images: [] }))
    expect(line.startsWith(' ❯')).toBe(true)
  })

  it('indents the assistant markdown by one column', () => {
    const line = pad(renderRow(assistant({ text: 'plain answer' })), 1)
    expect(line.startsWith(' plain answer')).toBe(true)
  })

  it('indents a folded reasoning line by one column', () => {
    const line = pad(renderRow(assistant({ thinking: 'a thought', text: 'x', done: true })), 1)
    expect(line.startsWith(' 🐳')).toBe(true)
  })

  it('indents a tool card by one column', () => {
    // The bolded name is the first thing on the line now, not an emoji.
    const line = pad(renderRow(tool({ name: 'bash', args: { command: 'ls' } })))
    expect(line.startsWith(' bash')).toBe(true)
  })

  it('indents a failure by one column', () => {
    const line = pad(renderRow({ kind: 'failure', turn: 1, text: 'Error: boom' }))
    expect(line.startsWith(' ✖')).toBe(true)
  })
})

describe('left margin — bands do not double-inset', () => {
  it('insets a reasoning line exactly once when it has a background band', () => {
    // The band supplies the column; the text inside it must not add another, or
    // reasoning would sit two columns in while the answer sits one.
    const bg = (text: string): string => text
    const bare = flat(renderRow(assistant({ thinking: 'a thought', text: 'x', done: true })))
    const banded = flat(renderRow(
      assistant({ thinking: 'a thought', text: 'x', done: true }),
      undefined, undefined, { thinkingBackground: bg },
    ))
    const indent = (line: string): number => line.length - line.trimStart().length
    expect(indent(banded.split('\n')[0] ?? '')).toBe(indent(bare.split('\n')[0] ?? ''))
  })

  it('insets a tool card exactly once with and without a band', () => {
    const bg = (text: string): string => text
    const indent = (line: string): number => line.length - line.trimStart().length
    // `Box(_, 1, bg)` pads the card vertically, so the header is not row 0.
    const contentLine = (component: { render(w: number): string[] }, width = 60): string =>
      component.render(width).find((line) => line.trim() !== '') ?? ''
    const bare = contentLine(renderRow(tool({ name: 'bash', args: { command: 'ls' } })))
    const banded = contentLine(renderRow(tool({ name: 'bash', args: { command: 'ls' } }), undefined, undefined, {
      cardBackground: () => bg,
    }))
    // A band carries its own paddingY, so compare the content's column instead
    // of the height: the band starts one row up.
    expect(indent(banded)).toBe(indent(bare))
    expect(indent(bare)).toBe(1)
  })
})
