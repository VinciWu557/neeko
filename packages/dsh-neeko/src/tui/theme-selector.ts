/**
 * The theme selector, transcribed from pi's `ThemeSelectorComponent`.
 *
 * ## What this replaces
 *
 * The previous picker was a hand-rendered string: a title, rows built from a
 * window of the catalogue, and `─` rules. It could not do the one thing that
 * makes a theme picker usable — **preview**. pi's component wires
 * `SelectList.onSelectionChange` to an `onPreview` callback, so moving the cursor
 * recolours the whole TUI before you commit. Comparing forty palettes from a list
 * of names is guesswork; seeing them is not.
 *
 * Two smaller consequences of the port:
 *
 * - **No manual windowing.** `SelectList` takes `maxVisible`, computes the
 *   visible range from the cursor and moves the window as it leaves; the old code
 *   computed a window, mapped the cursor into it and emitted `↑ N more` markers
 *   by hand. (What it does *not* do is handle `pageUp`/`pageDown`: its
 *   `handleInput` covers exactly up / down / confirm / cancel, and both arrows
 *   wrap. Measured, not assumed.)
 * - **The cursor is the list's.** A `SelectList` owns its selection, so the
 *   `(current)` marker and the cursor are independent — which is what makes
 *   "preview this one, cancel back to the old one" work.
 *
 * ## What is not ported
 *
 * pi's `getAvailableThemes()` reads pi's own catalogue. Here the catalogue comes
 * from `ThemeController`, which merges the built-ins with the files in
 * `~/.dsh/themes` and `~/.pi/agent/themes`. The component takes it as a parameter
 * for that reason.
 *
 * @module dsh-neeko/tui/theme-selector
 */

import { Container, SelectList } from '@earendil-works/pi-tui'
import type { SelectListTheme } from '@earendil-works/pi-tui'
import type { Theme } from './theme.ts'
import { DynamicBorder } from './status-indicator.ts'

/**
 * Rows shown before the list pages.
 *
 * pi's `ThemeSelectorComponent` uses 10: enough to compare, small enough that the
 * panel never displaces the editor.
 */
const MAX_VISIBLE = 10

/**
 * Column bounds for the theme-name column.
 *
 * pi's `THEME_SELECT_LIST_LAYOUT`. Twelve fits the shortest built-in name and
 * thirty-two stops a long custom name from pushing `(current)` off the row.
 */
const LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 } as const

/** One selectable theme. */
export interface ThemeOption {
  readonly name: string
  /** `dark` or `light`; shown so a name like `neeko-claude` is not a guess. */
  readonly appearance: 'dark' | 'light'
  /** Absolute path for a user theme; absent for a built-in. */
  readonly sourcePath?: string
}

/**
 * The selector, mounted in the dock while open.
 *
 * Borders above and below, then the list. No filter box: pi's theme selector has
 * none either, because a theme catalogue is short and browsed rather than
 * searched.
 */
export class ThemeSelector extends Container {
  private readonly list: SelectList

  /**
   * @param options - the catalogue and the callbacks.
   */
  constructor(options: {
    readonly themes: readonly ThemeOption[]
    /** The theme in effect, marked `(current)` and used for the initial cursor. */
    readonly current: string
    /** The list's own theme (pi's `getSelectListTheme()` shape). */
    readonly selectTheme: SelectListTheme
    /** The palette that draws the borders. */
    readonly palette: Theme
    /** Called when the user commits a theme. */
    readonly onSelect: (name: string) => void
    /** Called on dismiss. */
    readonly onCancel: () => void
    /**
     * Called as the cursor moves, with the highlighted theme's name.
     *
     * pi's `onPreview`. The owner applies the palette without committing, which
     * is what lets a user see a theme before choosing it.
     */
    readonly onPreview?: (name: string) => void
  }) {
    super()
    const { themes, current, selectTheme, palette, onSelect, onCancel, onPreview } = options

    // `(current)` rather than a `✓` prefix on the label: pi marks the active row
    // in the *description* column, so the label column stays aligned across rows
    // and the cursor prefix is free to mean "cursor".
    const items = themes.map((theme) => ({
      value: theme.name,
      label: theme.name,
      description: [
        theme.name === current ? '(current)' : undefined,
        `[${theme.appearance}]`,
        theme.sourcePath === undefined ? undefined : 'custom',
      ].filter((part) => part !== undefined).join(' '),
    }))

    this.addChild(new DynamicBorder(palette))
    this.list = new SelectList(items, MAX_VISIBLE, selectTheme, LAYOUT)
    const at = themes.findIndex((theme) => theme.name === current)
    if (at !== -1) this.list.setSelectedIndex(at)
    this.list.onSelect = (item) => { onSelect(String(item.value)) }
    this.list.onCancel = () => { onCancel() }
    if (onPreview !== undefined) {
      this.list.onSelectionChange = (item) => { onPreview(String(item.value)) }
    }
    this.addChild(this.list)
    this.addChild(new DynamicBorder(palette))
  }

  /**
   * The list, for tests and for the owner's key routing.
   *
   * @returns the live `SelectList`.
   */
  getSelectList(): SelectList {
    return this.list
  }

  /**
   * Route one keystroke to the list.
   *
   * `SelectList` handles the four keys it knows — up, down, `enter`, `escape` —
   * itself, so there is nothing to split here. Unlike the thinking selector, this
   * panel has no filter box competing for them.
   *
   * @param data - the raw input chunk.
   */
  handleInput(data: string): void {
    this.list.handleInput(data)
  }
}
