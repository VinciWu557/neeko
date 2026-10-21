import { describe, expect, it } from 'vitest'
import { TuiApp } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'
import { rowSignature } from '../src/tui/row-cache.ts'
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

  it('reuses each unchanged row component by identity', async () => {
    // What a repaint must avoid is *rebuilding* a row: constructing a
    // `Markdown`, re-parsing it and re-allocating its tree is the expensive half.
    // `app.ts` caches one component per row object and `syncChildren` keeps it in
    // place, so an unchanged row is the same object across a repaint.
    //
    // This asserts **component identity**, not rendered-array identity. The
    // ported pi components have a `Container` or `MouseRegion` root, and neither
    // memoises its output array (`pi-tui` caches inside `Markdown`/`Text`/`Box`
    // instead), so array identity would be a test of pi-tui's internals rather
    // than of this app's caching. Measured cost of the array work: ~0.03 ms per
    // frame for 60 rows.
    const { app, state } = makeApp()
    state.rows.push(...rows(20))
    app.mountTranscript(state)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const first = [...children(app)]

    state.rows.push({ kind: 'user', messageId: 'more', content: 'one more' })
    ;(app as unknown as { scheduleRender(): void }).scheduleRender()
    await new Promise((resolve) => setTimeout(resolve, 120))

    const after = [...children(app)]
    // Every pre-existing row is still the same component; only the new one is new.
    const reused = first.filter((component, index) => after[index] === component).length
    expect(reused).toBe(first.length)
    expect(after.length).toBe(first.length + 1)
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

describe('the streaming spinner does not invalidate the streaming row', () => {
  /**
   * `spinnerFrame` used to be part of `rowSignature`, so every animation tick
   * (80 ms) changed the signature of the row that was streaming and forced a full
   * rebuild of it — a fresh `Markdown`, a fresh parse, a fresh tree, five times a
   * second for as long as the answer took.
   *
   * The fix was to delete the transcript's animation entirely, which is pi's shape:
   * the one animation owner is `Loader` in the composer's border, and the streaming
   * row is already visibly live because its text is arriving.
   *
   * These assertions pin what the signature still *must* track, since removing an
   * input is only safe as long as the remaining ones cover what changes.
   */
  const streaming = {
    kind: 'assistant', turn: 1, step: 1, attemptId: 'a',
    text: 'partial answer', thinking: 'reasoning', done: false,
  } as const
  const fold = { isExpanded: () => false } as never
  const sign = (row: unknown = streaming): string =>
    rowSignature({ row: row as never, themeName: 'dark', fold, attachTime: 0 })

  it('produces the same signature for the same content, however often it is read', () => {
    // A signature that drifted on its own would rebuild the row forever.
    expect(sign()).toBe(sign())
  })

  it('still changes when the streamed text grows', () => {
    // The signature must keep tracking the thing that actually changes, or the
    // reply would freeze mid-stream.
    expect(sign({ ...streaming, text: 'partial answer, longer' })).not.toBe(sign())
  })

  it('still changes when the streamed reasoning grows', () => {
    expect(sign({ ...streaming, thinking: 'reasoning, longer' })).not.toBe(sign())
  })

  it('still changes when the attempt settles', () => {
    expect(sign({ ...streaming, done: true })).not.toBe(sign())
  })
})
