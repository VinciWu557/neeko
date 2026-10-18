import { describe, expect, it } from 'vitest'
import { listWindow, overflowMarkers } from '../src/tui/window.ts'

/**
 * The list-window math every selector shares.
 *
 * These cases pin the two properties that make a windowed list usable: the
 * cursor is always visible, and the window never leaves the list. A selector
 * whose cursor scrolls off the window is unusable in exactly the way the theme
 * picker was before it was windowed.
 */

describe('listWindow', () => {
  it('returns an empty window for an empty list', () => {
    expect(listWindow(0, 0, 10)).toEqual({
      start: 0, end: 0, cursorRow: 0, total: 0, hiddenAbove: 0, hiddenBelow: 0,
    })
  })

  it('renders everything when the list fits', () => {
    expect(listWindow(3, 1, 10)).toEqual({
      start: 0, end: 3, cursorRow: 1, total: 3, hiddenAbove: 0, hiddenBelow: 0,
    })
  })

  it('windows a long list and centres the cursor', () => {
    const window = listWindow(100, 50, 10)
    expect(window.end - window.start).toBe(10)
    expect(window.cursorRow).toBe(5) // centred
    expect(window.hiddenAbove).toBe(45)
    expect(window.hiddenBelow).toBe(45)
  })

  it('keeps the cursor inside the window at both ends', () => {
    for (const cursor of [0, 1, 4, 5, 95, 98, 99]) {
      const window = listWindow(100, cursor, 10)
      expect(window.start).toBeGreaterThanOrEqual(0)
      expect(window.end).toBeLessThanOrEqual(100)
      expect(window.start + window.cursorRow).toBe(cursor)
      expect(window.cursorRow).toBeGreaterThanOrEqual(0)
      expect(window.cursorRow).toBeLessThan(10)
    }
  })

  it('clamps to the list start and end instead of leaving it', () => {
    expect(listWindow(100, 0, 10)).toMatchObject({ start: 0, cursorRow: 0, hiddenAbove: 0 })
    expect(listWindow(100, 99, 10)).toMatchObject({ start: 90, cursorRow: 9, hiddenBelow: 0 })
  })

  it('clamps an out-of-range cursor rather than producing a negative row', () => {
    expect(listWindow(5, -3, 2).cursorRow).toBe(0)
    expect(listWindow(5, 99, 2).cursorRow).toBe(1)
  })

  it('treats maxVisible below 1 as 1', () => {
    expect(listWindow(10, 4, 0)).toMatchObject({ start: 4, end: 5, cursorRow: 0 })
  })

  it('always accounts for every entry', () => {
    for (const total of [1, 2, 10, 11, 57]) {
      for (const maxVisible of [1, 3, 10]) {
        const window = listWindow(total, 0, maxVisible)
        const rendered = window.end - window.start
        expect(window.hiddenAbove + rendered + window.hiddenBelow).toBe(total)
      }
    }
  })
})

describe('overflowMarkers', () => {
  const plain = (token: string, text: string): string => `[${token}]${text}`

  it('is silent when nothing is hidden', () => {
    const window = listWindow(3, 0, 10)
    expect(overflowMarkers(window, plain)).toEqual(['', ''])
  })

  it('reports hidden entries above and below', () => {
    const window = listWindow(100, 50, 10)
    const [above, below] = overflowMarkers(window, plain)
    expect(above).toContain('↑ 45 more')
    expect(below).toContain('↓ 45 more')
  })

  it('omits only the empty side', () => {
    const window = listWindow(100, 0, 10)
    const [above, below] = overflowMarkers(window, plain)
    expect(above).toBe('')
    expect(below).toContain('↓ 90 more')
  })
})
