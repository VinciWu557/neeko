import { describe, expect, it } from 'vitest'
import { movedIndex, pickerIntent, renderPanel, runPickerKey } from '../src/tui/picker.ts'

/**
 * The selector skeleton every panel shares.
 *
 * One home for the three things `/model`, `/theme` and `/thinking` each used to
 * carry separately: the key→intent table, the cursor rule, and the panel chrome.
 */

const key = (name: string) => (candidate: string): boolean => candidate === name

describe('pickerIntent', () => {
  it('maps the four shared keys', () => {
    expect(pickerIntent(key('escape'))).toEqual({ kind: 'close' })
    expect(pickerIntent(key('up'))).toEqual({ kind: 'move', delta: -1 })
    expect(pickerIntent(key('down'))).toEqual({ kind: 'move', delta: 1 })
    expect(pickerIntent(key('enter'))).toEqual({ kind: 'confirm' })
  })

  it('swallows everything else', () => {
    // A selector owns the screen; a stray key must not reach the editor behind it.
    expect(pickerIntent(key('x'))).toEqual({ kind: 'ignore' })
  })
})

describe('movedIndex', () => {
  it('clamps at both ends instead of wrapping', () => {
    // pi-tui's own `SelectList` clamps. Wrapping also jumps the *window*, so the
    // screen scrolls somewhere the user did not ask for.
    expect(movedIndex(0, -1, 3)).toBe(0)
    expect(movedIndex(2, 1, 3)).toBe(2)
    expect(movedIndex(1, 1, 3)).toBe(2)
    expect(movedIndex(1, -1, 3)).toBe(0)
  })

  it('keeps the cursor at 0 for an empty list', () => {
    expect(movedIndex(0, 1, 0)).toBe(0)
    expect(movedIndex(5, -1, 0)).toBe(0)
  })
})

describe('renderPanel', () => {
  const plain = { fg: (_token: string, text: string): string => text }

  const panel = (over: Partial<Parameters<typeof renderPanel>[0]> = {}): string[] =>
    renderPanel({
      title: 'Theme',
      rows: [{ text: 'dark', active: true }, { text: 'light' }],
      index: 0,
      theme: plain,
      ...over,
    }).split('\n')

  it('draws the cursor and the active marker on separate axes', () => {
    // `→` follows the cursor, `✓` follows what is in effect: moving the cursor
    // must never claim the value already changed.
    const lines = panel({ index: 1 })
    // Row 0 is active but not under the cursor; row 1 has the cursor, not `✓`.
    expect(lines[2]).toBe('  ✓ dark')
    expect(lines[3]).toBe('→   light')
  })

  it('frames the rows with rules and a titled hint', () => {
    const lines = panel()
    expect(lines[0]).toMatch(/^─+$/)
    expect(lines[1]).toContain('Theme')
    expect(lines[1]).toContain('↑/↓ move, enter apply, esc cancel')
    expect(lines.at(-1)).toMatch(/^─+$/)
  })

  it('lets a selector override the hint', () => {
    // The theme picker windows its catalogue and reports the total instead.
    expect(panel({ hint: '12 total' })[1]).toContain('12 total')
  })

  it('appends notes below the rows', () => {
    const lines = panel({ notes: ['  (provider default — no level pinned)'] })
    expect(lines.at(-2)).toContain('provider default')
  })

  it('uses one panel width for every selector', () => {
    // The two panels had different rule widths before, which read as two
    // different widgets.
    expect(panel()[0]).toHaveLength(50)
    expect(panel({ title: 'Thinking level' })[0]).toHaveLength(50)
  })
})

describe('pickerIntent — precedence', () => {
  it('checks escape before the others', () => {
    // A key that matched everything must still read as a cancel, or a terminal
    // sending a combined sequence would apply the highlighted entry instead of
    // dismissing the panel.
    expect(pickerIntent(() => true)).toEqual({ kind: 'close' })
  })
})

describe('runPickerKey', () => {
  function harness(state: { index: number; length: number } | undefined, pressed: string) {
    const calls: string[] = []
    const result = runPickerKey({
      state,
      data: 'x',
      isKey: key(pressed),
      onMove: (index) => calls.push(`move:${index}`),
      onClose: () => calls.push('close'),
      onConfirm: () => calls.push('confirm'),
    })
    return { calls, result }
  }

  it('moves by the clamped index, not by a delta the caller re-derives', () => {
    // Handing the *resolved* index out means no selector can re-implement the
    // rule differently (one of them used to wrap).
    expect(harness({ index: 0, length: 3 }, 'down').calls).toEqual(['move:1'])
    expect(harness({ index: 2, length: 3 }, 'down').calls).toEqual(['move:2'])
    expect(harness({ index: 0, length: 3 }, 'up').calls).toEqual(['move:0'])
  })

  it('routes close and confirm', () => {
    expect(harness({ index: 1, length: 3 }, 'escape').calls).toEqual(['close'])
    expect(harness({ index: 1, length: 3 }, 'enter').calls).toEqual(['confirm'])
  })

  it('swallows an unrelated key rather than leaking it', () => {
    expect(harness({ index: 0, length: 2 }, 'x').calls).toEqual([])
    expect(harness({ index: 0, length: 2 }, 'x').result).toEqual({ consume: true })
  })

  it('consumes without acting when no selector is open', () => {
    expect(harness(undefined, 'enter').calls).toEqual([])
  })
})
