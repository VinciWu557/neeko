import { describe, expect, it } from 'vitest'
import {
  renderThinkingPicker,
  thinkingChoices,
  thinkingOutcome,
  withReasoningEffort,
} from '../src/tui/thinking.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

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

describe('renderThinkingPicker without a pinned level', () => {
  const plain = (token: string, text: string): string => text

  it('says the provider default applies when nothing is marked', () => {
    // Real dsh answers `reasoning.efforts` with no `defaultEffort`, and a fresh
    // selection has no effort — so no row can carry `✓`. Silence there reads as
    // a broken panel rather than as "no level is pinned".
    const text = renderThinkingPicker({
      choices: [
        { id: ReasoningEffortId('low'), name: 'Low', current: false },
        { id: ReasoningEffortId('high'), name: 'High', current: false },
      ],
      index: 0,
    }, { fg: plain })
    expect(text).toContain('provider default')
  })

  it('stays quiet when a level is marked', () => {
    const text = renderThinkingPicker({
      choices: [{ id: ReasoningEffortId('low'), name: 'Low', current: true }],
      index: 0,
    }, { fg: plain })
    expect(text).not.toContain('provider default')
  })
})
