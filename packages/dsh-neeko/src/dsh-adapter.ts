/**
 * DSH adapter: translates DSH session-log events into dsh-neeko protocol
 * messages, and reconstructs a stable conversation history for `session.init`.
 *
 * # Two distinct sources (0.2.x contract)
 *
 * DSH 0.2.x splits what 0.1.x merged into one `assistant/chunk` event:
 *
 * 1. **Live deltas** — `agent/assistant-stream` on the *agent* context, carrying
 *    `start` / `chunk` / `end` frames. This is the ONLY streaming source.
 *    See {@link translateStreamFrame}.
 * 2. **Durable log** — `snapshotEvents()` yields settled rows. Assistant output
 *    arrives whole as `assistant/message` (plus the compact `stream` records for
 *    replay); there is no per-token row. See {@link translateEvent}.
 *
 * Treating the durable log as a delta source is exactly the bug this module
 * previously carried: it matched on `assistant/chunk`, an event 0.2.x no longer
 * emits, so every assistant token silently vanished.
 *
 * @module dsh-neeko/dsh-adapter
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { DshToNeeko, HistoryItem } from './protocol.ts'

/**
 * Stable assistant message id for one (turn, step, attempt).
 *
 * The attempt id is part of the identity on purpose: `dsh-agent-loop` retries a
 * step by re-running the same `turn`/`step` with a fresh `attemptId`. Keying on
 * turn/step alone would let a failed attempt's deltas and the successful
 * retry's deltas share one id, so a client would splice the failed text into
 * the final message. `start` frames carry `attemptId`, so this costs nothing.
 */
function assistantMessageId(turn: number, step: number, attemptId: string): string {
  return `assistant:${turn}:${step}:${attemptId}`
}

/** The subset of a DSH session this adapter needs in order to read its log. */
export interface SessionLogSource {
  /**
   * Materialize a snapshot of the event log (dsh-session 0.2.x).
   * The legacy synchronous `events` property no longer exists — reading it
   * threw `TypeError: events is not iterable` and killed the first handshake.
   *
   * ⚠️ `snapshotEvents()` is marked `@deprecated` in 0.2.0-rc.2 ("new calls are
   * prohibited"), but DSH's own core plugins still use it and there is no
   * announced replacement. This is therefore a pragmatic, reversible choice,
   * not a claim that the API is permanent — revisit when DSH publishes the
   * successor.
   */
  snapshotEvents?: () => readonly SessionEvent[]
}

/**
 * Read a session's full event log through the supported API.
 *
 * Fails open to an empty log: a missing or throwing reader must not take down
 * the whole bridge (history is a best-effort reconstruction, the live stream
 * still works without it).
 *
 * @param session - the DSH session to read.
 * @returns the event log, or an empty array when unavailable.
 */
export function readSessionEvents(session: unknown): readonly SessionEvent[] {
  try {
    const reader = (session as SessionLogSource | undefined)?.snapshotEvents
    if (typeof reader !== 'function') return []
    return reader.call(session) ?? []
  } catch {
    return []
  }
}

/** A `start` frame, remembered so chunk frames can be attributed to a turn/step. */
export type StreamStart = Extract<AssistantStreamFrame, { type: 'start' }>

/**
 * Translate one live stream frame into protocol messages.
 *
 * Only text and reasoning deltas reach Neeko: tool-call deltas are superseded by
 * the `tool/call` log row (which carries the complete argument JSON), and
 * `usage` / `finish` / block markers have no protocol representation.
 *
 * @param start - the `start` frame that opened the current attempt, if seen.
 * @param frame - the frame just published.
 * @returns the protocol messages to send, in order.
 */
export function translateStreamFrame(start: StreamStart | undefined, frame: AssistantStreamFrame): DshToNeeko[] {
  if (frame.type !== 'chunk' || start === undefined) return []
  const chunk = frame.chunk
  if (chunk.type === 'text-delta') {
    return [{
      type: 'text.delta',
      payload: {
        chunk: chunk.text,
        messageId: assistantMessageId(start.turn, start.step, String(start.attemptId)),
      },
    }]
  }
  if (chunk.type === 'reasoning-delta') {
    return [{ type: 'thinking.delta', payload: { chunk: chunk.text } }]
  }
  return []
}

/**
 * Translate one durable session event into the protocol messages Neeko should
 * see. Unknown or presentation-only rows produce nothing.
 *
 * Assistant text is deliberately NOT emitted here — it already reached the
 * client through {@link translateStreamFrame}. Replaying it would double every
 * token. The log contributes tool lifecycle only.
 *
 * @param event - the appended session event.
 * @returns the protocol messages to send, in order.
 */
export function translateEvent(event: SessionEvent): DshToNeeko[] {
  switch (event.type) {
    case 'tool/call': {
      const data = event.data
      return [{
        type: 'tool.start',
        payload: {
          taskId: String(data.callId),
          toolName: data.name,
          args: parseToolArguments(data.arguments),
        },
      }]
    }
    case 'tool/result': {
      const data = event.data
      const diff = extractDiff(data.meta)
      return [{
        type: 'tool.end',
        payload: {
          taskId: String(data.message.toolCallId),
          status: data.message.isError === true ? 'failed' : 'success',
          result: textFromBlocks(data.message.content),
          ...(diff === undefined ? {} : { diff }),
        },
      }]
    }
    default:
      return []
  }
}

/**
 * Reconstruct the ordered conversation history for one session's log, for the
 * `session.init` push.
 *
 * 0.2.x logs are message-oriented, so this is a straight fold over settled rows:
 * `user/message` and `assistant/message` project verbatim, and each `tool/call`
 * pairs with the later `tool/result` that cites its id.
 *
 * @param events - the session's event log, in seq order.
 * @returns protocol history rows, in chronological order.
 */
export function buildHistory(events: readonly SessionEvent[]): HistoryItem[] {
  const items: HistoryItem[] = []
  const toolStarts = new Map<string, { name: string; args: unknown; createdAt: number }>()

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const data = event.data
        const text = textFromBlocks(data.content)
        if (text !== '') {
          items.push({
            kind: 'user',
            messageId: String(data.id),
            content: text,
            createdAt: event.time,
          })
        }
        break
      }
      case 'assistant/message': {
        const data = event.data
        const text = textFromBlocks(data.message.content)
        const thinking = thinkingFromBlocks(data.message.content)
        if (text !== '' || thinking !== '') {
          items.push({
            kind: 'assistant',
            // History rows have no live attempt to correlate with, so the id is
            // scoped to the settled message itself.
            messageId: `assistant:${data.turn}:${data.step}:${String(data.message.id)}`,
            text,
            thinking,
            createdAt: event.time,
          })
        }
        break
      }
      case 'tool/call': {
        const data = event.data
        toolStarts.set(String(data.callId), {
          name: data.name,
          args: parseToolArguments(data.arguments),
          createdAt: event.time,
        })
        break
      }
      case 'tool/result': {
        const data = event.data
        const taskId = String(data.message.toolCallId)
        const start = toolStarts.get(taskId)
        // A result whose call predates this log window has nothing to pair with.
        if (start === undefined) break
        toolStarts.delete(taskId)
        items.push({
          kind: 'tool',
          taskId,
          name: start.name,
          args: start.args,
          result: textFromBlocks(data.message.content),
          status: data.message.isError === true ? 'failed' : 'success',
          createdAt: start.createdAt,
        })
        break
      }
      case 'turn/end': {
        // A failed turn leaves no `assistant/message`, so without this a
        // resumed session shows the question and then nothing — the same
        // silence the live path had before `turn/end` was handled.
        const text = turnEndFailure(event.data.reason)
        if (text !== undefined) {
          items.push({ kind: 'failure', turn: event.data.turn, text, createdAt: event.time })
        }
        break
      }
      default:
        break
    }
  }
  return items
}

/**
 * Word one `turn/end` reason for the screen, in pi's wording.
 *
 * Exported and pure so the wording is assertable without a terminal — and so a
 * reason this build does not know returns `undefined` (no row) instead of
 * throwing: `TurnEndReason` is merge-extensible, so a plugin can add a variant
 * nobody here has seen.
 *
 * @param reason - the turn's end reason, as recorded in the durable log.
 * @returns the line to show, or `undefined` when nothing failed.
 */
export function turnEndFailure(reason: unknown): string | undefined {
  if (typeof reason !== 'object' || reason === null) return undefined
  const kind = (reason as { kind?: unknown }).kind
  if (kind === 'error') {
    const failure = (reason as { error?: unknown }).error
    if (typeof failure !== 'object' || failure === null) return 'Error: Unknown error'
    const { message, code, status } = failure as { message?: unknown; code?: unknown; status?: unknown }
    const text = typeof message === 'string' && message !== '' ? message : 'Unknown error'
    // The code is what makes two 401s distinguishable; `UNKNOWN` is the loop's
    // own flattening of a non-Llm error and names nothing.
    const tag = typeof code === 'string' && code !== '' && code !== 'UNKNOWN'
      ? typeof status === 'number' ? ` [${code} ${status}]` : ` [${code}]`
      : ''
    return `Error: ${text}${tag}`
  }
  if (kind === 'aborted') {
    const cause = (reason as { reason?: unknown }).reason
    const note = typeof cause === 'object' && cause !== null
      && (cause as { kind?: unknown }).kind === 'hook'
      && typeof (cause as { reason?: unknown }).reason === 'string'
      ? (cause as { reason: string }).reason
      : undefined
    return note === undefined ? 'Operation aborted' : `Operation aborted (${note})`
  }
  if (kind === 'max-tokens') return 'Response was truncated before completion.'
  return undefined
}

/** Parse a tool call's raw argument JSON; falls back to the raw string. */
function parseToolArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

/** Join the text blocks of a message's content. */
function textFromBlocks(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** Join the reasoning blocks of a message's content. */
function thinkingFromBlocks(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
}

/**
 * Narrow the tool-private `meta` to the protocol's diff shape. The fs tools
 * attach `{ diffs: FileDiff[] }` here; unknown shapes are ignored defensively.
 */
function extractDiff(meta: unknown): { filePath: string; patch: string } | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const diffs = (meta as { diffs?: unknown }).diffs
  if (!Array.isArray(diffs)) return undefined
  const first = diffs[0]
  if (typeof first !== 'object' || first === null) return undefined
  const candidate = first as { path?: unknown; newText?: unknown; oldText?: unknown }
  if (typeof candidate.path !== 'string') return undefined
  return {
    filePath: candidate.path,
    patch: typeof candidate.newText === 'string' ? candidate.newText : typeof candidate.oldText === 'string' ? candidate.oldText : '',
  }
}
