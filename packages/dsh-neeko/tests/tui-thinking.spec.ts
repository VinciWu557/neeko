import { describe, expect, it, vi } from 'vitest'
import {
  thinkingChoices,
  thinkingOutcome,
  withReasoningEffort,
  cycleThinking,
} from '../src/tui/thinking.ts'
import type { ReasoningSupport } from '../src/tui/thinking.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { TuiApp } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

/**
 * `/thinking` — the model's reasoning effort.
 *
 * pi's shape (`handleThinkingCommand` / `showThinkingSelector`): bare `/thinking`
 * opens a selector, `/thinking <level>` applies directly and rejects an unknown
 * level with the available list. What differs is where the levels come from.
 *
 * dsh does not let us invent them: `llm.resolveModelInfo(provider, model)` answers
 * `reasoning.efforts` for the **exact** route, and `resolveCallConfig` rejects an
 * unsupported explicit effort before any provider I/O. So a hard-coded
 * `low|medium|high` list would let the UI offer levels that fail on send.
 */

const route = { provider: 'magpie', model: 'group/auto-step-5-preview' }

describe('thinkingChoices', () => {
  it('reports the efforts the model actually advertises, in adapter order', () => {
    const choices = thinkingChoices({
      efforts: [
        { id: ReasoningEffortId('low'), name: 'Low' },
        { id: ReasoningEffortId('high'), name: 'High' },
      ],
      defaultEffort: ReasoningEffortId('high'),
    })
    expect(choices.map((choice) => choice.id)).toEqual(['low', 'high'])
    expect(choices.map((choice) => choice.name)).toEqual(['Low', 'High'])
  })

  it('marks the effort in effect, not the adapter default', () => {
    // The user may have switched away from the default; the check has to follow
    // the live selection or the menu lies about the current state.
    const choices = thinkingChoices(
      { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('low') },
      'high',
    )
    expect(choices.filter((choice) => choice.current).map((choice) => choice.id)).toEqual(['high'])
  })

  it('falls back to the adapter default only when nothing is selected', () => {
    // Absent effort means "provider default" at the wire level; showing that as
    // current is honest as long as it is what will actually be sent.
    const choices = thinkingChoices(
      { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }], defaultEffort: ReasoningEffortId('low') },
      undefined,
    )
    expect(choices[0]?.current).toBe(true)
  })

  it('offers nothing for a model without reasoning support', () => {
    // A non-reasoning model has no `reasoning` block; offering a level would be
    // a setting that cannot take effect.
    expect(thinkingChoices(undefined, 'high')).toEqual([])
  })

  it('keeps a description when the adapter supplies one', () => {
    const choices = thinkingChoices({ efforts: [{ id: ReasoningEffortId('low'), name: 'Low', description: 'fast' }] }, undefined)
    expect(choices[0]?.description).toBe('fast')
  })
})

describe('thinkingOutcome', () => {
  const model = {
    efforts: [
      { id: ReasoningEffortId('low'), name: 'Low' },
      { id: ReasoningEffortId('high'), name: 'High' },
    ],
    defaultEffort: ReasoningEffortId('low'),
  }

  it('opens the picker for a bare invocation', () => {
    expect(thinkingOutcome('', model, undefined)).toEqual({ kind: 'picker' })
  })

  it('accepts an effort id', () => {
    expect(thinkingOutcome('high', model, 'low')).toEqual({ kind: 'apply', effort: 'high' })
  })

  it('accepts the adapter display name case-insensitively', () => {
    // pi matches on the level string; a name like "High" is what the menu shows,
    // so typing it must work too.
    expect(thinkingOutcome('  HiGh ', model, 'low')).toEqual({ kind: 'apply', effort: 'high' })
  })

  it('lists the available levels when the input matches none', () => {
    const outcome = thinkingOutcome('extreme', model, 'low')
    expect(outcome).toMatchObject({ kind: 'unknown' })
    if (outcome.kind === 'unknown') {
      expect(outcome.message).toContain('extreme')
      expect(outcome.message).toContain('low')
      expect(outcome.message).toContain('high')
    }
  })

  it('says the model has no reasoning settings instead of listing nothing', () => {
    const outcome = thinkingOutcome('high', undefined, undefined)
    expect(outcome).toMatchObject({ kind: 'unsupported' })
  })

  it('is a no-op when the level is already in effect', () => {
    // Re-applying is harmless but should not claim to have changed anything.
    expect(thinkingOutcome('high', model, 'high')).toEqual({ kind: 'unchanged', effort: 'high' })
  })
})

describe('withReasoningEffort', () => {
  it('keeps provider and model, replacing only the effort', () => {
    expect(withReasoningEffort(route, 'high')).toEqual({
      provider: 'magpie',
      model: 'group/auto-step-5-preview',
      reasoningEffort: 'high',
    })
  })

  it('drops the effort key when clearing, so the provider default applies', () => {
    // `exactOptionalPropertyTypes` + the DSH contract: absent means "provider
    // default", while `undefined` is a different (and invalid) value at the wire.
    const cleared = withReasoningEffort({ ...route, reasoningEffort: 'high' as never }, undefined)
    expect(cleared).not.toHaveProperty('reasoningEffort')
  })
})

describe('the selector marks what is in effect, and only that', () => {
  /**
   * The rendering moved to `ThinkingSelector` (pi's component shape), so the
   * `✓` marker and the "no level pinned" story are asserted there
   * (`tui-thinking-selector.spec.ts`) and through the app seam
   * (`tui-thinking-glue.spec.ts`).
   *
   * What stays here is the decision those two consume: which choice is `current`.
   * That is this module's job, and it is the half a rendering change must not
   * alter — a model with no `defaultEffort` and a selection with no effort must
   * produce **no** `current` row, or the menu would claim a level is pinned when
   * the wire sends none.
   */
  it('marks nothing when the adapter names no default and nothing is selected', () => {
    const choices = thinkingChoices({ efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }] } as never, undefined)
    expect(choices.some((choice) => choice.current)).toBe(false)
  })

  it('marks the selected level', () => {
    const choices = thinkingChoices(
      { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }] } as never,
      'high',
    )
    expect(choices.filter((choice) => choice.current).map((choice) => choice.id)).toEqual(['high'])
  })

  it('marks the adapter default when the selection is silent', () => {
    // An absent selection means "provider default" on the wire, so showing the
    // adapter's default as current is honest: that is what gets sent.
    const choices = thinkingChoices(
      { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }], defaultEffort: ReasoningEffortId('low') } as never,
      undefined,
    )
    expect(choices[0]?.current).toBe(true)
  })
})

describe('cycling the thinking level with shift+tab', () => {
  /**
   * pi binds `shift+tab` to `app.thinking.cycle`. It is not a selector: it advances
   * to the next level in place, so a user can step through levels while looking at
   * the transcript.
   *
   * The list comes from the adapter (`reasoning.efforts`), never from a hard-coded
   * `low|medium|high` — offering a level the model cannot run is a rejection, and
   * `resolveCallConfig` refuses it before any provider I/O.
   */
  const support: ReasoningSupport = {
    efforts: [
      { id: ReasoningEffortId('low'), name: 'Low' },
      { id: ReasoningEffortId('medium'), name: 'Medium' },
      { id: ReasoningEffortId('high'), name: 'High' },
    ],
    defaultEffort: ReasoningEffortId('medium'),
  }

  it('advances to the next level', () => {
    expect(cycleThinking('low', support)).toBe('medium')
    expect(cycleThinking('medium', support)).toBe('high')
  })

  it('wraps from the last level back to the first', () => {
    // A cycle that stops at the end is a list. pi wraps.
    expect(cycleThinking('high', support)).toBe('low')
  })

  it('starts from the adapter default when nothing is selected', () => {
    // An absent selection means "provider default"; the first step should be the one
    // after that, not the one after a level that is not in effect.
    expect(cycleThinking(undefined, support)).toBe('high')
  })

  it('returns undefined when the model has no reasoning levels', () => {
    // The caller reports "this model has no thinking levels" rather than silently
    // applying an invented one.
    expect(cycleThinking(undefined, undefined)).toBeUndefined()
    expect(cycleThinking('low', { efforts: [] })).toBeUndefined()
  })

})

describe('a failed level change never reports success', () => {
  /**
   * `commitThinking` used to `showStatus` on success and **return silently** on
   * failure, while its callers printed the level unconditionally. Measured: with
   * `selectReasoningEffort` throwing `provider rejected`, the app emitted both
   * "thinking level not applied: provider rejected" *and* "thinking level: high" —
   * the status bar claiming the change the notice had just said failed.
   *
   * The fix is a return value, not a second check: one place decides whether it
   * worked, and the caller has nothing left to infer.
   */
  function appThatFails(): { failed: string[]; succeeded: string[] } {
    const notices: string[] = []
    const statuses: string[] = []
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
      reasoningSupport: async () => ({
        efforts: [
          { id: ReasoningEffortId('low'), name: 'L' },
          { id: ReasoningEffortId('high'), name: 'H' },
        ],
      }),
      selectReasoningEffort: () => { throw new Error('provider rejected') },
      terminal: new FakeTerminal(),
    })
    const internal = app as unknown as {
      showStatus(text: string): void
      addNotice(text: string): void
      cycleThinkingLevel(): Promise<void>
    }
    internal.showStatus = (text) => { statuses.push(text) }
    internal.addNotice = (text) => { notices.push(text) }
    void internal.cycleThinkingLevel()
    return { failed: notices, succeeded: statuses }
  }

  it('reports the failure and no success line', async () => {
    const { failed, succeeded } = appThatFails()
    await vi.waitFor(() => { expect(failed.length).toBeGreaterThan(0) })
    expect(failed.join('\n')).toMatch(/provider rejected/u)
    expect(succeeded).toEqual([])
  })
})
