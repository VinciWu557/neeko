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
  /** Invoked whenever {@linkcode current} changes (set/cleared). */
  onChange: (() => void) | undefined

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
      this.onChange?.()
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
    this.onChange?.()
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
      this.onChange?.()
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
    this.onChange?.()
  }

  /**
   * Settle every pending interaction (teardown / exit).
   *
   * Distinct from {@linkcode cancelByUser} only in the aborted-question
   * message: a teardown is not something the user did, and conflating the two
   * made an ESC press report "connection closed".
   */
  cancelAll(): void {
    this.settleAll('dsh-neeko: connection closed before the user answered')
  }

  /**
   * Settle whatever is pending because the user dismissed it (ESC).
   *
   * Approval → `'cancelled'`; question → `ASK_ABORTED`. Both are the same
   * waterfall-legal outcomes as an aborted signal, so the agent unblocks
   * instead of waiting for an answer that is no longer coming.
   */
  cancelByUser(): void {
    this.settleAll('dsh-neeko: question cancelled by the user')
  }

  private settleAll(questionAbortMessage: string): void {
    this.finishApproval('cancelled')
    this.finishQuestion(new UserQuestionError(questionAbortMessage, 'ASK_ABORTED'))
    this.questionQueue = []
  }
}

/**
 * What the UI must do with one keystroke while an interaction is pending.
 *
 * The split is deliberate: deciding *what* a key means is a pure function of
 * (view, key), and only the app performs the effects. That is what makes the
 * routing testable without a terminal — and what previously let two branches
 * go missing (a pending question answered by sending the text to the model,
 * and ESC doing nothing on a question while it cancelled an approval).
 */
export type InteractionIntent =
  /** Resolve the approval with `allowed-once`. */
  | { readonly kind: 'allow-approval' }
  /** Resolve the approval with `rejected`. */
  | { readonly kind: 'reject-approval' }
  /** Abort whatever is pending (ESC): approval → `cancelled`, question → `ASK_ABORTED`. */
  | { readonly kind: 'cancel' }
  /** Answer the pending question with an option label. */
  | { readonly kind: 'answer-option'; readonly label: string }
  /** Swallow the key: an interaction owns the keyboard but this key does nothing. */
  | { readonly kind: 'ignore' }
  /** Not an interaction key — let the editor (or another mode) handle it. */
  | { readonly kind: 'pass-through' }

/**
 * Render the inline interaction panel.
 *
 * Pure so the wording and the branch structure are assertable without a screen
 * — the three defects found in this layer (wrong destination for a submitted
 * answer, missing ESC, a stale panel) were all invisible to the state-machine
 * tests.
 *
 * @param view - the pending view, or `undefined` when idle.
 * @returns the panel text; `''` when nothing is pending.
 */
export function renderInteractionPanel(view: InteractionView | undefined): string {
  if (view === undefined) return ''
  if (view.kind === 'approval') {
    const reason = view.reason === undefined ? '' : ` — ${view.reason}`
    return `⚠ approve ${view.toolName}${reason}\n[y] allow   [n] reject   [esc] cancel`
  }
  const optionLines = view.options.length === 0
    ? '(type your answer, enter to submit)'
    : view.options.map((option) => `  ${Number(option.id) + 1}. ${option.label}`).join('\n')
  return `? (${view.index}/${view.total}) ${view.question}\n${optionLines}`
}

/**
 * Map one keystroke to an {@linkcode InteractionIntent}.
 *
 * @param view - the pending view, or `undefined` when idle.
 * @param isKey - predicate: does this key data match a named key?
 * @param digits - `1`-`9` extracted from the input, or `undefined`.
 * @returns the intent; `pass-through` when no interaction is pending.
 */
export function interactionIntent(
  view: InteractionView | undefined,
  isKey: (name: 'escape' | 'y' | 'n') => boolean,
  digit: number | undefined,
): InteractionIntent {
  if (view === undefined) return { kind: 'pass-through' }
  if (isKey('escape')) return { kind: 'cancel' }
  if (view.kind === 'approval') {
    if (isKey('y')) return { kind: 'allow-approval' }
    if (isKey('n')) return { kind: 'reject-approval' }
    // An approval must not leak typing into the editor.
    return { kind: 'ignore' }
  }
  if (digit !== undefined) {
    const option = view.options[digit - 1]
    if (option !== undefined) return { kind: 'answer-option', label: option.label }
    return { kind: 'ignore' }
  }
  // A free-text question consumes Enter through the editor: `undefined` here
  // means "not an interaction key", and the app routes the submission to
  // `answerQuestion` instead of the model.
  return { kind: 'pass-through' }
}
