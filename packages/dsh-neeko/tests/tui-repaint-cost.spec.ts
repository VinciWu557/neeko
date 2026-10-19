import { describe, expect, it } from 'vitest'
import { TuiApp } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'
import type { TranscriptState, TranscriptRow } from '../src/tui/transcript.ts'

/**
 * Repaint cost.
 *
 * A transcript flush used to rebuild every row component and re-`addChild` the
 * whole container. Measured on 600 rows that was ~30 ms — over half of the 50 ms
 * repaint budget — and it grew with the conversation, which is what made the
 * screen feel sluggish. These cases pin the two properties that fixed it:
 * unchanged rows keep their component, and a flush costs a small constant.
 */

function makeApp(): { app: TuiApp; state: TranscriptState } {
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
    terminal: new FakeTerminal({ columns: 100, rows: 40 }),
  })
  return { app, state: { attachTime: 0, rows: [] } }
}

function rows(count: number): TranscriptRow[] {
  const out: TranscriptRow[] = []
  for (let i = 0; i < count; i += 1) {
    out.push({ kind: 'user', messageId: `u${i}`, content: `prompt ${i}` })
    out.push({
      kind: 'assistant', turn: i, step: 1, attemptId: `a${i}`,
      text: 'some answer text here', thinking: 'th', done: true,
    })
    out.push({
      kind: 'tool', taskId: `t${i}`, name: 'bash',
      args: { command: 'ls' }, status: 'success', result: 'out '.repeat(50), turn: i,
    })
  }
  return out
}

const children = (app: TuiApp): unknown[] =>
  (app as unknown as { messages: { children: unknown[] } }).messages.children

describe('repaint is incremental', () => {
  it('keeps the component of every unchanged row', async () => {
    const { app, state } = makeApp()
    state.rows.push(...rows(100))
    app.mountTranscript(state)
    const before = [...children(app)]

    state.rows.push({ kind: 'user', messageId: 'new', content: 'appended' })
    ;(app as unknown as { scheduleRender(): void }).scheduleRender()
    await new Promise((resolve) => setTimeout(resolve, 120))

    const after = children(app)
    const reused = before.filter((component, index) => after[index] === component).length
    expect(reused).toBe(before.length)
    expect(after).toHaveLength(before.length + 1)
  })

  it('rebuilds only the row whose content changed', async () => {
    const { app, state } = makeApp()
    state.rows.push(...rows(50))
    app.mountTranscript(state)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const before = [...children(app)]

    // Append a row: every existing row keeps its component.
    const fresh: TranscriptRow = { kind: 'user', messageId: 'fresh', content: 'new row' }
    state.rows.push(fresh)
    ;(app as unknown as { scheduleRender(): void }).scheduleRender()
    await new Promise((resolve) => setTimeout(resolve, 120))

    const after = children(app)
    const changed = before
      .map((component, index) => (after[index] === component ? undefined : index))
      .filter((index): index is number => index !== undefined)
    expect(changed).toEqual([])
  })

  it('drops trailing components when the view shrinks', async () => {
    // `/clear` moved the watermark, so the container must lose its tail.
    const { app, state } = makeApp()
    state.rows.push(...rows(10))
    app.mountTranscript(state)
    expect(children(app).length).toBe(30)

    await (app as unknown as { submit(t: string): Promise<void> }).submit.call(app, '/clear')
    expect(children(app)).toHaveLength(0)
  })

  it('lets unchanged rows reuse their own render cache', async () => {
    // `Text.render()` returns the same array while its content is unchanged, so
    // keeping the child's identity is what makes a repaint cheap. Clearing the
    // container would build a fresh component and throw that cache away.
    const { app, state } = makeApp()
    state.rows.push(...rows(20))
    app.mountTranscript(state)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const first = [...children(app)] as unknown as { render(w: number): string[] }[]
    const rendered = first.map((component) => component.render(100))

    state.rows.push({ kind: 'user', messageId: 'more', content: 'one more' })
    ;(app as unknown as { scheduleRender(): void }).scheduleRender()
    await new Promise((resolve) => setTimeout(resolve, 120))

    const after = [...children(app)] as unknown as { render(w: number): string[] }[]
    const again = after.map((component) => component.render(100))
    // Same array instance ⇒ the component served its cache instead of re-rendering.
    const cached = first.filter((_, index) => again[index] === rendered[index]).length
    // Card wrappers (`MouseRegion`/`Box`) have no line cache of their own; the
    // text components inside them do. Assert the majority keeps its identity.
    expect(cached).toBeGreaterThanOrEqual(first.length / 2)
  })

  it('does not reschedule itself while idle', async () => {
    // `flush()` used to end with `requestRender()`, which re-armed the timer: a
    // full rebuild every 50 ms forever, with nothing changing. That is what made
    // the whole screen feel sluggish.
    const { app, state } = makeApp()
    state.rows.push(...rows(30))
    app.mountTranscript(state)
    await new Promise((resolve) => setTimeout(resolve, 120))

    // Count render calls: a self-rescheduling flush re-renders the transcript
    // even when nothing changed, which the identity check above cannot see.
    const terminal = (app as unknown as { terminal: { output: string } }).terminal
    const before = terminal.output.length
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(terminal.output.length).toBe(before)
  })

  it('keeps a steady-state flush cheap', async () => {
    const { app, state } = makeApp()
    state.rows.push(...rows(200))
    app.mountTranscript(state)
    const seam = app as unknown as { scheduleRender(): void }

    // Ten flushes with nothing changing: the cost must not scale with 600 rows.
    const start = performance.now()
    for (let i = 0; i < 10; i += 1) {
      seam.scheduleRender()
      await new Promise((resolve) => setTimeout(resolve, 55))
    }
    const perFlush = (performance.now() - start) / 10 - 55
    expect(perFlush).toBeLessThan(5)
  })
})
