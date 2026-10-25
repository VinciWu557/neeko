/**
 * `/thinking` — the reasoning effort of the **current** model.
 *
 * pi's shape (`handleThinkingCommand` / `showThinkingSelector`): a bare
 * `/thinking` opens a selector, `/thinking <level>` applies directly, an unknown
 * level is rejected with the list of valid ones, and applying the level you
 * already have is a no-op.
 *
 * What differs is where the levels come from. dsh does not let a client invent
 * them: `llm.resolveModelInfo(provider, model)` answers `reasoning.efforts` for
 * the **exact** route, and `resolveCallConfig` rejects an unsupported explicit
 * effort *before* provider I/O. A hard-coded `low|medium|high` list would offer
 * levels the model cannot run, so the whole module is a projection of the
 * adapter's answer.
 *
 * Effort belongs to the model, which is why {@linkcode withReasoningEffort}
 * only ever touches the effort: carrying one across a model switch pins the new
 * model to a level it may not support (see `model-switch.ts`).
 *
 * @module dsh-neeko/tui/thinking
 */

import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
// Shared selector chrome and cursor rule: every panel in this TUI answers the
// same keys and moves the same way, so those halves are not restated here.

/**
 * What the adapter says about one route's reasoning support.
 *
 * An alias of dsh's own `LlmModelReasoningInfo`, not a hand-written copy: the
 * copy this used to be could drift out of shape with the real one and turn a
 * breaking upstream change into an empty level list (silent), instead of a
 * compile error (loud).
 */
export type ReasoningSupport = LlmModelReasoningInfo

/** One selectable reasoning level, ready to render. */
export interface ThinkingChoice {
  readonly id: string
  readonly name: string
  readonly description?: string
  /** True for the level in effect right now (exactly one, at most). */
  readonly current: boolean
}

/**
 * Turn the adapter's answer into the rows a selector shows.
 *
 * @param support - `resolvedModelInfo.reasoning`, or `undefined` for a model
 *   without reasoning support.
 * @param selected - the effort in the live selection, if any.
 * @returns one choice per advertised effort, in adapter order; empty when the
 *   model has no reasoning support.
 */
export function thinkingChoices(
  support: ReasoningSupport | undefined,
  selected?: string | undefined,
): ThinkingChoice[] {
  if (support === undefined) return []
  // An absent selection means "provider default" on the wire; showing the
  // adapter's default as current is then honest, because that is what is sent.
  const inEffect = selected ?? support.defaultEffort
  return support.efforts.map((effort) => ({
    id: effort.id,
    name: effort.name,
    ...(effort.description === undefined ? {} : { description: effort.description }),
    current: effort.id === inEffect,
  }))
}

/** What `/thinking <arg>` means for this model and this selection. */
export type ThinkingOutcome =
  /** No argument: open the selector. */
  | { readonly kind: 'picker' }
  /** Apply this effort. */
  | { readonly kind: 'apply'; readonly effort: string }
  /** It is already in effect — report, do not rewrite. */
  | { readonly kind: 'unchanged'; readonly effort: string }
  /** The model advertises no reasoning levels at all. */
  | { readonly kind: 'unsupported' }
  /** No such level; `message` lists the valid ones. */
  | { readonly kind: 'unknown'; readonly message: string }

/**
 * Map one `/thinking` argument onto an intent.
 *
 * Pure so the four branches are assertable without a terminal — the level list
 * comes from the adapter, so "which branch" is the only thing this module
 * decides.
 *
 * @param argument - the text after `/thinking` (may be empty).
 * @param support - the model's reasoning support.
 * @param selected - the effort currently in effect, if any.
 * @returns the intent for the app to perform.
 */
export function thinkingOutcome(
  argument: string,
  support: ReasoningSupport | undefined,
  selected?: string | undefined,
): ThinkingOutcome {
  const choices = thinkingChoices(support, selected)
  if (choices.length === 0) return { kind: 'unsupported' }
  const wanted = argument.trim().toLowerCase()
  if (wanted === '') return { kind: 'picker' }
  // Both the opaque id and the display name are accepted: the menu shows names,
  // so typing what you see has to work, and ids are what completion inserts.
  const match = choices.find(
    (choice) => choice.id.toLowerCase() === wanted || choice.name.toLowerCase() === wanted,
  )
  if (match === undefined) {
    return {
      kind: 'unknown',
      message: `unknown thinking level "${argument.trim()}" (available: ${choices.map((choice) => choice.id).join(', ')})`,
    }
  }
  if (match.current === true) return { kind: 'unchanged', effort: match.id }
  return { kind: 'apply', effort: match.id }
}

/**
 * The next level in the cycle — the `shift+tab` action (`app.thinking.cycle`).
 *
 * pi advances in place rather than opening a selector, so a user can step through
 * levels while still looking at the transcript.
 *
 * Wraps, and starts from the level actually in effect: an absent selection means
 * "provider default" on the wire, so the first step is the one after that default
 * rather than the one after a level nobody chose.
 *
 * @param selected - the effort in effect, or `undefined` for the provider default.
 * @param support - what the adapter advertises for this route.
 * @returns the effort to apply, or `undefined` when there is nothing to cycle.
 */
export function cycleThinking(
  selected: string | undefined,
  support: ReasoningSupport | undefined,
): string | undefined {
  if (support === undefined || support.efforts.length === 0) return undefined
  const ids = support.efforts.map((effort) => effort.id)
  const first = ids[0]
  if (first === undefined) return undefined
  const inEffect = selected ?? support.defaultEffort ?? first
  const at = (ids as readonly string[]).indexOf(inEffect)
  // An unknown current level starts the cycle at the first entry: the live route can
  // name one this model no longer offers, and cycling must still land somewhere real.
  if (at === -1) return first
  return ids[(at + 1) % ids.length] ?? first
}

/**
 * The selection with one effort applied, or **removed** when clearing.
 *
 * Removal (not `reasoningEffort: undefined`) matters twice over: the DSH
 * contract reads an absent effort as "provider default" while a present one is
 * applied verbatim, and `exactOptionalPropertyTypes` forbids writing `undefined`
 * into an optional key.
 *
 * @param route - the selection in effect.
 * @param effort - the effort to apply, or `undefined` to clear it.
 * @returns a new selection; `provider`/`model` are untouched.
 */
export function withReasoningEffort(
  route: ModelSelection,
  effort: string | undefined,
): ModelSelection {
  const { reasoningEffort: _previous, ...rest } = route
  void _previous
  return effort === undefined ? rest : { ...rest, reasoningEffort: effort as never }
}
