/**
 * Status-bar subsystem: the timing segment, the live facts, and the rendered
 * lines.
 *
 * Extracted from `TuiApp` for one reason that matters: the bar is a pi-tui
 * **component** whose `render(width)` is called on every repaint, and folding
 * session facts on every repaint is a side effect inside a render path. Owning
 * the cache here makes the purity rule explicit and testable.
 *
 * Two rules this class enforces:
 *
 * 1. **Facts are pulled once per change, not once per render.** `render(width)`
 *    re-lays-out the cached facts; it only re-reads them when the caller says
 *    something changed (`refresh()`), or when the width changed.
 * 2. **Width is the only render input.** Layout decisions (right-aligned route,
 *    left-side truncation) depend on the viewport, never on stale state.
 *
 * @module dsh-neeko/tui/status-controller
 */

import { renderStatusBar } from './status-bar.ts'
import type { StatusFacts } from './status-bar.ts'
import type { Theme } from './theme.ts'

/** Facts the app must supply, minus what the controller fills in itself. */
export type LiveStatusFacts = Omit<StatusFacts, 'provider' | 'model'>

export interface StatusControllerOptions {
  /** Pull the live facts (token ledger, branch, context pressure…). */
  readonly readFacts: () => LiveStatusFacts
  /** The route shown flush right. */
  readonly route: () => { provider: string; model: string }
  /** The active theme, read lazily so a theme switch needs no rewiring. */
  readonly theme: () => Theme
  /** Viewport width when the caller does not provide one. */
  readonly width?: () => number
}

/**
 * Owns the status bar's cached lines and its pi-tui component.
 *
 * The component is exposed as {@linkcode component} so the app can mount it
 * without knowing how the lines are produced.
 */
export class StatusController {
  private facts: StatusFacts | undefined
  private timing = ''
  private lines: string[] = []

  /** Fired when the rendered lines changed, so the owner can request a repaint. */
  onChange: (() => void) | undefined

  /** The mountable pi-tui component (one place, so the app has no inline object). */
  readonly component = {
    render: (width: number): string[] => this.renderLines(width),
    invalidate: (): void => {
      // Only `lines` is cached; `refresh()` rebuilds it.
    },
  }

  constructor(private readonly options: StatusControllerOptions) {}

  /** The currently rendered lines (empty before the first refresh). */
  get currentLines(): readonly string[] {
    return this.lines
  }

  /**
   * Re-read the live facts and rebuild the lines.
   *
   * Call this when session state *changed* (new event, new turn, model switch),
   * not from `render()`.
   */
  refresh(): void {
    this.facts = {
      ...this.options.readFacts(),
      ...this.options.route(),
    }
    this.lines = this.renderLines(this.width())
    this.onChange?.()
  }

  /**
   * Update the timing segment; no-op when unchanged (it ticks constantly).
   * @param text - the timing segment, or `''` to hide it.
   */
  setTiming(text: string): void {
    if (text === this.timing) return
    this.timing = text
    // Facts did not change, but the segment did — re-render from the cache.
    this.lines = this.renderLines(this.width())
    this.onChange?.()
  }

  /** Rebuild the rendered lines for one viewport width. */
  private renderLines(width: number): string[] {
    // A render before the first refresh must still produce something sane; pull
    // the facts then rather than printing an empty bar.
    if (this.facts === undefined) {
      this.facts = { ...this.options.readFacts(), ...this.options.route() }
    }
    const theme = this.options.theme()
    return [...renderStatusBar(this.facts, {
      width,
      timing: this.timing,
      paint: (token, text) => theme.fg(token, text),
    })]
  }

  private width(): number {
    return this.options.width?.() ?? process.stdout.columns ?? 80
  }
}
