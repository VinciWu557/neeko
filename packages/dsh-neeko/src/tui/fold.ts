/**
 * The transcript's fold state: one global switch plus per-row overrides.
 *
 * ## Why one object, and not two flags
 *
 * pi binds `ctrl+o` to `app.tools.expand` → `setToolsExpanded()` which walks the
 * chat container and calls `setExpanded()` on **every** expandable child: the
 * key is a broadcast, not a per-row toggle. A click, meanwhile, flips exactly
 * one row. Both mechanisms have to agree on what "expanded" means, or the key
 * and the pointer fight over the same rows — so the state lives here once.
 *
 * A broadcast also *overwrites* per-row overrides (that is what a broadcast
 * means), which is why {@linkcode TranscriptFold.toggleAll} drops the override
 * set. Keeping them would leave rows open after "collapse everything", making
 * the key unable to restore a uniform view.
 *
 * The overrides are held in a `WeakSet` keyed by row object: expansion is a
 * *view* preference, so this must not keep transcript rows alive.
 *
 * @module dsh-neeko/tui/fold
 */

import type { TranscriptRow } from './transcript.ts'

/** Read-only view of the fold state, which is all the renderer needs. */
export interface FoldView {
  /** Whether every row is open unless individually flipped. */
  readonly allExpanded: boolean
  /** Whether one row renders its full body. */
  isExpanded(row: TranscriptRow): boolean
}

/**
 * Mutable fold state owned by the app.
 *
 * Folded is the default: a transcript that is expanded by default is unreadable
 * the moment a tool returns a file, so a row opens only when asked.
 */
export class TranscriptFold implements FoldView {
  private expandedAll = false
  private flipped = new WeakSet<TranscriptRow>()

  get allExpanded(): boolean {
    return this.expandedAll
  }

  /**
   * Whether one row renders its body.
   *
   * The override *inverts* the global state rather than adding to it, so a click
   * is meaningful in both directions: it opens one row while everything is
   * folded, and closes one row while everything is expanded.
   *
   * @param row - the row being rendered.
   */
  isExpanded(row: TranscriptRow): boolean {
    return this.expandedAll !== this.flipped.has(row)
  }

  /**
   * Flip every row at once — the `ctrl+o` action.
   *
   * Clears the per-row overrides: the next state is uniform, exactly as pi's
   * broadcast leaves it.
   *
   * @returns the state now in effect, for the caller's status notice.
   */
  toggleAll(): boolean {
    this.expandedAll = !this.expandedAll
    // `WeakSet` has no `clear()`; a fresh set drops every override at once.
    this.flipped = new WeakSet()
    return this.expandedAll
  }

  /**
   * Flip one row — the click action.
   * @param row - the clicked row.
   */
  toggle(row: TranscriptRow): void {
    if (this.flipped.has(row)) this.flipped.delete(row)
    else this.flipped.add(row)
  }
}
