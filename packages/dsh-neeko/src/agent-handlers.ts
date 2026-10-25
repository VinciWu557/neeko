/**
 * Agent-scoped event wiring for the Neeko bridge.
 *
 * Both human-interaction seams are Cordis waterfalls on the *agent* context,
 * not methods on a global service:
 *
 * - `approval/request` — `dsh-user-approval` dispatches it via
 *   `ctx.waterfall(scopeTarget(agent, agent), 'approval/request', req, ...)`.
 * - `user-questions/request` — `dsh-user-questions` dispatches it the same way
 *   (`UserQuestionService.ask`), documented as *"UI packages compose answerers
 *   on the Agent-scoped Cordis waterfall."*
 *
 * Historical note (why this file exists): the bridge originally called
 * `ctx.get('userQuestions').registerProvider(...)`. That method lived in
 * dsh-user-questions 0.1.0-rc.8 — which devDependencies pinned, so `tsc`
 * passed — and was removed by 0.2.0-rc.2, which the dsh CLI actually loads.
 * The profile row therefore crashed on `registerProvider is not a function`
 * before ever binding a port. Keeping the wiring in a small, injectable
 * function is what makes that regression testable without a live dsh runtime.
 *
 * @module dsh-neeko/agent-handlers
 */

import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'

/**
 * The two waterfall seams this module registers, typed against the real dsh
 * contracts. A genuine Cordis `Context` satisfies this interface structurally,
 * so no cast is needed at the call site — which is what keeps "used a removed
 * API" a compile error rather than a runtime crash.
 */
export interface AgentEventSource {
  on(
    name: 'approval/request',
    listener: (request: ApprovalRequest) => Promise<ApprovalOutcome>,
  ): () => void
  on(
    name: 'user-questions/request',
    listener: (request: AskUserQuestionRequest, next: NextAnswerer) => Promise<AskUserQuestionAnswer>,
  ): () => void
}

/** Callbacks the bridge supplies; they own the actual approval/question plumbing. */
export interface AgentHandlers {
  /** Resolve one approval request against the Neeko connection. */
  onApproval(request: ApprovalRequest): Promise<ApprovalOutcome>
  /**
   * Answer one question batch, or return `undefined` to decline so the
   * waterfall falls through to the next answerer (the inner `noAnswerer`
   * then rejects with `NO_PROVIDER`).
   */
  onQuestion(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer | undefined>
}

/**
 * The waterfall's inner answerer: what `next()` resolves to.
 * Mirrors `user-questions/request`'s declared signature in dsh 0.2.x.
 */
export type NextAnswerer = () => Promise<AskUserQuestionAnswer>

/**
 * Register both interaction waterfalls on one agent context.
 *
 * Declining (returning `undefined` from `onQuestion`) MUST call `next()` rather
 * than resolve — otherwise a bridge with no active connection would swallow the
 * question and leave the agent blocked forever.
 *
 * The listener bodies are typed against the real dsh contracts (not cast away):
 * that is what turns "used a removed API" into a compile error instead of a
 * runtime crash — the exact failure mode this module was created to prevent.
 *
 * @param source - the agent-scoped event source (a Cordis `Context`).
 * @param handlers - bridge-owned callbacks.
 * @returns a disposer that unregisters both listeners.
 */
export function registerAgentHandlers(source: AgentEventSource, handlers: AgentHandlers): () => void {
  const approvalDisposer = source.on('approval/request', (request) => handlers.onApproval(request))

  const questionDisposer = source.on('user-questions/request', (request, next) =>
    handlers.onQuestion(request).then((answer) => answer ?? next()))

  return () => {
    approvalDisposer()
    questionDisposer()
  }
}

/**
 * Whether the bridge can answer a question at all.
 *
 * This is the highest-consequence branch in the bridge: answering when nobody
 * is listening hangs the agent forever (the question is never seen and the
 * waterfall never falls through). Kept as a named predicate so the decision is
 * unit-testable without constructing a `NeekoBridge` (which needs a real Cordis
 * context and a live server).
 *
 * @param hasConnection - whether a Neeko client is currently attached.
 * @returns `true` when the bridge should answer, `false` when it must decline.
 */
export function canAnswerQuestions(hasConnection: boolean): boolean {
  return hasConnection
}
