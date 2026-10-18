/**
 * Windowed list slicing — the one piece of list math every selector in this TUI
 * needs, kept separate so it is stated once and tested once.
 *
 * ## Why a window at all
 *
 * Any selector that renders one line per entry grows without bound: the theme
 * catalogue is every `*.json` under two directories, and the model catalogue is
 * every model a provider exposes. Rendering them all pushes the editor out of
 * the viewport — and because the selector still owns the keyboard, the user ends
 * up with an invisible input row. pi's model selector solves it the same way
 * (`maxVisible` + keep the selection centred), which is why the shape here
 * follows it.
 *
 * @module dsh-neeko/tui/window
 */

/** A visible slice of a list plus where the cursor sits inside it. */
export interface ListWindow {
  /** First rendered index (inclusive). */
  readonly start: number
  /** Last rendered index (exclusive). */
  readonly end: number
  /** The cursor's row **within the window** (0-based). */
  readonly cursorRow: number
  /** How many entries exist in total. */
  readonly total: number
  /** Entries hidden above the window. */
  readonly hiddenAbove: number
  /** Entries hidden below the window. */
  readonly hiddenBelow: number
}

/**
 * Compute the visible window for a list of `total` entries with `cursor`
 * selected.
 *
 * The cursor is kept **centred** once the list is longer than the window, so
 * moving up or down always reveals more entries ahead instead of pinning the
 * cursor to an edge. At the ends the window clamps, which keeps the visible
 * block from jittering on the first and last entries.
 *
 * @param total - number of entries in the list.
 * @param cursor - the selected index (clamped into range).
 * @param maxVisible - how many rows may be rendered (at least 1).
 * @returns the window; `start === end === 0` for an empty list.
 */
export function listWindow(total: number, cursor: number, maxVisible: number): ListWindow {
  const limit = Math.max(1, Math.floor(maxVisible))
  if (total <= 0) {
    return { start: 0, end: 0, cursorRow: 0, total: 0, hiddenAbove: 0, hiddenBelow: 0 }
  }
  const index = Math.min(Math.max(0, Math.floor(cursor)), total - 1)
  if (total <= limit) {
    return { start: 0, end: total, cursorRow: index, total, hiddenAbove: 0, hiddenBelow: 0 }
  }
  // Centre the cursor, then clamp so the window never leaves the list.
  const half = Math.floor(limit / 2)
  const start = Math.min(Math.max(0, index - half), total - limit)
  const end = start + limit
  return {
    start,
    end,
    cursorRow: index - start,
    total,
    hiddenAbove: start,
    hiddenBelow: total - end,
  }
}

/**
 * Render `↑ N more` / `↓ N more` overflow markers.
 *
 * Exposed so every selector reports hidden rows with the same wording — a
 * silently truncated list reads as "this is everything", which is a correctness
 * problem for a catalogue the user is choosing from.
 *
 * @param window - the computed window.
 * @param paint - colors the marker with a theme token.
 * @returns `[above, below]`, either possibly `''`.
 */
export function overflowMarkers(
  window: ListWindow,
  paint: (token: 'dim', text: string) => string,
): readonly [string, string] {
  const above = window.hiddenAbove === 0 ? '' : paint('dim', `  ↑ ${window.hiddenAbove} more`)
  const below = window.hiddenBelow === 0 ? '' : paint('dim', `  ↓ ${window.hiddenBelow} more`)
  return [above, below]
}
