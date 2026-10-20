import { describe, expect, it, vi } from 'vitest'
import { Container, Text } from '@earendil-works/pi-tui'
import type { TuiAltScreen } from '@earendil-works/pi-tui'
import { mountFullscreen } from '../src/tui/fullscreen.ts'
import { TuiApp } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'
import { stripAnsi } from './support/ansi.ts'

/**
 * The fullscreen surface.
 *
 * This is the opt-in place for click-to-expand: the alt screen owns its own
 * selection and copy model, so reporting the pointer costs nothing native there.
 * The main screen stays out of the terminal's way, which is why this exists as a
 * mode rather than a setting.
 */

/**
 * Strip terminal protocol from a captured frame.
 *
 * Three copies of this lived in separate `describe` blocks and drifted (the
 * newest one dropped the pi-tui marker rule), so a test could assert on text a
 * sibling would have removed.
 *
 * @param text - the raw bytes written to the terminal.
 * @returns the visible characters only.
 */
function strip(text: string): string {
  return stripAnsi(text)
}

function mount(onInput = vi.fn()): {
  screen: ReturnType<typeof mountFullscreen>['screen']
  dispose: () => void
  terminal: FakeTerminal
  text: () => string
} {
  const terminal = new FakeTerminal({ columns: 80, rows: 24 })
  const document = new Container()
  document.addChild(new Text('HEADER'))
  document.addChild(new Text('TRANSCRIPT ROW'))
  const surface = mountFullscreen({
    terminal,
    document,
    input: new Text('INPUT'),
    footer: new Text('FOOTER'),
    onInput,
  })
  return {
    screen: surface.screen,
    dispose: () => { surface.dispose() },
    terminal,
    // `getScreenLines()` is the frame actually written to the terminal; a bare
    // `render()` would skip the layout pass and show an empty viewport.
    text: () => {
      surface.screen.renderNow(true)
      return stripAnsi(surface.screen.getScreenLines().join('\n'))
    },
  }
}

describe('mountFullscreen', () => {
  it('lays out header, transcript, input and footer', () => {
    const { text } = mount()
    const rendered = text()
    expect(rendered).toContain('HEADER')
    expect(rendered).toContain('TRANSCRIPT ROW')
    expect(rendered).toContain('INPUT')
    expect(rendered).toContain('FOOTER')
  })

  it('keeps the footer below the input so the prompt stays where it was', () => {
    const rendered = mount().text()
    expect(rendered.indexOf('INPUT')).toBeLessThan(rendered.indexOf('FOOTER'))
  })

  it('enables pointer reporting, which the main screen cannot', () => {
    // The whole reason this mode exists: clicks work here and nowhere else.
    const { terminal } = mount()
    expect(terminal.output).toContain('?1000h')
  })

  it('forwards keys to the owner', () => {
    const onInput = vi.fn()
    const { terminal } = mount(onInput)
    terminal.onInput?.('a')
    expect(onInput).toHaveBeenCalledWith('a')
  })

  it('leaves the alt screen on dispose', () => {
    // Without this the shell would inherit an alternate screen and a shell
    // prompt would be drawn over the transcript.
    const { dispose, terminal } = mount()
    dispose()
    expect(terminal.stopped).toBe(true)
  })

  it('uses the terminal clipboard path rather than a platform command', () => {
    // pi-tui writes OSC 52 when no `copySelection` is supplied, so selection
    // copy works over SSH without shelling out to pbcopy/xclip.
    const { terminal, screen } = mount()
    // The alt screen owns selection; a click must not throw.
    expect(() => { screen.copyActiveSelectionToClipboard().catch(() => undefined) }).not.toThrow()
    expect(terminal.output).not.toContain('pbcopy')
  })
})

describe('/fullscreen toggles the mode', () => {
  function makeApp(terminal = new FakeTerminal({ columns: 80, rows: 24 })): {
    app: TuiApp
    submit: (text: string) => Promise<void>
    isFullscreen: () => boolean
  } {
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
    const seam = app as unknown as {
      submit(t: string): Promise<void>
      fullscreen?: unknown
      tui: { start(): void }
    }
    // `start()` is what raw mode would normally do; the seam avoids needing a TTY.
    seam.tui.start = () => {}
    return {
      app,
      submit: (text) => seam.submit.call(app, text),
      isFullscreen: () => seam.fullscreen !== undefined,
    }
  }

  it('enters fullscreen on /fullscreen', async () => {
    const { submit, isFullscreen } = makeApp()
    await submit('/fullscreen')
    expect(isFullscreen()).toBe(true)
  })

  it('leaves fullscreen on a second /fullscreen', async () => {
    const { submit, isFullscreen } = makeApp()
    await submit('/fullscreen')
    await submit('/fullscreen')
    expect(isFullscreen()).toBe(false)
  })

  it('does not enable pointer reporting on the main screen', async () => {
    // The default path must leave the terminal alone: selection, copy and the
    // right-click menu all depend on it.
    const terminal = new FakeTerminal({ columns: 80, rows: 24 })
    const { submit } = makeApp(terminal)
    await submit('/fullscreen')
    await submit('/fullscreen')
    // Everything before the first fullscreen entered, and after exit, is main-screen.
    expect(terminal.output.slice(0, terminal.output.indexOf('\x1b[?1049h'))).not.toContain('?1000h')
  })
})

describe('exit leaves the terminal usable', () => {
  /**
   * Stopping only the main screen left the terminal in the alternate buffer: the
   * shell drew its prompt into a screen the user could not see, and every later
   * write looked like garbage. The alt screen must be left too.
   */
  function makeApp(terminal: FakeTerminal): {
    submit: (text: string) => Promise<void>
    stop: () => void
    isFullscreen: () => boolean
  } {
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
    const seam = app as unknown as {
      submit(t: string): Promise<void>
      stop(): void
      fullscreen?: unknown
      tui: { start(): void }
    }
    seam.tui.start = () => {}
    return {
      submit: (text) => seam.submit.call(app, text),
      stop: () => { seam.stop.call(app) },
      isFullscreen: () => seam.fullscreen !== undefined,
    }
  }

  it('leaves the alt screen when stopped from fullscreen', async () => {
    const terminal = new FakeTerminal({ columns: 80, rows: 24 })
    const { submit, stop, isFullscreen } = makeApp(terminal)
    await submit('/fullscreen')
    expect(isFullscreen()).toBe(true)

    stop()
    // `?1049l` is the sequence that returns the terminal to the main buffer.
    expect(terminal.output).toContain('\x1b[?1049l')
    expect(isFullscreen()).toBe(false)
  })

  it('prints the final document back into scrollback', async () => {
    const terminal = new FakeTerminal({ columns: 80, rows: 24 })
    const { submit, stop } = makeApp(terminal)
    await submit('/fullscreen')
    stop()
    const tail = terminal.output.slice(terminal.output.lastIndexOf('\x1b[?1049l'))
    expect(tail.length).toBeGreaterThan(20)
  })

  it('is idempotent', async () => {
    // Ctrl+C can arrive twice (a repeated key, or a second press while exiting).
    const terminal = new FakeTerminal({ columns: 80, rows: 24 })
    const { submit, stop } = makeApp(terminal)
    await submit('/fullscreen')
    stop()
    const after = terminal.output.length
    stop()
    expect(terminal.output.length).toBe(after)
  })
})

describe('fullscreen can be the default', () => {
  function bootWith(startOnMainScreen?: boolean): {
    terminal: FakeTerminal
    isFullscreen: () => boolean
    stop: () => void
    submit: (text: string) => Promise<void>
  } {
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
      ...(startOnMainScreen === undefined ? {} : { startOnMainScreen }),
      terminal,
    })
    const seam = app as unknown as {
      start(): void
      stop(): void
      submit(t: string): Promise<void>
      fullscreen?: unknown
    }
    seam.start.call(app)
    return {
      terminal,
      isFullscreen: () => seam.fullscreen !== undefined,
      stop: () => { seam.stop.call(app) },
      submit: (text) => seam.submit.call(app, text),
    }
  }

  it('enters the alt screen on start', () => {
    const app = bootWith(undefined)
    expect(app.isFullscreen()).toBe(true)
    expect(app.terminal.output).toContain('\x1b[?1049h')
  })

  it('starts in the alt screen by default', () => {
    // pi's own default is `tuiMode: 'fullscreen'` (settings-defaults.js): the alt
    // screen is the mode where clicking a card works and the whole viewport is
    // ours, so it is what a user should get without asking.
    const app = bootWith(undefined)
    expect(app.isFullscreen()).toBe(true)
    expect(app.terminal.output).toContain('\x1b[?1049h')
  })

  it('stays on the main screen when asked to', () => {
    // The main screen keeps the terminal's scrollback: it is the opt-out.
    const app = bootWith(true)
    expect(app.isFullscreen()).toBe(false)
    expect(app.terminal.output).not.toContain('\x1b[?1049h')
  })

  it('still exits cleanly from a fullscreen boot', async () => {
    // The boot path and the `/fullscreen` path must leave the same state behind.
    const app = bootWith(undefined)
    app.stop()
    expect(app.terminal.output).toContain('\x1b[?1049l')
    expect(app.isFullscreen()).toBe(false)
  })

  it('toggles back to the main screen on /fullscreen', async () => {
    const app = bootWith(undefined)
    await app.submit('/fullscreen')
    expect(app.isFullscreen()).toBe(false)
  })
})

describe('leaving the alt screen keeps the conversation in scrollback', () => {
  /**
   * pi-tui's "print the final document" path is broken for a `VStack` layout
   * root: `afterTerminalStop()` calls `render(width)`, which delegates to
   * `layoutRoot.render()`, and a layout root that was never measured by
   * `renderLayoutFrame()` returns ONE line. Measured on a real pty: the document
   * was 1426 bytes (banner only) — the whole conversation was gone.
   *
   * So we stop with `preserveScreen: true` (pi's own choice when quitting from
   * fullscreen) and let `exitFullscreen()` repaint the transcript onto the main
   * screen, which lands in real scrollback.
   */
  it('prints the whole conversation onto the main screen on quit', async () => {
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
    const seam = app as unknown as {
      start(): void
      stop(): void
      messages: { render(w: number): string[] }
    }
    app.mountTranscript({
      attachTime: 0,
      rows: [{ kind: 'user', messageId: 'u1', content: 'remember pineapple', images: [] }],
    } as never)
    seam.start.call(app)
    const before = terminal.output.length
    seam.stop.call(app)
    const written = terminal.output.slice(before)
    expect(written).toContain('\x1b[?1049l')
    // The transcript reached the terminal's normal buffer, not just the alt screen.
    expect(written).toContain('pineapple')
  })
})

describe('quitting does not leave terminal capability replies as text', () => {
  /**
   * Every `TuiBase.start()` calls `terminal.start()`, which writes three
   * capability queries: Kitty keyboard protocol (`ESC[>1u ESC[?u`), device
   * attributes (`ESC[c`), and cell size (`ESC[16t`). The terminal answers them
   * asynchronously — after we have already exited, so the reply bytes are no
   * longer parsed as input and the shell prints them literally:
   *
   *     7u  62;22;52c  34;16t
   *
   * (Reported by the user.) The quit path must therefore not start the terminal
   * again: it repaints the transcript onto the *already running* main screen.
   */
  it('does not query the terminal again while quitting', () => {
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
    const seam = app as unknown as { start(): void; stop(): void }
    seam.start.call(app)
    const before = terminal.output.length
    seam.stop.call(app)
    const written = terminal.output.slice(before)
    // The three query sequences, exactly as `Terminal.start()` emits them.
    expect(written).not.toContain('\x1b[>1u')
    expect(written).not.toContain('\x1b[?u')
    expect(written).not.toContain('\x1b[c')
    expect(written).not.toContain('\x1b[16t')
  })
})

describe('the final document writes plain newlines', () => {
  /**
   * The terminal is in cooked mode when the document is printed, and tty ONLCR
   * translates `\n` → `\r\n` for us. Writing `\r\n` therefore became `\r\r\n`
   * on a real pty: a blank line between every row of the transcript.
   */
  it('uses \n rather than \r\n', () => {
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
    const seam = app as unknown as { start(): void; stop(): void }
    seam.start.call(app)
    const before = terminal.output.length
    seam.stop.call(app)
    const written = terminal.output.slice(before)
    expect(written).not.toContain('\r\r\n')
  })
})

describe('the printed document ends with the resume hint', () => {
  function boot(sessionId: string): { terminal: FakeTerminal; stop: () => void } {
    const terminal = new FakeTerminal({ columns: 80, rows: 24 })
    const app = new TuiApp({
      getSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp/w',
      getSessionId: () => sessionId,
      onSubmit: () => {},
      onExit: () => {},
      version: '0',
      statusFacts: () => ({ cwd: '/tmp/w' }),
      modelPicker: async () => ({ models: [], current: '' }),
      selectModel: () => {},
      terminal,
    })
    const seam = app as unknown as { start(): void; stop(): void }
    seam.start.call(app)
    return { terminal, stop: () => { seam.stop.call(app) } }
  }

  it('names the dsh invocation, not pi', () => {
    // pi prints `To resume this session: pi --session <id>`; ours must be the
    // command that actually reaches this TUI (dsh needs the profile + --tui).
    const app = boot('01a15350-e56a-77a9-8dfd-411652d4c087')
    const before = app.terminal.output.length
    app.stop()
    const written = strip(app.terminal.output.slice(before))
    expect(written).toContain('To resume this session: dsh --profile neeko --tui --session 01a15350-e56a-77a9-8dfd-411652d4c087')
    expect(written).not.toContain('To resume this session: pi')
  })

  it('is the last thing printed', () => {
    const app = boot('abc-123')
    const before = app.terminal.output.length
    app.stop()
    const lines = strip(app.terminal.output.slice(before)).split('\n').filter((l) => l.trim() !== '')
    expect(lines.at(-1)).toContain('To resume this session:')
  })

  it('prints nothing when the session has no id', () => {
    const app = boot('')
    const before = app.terminal.output.length
    app.stop()
    expect(strip(app.terminal.output.slice(before))).not.toContain('To resume this session:')
  })
})

describe('panels are visible in fullscreen too', () => {
  /**
   * Reported from a real session: `/thinking` (and `/theme`) rendered nothing in
   * the default fullscreen mode, while the arrow keys still moved a cursor and
   * enter still applied a level — the panel was mounted into the *main* screen's
   * tree, which is stopped while the alt screen owns the terminal.
   *
   * The cause is the layout: `mountFullscreen()` takes an explicit component
   * list, so every panel added to `TuiApp` afterwards is silently absent until
   * someone remembers to thread it through here.
   */
  function bootInFullscreen(): {
    app: TuiApp
    terminal: FakeTerminal
    submit: (text: string) => Promise<void>
  } {
    const terminal = new FakeTerminal({ columns: 100, rows: 40 })
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
      reasoningSupport: async () => ({
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
      }),
      selectReasoningEffort: () => {},
      terminal,
    } as never)
    const seam = app as unknown as { start(): void; submit(t: string): Promise<void> }
    seam.start.call(app)
    return { app, terminal, submit: (text) => seam.submit.call(app, text) }
  }

  /** Let the alt screen's (coalesced, async) repaint land. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 250))

  it('shows the thinking panel on the alt screen', async () => {
    const { terminal, submit } = bootInFullscreen()
    expect(terminal.output).toContain('\x1b[?1049h')
    const before = terminal.output.length
    await submit('/thinking')
    await settle()
    // The panel must be painted by the renderer that is actually on screen.
    const painted = strip(terminal.output.slice(before))
    expect(painted).toContain('Thinking level')
    expect(painted).toContain('High')
  })

  it('shows the theme panel on the alt screen', async () => {
    const { terminal, submit } = bootInFullscreen()
    const before = terminal.output.length
    await submit('/theme')
    await settle()
    expect(strip(terminal.output.slice(before))).toContain('Theme')
  })
})


describe('the whole document scrolls, not just the transcript', () => {
  /**
   * pi's viewport (`createChatViewport`) wraps the **document** — header plus
   * chat — in its `ScrollView`, and keeps only the dock (editor, footer) fixed.
   * Wrapping just the transcript leaves the banner pinned: scrolling moves the
   * conversation under a stationary header, which is not what "scroll the screen"
   * means.
   */
  function mountScrollingDocument(): {
    screen: TuiAltScreen
    document: Container
    lines: () => string[]
  } {
    const terminal = new FakeTerminal({ columns: 60, rows: 12 })
    const document = new Container()
    // Enough rows that the viewport must scroll to show the tail.
    for (let i = 0; i < 40; i += 1) document.addChild(new Text(`row ${i}`, 0, 0))
    const input = new Text('input', 0, 0)
    const footer = new Text('footer', 0, 0)
    const surface = mountFullscreen({ terminal, document, input, footer, onInput: () => undefined })
    return {
      screen: surface.screen,
      document,
      // `renderNow` runs the layout pass; a bare `render()` skips it and shows a
      // one-row degenerate viewport.
      lines: () => {
        surface.screen.renderNow(true)
        return surface.screen.getScreenLines().map((line) => strip(line).trim())
      },
    }
  }

  it('scrolls the banner with the conversation', () => {
    // A `ScrollView` over the document means the header is part of the scroll
    // region: it is not pinned above it.
    const { lines } = mountScrollingDocument()
    const plain = lines()
    // The viewport is 12 rows and the document is 40; the last row must be
    // reachable, so the first rows have scrolled away.
    expect(plain).toContain('row 39')
    expect(plain).not.toContain('row 0')
  })

  it('keeps the input and footer out of the scroll region', () => {
    // They are docked below the viewport, so they survive any scroll position.
    const { lines } = mountScrollingDocument()
    expect(lines()).toContain('input')
    expect(lines()).toContain('footer')
  })
})
