/**
 * The thinking-level selector, transcribed from pi's `ThinkingSelectorComponent`.
 *
 * ## What changed and why
 *
 * The previous selector was a hand-rendered string: a title line, rows prefixed
 * with `→`/`✓`, and a border made of `─` characters. It worked, but it could not
 * do three things pi's does, and each is visible:
 *
 * 1. **No filtering.** pi puts an `Input` above a `SelectList` and fuzzy-filters
 *    as you type. With seven levels that matters less than for models, but the
 *    shape is the same one `/model` uses, so learning one teaches the other.
 * 2. **No descriptions from the adapter.** pi shows a fixed table
 *    (`LEVEL_DESCRIPTIONS`) *and* marks which level is the configured default.
 *    A row said `high [high]` — the id and the name — and nothing about cost.
 * 3. **No per-row cursor.** pi's `SelectList` owns the cursor, the visible
 *    window, `pageUp`/`pageDown` and the mouse; the hand-rolled version had to
 *    re-derive all of that from an index.
 *
 * ## What is not ported
 *
 * - **`app.thinking.save` (ctrl+s, "set as default").** This build has no
 *   settings writer for a reasoning level: the selection lives in the live
 *   agent, and persisting it is a profile concern the TUI does not own. The key
 *   is therefore not advertised — a hint for a key that does nothing is worse
 *   than no hint.
 * - **`app.thinking.cycle` hint.** Same reason: this build has no cycle action
 *   yet, and `keymap.ts` deliberately declares only actions it routes.
 *
 * @module dsh-neeko/tui/thinking-selector
 */

import { Container, Input, SelectList, Spacer, Text, fuzzyFilter, getKeybindings } from '@earendil-works/pi-tui'
import type { Keybinding, KeybindingsManager, SelectItem, SelectListTheme } from '@earendil-works/pi-tui'
import type { Theme } from './theme.ts'
import { DynamicBorder } from './status-indicator.ts'

/**
 * What each level costs, in pi's words.
 *
 * Transcribed from pi's `ThinkingSelectorComponent` (`LEVEL_DESCRIPTIONS`). A
 * level's *name* is opaque (`xhigh`), so a one-line explanation is what makes the
 * menu a decision aid rather than a list of tokens.
 */
const LEVEL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  off: 'No reasoning',
  minimal: 'Very brief reasoning (~1k tokens)',
  low: 'Light reasoning (~2k tokens)',
  medium: 'Moderate reasoning (~8k tokens)',
  high: 'Deep reasoning (~16k tokens)',
  xhigh: 'Extra-high reasoning (~32k tokens)',
  max: 'Maximum reasoning',
}

/**
 * Column bounds for the level name column.
 *
 * pi's `THINKING_SELECT_LIST_LAYOUT`: twelve columns fits the longest level name,
 * and thirty-two stops a long one from pushing the description off the row.
 */
const LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 } as const

/**
 * The actions that belong to the list rather than to the filter.
 *
 * `SelectList.handleInput` itself only understands up / down / confirm / cancel;
 * the two page actions are listed because a terminal may send them and the list
 * ignores what it does not know — routing them here keeps them out of the filter
 * instead of typing an escape sequence into the search box.
 */
const NAV_ACTIONS = [
  'tui.select.up',
  'tui.select.down',
  'tui.select.confirm',
  'tui.select.cancel',
] as const satisfies readonly Keybinding[]

/** One selectable level. */
export interface ThinkingLevel {
  /** The opaque id the provider accepts (`high`, `xhigh`, …). */
  readonly id: string
  /** The display name; usually equal to the id. */
  readonly name: string
  /** Adapter-supplied description, when it has one. */
  readonly description?: string
}

/**
 * The selector, mounted in the input slot while open.
 *
 * Owns the search input and the list, and routes keys between them the way pi
 * does: navigation keys go to the list, everything else goes to the input and
 * re-filters.
 */
export class ThinkingSelector extends Container {
  private readonly search: Input
  private list: SelectList
  /** Index of the list in `children`, so a re-filter can replace it in place. */
  private listIndex = 0
  private readonly allItems: readonly SelectItem[]
  private focusedFlag = false
  /** Captured at construction: a re-filter rebuilds the list and needs both. */
  private readonly selectTheme: SelectListTheme
  private readonly onSelect: (id: string) => void
  private readonly onCancel: () => void

  /**
   * @param levels - the levels the model advertises.
   * @param current - the level in effect, for the `✓` marker and the cursor.
   * @param theme - the palette (borders, hint text).
   * @param selectTheme - the list's own theme (pi's `getSelectListTheme()` shape).
   * @param onSelect - called with the chosen level id.
   * @param onCancel - called when the user dismisses without choosing.
   * @param defaultLevel - the profile's configured default, marked in the row.
   */
  constructor(
    levels: readonly ThinkingLevel[],
    private readonly current: string | undefined,
    theme: Theme,
    selectTheme: SelectListTheme,
    onSelect: (id: string) => void,
    onCancel: () => void,
    defaultLevel?: string,
  ) {
    super()
    this.selectTheme = selectTheme
    this.onSelect = onSelect
    this.onCancel = onCancel
    this.allItems = levels.map((level) => ({
      value: level.id,
      label: `${level.id === current ? '✓ ' : '  '}${level.name}`,
      description: describe(level, defaultLevel),
    }))

    this.addChild(new DynamicBorder(theme))
    this.addChild(new Spacer(1))
    this.addChild(new Text(theme.has('text') ? theme.fg('text', 'Thinking Level') : 'Thinking Level', 0, 0))
    this.addChild(new Spacer(1))
    this.search = new Input()
    this.addChild(this.search)
    this.addChild(new Spacer(1))

    this.list = this.buildList(this.allItems)
    this.listIndex = this.children.length
    this.addChild(this.list)
    this.addChild(new Spacer(1))
    this.addChild(new Text(hint(theme), 0, 0))
    this.addChild(new DynamicBorder(theme))

    // Enter in the search box confirms the highlighted row, so a typed filter does
    // not need the cursor moved first.
    this.search.onSubmit = () => { this.list.handleInput('\r') }
    this.search.onEscape = () => { onCancel() }
  }

  /**
   * Focus propagation.
   *
   * A `Container` does not forward focus, and an unfocused `Input` draws no
   * cursor — and, more importantly, positions no IME candidate window. pi's
   * selector does the same (`focused` setter).
   */
  get focused(): boolean {
    return this.focusedFlag
  }

  set focused(value: boolean) {
    this.focusedFlag = value
    this.search.focused = value
  }

  /**
   * The list, for tests and for the owner's own key routing.
   *
   * @returns the live `SelectList`.
   */
  getSelectList(): SelectList {
    return this.list
  }

  /**
   * Route one keystroke.
   *
   * pi's split: navigation keys belong to the list, everything else feeds the
   * filter. Getting this backwards would make typing `h` move the cursor instead of
   * narrowing the list.
   *
   * "Navigation" is a **keybinding question**, so it is answered by the registry
   * rather than by comparing byte sequences. A literal `data === '\x1b[B'` froze
   * the answer at pi-tui's defaults: after rebinding `tui.select.down` to `ctrl+n`,
   * `↓` was swallowed as navigation and did nothing while `ctrl+n` fell through to
   * the filter and was typed as text — both keys dead.
   *
   * @param data - the raw input chunk.
   * @param keybindings - the registry to match against; defaults to the installed one.
   */
  handleInput(data: string, keybindings: KeybindingsManager = getKeybindings()): void {
    const isNav = NAV_ACTIONS.some((action) => keybindings.matches(data, action))
    if (isNav) {
      this.list.handleInput(data)
      return
    }
    this.search.handleInput(data)
    this.applyFilter(this.search.getValue())
  }

  /**
   * Re-filter the list in place, keeping the cursor on the same level.
   *
   * Replacing the `SelectList` rather than calling `setFilter` is pi's approach
   * and it is deliberate: `setFilter` can move the selection when the previously
   * highlighted row is filtered out, so the cursor would jump to whatever happens
   * to be first. Rebuilding with an explicit `preselect` keeps it where the user
   * left it, or on the current level when it is still visible.
   *
   * @param query - the filter text.
   */
  private applyFilter(query: string): void {
    // Keep the cursor on the row it was on: `setFilter` would move it to the first
    // match when the highlighted row is filtered out.
    const selected = this.list.getSelectedItem()?.value
    const filtered = query === ''
      ? this.allItems
      : fuzzyFilter([...this.allItems], query, (item) => `${String(item.value)} ${item.description ?? ''}`)
    this.list = this.buildList(filtered, selected)
    this.children[this.listIndex] = this.list
  }

  /**
   * Build a list over one item set.
   *
   * @param items - the rows to show.
   * @param preselect - value to put the cursor on; defaults to the current level.
   * @returns the list, wired to this selector's callbacks.
   */
  private buildList(items: readonly SelectItem[], preselect?: string): SelectList {
    const list = new SelectList([...items], Math.max(1, items.length), this.selectTheme, LAYOUT)
    const wanted = preselect ?? this.current
    const at = items.findIndex((item) => item.value === wanted)
    if (at !== -1) list.setSelectedIndex(at)
    list.onSelect = (item) => { this.onSelect(String(item.value)) }
    list.onCancel = () => { this.onCancel() }
    return list
  }
}

/**
 * The description for one level.
 *
 * pi's rule: the fixed cost table, plus `· default` on the profile's configured
 * level so "what will a fresh session use" is answerable from the menu. An
 * adapter-supplied description wins over the table — it knows the real budget.
 *
 * @param level - the level.
 * @param defaultLevel - the profile default, if any.
 * @returns the description text.
 */
function describe(level: ThinkingLevel, defaultLevel: string | undefined): string {
  const base = level.description ?? LEVEL_DESCRIPTIONS[level.id] ?? ''
  if (level.id !== defaultLevel) return base
  return base === '' ? 'default' : `${base} · default`
}

/**
 * The hint line under the list.
 *
 * Only keys this build actually routes: `enter` confirms, `escape` cancels. pi
 * also advertises `ctrl+s` (save as default) and the cycle key; neither has a
 * handler here, and a hint for a dead key is worse than no hint.
 *
 * @param theme - the palette.
 * @returns the hint text.
 */
function hint(theme: Theme): string {
  const text = '  enter to select · esc to cancel · type to filter'
  return theme.has('dim') ? theme.fg('dim', text) : text
}
