import { describe, expect, it, vi } from 'vitest'
import { SelectList } from '@earendil-works/pi-tui'
import type { SelectListTheme } from '@earendil-works/pi-tui'
import { ThemeSelector } from '../src/tui/theme-selector.ts'
import type { ThemeOption } from '../src/tui/theme-selector.ts'
import { resolveTheme } from '../src/tui/theme.ts'
import type { Theme } from '../src/tui/theme.ts'
import { stripAnsi } from './support/ansi.ts'

/**
 * The theme selector, transcribed from pi's `ThemeSelectorComponent`.
 *
 * ## The one capability this adds
 *
 * **Preview.** The previous picker rendered a string and could only change the
 * theme on `enter`, so choosing a palette meant reading names and trying them one
 * at a time. pi wires `SelectList.onSelectionChange` to an `onPreview` callback,
 * so moving the cursor recolours the TUI immediately — a theme is chosen by
 * looking at it.
 *
 * The rest of this file pins the smaller consequences: no title (pi has none),
 * the active theme marked in the description column, and the list owning its own
 * cursor rather than being driven by an index the caller passes in.
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

const THEMES: readonly ThemeOption[] = [
  { name: 'dark', appearance: 'dark' },
  { name: 'light', appearance: 'light' },
  { name: 'neeko-dark', appearance: 'dark', sourcePath: '/home/u/.dsh/themes/neeko-dark.json' },
]

/**
 * Build a selector with recording callbacks.
 *
 * @param overrides - fields to override.
 * @returns the selector and its spies.
 */
function build(overrides: {
  themes?: readonly ThemeOption[]
  current?: string
} = {}): {
  selector: ThemeSelector
  onSelect: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
  onPreview: ReturnType<typeof vi.fn>
  text: () => string
} {
  const onSelect = vi.fn()
  const onCancel = vi.fn()
  const onPreview = vi.fn()
  const selector = new ThemeSelector({
    themes: overrides.themes ?? THEMES,
    current: overrides.current ?? 'dark',
    selectTheme,
    palette,
    onSelect,
    onCancel,
    onPreview,
  })
  return {
    selector,
    onSelect,
    onCancel,
    onPreview,
    text: () => stripAnsi(selector.render(70).join('\n')),
  }
}

describe('ThemeSelector — the shape pi gives it', () => {
  it('borders the list above and below, with no title', () => {
    // pi's `ThemeSelectorComponent` adds a `DynamicBorder`, the list, and another
    // `DynamicBorder`. There is deliberately no heading: the list is the whole
    // panel, and a title would cost a row of the dock for nothing.
    const lines = build().selector.render(40).map((line) => stripAnsi(line).trim())
    expect(lines[0]).toMatch(/^─+$/u)
    expect(lines[lines.length - 1]).toMatch(/^─+$/u)
    expect(stripAnsi(build().text())).not.toContain('Theme')
  })

  it('lists every theme in the catalogue', () => {
    const text = build().text()
    for (const theme of THEMES) expect(text).toContain(theme.name)
  })

  it('marks the active theme in the description column', () => {
    // pi uses `(current)` in the *description*, not a `✓` on the label: the label
    // column then stays aligned across rows, and the cursor prefix keeps its one
    // meaning.
    const text = build({ current: 'light' }).text()
    expect(text).toContain('(current)')
    const rows = text.split('\n').filter((line) => /dark|light/u.test(line))
    expect(rows.find((line) => line.includes('light'))).toContain('(current)')
    expect(rows.find((line) => line.includes('(current)'))).not.toContain('neeko-dark')
  })

  it('shows each theme appearance, so a name is not a guess', () => {
    expect(build().text()).toContain('[dark]')
    expect(build().text()).toContain('[light]')
  })

  it('marks a theme that came from a file', () => {
    // Built-in versus custom matters: a custom theme can break on a hand edit, and
    // knowing which is which is the first step in debugging one.
    const rows = build().text().split('\n')
    expect(rows.find((line) => line.includes('neeko-dark'))).toContain('custom')
    expect(rows.find((line) => line.includes('light'))).not.toContain('custom')
  })

  it('opens with the cursor on the active theme', () => {
    // Otherwise `enter` immediately switches away from the theme the user is
    // already looking at.
    expect(build({ current: 'light' }).selector.getSelectList().getSelectedItem()?.value).toBe('light')
  })
})

describe('ThemeSelector — preview', () => {
  it('previews the highlighted theme as the cursor moves', () => {
    // The reason for the port: choosing a palette by reading names is guesswork.
    const { selector, onPreview } = build({ current: 'dark' })
    selector.handleInput('\x1b[B')
    expect(onPreview).toHaveBeenCalledWith('light')
  })

  it('does not commit while previewing', () => {
    // A preview must be reversible; committing on move would make `esc` unable to
    // put the theme back.
    const { selector, onSelect } = build({ current: 'dark' })
    selector.handleInput('\x1b[B')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('commits the highlighted theme on enter', () => {
    const { selector, onSelect } = build({ current: 'dark' })
    selector.handleInput('\x1b[B')
    selector.handleInput('\r')
    expect(onSelect).toHaveBeenCalledWith('light')
  })
})

describe('ThemeSelector — keys', () => {
  it('cancels on escape', () => {
    const { selector, onCancel } = build()
    selector.handleInput('\x1b')
    expect(onCancel).toHaveBeenCalled()
  })

  it('moves up as well as down', () => {
    const { selector } = build({ current: 'light' })
    selector.handleInput('\x1b[A')
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('dark')
  })

  it('walks past the visible window with the arrow keys', () => {
    // `SelectList` computes its own visible window from `maxVisible` and moves the
    // window as the cursor leaves it — the old renderer did that by hand
    // (`listWindow` + `overflowMarkers` + mapping the cursor into the slice).
    //
    // Note what `SelectList.handleInput` does **not** support: `pageUp`/`pageDown`.
    // It handles exactly `tui.select.up` / `down` / `confirm` / `cancel`, and both
    // arrows wrap. Measured, not assumed.
    const many: readonly ThemeOption[] = Array.from({ length: 30 }, (_, index) => ({
      name: `theme-${String(index).padStart(2, '0')}`,
      appearance: 'dark' as const,
    }))
    const { selector } = build({ themes: many, current: 'theme-00' })
    for (let step = 0; step < 12; step += 1) selector.handleInput('\x1b[B')
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('theme-12')
  })

  it('wraps from the last row back to the first, as SelectList does', () => {
    // Recorded because it is a visible difference from the old panel, which
    // clamped at both ends.
    const { selector } = build({ current: 'neeko-dark' })
    selector.handleInput('\x1b[B')
    expect(selector.getSelectList().getSelectedItem()?.value).toBe('dark')
  })
})

describe('ThemeSelector — the list is a real SelectList', () => {
  it('owns its own cursor', () => {
    // Structural on purpose: paging, the visible window and hit-testing all come
    // from pi-tui's component, and a string renderer cannot provide them.
    expect(build().selector.getSelectList()).toBeInstanceOf(SelectList)
  })
})
