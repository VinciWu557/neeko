import { describe, expect, it, vi } from 'vitest'
import { canAnswerQuestions, registerAgentHandlers } from '../src/agent-handlers.ts'
import type { AgentEventSource, AgentHandlers } from '../src/agent-handlers.ts'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'

/**
 * Regression origin: the bridge registered questions with
 * `ctx.get('userQuestions').registerProvider(...)`. That method exists in
 * dsh-user-questions 0.1.0-rc.8 (what devDependencies pinned, so `tsc` passed)
 * but was REMOVED in 0.2.0-rc.2 (what the dsh CLI actually loads). The profile
 * row crashed at startup with `registerProvider is not a function` and the
 * bridge never bound a port.
 *
 * The supported seam is the Agent-scoped Cordis waterfall
 * `user-questions/request` — the same shape `approval/request` already used.
 *
 * These cases pin the *contract*, not just the registration. An earlier version
 * of this file asserted only "a listener was registered", which meant a
 * mutation that stopped calling `next()` (permanently hanging every agent)
 * still left the suite green. The decline, abort and answer-shape cases below
 * exist specifically to fail under those mutations.
 */

const ANSWER: AskUserQuestionAnswer = {
  answers: [{ id: 'q1', selected: ['yes'] }],
}

/** A source that captures listeners so a test can drive the waterfall itself. */
function capturingSource(): {
  source: AgentEventSource
  names: string[]
  question: (request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>
  approval: (request: ApprovalRequest) => Promise<ApprovalOutcome>
} {
  const names: string[] = []
  let questionListener: ((request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>) | undefined
  let approvalListener: ((request: ApprovalRequest) => Promise<ApprovalOutcome>) | undefined

  const source = {
    on(name: string, listener: unknown): () => void {
      names.push(name)
      if (name === 'user-questions/request') {
        questionListener = listener as typeof questionListener
      } else if (name === 'approval/request') {
        approvalListener = listener as typeof approvalListener
      }
      return () => {}
    },
  } as unknown as AgentEventSource

  return {
    source,
    names,
    question: (request, next) => {
      if (questionListener === undefined) throw new Error('question listener not registered')
      return questionListener(request, next)
    },
    approval: (request) => {
      if (approvalListener === undefined) throw new Error('approval listener not registered')
      return approvalListener(request)
    },
  }
}

function handlers(overrides: Partial<AgentHandlers> = {}): AgentHandlers {
  return {
    onApproval: async () => 'allowed-once',
    onQuestion: async () => ANSWER,
    ...overrides,
  }
}

const QUESTION_REQUEST = { questions: [{ id: 'q1', question: 'continue?' }] } as AskUserQuestionRequest
const APPROVAL_REQUEST = { toolName: 'bash' } as ApprovalRequest

describe('registerAgentHandlers — registration', () => {
  it('subscribes to both waterfalls in a stable order', () => {
    const { source, names } = capturingSource()
    registerAgentHandlers(source, handlers())
    expect(names).toEqual(['approval/request', 'user-questions/request'])
  })

  it('disposes every listener it registered', () => {
    const disposed: string[] = []
    const source = {
      on(name: string): () => void {
        return () => { disposed.push(name) }
      },
    } as unknown as AgentEventSource
    registerAgentHandlers(source, handlers())()
    expect(disposed).toEqual(['approval/request', 'user-questions/request'])
  })
})

describe('registerAgentHandlers — question contract', () => {
  it('returns the handler answer without consulting next()', async () => {
    const { source, question } = capturingSource()
    const next = vi.fn(async () => ANSWER)
    registerAgentHandlers(source, handlers())
    await expect(question(QUESTION_REQUEST, next)).resolves.toEqual(ANSWER)
    // Accepting must not also fall through.
    expect(next).not.toHaveBeenCalled()
  })

  it('calls next() when the handler declines', async () => {
    // This is the blocker case: without next() the question is swallowed and
    // the agent waits forever. Declining must hand off to the inner answerer.
    const { source, question } = capturingSource()
    const next = vi.fn(async () => ANSWER)
    registerAgentHandlers(source, handlers({ onQuestion: async () => undefined }))
    await expect(question(QUESTION_REQUEST, next)).resolves.toEqual(ANSWER)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('propagates the inner NO_PROVIDER rejection when declining', async () => {
    const { source, question } = capturingSource()
    const noProvider = vi.fn(async (): Promise<AskUserQuestionAnswer> => {
      throw new Error('NO_PROVIDER')
    })
    registerAgentHandlers(source, handlers({ onQuestion: async () => undefined }))
    await expect(question(QUESTION_REQUEST, noProvider)).rejects.toThrow('NO_PROVIDER')
  })

  it('propagates a handler rejection instead of swallowing it', async () => {
    const { source, question } = capturingSource()
    const next = vi.fn(async () => ANSWER)
    registerAgentHandlers(source, handlers({
      onQuestion: async () => { throw new Error('ASK_ABORTED') },
    }))
    await expect(question(QUESTION_REQUEST, next)).rejects.toThrow('ASK_ABORTED')
    expect(next).not.toHaveBeenCalled()
  })

  it('passes the request through to the handler unchanged', async () => {
    const { source, question } = capturingSource()
    const seen: AskUserQuestionRequest[] = []
    registerAgentHandlers(source, handlers({
      onQuestion: async (request) => { seen.push(request); return ANSWER },
    }))
    await question(QUESTION_REQUEST, async () => ANSWER)
    expect(seen[0]).toBe(QUESTION_REQUEST)
  })
})

describe('registerAgentHandlers — approval contract', () => {
  it('routes approvals to the handler and returns its outcome', async () => {
    const { source, approval } = capturingSource()
    const seen: ApprovalRequest[] = []
    registerAgentHandlers(source, handlers({
      onApproval: async (request) => { seen.push(request); return 'rejected' },
    }))
    await expect(approval(APPROVAL_REQUEST)).resolves.toBe('rejected')
    expect(seen[0]).toBe(APPROVAL_REQUEST)
  })

  it('propagates an approval rejection', async () => {
    const { source, approval } = capturingSource()
    registerAgentHandlers(source, handlers({
      onApproval: async () => { throw new Error('boom') },
    }))
    await expect(approval(APPROVAL_REQUEST)).rejects.toThrow('boom')
  })
})

describe('canAnswerQuestions — the decline decision', () => {
  it('declines when no Neeko client is attached', () => {
    // Answering without a listener would hang the agent forever: the question is
    // never rendered and the waterfall never falls through to NO_PROVIDER.
    expect(canAnswerQuestions(false)).toBe(false)
  })

  it('answers when a Neeko client is attached', () => {
    expect(canAnswerQuestions(true)).toBe(true)
  })
})
