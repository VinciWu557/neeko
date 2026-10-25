/**
 * The session picker, as a mounted `SelectList`.
 *
 * ## What this replaces
 *
 * The panel used to be a string: `renderPanel` computed a window
 * (`listWindow`), mapped the cursor into that window, and emitted `↑ N more`
 * markers by hand. That is exactly what `SelectList` already does, and doing it
 * twice means the two can disagree — the markers came from the window arithmetic
 * while the cursor came from `SelectList`, so after a page the visible rows and
 * the highlighted row were computed by different code.
 *
 * ## What is *not* transcribed from pi
 *
 * pi's `SessionSelectorComponent` is 892 lines and owns four things this build
 * has no counterpart for:
 *
 * - **Scope switching** (current directory / all directories). dsh's
 *   `sessionQuery.listSessions()` already answers the scope the caller asked
 *   for; a second filter here would be a second source of truth.
 * - **Sorting** (recency / name). The corpus is newest-first *by contract*, and
 *   re-sorting would second-guess the backend.
 * - **Delete and rename.** Both need a persistence API this build does not have.
 * - **A background corpus scan with progress.** Titles arrive per page from
 *   `ResumeController` (see its `fillPage`), because the cost has to follow what
 *   is on screen: reading 426 titles took 40 seconds.
 *
 * What is left is the panel: a border, a list, a border. The controller keeps the
 * data, the paging and the title cache; this file only renders them.
 *
 * @module dsh-neeko/tui/resume-selector
 */

import { Container, SelectList } from '@earendil-works/pi-tui'
import type { SelectItem, SelectListTheme } from '@earendil-works/pi-tui'
import type { Theme } from './theme.ts'
import type { ResumeChoice } from './resume-list.ts'
import { DynamicBorder } from './status-indicator.ts'

/**
 * Rows shown before the list scrolls.
 *
 * Ten is pi's model-picker window and what this panel used before the port, so
 * the dock does not change height.
 */
const MAX_VISIBLE = 10

/** Column bounds: a session row leads with its title, which can be long. */
const LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 60 } as const

/**
 * One session row as a `SelectItem`.
 *
 * The label is the controller's row text **verbatim**: `resume-list.ts` already
 * composes the title, the age and the `[current]` marker, and reformatting here
 * would be a second definition of what a session row says.
 *
 * @param choice - the row.
 * @returns the list item.
 */
function rowItem(choice: ResumeChoice): SelectItem {
  return {
    value: choice.id,
    label: choice.text,
    // A session nobody ever typed into is resumable but is noise: every launch
    // that exits without a prompt leaves one, and they sort newest-first.
    ...(choice.hasHistory ? {} : { description: 'empty' }),
  }
}

/**
 * The picker, mounted in the dock while open.
 *
 * Rebuilt whenever the underlying choices change (a page of titles arrived, the
 * cursor moved): `SelectList` snapshot its items at construction, so a
 * `setItems`-style update does not exist. Rebuilding with an explicit preselect
 * keeps the cursor on the session it was on.
 */
export class ResumeSelector extends Container {
  private list: SelectList
  /** Where the list sits in `children`, so a rebuild replaces it in place. */
  private readonly listIndex: number

  /**
   * @param options - rows and callbacks.
   */
  constructor(options: {
    /** The rows to show, in the order the controller produced them. */
    readonly choices: readonly ResumeChoice[]
    /** The id the cursor should sit on, if it is still present. */
    readonly selected: string | undefined
    /** The session this TUI is attached to, marked as such. */
    readonly currentId: string
    /** The list's own theme (pi's `getSelectListTheme()` shape). */
    readonly selectTheme: SelectListTheme
    /** The palette that draws the borders. */
    readonly palette: Theme
    /** Called with the chosen session id. */
    readonly onSelect: (id: string) => void
    /** Called on dismiss. */
    readonly onCancel: () => void
  }) {
    super()
    const { choices, selected, currentId, selectTheme, palette, onSelect, onCancel } = options

    const items = choices.map(rowItem)

    this.addChild(new DynamicBorder(palette))
    this.list = new SelectList(items, MAX_VISIBLE, selectTheme, LAYOUT)
    const at = items.findIndex((item) => item.value === (selected ?? currentId))
    if (at !== -1) this.list.setSelectedIndex(at)
    this.list.onSelect = (item) => { onSelect(String(item.value)) }
    this.list.onCancel = () => { onCancel() }
    this.listIndex = this.children.length
    this.addChild(this.list)
    this.addChild(new DynamicBorder(palette))
  }

  /**
   * The list, for tests and for the owner's own inspection.
   *
   * @returns the live `SelectList`.
   */
  getSelectList(): SelectList {
    return this.list
  }

  /**
   * Replace the rows, keeping the cursor where it was.
   *
   * A page of titles arrives asynchronously, so the rows change under the user.
   * `SelectList` snapshots its items, which is why this rebuilds rather than
   * calling a setter — and rebuilding without the preselect would put the cursor
   * back on row 0 on every page.
   *
   * @param choices - the new rows.
   * @param theme - the list theme (re-read: a theme switch changes it).
   * @param onSelect - the commit callback.
   * @param onCancel - the dismiss callback.
   * @param index - the row to highlight, from the controller's `view.index`.
   *   **Omitted means "keep the current row"**, which is what a page of titles
   *   arriving needs: the user is reading, not navigating.
   */
  setChoices(
    choices: readonly ResumeChoice[],
    theme: SelectListTheme,
    onSelect: (id: string) => void,
    onCancel: () => void,
    index?: number,
  ): void {
    const previous = this.list.getSelectedItem()?.value
    const items = choices.map(rowItem)
    const next = new SelectList(items, MAX_VISIBLE, theme, LAYOUT)
    if (index !== undefined) {
      // The controller already decided where the cursor is; the component's job is
      // to show that, not to remember a different place. Clamped because a rescan
      // can hand back a shorter list than the index was computed against.
      next.setSelectedIndex(Math.max(0, Math.min(items.length - 1, index)))
    } else {
      const at = items.findIndex((item) => item.value === previous)
      if (at !== -1) next.setSelectedIndex(at)
    }
    next.onSelect = (item) => { onSelect(String(item.value)) }
    next.onCancel = () => { onCancel() }
    this.children[this.listIndex] = next
    this.list = next
  }

  /**
   * Route one keystroke to the list.
   *
   * `SelectList` handles up / down / `enter` / `escape`; this panel has no other
   * input, so there is nothing to split.
   *
   * @param data - the raw input chunk.
   */
  handleInput(data: string): void {
    this.list.handleInput(data)
  }
}
