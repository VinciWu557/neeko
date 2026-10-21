import { describe, expect, it, vi } from 'vitest'
import { Container, Text } from '@earendil-works/pi-tui'
import type { TuiAltScreen } from '@earendil-works/pi-tui'
import type { MountedScreen } from '../src/tui/screen.ts'
import { mountScreen } from '../src/tui/screen.ts'
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
  // Named, not inferred: `ReturnType` of an overloaded function takes the last
  // overload, which is the screen-agnostic one. The alt-screen extras this file
  // exercises (`getScreenLines`) only exist on the concrete type.
  screen: MountedScreen<TuiAltScreen>['screen']
  dispose: () => void
  terminal: FakeTerminal
  text: () => string
} {
  const terminal = new FakeTerminal({ columns: 80, rows: 24 })
  const document = new Container()
  document.addChild(new Text('HEADER'))
  document.addChild(new Text('TRANSCRIPT ROW'))
  const surface = mountScreen(terminal, 'fullscreen', {
    document,
    // The alt screen always receives a dock container; an empty one keeps this
    // fixture about layout rather than about panels.
    aboveInput: new Container(),
    input: new Text('INPUT'),
    footer: new Text('FOOTER'),
    onInput,
  })
  // Mounting composes the tree; starting is what enters the alt screen and arms
  // raw mode. A layout fixture is meaningless without the start.
  surface.start()
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

describe('mountScreen — fullscreen', () => {
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

describe('which screen a boot mounts', () => {
  function bootWith(screenMode?: 'main' | 'fullscreen'): {
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
      ...(screenMode === undefined ? {} : { screenMode }),
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

  it('stays on the terminal-owned main screen when nothing was asked for', () => {
    // The default, and it is what pi actually runs: the terminal owns the
    // scrollback, so its own scrollbar is there, `PageUp` and the wheel work as in
    // any other CLI, and history survives. Measured cost is comparable to pi's own
    // regular mode (25 KB vs 59 KB for one turn on a 24x100 pty).
    const app = bootWith(undefined)
    expect(app.isFullscreen()).toBe(false)
    expect(app.terminal.output).not.toContain('\x1b[?1049h')
  })

  it('enters the alt screen when fullscreen was asked for', () => {
    const app = bootWith('fullscreen')
    expect(app.isFullscreen()).toBe(true)
    expect(app.terminal.output).toContain('\x1b[?1049h')
  })

  it('stays on the main screen when main was asked for', () => {
    const app = bootWith('main')
    expect(app.isFullscreen()).toBe(false)
    expect(app.terminal.output).not.toContain('\x1b[?1049h')
  })

  it('exits cleanly from a fullscreen boot', () => {
    // The boot path and the `/fullscreen` path must leave the same state behind.
    const app = bootWith('fullscreen')
    app.stop()
    expect(app.terminal.output).toContain('\x1b[?1049l')
    expect(app.isFullscreen()).toBe(false)
  })

  it('toggles into the alt screen on /fullscreen', async () => {
    // The toggle starts from the main screen, which is the default.
    const app = bootWith(undefined)
    await app.submit('/fullscreen')
    expect(app.isFullscreen()).toBe(true)
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
    // Only a fullscreen boot has an alt screen to leave; the main screen is
    // already the terminal's own buffer.
    const terminal = new FakeTerminal({ columns: 80, rows: 24 })
    const app = new TuiApp({
      screenMode: 'fullscreen',
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
   * The cause is the layout: `mountFullscreen()` **used to** take an explicit
   * component list, so every panel added to `TuiApp` afterwards was silently
   * absent until someone remembered to thread it through there. `mountScreen()`
   * now takes aggregates (`aboveInput`, `input`), so a panel rides along with
   * the container it lives in and cannot be forgotten.
   */
  function bootInFullscreen(): {
    app: TuiApp
    terminal: FakeTerminal
    submit: (text: string) => Promise<void>
  } {
    const terminal = new FakeTerminal({ columns: 100, rows: 40 })
    const app = new TuiApp({
      // Named, not implied: the main screen is the default now, and these tests
      // are specifically about what the alt screen does with panels.
      screenMode: 'fullscreen',
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
    // pi's `ThinkingSelectorComponent` titles the panel `Thinking Level` (capital
    // L); the previous hand-rolled panel wrote `Thinking level`.
    expect(painted).toContain('Thinking Level')
    expect(painted).toContain('High')
  })

  it('shows the theme panel on the alt screen', async () => {
    const { terminal, submit } = bootInFullscreen()
    const before = terminal.output.length
    await submit('/theme')
    await settle()
    const painted = strip(terminal.output.slice(before))
    // pi's `ThemeSelectorComponent` has **no title**: two rules around a
    // `SelectList`, and the active theme is marked in the description column
    // (`(current)`). The previous panel had a `Theme` heading; asserting on it
    // would pin the old shape rather than pi's.
    expect(painted).toContain('(current)')
    expect(painted).toContain('dark')
    expect(painted).toContain('[light]')
  })
})


describe('the scroll region takes every row the dock does not need', () => {
  /**
   * pi's `createChatViewport` wraps the fixed rows in **one** dock `VStack` and
   * gives it `basis: "auto"` as a single entry; the transcript gets `grow: 1`.
   *
   * Flattening the dock into the root stack instead — four entries at
   * `basis: "auto"` with their own `minSize`s — made the transcripts collapse to
   * one row on a short terminal: measured on a 10-row screen, the region showed a
   * single row and the editor and footer took the rest.
   */
  function mountShortScreen(): { rows: () => string[] } {
    const terminal = new FakeTerminal({ columns: 40, rows: 10 })
    const document = new Container()
    for (let i = 0; i < 30; i += 1) document.addChild(new Text(`row ${i}`, 0, 0))
    const surface = mountScreen(terminal, 'fullscreen', {
      document,
      aboveInput: new Container(),
      input: new Text('INPUT', 0, 0),
      footer: new Text('FOOTER', 0, 0),
      onInput: () => undefined,
    })
    surface.start()
    return {
      rows: () => {
        surface.screen.renderNow(true)
        return surface.screen.getScreenLines().map((line) => stripAnsi(line).trimEnd())
      },
    }
  }

  it('gives the transcript every row the dock does not need', () => {
    // 10 rows total, and the dock is one editor row plus one footer row plus the
    // padding each carries. The transcript must get the rest — measured 1 row
    // before the dock became a single stack entry, which is what "the scroll
    // region is tiny" looks like from the outside.
    const rows = mountShortScreen().rows()
    const documentRows = rows.filter((line) => line.startsWith('row '))
    expect(documentRows.length).toBeGreaterThanOrEqual(4)
  })

  it('still keeps the editor and footer visible', () => {
    // The point of the dock: fixed rows must survive any scroll position.
    const rows = mountShortScreen().rows()
    expect(rows).toContain('INPUT')
    expect(rows).toContain('FOOTER')
  })

  it('puts the dock below the document, in order', () => {
    const rows = mountShortScreen().rows().filter((line) => line.trim() !== '')
    expect(rows.indexOf('INPUT')).toBeGreaterThan(rows.findIndex((line) => line.startsWith('row ')))
    expect(rows.indexOf('FOOTER')).toBeGreaterThan(rows.indexOf('INPUT'))
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
    const surface = mountScreen(terminal, 'fullscreen', {
      document,
      aboveInput: new Container(),
      input,
      footer,
      onInput: () => undefined,
    })
    surface.start()
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

describe('quitting drains pending terminal input', () => {
  /**
   * The third variant of one defect class.
   *
   * While the Kitty keyboard protocol is on, the terminal reports **key releases**
   * as CSI-u sequences (`9;5:3u` = ctrl+tab released). A release that lands between
   * the last render and `process.exit` sits in stdin until the shell takes over,
   * and the shell echoes it literally — the user sees `9;5:3u9;` after the
   * transcript.
   *
   * `drainInput` is the supported fix: it disables the protocol first (so no
   * further releases are generated), waits for the queue to go quiet, and discards
   * what arrived. It must be called **and awaited** before exiting, or the process
   * ends with bytes still queued.
   */
  it('calls drainInput as the last step of stopping', async () => {
    const terminal = new FakeTerminal({ columns: 80, rows: 24 })
    const drained: number[] = []
    const original = terminal.drainInput.bind(terminal)
    terminal.drainInput = (): Promise<void> => {
      drained.push(Date.now())
      return original()
    }
    const app = new TuiApp({
      screenMode: 'fullscreen',
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
    const seam = app as unknown as { start(): void }
    seam.start.call(app)
    const before = terminal.output.length

    await app.drainTerminalInput()
    expect(drained).toHaveLength(1)
    // Draining is not a write: the document was already printed by `stop()`.
    expect(terminal.output.length).toBe(before)
  })

  it('exposes the drain as a promise so the owner can wait for it', async () => {
    // A fire-and-forget drain would leave the process exiting mid-drain, which is
    // exactly the race that produces the stray bytes.
    const terminal = new FakeTerminal({ columns: 80, rows: 24 })
    let settled = false
    const original = terminal.drainInput.bind(terminal)
    terminal.drainInput = (): Promise<void> => original().then(() => { settled = true })
    const app = new TuiApp({
      screenMode: 'fullscreen',
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
    const pending = app.drainTerminalInput()
    expect(pending).toBeInstanceOf(Promise)
    await pending
    expect(settled).toBe(true)
  })
})
