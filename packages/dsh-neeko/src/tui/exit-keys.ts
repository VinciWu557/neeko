/**
 * The two exit keys, and what they mean when the editor has something in it.
 *
 * ## `ctrl+c` clears; `ctrl+c` twice exits
 *
 * This was an immediate `onExit()` here. That is the one keystroke every terminal
 * user reaches for to abandon a half-typed message, and answering it with a shutdown
 * costs the session — including a turn that was mid-flight. pi's own hint text says
 * it plainly:
 *
 * ```
 * ctrl+c   to clear
 * ctrl+c twice   to exit
 * ctrl+d   to exit (empty)
 * ```
 *
 * ## The 500 ms window
 *
 * pi treats a second `ctrl+c` within 500 ms as the exit (`now - lastSigintTime <
 * 500`). A longer gap is two separate "clear" presses, which is exactly what someone
 * mashing the key to wipe a long draft produces — and the one thing that must not
 * quit on them.
 *
 * The window lives in this module rather than in the caller so that the rule is one
 * testable unit. It is a plain timestamp comparison, not a timer: a timer would keep
 * the event loop alive for half a second after every keypress, and the comparison is
 * what pi does anyway.
 *
 * ## `ctrl+d` is the opposite
 *
 * It exits **only** from an empty editor. pi enforces that in its `CustomEditor`
 * (`onCtrlD` fires when empty); pi-tui's plain `Editor` has no such hook, so the
 * check is here instead of in the keybinding — a binding cannot see the text.
 *
 * @module dsh-neeko/tui/exit-keys
 */

/** How long a second `ctrl+c` still counts as the same intent. */
export const DOUBLE_INTERRUPT_MS = 500

/** What the caller should do after an exit key. */
export type ExitKeyAction =
  /** Wipe the draft; the program stays alive. */
  | { readonly kind: 'clear' }
  /** Leave. */
  | { readonly kind: 'exit' }
  /** Nothing to do (a draft survives `ctrl+d`). */
  | { readonly kind: 'ignore' }

/**
 * Decide what one `ctrl+c` press means.
 *
 * Pure: the caller passes the clock and keeps the returned timestamp. That keeps the
 * rule testable without fake timers, and keeps the mutable field where the rest of
 * the app's state already lives.
 *
 * @param now - milliseconds, from the caller's clock.
 * @param lastPress - the previous press, or `undefined` when there was none.
 * @returns the action, and the timestamp to remember (always `now`).
 */
export function onInterrupt(
  now: number,
  lastPress: number | undefined,
): { readonly action: ExitKeyAction; readonly remember: number } {
  // A second press inside the window is "I meant it". Outside it, the user has
  // forgotten the first one, so this is a fresh clear.
  if (lastPress !== undefined && now - lastPress < DOUBLE_INTERRUPT_MS) {
    return { action: { kind: 'exit' }, remember: now }
  }
  return { action: { kind: 'clear' }, remember: now }
}

/**
 * Decide what one `ctrl+d` press means.
 *
 * @param draft - whether the editor has text in it.
 * @returns the action.
 */
export function onEndOfInput(draft: boolean): ExitKeyAction {
  // `ctrl+d` is end-of-input everywhere: it means "nothing more from me". With a
  // draft in the editor that is not true yet, so the key is a no-op rather than a
  // shutdown — quitting would discard the message in progress.
  return draft ? { kind: 'ignore' } : { kind: 'exit' }
}
