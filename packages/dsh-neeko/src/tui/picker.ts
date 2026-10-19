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

/** The subset of a theme this module paints with. */
export interface PanelTheme {
  fg(token: 'border' | 'accent' | 'dim' | 'muted', text: string): string
}

/** Columns of the panel's horizontal rules. */
const PANEL_WIDTH = 50

/** The hint every selector shows when the whole list fits. */
const PANEL_HINT = '↑/↓ move, enter apply, esc cancel'

/** One selectable entry, already formatted for display. */
export interface PanelRow {
  /** The row's text, without the cursor/active markers. */
  readonly text: string
  /** True for the entry in effect (draws `✓`). */
  readonly active?: boolean
}

/**
 * Render a selector's panel.
 *
 * The chrome — rules, title, hint, and the two markers — is the same for every
 * selector; only the rows differ. `→` follows the cursor and `✓` follows what is
 * actually in effect, so moving the cursor never pretends the value changed.
 *
 * @param options.title - the panel's title (`Theme`, `Thinking level`, …).
 * @param options.rows - one entry per selectable item, in display order.
 * @param options.index - the cursor's row.
 * @param options.theme - the active theme (colors the chrome).
 * @param options.hint - overrides {@link PANEL_HINT}; selectors that window their
 *   list report the total here instead.
 * @param options.notes - extra dim lines below the rows (e.g. "no level pinned").
 * @returns the panel's lines.
 */
export function renderPanel(options: {
  readonly title: string
  readonly rows: readonly PanelRow[]
  readonly index: number
  readonly theme: PanelTheme
  readonly hint?: string | undefined
  readonly notes?: readonly string[] | undefined
}): string {
  const { title, rows, index, theme } = options
  const painted = rows.map((row, position) => {
    const cursor = position === index ? '→ ' : '  '
    const active = row.active === true ? '✓ ' : '  '
    return `${cursor}${active}${row.text}`
  })
  return [
    theme.fg('border', '─'.repeat(PANEL_WIDTH)),
    theme.fg('accent', title) + theme.fg('dim', ` — ${options.hint ?? PANEL_HINT}`),
    ...painted,
    ...(options.notes ?? []).map((note) => theme.fg('dim', note)),
    theme.fg('border', '─'.repeat(PANEL_WIDTH)),
  ].join('\n')
}

/**
 * Run one keystroke against a selector that the caller owns the state for.
 *
 * The three selectors differ only in *where their state lives* — the theme
 * controller already holds its own cursor, while `/thinking` keeps its view in
 * the app — and in *what confirming means*. Those two are parameters; the
 * routing itself is identical and is therefore performed here once.
 *
 * @param options.state - the cursor and list length, or `undefined` when closed.
 * @param options.data - the raw keystroke.
 * @param options.isKey - predicate: does this key data match a named key?
 * @param options.onMove - called with the already-clamped next index and the
 *   intent's delta (a controller that owns its own cursor applies the delta;
 *   one that stores the index takes the index).
 * @param options.onClose - dismiss without applying.
 * @param options.onConfirm - apply the entry at `state.index`.
 * @returns whether a selector consumed the key (always true while open).
 */
export function runPickerKey(options: {
  readonly state: { readonly index: number; readonly length: number } | undefined
  readonly data: string
  readonly isKey: (name: 'escape' | 'up' | 'down' | 'enter') => boolean
  readonly onMove: (index: number, delta: 1 | -1) => void
  readonly onClose: () => void
  readonly onConfirm: () => void
}): { consume: true } {
  if (options.state === undefined) return { consume: true }
  const intent = pickerIntent(options.isKey)
  switch (intent.kind) {
    case 'close':
      options.onClose()
      return { consume: true }
    case 'move':
      options.onMove(movedIndex(options.state.index, intent.delta, options.state.length), intent.delta)
      return { consume: true }
    case 'confirm':
      options.onConfirm()
      return { consume: true }
    case 'ignore':
      return { consume: true }
  }
}
