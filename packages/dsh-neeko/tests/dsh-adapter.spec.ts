import { describe, expect, it } from 'vitest'
import { buildHistory, translateEvent, translateStreamFrame } from '../src/dsh-adapter.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

/**
 * These cases pin the translation layer to the **0.2.0-rc.2** event model.
 *
 * The previous implementation targeted 0.1.x, whose log carried `assistant/chunk`
 * rows. 0.2.0-rc.2 removed that event entirely: settled assistant output arrives
 * as a single `assistant/message` (with the compact `stream` records), and live
 * deltas arrive on a *separate* agent-scoped channel, `agent/assistant-stream`.
 *
 * Keeping these two sources distinct is the core invariant: the durable log must
 * never be treated as a delta source again.
 */

let seq = 0
function ev<K extends string>(type: K, data: unknown, time = 1000): SessionEvent {
  seq += 1
  return { type, seq, time, data } as unknown as SessionEvent
}

describe('translateEvent — 0.2.0-rc.2 durable log', () => {
  it('does not emit deltas for a settled assistant message', () => {
    // Live text already reached the client via agent/assistant-stream; replaying
    // it from the log would double every token.
    const message = ev('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'hello' }], source: {} },
      stream: [],
    })
    expect(translateEvent(message)).toEqual([])
  })

  it('ignores the removed assistant/chunk event without throwing', () => {
    const legacy = ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'x' } })
    expect(translateEvent(legacy)).toEqual([])
  })

  it('maps tool/call to tool.start with parsed arguments', () => {
    const event = ev('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'bash', arguments: '{"cmd":"ls"}' })
    expect(translateEvent(event)).toEqual([{
      type: 'tool.start',
      payload: { taskId: 'c1', toolName: 'bash', args: { cmd: 'ls' } },
    }])
  })

  it('keeps raw arguments when they are not valid JSON', () => {
    const event = ev('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'bash', arguments: 'not json' })
    const [message] = translateEvent(event)
    expect(message).toMatchObject({ type: 'tool.start', payload: { args: 'not json' } })
  })

  it('maps a failed tool/result to status failed', () => {
    const event = ev('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', id: 'r1', toolCallId: ToolCallId('c1'), isError: true, content: [{ type: 'text', text: 'boom' }], source: {} },
      error: { name: 'E', code: 'E_FAIL' },
    })
    expect(translateEvent(event)).toEqual([{
      type: 'tool.end',
      payload: { taskId: 'c1', status: 'failed', result: 'boom' },
    }])
  })

  it('maps a successful tool/result to status success', () => {
    const event = ev('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', id: 'r1', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: 'ok' }], source: {} },
    })
    expect(translateEvent(event)).toEqual([{
      type: 'tool.end',
      payload: { taskId: 'c1', status: 'success', result: 'ok' },
    }])
  })

  it('extracts the fs diff from tool meta', () => {
    const event = ev('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', id: 'r1', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: 'changed' }], source: {} },
      meta: { diffs: [{ path: 'a.txt', oldText: 'a', newText: 'b' }] },
    })
    const [message] = translateEvent(event)
    expect(message).toMatchObject({
      type: 'tool.end',
      payload: { diff: { filePath: 'a.txt', patch: 'b' } },
    })
  })

  it('ignores presentation-only and lifecycle events', () => {
    expect(translateEvent(ev('turn/start', { turn: 1 }))).toEqual([])
    expect(translateEvent(ev('step/end', { turn: 1, step: 1 }))).toEqual([])
  })
})

describe('translateStreamFrame — live agent/assistant-stream channel', () => {
  const start = { type: 'start', attemptId: LlmAttemptId('a1'), revision: 1, turn: 3, step: 2 } as const

  it('emits text.delta for a text-delta chunk', () => {
    const frame = { type: 'chunk', attemptId: LlmAttemptId('a1'), revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } } as const
    expect(translateStreamFrame(start, frame)).toEqual([{
      type: 'text.delta',
      payload: { chunk: 'hi', messageId: 'assistant:3:2:a1' },
    }])
  })

  it('emits thinking.delta for a reasoning-delta chunk', () => {
    const frame = { type: 'chunk', attemptId: LlmAttemptId('a1'), revision: 1, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' } } as const
    expect(translateStreamFrame(start, frame)).toEqual([{
      type: 'thinking.delta',
      payload: { chunk: 'hmm' },
    }])
  })

  it('emits nothing for tool-call deltas, block markers, usage and finish', () => {
    const chunks: StreamChunk[] = [
      { type: 'tool-call-delta', index: 0, id: ToolCallId('c1'), argumentsDelta: '{' },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } as unknown as TokenUsage },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    for (const chunk of chunks) {
      const frame = { type: 'chunk', attemptId: LlmAttemptId('a1'), revision: 1, index: 0, time: 1, chunk } as const
      expect(translateStreamFrame(start, frame)).toEqual([])
    }
  })

  it('scopes the message id to the attempt so a retry does not collide', () => {
    // dsh-agent-loop retries a step by re-running the same turn/step with a new
    // attemptId. Without the attempt in the id, failed-attempt text would be
    // spliced into the successful retry's message.
    const first = translateStreamFrame(start, {
      type: 'chunk', attemptId: LlmAttemptId('a1'), revision: 1, index: 0, time: 1,
      chunk: { type: 'text-delta', index: 0, text: 'first' },
    } as const)
    const second = translateStreamFrame(
      { type: 'start', attemptId: LlmAttemptId('a2'), revision: 2, turn: 3, step: 2 } as const,
      {
        type: 'chunk', attemptId: LlmAttemptId('a2'), revision: 2, index: 0, time: 2,
        chunk: { type: 'text-delta', index: 0, text: 'second' },
      } as const,
    )
    const idOf = (msgs: typeof first) => (msgs[0]?.type === 'text.delta' ? msgs[0].payload.messageId : undefined)
    expect(idOf(first)).not.toBe(idOf(second))
  })

  it('emits nothing before a start frame establishes turn/step', () => {
    const frame = { type: 'chunk', attemptId: LlmAttemptId('a1'), revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } } as const
    expect(translateStreamFrame(undefined, frame)).toEqual([])
  })

  it('emits nothing for the start and end frames themselves', () => {
    expect(translateStreamFrame(undefined, start)).toEqual([])
    const end = { type: 'end', attemptId: LlmAttemptId('a1'), revision: 1, index: 1, outcome: { kind: 'abandoned' } } as const
    expect(translateStreamFrame(start, end)).toEqual([])
  })
})

describe('buildHistory — assembled from settled messages', () => {
  it('builds user and assistant rows from message events', () => {
    const events = [
      ev('user/message', { id: 'u1', content: [{ type: 'text', text: 'question?' }], source: {} }, 10),
      ev('assistant/message', {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          id: 'a1',
          content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }],
          source: {},
        },
        stream: [],
      }, 20),
    ]
    expect(buildHistory(events)).toEqual([
      { kind: 'user', messageId: 'u1', content: 'question?', createdAt: 10 },
      { kind: 'assistant', messageId: 'assistant:1:1:a1', text: 'answer', thinking: 'think', createdAt: 20 },
    ])
  })

  it('pairs tool/call with its tool/result into one row', () => {
    const events = [
      ev('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'bash', arguments: '{"cmd":"ls"}' }, 30),
      ev('tool/result', {
        turn: 1,
        step: 1,
        message: { role: 'tool', id: 'r1', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: 'file.txt' }], source: {} },
      }, 40),
    ]
    expect(buildHistory(events)).toEqual([{
      kind: 'tool',
      taskId: 'c1',
      name: 'bash',
      args: { cmd: 'ls' },
      result: 'file.txt',
      status: 'success',
      createdAt: 30,
    }])
  })

  it('skips an assistant message with no visible content', () => {
    const events = [ev('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', id: 'a1', content: [], source: {} },
      stream: [],
    })]
    expect(buildHistory(events)).toEqual([])
  })

  it('does not resurrect removed assistant/chunk rows', () => {
    const events = [ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'ghost' } })]
    expect(buildHistory(events)).toEqual([])
  })

  it('falls through unknown event types without throwing', () => {
    expect(buildHistory([ev('some/future-event', { anything: true })])).toEqual([])
  })

  it('drops a dangling tool call that never produced a result', () => {
    const events = [ev('tool/call', { turn: 1, step: 1, callId: ToolCallId('c9'), name: 'bash', arguments: '{}' })]
    expect(buildHistory(events)).toEqual([])
  })

  it('skips a tool result whose call is out of history', () => {
    const events = [ev('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', id: 'r1', toolCallId: ToolCallId('missing'), content: [{ type: 'text', text: 'orphan' }], source: {} },
    })]
    expect(buildHistory(events)).toEqual([])
  })
})
