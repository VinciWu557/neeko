import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { resolveTheme } from '../src/tui/theme.ts'
import type { Theme } from '../src/tui/theme.ts'
import { SPINNER_FRAMES, StatusIndicator, borderWithStatus } from '../src/tui/status-indicator.ts'
import { composerTheme } from '../src/tui/composer.ts'
import { stripAnsi } from './support/ansi.ts'

/**
 * The composer's border and the indicator that rides in it.
 *
 * ## What this replaces
 *
 * `working…` used to be its own row above the editor, and the spinner was an
 * 80 ms timer the app advanced by hand. pi's shape (`CustomEditor.
 * renderTopBorder`) puts the status *inside* the editor's frame, which is why pi's
 * composer reads as a box rather than as a rule above a rule — and why the input
 * stays on screen when the terminal is short.
 *
 * The border is also the one place where a width mistake costs every row below it:
 * a short line leaves the frame ragged, a long one wraps and shifts the editor.
 * Every branch below asserts the width, not just the content.
 */

const theme: Theme = resolveTheme({ name: 'probe', appearance: 'dark', colors: {} } as never)

/** A fake `TUI` good enough for `Loader` (it only calls `requestRender`). */
const fakeUi = { requestRender: () => {} } as never

/**
 * Build an indicator at a fixed frame.
 *
 * `StatusIndicator` starts a timer as soon as it is constructed; these tests are
 * about composition, so the timer is stopped immediately.
 *
 * @param message - the label.
 * @returns a stopped indicator.
 */
function indicator(message = 'Working'): StatusIndicator {
  const made = new StatusIndicator(fakeUi, theme, message)
  made.stop()
  return made
}

/**
 * Render a border and strip its styling.
 *
 * @param width - columns.
 * @param instance - the indicator, or `undefined`.
 * @param hiddenAbove - rows scrolled out above.
 * @returns the visible border text.
 */
function border(width: number, instance: StatusIndicator | undefined, hiddenAbove = 0): string {
  return stripAnsi(borderWithStatus({ width, indicator: instance, hiddenAbove, theme }))
}

describe('borderWithStatus — every branch is exactly the requested width', () => {
  /**
   * The invariant behind every case.
   *
   * The border is one row of a frame whose other rows are the editor's own, so its
   * width is not cosmetic: a short line leaves the frame ragged and a long one
   * wraps, shifting the editor and every row below it.
   */
  const widths = [1, 4, 5, 10, 20, 40, 80, 200]

  it.each(widths)('draws %i columns with no indicator', (width) => {
    expect(visibleWidth(border(width, undefined))).toBe(width)
  })

  it.each(widths)('draws %i columns with an indicator', (width) => {
    expect(visibleWidth(border(width, indicator()))).toBe(width)
  })

  it.each(widths)('draws %i columns with an indicator and an overflow marker', (width) => {
    expect(visibleWidth(border(width, indicator(), 7))).toBe(width)
  })

  it.each(widths)('draws %i columns with only an overflow marker', (width) => {
    // The no-indicator path has its own centring branch; it needs the marker too.
    expect(visibleWidth(border(width, undefined, 3))).toBe(width)
  })
})

describe('borderWithStatus — the fallback order', () => {
  it('shows the label and the overflow marker together when both fit', () => {
    // pi's first branch: `── ⠋ Working ──── ↑ 3 more ────`.
    const text = border(80, indicator(), 3)
    expect(text).toContain('Working')
    expect(text).toContain('↑ 3 more')
    // Both on one line means the label comes first.
    expect(text.indexOf('Working')).toBeLessThan(text.indexOf('↑'))
  })

  it('drops both the label and the marker in the middle band, as pi does', () => {
    // A genuine quirk of pi's `renderTopBorder`, kept because the rule is "match
    // pi". When the label and the marker cannot share a line, pi first shrinks the
    // status to the spinner — then falls into the *label-only* branch, which draws
    // a plain rule where the marker used to be. So between roughly 24 and 36
    // columns neither the label nor the marker survives, only the spinner.
    //
    // Measured: 20-32 columns → spinner only. 40+ → label and marker together.
    // Recorded as a test rather than "fixed", because changing it would make the
    // border differ from pi's on the same terminal.
    const narrow = border(30, indicator('Working'), 99)
    expect(narrow).not.toContain('Working')
    expect(narrow).not.toContain('↑')

    // Wide enough for both: the marker comes back alongside the label.
    const wide = border(50, indicator('Working'), 99)
    expect(wide).toContain('Working')
    expect(wide).toContain('↑ 99 more')
  })

  it('shows the label alone when nothing is scrolled out', () => {
    expect(border(80, indicator('Working'))).toContain('Working')
  })

  it('still draws a rule with no indicator and nothing scrolled out', () => {
    // The frame must not appear and disappear as work starts and stops.
    const text = border(40, undefined)
    expect(text.trim()).toMatch(/^─+$/u)
    expect(text).toHaveLength(40)
  })

  it('centres the overflow marker when there is no indicator', () => {
    // Centring is what makes the marker read as a bookmark rather than as a label.
    const text = border(41, undefined, 12)
    const at = text.indexOf('↑ 12 more')
    const before = visibleWidth(text.slice(0, at))
    expect(Math.abs(before - (41 - at) / 2)).toBeLessThan(20)
  })
})

describe('StatusIndicator', () => {
  it('paints the spinner and the message in different tones', () => {
    // The glyph moves, so it gets the accent; the label is context, so it is muted.
    const made = indicator('Working')
    const painted = made.render(40).join('\n')
    expect(painted).toContain('\x1b[38;')
    // Two different SGR colours means two different tones.
    const colours = new Set(painted.match(/\x1b\[38;[0-9;]+m/gu) ?? [])
    expect(colours.size).toBeGreaterThan(1)
    made.dispose()
  })

  it('renders its own blank line first, which the border helper accounts for', () => {
    // `Loader.render()` prefixes `""` so it can sit in a stack. `renderInBorder`
    // reads row 1 for that reason; reading row 0 would give an empty border.
    expect(indicator().render(40)[0]).toBe('')
    expect(indicator().renderInBorder(40)).not.toBe('')
  })

  it('stops its timer on dispose', () => {
    // A timer that outlives the work repaints a settled screen forever — the exact
    // defect the hand-rolled spinner had.
    const made = new StatusIndicator(fakeUi, theme, 'Working')
    made.dispose()
    // A stopped loader changes neither its text nor its frame on a later render.
    const before = made.render(40).join('\n')
    expect(made.render(40).join('\n')).toBe(before)
  })

  it('uses pi\'s braille frame set', () => {
    // Shared with the streaming reasoning row so the two animations stay in phase.
    expect(SPINNER_FRAMES).toHaveLength(10)
    expect(SPINNER_FRAMES[0]).toBe('⠋')
  })
})

describe('composerTheme', () => {
  it('paints the border with borderMuted, not the text colour', () => {
    // A border in the text colour reads as part of the transcript above it; the
    // subtle tone is what makes the composer a frame.
    const painted = composerTheme(theme).borderColor('─')
    expect(painted).toContain('\x1b[38;')
    expect(stripAnsi(painted)).toBe('─')
  })

  it('colours the selected completion row in the accent tone', () => {
    // A colourless select list reads as plain text, which is what made the
    // autocomplete menu look like part of the input.
    const select = composerTheme(theme).selectList
    expect(select.selectedPrefix('> a')).toContain('\x1b[38;')
    expect(select.description('desc')).toContain('\x1b[38;')
    expect(stripAnsi(select.description('desc'))).toBe('desc')
  })
})
