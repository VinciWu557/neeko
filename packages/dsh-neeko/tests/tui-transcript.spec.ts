import { describe, expect, it } from 'vitest'
import { feedEvent, type TranscriptState, type TranscriptRow } from '../src/tui/transcript.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'

/**
 * The transcript's dual-source contract (design §4) — the same invariant the
 * bridge's dsh-adapter pins, restated for the TUI's row model:
 *
 * - Live deltas come ONLY from `agent/assistant-stream` frames.
 * - The durable log contributes tool lifecycle; `assistant/message` rows
 *   arriving AFTER attach are skipped (their text already streamed live).
 * - Rows arriving "before attach" (restored history) render as settled rows.
 */

let seq = 0
function ev<K extends string>(type: K, data: unknown, time = 1000): SessionEvent {
  seq += 1
  return { type, seq, time, data } as unknown as SessionEvent
}

function state(attachTime = 5000): TranscriptState {
  return { attachTime, rows: [] }
}

const delta = (text: string, attempt = 'a1') => ({
  type: 'chunk',
  attemptId: LlmAttemptId(attempt),
  revision: 1,
  index: 0,
  time: 6000,
  chunk: { type: 'text-delta', index: 0, text },
} as const)

describe('transcript — live deltas', () => {
  it('a start frame opens an assistant bubble for its turn/step/attempt', () => {
    const s = state()
    const start = { type: 'start', attemptId: LlmAttemptId('a1'), revision: 1, turn: 1, step: 2 } as const
    feedEvent(s, { kind: 'stream', frame: start })
    const rows = s.rows as Extract<TranscriptRow, { kind: 'assistant' }>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'assistant', turn: 1, step: 2, attemptId: 'a1', text: '' })
  })

  it('text deltas accumulate into the open bubble', () => {
    const s = state()
    feedEvent(s, { kind: 'stream', frame: { type: 'start', attemptId: LlmAttemptId('a1'), revision: 1, turn: 1, step: 2 } as const })
    feedEvent(s, { kind: 'stream', frame: delta('hello ') })
    feedEvent(s, { kind: 'stream', frame: delta('world') })
    const rows = s.rows as Extract<TranscriptRow, { kind: 'assistant' }>[]
    expect(rows[0]?.text).toBe('hello world')
  })

  it('a retried attempt (new attemptId) opens a new bubble, never mixing streams', () => {
    const s = state()
    feedEvent(s, { kind: 'stream', frame: { type: 'start', attemptId: LlmAttemptId('a1'), revision: 1, turn: 1, step: 2 } as const })
    feedEvent(s, { kind: 'stream', frame: delta('failed attempt ', 'a1') })
    feedEvent(s, { kind: 'stream', frame: { type: 'start', attemptId: LlmAttemptId('a2'), revision: 2, turn: 1, step: 2 } as const })
    feedEvent(s, { kind: 'stream', frame: delta('retry text', 'a2') })
    const rows = s.rows as Extract<TranscriptRow, { kind: 'assistant' }>[]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.attemptId).toBe('a1')
    expect(rows[0]?.text).toBe('failed attempt ')
    expect(rows[1]?.attemptId).toBe('a2')
    expect(rows[1]?.text).toBe('retry text')
  })

  it('an end frame closes the attempt; later deltas for it are dropped', () => {
    const s = state()
    feedEvent(s, { kind: 'stream', frame: { type: 'start', attemptId: LlmAttemptId('a1'), revision: 1, turn: 1, step: 2 } as const })
    feedEvent(s, { kind: 'stream', frame: { type: 'end', attemptId: LlmAttemptId('a1'), revision: 1, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 as never } } as const })
    const before = (s.rows as Extract<TranscriptRow, { kind: 'assistant' }>[]).length
    feedEvent(s, { kind: 'stream', frame: delta('late', 'a1') })
    const rows = s.rows as Extract<TranscriptRow, { kind: 'assistant' }>[]
    expect(rows).toHaveLength(before)
  })

  it('reasoning deltas accumulate into thinking, separate from text', () => {
    const s = state()
    feedEvent(s, { kind: 'stream', frame: { type: 'start', attemptId: LlmAttemptId('a1'), revision: 1, turn: 1, step: 1 } as const })
    feedEvent(s, { kind: 'stream', frame: { type: 'chunk', attemptId: LlmAttemptId('a1'), revision: 1, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' } } as const })
    feedEvent(s, { kind: 'stream', frame: delta('answer') })
    const rows = s.rows as Extract<TranscriptRow, { kind: 'assistant' }>[]
    expect(rows[0]).toMatchObject({ thinking: 'hmm', text: 'answer' })
  })
})

describe('transcript — durable log events', () => {
  it('tool/call opens a tool row', () => {
    const s = state()
    feedEvent(s, { kind: 'event', event: ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' }) })
    expect(s.rows).toEqual([
      { kind: 'tool', taskId: 'c1', name: 'bash', args: { cmd: 'ls' }, status: 'running', result: undefined, turn: 0, images: [] },
    ])
  })

  it('tool/result completes the matching tool row (success and failure)', () => {
    const s = state()
    feedEvent(s, { kind: 'event', event: ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }) })
    feedEvent(s, { kind: 'event', event: ev('tool/result', {
      turn: 1, step: 1,
      message: { role: 'tool', id: 'r1', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'boom' }], source: {} },
    }) })
    expect(s.rows[0]).toMatchObject({ kind: 'tool', taskId: 'c1', status: 'failed', result: 'boom' })
  })

  it('an assistant/message AFTER attach is skipped (its text already streamed)', () => {
    // Mutation guard: rendering it again would double every token.
    const s = state()
    feedEvent(s, { kind: 'event', event: ev('assistant/message', {
      turn: 1, step: 1, message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'x' }], source: {} }, stream: [],
    }, 6000) })
    expect(s.rows).toEqual([])
  })

  it('user/message renders as a settled user row', () => {
    const s = state()
    feedEvent(s, { kind: 'event', event: ev('user/message', { id: 'u1', content: [{ type: 'text', text: 'hi' }], source: {} }) })
    expect(s.rows).toEqual([{ kind: 'user', messageId: 'u1', content: 'hi', images: [] }])
  })

  it('unknown future events are ignored (fail-open)', () => {
    const s = state()
    expect(() => feedEvent(s, { kind: 'event', event: ev('some/future', { x: 1 }) })).not.toThrow()
    expect(s.rows).toEqual([])
  })
})
