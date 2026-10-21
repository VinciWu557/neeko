/**
 * The working indicator and the editor border it rides in.
 *
 * ## What this replaces
 *
 * `working…` used to be a plain row above the editor, and the spinner was a
 * separate 80 ms timer that mutated a shared frame string. pi's shape is
 * different in three ways that matter:
 *
 * 1. **The status rides inside the editor's top border** (`CustomEditor.
 *    renderTopBorder`), so the working line costs no screen row of its own. On a
 *    short terminal that row is the difference between seeing the input and not.
 * 2. **The animation lives in the component** (`Loader`), not in the app. The app
 *    used to advance a frame counter by hand and repaint the whole screen; the
 *    loader advances itself and asks for a repaint.
 * 3. **A border that has no status still draws a border** — the plain `─` run —
 *    so the editor's frame does not appear and disappear as work starts and stops.
 *
 * ## Why transcribed
 *
 * `Loader` / `StatusIndicator` / `CustomEditor` live in
 * `@earendil-works/pi-coding-agent`, and this package depends on `pi-tui` only.
 * `Loader` itself **is** in `pi-tui`; what is ported here is the thin
 * `StatusIndicator` wrapper plus the border composition.
 *
 * @module dsh-neeko/tui/status-indicator
 */

import { Loader, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import type { Component, TUI } from '@earendil-works/pi-tui'
import type { Theme } from './theme.ts'

/**
 * Spinner frames, in pi's order.
 *
 * The same ten braille glyphs `pi-tui`'s `Loader` defaults to, named here so a
 * call site can reason about the cycle length without reaching into pi-tui.
 */
export const SPINNER_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * The activity indicator, as a `Loader`.
 *
 * pi's `StatusIndicator` (`status-indicator.js`) is a `Loader` subclass that adds
 * `renderInBorder` / `renderSpinnerInBorder` so the indicator can be squeezed into
 * a border line. Both behaviours are needed; the subclass only exists so the
 * border composition can ask those two questions.
 *
 * `Loader.render()` prefixes a blank line (it is meant to sit in a stack), which
 * is why the border helpers read row 1 rather than row 0.
 */
export class StatusIndicator extends Loader {
  constructor(
    ui: TUI,
    theme: Theme,
    message: string,
    indicator?: { readonly frames?: string[]; readonly intervalMs?: number },
  ) {
    super(
      ui,
      // The spinner in the accent tone, the message in muted: the glyph is the
      // thing that moves, so it gets the attention.
      (text: string) => paint(theme, 'accent', text),
      (text: string) => paint(theme, 'muted', text),
      message,
      indicator,
    )
  }

  /**
   * The indicator's rendered line, trimmed, for embedding mid-border.
   *
   * @param width - columns available for the whole border.
   * @returns the indicator text, clipped to `width`.
   */
  renderInBorder(width: number): string {
    // `Loader.render` puts an empty line first; the message is row 1.
    const line = super.render(width + 2)[1] ?? ''
    const trimmed = line.startsWith(' ') ? line.slice(1).trimEnd() : line.trimEnd()
    return truncateToWidth(trimmed, width, '')
  }

  /**
   * Only the spinner glyph, for when the full label does not fit.
   *
   * @param width - columns available.
   * @returns the glyph, clipped.
   */
  renderSpinnerInBorder(width: number): string {
    return truncateToWidth(this.getRenderedIndicator(), width, '')
  }

  /** Stop the animation timer. */
  dispose(): void {
    this.stop()
  }
}

/**
 * Paint one token, or leave the text alone.
 *
 * @param theme - the palette.
 * @param token - the token to paint with.
 * @param text - the text to paint.
 * @returns the painted text.
 */
function paint(theme: Theme, token: 'accent' | 'muted' | 'borderMuted' | 'border', text: string): string {
  return theme.has(token) ? theme.fg(token, text) : text
}

/**
 * A full-width rule, coloured like a border.
 *
 * pi's `DynamicBorder` (`dynamic-border.js`): the width is the terminal's, so the
 * rule cannot be a fixed string. Used above and below a panel.
 */
export class DynamicBorder implements Component {
  constructor(private readonly theme: Theme) {}

  invalidate(): void {
    // Nothing cached: the rule is derived from the width each call.
  }

  render(width: number): string[] {
    return [paint(this.theme, 'border', '─'.repeat(Math.max(1, width)))]
  }
}

/** What {@linkcode borderWithStatus} needs. */
export interface BorderOptions {
  /** Whole-border width in columns. */
  readonly width: number
  /** The indicator to embed, or `undefined` for a plain rule. */
  readonly indicator: StatusIndicator | undefined
  /** Rows of editor content scrolled out above, for the `↑ N` marker. */
  readonly hiddenAbove: number
  /** The palette, for the rule and the overflow label. */
  readonly theme: Theme
}

/**
 * Compose the editor's top border: a rule with the status embedded.
 *
 * Transcribed from pi's `CustomEditor.renderTopBorder`
 * (`custom-editor.js`), including its three fallbacks. The order matters and is
 * the whole reason this is not a one-liner:
 *
 * 1. **Full label plus overflow marker** when both fit.
 * 2. **Spinner only** when the label cannot share the line with the marker.
 * 3. **Label only** when the marker is absent but the label fits.
 * 4. **Nothing but rules** when even the spinner cannot fit.
 *
 * Every branch returns exactly `width` columns, because the border is one row of a
 * frame whose other rows are the editor's own — a short border leaves the frame
 * ragged and a long one wraps and shifts every row below it.
 *
 * @param options - width, indicator, overflow count and palette.
 * @returns the border line.
 */
export function borderWithStatus(options: BorderOptions): string {
  const { width, indicator, hiddenAbove, theme } = options
  const rule = (count: number): string => paint(theme, 'borderMuted', '─'.repeat(Math.max(0, count)))
  const overflowLabel = hiddenAbove > 0 ? ` ↑ ${hiddenAbove} more ` : undefined

  if (indicator === undefined) {
    // No status: a plain rule, plus the overflow marker when lines are hidden.
    // pi's `Editor` does this itself; doing it here keeps one shape.
    if (overflowLabel === undefined) return rule(width)
    const labelWidth = visibleWidth(overflowLabel)
    if (labelWidth + 2 > width) return rule(width)
    const start = Math.floor((width - labelWidth) / 2)
    return rule(start) + paint(theme, 'borderMuted', overflowLabel) + rule(width - start - labelWidth)
  }

  let status = indicator.renderInBorder(Math.max(1, width - 5))
  let statusWidth = visibleWidth(status)
  const overflowWidth = overflowLabel === undefined ? 0 : visibleWidth(overflowLabel)
  const overflowStart = Math.floor((width - overflowWidth) / 2)
  // pi's test for "both fit": the marker's left edge must clear the label by at
  // least one column, or the two run together and read as one string.
  const bothFit = overflowLabel !== undefined
    && overflowWidth + 2 <= width
    && overflowStart - (3 + statusWidth + 1) >= 1

  if (overflowLabel !== undefined && !bothFit) {
    status = indicator.renderSpinnerInBorder(width)
    statusWidth = visibleWidth(status)
  }

  // 1. Label and overflow marker together: `── ⠋ Working ─── ↑ 3 more ───`.
  //
  // The space after the label is pi's and is part of the width budget:
  // `leftBlockWidth` already counts it, so the rule run must start after it.
  if (bothFit) {
    const leftBlockWidth = 3 + statusWidth + 1
    return rule(3) + status + ` ${rule(Math.max(0, overflowStart - leftBlockWidth))}`
      + paint(theme, 'borderMuted', overflowLabel ?? '')
      + rule(Math.max(0, width - overflowStart - overflowWidth))
  }

  // 2/3. Label (or spinner) alone, with room for the `── ` prefix.
  //
  // The single space after the label is pi's, and it is load-bearing: the run of
  // rules is `width - statusWidth - 4` starting *after* that space, which is what
  // makes the total exactly `width`. Dropping it left every border one column
  // short — a ragged frame edge on every frame.
  if (width >= statusWidth + 5) return rule(3) + status + ` ${rule(width - statusWidth - 4)}`

  // 4. Not even the label fits: shrink to the spinner, then to rules only.
  status = indicator.renderSpinnerInBorder(width)
  statusWidth = visibleWidth(status)
  const prefix = Math.min(3, Math.max(0, width - statusWidth))
  return rule(prefix) + status + rule(Math.max(0, width - prefix - statusWidth))
}
