import { describe, expect, it } from 'vitest'
import { movedIndex, pickerIntent } from '../src/tui/picker.ts'

/**
 * The two decisions every selector shares.
 *
 * `picker.ts` used to also own the panel chrome (`renderPanel`) and a generic
 * `runPickerKey`. Both were removed once the panels became `SelectList`
 * components: the chrome is now `DynamicBorder` + the list, and the key routing is
 * the list's own `handleInput`.
 *
 * What is left is the part no component can own — what a key *means* when a
 * selector is open, and where the cursor lands after a move.
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


describe('pickerIntent — precedence', () => {
  it('checks escape before the others', () => {
    // A key that matched everything must still read as a cancel, or a terminal
    // sending a combined sequence would apply the highlighted entry instead of
    // dismissing the panel.
    expect(pickerIntent(() => true)).toEqual({ kind: 'close' })
  })
})
