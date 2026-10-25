import { describe, expect, it } from 'vitest'
import { stripAnsi } from './ansi.ts'

/**
 * The one ANSI stripper the suite shares.
 *
 * Seven test files had grown their own, and the rules had drifted apart:
 * `[0-9;]*m`, `[a-z0-9;]*m`, `[0-9;?]*[a-zA-Z]`, with the `_pi:` marker rule
 * present in only some. A test could therefore assert on text that a sibling
 * would have removed — the same failure the three `strip()` copies in
 * `tui-fullscreen.spec.ts` already produced once.
 */

describe('stripAnsi', () => {
  it('removes SGR colour sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[39m')).toBe('red')
  })

  it('removes the compound SGR a theme emits', () => {
    expect(stripAnsi('\x1b[38;2;97;175;239mblue\x1b[0m')).toBe('blue')
  })

  it('removes cursor and screen control sequences', () => {
    // Not just `m`: pi-tui also emits `H`, `J`, `K` and private modes.
    expect(stripAnsi('\x1b[2J\x1b[1;1Hrow\x1b[K')).toBe('row')
    expect(stripAnsi('\x1b[?25lhidden\x1b[?25h')).toBe('hidden\x1b[?25h'.replace('\x1b[?25h', ''))
  })

  it('removes OSC hyperlink sequences', () => {
    expect(stripAnsi('\x1b]8;;https://example.com\x07link\x1b]8;;\x07')).toBe('link')
  })

  it('removes pi-tui fake-cursor markers', () => {
    // `CURSOR_MARKER` is render-time protocol, never visible text. It arrives as
    // ESC `_pi:…` ESC `\\`, so the fixture must carry both escapes.
    expect(stripAnsi('abc\x1b_pi:fc\\def\x1b_pi:/fc\\ghi')).toBe('abcdefghi')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('plain text')).toBe('plain text')
    expect(stripAnsi('')).toBe('')
  })

  it('removes every rule at once', () => {
    // The files drifted by keeping only some rules; one pass must handle all.
    expect(stripAnsi('\x1b[38;2;1;2;3m\x1b]8;;u\x07pi\x1b]8;;\x07\x1b[0m\x1b_pi:fc\\')).toBe('pi')
  })
})
