import { describe, expect, it, vi } from 'vitest'
import { Text } from '@earendil-works/pi-tui'
import { TuiApp } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

/**
 * The app's key-routing contract. The exit keys are the highest-consequence
 * branch (a stuck TUI means a stuck agent), so they are pinned here with fake
 * components — rendering itself is a Step 9 manual item.
 *
 * `TuiApp` is constructed against a `FakeTerminal`, so the real pi-tui renderer
 * runs without writing ANSI into the test reporter or the developer's TTY; only
 * routing is exercised through the private seams below.
 */

function makeApp(overrides: Partial<ConstructorParameters<typeof TuiApp>[0]> = {}): {
  app: TuiApp
  onExit: ReturnType<typeof vi.fn>
  onSubmit: ReturnType<typeof vi.fn>
} {
  const onExit = vi.fn()
  const onSubmit = vi.fn()
  const app = new TuiApp({
    getSelection: () => ({ provider: 'test', model: 'test-model' }),
    cwd: '/tmp/test',
    getSessionId: () => 'session-test',
    onSubmit,
    onExit,
    version: '0.0.0-test',
    statusFacts: () => ({ cwd: '/tmp/test' }),
    modelPicker: async () => ({ models: [], current: '' }),
    selectModel: () => {},
    // Never touch the real TTY: the app renders through this fake.
    terminal: new FakeTerminal(),
    ...overrides,
  })
  return { app, onExit, onSubmit }
}

/** Access the registered input listener (the first one the app adds). */
function inputListener(app: TuiApp): (data: string) => { consume?: boolean } | undefined {
  const listeners = (app as unknown as { tui: { handleInput(data: string): unknown } }).tui
  // The TuiApp registers its listener via tui.addInputListener; route directly
  // through the TuiBase to avoid touching private fields beyond the one seam.
  void listeners
  // Simplest reliable seam: invoke the private method via bracket access.
  const route = (app as unknown as { handleInput(data: string): { consume?: boolean } | undefined }).handleInput
  return (data) => route.call(app, data)
}

/** Drive one editor submission through the private routing seam. */
async function submit(app: TuiApp, text: string): Promise<void> {
  const route = (app as unknown as { submit(text: string): Promise<void> }).submit
  await route.call(app, text)
}

/** The rendered notice lines (theme colors included, substring-safe). */
function noticeText(app: TuiApp): string {
  const { container } = (app as unknown as {
    noticeLog: { container: { children: { render(width: number): string[] }[] } }
  }).noticeLog
  return container.children.map((child) => child.render(200).join('\n')).join('\n')
}

describe('TuiApp key routing', () => {
  it('ctrl+c clears the draft first and exits only on a second press', () => {
    // pi's rule (`exit-keys.ts`): the first press wipes the draft, the second one
    // inside 500 ms leaves. Asserting an immediate exit here is what made this key
    // throw away a half-typed message.
    const { app, onExit } = makeApp()
    const press = inputListener(app)
    expect(press('\x03')).toEqual({ consume: true })
    expect(onExit).not.toHaveBeenCalled()
    expect(press('\x03')).toEqual({ consume: true })
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('ctrl+d invokes onExit and consumes the key', () => {
    const { app, onExit } = makeApp()
    inputListener(app)('\x04')
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('ordinary characters are not consumed (they flow to the focused editor)', () => {
    const { app, onExit } = makeApp()
    expect(inputListener(app)('hello')).toBeUndefined()
    expect(onExit).not.toHaveBeenCalled()
  })

  it('escape is not an exit key', () => {
    const { app, onExit } = makeApp()
    expect(inputListener(app)('\x1b')).toBeUndefined()
    expect(onExit).not.toHaveBeenCalled()
  })

  it('stop() is idempotent', () => {
    const { app, onExit } = makeApp()
    app.stop()
    app.stop()
    expect(onExit).not.toHaveBeenCalled() // stop ≠ exit
  })
})

describe('TuiApp submit routing', () => {
  it('a plain line goes to the model and is not treated as a command', async () => {
    const { app, onSubmit, onExit } = makeApp()
    await submit(app, 'hello')
    expect(onSubmit).toHaveBeenCalledWith('hello')
    expect(onExit).not.toHaveBeenCalled()
  })

  it('/exit calls onExit instead of prompting', async () => {
    const { app, onExit, onSubmit } = makeApp()
    await submit(app, '/exit')
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('/help answers with a notice, not a prompt', async () => {
    const { app, onSubmit } = makeApp()
    await submit(app, '/help')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(noticeText(app)).toContain('Commands:')
  })

  it('/model <id> validates against the catalogue, switches and reports the route', async () => {
    const selectModel = vi.fn()
    const { app, onSubmit } = makeApp({
      modelPicker: async () => ({
        models: [{ id: 'm1', name: 'Model One', provider: 'test' }],
        current: 'test/test-model',
      }),
      selectModel,
    })
    await submit(app, '/model m1')
    expect(selectModel).toHaveBeenCalledWith('m1')
    expect(noticeText(app)).toContain('model → test/m1')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('/model <unknown> is a typo: no switch, an error notice', async () => {
    const selectModel = vi.fn()
    const { app } = makeApp({
      modelPicker: async () => ({
        models: [{ id: 'm1', name: 'Model One', provider: 'test' }],
        current: 'test/test-model',
      }),
      selectModel,
    })
    await submit(app, '/model nope')
    expect(selectModel).not.toHaveBeenCalled()
    expect(noticeText(app)).toContain('unknown model "nope"')
  })

  it('/model with an empty catalogue reports it instead of switching', async () => {
    const selectModel = vi.fn()
    const { app } = makeApp({ modelPicker: async () => ({ models: [], current: '' }), selectModel })
    await submit(app, '/model anything')
    expect(selectModel).not.toHaveBeenCalled()
    expect(noticeText(app)).toContain('no models available')
  })

  it('/theme <name> applies the theme and reports it', async () => {
    const { app } = makeApp()
    await submit(app, '/theme light')
    expect(noticeText(app)).toContain('theme → light')
  })

  it('a host command result renders as a notice (success or error)', async () => {
    const { app } = makeApp({ runHostCommand: async () => ({ kind: 'error', text: 'boom' }) })
    await submit(app, '/frobnicate')
    expect(noticeText(app)).toContain('boom')
  })

  it('an unmatched slash line with no host runner reports unknown', async () => {
    const { app } = makeApp()
    await submit(app, '/frobnicate')
    expect(noticeText(app)).toContain('unknown command: /frobnicate (try /help)')
  })

  it('/clear empties both the transcript and the notices', async () => {
    const { app } = makeApp()
    app.addMessage(new Text('transcript row'))
    await submit(app, '/help')
    // `clearTranscript` forces a full redraw, which needs a live screen.
    app.stop()
    await submit(app, '/clear')
    const view = app as unknown as {
      messages: { children: unknown[] }
      noticeLog: { container: { children: unknown[] } }
    }
    expect(view.messages.children).toHaveLength(0)
    expect(view.noticeLog.container.children).toHaveLength(0)
  })
})

describe('TuiApp notice placement', () => {
  /**
   * Command replies belong to the conversation, not to the dock.
   *
   * They were mounted in `aboveInput` (the fixed rows between the transcript and
   * the editor), so a reply such as `/compact`'s "No compactable history yet."
   * sat pinned above the prompt and never scrolled with the conversation it was
   * answering. pi's own `/compact` writes nothing to a fixed area either: it
   * calls `session.compact()` and the outcome arrives as a chat entry.
   *
   * The dock keeps only what is transient and self-clearing (the one-line status
   * notice) and what must stay visible while the document scrolls (the editor,
   * the pickers, the status bar).
   */
  const containerOf = (app: TuiApp, field: 'document' | 'aboveInput' | 'messages'): {
    children: unknown[]
  } => (app as unknown as Record<string, { children: unknown[] }>)[field] as { children: unknown[] }

  /** The notices container; it lives inside {@linkcode NoticeLog} now. */
  const noticeContainerOf = (app: TuiApp): { children: unknown[] } =>
    (app as unknown as { noticeLog: { container: { children: unknown[] } } }).noticeLog.container

  it('mounts the notice container inside the scrolling document', () => {
    const { app } = makeApp()
    const document = containerOf(app, 'document')
    const notices = noticeContainerOf(app)
    expect(document.children).toContain(notices)
  })

  it('keeps notices out of the fixed rows above the editor', () => {
    const { app } = makeApp()
    expect(containerOf(app, 'aboveInput').children).not.toContain(noticeContainerOf(app))
  })

  it('places notices after the transcript so replies read in order', () => {
    // A reply that appeared above the message it answers would be unreadable.
    const { app } = makeApp()
    const children = containerOf(app, 'document').children
    const messages = containerOf(app, 'messages')
    const notices = noticeContainerOf(app)
    expect(children.indexOf(notices)).toBeGreaterThan(children.indexOf(messages))
  })
})

describe('TuiApp input slot', () => {
  /**
   * The model panel replaces whatever occupies the input slot, in **both** screen
   * modes.
   *
   * `replaceInputSlot` used to add the panel to `tui`'s own children. In
   * fullscreen (the default) the editor is not a child of `tui` at all — it is
   * handed to `mountFullscreen` as its `input` slot, and the main screen is
   * stopped. So `/model` mounted the panel into a stopped tree: nothing was
   * drawn, while the panel's own key handling kept waiting. From the outside that
   * is "the model list is gone and the app is stuck".
   *
   * The fix is an indirection: a stable container owns the slot, and the app
   * swaps that container's child. Whatever the screen does with the container
   * stays the screen's business.
   */
  const anyApp = (app: TuiApp): Record<string, any> => app as unknown as Record<string, any>

  /** Models the panel needs to open at all. */
  function makeAppWithModels(): TuiApp {
    return makeApp({
      modelPicker: async () => ({
        models: [{ id: 'm1', name: 'M1', provider: 'test' }],
        current: 'm1',
      }),
    }).app
  }

  it('keeps the input slot in the tree in main-screen mode', async () => {
    const app = makeAppWithModels()
    await anyApp(app).openModelPanel()
    expect(anyApp(app).inputSlot.children).toContain(anyApp(app).modelPanel.component)
  })

  it('keeps the input slot in the tree in fullscreen mode', async () => {
    // The failing case: the panel must reach the alt screen's input slot, not
    // the stopped main screen's child list.
    const app = makeAppWithModels()
    anyApp(app).enterFullscreen()
    await anyApp(app).openModelPanel()
    expect(anyApp(app).inputSlot.children).toContain(anyApp(app).modelPanel.component)
  })

  it('draws the panel on the live screen, not on the stopped main screen', async () => {
    // Structure alone cannot catch this: with the slot mounted on `tui` and the
    // alt screen handed the raw editor, `inputSlot.children` still contains the
    // panel while the visible frame shows nothing. The assertion has to be the
    // rendered frame of the *live* renderer.
    const app = makeAppWithModels()
    anyApp(app).enterFullscreen()
    await anyApp(app).openModelPanel()
    const screen = anyApp(app).fullscreen.screen as {
      renderNow(force: boolean): void
      getScreenLines(): string[]
    }
    // `getScreenLines()` is the frame written to the terminal; without a render
    // pass it is empty and would pass for the wrong reason.
    screen.renderNow(true)
    expect(screen.getScreenLines().join('\n')).toContain('M1')
  })

  it('prints whatever occupies the slot on exit, not the editor', async () => {
    // `printFinalDocument()` renders the live component tree for scrollback. It
    // listed `this.editor` — but the editor is not what is in the slot while the
    // model panel is open, so quitting from `/model` printed a component that was
    // not mounted and lost the panel from the final document.
    const app = makeAppWithModels()
    await anyApp(app).openModelPanel()
    anyApp(app).printFinalDocument()
    expect(anyApp(app).terminal.output).toContain('M1')
  })

  it('restores the editor to the slot when the panel closes', async () => {
    const app = makeAppWithModels()
    anyApp(app).enterFullscreen()
    await anyApp(app).openModelPanel()
    anyApp(app).closeModelPanel()
    expect(anyApp(app).inputSlot.children).toEqual([anyApp(app).editor])
  })
})

describe('a selector takes the dock and gives it back', () => {
  /**
   * Three selectors (`/thinking`, `/theme`, `/resume`) each carried their own copy
   * of the same two moves: `aboveInput.clear()` then `addChild(selector)`, and on
   * close `clear()` then re-add the permanent rows.
   *
   * Three copies of one policy is how the dock was left empty the first time a
   * selector closed early: `clear()` removed the rows, and only the constructor
   * ever put them back. One pair of methods means a fourth selector gets the
   * behaviour for free.
   *
   * The assertion is the invariant, not the plumbing: **after a selector closes,
   * the dock holds its four permanent rows again**.
   */
  // Three, not four: `/resume` used to carry a `Text` row that nothing ever
  // wrote to — its feedback is the transcript. The row was removed with it.
  const PERMANENT = 3
  const dockRows = (app: TuiApp): number =>
    (app as unknown as { aboveInput: { children: unknown[] } }).aboveInput.children.length

  /** An app whose model advertises reasoning levels and that knows some themes. */
  function appWithSelectors(): { app: TuiApp; press: (data: string) => unknown } {
    const { app } = makeApp({
      reasoningSupport: async () => ({
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
      }),
      selectReasoningEffort: () => {},
    } as never)
    return { app, press: inputListener(app) }
  }

  it('starts with the permanent rows mounted', () => {
    expect(dockRows(appWithSelectors().app)).toBe(PERMANENT)
  })

  it('mounts the theme selector over the dock', async () => {
    const { app } = appWithSelectors()
    await submit(app, '/theme')
    // The selector plus nothing else: `clear()` ran.
    expect(dockRows(app)).toBe(1)
  })

  it('restores the dock when the theme selector is cancelled', async () => {
    const { app, press } = appWithSelectors()
    await submit(app, '/theme')
    press('\x1b')
    expect(dockRows(app)).toBe(PERMANENT)
  })

  it('restores the dock when the thinking selector is cancelled', async () => {
    const { app, press } = appWithSelectors()
    await submit(app, '/thinking')
    expect(dockRows(app)).toBe(1)
    press('\x1b')
    expect(dockRows(app)).toBe(PERMANENT)
  })

  it('survives opening one selector right after another', async () => {
    // The pairing that broke when each selector owned its own copy: the second
    // `clear()` ran on a dock the first selector had already emptied, and whichever
    // close ran last decided how many rows came back.
    const { app, press } = appWithSelectors()
    await submit(app, '/theme')
    await submit(app, '/thinking')
    press('\x1b')
    expect(dockRows(app)).toBe(PERMANENT)
  })
})
