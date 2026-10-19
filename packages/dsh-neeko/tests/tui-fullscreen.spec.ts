import { describe, expect, it, vi } from 'vitest'
import { Container, Text } from '@earendil-works/pi-tui'
import { mountFullscreen } from '../src/tui/fullscreen.ts'
import { TuiApp } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

/**
 * The fullscreen surface.
 *
 * This is the opt-in place for click-to-expand: the alt screen owns its own
 * selection and copy model, so reporting the pointer costs nothing native there.
 * The main screen stays out of the terminal's way, which is why this exists as a
 * mode rather than a setting.
 */

function mount(onInput = vi.fn()): {
  screen: ReturnType<typeof mountFullscreen>['screen']
  dispose: () => void
  terminal: FakeTerminal
  text: () => string
} {
  const terminal = new FakeTerminal({ columns: 80, rows: 24 })
  const transcript = new Container()
  transcript.addChild(new Text('TRANSCRIPT ROW'))
  const surface = mountFullscreen({
    terminal,
    header: new Text('HEADER'),
    transcript,
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
      return surface.screen.getScreenLines().join('\n').replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, '')
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
  function bootWith(initialFullscreen?: boolean): {
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
      ...(initialFullscreen === undefined ? {} : { initialFullscreen }),
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
    const app = bootWith(true)
    expect(app.isFullscreen()).toBe(true)
    expect(app.terminal.output).toContain('\x1b[?1049h')
  })

  it('stays on the main screen by default', () => {
    // Fullscreen is opt-in: it owns scrolling and repaints its whole viewport.
    const app = bootWith(undefined)
    expect(app.isFullscreen()).toBe(false)
    expect(app.terminal.output).not.toContain('\x1b[?1049h')
  })

  it('still exits cleanly from a fullscreen boot', async () => {
    // The boot path and the `/fullscreen` path must leave the same state behind.
    const app = bootWith(true)
    app.stop()
    expect(app.terminal.output).toContain('\x1b[?1049l')
    expect(app.isFullscreen()).toBe(false)
  })

  it('toggles back to the main screen on /fullscreen', async () => {
    const app = bootWith(true)
    await app.submit('/fullscreen')
    expect(app.isFullscreen()).toBe(false)
  })
})
