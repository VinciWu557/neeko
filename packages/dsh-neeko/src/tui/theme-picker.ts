/**
 * Theme picker: the panel's text and its key handling.
 *
 * Split out of `TuiApp` because neither half is about *owning the screen*:
 * the panel is a pure string built from (view, theme), and a keystroke is a
 * pure decision over (view, key). `TuiApp` keeps only the mount and the effect,
 * which is the same boundary `interactionIntent()` uses one directory over.
 *
 * @module dsh-neeko/tui/theme-picker
 */

import type { Theme } from './theme.ts'
import type { ThemePickerView } from './theme-controller.ts'
import { listWindow, overflowMarkers } from './window.ts'

/**
 * How many theme rows may be rendered before the list is windowed.
 *
 * pi's model selector uses 10 for the same reason: enough to compare options,
 * small enough that the panel never displaces the editor.
 */
export const THEME_PICKER_MAX_VISIBLE = 10

/** What one keystroke means while the picker is open. */
export type ThemePickerIntent =
  | { readonly kind: 'close' }
  | { readonly kind: 'move'; readonly delta: 1 | -1 }
  | { readonly kind: 'confirm' }
  /** The picker owns the keyboard but this key does nothing. */
  | { readonly kind: 'ignore' }

/**
 * Render the picker panel.
 *
 * `→` marks the cursor, `✓` the active theme, `[appearance]` the palette, and
 * `· custom` the origin — pi's three-marker layout.
 *
 * The list is **windowed**: the catalogue is every `*.json` under two theme
 * directories, so rendering it whole let a user with many themes push the editor
 * off screen while the picker still owned the keyboard. Overflow is reported
 * explicitly (`↑ N more`) rather than silently dropped.
 *
 * @param view - the picker's current view.
 * @param theme - the active theme (its palette colors the panel).
 * @param maxVisible - rows to render before windowing (default {@linkcode THEME_PICKER_MAX_VISIBLE}).
 * @returns the panel text.
 */
export function renderThemePicker(
  view: ThemePickerView,
  theme: Theme,
  maxVisible: number = THEME_PICKER_MAX_VISIBLE,
): string {
  const window = listWindow(view.choices.length, view.index, maxVisible)
  const rows = view.choices.slice(window.start, window.end).map((choice, offset) => {
    const index = window.start + offset
    const cursor = index === view.index ? '→ ' : '  '
    const active = choice.name === theme.name ? '✓ ' : '  '
    const origin = choice.sourcePath === undefined ? '' : theme.fg('dim', ' · custom')
    return `${cursor}${active}${choice.name} [${choice.appearance}]${origin}`
  })
  const [hiddenAbove, hiddenBelow] = overflowMarkers(window, (token, text) => theme.fg(token, text))
  const hint = window.total > window.end - window.start
    ? ` — ↑/↓ move · ${window.total} total`
    : ' — ↑/↓ move, enter apply, esc cancel'
  return [
    theme.fg('border', '─'.repeat(50)),
    theme.fg('accent', 'Theme') + theme.fg('dim', hint),
    ...(hiddenAbove === '' ? [] : [hiddenAbove]),
    ...rows,
    ...(hiddenBelow === '' ? [] : [hiddenBelow]),
    theme.fg('border', '─'.repeat(50)),
  ].join('\n')
}

/**
 * Map one keystroke to a picker intent.
 * @param isKey - predicate: does this key data match a named key?
 * @returns the intent.
 */
export function themePickerIntent(isKey: (name: 'escape' | 'up' | 'down' | 'enter') => boolean): ThemePickerIntent {
  if (isKey('escape')) return { kind: 'close' }
  if (isKey('up')) return { kind: 'move', delta: -1 }
  if (isKey('down')) return { kind: 'move', delta: 1 }
  if (isKey('enter')) return { kind: 'confirm' }
  return { kind: 'ignore' }
}
