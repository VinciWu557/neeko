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

/** One rendered transcript row. */
export type TranscriptRow =
  | { kind: 'user'; messageId: string; content: string }
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
      if (text !== '') {
        state.rows.push({ kind: 'user', messageId: String(event.data.id), content: text })
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
      })
      break
    }
    case 'tool/result': {
      const row = state.rows.find((candidate): candidate is Extract<TranscriptRow, { kind: 'tool' }> =>
        candidate.kind === 'tool' && candidate.taskId === String(event.data.message.toolCallId))
      if (row === undefined) break // orphan result — the call predates this view
      row.status = event.data.message.isError === true ? 'failed' : 'success'
      row.result = textFromBlocks(event.data.message.content)
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
      state.rows.push({ kind: 'user', messageId: row.messageId, content: row.content })
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

/** Join the text blocks of a message's content. */
function textFromBlocks(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

// ── rendering ───────────────────────────────────────────────────────────────
// Row → pi-tui component. Kept in transcript.ts (not app.ts) so the mapping
// stays a pure, testable function of the row model.

import { Text } from '@earendil-works/pi-tui'
import { Markdown } from '@earendil-works/pi-tui'

const markdownTheme = {
  heading: (text: string) => text,
  link: (text: string) => text,
  linkUrl: (text: string) => text,
  code: (text: string) => text,
  codeBlock: (text: string) => text,
  codeBlockBorder: (text: string) => text,
  quote: (text: string) => text,
  quoteBorder: (text: string) => text,
  hr: (text: string) => text,
  listBullet: (text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
  underline: (text: string) => text,
}

/**
 * Render one transcript row as a pi-tui component.
 *
 * Plain (colorless) styling for the MVP; a palette is R3 scope.
 *
 * @param row - the transcript row.
 * @returns the component to mount in the messages container.
 */
export function renderRow(row: TranscriptRow): Text | Markdown {
  switch (row.kind) {
    case 'user':
      return new Text(`❯ ${row.content}`)
    case 'assistant': {
      const parts: string[] = []
      if (row.thinking !== '') parts.push(row.thinking)
      if (row.text !== '') parts.push(row.text)
      if (parts.length === 0) parts.push(row.done ? '(no content)' : '…')
      return new Markdown(parts.join('\n\n'), 1, 0, markdownTheme)
    }
    case 'tool': {
      const statusMark = row.status === 'running' ? '⟳' : row.status === 'failed' ? '✗' : '✓'
      const detail = row.result === undefined ? '' : `\n  ${row.result}`
      return new Text(`${statusMark} ${row.name} ${JSON.stringify(row.args)}${detail}`)
    }
  }
}
