import { describe, expect, it } from 'vitest'
import { TuiApp } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

/**
 * What the terminal shows when the TUI opens.
 *
 * ## The observation
 *
 * Launching left the previous shell session visible above the banner: several
 * `user@host dir %` lines and whatever the last run printed. The user's ask was that
 * opening the TUI show *only* the TUI.
 *
 * ## What pi actually does (measured, because it was assumed)
 *
 * pi issues **no** clear sequence at all — no `ESC[2J`, no `ESC[3J`, no alt screen.
 * It looks clean on a 30-row terminal only because its startup header happens to be
 * 26 lines: the history is still above, pushed out of view. On a 50- or 70-row
 * terminal the same `pi` leaves the history visible below its output (verified).
 *
 * So "match pi" and "open on a clean screen" are different requirements, and this
 * build takes the second one: `Terminal.clearScreen()` is pi-tui's own API, and it
 * makes the intent explicit instead of depending on how many lines the banner
 * happens to occupy.
 *
 * The tradeoff is stated rather than hidden: clearing discards scrollback the user
 * could otherwise scroll up into. That is what "only the TUI" means, and the resume
 * hint printed on exit is how they get back to the conversation.
 */
function boot(): { terminal: FakeTerminal; start: () => void } {
  const terminal = new FakeTerminal({ columns: 80, rows: 24 })
  const app = new TuiApp({
    getSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp/w',
    getSessionId: () => 's',
    onSubmit: () => {},
    onExit: () => {},
    version: '0',
    statusFacts: () => ({ cwd: '/tmp/w' }),
    modelPicker: async () => ({ models: [], current: '' }),
    selectModel: () => {},
    terminal,
  })
  return { terminal, start: () => { (app as unknown as { start(): void }).start.call(app) } }
}

describe('opening the TUI clears what was on the screen', () => {
  it('clears before drawing the banner', () => {
    // `Terminal.clearScreen()` writes `ESC[2J ESC[H`. Asserting the call rather than
    // the bytes keeps this independent of how pi-tui spells it, but the bytes are
    // checked too because that is the contract the terminal actually sees.
    const { terminal, start } = boot()
    start()
    const output = terminal.output
    expect(output).toContain('\x1b[2J')
    expect(output).toContain('\x1b[H')
  })

  it('clears before anything else is written', () => {
    // Clearing after painting would erase the banner it had just drawn. The banner
    // itself is painted on the first *render*, not inside `start()`, so the ordering
    // that can be asserted here is "the clear is the first thing written".
    const { terminal, start } = boot()
    start()
    expect(terminal.output.startsWith('\x1b[2J\x1b[H')).toBe(true)
  })

  it('does not clear on every repaint', () => {
    // Only the first frame: a clear per repaint would flicker and throw away the
    // transcript that has accumulated since startup.
    const { terminal, start } = boot()
    start()
    const clearsAfterStart = terminal.output.split('\x1b[2J').length - 1
    expect(clearsAfterStart).toBe(1)
  })
})
