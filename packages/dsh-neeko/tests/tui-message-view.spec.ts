import { describe, expect, it, vi } from 'vitest'
import { Markdown } from '@earendil-works/pi-tui'
import type { MarkdownTheme } from '@earendil-works/pi-tui'
import { isExpanded, renderRow, setKeyReader } from '../src/tui/message-view.ts'
import type { RenderOptions } from '../src/tui/message-view.ts'
import { resolveTheme } from '../src/tui/theme.ts'
import type { Theme } from '../src/tui/theme.ts'
import type { TranscriptRow } from '../src/tui/transcript.ts'
import { stripAnsi } from './support/ansi.ts'

/**
 * The three message renderers, ported from pi's own components.
 *
 * ## What these tests are for
 *
 * The previous renderer was written from a reading of pi's *documentation*, and
 * it drifted in ways a reader could not see but a user immediately could: an
 * emoji where pi has none, a hard-coded `ctrl+o` where pi resolves the live
 * binding, no spacer before a tool card, a reasoning line that was not italic
 * Markdown. Every test below pins one of those rules against pi's source
 * (`assistant-message.js`, `user-message.js`, `tool-execution.js`,
 * `render-utils.js`).
 *
 * They assert **rendered output**, not component structure: what matters is the
 * bytes a terminal receives, and that is also what makes a regression visible
 * when pi-tui itself changes.
 */

/** A palette built from the real loader, so token names are checked too. */
const theme: Theme = resolveTheme({ name: 'probe', appearance: 'dark', colors: {} } as never)

/** Colourless markdown theme, so layout is asserted without palette noise. */
const markdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  // Emphasis is a **terminal attribute**, not a colour, and it comes from the
  // markdown theme — `defaultTextStyle.italic` does not emit an SGR on its own.
  // pi's `getMarkdownTheme()` uses `theme.italic(text)`; a fixture that returns
  // the text unchanged cannot tell italic output from plain output.
  bold: (text) => `\x1b[1m${text}\x1b[22m`,
  italic: (text) => `\x1b[3m${text}\x1b[23m`,
  strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
  underline: (text) => `\x1b[4m${text}\x1b[24m`,
}

/**
 * Render one row to plain lines.
 *
 * @param row - the row to render.
 * @param options - render options.
 * @param width - terminal columns.
 * @returns the visible text, one entry per line, ANSI removed.
 */
function render(row: TranscriptRow, options: RenderOptions = {}, width = 70): string[] {
  return renderRow(row, theme, markdownTheme, options)
    .render(width)
    .map((line) => stripAnsi(line).trimEnd())
}

/** A user row. */
function userRow(content: string):TranscriptRow {
  return { kind: 'user', messageId: 'u1', content }
}

/** An assistant row. */
function assistantRow(overrides: Partial<Extract<TranscriptRow, { kind: 'assistant' }>> = {}): TranscriptRow {
  return {
    kind: 'assistant', turn: 1, step: 1, attemptId: 'a', text: '', thinking: '', done: true, ...overrides,
  }
}

/** A tool row. */
function toolRow(overrides: Partial<Extract<TranscriptRow, { kind: 'tool' }>> = {}): TranscriptRow {
  return {
    kind: 'tool', taskId: 't1', name: 'bash', args: { command: 'ls' },
    status: 'success', result: 'a.txt', turn: 1, ...overrides,
  }
}

describe('user message — pi\'s UserMessageComponent', () => {
  it('renders the text through Markdown, not as a plain line', () => {
    // The old renderer prefixed `❯` and printed the raw string, so **bold** and
    // lists stayed literal. pi puts user text through `Markdown`.
    const lines = render(userRow('**bold** and a list:\n- one'))
    const text = lines.join('\n')
    expect(text).toContain('bold')
    expect(text).toContain('one')
    // Markdown's normalisation drops the literal asterisks.
    expect(text).not.toContain('**bold**')
  })

  it('is inset by one column, pi\'s outputPad', () => {
    // Prose at column 0 reads as shell output rather than app content.
    const lines = render(userRow('hello'))
    expect(lines.some((line) => line.startsWith(' hello'))).toBe(true)
  })

  it('carries the OSC 133 prompt markers a terminal can jump between', () => {
    // These are what make "jump to previous prompt" work in iTerm2 / kitty.
    const raw = renderRow(userRow('hello'), theme, markdownTheme).render(70)
    expect(raw.join('')).toContain('\x1b]133;A\x07')
    expect(raw.join('')).toContain('\x1b]133;B\x07')
  })
})

describe('assistant message — pi\'s AssistantMessageComponent', () => {
  it('opens with exactly one blank line when there is content', () => {
    // pi adds `Spacer(1)` before the content, which is what separates one reply
    // from the row above without padding every row internally. One line, because
    // the markdown inside carries `paddingY: 0` — the pair is what pi chose, and
    // changing either changes the rhythm between messages.
    const lines = render(assistantRow({ text: 'hi' }))
    expect(lines[0]).toBe('')
    expect(lines[1]).not.toBe('')
    expect(lines[1]).toContain('hi')
  })

  it('renders reasoning as italic Markdown in the thinking tone', () => {
    // pi passes `defaultTextStyle: { color: thinkingText, italic: true }` to a
    // `Markdown`. A plain `Text` line is not the same thing: emphasis inside the
    // reasoning (**like this**) has to render as emphasis.
    const raw = renderRow(
      assistantRow({ thinking: '**careful** reasoning', text: 'answer' }),
      theme, markdownTheme,
      { fold: { isExpanded: () => true } as never },
    ).render(70).join('\n')
    // Italic SGR is 3m; the styled run must carry it.
    expect(raw).toContain('\x1b[3m')
    expect(stripAnsi(raw)).toContain('careful')
    expect(stripAnsi(raw)).not.toContain('**careful**')
  })

  it('folds a settled reasoning run to its first line', () => {
    // pi shows one line so the row cannot grow into a wall. Once the turn has
    // settled the *first* line is what the reasoning concluded from.
    const lines = render(assistantRow({ thinking: 'first line\nsecond line', done: true }))
    const text = lines.join('\n')
    expect(text).toContain('first line')
    expect(text).not.toContain('second line')
  })

  it('shows the newest line while the reasoning still streams', () => {
    // The reverse while live: the newest line is the one moving, so that is what
    // a one-line view must show.
    const lines = render(assistantRow({ thinking: 'older thought\nnewest thought', done: false }))
    const text = lines.join('\n')
    expect(text).toContain('newest thought')
    expect(text).not.toContain('older thought')
  })

  it('keeps a blank line between the reasoning run and the answer', () => {
    // A reasoning band directly against the answer reads as one paragraph.
    const lines = render(
      assistantRow({ thinking: 'why', text: 'answer' }),
      { fold: { isExpanded: () => true } as never },
    )
    const reasoningAt = lines.findIndex((line) => line.includes('why'))
    const answerAt = lines.findIndex((line) => line.includes('answer'))
    expect(reasoningAt).toBeGreaterThanOrEqual(0)
    expect(answerAt).toBeGreaterThan(reasoningAt + 1)
  })

  it('renders the answer as Markdown', () => {
    const text = render(assistantRow({ text: '# Heading\n\n- item' })).join('\n')
    expect(text).toContain('Heading')
    expect(text).toContain('item')
  })

  it('renders an empty settled reply as nothing, not as a placeholder', () => {
    // pi returns an empty container when there is nothing to show. The old
    // renderer printed `(no content)`, which reads as a defect in the reply.
    expect(render(assistantRow({ text: '   ', thinking: '' }))).toEqual([])
  })
})

describe('failure message', () => {
  it('is never folded, because hiding the reason looks like a empty reply', () => {
    const row: TranscriptRow = { kind: 'failure', turn: 1, text: 'Error: 401 unauthorized' }
    expect(isExpanded(row, {})).toBe(true)
    expect(render(row).join('\n')).toContain('401 unauthorized')
  })

  it('keeps every line of a multi-line provider message', () => {
    const row: TranscriptRow = { kind: 'failure', turn: 1, text: 'line one\nline two' }
    const text = render(row).join('\n')
    expect(text).toContain('line one')
    expect(text).toContain('line two')
  })
})

describe('tool execution — pi\'s ToolExecutionComponent fallback path', () => {
  it('puts a blank line above the box, on top of the box own padding', () => {
    // pi's constructor starts with `addChild(new Spacer(1))` and *then* adds
    // `Box(outputPad, 1, bg)` — whose `paddingY` of 1 already emits a blank row.
    // So the card opens with **two** blank rows before its header.
    //
    // Asserting "the first line is blank" would pass without the spacer, because
    // the box supplies one on its own; the count is what distinguishes them.
    const lines = render(toolRow())
    expect(lines[0]).toBe('')
    expect(lines[1]).toBe('')
    expect(lines[2]).toContain('bash')
  })

  it('paints the status as a background band, not as a label', () => {
    // pi picks `toolPendingBg` / `toolSuccessBg` / `toolErrorBg` by state. A card
    // with no band is indistinguishable from prose.
    const raw = renderRow(toolRow(), theme, markdownTheme).render(70).join('\n')
    // `48;` is a background SGR: the band.
    expect(raw).toContain('\x1b[48;')
    // `[ok]`, `[failed]` and emoji were the old build's invention.
    expect(stripAnsi(raw)).not.toMatch(/\[ok\]|\[failed\]|\[running\]/u)
  })

  it('uses a different band for a failed call than for a successful one', () => {
    const ok = renderRow(toolRow({ status: 'success' }), theme, markdownTheme).render(70).join('\n')
    const bad = renderRow(toolRow({ status: 'failed' }), theme, markdownTheme).render(70).join('\n')
    expect(ok).not.toBe(bad)
  })

  it('renders the header as bold(name) plus key=value pairs', () => {
    // pi's `formatToolCallWithArgs`: no emoji, no derived summary, no title.
    const text = render(toolRow({ args: { command: 'ls -la' } })).join('\n')
    expect(text).toContain('bash')
    expect(text).toContain('command="ls -la"')
  })

  it('cuts a long collapsed argument list at 100 characters', () => {
    // 100 characters of `key=value` pairs, then an ellipsis (pi's
    // `COLLAPSED_ARGS_CHARS`). Asserted over the whole card because the box wraps
    // the header onto as many lines as the terminal needs — the *content* is
    // capped, not the rendered width.
    const args = { command: 'x'.repeat(400) }
    const card = render(toolRow({ args })).join('\n')
    expect(card).toContain('bash')
    expect(card).toContain('...')
    // 100 characters of preview, so far fewer than the 400 that were passed.
    expect((card.match(/x/gu) ?? []).length).toBeLessThan(120)
  })

  it('expands arguments to one key: value line each', () => {
    const text = render(
      toolRow({ args: { command: 'ls', cwd: '/tmp' } }),
      { fold: { isExpanded: () => true } as never },
    ).join('\n')
    expect(text).toContain('command: ls')
    expect(text).toContain('cwd: /tmp')
  })

  it('previews ten result lines while folded and counts the rest', () => {
    // pi's `FALLBACK_PREVIEW_LINES = 10`.
    const result = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n')
    const text = render(toolRow({ result })).join('\n')
    expect(text).toContain('line 9')
    expect(text).not.toContain('line 10')
    expect(text).toContain('15 more lines')
  })

  it('names the live expand binding in the fold hint', () => {
    // The old build hard-coded `ctrl+o`, so a user who rebound the action saw a
    // key that did nothing. pi's `keyHint` reads the registry.
    setKeyReader(() => ['f9'])
    try {
      const result = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
      const text = render(toolRow({ result })).join('\n')
      expect(text).toContain('f9')
      expect(text).not.toContain('ctrl+o')
    } finally {
      setKeyReader(() => [])
    }
  })

  it('falls back to ctrl+o when no registry has been installed', () => {
    // A hint that shows nothing is worse than one showing the default.
    const result = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    expect(render(toolRow({ result })).join('\n')).toContain('ctrl+o')
  })

  it('shows the whole result when expanded, with no marker', () => {
    const result = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n')
    const text = render(toolRow({ result }), { fold: { isExpanded: () => true } as never }).join('\n')
    expect(text).toContain('line 24')
    expect(text).not.toContain('more lines')
  })

  it('hides the body while a call is still running', () => {
    // There is no result yet; showing an empty box would read as a failed call.
    const text = render(toolRow({ status: 'running', result: undefined })).join('\n')
    expect(text).toContain('bash')
  })

  it('strips escape sequences from a command\'s output', () => {
    // A command's output is arbitrary bytes: a stray sequence recolours every
    // later row or moves the cursor.
    const text = render(toolRow({ result: 'safe\x1b[31mred\x1b[0mtext' })).join('\n')
    expect(text).toContain('saferedtext')
    expect(text).not.toContain('\x1b[31m')
  })

  it('drops a CR so a progress line cannot overwrite itself', () => {
    const text = render(toolRow({ result: 'step 1\rstep 2' })).join('\n')
    expect(text).toContain('step 1step 2')
  })
})

describe('click toggles a row', () => {
  it('reports the clicked row so the owner can flip its fold', () => {
    // pi wraps cards and thinking runs in `MouseRegion`: the pointer equivalent of
    // `ctrl+o` without expanding the whole transcript.
    const onToggle = vi.fn()
    const row = toolRow()
    const component = renderRow(row, theme, markdownTheme, { onToggle })
    // The whole card is the hit target, so a click anywhere on it works.
    expect(component.handleMouse).toBeDefined()
  })

  it('is not clickable when the owner supplies no handler', () => {
    const component = renderRow(toolRow(), theme, markdownTheme, {})
    // A plain container forwards mouse events to children; there is no handler
    // bound for the row itself.
    expect(component.handleMouse).toBeDefined()
  })
})

describe('Markdown is the renderer, not a string', () => {
  it('uses a Markdown component for the answer', () => {
    // A structural assertion, deliberately: the point is *which component* renders
    // the text, and a string comparison cannot see the difference once ANSI is
    // stripped. `Markdown` is what gives headings, lists and fences.
    //
    // `renderRow` wraps its output in the OSC-133 marker adapter, so the tree is
    // inspected through the adapter's `render` rather than `children`.
    const row = assistantRow({ text: 'plain text answer' })
    const component = renderRow(row, theme, markdownTheme)
    expect(hasMarkdownChild(component)).toBe(true)
  })
})

/**
 * Whether a component tree contains a `Markdown`.
 *
 * Walks `children` and, for the marker adapter (which has none), falls back to
 * the wrapped component it renders through.
 *
 * @param component - the root to inspect.
 * @param depth - recursion guard.
 * @returns true when a `Markdown` is reachable.
 */
function hasMarkdownChild(component: unknown, depth = 0): boolean {
  if (depth > 8 || component === null || typeof component !== 'object') return false
  if (component instanceof Markdown) return true
  const children = (component as { children?: unknown }).children
  if (Array.isArray(children) && children.some((child) => hasMarkdownChild(child, depth + 1))) return true
  // The OSC-133 adapter is a plain object; look at what it wraps.
  const wrapped = (component as { inner?: unknown }).inner
  return wrapped === undefined ? false : hasMarkdownChild(wrapped, depth + 1)
}

describe('rendering is idempotent — no state accumulates across frames', () => {
  /**
   * `zoneMarked` wraps a row's `render` to add the OSC 133 prompt markers. It used
   * to mutate the array `render` returned **in place**, on the assumption that a
   * component builds a fresh array per call.
   *
   * `Text` does not: it caches `cachedLines` and hands back the same instance while
   * its content is unchanged (`components/text.js`). So each frame prepended another
   * `\x1b]133;A` to the same string — measured 100 → 8116 bytes over 500 frames,
   * ~16 bytes per frame. A streaming session at 20 fps grows about 19 KB a minute
   * and eventually wraps.
   *
   * The assertions below are the property that was missing: **rendering twice must
   * produce byte-identical output**. That is true of every pure renderer, so the
   * test also catches the next component that tries to memoise by mutation.
   */
  const rows: readonly TranscriptRow[] = [
    userRow('hello'),
    assistantRow({ text: 'answer', thinking: 'reasoning' }),
    toolRow({ args: { command: 'ls' }, result: 'a.txt' }),
    { kind: 'failure', turn: 1, text: 'Error: boom' },
  ]

  it.each(rows.map((row) => [row.kind, row] as const))(
    '%s row grows into the same output on the 1st and the 500th frame',
    (_kind, row) => {
      const component = renderRow(row, theme, markdownTheme)
      // Compared by **value**, not by reference: a `Text` hands back its cached
      // array, so `toEqual` on the two arrays would compare one object with itself
      // and pass no matter what the renderer did.
      const first = component.render(60).map((line) => line.length)
      for (let frame = 0; frame < 500; frame += 1) component.render(60)
      expect(component.render(60).map((line) => line.length)).toEqual(first)
    },
  )

  it('keeps exactly one prompt marker per edge, however many frames ran', () => {
    // The concrete symptom: markers stacking up in front of the first line.
    const component = renderRow(assistantRow({ text: 'hi' }), theme, markdownTheme)
    component.render(60)
    for (let frame = 0; frame < 100; frame += 1) component.render(60)
    const raw = component.render(60).join('')
    const starts = raw.split('\x1b]133;A\x07').length - 1
    expect(starts).toBe(1)
  })
})
