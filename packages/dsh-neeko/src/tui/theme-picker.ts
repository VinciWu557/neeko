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
import { renderPanel } from './picker.ts'

/**
 * How many theme rows may be rendered before the list is windowed.
 *
 * pi's model selector uses 10 for the same reason: enough to compare options,
 * small enough that the panel never displaces the editor.
 */
export const THEME_PICKER_MAX_VISIBLE = 10

/**
 * Render the picker panel.
 *
 * `→` marks the cursor, `✓` the active theme, `[appearance]` the palette, and
 * `· custom` the origin — pi's three-marker layout. The chrome (rules, title,
 * keys) and the marker positions come from the shared `picker.ts`; this function
 * supplies only the row text.
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
  const rows = view.choices.slice(window.start, window.end).map((choice) => ({
    text: `${choice.name} [${choice.appearance}]${
      choice.sourcePath === undefined ? '' : theme.fg('dim', ' · custom')}`,
    active: choice.name === theme.name,
  }))
  const [hiddenAbove, hiddenBelow] = overflowMarkers(window, (token, text) => theme.fg(token, text))
  // Only the *visible* slice reaches `renderPanel`, so its cursor must be the
  // row's position inside the window, not in the full catalogue.
  const notes = [hiddenAbove, hiddenBelow].filter((marker) => marker !== '')
  const hint = window.total > window.end - window.start
    ? `↑/↓ move · ${window.total} total`
    : undefined
  return renderPanel({
    title: 'Theme',
    rows,
    index: window.cursorRow,
    theme,
    ...(hint === undefined ? {} : { hint }),
    ...(notes.length === 0 ? {} : { notes }),
  })
}
