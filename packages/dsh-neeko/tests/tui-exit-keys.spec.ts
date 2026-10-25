import { describe, expect, it, vi } from 'vitest'
import { TuiApp } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

/**
 * `ctrl+c` clears the draft; pressing it twice exits. `ctrl+d` exits only when the
 * editor is empty.
 *
 * ## Why this is not a detail
 *
 * `ctrl+c` used to exit immediately here. That is the one keystroke every terminal
 * user reaches for to abandon a half-typed message, and getting a shutdown instead
 * costs the session — including a turn that was mid-flight. pi's own hint text says
 * it plainly: `ctrl+c to clear`, `ctrl+c twice to exit`, `ctrl+d to exit (empty)`.
 *
 * ## The window
 *
 * pi treats a second `ctrl+c` within **500 ms** as the exit. A longer gap is two
 * separate "clear" presses, which is what someone mashing the key to wipe a long
 * draft produces — and what must not quit on them.
 */
function app(): {
  app: TuiApp
  /** Live counter — a getter, because a snapshot taken at construction stays 0. */
  readonly exits: () => number
  press: (data: string) => unknown
  editor: { getText(): string; setText(text: string): void }
  openModelPanel: () => Promise<void>
  closePanel: () => void
  panelOpen: () => boolean
} {
  let exits = 0
  const instance = new TuiApp({
    getSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp/w',
    getSessionId: () => 's',
    onSubmit: () => {},
    onExit: () => { exits += 1 },
    version: '0',
    statusFacts: () => ({ cwd: '/tmp/w' }),
    modelPicker: async () => ({ models: [{ id: 'm1', name: 'M1', provider: 'p' }], current: 'm1' }),
    selectModel: () => {},
    terminal: new FakeTerminal(),
  })
  instance.start()
  const route = (instance as unknown as { handleInput(d: string): unknown }).handleInput
  const internal = instance as unknown as {
    editor: unknown
    panels: { close(): boolean }
    modelPanel: unknown
    closeModelPanel(): void
    openModelPanel(): Promise<void>
  }
  return {
    app: instance,
    exits: () => exits,
    press: (data) => route.call(instance, data),
    editor: internal.editor as never,
    openModelPanel: () => internal.openModelPanel.call(instance),
    closePanel: () => { internal.closeModelPanel() },
    panelOpen: () => internal.modelPanel !== undefined,
  }
}

describe('ctrl+c clears before it exits', () => {
  it('clears a draft instead of quitting', () => {
    const { press, editor, exits } = app()
    editor.setText('half-typed message')
    press('\x03')
    expect(editor.getText()).toBe('')
    expect(exits()).toBe(0)
  })

  it('exits on a second press inside the window', () => {
    const { press, exits } = app()
    press('\x03')
    press('\x03')
    expect(exits()).toBe(1)
  })

  it('does not exit when the two presses are far apart', () => {
    // Mashing `ctrl+c` to wipe a long draft must not quit on the fifth press.
    vi.useFakeTimers()
    try {
      const { press, exits } = app()
      press('\x03')
      vi.advanceTimersByTime(2_000)
      press('\x03')
      expect(exits()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('exits on the second press even when there was nothing to clear', () => {
    // An empty editor still counts: the first press does nothing visible, so the
    // second is the exit a user expects when they hit it twice.
    const { press, exits } = app()
    press('\x03')
    press('\x03')
    expect(exits()).toBe(1)
  })
})

describe('ctrl+d exits only from an empty editor', () => {
  it('exits when the editor is empty', () => {
    const { press, exits } = app()
    press('\x04')
    expect(exits()).toBe(1)
  })

  it('does nothing when there is a draft', () => {
    // The mirror of pi's `onCtrlD` contract. Quitting here would lose the message
    // the user is in the middle of, which is the opposite of what `ctrl+d` means in
    // every other line editor.
    const { press, editor, exits } = app()
    editor.setText('draft')
    press('\x04')
    expect(exits()).toBe(0)
    expect(editor.getText()).toBe('draft')
  })
})

describe('a modal panel owns ctrl+c', () => {
  /**
   * With a picker open, `ctrl+c` closes the picker — that is pi-tui's own
   * `tui.select.cancel`, which defaults to `['escape', 'ctrl+c']`, so the panel
   * consumes the key before the clear/exit rule ever sees it.
   *
   * That is the right layering, and it is what needs pinning: the exit scope must
   * **yield** to an open panel rather than acting on a draft the user cannot see
   * behind it. Without that, `ctrl+c` cleared an invisible draft, and two presses
   * exited the program with the picker still drawn.
   */
  it('yields to the panel, which cancels on ctrl+c', async () => {
    const { press, editor, exits, openModelPanel, panelOpen } = app()
    await openModelPanel()
    expect(panelOpen()).toBe(true)
    editor.setText('draft')
    press('\x03')
    // The panel took the key and closed; the draft behind it is untouched.
    expect(panelOpen()).toBe(false)
    expect(editor.getText()).toBe('draft')
    expect(exits()).toBe(0)
  })

  it('does not let a panel press arm the exit window', async () => {
    // A press the user aimed at the picker must not count toward "press twice to
    // exit". Otherwise closing a picker and pressing `ctrl+c` once — a clear —
    // becomes a shutdown, because the panel press had primed the 500 ms timer.
    const { press, exits, openModelPanel, panelOpen } = app()
    await openModelPanel()
    press('\x03')
    expect(panelOpen()).toBe(false)
    press('\x03')
    expect(exits()).toBe(0)
  })

  it('still exits on two presses after the panel is gone', () => {
    // The rule is not disabled, only deferred while a panel covers the input.
    const { press, exits } = app()
    press('\x03')
    press('\x03')
    expect(exits()).toBe(1)
  })
})
