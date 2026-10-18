import { describe, expect, it } from 'vitest'
import { switchedSelection } from '../src/tui/model-switch.ts'

/**
 * The rule that makes a model switch actually take effect.
 *
 * DSH's `agent/request` handler strips whatever effort the inner resolver
 * produced and re-adds the selected one only when it is defined, so `undefined`
 * means "let the new model use its provider default" while a value is applied
 * verbatim. These cases pin that a switch never carries the old model's effort.
 */

describe('switchedSelection', () => {
  it('keeps the provider and takes the new model', () => {
    expect(switchedSelection({ provider: 'magpie', model: 'a' }, 'b')).toEqual({
      provider: 'magpie',
      model: 'b',
    })
  })

  it('DROPS the previous reasoning effort (the switch was silently ineffective)', () => {
    // Regression: `{ ...route, model: id }` carried `reasoningEffort: 'high'`
    // into a model that may not support it; DSH applies it verbatim, so the
    // request failed or degraded and the switch looked like a no-op.
    const next = switchedSelection({ provider: 'p', model: 'a', reasoningEffort: 'high' as never }, 'b')
    expect(next).not.toHaveProperty('reasoningEffort')
    expect(next).toEqual({ provider: 'p', model: 'b' })
  })

  it('does not mutate the previous selection', () => {
    const previous = { provider: 'p', model: 'a', reasoningEffort: 'low' as never }
    switchedSelection(previous, 'b')
    expect(previous).toEqual({ provider: 'p', model: 'a', reasoningEffort: 'low' })
  })

  it('is a pure replacement even when switching to the same model', () => {
    const previous = { provider: 'p', model: 'a', reasoningEffort: 'max' as never }
    // Re-selecting the current model still drops the effort: the user asking for
    // that model means "that model's default", not "keep this pinned level".
    expect(switchedSelection(previous, 'a')).toEqual({ provider: 'p', model: 'a' })
  })
})
