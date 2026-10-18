/**
 * Interaction UIs for the two human-interaction waterfalls: approvals and
 * user questions. Same waiter lifecycle as the bridge (Map + abort listener +
 * cancelAll on teardown), but the "answerer" is the local keyboard instead of
 * a remote WebSocket client.
 *
 * The rendering contract is intentionally minimal: this module owns STATE and
 * resolves promises; the app renders `renderInteraction()` output inline above
 * the editor. That keeps the waterfall contracts unit-testable without a TUI.
 *
 * @module dsh-neeko/tui/interactions
 */

import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'

/** What the UI should currently display above the editor. */
export type InteractionView =
  | {
      readonly kind: 'approval'
      readonly toolName: string
      readonly reason: string | undefined
    }
  | {
      readonly kind: 'question'
      readonly index: number
      readonly total: number
      readonly question: string
      readonly options: readonly { id: string; label: string }[]
    }

interface PendingInteraction {
  readonly signal?: AbortSignal
  readonly onAbort: () => void
}

/**
 * Owns the single active interaction and resolves its promise.
 *
 * Invariants (mirroring the bridge, mutation-tested there):
 * - One interaction at a time; a second request while one is pending is
 *   rejected by dsh's waterfall, not by us.
 * - Abort (request.signal or ESC) resolves approvals with `'cancelled'` and
 *   rejects questions with `ASK_ABORTED` — never silence.
 * - `cancelAll()` on teardown settles everything (connection close / exit).
 */
export class InteractionManager {
  private pending: PendingInteraction | undefined
  private view: InteractionView | undefined

  private settleApproval: ((outcome: ApprovalOutcome) => void) | undefined
  private settleQuestion: { resolve: (item: AskUserQuestionAnswerItem) => void; reject: (error: Error) => void } | undefined
  private questionQueue: { item: AskUserQuestionItem; signal?: AbortSignal }[] = []
  private questionTotal = 0
  private questionIndex = 0

  /** The view to render, or `undefined` when idle. */
  get current(): InteractionView | undefined {
    return this.view
  }

  get busy(): boolean {
    return this.pending !== undefined
  }

  /**
   * Present an approval and wait for the user's decision.
   * @param request - the waterfall request.
   * @returns the outcome; `'cancelled'` when aborted.
   */
  async approve(request: ApprovalRequest): Promise<ApprovalOutcome> {
    if (request.signal?.aborted) return 'cancelled'
    return new Promise<ApprovalOutcome>((resolve) => {
      const onAbort = (): void => { this.finishApproval('cancelled') }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending = { ...(request.signal === undefined ? {} : { signal: request.signal }), onAbort }
      this.settleApproval = resolve
      this.view = { kind: 'approval', toolName: request.toolName, reason: request.reason }
    })
  }

  /** Resolve the active approval (allow path). */
  allowApproval(): void {
    this.finishApproval('allowed-once')
  }

  /** Resolve the active approval (reject path). */
  rejectApproval(): void {
    this.finishApproval('rejected')
  }

  private finishApproval(outcome: ApprovalOutcome): void {
    if (this.settleApproval === undefined) return
    this.pending?.signal?.removeEventListener('abort', this.pending.onAbort)
    this.pending = undefined
    this.view = undefined
    const resolve = this.settleApproval
    this.settleApproval = undefined
    resolve(outcome)
  }

  /**
   * Present a question batch and collect structured answers, one question at
   * a time (options → SelectList; free text → editor).
   *
   * @param request - the waterfall request.
   * @returns the DSH answer shape, or rejection with `ASK_ABORTED`.
   */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    if (request.signal?.aborted) {
      return Promise.reject(new UserQuestionError('dsh-neeko: question aborted before the user answered', 'ASK_ABORTED'))
    }
    this.questionQueue = request.questions.map((item) => request.signal === undefined
      ? { item }
      : { item, signal: request.signal })
    this.questionTotal = request.questions.length
    this.questionIndex = 0
    const answers: AskUserQuestionAnswerItem[] = []
    while (this.questionQueue.length > 0) {
      const next = this.questionQueue[0]
      if (next === undefined) break
      answers.push(await this.askOne(next.item, next.signal))
      this.questionQueue.shift()
      this.questionIndex += 1
    }
    return { answers }
  }

  private askOne(question: AskUserQuestionItem, signal?: AbortSignal): Promise<AskUserQuestionAnswerItem> {
    if (signal?.aborted) {
      return Promise.reject(new UserQuestionError('dsh-neeko: question aborted before the user answered', 'ASK_ABORTED'))
    }
    return new Promise<AskUserQuestionAnswerItem>((resolve, reject) => {
      const onAbort = (): void => {
        this.finishQuestion(new UserQuestionError('dsh-neeko: question aborted before the user answered', 'ASK_ABORTED'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending = { ...(signal === undefined ? {} : { signal }), onAbort }
      this.settleQuestion = { resolve, reject }
      this.view = {
        kind: 'question',
        index: this.questionIndex + 1,
        total: this.questionTotal,
        question: question.question,
        options: question.options?.map((option, index) => ({ id: String(index), label: option.label })) ?? [],
      }
    })
  }

  /** Answer the active question with a chosen option label or free text. */
  answerQuestion(text: string): void {
    if (this.settleQuestion === undefined || this.view?.kind !== 'question') return
    const question = this.questionQueue[0]?.item
    if (question === undefined) return
    const option = question.options?.find((candidate) => candidate.label === text)
    this.finishQuestion({
      id: question.id,
      selected: option === undefined ? [] : [option.label],
      ...(option === undefined && text !== '' ? { custom: text } : {}),
    })
  }

  private finishQuestion(result: AskUserQuestionAnswerItem | Error): void {
    if (this.settleQuestion === undefined) return
    this.pending?.signal?.removeEventListener('abort', this.pending.onAbort)
    this.pending = undefined
    this.view = undefined
    const settle = this.settleQuestion
    this.settleQuestion = undefined
    if (result instanceof Error) settle.reject(result)
    else settle.resolve(result)
  }

  /** Settle every pending interaction (teardown / exit). */
  cancelAll(): void {
    this.finishApproval('cancelled')
    this.finishQuestion(new UserQuestionError('dsh-neeko: connection closed before the user answered', 'ASK_ABORTED'))
    this.questionQueue = []
  }
}
