/**
 * The shape every selector in this TUI shares.
 *
 * ## Why this module exists
 *
 * Three selectors grew independently — `/model`, `/theme`, `/thinking` — and each
 * one carried its own copy of the same three things: a key→intent mapping, a
 * cursor-move rule, and a bordered panel with a title and a hint. The copies had
 * already drifted: the theme picker *wrapped* at the ends while `pi-tui`'s
 * `SelectList` and the thinking picker *clamped*, so the same arrow key did
 * different things depending on which menu was open.
 *
 * From first principles a selector is only:
 *
 * 1. **a list plus a cursor** (state),
 * 2. **a key→intent mapping** (policy),
 * 3. **a bordered panel whose rows the caller formats** (presentation).
 *
 * Nothing here knows what a theme or a reasoning level is — the row text is a
 * callback — which is what keeps this module testable without a terminal and
 * lets a new selector be *added* rather than forked.
 *
 * @module dsh-neeko/tui/picker
 */

/** What one keystroke means while a selector owns the keyboard. */
export type PickerIntent =
  | { readonly kind: 'close' }
  | { readonly kind: 'move'; readonly delta: 1 | -1 }
  | { readonly kind: 'confirm' }
  /** The selector owns the keyboard but this key does nothing. */
  | { readonly kind: 'ignore' }

/**
 * Map one keystroke to a selector intent.
 *
 * Every selector answers the same four keys, so this is stated once. `ignore`
 * rather than "not handled" is deliberate: a selector that owns the screen must
 * not leak typing into the editor behind it.
 *
 * @param isKey - predicate: does this key data match a named key?
 * @returns the intent.
 */
export function pickerIntent(
  isKey: (name: 'escape' | 'up' | 'down' | 'enter') => boolean,
): PickerIntent {
  if (isKey('escape')) return { kind: 'close' }
  if (isKey('up')) return { kind: 'move', delta: -1 }
  if (isKey('down')) return { kind: 'move', delta: 1 }
  if (isKey('enter')) return { kind: 'confirm' }
  return { kind: 'ignore' }
}

/**
 * Where the cursor lands after a move.
 *
 * **Clamps, never wraps.** This is the rule `pi-tui`'s own `SelectList` uses
 * (`Math.max(0, Math.min(len - 1, index + delta))`), and the reason is
 * mechanical rather than stylistic: a selector window is a slice of the list, so
 * wrapping from the first row to the last also jumps the *window* — the screen
 * scrolls to a place the user did not ask for. Clamping keeps the motion the
 * user made.
 *
 * @param index - current cursor.
 * @param delta - `-1` up, `+1` down.
 * @param length - number of entries; `0` keeps the cursor at 0.
 * @returns the clamped index.
 */
export function movedIndex(index: number, delta: 1 | -1, length: number): number {
  if (length <= 0) return 0
  return Math.min(length - 1, Math.max(0, index + delta))
}
