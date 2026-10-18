/**
 * The model switch itself: what a selection becomes when the user picks another
 * model.
 *
 * Kept as a pure function because the rule is not obvious and getting it wrong
 * is silent. DSH's `installModelSelection` reads the ref at two points:
 *
 * - `system-prompt/assemble` snapshots `current` into `assembled`;
 * - `agent/request` resolves the request from `assembled`, stripping any
 *   inherited `reasoningEffort` and re-adding the selected one **only when it is
 *   defined**.
 *
 * So an absent effort means "restore this model's provider default", while a
 * present one is applied verbatim to whatever model is now selected. Carrying
 * the previous model's effort across a switch therefore pins the new model to a
 * level it may not support, and the request fails or silently degrades — which
 * the user observes as "the model switch does not take effect".
 *
 * @module dsh-neeko/tui/model-switch
 */

import type { ModelSelection } from '@deepseek-ai/dsh-agent'

/**
 * The selection to install when switching to another model.
 *
 * `provider` is preserved (a model id is only meaningful on its own route) and
 * every model-scoped attribute is dropped, `reasoningEffort` above all.
 *
 * @param previous - the selection in effect right now.
 * @param model - the model id the user picked.
 * @returns the selection for the next step that enters prompt assembly.
 */
export function switchedSelection(previous: ModelSelection, model: string): ModelSelection {
  return { provider: previous.provider, model }
}
