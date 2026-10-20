import { describe, expect, it, vi } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { TuiApp } from '../src/tui/app.ts'
import type { TuiAppOptions } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

/**
 * `/thinking` glue: slash line → app → host selection, and picker keys → apply.
 *
 * Kept separate from `tui-thinking.spec.ts` (the pure decisions) because every
 * defect this project has had in the TUI lived in exactly this layer — a state
 * machine that is correct on its own, wired to nothing.
 */

const support = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High', description: 'slower' },
  ],
  defaultEffort: ReasoningEffortId('low'),
}

function makeApp(over: Partial<TuiAppOptions> = {}): {
  app: TuiApp
  submit: (text: string) => Promise<void>
  key: (data: string) => { consume?: boolean } | undefined
  apply: ReturnType<typeof vi.fn>
  panel: () => string
  notices: () => string
  status: () => string
} {
  const apply = vi.fn()
  const app = new TuiApp({
    getSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('low') }),
    cwd: '/tmp/w',
    getSessionId: () => 's',
    onSubmit: () => {},
    onExit: () => {},
    version: '0',
    statusFacts: () => ({ cwd: '/tmp/w' }),
    modelPicker: async () => ({ models: [], current: '' }),
    selectModel: () => {},
    reasoningSupport: async () => support,
    selectReasoningEffort: apply,
    terminal: new FakeTerminal(),
    ...over,
  } as TuiAppOptions)
  const call = <T>(name: string, ...args: unknown[]): T => {
    const fn = (app as unknown as Record<string, ((...a: unknown[]) => T) | undefined>)[name]
    if (fn === undefined) throw new Error(`TuiApp has no method ${name}`)
    return fn.apply(app, args)
  }
  return {
    app,
    apply,
    // The transient line lives inside `NoticeLog` now; read it through the same
    // container the notices use, so the test sees what the user sees.
    status: () => (app as unknown as { noticeLog: { container: { children: { render(w: number): string[] }[] } } })
      .noticeLog.container.children.map((child) => child.render(200).join('\n')).join('\n'),
    submit: (text) => call('submit', text),
    key: (data) => call('handleInput', data),
    panel: () => (app as unknown as { thinkingText: { render(w: number): string[] } })
      .thinkingText.render(120).join('\n').trim(),
    notices: () => (app as unknown as { noticeLog: { container: { children: { render(w: number): string[] }[] } } })
      .noticeLog.container.children.map((child) => child.render(200).join('\n')).join('\n'),
  }
}

describe('/thinking <level>', () => {
  it('applies a level the model advertises', async () => {
    const { submit, apply } = makeApp()
    await submit('/thinking high')
    expect(apply).toHaveBeenCalledWith('high')
  })

  it('rejects an unknown level and says what is available', async () => {
    // pi's behaviour: never silently ignore a typo.
    const { submit, apply, notices } = makeApp()
    await submit('/thinking extreme')
    expect(apply).not.toHaveBeenCalled()
    expect(notices()).toContain('unknown thinking level')
    expect(notices()).toContain('low')
    expect(notices()).toContain('high')
  })

  it('does not rewrite the selection when the level is already set', async () => {
    const { submit, apply, status } = makeApp()
    await submit('/thinking low')
    expect(apply).not.toHaveBeenCalled()
    expect(status()).toContain('already set')
  })

  it('explains a model with no reasoning levels instead of offering an empty list', async () => {
    const { submit, apply, notices } = makeApp({ reasoningSupport: async () => undefined })
    await submit('/thinking high')
    expect(apply).not.toHaveBeenCalled()
    expect(notices()).toContain('no reasoning levels')
  })

  it('surfaces a failed capability read', async () => {
    const { submit, apply, notices } = makeApp({
      reasoningSupport: async () => { throw new Error('adapter missing') },
    })
    await submit('/thinking high')
    expect(apply).not.toHaveBeenCalled()
    expect(notices()).toContain('adapter missing')
  })

  it('surfaces a rejected apply', async () => {
    const { submit, notices } = makeApp({
      selectReasoningEffort: () => { throw new Error('unsupported effort') },
    })
    await submit('/thinking high')
    expect(notices()).toContain('unsupported effort')
  })
})

describe('/thinking (bare) opens a selector', () => {
  it('lists the advertised levels and starts on the current one', async () => {
    // `current` is deliberately NOT the first effort (and not the adapter
    // default): with both equal to 'low', a cursor parked at index 0 would pass.
    const { submit, panel } = makeApp({
      getSelection: () => ({ provider: 'p', model: 'm', reasoningEffort: ReasoningEffortId('high') }),
    })
    await submit('/thinking')
    expect(panel()).toContain('Thinking level')
    expect(panel()).toContain('Low')
    expect(panel()).toContain('High')
    // The cursor sits on the level in effect, so enter-without-moving is a no-op.
    // Asserted per row, not with one loose regex: `→ +High` would also match a
    // cursor parked at index 0 whenever `Low` happens to be `current`.
    const rows = panel().split('\n').filter((line) => /Low|High/u.test(line))
    expect(rows[1]).toContain('→ ✓ High')
    // The other row must NOT carry the cursor — this is what a parked index-0
    // cursor gets wrong, and a loose `/→ ✓?/` regex would not notice.
    expect(rows[0]).not.toContain('→')
  })

  it('moves with arrows and applies on enter', async () => {
    const { submit, key, apply, panel } = makeApp()
    await submit('/thinking')
    key('\x1b[B') // down
    const rows = panel().split('\n').filter((line) => /Low|High/u.test(line))
    // `→` follows the cursor, `✓` follows what is in effect — moving the cursor
    // must not move the checkmark, or the panel would claim the level already
    // changed before enter is pressed.
    expect(rows[1]).toContain('→')
    expect(rows[1]).not.toContain('✓')
    expect(rows[0]).toContain('✓')
    expect(rows[0]).not.toContain('→')
    key('\r')
    expect(apply).toHaveBeenCalledWith('high')
  })

  it('closes on escape without applying', async () => {
    const { submit, key, apply, panel } = makeApp()
    await submit('/thinking')
    key('\x1b')
    expect(panel()).toBe('')
    expect(apply).not.toHaveBeenCalled()
  })

  it('owns the keyboard while open', async () => {
    // A stray key must not reach the editor behind the panel.
    const { submit, key, panel } = makeApp()
    await submit('/thinking')
    expect(key('x')).toEqual({ consume: true })
    expect(panel()).toContain('Thinking level')
  })
})
