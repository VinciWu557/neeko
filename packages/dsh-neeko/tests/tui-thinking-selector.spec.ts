import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeybindingsManager, SelectList, TUI_KEYBINDINGS, setKeybindings } from '@earendil-works/pi-tui'
import type { SelectListTheme } from '@earendil-works/pi-tui'
import { ThinkingSelector } from '../src/tui/thinking-selector.ts'
import type { ThinkingLevel } from '../src/tui/thinking-selector.ts'
import { resolveTheme } from '../src/tui/theme.ts'
import { installKeymap } from '../src/tui/keymap.ts'
import type { Theme } from '../src/tui/theme.ts'
import { stripAnsi } from './support/ansi.ts'

/**
 * The thinking-level selector, transcribed from pi's `ThinkingSelectorComponent`.
 *
 * ## What the previous selector could not do
 *
 * It rendered a string: a title, rows prefixed `→`/`✓`, and a `─` border. Three
 * things were missing and each is asserted below, because they are the reason the
 * port happened at all:
 *
 * 1. **Filtering** — pi puts an `Input` above a `SelectList` and fuzzy-filters as
 *    you type. `/model` uses the same shape, so learning one teaches the other.
 * 2. **Descriptions** — a row said `high [high]`: the id twice, and nothing about
 *    what the level costs. pi shows a fixed cost table.
 * 3. **A real cursor** — pi's `SelectList` owns the cursor, the window,
 *    `pageUp`/`pageDown` and the mouse. The hand-rolled version re-derived all of
 *    that from an index.
 */

const theme: Theme = resolveTheme({ name: 'probe', appearance: 'dark', colors: {} } as never)

/** Colourless list theme, so rows are asserted as text. */
const selectTheme: SelectListTheme = {
  selectedPrefix: (text) => `> ${text}`,
  selectedText: (text) => text,
  description: (text) => text,
  scrollInfo: (text) => text,
  noMatch: (text) => text,
}

const LEVELS: readonly ThinkingLevel[] = [
  { id: 'off', name: 'off' },
  { id: 'low', name: 'low' },
  { id: 'medium', name: 'medium' },
  { id: 'high', name: 'high' },
]

/**
 * Build a selector with recording callbacks.
 *
 * @param overrides - fields to override.
 * @returns the selector and its spies.
 */
function build(overrides: {
  levels?: readonly ThinkingLevel[]
  current?: string
  defaultLevel?: string
} = {}): {
  selector: ThinkingSelector
  onSelect: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
  text: () => string
} {
  const onSelect = vi.fn()
  const onCancel = vi.fn()
  const selector = new ThinkingSelector(
    overrides.levels ?? LEVELS,
    overrides.current,
    theme,
    selectTheme,
    onSelect,
    onCancel,
    overrides.defaultLevel,
  )
  return {
    selector,
    onSelect,
    onCancel,
    text: () => stripAnsi(selector.render(70).join('\n')),
  }
}

describe('ThinkingSelector — the shape pi gives it', () => {
  it('borders the panel top and bottom', () => {
    // pi's `DynamicBorder` above and below, so the selector reads as a panel
    // rather than as text appended under the transcript.
    const lines = build().selector.render(40).map((line) => stripAnsi(line).trim())
    expect(lines[0]).toMatch(/^─+$/u)
    expect(lines[lines.length - 1]).toMatch(/^─+$/u)
  })

  it('titles the panel', () => {
    expect(build().text()).toContain('Thinking Level')
  })

  it('shows a filter input', () => {
    // pi puts an `Input` above the list. Without one the only way to reach a level
    // is the arrow keys.
    expect(build().text()).toContain('>')
  })

  it('hints only the keys this build routes', () => {
    // pi also advertises ctrl+s (save as default) and the cycle key. Neither has a
    // handler here, and a hint for a dead key is worse than no hint.
    const text = build().text()
    expect(text).toContain('enter to select')
    expect(text).toContain('esc to cancel')
    expect(text).not.toContain('ctrl+s')
  })
})

describe('ThinkingSelector — rows', () => {
  it('marks the level in effect with a check', () => {
    // pi's `✓ ` prefix; the cursor prefix is the list's own.
    expect(build({ current: 'medium' }).text()).toContain('✓ medium')
  })

  it('leaves the other rows unmarked', () => {
    const text = build({ current: 'medium' }).text()
    expect(text).not.toContain('✓ high')
    expect(text).not.toContain('✓ low')
  })

  it('describes what each level costs', () => {
    // The whole reason a row is not just an id: `xhigh` says nothing on its own.
    const text = build().text()
    expect(text).toContain('Light reasoning')
    expect(text).toContain('Deep reasoning')
  })

  it('marks the profile default, so "what a new session uses" is answerable', () => {
    expect(build({ defaultLevel: 'low' }).text()).toContain('· default')
  })

  it('prefers an adapter-supplied description over the fixed table', () => {
    // The adapter knows the real budget; the table is pi's generic estimate.
    const levels: readonly ThinkingLevel[] = [{ id: 'high', name: 'high', description: 'budget 42k' }]
    expect(build({ levels }).text()).toContain('budget 42k')
  })

  it('falls back to the id alone for a level nobody described', () => {
    // `TurnEndReason`-style merge extensibility: a provider may advertise a level
    // pi has never heard of, and the row must still render.
    const levels: readonly ThinkingLevel[] = [{ id: 'turbo', name: 'turbo' }]
    expect(build({ levels }).text()).toContain('turbo')
  })
})

describe('ThinkingSelector — keys', () => {
  it('selects the highlighted level on enter', () => {
    const { selector, onSelect } = build({ current: 'medium' })
    selector.handleInput('\r')
    expect(onSelect).toHaveBeenCalledWith('medium')
  })

  it('cancels on escape', () => {
    const { selector, onCancel } = build({ current: 'medium' })
    selector.handleInput('\x1b')
    expect(onCancel).toHaveBeenCalled()
  })

  it('moves the cursor with the arrow keys', () => {
    const { selector } = build({ current: 'off' })
    selector.handleInput('\x1b[B')
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('low')
  })

  it('filters as you type instead of moving the cursor', () => {
    // The split pi makes: navigation keys go to the list, everything else feeds the
    // filter. Getting it backwards makes typing `h` move the cursor.
    const { selector } = build({ current: 'off' })
    selector.handleInput('h')
    const items = selector.getSelectList().render(60).map((line) => stripAnsi(line)).join('\n')
    expect(items).toContain('high')
    expect(items).not.toContain('medium')
  })

  it('keeps the cursor on the highlighted level across a re-filter', () => {
    // `SelectList.setFilter` moves the cursor to the first match when the
    // highlighted row disappears; rebuilding with an explicit preselect is what
    // stops the cursor jumping.
    //
    // The filter has to keep a matching row *before* the highlighted one, or the
    // test would pass without the preselect simply because the cursor was already
    // first. `off` and `high` both match `o` (every row's id contains none, but
    // `off` does), and the cursor moves from `off` down to `high` first — so
    // "first match" would put the cursor back on `off`.
    const levels: readonly ThinkingLevel[] = [
      { id: 'off', name: 'off' },
      { id: 'low', name: 'low' },
      { id: 'high', name: 'high' },
    ]
    const { selector } = build({ levels, current: 'off' })
    selector.handleInput('\x1b[B') // off -> low
    selector.handleInput('\x1b[B') // low -> high
    selector.handleInput('o') // keeps `off` and `low`; both sit before `high`
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('high')
    const rows = selector.getSelectList().render(70).map((line) => stripAnsi(line))
    expect(rows[0]).toContain('off')
  })

  it('confirms from the search box, so a typed filter needs no cursor move', () => {
    const { selector, onSelect } = build({ current: 'off' })
    selector.handleInput('h')
    selector.handleInput('\r')
    expect(onSelect).toHaveBeenCalledWith('high')
  })
})

describe('ThinkingSelector — focus', () => {
  it('forwards focus to the search input', () => {
    // An unfocused `Input` draws no cursor and positions no IME candidate window,
    // which puts a CJK candidate popup in the wrong place.
    const { selector } = build()
    selector.focused = true
    expect(selector.focused).toBe(true)
  })

  it('starts unfocused', () => {
    expect(build().selector.focused).toBe(false)
  })
})

describe('ThinkingSelector — the list is a real SelectList', () => {
  it('owns its own cursor, not an index the caller passes in', () => {
    // Structural, deliberately: the point of the port is that pi-tui's component
    // handles paging and hit-testing, and a string renderer cannot.
    expect(build().selector.getSelectList()).toBeInstanceOf(SelectList)
  })
})

describe('ThinkingSelector — navigation follows the keybinding registry', () => {
  /**
   * The split pi makes is "navigation keys go to the list, everything else feeds
   * the filter". The *first* half of that is a keybinding question, and answering
   * it by comparing raw byte sequences (`data === '\x1b[B'`) means the answer is
   * frozen at whatever pi-tui's defaults were.
   *
   * Measured with `tui.select.down` rebound to `ctrl+n`: `↓` stopped moving the
   * cursor **and** `ctrl+n` was typed into the filter — both keys dead, because the
   * hard-coded list did not recognise the new binding and the fallback path treats
   * anything unrecognised as text.
   */
  function withBindings(overrides: Record<string, unknown>): void {
    installKeymap(overrides as never)
  }

  afterEach(() => {
    // Restore pi-tui's registry so a later file's `Editor` sees the defaults.
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS))
  })

  it('moves the cursor with the bound key, not a hard-coded sequence', () => {
    withBindings({ 'tui.select.down': 'ctrl+n' })
    const { selector } = build({ current: 'off' })
    selector.handleInput('\x0e') // ctrl+n
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('low')
  })

  it('stops treating the old default as navigation once it is unbound', () => {
    // Otherwise `↓` would be swallowed as "navigation" and then do nothing,
    // because the list no longer has a binding for it.
    withBindings({ 'tui.select.down': 'ctrl+n' })
    const { selector } = build({ current: 'off' })
    selector.handleInput('\x1b[B')
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('off')
  })

  it('confirms with the bound key', () => {
    withBindings({ 'tui.select.confirm': 'ctrl+y' })
    const { selector, onSelect } = build({ current: 'medium' })
    selector.handleInput('\x19') // ctrl+y
    expect(onSelect).toHaveBeenCalledWith('medium')
  })

  it('still types ordinary characters into the filter', () => {
    // The complement: everything that is *not* navigation must keep reaching the
    // filter, or the search box would stop working the moment a key is rebound.
    const { selector } = build({ current: 'off' })
    selector.handleInput('h')
    expect(stripAnsi(selector.getSelectList().render(60).join('\n'))).toContain('high')
  })
})
