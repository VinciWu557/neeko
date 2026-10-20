/**
 * Row → pi-tui component for the transcript.
 *
 * Split from `transcript.ts` (which owns the row model and the event merge) so
 * that a **layout change never touches the event layer**, and the merge logic
 * stays testable without constructing components. `status-bar.ts` /
 * `status-controller.ts` follow the same split.
 *
 * The mapping is a pure function of a row plus its render options: no I/O, no
 * scheduling. Anything that needs to happen as a side effect (reading an image's
 * bytes, advancing a spinner) is an owner concern, injected through
 * {@linkcode RenderOptions}.
 *
 * @module dsh-neeko/tui/transcript-view
 */

import { Box, Container, Image, MouseRegion, Spacer, Text } from '@earendil-works/pi-tui'
import { Markdown } from '@earendil-works/pi-tui'
import type { Component, MarkdownTheme } from '@earendil-works/pi-tui'
import type { Theme, ThemeToken } from './theme.ts'
import type { RowImage, TranscriptRow } from './transcript.ts'
import type { FoldView } from './fold.ts'
import { firstLine, foldText, formatToolHeader, latestLine, toolOutputLines } from './tool-present.ts'
import { NO_BOLD } from './tool-present.ts'
import type { Bold, Paint } from './tool-present.ts'

/**
 * Characters of reasoning shown on a folded line.
 *
 * Longer than a user prompt's fold: a reasoning preview is the only hint of what
 * the model is thinking, so it earns more room than a message excerpt does.
 */
const THINKING_PREVIEW_CHARS = 120

/**
 * Columns of left inset for every transcript row.
 *
 * pi's `outputPad` (default 1 in `settings-defaults.js`) is passed as `paddingX`
 * to every chat component — assistant markdown, thinking, user message, tool
 * output, errors alike. Prose that starts at column 0 reads as if it were still
 * shell output; one column is enough to mark it as the app's own content.
 *
 * Kept uniform on purpose: the earlier build indented only the tool cards and the
 * reasoning band (via `Box(1, 0, bg)`), so cards floated while prose hugged the
 * terminal edge.
 */
const OUTPUT_PAD = 1

/** Colorless fallback used when the caller supplies no theme (tests). */
const PLAIN_MARKDOWN_THEME: MarkdownTheme = {
  heading: (text: string) => text,
  link: (text: string) => text,
  linkUrl: (text: string) => text,
  code: (text: string) => text,
  codeBlock: (text: string) => text,
  codeBlockBorder: (text: string) => text,
  quote: (text: string) => text,
  quoteBorder: (text: string) => text,
  hr: (text: string) => text,
  listBullet: (text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
  underline: (text: string) => text,
}

/**
 * What a row needs from a theme: colour tokens and emphasis.
 *
 * One parameter rather than two, because both are things the theme provides and
 * both reach the same renderers. `bold` is optional so a caller that only paints
 * colours (a test, a plain dump) still renders — unemphasised rather than broken.
 */
export interface ThemeCapabilities {
  /** Colour painting, exactly what the renderers take (see {@linkcode Paint}). */
  fg: Paint
  bold?: Bold | undefined
}

/**
 * How one row renders: whether it is expanded.
 */
export interface RenderOptions {
  /**
   * The fold state. Absent means "fully folded", which is the default a fresh
   * transcript has — a caller that forgets it hides content rather than dumping
   * a wall of it, and the `ctrl+o` hint on the row still tells the user how to
   * see the rest.
   */
  readonly fold?: FoldView | undefined
  /**
   * Called when a tool card is clicked.
   *
   * A card is the unit of "this happened"; clicking it re-opens its body, which
   * is the pointer equivalent of `ctrl+o` without having to expand the whole
   * transcript.
   */
  readonly onToggle?: ((row: TranscriptRow) => void) | undefined
  /**
   * Resolve one image id to base64 bytes, or `undefined` while it is still being
   * read.
   *
   * Synchronous by contract: a render must not do I/O. The owner pre-fetches
   * (see `TuiApp#prefetchImages`) and re-flushes once the bytes arrive, so a
   * missing entry renders a placeholder rather than blocking the frame.
   */
  readonly imageData?: ((image: RowImage) => { base64: string; mediaType: string } | undefined) | undefined
  /**
   * Fill a tool card's background by status.
   *
   * A card without a filled band is indistinguishable from prose — which is what
   * made every row read as one wall of text. The band is what makes "this
   * happened" visible at a glance.
   */
  readonly cardBackground?: ((status: 'running' | 'success' | 'failed') => ((text: string) => string) | undefined) | undefined
  /** Fill the reasoning band, so it is visibly not the answer. */
  readonly thinkingBackground?: ((text: string) => string) | undefined
  /**
   * The spinner glyph for *this* frame.
   *
   * A plain string, not a callback: the owner advances one frame per repaint, so
   * every reasoning row in a single frame shows the same glyph. A callback would
   * let rows within one frame disagree.
   */
  readonly spinnerFrame?: string | undefined
}

/** Whether one row renders its full body. */
export function isExpanded(row: TranscriptRow, options: RenderOptions): boolean {
  // A failure is never folded away: hiding the reason a reply did not arrive
  // would return the screen to the bug the row exists to fix.
  if (row.kind === 'failure') return true
  // Folded is the *default*: a clean screen is the goal, so a row opens only
  // when the user asks for it — `ctrl+o` for everything, a click for one row.
  return options.fold?.isExpanded(row) ?? false
}

/**
 * Render one transcript row as a pi-tui component.
 *
 * Assistant text stays a {@linkcode Markdown} block (headings, lists, code
 * fences all matter); everything else is line-oriented so the layout is exact.
 * A tool row is a **card**: a header naming the tool and its subject, a status
 * pill, and — only when expanded — the result body. Folding older turns is what
 * keeps a long session readable.
 *
 * @param row - the transcript row.
 * @param theme - token painter; absent means plain text (tests).
 * @param markdownTheme - Markdown styling; defaults to the colorless theme.
 * @param options - expansion state and workspace root.
 * @returns the component to mount in the messages container.
 */
export function renderRow(
  row: TranscriptRow,
  theme?: ThemeCapabilities,
  markdownTheme: MarkdownTheme = PLAIN_MARKDOWN_THEME,
  options: RenderOptions = {},
): Component {
  const paint = theme === undefined
    ? (_token: ThemeToken, text: string): string => text
    : (token: ThemeToken, text: string): string => theme.fg(token, text)
  switch (row.kind) {
    case 'user':
      return clickable(renderUser(row, paint, options), row, options)
    case 'assistant':
      return renderAssistant(row, paint, markdownTheme, options)
    case 'failure':
      return renderFailure(row, paint, options)
    case 'tool':
      return clickable(renderTool(row, paint, theme?.bold ?? NO_BOLD, options), row, options)
  }
}

/**
 * One model-response failure.
 *
 * Always visible (never folded away): a reply that did not arrive looks exactly
 * like a reply that did, so hiding the reason behind a fold would return the
 * screen to the bug this row exists to fix. pi appends the same line after the
 * partial content, in `fg("error")`.
 *
 * @param row - the failure row.
 * @param paint - token painter.
 * @param options - render options (kept for signature symmetry).
 */
function renderFailure(
  row: Extract<TranscriptRow, { kind: 'failure' }>,
  paint: Paint,
  options: RenderOptions,
): Component {
  void options
  // Multi-line provider messages stay readable: each line keeps the error tone.
  const lines = row.text.split('\n').map((line) => paint('error', line)).join('\n')
  return new Text(`✖ ${lines}`, OUTPUT_PAD, 0)
}

/**
 * Make a row's component respond to a left click by toggling its fold.
 *
 * `MouseRegion` adds hit handling without changing the rendering, so the layout
 * stays a pure function of the row. With no owner handler the component is
 * returned untouched.
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
 * One user message.
 *
 * Folded to a short one-line excerpt by default: the prompt is an anchor for the
 * answer below it, and a pasted wall of text would bury that answer. A click
 * expands it.
 */
function renderUser(
  row: Extract<TranscriptRow, { kind: 'user' }>,
  paint: Paint,
  options: RenderOptions,
): Component {
  const folded = !isExpanded(row, options)
  const body = folded ? foldText(row.content) : row.content
  // `paddingY: 0` on purpose. `Text`'s default is 1, which pads *both* sides, so
  // two adjacent rows ended up two blank lines apart — the "input rows are too
  // far apart" report from a real session.
  const text = new Text(`${paint('accent', '❯')} ${paint('userMessageText', body)}`, OUTPUT_PAD, 0)
  const images = row.images ?? []
  // A folded row shows the text only: an image cannot shrink to one line.
  if (images.length === 0 || folded) return text
  const block = new Container()
  block.addChild(text)
  for (const image of images) block.addChild(renderImage(image, paint, options))
  return block
}

/** One assistant bubble: a leading glyph, optional reasoning, then the text. */
function renderAssistant(
  row: Extract<TranscriptRow, { kind: 'assistant' }>,
  paint: Paint,
  markdownTheme: MarkdownTheme,
  options: RenderOptions,
): Container {
  const card = new Container()
  // pi opens every assistant message with a blank line (`hasVisibleContent →
  // Spacer(1)`), which is what separates one reply from the previous row without
  // padding each row internally.
  if (row.thinking !== '' || row.text !== '') card.addChild(new Spacer(1))
  const thinkingBg = options.thinkingBackground
  if (row.thinking !== '') {
    // A live reasoning stream is *always* one line: it is still being written, so
    // expanding it would show a growing wall that pushes the answer off screen.
    // Expansion only applies once the turn has settled.
    const expanded = row.done && isExpanded(row, options)
    if (expanded) {
      // Settled and expanded: plain text, because nothing is moving any more.
      // A background band supplies the left inset itself (`wrapWithBackground`),
      // so the text starts at column 0 inside it; without a band the line pads.
      const pad = thinkingBg === undefined ? OUTPUT_PAD : 0
      const node = new Text(paint('thinkingText', row.thinking), pad, 0)
      card.addChild(thinkingBg === undefined ? node : wrapWithBackground(node, thinkingBg))
    } else {
      // While the turn runs, the newest line is what is moving; once it settles,
      // the first line is what it concluded from. The spinner rides on that
      // single line so the row stays one line tall and visibly alive.
      const summary = row.done ? firstLine(row.thinking) : latestLine(row.thinking)
      const marker = row.done ? '🐳' : options.spinnerFrame ?? '🐳'
      const pad = thinkingBg === undefined ? OUTPUT_PAD : 0
      const node = new Text(
        paint('thinkingText', `${marker} ${foldText(summary, THINKING_PREVIEW_CHARS)} (ctrl+o to expand)`),
        pad, 0,
      )
      card.addChild(thinkingBg === undefined ? node : wrapWithBackground(node, thinkingBg))
    }
  }
  if (row.text !== '') {
    // The leading spacer separates the message from the previous row; the
    // reasoning/answer boundary still needs its own line, because a reasoning
    // band directly against the answer reads as one paragraph.
    if (row.thinking !== '') card.addChild(new Spacer(1))
    card.addChild(new Markdown(row.text, OUTPUT_PAD, 0, markdownTheme))
  } else if (!row.done) {
    card.addChild(new Text(paint('dim', '…'), 0, 0))
  } else if (row.thinking === '') {
    card.addChild(new Text(paint('dim', '(no content)'), 0, 0))
  }
  return card
}

/**
 * One tool call, rendered the way pi renders every tool.
 *
 * The header is `bold(name)` plus the arguments (see `formatToolHeader`); the
 * body is the result, previewed while folded. Nothing here classifies the tool:
 * pi has no per-tool styling, and the earlier emoji + title + summary + status
 * pill made one row carry four labels for one call.
 *
 * Status is the card's background (`toolPendingBg` / `toolSuccessBg` /
 * `toolErrorBg`) — that is what a colour is for, and it survives having no text
 * to spare.
 *
 * @param row - the tool row.
 * @param paint - token painter.
 * @param options - expansion state, workspace root, card background.
 */
function renderTool(
  row: Extract<TranscriptRow, { kind: 'tool' }>,
  paint: Paint,
  bold: Bold,
  options: RenderOptions,
): Component {
  const expanded = isExpanded(row, options)
  // `Box` supplies the band *and* the inset, so it takes `OUTPUT_PAD` on both
  // axes and the lines inside start at column 0 (pi's `Box(1, 1, bg)`).
  const bg = options.cardBackground?.(row.status)
  const card: Component & { addChild(c: Component): void } = bg === undefined
    ? new Container()
    : new Box(OUTPUT_PAD, 1, bg)
  const pad = bg === undefined ? OUTPUT_PAD : 0

  card.addChild(new Text(
    formatToolHeader(row.name, row.args, paint, expanded, bold),
    pad, 0,
  ))
  if (row.status !== 'running' && row.result !== undefined) {
    for (const line of toolOutputLines(row.result, expanded, paint)) {
      card.addChild(new Text(line, pad, 0))
    }
  }
  for (const image of row.images ?? []) card.addChild(renderImage(image, paint, options))
  return card
}

/**
 * One image block.
 *
 * Rendered through pi-tui's {@linkcode Image}, which negotiates the terminal's
 * graphics protocol itself (Kitty / iTerm2) and falls back to a text placeholder
 * when the terminal cannot draw pictures — so this works over SSH and inside
 * multiplexers without a special case here.
 *
 * @param image - the attachment reference.
 * @param paint - token painter.
 * @param options - carries the byte cache.
 * @returns a component for the image (or its placeholder).
 */
function renderImage(
  image: RowImage,
  paint: Paint,
  options: RenderOptions,
): Component {
  const data = options.imageData?.(image)
  if (data === undefined) {
    // Still loading (or unavailable): name it instead of showing nothing, so the
    // user knows an image belongs here.
    const label = image.name ?? image.attachmentId
    return new Text(paint('dim', `  🖼  ${label} (${image.mediaType})`), OUTPUT_PAD, 0)
  }
  return new Image(data.base64, data.mediaType, {
    fallbackColor: (text: string) => paint('dim', text),
  }, {
    maxWidthCells: 60,
    maxHeightCells: 20,
    ...(image.name === undefined ? {} : { filename: image.name }),
  })
}

/** Wrap a component in a full-width background band. */
function wrapWithBackground(child: Component, bg: (text: string) => string): Component {
  const box = new Box(OUTPUT_PAD, 0, bg)
  box.addChild(child)
  return box
}

/**
 * The background token for a tool card's status.
 *
 * Lives here (not in the app) because it is *presentation knowledge*: which
 * palette slot paints "pending" is part of how a card looks, not part of what
 * the app orchestrates.
 *
 * @param status - the card's lifecycle state.
 * @returns the theme token to fill the band with.
 */
export function cardBackgroundToken(status: 'running' | 'success' | 'failed'): ThemeToken {
  return status === 'running'
    ? 'toolPendingBg'
    : status === 'failed' ? 'toolErrorBg' : 'toolSuccessBg'
}

/** What {@linkcode renderOptionsFor} needs from the app. */
export interface RenderContext {
  readonly theme: Theme
  /** The transcript's fold state (global switch + per-row overrides). */
  readonly fold: FoldView
  /** Glyph for the current spinner frame. */
  readonly spinnerFrame: string
  /** Cached image bytes, keyed by attachment id. */
  readonly imageData: (image: RowImage) => { base64: string; mediaType: string } | undefined
  /** Called when a card is clicked. */
  readonly onToggle: (row: TranscriptRow) => void
}

/**
 * Build the {@linkcode RenderOptions} for one frame.
 *
 * The options are a **pure projection of the theme plus the owner's view state**,
 * so constructing them belongs with the renderer rather than with the app: the
 * app says *what* the view state is, `transcript-view` says *how* that becomes
 * colours. Colour functions are skipped when the theme does not define the token,
 * which is what keeps a sparse pi theme working.
 *
 * @param context - theme, view state and owner callbacks.
 * @returns options ready to hand to {@linkcode renderRow}.
 */
export function renderOptionsFor(context: RenderContext): RenderOptions {
  const { theme } = context
  const tint = (token: ThemeToken): ((text: string) => string) | undefined =>
    theme.has(token) ? (text: string) => theme.bg(token, text) : undefined
  return {
    fold: context.fold,
    spinnerFrame: context.spinnerFrame,
    onToggle: context.onToggle,
    imageData: context.imageData,
    thinkingBackground: tint('customMessageBg'),
    cardBackground: (status) => tint(cardBackgroundToken(status)),
  }
}
