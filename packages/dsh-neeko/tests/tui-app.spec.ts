import { describe, expect, it, vi } from 'vitest'
import { TuiApp } from '../src/tui/app.ts'

/**
 * The app's key-routing contract. The exit keys are the highest-consequence
 * branch (a stuck TUI means a stuck agent), so they are pinned here with fake
 * components — rendering itself is a Step 9 manual item.
 *
 * `TuiApp` is constructed against a real `ProcessTerminal`, but in tests the
 * TUI is never `start()`ed, so no raw-mode side effects occur; only routing is
 * exercised through the private listener via a public test seam.
 */

function makeApp(overrides: Partial<ConstructorParameters<typeof TuiApp>[0]> = {}): {
  app: TuiApp
  onExit: ReturnType<typeof vi.fn>
  onSubmit: ReturnType<typeof vi.fn>
} {
  const onExit = vi.fn()
  const onSubmit = vi.fn()
  const app = new TuiApp({
    agent: {} as never,
    selection: { provider: 'test', model: 'test-model' },
    getSessionId: () => 'session-test',
    onSubmit,
    onExit,
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
