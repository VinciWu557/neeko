import { describe, expect, it } from 'vitest'
import { turnEndFailure } from '../src/dsh-adapter.ts'
import { feedEvent, restoreRows, type TranscriptState } from '../src/tui/transcript.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Model-response failures on screen.
 *
 * In dsh 0.2.x a failed request has exactly one durable landing point: the
 * `turn/end` event's `reason` (`dsh-agent-loop` writes it in the turn's
 * `finally`, so a retried-then-succeeded turn still ends `completed` and never
 * floods the screen). Before this, `feedLogEvent` had **no branch for
 * `turn/end`** — every model error fell through `default: break` and the user
 * saw a reply simply stop arriving.
 *
 * Wording follows pi (`assistant-message.js`): `Error: <message>`,
 * "Operation aborted", "Response was truncated before completion."
 */

let seq = 0
function turnEnd(reason: unknown, turn = 3, time = 6000): SessionEvent {
  seq += 1
  return { type: 'turn/end', seq, time, data: { turn, reason } } as unknown as SessionEvent
}

function state(attachTime = 5000): TranscriptState {
  return { attachTime, rows: [] }
}

const rowsOf = (s: TranscriptState): Extract<TranscriptState['rows'][number], { kind: 'failure' }>[] =>
  s.rows.filter((row): row is Extract<TranscriptState['rows'][number], { kind: 'failure' }> =>
    row.kind === 'failure')

describe('turnEndFailure — wording', () => {
  it('names an LLM failure with its provider message', () => {
    expect(turnEndFailure({
      kind: 'error',
      error: { message: 'Invalid API key', code: 'AUTH_INVALID' },
    })).toBe('Error: Invalid API key [AUTH_INVALID]')
  })

  it('carries the HTTP status when the provider reported one', () => {
    expect(turnEndFailure({
      kind: 'error',
      error: { message: 'Too many requests', code: 'RATE_LIMIT', status: 429 },
    })).toBe('Error: Too many requests [RATE_LIMIT 429]')
  })

  it('drops the UNKNOWN code, which names nothing', () => {
    // The loop flattens any non-LlmError to `{ message, code: 'UNKNOWN' }`;
    // printing that tag would add noise without information.
    expect(turnEndFailure({
      kind: 'error',
      error: { message: 'boom', code: 'UNKNOWN' },
    })).toBe('Error: boom')
  })

  it('still reports the code when the message is empty', () => {
    // A blank provider message with a code is exactly the case where the code is
    // the only information there is — dropping it would leave `Error: Unknown
    // error`, which tells the user nothing to act on.
    expect(turnEndFailure({ kind: 'error', error: { message: '', code: 'RATE_LIMIT' } }))
      .toBe('Error: Unknown error [RATE_LIMIT]')
  })

  it('says so when the turn was cancelled', () => {
    expect(turnEndFailure({ kind: 'aborted', reason: { kind: 'user' } })).toBe('Operation aborted')
  })

  it('reports the hook that aborted the turn when there is one', () => {
    expect(turnEndFailure({ kind: 'aborted', reason: { kind: 'hook', reason: 'context compacted' } }))
      .toBe('Operation aborted (context compacted)')
  })

  it('uses pi\'s wording for an output-token cutoff', () => {
    expect(turnEndFailure({ kind: 'max-tokens' }))
      .toBe('Response was truncated before completion.')
  })

  it('returns nothing for a turn that ended normally', () => {
    // `completed` is the normal case and must never produce a row, and an
    // unknown future reason must fail open rather than throw.
    expect(turnEndFailure({ kind: 'completed' })).toBeUndefined()
    expect(turnEndFailure({ kind: 'blocked' })).toBeUndefined()
    expect(turnEndFailure({ kind: 'some-future-reason' })).toBeUndefined()
    expect(turnEndFailure(undefined)).toBeUndefined()
  })
})

describe('feedEvent — turn/end reaches the transcript', () => {
  it('appends a failure row after the content it interrupted', () => {
    const s = state()
    feedEvent(s, { kind: 'event', event: turnEnd({ kind: 'error', error: { message: '401 unauthorized', code: 'AUTH' } }) })
    const rows = rowsOf(s)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'failure', turn: 3, text: 'Error: 401 unauthorized [AUTH]' })
  })

  it('adds no row for a completed turn', () => {
    const s = state()
    feedEvent(s, { kind: 'event', event: turnEnd({ kind: 'completed' }) })
    expect(s.rows).toEqual([])
  })

  it('keeps retry-succeeded turns silent', () => {
    // The loop only writes `error` when recovery gave up, so a transient failure
    // that retried into a good reply ends `completed` — the screen must not show
    // an error the user got no error from.
    const s = state()
    feedEvent(s, { kind: 'event', event: turnEnd({ kind: 'error', error: { message: 'temp', code: 'X' } }, 1) })
    feedEvent(s, { kind: 'event', event: turnEnd({ kind: 'completed' }, 2) })
    expect(rowsOf(s)).toHaveLength(1)
  })

  it('does not throw on a malformed reason', () => {
    // `kind: 'error'` with no payload still means the turn FAILED, so a line is
    // printed (pi: `message.errorMessage || "Unknown error"`) rather than the
    // failure going back to being invisible. A missing/odd `kind` stays silent.
    const s = state()
    expect(() => feedEvent(s, { kind: 'event', event: turnEnd({ kind: 'error' }) })).not.toThrow()
    expect(rowsOf(s)[0]?.text).toBe('Error: Unknown error')
    expect(() => feedEvent(s, { kind: 'event', event: turnEnd(null) })).not.toThrow()
    expect(s.rows).toHaveLength(1)
  })
})

describe('restoreRows — a resumed session keeps the failure', () => {
  it('renders a restored failure row', () => {
    // Same defect class as the live path: without this, a resumed session shows
    // the question and then nothing, with no reason on screen.
    const s = state()
    restoreRows(s, [{ kind: 'failure', turn: 1, text: 'Error: Invalid API key [AUTH]' }])
    expect(rowsOf(s)).toHaveLength(1)
    expect(rowsOf(s)[0]).toMatchObject({ kind: 'failure', text: 'Error: Invalid API key [AUTH]' })
  })

  it('falls back to a placeholder for a restored row with no text', () => {
    const s = state()
    restoreRows(s, [{ kind: 'failure', turn: 1 }])
    expect(rowsOf(s)).toHaveLength(0)
  })
})

describe('a failed turn closes the tools it interrupted', () => {
  it('marks a still-running tool card failed instead of leaving [running] forever', () => {
    // Nothing will ever write that tool's result — the turn is gone — so the
    // card would spin for the rest of the session. pi does the same to its
    // `pendingTools` on `stopReason: 'error'`.
    const s = state()
    feedEvent(s, { kind: 'event', event: turnEnd({ kind: 'completed' }, 1) })
    s.rows.push({ kind: 'tool', taskId: 'c1', name: 'bash', args: {}, status: 'running', result: undefined, turn: 1 })
    feedEvent(s, { kind: 'event', event: turnEnd({ kind: 'error', error: { message: 'boom', code: 'X' } }, 2) })
    const tool = s.rows.find((row) => row.kind === 'tool')
    expect(tool).toMatchObject({ status: 'failed', result: 'Error: boom [X]' })
  })

  it('leaves an already-settled tool card alone', () => {
    const s = state()
    s.rows.push({ kind: 'tool', taskId: 'c1', name: 'bash', args: {}, status: 'success', result: 'ok', turn: 1 })
    feedEvent(s, { kind: 'event', event: turnEnd({ kind: 'error', error: { message: 'boom', code: 'X' } }, 2) })
    expect(s.rows.find((row) => row.kind === 'tool')).toMatchObject({ status: 'success', result: 'ok' })
  })
})
