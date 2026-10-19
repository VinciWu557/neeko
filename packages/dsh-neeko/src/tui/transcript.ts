/**
 * Transcript: merges the two event sources into one ordered row list.
 *
 * Dual-source contract (same invariant the bridge's `dsh-adapter.ts` pins,
 * restated for the TUI's row model — see design §4):
 *
 * 1. **Live deltas** arrive only through {@linkcode StreamFrame} events on
 *    `agent/assistant-stream`. A `start` frame opens an assistant bubble keyed
 *    by `(turn, step, attemptId)`; text/reasoning deltas append to it.
 * 2. **The durable log** (`session/event`) contributes user rows and tool
 *    lifecycle. An `assistant/message` appended *after attach* is skipped:
 *    its text already reached the bubble via live deltas, and rendering it
 *    again would double every token. Restored history is fed as settled rows
 *    by the runner before the first frame (see {@linkcode restoreRows}).
 *
 * The state is a plain mutable object so the UI layer can diff rows by
 * identity; mutation is confined to {@linkcode feedEvent}.
 *
 * @module dsh-neeko/tui/transcript
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * One image attached to a row.
 *
 * The bytes are **not** carried here: an `ImageBlock` holds an opaque
 * `attachmentId`, and only the attachment service can turn that into bytes (with
 * integrity verification). Storing the id keeps the row model serialisable and
 * makes the read explicit — a synchronous render cannot do I/O.
 */
export interface RowImage {
  readonly attachmentId: string
  readonly mediaType: string
  readonly name?: string
}

/** One rendered transcript row. */
export type TranscriptRow =
  | { kind: 'user'; messageId: string; content: string; images?: readonly RowImage[] }
  | {
      kind: 'assistant'
      turn: number
      step: number
      attemptId: string
      text: string
      thinking: string
      /** Set when the attempt's `end` frame arrived. */
      done: boolean
    }
  | {
      kind: 'tool'
      taskId: string
      name: string
      args: unknown
      status: 'running' | 'success' | 'failed'
      result: string | undefined
      /** Turn the call belongs to (drives folding); -1 when restored. */
      turn: number
      /** Images the result carried, if any. */
      images?: readonly RowImage[]
    }

/** Mutable transcript state owned by the UI layer. */
export interface TranscriptState {
  /**
   * Wall-clock (epoch ms) moment the TUI attached to the agent. Log events
   * newer than this are expected to arrive as live deltas too.
   */
  attachTime: number
  rows: TranscriptRow[]
}

/** One input to {@linkcode feedEvent}. */
export type TranscriptInput =
  | { kind: 'stream'; frame: AssistantStreamFrame }
  | { kind: 'event'; event: SessionEvent }

/**
 * Merge one input into the transcript.
 *
 * @param state - the transcript to mutate.
 * @param input - a live stream frame or a durable log event.
 */
export function feedEvent(state: TranscriptState, input: TranscriptInput): void {
  if (input.kind === 'stream') feedStreamFrame(state, input.frame)
  else feedLogEvent(state, input.event)
}

function feedStreamFrame(state: TranscriptState, frame: AssistantStreamFrame): void {
  if (frame.type === 'start') {
    state.rows.push({
      kind: 'assistant',
      turn: frame.turn,
      step: frame.step,
      attemptId: String(frame.attemptId),
      text: '',
      thinking: '',
      done: false,
    })
    return
  }
  if (frame.type === 'end') {
    const open = findOpenBubble(state, String(frame.attemptId))
    if (open !== undefined) open.done = true
    return
  }
  // chunk frame
  const { chunk } = frame
  const open = findOpenBubble(state, String(frame.attemptId))
  if (open === undefined) return // no start seen for this attempt — cannot attribute
  if (chunk.type === 'text-delta') open.text += chunk.text
  else if (chunk.type === 'reasoning-delta') open.thinking += chunk.text
  // tool-call-delta / block markers / usage / finish have no transcript form:
  // the tool lifecycle arrives via the log (`tool/call` / `tool/result`).
}

function feedLogEvent(state: TranscriptState, event: SessionEvent): void {
  switch (event.type) {
    case 'user/message': {
      const text = textFromBlocks(event.data.content)
      const images = imagesFromBlocks(event.data.content)
      // An image-only message is still a message: dropping it would hide the
      // turn entirely.
      if (text !== '' || images.length > 0) {
        state.rows.push({ kind: 'user', messageId: String(event.data.id), content: text, images })
      }
      break
    }
    case 'tool/call': {
      state.rows.push({
        kind: 'tool',
        taskId: String(event.data.callId),
        name: event.data.name,
        args: parseToolArguments(event.data.arguments),
        status: 'running',
        result: undefined,
        images: [],
        // Tool rows fold with their turn, so they need one.
        turn: currentTurn(state),
      })
      break
    }
    case 'tool/result': {
      const row = state.rows.find((candidate): candidate is Extract<TranscriptRow, { kind: 'tool' }> =>
        candidate.kind === 'tool' && candidate.taskId === String(event.data.message.toolCallId))
      if (row === undefined) break // orphan result — the call predates this view
      row.status = event.data.message.isError === true ? 'failed' : 'success'
      row.result = textFromBlocks(event.data.message.content)
      row.images = imagesFromBlocks(event.data.message.content)
      break
    }
    case 'assistant/message': {
      // Its text already streamed live (post-attach); restored history is fed
      // by the runner via restoreRows, never through here. Rendering it again
      // would double every token.
      break
    }
    default:
      break // unknown / presentation-only rows are fail-open
  }
}

/**
 * Seed the transcript with restored history before the first live frame.
 *
 * @param state - the transcript to mutate.
 * @param rows - settled rows (from the runner's `buildHistory` projection).
 */
export function restoreRows(state: TranscriptState, rows: readonly HistoryRow[]): void {
  for (const row of rows) {
    if (row.kind === 'user' && row.messageId !== undefined && row.content !== undefined) {
      state.rows.push({ kind: 'user', messageId: row.messageId, content: row.content, images: [] })
    } else if (row.kind === 'assistant' && row.messageId !== undefined
      && row.text !== undefined && row.thinking !== undefined) {
      state.rows.push({
        kind: 'assistant',
        turn: -1,
        step: -1,
        attemptId: row.messageId,
        text: row.text,
        thinking: row.thinking,
        done: true,
      })
    } else if (row.kind === 'tool' && row.taskId !== undefined && row.name !== undefined
      && (row.status === 'success' || row.status === 'failed')) {
      state.rows.push({
        kind: 'tool',
        taskId: row.taskId,
        name: row.name,
        args: row.args,
        status: row.status,
        result: typeof row.result === 'string' ? row.result : undefined,
        turn: -1,
        images: [],
      })
    }
  }
}

/**
 * A settled row projected from restored history (the runner derives these from
 * the bridge's `buildHistory` output shape).
 */
export interface HistoryRow {
  kind: 'user' | 'assistant' | 'tool'
  messageId?: string
  content?: string
  text?: string
  thinking?: string
  taskId?: string
  name?: string
  args?: unknown
  status?: 'success' | 'failed'
  result?: unknown
}

/** The turn the transcript is currently in (the newest assistant bubble's). */
function currentTurn(state: TranscriptState): number {
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    const row = state.rows[i]
    if (row !== undefined && row.kind === 'assistant') return row.turn
  }
  return 0
}

/** The open assistant bubble for one attempt, if any. */
function findOpenBubble(state: TranscriptState, attemptId: string): Extract<TranscriptRow, { kind: 'assistant' }> | undefined {
  for (let i = state.rows.length - 1; i >= 0; i -= 1) {
    const row = state.rows[i]
    if (row !== undefined && row.kind === 'assistant' && row.attemptId === attemptId && !row.done) return row
  }
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

/**
 * Collect the images of a message's content.
 *
 * Only the attachment id is kept: bytes need an async, verified read through the
 * attachment service, which a render path cannot do.
 *
 * @param content - the message's content blocks.
 * @returns one entry per image block, in order.
 */
function imagesFromBlocks(content: readonly ContentBlock[]): RowImage[] {
  const images: RowImage[] = []
  for (const block of content) {
    if (block.type !== 'image') continue
    const { attachment } = block
    images.push({
      attachmentId: String(attachment.attachmentId),
      mediaType: attachment.mediaType,
      ...(attachment.name === undefined ? {} : { name: attachment.name }),
    })
  }
  return images
}

/** Join the text blocks of a message's content. */
function textFromBlocks(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}
