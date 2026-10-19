import { describe, expect, it, vi } from 'vitest'
import { TuiApp } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'
import type { TranscriptState } from '../src/tui/transcript.ts'

/**
 * The reasoning spinner's lifecycle.
 *
 * The animation is a `setInterval`; leaving it running after the work finishes
 * repaints a settled transcript forever. These cases pin "runs while streaming,
 * stops when idle" — the only reason the animation is affordable.
 */

function makeApp(): { app: TuiApp; state: TranscriptState; spinner: () => string | undefined } {
  const app = new TuiApp({
    getSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp/test',
    getSessionId: () => 's',
    onSubmit: () => {},
    onExit: () => {},
    version: '0.0.0',
    statusFacts: () => ({ cwd: '/tmp/test' }),
    modelPicker: async () => ({ models: [], current: '' }),
    selectModel: () => {},
    terminal: new FakeTerminal(),
  })
  const state: TranscriptState = { attachTime: 0, rows: [] }
  const seam = app as unknown as { spinnerTimer?: unknown; spinnerFrame: string }
  return { app, state, spinner: () => (seam.spinnerTimer === undefined ? undefined : seam.spinnerFrame) }
}

describe('reasoning spinner', () => {
  it('does not spin before anything is streaming', () => {
    const { app, state, spinner } = makeApp()
    app.mountTranscript(state)
    expect(spinner()).toBeUndefined()
  })

  it('spins while an assistant row is unfinished', async () => {
    vi.useFakeTimers()
    try {
      const { app, state, spinner } = makeApp()
      state.rows.push({
        kind: 'assistant', turn: 1, step: 1, attemptId: 'a', text: '', thinking: 'hmm', done: false,
      })
      app.mountTranscript(state)
      expect(spinner()).toBeDefined()
      const first = spinner()
      vi.advanceTimersByTime(200)
      // The frame moved, so the row is visibly alive.
      expect(spinner()).not.toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops once the turn settles', () => {
    // A timer outliving the work repaints a static transcript forever.
    const { app, state, spinner } = makeApp()
    const row = {
      kind: 'assistant' as const, turn: 1, step: 1, attemptId: 'a', text: '', thinking: 'hmm', done: true,
    }
    state.rows.push(row)
    app.mountTranscript(state)
    expect(spinner()).toBeUndefined()
  })

  it('stops when the app stops', () => {
    const { app, state, spinner } = makeApp()
    state.rows.push({
      kind: 'assistant', turn: 1, step: 1, attemptId: 'a', text: '', thinking: 'hmm', done: false,
    })
    app.mountTranscript(state)
    expect(spinner()).toBeDefined()
    app.stop()
    expect(spinner()).toBeUndefined()
  })
})
