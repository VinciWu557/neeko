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

import { Box, Container, Image, MouseRegion, Text } from '@earendil-works/pi-tui'
import { Markdown } from '@earendil-works/pi-tui'
import type { Component, MarkdownTheme } from '@earendil-works/pi-tui'
import type { Theme, ThemeToken } from './theme.ts'
import type { RowImage, TranscriptRow } from './transcript.ts'
import { firstLine, foldText, isFileRead, latestLine, toolHeader } from './tool-present.ts'

/**
 * Characters of reasoning shown on a folded line.
 *
 * Longer than a user prompt's fold: a reasoning preview is the only hint of what
 * the model is thinking, so it earns more room than a message excerpt does.
 */
const THINKING_PREVIEW_CHARS = 120

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
 * How one row renders: whether it is expanded, and the workspace root used to
 * shorten paths.
 */
export interface RenderOptions {
  /**
   * Cards in turns at or above this boundary are expanded; older ones fold to a
   * one-line preview. `undefined` expands everything (tests, short sessions).
   */
  readonly boundary?: number | undefined
  /** Rows the user expanded with `ctrl+o`, overriding {@linkcode boundary}. */
  readonly expanded?: { has(row: TranscriptRow): boolean } | undefined
  /** Workspace root, stripped from paths so a row shows the distinguishing part. */
  readonly cwd?: string | undefined
  /**
   * Called when a tool card is clicked.
   *
   * A card is the unit of "this happened"; clicking it re-opens its body, which
   * is the pointer equivalent of `ctrl+o` without having to find the newest row
   * first.
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
  // Folded is the *default*: a clean screen is the goal, so a row opens only when
  // the user asks for it — a click, which lands in `expanded`.
  if (options.expanded?.has(row) === true) return true
  const boundary = options.boundary
  // `boundary: 0` is the explicit "show everything" switch, used by tests and by
  // any caller that wants the raw transcript. Omitting the boundary means the
  // default, which is folded.
  if (boundary === undefined) return false
  if (boundary <= 0) return true
  // A user row has no turn of its own; treat it as "not in the window", so it
  // folds until clicked just like everything else.
  const turn = row.kind === 'user' ? Number.POSITIVE_INFINITY : row.turn
  return turn >= boundary
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
  theme?: { fg(token: ThemeToken, text: string): string },
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
    case 'tool':
      return clickable(renderTool(row, paint, options), row, options)
  }
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
  paint: (token: ThemeToken, text: string) => string,
  options: RenderOptions,
): Component {
  const folded = !isExpanded(row, options)
  const body = folded ? foldText(row.content) : row.content
  const text = new Text(`${paint('accent', '❯')} ${paint('userMessageText', body)}`)
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
  paint: (token: ThemeToken, text: string) => string,
  markdownTheme: MarkdownTheme,
  options: RenderOptions,
): Container {
  const card = new Container()
  const thinkingBg = options.thinkingBackground
  if (row.thinking !== '') {
    // A live reasoning stream is *always* one line: it is still being written, so
    // expanding it would show a growing wall that pushes the answer off screen.
    // Expansion only applies once the turn has settled.
    const expanded = row.done && isExpanded(row, options)
    if (expanded) {
      // Settled and expanded: plain text, because nothing is moving any more.
      const node = new Text(paint('thinkingText', row.thinking), 0, 0)
      card.addChild(thinkingBg === undefined ? node : wrapWithBackground(node, thinkingBg))
    } else {
      // While the turn runs, the newest line is what is moving; once it settles,
      // the first line is what it concluded from. The spinner rides on that
      // single line so the row stays one line tall and visibly alive.
      const summary = row.done ? firstLine(row.thinking) : latestLine(row.thinking)
      const marker = row.done ? '🐳' : options.spinnerFrame ?? '🐳'
      const node = new Text(
        paint('thinkingText', `${marker} ${foldText(summary, THINKING_PREVIEW_CHARS)} (ctrl+o to expand)`),
        0, 0,
      )
      card.addChild(thinkingBg === undefined ? node : wrapWithBackground(node, thinkingBg))
    }
  }
  if (row.text !== '') {
    card.addChild(new Markdown(row.text, 0, 0, markdownTheme))
  } else if (!row.done) {
    card.addChild(new Text(paint('dim', '…'), 0, 0))
  } else if (row.thinking === '') {
    card.addChild(new Text(paint('dim', '(no content)'), 0, 0))
  }
  return card
}

/** One tool card: `emoji Title summary [status]`, body only when expanded. */
function renderTool(
  row: Extract<TranscriptRow, { kind: 'tool' }>,
  paint: (token: ThemeToken, text: string) => string,
  options: RenderOptions,
): Component {
  const header = toolHeader(row.name, row.args, options.cwd)
  const summary = header.summary === '' ? '' : ` ${header.summary}`
  const pill = row.status === 'running'
    ? paint('muted', '[running]')
    : row.status === 'failed'
      ? paint('error', '[error]')
      : paint('success', '[ok]')
  const head = `${header.emoji} ${paint('toolTitle', header.title)}${paint('muted', summary)} ${pill}`

  // `Box` fills its whole width with the background, so the card reads as a
  // band rather than as coloured words.
  const bg = options.cardBackground?.(row.status)
  const card: Component & { addChild(c: Component): void } = bg === undefined ? new Container() : new Box(1, 0, bg)
  if (!isExpanded(row, options)) {
    // Folded: the head alone is the row. A file read adds nothing by quoting a
    // slice of the file — its path (already in the head) is the useful part.
    const short = row.result === undefined || row.result === '' || isFileRead(row.name)
      ? ''
      : ` — ${paint('dim', foldText(row.result))}`
    card.addChild(new Text(`${head}${short}`, 0, 0))
    return card
  }
  card.addChild(new Text(head, 0, 0))
  if (row.status === 'running') {
    const raw = typeof row.args === 'string' ? row.args : JSON.stringify(row.args, null, 2)
    if (raw !== undefined && raw !== '{}') card.addChild(new Text(paint('dim', indent(raw)), 0, 0))
    return card
  }
  if (row.result !== undefined && row.result !== '') {
    for (const line of row.result.split('\n')) {
      card.addChild(new Text(paint('toolOutput', `  ${line}`), 0, 0))
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
  paint: (token: ThemeToken, text: string) => string,
  options: RenderOptions,
): Component {
  const data = options.imageData?.(image)
  if (data === undefined) {
    // Still loading (or unavailable): name it instead of showing nothing, so the
    // user knows an image belongs here.
    const label = image.name ?? image.attachmentId
    return new Text(paint('dim', `  🖼  ${label} (${image.mediaType})`), 0, 0)
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
  const box = new Box(1, 0, bg)
  box.addChild(child)
  return box
}

/** Indent a multi-line block by two cells so it reads as body text. */
function indent(text: string): string {
  return text.split('\n').map((line) => `  ${line}`).join('\n')
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
  /** Rows the user expanded explicitly. */
  readonly expanded: { has(row: TranscriptRow): boolean }
  /** Workspace root, stripped from displayed paths. */
  readonly cwd: string
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
    expanded: context.expanded,
    cwd: context.cwd,
    spinnerFrame: context.spinnerFrame,
    onToggle: context.onToggle,
    imageData: context.imageData,
    thinkingBackground: tint('customMessageBg'),
    cardBackground: (status) => tint(cardBackgroundToken(status)),
  }
}
