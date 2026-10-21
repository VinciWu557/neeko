import { describe, expect, it, vi } from 'vitest'
import { SelectList } from '@earendil-works/pi-tui'
import type { SelectListTheme } from '@earendil-works/pi-tui'
import { ResumeSelector } from '../src/tui/resume-selector.ts'
import { resolveTheme } from '../src/tui/theme.ts'
import type { Theme } from '../src/tui/theme.ts'
import type { ResumeChoice } from '../src/tui/resume-list.ts'
import { stripAnsi } from './support/ansi.ts'

/**
 * The session picker, as a mounted `SelectList`.
 *
 * ## What the port removed
 *
 * The panel used to be a string: `renderPanel` computed a window (`listWindow`),
 * mapped the cursor into that window, and emitted `↑ N more` markers by hand —
 * while `SelectList` did its own windowing for the cursor. Two window
 * computations meant the visible rows and the highlighted row could disagree
 * after a page.
 *
 * ## What it deliberately kept
 *
 * `ResumeController` still owns the data, the paging and the title cache. pi's
 * `SessionSelectorComponent` is 892 lines of scope switching, sorting, delete,
 * rename and a background corpus scan; none of that has a counterpart here (dsh's
 * corpus already answers a scoped, newest-first list), so this file only renders.
 */

const palette: Theme = resolveTheme({ name: 'probe', appearance: 'dark', colors: {} } as never)

/** Colourless list theme, so rows are asserted as text. */
const selectTheme: SelectListTheme = {
  selectedPrefix: (text) => `> ${text}`,
  selectedText: (text) => text,
  description: (text) => text,
  scrollInfo: (text) => text,
  noMatch: (text) => text,
}

/** Build one row; the label is what `resume-list.ts` composed. */
function choice(id: string, text: string, over: Partial<ResumeChoice> = {}): ResumeChoice {
  return { id, text, current: false, hasHistory: true, ...over }
}

const ROWS: readonly ResumeChoice[] = [
  choice('s-new', 'newest work · one · 5m'),
  // The `[current]` marker is part of the label `resume-list.ts` composes; the
  // fixture spells it out so the "does not re-invent it" test has something to
  // find.
  choice('s-cur', 'current work · two · 1h · [current]', { current: true }),
  choice('s-old', 'older work · three · 2d'),
]

/**
 * Build a selector with recording callbacks.
 *
 * @param overrides - fields to override.
 * @returns the selector and its spies.
 */
function build(overrides: {
  choices?: readonly ResumeChoice[]
  selected?: string
  currentId?: string
} = {}): {
  selector: ResumeSelector
  onSelect: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
  text: () => string
} {
  const onSelect = vi.fn()
  const onCancel = vi.fn()
  const selector = new ResumeSelector({
    choices: overrides.choices ?? ROWS,
    selected: overrides.selected,
    currentId: overrides.currentId ?? 's-cur',
    selectTheme,
    palette,
    onSelect,
    onCancel,
  })
  return { selector, onSelect, onCancel, text: () => stripAnsi(selector.render(80).join('\n')) }
}

describe('ResumeSelector — the shape of the panel', () => {
  it('borders the list above and below, with no title', () => {
    // Two rules around the list. The old panel had a `Resume session` heading;
    // pi's session selector has no title, and a heading would cost a dock row.
    const lines = build().selector.render(60).map((line) => stripAnsi(line).trim())
    expect(lines[0]).toMatch(/^─+$/u)
    expect(lines[lines.length - 1]).toMatch(/^─+$/u)
    expect(build().text()).not.toContain('Resume session')
  })

  it('renders the controller row text verbatim', () => {
    // The label already carries the title, the age and the `[current]` marker
    // (`resume-list.ts`). Reformatting it here would be a second definition of
    // what a session row says.
    const text = build().text()
    for (const row of ROWS) expect(text).toContain(row.text)
  })

  it('does not re-invent the current marker', () => {
    // `SelectList` would happily accept a `✓` prefix; adding one would duplicate
    // the `[current]` the controller already put in the text.
    expect(build().text()).not.toContain('✓')
    expect(build().text()).toContain('[current]')
  })

  it('marks a session with no history', () => {
    // Every launch that exits without a prompt leaves one of these, and they sort
    // newest-first, so they bury what a user actually wants. Marked, not hidden:
    // they are still resumable.
    const rows = [choice('s-empty', 'never used · 1m', { hasHistory: false })]
    expect(build({ choices: rows }).text()).toContain('empty')
  })
})

describe('ResumeSelector — the cursor', () => {
  it('opens on the current session when it is not the first row', () => {
    // With the current session first, an implementation that always returns index
    // 0 would pass — so the fixture puts it second.
    const { selector } = build()
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('s-cur')
  })

  it('prefers an explicit selection over the current session', () => {
    // A page of titles arrived and the user had already moved: the cursor must
    // stay where they left it, not snap back to the current session.
    const { selector } = build({ selected: 's-old' })
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('s-old')
  })

  it('falls back to the first row when the selection is gone', () => {
    // A rescan can drop a session (deleted on disk between pages).
    const { selector } = build({ selected: 's-vanished' })
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('s-new')
  })
})

describe('ResumeSelector — keys', () => {
  it('selects the highlighted session on enter', () => {
    const { selector, onSelect } = build()
    selector.handleInput('\r')
    expect(onSelect).toHaveBeenCalledWith('s-cur')
  })

  it('moves the cursor before selecting', () => {
    const { selector, onSelect } = build()
    selector.handleInput('\x1b[B')
    selector.handleInput('\r')
    expect(onSelect).toHaveBeenCalledWith('s-old')
  })

  it('cancels on escape', () => {
    const { selector, onCancel } = build()
    selector.handleInput('\x1b')
    expect(onCancel).toHaveBeenCalled()
  })
})

describe('ResumeSelector — setChoices', () => {
  it('replaces the rows and keeps the cursor on the same session', () => {
    // A page of titles arrives asynchronously and rebuilds the list; without the
    // preselect the cursor would jump to row 0 on every page.
    const { selector } = build()
    selector.handleInput('\x1b[B') // s-cur -> s-old
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('s-old')
    selector.setChoices(
      [choice('s-new', 'newest work · one · 5m'), choice('s-cur', 'current work · two · 1h'), choice('s-old', 'older work · three · 2d · titled')],
      selectTheme,
      () => {},
      () => {},
    )
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('s-old')
  })

  it('swaps the mounted list rather than mutating a stale one', () => {
    // `SelectList` snapshot its items at construction, so a rebuild is the only
    // update path. The replacement has to be in `children`, or the panel would
    // keep painting the old rows while the new list held the cursor.
    const { selector } = build()
    const before = selector.getSelectList()
    selector.setChoices([choice('s-new', 'newest work')], selectTheme, () => {}, () => {})
    expect(selector.getSelectList()).not.toBe(before)
    expect(selector.children).toContain(selector.getSelectList())
  })

  it('uses the new callbacks after a rebuild', () => {
    // The rebuild re-wires `onSelect`; a leftover closure would call the old
    // owner's handler, which after a reopen is a stale app.
    const { selector } = build()
    const picked = vi.fn()
    selector.setChoices(ROWS, selectTheme, picked, () => {})
    selector.handleInput('\r')
    expect(picked).toHaveBeenCalled()
  })
})

describe('ResumeSelector — the list is a real SelectList', () => {
  it('owns its own cursor and visible window', () => {
    // Structural on purpose: the windowing arithmetic the old panel duplicated is
    // exactly what this component provides.
    expect(build().selector.getSelectList()).toBeInstanceOf(SelectList)
  })
})

describe('ResumeSelector — the highlight follows the controller', () => {
  /**
   * The controller owns `view.index`; the component owns the highlight. They are
   * two copies of one fact, so *something* has to keep them in step — and nothing
   * did.
   *
   * Measured before the fix, on four titled sessions: `↓` twice moved
   * `view.index` 0 → 1 → 2 while `SelectList.getSelectedItem()` stayed on the
   * first row. Pressing enter resumed the third session while the first one was
   * highlighted.
   *
   * `setChoices` rebuilt the list but derived its preselect from the *old* list's
   * selection, which is exactly the row that never moved.
   */
  const four: readonly ResumeChoice[] = [
    choice('s0', 'zero', { current: true }),
    choice('s1', 'one'),
    choice('s2', 'two'),
    choice('s3', 'three'),
  ]

  it('applies an explicit index when the rows are replaced', () => {
    const { selector } = build({ choices: four, currentId: 's0' })
    selector.setChoices(four, selectTheme, () => {}, () => {}, 2)
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('s2')
  })

  it('keeps the cursor when no index is given', () => {
    // A page of titles arriving must not move the cursor — the user is reading.
    const { selector } = build({ choices: four, currentId: 's0' })
    selector.handleInput('\x1b[B')
    const moved = selector.getSelectList().getSelectedItem()?.value
    expect(moved).toBe('s1')
    selector.setChoices(four, selectTheme, () => {}, () => {})
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('s1')
  })

  it('survives an index past the end of a shorter list', () => {
    // A rescan can drop sessions; clamping is the only answer that does not throw.
    const { selector } = build({ choices: four, currentId: 's0' })
    selector.setChoices([choice('s0', 'zero')], selectTheme, () => {}, () => {}, 3)
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('s0')
  })
})
