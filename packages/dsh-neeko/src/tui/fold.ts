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
 * ## Why thinking has its own switch
 *
 * pi binds `ctrl+o` to `app.tools.expand` and `ctrl+t` to `app.thinking.toggle`:
 * two keys, two actions, two independent states. One switch forced a choice with
 * no good answer — make `ctrl+o` collapse reasoning too and the user loses the
 * answer along with the logs; leave reasoning alone and `ctrl+t` does nothing.
 *
 * They are **orthogonal**, which is the part worth getting right. pi keeps them in
 * two unrelated places: `toolOutputExpanded` walks the chat container calling
 * `setExpanded()`, while `hideThinkingBlock` is a field pushed into each
 * `AssistantMessageComponent`. An assistant message is *not* in the expandable walk,
 * so `ctrl+o` never reaches reasoning and `ctrl+t` never reaches tools.
 *
 * The first attempt here used `or` ("expanded if either switch says so") and had to
 * be undone: after `ctrl+o` opened everything, `ctrl+t` could no longer close the
 * reasoning. Orthogonal means an assistant row's body is open when its *own* switch
 * says so, independent of the tools' switch — a conjunction held against a per-row
 * flip, not a disjunction of two globals.
 *
 * The switch is consulted per row kind rather than as a second broadcast, because
 * `thinking` is a field on the assistant row, not a row of its own.
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
  /** Whether reasoning is shown, independently of {@linkcode allExpanded}. */
  readonly thinkingVisible: boolean
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
  private thinkingShown = false
  private flipped = new WeakSet<TranscriptRow>()

  get allExpanded(): boolean {
    return this.expandedAll
  }

  get thinkingVisible(): boolean {
    return this.thinkingShown
  }

  /**
   * Whether one row renders its body.
   *
   * The override *inverts* the global state rather than adding to it, so a click
   * is meaningful in both directions: it opens one row while everything is
   * folded, and closes one row while everything is expanded.
   *
   * The two switches are orthogonal (see the module comment): an assistant row
   * answers to the thinking switch, every other row answers to the tools switch.
   * Neither key can undo the other, which is what pi does and what "two keys, two
   * actions" has to mean.
   *
   * A row with no reasoning to show stays governed by the tools switch, so `ctrl+o`
   * still opens an assistant message whose `thinking` is empty (its *text* is the
   * body) — the same row would otherwise be permanently folded.
   *
   * @param row - the row being rendered.
   */
  isExpanded(row: TranscriptRow): boolean {
    const governs = row.kind === 'assistant' && row.thinking.trim() !== ''
      ? this.thinkingShown
      : this.expandedAll
    return governs !== this.flipped.has(row)
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
   * Flip whether reasoning is shown — the `ctrl+t` action.
   *
   * Clears the per-row overrides for the same reason {@linkcode toggleAll} does:
   * the result should be uniform, and keeping stale flips would leave a row open
   * after "hide reasoning".
   *
   * @returns the state now in effect, for the caller's status notice.
   */
  toggleThinking(): boolean {
    this.thinkingShown = !this.thinkingShown
    this.flipped = new WeakSet()
    return this.thinkingShown
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
