/**
 * The three message components, transcribed from pi's own implementations.
 *
 * ## Why transcribed rather than imported
 *
 * pi's `AssistantMessageComponent`, `UserMessageComponent` and
 * `ToolExecutionComponent` live in `@earendil-works/pi-coding-agent`, a complete
 * CLI application (~20 MB of `dist`, 22 direct dependencies including a QuickJS
 * sandbox and an image transcoder). This package depends on `pi-tui` only, and
 * adding the CLI to reach fifteen components would triple a library whose whole
 * point is to be small.
 *
 * So the *behaviour* is ported and the dependency is not. Every rule below is
 * pi's, with the source named, because the point is identical output — the
 * previous renderer was written from a reading of pi's docs rather than its code
 * and had drifted in a dozen visible ways (an emoji thinking marker, a hard-coded
 * `ctrl+o`, no spacer before a tool card).
 *
 * ## What is deliberately not ported
 *
 * - **Per-tool renderers** (`renderCall` / `renderResult` / `renderShell`). pi
 *   resolves those from a tool definition registry it owns. This build has no
 *   registry, so every tool takes pi's own generic fallback path — which is what
 *   pi itself does for a tool with no renderer.
 * - **Extension markdown transformers.** No extension system here; the hook is a
 *   no-op rather than a half-wired parameter.
 * - **Image conversion** (`ensurePngTranscoder`). `pi-tui`'s `Image` already
 *   negotiates the terminal protocol and falls back to a placeholder.
 *
 * @module dsh-neeko/tui/message-view
 */

import {
  Box,
  Container,
  Image,
  Markdown,
  MouseRegion,
  Spacer,
  Text,
  stripTerminalSequences,
} from '@earendil-works/pi-tui'
import type { Component, DefaultTextStyle, MarkdownTheme } from '@earendil-works/pi-tui'
import type { Theme, ThemeToken } from './theme.ts'
import type { RowImage, TranscriptRow } from './transcript.ts'
import type { FoldView } from './fold.ts'

/**
 * Columns of left inset for every transcript row.
 *
 * pi's `outputPad` (`settings-defaults.js` → `outputPad: 1`), passed as
 * `paddingX` to every chat component — assistant markdown, thinking, user
 * message, tool output. Prose starting at column 0 reads as if it were still
 * shell output.
 */
const OUTPUT_PAD = 1

/**
 * Lines of a tool result shown while folded.
 *
 * pi's `FALLBACK_PREVIEW_LINES` (`tool-execution.js`). Ten is enough to see what
 * a command did and short enough that a long build log does not bury the
 * conversation.
 */
const FALLBACK_PREVIEW_LINES = 10

/** Characters of collapsed tool arguments shown on the header line. */
const COLLAPSED_ARGS_CHARS = 100

/**
 * Search-result markers pi's own chat entries carry.
 *
 * Transcribed because they are cheap and they are the difference between a
 * transcript a terminal can search natively and one it cannot: OSC 133 marks the
 * start and end of a command's output, which is what makes "jump to previous
 * prompt" work in iTerm2 / kitty / WezTerm.
 */
const OSC133_ZONE_START = '\x1b]133;A\x07'
const OSC133_ZONE_END = '\x1b]133;B\x07'
const OSC133_ZONE_FINAL = '\x1b]133;C\x07'

/**
 * Paint one theme token, or leave the text alone.
 *
 * Optional on purpose: a test that only asserts layout should not have to build a
 * palette, and a theme that omits a token must not throw during a repaint.
 */
type Paint = (token: ThemeToken, text: string) => string

/** Wrap text in a note that this theme cannot paint a token. */
const plainPaint: Paint = (_token, text) => text

/**
 * Read a theme's painter, tolerating a theme with holes.
 *
 * `Theme.fg` throws for a token it cannot paint, which is right for a
 * programming error but wrong here: a stock pi theme legitimately leaves some of
 * the 56 tokens to the fallback chain, and a user theme may omit more.
 *
 * @param theme - the theme to read, or `undefined` for plain text.
 * @returns a painter that never throws.
 */
function painterOf(theme: Theme | undefined): Paint {
  if (theme === undefined) return plainPaint
  return (token, text) => (theme.has(token) ? theme.fg(token, text) : text)
}

/** Background painter for the same reason as {@linkcode painterOf}. */
function backgroundOf(theme: Theme | undefined): (token: ThemeToken, text: string) => string {
  if (theme === undefined) return (_token, text) => text
  return (token, text) => (theme.has(token) ? theme.bg(token, text) : text)
}

/**
 * How one row renders.
 *
 * A projection of the owner's view state, so the renderers stay pure functions of
 * (row, options).
 */
export interface RenderOptions {
  /** Fold state; absent means everything folded (the default a fresh view has). */
  readonly fold?: FoldView | undefined
  /** Called when a tool card or a message band is clicked. */
  readonly onToggle?: ((row: TranscriptRow) => void) | undefined
  /** Resolved image bytes, or `undefined` while still being read. */
  readonly imageData?: ((image: RowImage) => { base64: string; mediaType: string } | undefined) | undefined
}

/**
 * Whether a row renders its full body.
 *
 * A failure is never folded: hiding the reason a reply did not arrive makes a
 * failed turn look like a successful empty one.
 *
 * @param row - the row to test.
 * @param options - fold state.
 * @returns whether the body is expanded.
 */
export function isExpanded(row: TranscriptRow, options: RenderOptions): boolean {
  if (row.kind === 'failure') return true
  return options.fold?.isExpanded(row) ?? false
}

/**
 * Render one row.
 *
 * @param row - the transcript row.
 * @param theme - the active palette, or `undefined` for plain text (tests).
 * @param markdownTheme - markdown styling; pi's `getMarkdownTheme()` shape.
 * @param options - fold state and owner callbacks.
 * @returns the component to mount.
 */
export function renderRow(
  row: TranscriptRow,
  theme: Theme | undefined,
  markdownTheme: MarkdownTheme,
  options: RenderOptions = {},
): Component {
  switch (row.kind) {
    case 'user':
      return userMessage(row, theme, markdownTheme, options)
    case 'assistant':
      return assistantMessage(row, theme, markdownTheme, options)
    case 'failure':
      return failureMessage(row, painterOf(theme))
    case 'tool':
      return toolExecution(row, theme, options)
  }
}

/**
 * A user message: one `Markdown` block on the user-message background.
 *
 * pi's `UserMessageComponent` (`user-message.js`). The Markdown pads and colours
 * its background itself — a `Box` around it would keep a second full-width copy
 * of every line for identical output.
 *
 * `lines[0]` gets an OSC 133 prompt-start marker and the last line closes it, so
 * the terminal can jump between prompts. Skipped while there is no content.
 *
 * @param row - the user row.
 * @param theme - the palette.
 * @param markdownTheme - markdown styling.
 * @param options - render options.
 * @returns the component.
 */
function userMessage(
  row: Extract<TranscriptRow, { kind: 'user' }>,
  theme: Theme | undefined,
  markdownTheme: MarkdownTheme,
  options: RenderOptions,
): Component {
  const paint = backgroundOf(theme)
  const fg = painterOf(theme)
  const style: DefaultTextStyle = {
    color: (text) => fg('userMessageText', text),
    bgColor: (text) => paint('userMessageBg', text),
  }
  const block = new Container()
  block.addChild(new Markdown(row.content, OUTPUT_PAD, 1, markdownTheme, style, {
    // pi preserves the source list markers and escapes for user text: a user's
    // `1.` or `\-` is part of what they typed, not markup to normalise.
    preserveOrderedListMarkers: true,
    preserveBackslashEscapes: true,
  }))
  for (const image of row.images ?? []) block.addChild(imageBlock(image, theme, options))
  return clickable(zoneMarked(block), row, options)
}

/**
 * An assistant message: optional reasoning, then the answer.
 *
 * pi's `AssistantMessageComponent` (`assistant-message.js`). Three rules are
 * load-bearing and were all missing before:
 *
 * 1. **A leading blank line** when there is visible content, so one reply is
 *    separated from the previous row without padding each row internally.
 * 2. **Reasoning renders as Markdown, italic, in `thinkingText`** — not as a
 *    plain line with a glyph. A live stream is trimmed to its first line so the
 *    row cannot grow into a wall that pushes the answer off screen.
 * 3. **A blank line between the reasoning run and the answer**, because a
 *    thinking band directly against the answer reads as one paragraph.
 *
 * @param row - the assistant row.
 * @param theme - the palette.
 * @param markdownTheme - markdown styling.
 * @param options - render options.
 * @returns the component.
 */
function assistantMessage(
  row: Extract<TranscriptRow, { kind: 'assistant' }>,
  theme: Theme | undefined,
  markdownTheme: MarkdownTheme,
  options: RenderOptions,
): Component {
  const fg = painterOf(theme)
  const card = new Container()
  const hasText = row.text.trim() !== ''
  const hasThinking = row.thinking.trim() !== ''
  if (!hasText && !hasThinking) return card
  card.addChild(new Spacer(1))

  if (hasThinking) {
    const expanded = row.done && isExpanded(row, options)
    if (expanded) {
      card.addChild(new Markdown(row.thinking.trim(), OUTPUT_PAD, 0, markdownTheme, {
        color: (text) => fg('thinkingText', text),
        italic: true,
      }))
    } else {
      // Folded: pi shows a *label*, not the content. It names what is hidden so
      // the row is still one line; expanding is the affordance.
      const summary = row.done ? firstLine(row.thinking) : latestLine(row.thinking)
      // No glyph. pi's folded reasoning row is the plain `hiddenThinkingLabel`
      // ("Thinking..."); the emoji this used to carry was this build's invention,
      // and animating it meant the row was rebuilt five times a second (the frame
      // was part of `rowSignature`) to redraw one character.
      card.addChild(new Text(fg('thinkingText', summary.trim()), OUTPUT_PAD, 0))
    }
    if (hasText) card.addChild(new Spacer(1))
  }

  if (hasText) {
    card.addChild(new Markdown(row.text.trim(), OUTPUT_PAD, 0, markdownTheme))
  }
  return zoneMarked(card)
}

/**
 * A failed turn: the reason, in the error tone.
 *
 * pi appends the same line after any partial content
 * (`assistant-message.js`, `stopReason === "error"`). Multi-line provider
 * messages stay readable because every line keeps the tone.
 *
 * @param row - the failure row.
 * @param paint - token painter.
 * @returns the component.
 */
function failureMessage(
  row: Extract<TranscriptRow, { kind: 'failure' }>,
  paint: Paint,
): Component {
  const lines = row.text.split('\n').map((line) => paint('error', line)).join('\n')
  return zoneMarked(new Text(`✖ ${lines}`, OUTPUT_PAD, 0))
}

/**
 * A tool call, rendered the way pi renders one with no per-tool renderer.
 *
 * pi's `ToolExecutionComponent` on its fallback path (`tool-execution.js`):
 *
 * - **A leading `Spacer(1)`**, so the card is separated from the row above. Its
 *   absence was visible: consecutive tool cards stacked flush against each other
 *   and against the assistant text.
 * - **`Box(outputPad, 1, bg)`** — one column of inset, one row of padding above
 *   and below, filled with the status colour. The band is what makes "this
 *   happened" visible at a glance; the status is the colour, not a label.
 * - **`formatToolCallWithArgs`** for the header, and the result previewed to
 *   {@linkcode FALLBACK_PREVIEW_LINES} lines with a key hint that names the
 *   **live** binding rather than a literal `ctrl+o`.
 *
 * @param row - the tool row.
 * @param theme - the palette.
 * @param options - fold state and owner callbacks.
 * @returns the component.
 */
function toolExecution(
  row: Extract<TranscriptRow, { kind: 'tool' }>,
  theme: Theme | undefined,
  options: RenderOptions,
): Component {
  const bg = backgroundOf(theme)
  const expanded = isExpanded(row, options)
  // pi picks the band by lifecycle state, not by result text.
  const band: ThemeToken = row.status === 'running'
    ? 'toolPendingBg'
    : row.status === 'failed' ? 'toolErrorBg' : 'toolSuccessBg'
  const box = new Box(OUTPUT_PAD, 1, (text: string) => bg(band, text))

  box.addChild(new Text(toolCallHeader(row.name, row.args, theme, expanded), 0, 0))
  if (row.status !== 'running' && row.result !== undefined) {
    const body = toolResultBody(row.result, expanded, theme)
    if (body !== undefined) box.addChild(body)
  }
  for (const image of row.images ?? []) box.addChild(imageBlock(image, theme, options))

  const card = new Container()
  card.addChild(new Spacer(1))
  card.addChild(box)
  return clickable(card, row, options)
}

/**
 * The tool call header, transcribed from pi's `formatToolCallWithArgs`.
 *
 * Collapsed: `bold(name)` then `key=value` pairs cut to
 * {@linkcode COLLAPSED_ARGS_CHARS}. Expanded: the name, then one `key: value`
 * line per argument with continuation lines indented.
 *
 * @param name - the tool name as the model called it.
 * @param args - parsed arguments.
 * @param theme - the palette; also supplies emphasis, since bold belongs to it.
 * @param expanded - show one argument per line.
 * @returns the header text, possibly multi-line.
 */
function toolCallHeader(name: string, args: unknown, theme: Theme | undefined, expanded: boolean): string {
  const fg = painterOf(theme)
  // `Theme.bold()` is the only implementation of emphasis (package rule: bold is a
  // terminal attribute the theme owns). A closed-over `x1b[1m` bypassed it, so a
  // theme that wanted different emphasis could not have it.
  const header = fg('toolTitle', theme?.bold(name) ?? name)
  if (args === null || args === undefined) return header
  const entries = typeof args === 'object' && !Array.isArray(args)
    ? Object.entries(args as Record<string, unknown>)
    : [['args', args] as const]
  if (entries.length === 0) return header

  if (expanded) {
    const lines = entries.map(([key, value]) => {
      const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value))
      // Tabs become spaces and continuation lines indent, so a multi-line
      // argument stays visibly one argument.
      return `  ${key}: ${text.replace(/\t/gu, '   ').replace(/\r/gu, '').split('\n').join('\n    ')}`
    })
    return `${header}\n${fg('muted', lines.join('\n'))}`
  }

  const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(' ')
  const preview = pairs.length > COLLAPSED_ARGS_CHARS
    ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...`
    : pairs
  return `${header} ${fg('muted', preview)}`
}

/**
 * The tool result body, transcribed from pi's `createResultFallback`.
 *
 * Folded, the first {@linkcode FALLBACK_PREVIEW_LINES} lines plus a marker naming
 * the key that opens the rest. Without the marker a truncated body reads as the
 * whole result.
 *
 * The hint resolves `app.tools.expand` through the **live** keybinding registry,
 * so a user who rebound the key sees their key. pi's `keyHint` does the same; the
 * hard-coded `ctrl+o` this replaces was wrong for exactly that reason.
 *
 * @param result - the result text.
 * @param expanded - show every line.
 * @param theme - the palette.
 * @returns the body component, or `undefined` when there is nothing to show.
 */
function toolResultBody(
  result: string,
  expanded: boolean,
  theme: Theme | undefined,
): Component | undefined {
  const output = stripTerminalControl(result)
  if (output === '') return undefined
  const fg = painterOf(theme)
  const lines = output.split('\n')
  const shown = expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES)
  const remaining = lines.length - shown.length
  let text = shown.map((line) => fg('toolOutput', line)).join('\n')
  if (remaining > 0) {
    text += `${fg('muted', `\n... (${remaining} more lines,`)} ${expandHint(theme)}${fg('muted', ')')}`
  }
  return new Text(text, 0, 0)
}

/**
 * A key hint naming the live `app.tools.expand` binding.
 *
 * pi's `keyHint(keybinding, description)`: the key in `dim`, the description in
 * `muted`. Reading the registry rather than a literal is what makes a rebind
 * visible in the UI.
 *
 * @param theme - the palette.
 * @returns the hint text.
 */
function expandHint(theme: Theme | undefined): string {
  const fg = painterOf(theme)
  const keys = liveExpandKeys()
  return `${fg('dim', keys)} ${fg('muted', 'to expand')}`
}

/**
 * The key currently bound to `app.tools.expand`, for display.
 *
 * `ctrl+o` is the fallback, not the answer: it is what the action is bound to
 * before any user override, and a hint that shows nothing is worse than a hint
 * that shows the default.
 *
 * @returns the key text.
 */
function liveExpandKeys(): string {
  const keys = getLiveKeys('app.tools.expand')
  return keys.length === 0 ? 'ctrl+o' : keys.join('/')
}

/**
 * Read one action's keys from the installed registry.
 *
 * Injected through a module-level seam rather than imported so this file does not
 * depend on pi-tui's keybinding module: the renderer stays a pure function of its
 * arguments, and a test can set the keys without installing a registry.
 *
 * @param action - the action id.
 * @returns the bound keys, or `[]` when unknown.
 */
let keyReader: (action: string) => readonly string[] = () => []
export function setKeyReader(reader: (action: string) => readonly string[]): void {
  keyReader = reader
}

function getLiveKeys(action: string): readonly string[] {
  return keyReader(action)
}

/**
 * Strip terminal control sequences from tool output.
 *
 * pi does the same (`sanitizeBinaryOutput(stripAnsi(...))`): a command's output is
 * arbitrary bytes, and letting a stray escape through corrupts the whole frame — a
 * mis-parsed sequence can recolour every subsequent row or move the cursor.
 *
 * `pi-tui` exports `stripTerminalSequences`, and it is used for the escape part.
 * It is **not** sufficient on its own: measured, it passes `\r` and C0 controls
 * through, and `\r` is the one that matters here — a progress line that uses it
 * (`step 1\rstep 2`) would otherwise overwrite the row it sits on and leave the
 * two states spliced together.
 *
 * @param text - raw output.
 * @returns the visible characters only.
 */
function stripTerminalControl(text: string): string {
  return stripTerminalSequences(text)
    // C0 controls except tab and newline; `\r` would overwrite earlier cells.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, '')
    .replace(/\r/gu, '')
}

/**
 * Add the OSC 133 zone markers around a component's rendered lines.
 *
 * A `Container` that owns the wrapped component rather than a bare object with a
 * `render`: the wrapper must stay transparent to the rest of the component
 * protocol. A bare object would drop `children`, and anything that walks the tree
 * — `invalidate()` propagation, hit-testing, a test asserting which component
 * renders the text — would silently stop seeing what is inside.
 *
 * The markers go on a **copy** of the rendered lines. That is not defensive
 * style: a `Text` caches its lines and returns the same array instance while its
 * content is unchanged, so writing into it prepended another marker to the same
 * string on every frame — measured 100 → 8116 bytes over 500 frames, ~16 bytes
 * per frame, which is ~19 KB a minute in a streaming session and eventually wraps.
 *
 * What this costs is array identity, and the note that used to live here claimed
 * that mattered. It does not: `row-cache.ts` keys its reuse on the **component**
 * (`WeakMap<TranscriptRow, …>`), never on the array a render returned.
 *
 * @param component - the component to mark.
 * @returns the marked component.
 */
function zoneMarked(component: Component): Component {
  // The marker is applied by *wrapping `render` on the component itself*, not by
  // wrapping the component in a new container.
  //
  // This matters for the repaint budget: `Text.render()` returns the same array
  // instance while its content is unchanged, and that identity is what
  // `row-cache.ts` measures. A container re-renders its children every call and
  // allocates a fresh array, so wrapping in one threw the child's cache away and
  // every repaint rebuilt the whole transcript (measured: 0 of 20 rows reused).
  //
  // `invalidate` is forwarded so the theme-change path still reaches the child.
  const original = component.render.bind(component)
  component.render = (width: number): string[] => {
    const lines = original(width)
    if (lines.length === 0) return lines
    // A copy, never the array the component handed back — see above.
    const marked = [...lines]
    marked[0] = OSC133_ZONE_START + (marked[0] ?? '')
    marked[marked.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + (marked[marked.length - 1] ?? '')
    return marked
  }
  return component
}

/**
 * Make a row's component respond to a left click by toggling its fold.
 *
 * pi wraps tool cards and thinking runs in `MouseRegion` for the same reason: the
 * pointer equivalent of `ctrl+o`, without expanding the whole transcript.
 *
 * @param component - the rendered row.
 * @param row - the row it came from.
 * @param options - carries the toggle callback.
 * @returns the clickable component.
 */
function clickable(component: Component, row: TranscriptRow, options: RenderOptions): Component {
  const onToggle = options.onToggle
  if (onToggle === undefined) return component
  return new MouseRegion(component, (event) => {
    if (event.button !== 'left' || event.type !== 'click') return undefined
    onToggle(row)
    return { handled: true }
  })
}

/**
 * One image block.
 *
 * `pi-tui`'s `Image` negotiates the terminal's graphics protocol itself (Kitty /
 * iTerm2) and falls back to a text placeholder, so this works over SSH and inside
 * multiplexers without a special case here.
 *
 * @param image - the attachment reference.
 * @param theme - the palette.
 * @param options - carries the byte cache.
 * @returns the image, or a labelled placeholder while bytes are missing.
 */
function imageBlock(
  image: RowImage,
  theme: Theme | undefined,
  options: RenderOptions,
): Component {
  const data = options.imageData?.(image)
  if (data === undefined) {
    const label = image.name ?? image.attachmentId
    return new Text(painterOf(theme)('dim', `  ${label} (${image.mediaType})`), OUTPUT_PAD, 0)
  }
  return new Image(data.base64, data.mediaType, {
    fallbackColor: (text: string) => painterOf(theme)('dim', text),
  }, {
    maxWidthCells: 60,
    maxHeightCells: 20,
    ...(image.name === undefined ? {} : { filename: image.name }),
  })
}

/** The first non-empty line of `text`, trimmed. */
function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '')
  return line?.trim() ?? ''
}

/** The last non-empty line of `text`, trimmed. */
function latestLine(text: string): string {
  const lines = text.split('\n').filter((candidate) => candidate.trim() !== '')
  return lines[lines.length - 1]?.trim() ?? ''
}
