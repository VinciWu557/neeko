import { describe, expect, it } from 'vitest'
import { renderThemePicker, themePickerIntent, THEME_PICKER_MAX_VISIBLE } from '../src/tui/theme-picker.ts'
import { resolveTheme, findBuiltin } from '../src/tui/theme.ts'
import type { ThemePickerView } from '../src/tui/theme-controller.ts'

/**
 * The picker's two pure halves: the panel text and the key mapping.
 *
 * Both were extracted from `TuiApp` so they could be asserted without a screen —
 * the app keeps only the mount and the effect.
 */

const dark = resolveTheme(findBuiltin('dark')!)
const view: ThemePickerView = {
  index: 1,
  choices: [
    { name: 'dark', appearance: 'dark' },
    { name: 'light', appearance: 'light' },
    { name: 'ocean', appearance: 'dark', sourcePath: '/x/ocean.json' },
  ],
}

/** Strip ANSI so assertions read the layout, not the palette. */
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, '')

const key = (name: string) => (candidate: string): boolean => candidate === name

describe('renderThemePicker', () => {
  it('marks the cursor, the active theme, the appearance and the origin', () => {
    const text = plain(renderThemePicker(view, dark))
    // Cursor sits on `light` (index 1); the ACTIVE theme is `dark`.
    expect(text).toContain('→   light [light]')
    expect(text).toContain('  ✓ dark [dark]')
    expect(text).toContain('ocean [dark] · custom')
  })

  it('shows the key hints', () => {
    expect(plain(renderThemePicker(view, dark))).toContain('↑/↓ move, enter apply, esc cancel')
  })

  it('marks only the active theme with ✓', () => {
    const text = plain(renderThemePicker(view, dark))
    expect(text.match(/✓/gu)).toHaveLength(1)
  })

  it('marks custom themes and leaves built-ins unmarked', () => {
    const lines = plain(renderThemePicker(view, dark)).split('\n')
    expect(lines.find((line) => line.includes('ocean'))).toContain('· custom')
    expect(lines.find((line) => line.includes('[dark]') && line.includes('dark'))).not.toContain('· custom')
  })

  it('brackets the list with rules', () => {
    const lines = plain(renderThemePicker(view, dark)).split('\n')
    expect(lines[0]).toMatch(/^─+$/)
    expect(lines.at(-1)).toMatch(/^─+$/)
  })
})

describe('themePickerIntent', () => {
  it('maps escape to close', () => {
    expect(themePickerIntent(key('escape'))).toEqual({ kind: 'close' })
  })

  it('maps the arrows to movement (up is -1)', () => {
    expect(themePickerIntent(key('up'))).toEqual({ kind: 'move', delta: -1 })
    expect(themePickerIntent(key('down'))).toEqual({ kind: 'move', delta: 1 })
  })

  it('maps enter to confirm', () => {
    expect(themePickerIntent(key('enter'))).toEqual({ kind: 'confirm' })
  })

  it('ignores every other key', () => {
    expect(themePickerIntent(key('x'))).toEqual({ kind: 'ignore' })
  })

  it('checks escape before the others', () => {
    // A key that matched everything must still read as a cancel.
    expect(themePickerIntent(() => true)).toEqual({ kind: 'close' })
  })
})

describe('renderThemePicker — windowing', () => {
  const many = (count: number): ThemePickerView => ({
    index: 0,
    choices: Array.from({ length: count }, (_, i) => ({ name: `t${i}`, appearance: 'dark' as const })),
  })

  it('renders every row when the catalogue fits', () => {
    const lines = plain(renderThemePicker(many(3), dark)).split('\n')
    for (const name of ['t0', 't1', 't2']) {
      expect(lines.some((line) => line.includes(name))).toBe(true)
    }
  })

  it('caps the panel height regardless of catalogue size', () => {
    // Regression: a user with many theme files pushed the editor off screen
    // while the picker still owned the keyboard.
    const lines = (count: number): number =>
      plain(renderThemePicker(many(count), dark)).split('\n').length
    // At the limit: rule + header + N rows + rule.
    expect(lines(THEME_PICKER_MAX_VISIBLE)).toBe(THEME_PICKER_MAX_VISIBLE + 3)
    // Over the limit: one more line (the `↓ N more` marker), NOT N more rows.
    expect(lines(200)).toBe(THEME_PICKER_MAX_VISIBLE + 4)
    expect(lines(2000)).toBe(lines(200))
  })

  it('reports the hidden entries instead of silently truncating', () => {
    const text = plain(renderThemePicker(many(200), dark))
    expect(text).toContain('↓ 190 more')
    expect(text).toContain('200 total')
  })

  it('keeps the cursor row visible however far down it moves', () => {
    const view: ThemePickerView = { index: 150, choices: many(200).choices }
    const lines = plain(renderThemePicker(view, dark)).split('\n')
    // The cursor marker and the (empty) active marker are separate columns.
    expect(lines.some((line) => line.startsWith('→') && line.includes('t150'))).toBe(true)
    // Both sides report what is out of view: 10 visible → 145 above, 45 below.
    expect(lines.some((line) => line.includes('↑ 145 more'))).toBe(true)
    expect(lines.some((line) => line.includes('↓ 45 more'))).toBe(true)
  })

  it('honours an explicit maxVisible', () => {
    const lines = plain(renderThemePicker(many(50), dark, 3)).split('\n')
    // rule + header + 3 rows + 1 overflow marker + rule
    expect(lines).toHaveLength(7)
  })

  it('defaults to pi\'s ten-row window', () => {
    expect(THEME_PICKER_MAX_VISIBLE).toBe(10)
    expect(plain(renderThemePicker(many(50), dark)).split('\n')).toHaveLength(14)
  })
})
