/**
 * Tool-call presentation, following pi's own renderer.
 *
 * ## What this module is
 *
 * pi has **no tool-specific styling**. `formatToolCallWithArgs` renders every
 * tool the same way:
 *
 * - collapsed: `bold(name)` then `key=value` pairs on the same line, cut at
 *   {@linkcode COLLAPSED_ARGS_CHARS};
 * - expanded: the name, then one `key: value` line per argument.
 *
 * Result bodies are cut at {@linkcode FOLDED_PREVIEW_LINES} with
 * `... (N more lines, ctrl+o to expand)`.
 *
 * ## What this module used to be
 *
 * A variant table — `read` / `search` / `bash` / `write` / `edit` / `code` /
 * `others`, each with an emoji, a title and a summary heuristic — inherited from
 * `@xmoon76/dsh-pi-tui`. That was the adapter's invention, not pi's, and it made
 * a single row carry three competing labels:
 *
 * ```
 * 🖥️ Bash List src/tui directory contents [ok] — app.ts banner.ts com… (+28 lines, ctrl+o)
 * ```
 *
 * The name, the derived summary and the status pill all described the same call.
 * pi's version says it once:
 *
 * ```
 * bash command="ls src/tui"
 * ```
 *
 * The status is carried by the card's background (`toolPendingBg` /
 * `toolSuccessBg` / `toolErrorBg`), which is what a colour is for.
 *
 * ## Why the length helpers stay
 *
 * A transcript row has to remain **one line** while folded, and a tool result is
 * unbounded — that is a rendering constraint, not a classification one, so
 * {@linkcode foldText} and friends remain. They are used by assistant and user
 * rows too and know nothing about tools.
 *
 * @module dsh-neeko/tui/tool-present
 */

import type { ThemeToken } from './theme.ts'

/**
 * Characters of collapsed arguments shown on the header line.
 *
 * Same bound as pi: enough for two or three `key=value` pairs, small enough that
 * the row never wraps.
 */
export const COLLAPSED_ARGS_CHARS = 100

/**
 * Characters a folded non-tool row shows before truncating.
 *
 * Deliberately short: a folded transcript is meant to be *scanned*, and 20
 * characters is enough to tell two messages apart.
 */
export const FOLDED_CHARS = 20

/**
 * Result lines shown on a folded tool card.
 *
 * pi's `FALLBACK_PREVIEW_LINES`. Module-private: it is a detail of
 * {@linkcode toolOutputLines}, and callers ask that function rather than slicing
 * the body themselves.
 */
const FOLDED_PREVIEW_LINES = 10

/**
 * Paints one theme token.
 *
 * Typed with the real token union so a caller's typed painter fits without an
 * adapter, and a typo in a token name fails the build.
 */
export type Paint = (token: ThemeToken, text: string) => string

/**
 * Applies emphasis to a tool name.
 *
 * Injectable rather than hard-coded ANSI: `Theme.bold()` exists and styles with a
 * terminal attribute, while a caller without a theme — a test, a dump — gets plain
 * text instead of raw escape codes leaking into an assertion.
 */
export type Bold = (text: string) => string

/**
 * Emphasis for a caller that has no theme.
 *
 * Exported so the fallback lives in one place: `transcript-view` needs the same
 * identity function when a caller supplies colour painting but no emphasis, and a
 * second inline copy there would be the same concept with two definitions.
 */
export const NO_BOLD: Bold = (text) => text

/**
 * The argument pairs of a tool call, the way pi treats them.
 *
 * A non-object argument (a bare string, a number) is a single `args` pair, so a
 * tool called with a primitive still shows what it was called with.
 *
 * @param args - the parsed tool arguments.
 * @returns ordered `[key, value]` pairs; empty when there is nothing to show.
 */
function argumentPairs(args: unknown): readonly (readonly [string, unknown])[] {
  if (args === undefined || args === null) return []
  if (typeof args === 'object' && !Array.isArray(args)) {
    return Object.entries(args as Record<string, unknown>)
  }
  return [['args', args]]
}

/**
 * One `key=value` pair, JSON-encoded the way pi does it.
 *
 * `JSON.stringify` is what makes a string argument keep its quotes and an object
 * argument stay readable; a bare `String(value)` would print `[object Object]`.
 *
 * @param value - the argument value.
 * @returns the rendered value.
 */
function renderValue(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

/**
 * The collapsed argument preview: `key=value` pairs, cut to
 * {@linkcode COLLAPSED_ARGS_CHARS}.
 *
 * Module-private: it is one branch of {@linkcode formatToolHeader}, and a caller
 * that rendered a preview without the name would be showing half a header.
 *
 * @param args - the parsed tool arguments.
 * @returns the preview, or `''` when there are no arguments.
 */
function argsPreview(args: unknown): string {
  const pairs = argumentPairs(args).map(([key, value]) => `${key}=${renderValue(value)}`).join(' ')
  if (pairs.length <= COLLAPSED_ARGS_CHARS) return pairs
  return `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...`
}

/**
 * The tool call header: a bold name, then either the argument preview (collapsed)
 * or one `key: value` line per argument (expanded).
 *
 * @param name - the tool name as the model called it.
 * @param args - the parsed tool arguments.
 * @param paint - token painter.
 * @param expanded - show the arguments as their own lines.
 * @param bold - emphasis for the tool name; defaults to none.
 * @returns one line when collapsed, several when expanded.
 */
export function formatToolHeader(
  name: string,
  args: unknown,
  paint: Paint,
  expanded = false,
  bold: Bold = NO_BOLD,
): string {
  const header = paint('toolTitle', bold(name))
  const pairs = argumentPairs(args)
  if (pairs.length === 0) return header
  if (!expanded) {
    const preview = argsPreview(args)
    return preview === '' ? header : `${header} ${paint('muted', preview)}`
  }
  const lines = pairs.map(([key, value]) => {
    const text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value))
    // Continuation lines are indented so a multi-line argument stays visibly
    // one argument (pi does the same).
    return `  ${key}: ${text.replace(/\r/gu, '').split('\n').join('\n    ')}`
  })
  return `${header}\n${paint('muted', lines.join('\n'))}`
}

/**
 * The result body as card lines.
 *
 * Folded, the body is previewed and a marker names the key that opens the rest —
 * without the marker a truncated body reads as the whole result.
 *
 * @param result - the tool result text.
 * @param expanded - show every line.
 * @param paint - token painter.
 * @returns one line per rendered result row.
 */
export function toolOutputLines(result: string, expanded: boolean, paint: Paint): string[] {
  if (result === '') return []
  const lines = result.split('\n')
  if (expanded) return lines.map((line) => paint('toolOutput', `  ${line}`))
  const shown = lines.slice(0, FOLDED_PREVIEW_LINES)
  const remaining = lines.length - shown.length
  const painted = shown.map((line) => paint('toolOutput', `  ${line}`))
  if (remaining === 0) return painted
  painted.push(paint('muted', `  ... (${remaining} more lines, ctrl+o to expand)`))
  return painted
}

/**
 * Collapse text to one bounded line, marking truncation.
 *
 * Newlines collapse to spaces: a folded row must occupy exactly one line, or the
 * fold stops saving the screen space it exists to save.
 *
 * @param text - the full text.
 * @param limit - maximum characters; defaults to {@linkcode FOLDED_CHARS}.
 * @returns one line, ending in `…` when it was cut.
 */
export function foldText(text: string, limit = FOLDED_CHARS): string {
  const oneLine = text.replace(/\s+/gu, ' ').trim()
  if (oneLine.length <= limit) return oneLine
  return `${oneLine.slice(0, limit)}…`
}

/**
 * The first non-empty line of a block.
 *
 * @param text - the block.
 * @returns that line, or `''`.
 */
export function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? ''
}

/**
 * The last non-empty line of a block.
 *
 * @param text - the block.
 * @returns that line, or `''`.
 */
export function latestLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]
    if (line !== undefined && line.trim() !== '') return line.trim()
  }
  return ''
}
