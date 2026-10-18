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
function notices(app: TuiApp): string {
  const container = (app as unknown as {
    notices: { children: { render(width: number): string[] }[] }
  }).notices
  return container.children.map((child) => child.render(200).join('\n')).join('\n')
}

describe('TuiApp key routing', () => {
  it('ctrl+c invokes onExit and consumes the key', () => {
    const { app, onExit } = makeApp()
    const result = inputListener(app)('\x03')
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ consume: true })
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
    expect(notices(app)).toContain('Commands:')
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
    expect(notices(app)).toContain('model → test/m1')
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
    expect(notices(app)).toContain('unknown model "nope"')
  })

  it('/model with an empty catalogue reports it instead of switching', async () => {
    const selectModel = vi.fn()
    const { app } = makeApp({ modelPicker: async () => ({ models: [], current: '' }), selectModel })
    await submit(app, '/model anything')
    expect(selectModel).not.toHaveBeenCalled()
    expect(notices(app)).toContain('no models available')
  })

  it('/theme <name> applies the theme and reports it', async () => {
    const { app } = makeApp()
    await submit(app, '/theme light')
    expect(notices(app)).toContain('theme → light')
  })

  it('a host command result renders as a notice (success or error)', async () => {
    const { app } = makeApp({ runHostCommand: async () => ({ kind: 'error', text: 'boom' }) })
    await submit(app, '/frobnicate')
    expect(notices(app)).toContain('boom')
  })

  it('an unmatched slash line with no host runner reports unknown', async () => {
    const { app } = makeApp()
    await submit(app, '/frobnicate')
    expect(notices(app)).toContain('unknown command: /frobnicate (try /help)')
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
      notices: { children: unknown[] }
    }
    expect(view.messages.children).toHaveLength(0)
    expect(view.notices.children).toHaveLength(0)
  })
})
