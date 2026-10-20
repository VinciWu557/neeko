/**
 * The two parts of the repaint pipeline that need no app state.
 *
 * ## Why these are separate
 *
 * `TuiApp.mountTranscript`'s flush does five things per tick: project the theme,
 * build render options, decide which rows can be reused, reconcile the container,
 * and prefetch images. Two of those are pure functions over their arguments —
 * deciding reuse ({@linkcode rowSignature}) and reconciling children
 * ({@linkcode syncChildren}) — and both carry rules worth stating on their own:
 *
 * - The signature is a **cheap fingerprint**, deliberately not a deep hash: it
 *   must be far cheaper than the render it guards, because it runs every 50 ms
 *   for a whole session. Too coarse and a streaming reply freezes; too eager and
 *   the cache it exists to feed is never hit.
 * - Reconciliation matches **by index**, so the container's child array keeps its
 *   identity and only the differing slots are touched. `clear()` + re-`addChild`
 *   rebuilds the whole array and runs an `indexOf` per removal.
 *
 * Keeping them here also means they can be tested without a terminal or a theme,
 * which is what the bug-prone half of the pipeline deserves.
 *
 * @module dsh-neeko/tui/row-cache
 */

import type { Component, Container } from '@earendil-works/pi-tui'
import type { FoldView } from './fold.ts'
import type { TranscriptRow, TranscriptState } from './transcript.ts'

export interface RowSignatureInput {
  /** The row being rendered. */
  readonly row: TranscriptRow
  /** A theme switch repaints every string. */
  readonly themeName: string
  /** Expansion is per row, and changes how much text is shown. */
  readonly fold: FoldView
  /** The spinner glyph is drawn inside an unfinished row. */
  readonly spinnerFrame: string
  /** A restore re-uses row objects with a new attach time. */
  readonly attachTime: number
}

/**
 * A cheap fingerprint of everything that changes how one row renders.
 *
 * Deliberately *not* a deep hash: it must be far cheaper than the render it
 * guards. Row content mutates in place (streaming appends to `text`), so the
 * mutable fields go in **by value** while identity comes from the row object.
 *
 * @param input - the row and the global state it depends on.
 * @returns a string that differs whenever the output would differ.
 */
export function rowSignature(input: RowSignatureInput): string {
  const { row, themeName, fold, spinnerFrame, attachTime } = input
  const expanded = fold.isExpanded(row) ? '1' : '0'
  if (row.kind === 'assistant') {
    // `thinking.length`/`text.length` change on every streamed token, which is
    // exactly when this row must be rebuilt.
    return `a|${themeName}|${expanded}|${row.done ? '1' : '0'}|${spinnerFrame}|` +
      `${row.text.length}|${row.thinking.length}`
  }
  if (row.kind === 'tool') {
    const images = row.images?.length ?? 0
    return `t|${themeName}|${expanded}|${row.status}|${images}|` +
      `${row.result?.length ?? -1}|${attachTime}`
  }
  if (row.kind === 'failure') {
    // Written once and never mutated, so only the fold can change it.
    return `f|${themeName}|${expanded}|${row.text.length}`
  }
  const images = row.images?.length ?? 0
  return `u|${themeName}|${expanded}|${row.content.length}|${images}`
}

/**
 * Make `container` hold exactly `next`, touching as little as possible.
 *
 * Matching by index keeps the child array's identity, so the flush touches only
 * the slots that differ. (pi-tui's `Container` keeps no line cache of its own, so
 * the win is the array work, not memoised lines.)
 *
 * @param container - the container to reconcile.
 * @param next - the children it should end up with.
 */
export function syncChildren(container: Container, next: readonly Component[]): void {
  const current = container.children
  for (let i = 0; i < next.length; i += 1) {
    if (current[i] === next[i]) continue
    const existing = current[i]
    if (existing === undefined) container.addChild(next[i] as Component)
    else container.children[i] = next[i] as Component
  }
  // Drop any trailing children a shorter transcript left behind.
  while (container.children.length > next.length) {
    const last = container.children[container.children.length - 1]
    if (last === undefined) break
    container.removeChild(last)
  }
}

/**
 * The rows a flush should paint.
 *
 * `/clear` is a view operation, so it is a watermark rather than a one-off
 * `Container.clear()`: the flush rebuilds from `rows` on every tick, so clearing
 * the container alone made the whole conversation reappear on the next event.
 * Rows added after the clear are kept; only the pre-clear prefix is hidden.
 *
 * @param state - the transcript state owned by the runner.
 * @param visibleFrom - index of the first row that may be painted.
 * @returns the rows to paint.
 */
export function visibleRows(
  state: TranscriptState,
  visibleFrom: number,
): readonly TranscriptRow[] {
  return state.rows.slice(visibleFrom)
}
