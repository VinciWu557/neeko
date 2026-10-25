import { describe, expect, it } from 'vitest'
import { InteractionManager, interactionIntent, renderInteractionPanel } from '../src/tui/interactions.ts'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'

/**
 * The interaction state machines. The decline/abort paths are the
 * highest-consequence branches (same class as the bridge's next() contract:
 * a swallowed question hangs the agent forever), so every settle path is
 * pinned — including the abort listener, which must fire on a signal that
 * aborts AFTER the request was presented.
 */

const approvalRequest = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ({ toolName: 'bash', ...overrides }) as ApprovalRequest

const questionRequest = (): AskUserQuestionRequest =>
  ({
    questions: [
      { id: 'q1', question: 'continue?' },
      { id: 'q2', question: 'which path?', options: [{ id: 'a', label: 'left' }, { id: 'b', label: 'right' }] },
    ],
  }) as AskUserQuestionRequest

describe('InteractionManager — approval', () => {
  it('resolves allowed-once on the allow path and clears the view', async () => {
    const m = new InteractionManager()
    const pending = m.approve(approvalRequest())
    expect(m.current).toMatchObject({ kind: 'approval', toolName: 'bash' })
    m.allowApproval()
    await expect(pending).resolves.toBe('allowed-once')
    expect(m.current).toBeUndefined()
  })

  it('resolves rejected on the reject path', async () => {
    const m = new InteractionManager()
    const pending = m.approve(approvalRequest())
    m.rejectApproval()
    await expect(pending).resolves.toBe('rejected')
  })

  it('returns cancelled immediately for an already-aborted signal', async () => {
    const m = new InteractionManager()
    const controller = new AbortController()
    controller.abort()
    await expect(m.approve(approvalRequest({ signal: controller.signal }))).resolves.toBe('cancelled')
    expect(m.current).toBeUndefined()
  })

  it('resolves cancelled when the signal aborts after presentation', async () => {
    const m = new InteractionManager()
    const controller = new AbortController()
    const pending = m.approve(approvalRequest({ signal: controller.signal }))
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(m.current).toBeUndefined()
  })

  it('cancelAll settles a pending approval with cancelled', async () => {
    const m = new InteractionManager()
    const pending = m.approve(approvalRequest())
    m.cancelAll()
    await expect(pending).resolves.toBe('cancelled')
  })
})

describe('InteractionManager — questions', () => {
  it('collects answers one question at a time in order', async () => {
    const m = new InteractionManager()
    const pending = m.ask(questionRequest())

    expect(m.current).toMatchObject({ kind: 'question', index: 1, total: 2, question: 'continue?' })
    m.answerQuestion('yes') // free text (no options on q1)
    await Promise.resolve() // let the ask() loop advance

    expect(m.current).toMatchObject({ kind: 'question', index: 2, total: 2, question: 'which path?' })
    m.answerQuestion('left') // option label
    await expect(pending).resolves.toEqual({
      answers: [
        { id: 'q1', selected: [], custom: 'yes' },
        { id: 'q2', selected: ['left'] },
      ],
    })
    expect(m.current).toBeUndefined()
  })

  it('rejects with ASK_ABORTED when the signal aborts mid-question', async () => {
    const m = new InteractionManager()
    const controller = new AbortController()
    const pending = m.ask({ ...questionRequest(), signal: controller.signal } as unknown as AskUserQuestionRequest)
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
    expect(m.current).toBeUndefined()
  })

  it('rejects the whole batch when cancelled', async () => {
    const m = new InteractionManager()
    const pending = m.ask(questionRequest())
    m.cancelAll()
    await expect(pending).rejects.toThrow('closed')
  })

  it('answerQuestion is a no-op when idle (no phantom answers)', () => {
    const m = new InteractionManager()
    expect(() => m.answerQuestion('stray')).not.toThrow()
  })
})

describe('renderInteractionPanel', () => {
  it('is empty when idle', () => {
    expect(renderInteractionPanel(undefined)).toBe('')
  })

  it('shows the tool, the reason and every key hint for an approval', () => {
    const text = renderInteractionPanel({ kind: 'approval', toolName: 'bash', reason: 'needs write' })
    expect(text).toContain('approve bash')
    expect(text).toContain('needs write')
    expect(text).toContain('[y] allow')
    expect(text).toContain('[n] reject')
    expect(text).toContain('[esc] cancel')
  })

  it('omits the em dash when the approval carries no reason', () => {
    const text = renderInteractionPanel({ kind: 'approval', toolName: 'bash', reason: undefined })
    expect(text).toContain('approve bash\n')
    expect(text).not.toContain('—')
  })

  it('numbers the options 1-based and shows the counter', () => {
    const text = renderInteractionPanel({
      kind: 'question', index: 2, total: 3, question: 'Which?',
      options: [{ id: '0', label: 'Alpha' }, { id: '1', label: 'Beta' }],
    })
    expect(text).toContain('(2/3)')
    expect(text).toContain('Which?')
    expect(text).toContain('1. Alpha')
    expect(text).toContain('2. Beta')
  })

  it('tells the user to type when a question has no options', () => {
    const text = renderInteractionPanel({ kind: 'question', index: 1, total: 1, question: 'Name?', options: [] })
    expect(text).toContain('type your answer, enter to submit')
  })
})

describe('interactionIntent', () => {
  const never = (): boolean => false
  const only = (name: string) => (candidate: string): boolean => candidate === name

  it('passes every key through when nothing is pending', () => {
    expect(interactionIntent(undefined, only('y'), 1)).toEqual({ kind: 'pass-through' })
  })

  it('cancels on escape for BOTH kinds (the discrepancy that stranded questions)', () => {
    const approval = { kind: 'approval', toolName: 't', reason: undefined } as const
    const question = { kind: 'question', index: 1, total: 1, question: 'q', options: [] } as const
    expect(interactionIntent(approval, only('escape'), undefined)).toEqual({ kind: 'cancel' })
    expect(interactionIntent(question, only('escape'), undefined)).toEqual({ kind: 'cancel' })
  })

  it('maps y/n on an approval and swallows everything else', () => {
    const approval = { kind: 'approval', toolName: 't', reason: undefined } as const
    expect(interactionIntent(approval, only('y'), undefined)).toEqual({ kind: 'allow-approval' })
    expect(interactionIntent(approval, only('n'), undefined)).toEqual({ kind: 'reject-approval' })
    expect(interactionIntent(approval, never, undefined)).toEqual({ kind: 'ignore' })
  })

  it('maps a valid digit to that option', () => {
    const view = {
      kind: 'question', index: 1, total: 1, question: 'q',
      options: [{ id: '0', label: 'A' }, { id: '1', label: 'B' }],
    } as const
    expect(interactionIntent(view, never, 2)).toEqual({ kind: 'answer-option', label: 'B' })
  })

  it('swallows an out-of-range digit instead of answering with undefined', () => {
    const view = {
      kind: 'question', index: 1, total: 1, question: 'q', options: [{ id: '0', label: 'A' }],
    } as const
    expect(interactionIntent(view, never, 9)).toEqual({ kind: 'ignore' })
  })

  it('lets a free-text question fall through to the editor', () => {
    const view = { kind: 'question', index: 1, total: 1, question: 'q', options: [] } as const
    expect(interactionIntent(view, never, undefined)).toEqual({ kind: 'pass-through' })
  })
})
