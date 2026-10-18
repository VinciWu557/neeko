/**
 * Session timing — how long the agent has been generating, running tools, and
 * how much of the session was actually *active*.
 *
 * Modeled on `pi-timing` (`extensions/timing/index.ts`), keeping the parts that
 * make its numbers trustworthy:
 *
 * - **Generation time** is measured from the first stream frame of an attempt to
 *   its `end` frame — the model's own wall clock, not the turn boundary.
 * - **Tool time is chunked, not summed.** Concurrent tools run in parallel, so
 *   each *contiguous run* of active tools is one wall-clock interval. Summing
 *   per-tool durations would inflate the total by the parallelism factor.
 * - **Active time = Σ generation + Σ tool runs.** Idle gaps (user thinking,
 *   reading output) are excluded — that is the difference between `active` and
 *   the session `span`.
 * - **Thinking time** is the prefix of generation before the first visible text
 *   (or the explicit reasoning-delta timestamp), reported as an estimate.
 *
 * What this does **not** do (pi-timing has them; they need pi-only APIs):
 * per-reply inline annotation entries, `/timing lines`, and multi-language
 * strings. The widget figures are the useful part; the rest is presentation.
 *
 * @module dsh-neeko/tui/timing
 */

/** Live timing state for one session. */
export interface TimingState {
  /**
   * Wall-clock of the first user message (span origin), or `undefined` before
   * any. Not `0`: `0` is a legal timestamp (epoch), and using it as a sentinel
   * made "turn started at t=0" behave like "no turn yet".
   */
  spanFirst: number | undefined
  /** Wall-clock of the latest activity, or `undefined` before any. */
  spanLast: number | undefined
  /** Cumulative generation time across every attempt. */
  genMs: number
  /** Cumulative tool-run time (parallel runs counted once). */
  toolMs: number
  /** Number of user turns seen. */
  turns: number
  /** Currently generating: attempt start, or `undefined`. */
  genStart: number | undefined
  /** Wall-clock of the first visible text of the current attempt. */
  firstTextAt: number | undefined
  /** Wall-clock of the newest reasoning delta of the current attempt. */
  thinkingAt: number | undefined
  /** Number of tools currently running. */
  activeTools: number
  /** Start of the current contiguous tool run, or `undefined`. */
  toolRunStart: number | undefined
  /** Generation time of the most recently finished attempt. */
  lastGenMs: number
  /** Thinking estimate for the most recently finished attempt. */
  lastThinkingMs: number | undefined
  /** Wall-clock → the reply's first user message, for the last completed turn. */
  lastReplyMs: number | undefined
}

/** A fresh timing state. */
export function emptyTiming(): TimingState {
  return {
    spanFirst: undefined,
    spanLast: undefined,
    genMs: 0,
    toolMs: 0,
    turns: 0,
    genStart: undefined,
    firstTextAt: undefined,
    thinkingAt: undefined,
    activeTools: 0,
    toolRunStart: undefined,
    lastGenMs: 0,
    lastThinkingMs: undefined,
    lastReplyMs: undefined,
  }
}

/** A user message starts a turn; the span origin is the first one. */
export function onUserMessage(state: TimingState, now: number): void {
  if (state.spanFirst === undefined) state.spanFirst = now
  state.spanLast = now
  state.turns += 1
  state.lastReplyMs = undefined
}

/** An attempt's `start` frame. */
export function onGenerationStart(state: TimingState, now: number): void {
  state.genStart = now
  state.firstTextAt = undefined
  state.thinkingAt = undefined
}

/** A stream chunk; classifies it as reasoning or first visible text. */
export function onChunk(state: TimingState, now: number, kind: 'text' | 'reasoning'): void {
  if (state.genStart === undefined) return
  if (kind === 'reasoning') state.thinkingAt = now
  else if (state.firstTextAt === undefined) state.firstTextAt = now
}

/** An attempt's `end` frame; folds the attempt into the totals. */
export function onGenerationEnd(state: TimingState, now: number): void {
  if (state.genStart === undefined) return
  const elapsed = Math.max(0, now - state.genStart)
  state.genMs += elapsed
  state.lastGenMs = elapsed
  // Thinking is the prefix before the first visible text; `thinkingAt` (an
  // explicit reasoning delta) wins over the text anchor when present.
  // Only an actual reasoning delta counts as thinking; the text anchor is a
  // fallback for *where* thinking ended, never evidence that it happened.
  const anchor = state.thinkingAt ?? state.firstTextAt
  state.lastThinkingMs = state.thinkingAt === undefined || anchor === undefined
    ? undefined
    : Math.max(0, anchor - state.genStart)
  state.spanLast = Math.max(state.spanLast ?? now, now)
  // Turn elapsed (`lastReplyMs`) is folded by `onTurnComplete`, which knows the
  // user message's timestamp; an attempt end is not a turn end.
  state.genStart = undefined
  state.firstTextAt = undefined
  state.thinkingAt = undefined
}

/**
 * Fold the finished turn: the reply took from the user message to now.
 * @param state - timing state.
 * @param turnStart - the user message's timestamp for this turn.
 * @param now - completion timestamp.
 */
export function onTurnComplete(state: TimingState, turnStart: number, now: number): void {
  state.lastReplyMs = Math.max(0, now - turnStart)
  state.spanLast = Math.max(state.spanLast ?? now, now)
}

/** A tool started; opens a run if this is the first active tool. */
export function onToolStart(state: TimingState, now: number): void {
  if (state.activeTools === 0) state.toolRunStart = now
  state.activeTools += 1
  state.spanLast = Math.max(state.spanLast ?? now, now)
}

/** A tool finished; closes the run when the last active tool ends. */
export function onToolEnd(state: TimingState, now: number): void {
  state.activeTools = Math.max(0, state.activeTools - 1)
  if (state.activeTools > 0) return
  if (state.toolRunStart === undefined) return
  const elapsed = Math.max(0, now - state.toolRunStart)
  state.toolMs += elapsed
  state.toolRunStart = undefined
  state.spanLast = Math.max(state.spanLast ?? now, now)
}

/** Session span: first user message → latest activity (or `now` while live). */
export function spanMs(state: TimingState, now: number): number {
  if (state.spanFirst === undefined) return 0
  const last = state.spanLast ?? now
  return Math.max(0, last - state.spanFirst)
}

/** Active time: generation plus tool runs, excluding idle gaps. */
export function activeMs(state: TimingState, now: number): number {
  const runningGen = state.genStart === undefined ? 0 : Math.max(0, now - state.genStart)
  const runningTool = state.toolRunStart === undefined ? 0 : Math.max(0, now - state.toolRunStart)
  return state.genMs + state.toolMs + runningGen + runningTool
}

/**
 * Format a duration the way pi-timing does: `1.2s`, `12s`, `3m04s`, `1h02m`.
 * @param ms - duration in milliseconds.
 * @returns the compact text.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSeconds = ms / 1000
  if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  if (totalMinutes < 60) return `${totalMinutes}m${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}h${String(minutes).padStart(2, '0')}m`
}

/**
 * The timing segment for the status bar: `⏱ 3m04s · active 1m12s (2轮)`.
 *
 * While busy it appends the live sub-state so the number moves without a
 * separate widget (pi-timing drives its own ticker; here the bar refreshes on
 * every stream frame, which is frequent enough in practice).
 *
 * @param state - timing state.
 * @param now - current wall clock.
 * @param options - wording + live detail toggles.
 * @returns the segment text, or `''` before the first turn.
 */
export function timingLine(
  state: TimingState,
  now: number,
  options: { readonly live?: boolean } = {},
): string {
  if (state.spanFirst === undefined) return ''
  const parts = [`⏱ ${formatDuration(spanMs(state, now))}`]
  parts.push(`active ${formatDuration(activeMs(state, now))}`)
  parts.push(`${state.turns}${state.turns === 1 ? ' turn' : ' turns'}`)
  if (options.live !== false) {
    if (state.genStart !== undefined) {
      const elapsed = Math.max(0, now - state.genStart)
      const thinking = state.thinkingAt ?? state.firstTextAt
      const thinkingSuffix = thinking === undefined
        ? ''
        : ` (think≈${formatDuration(Math.max(0, thinking - state.genStart))})`
      parts.push(`generating ${formatDuration(elapsed)}${thinkingSuffix}`)
    } else if (state.activeTools > 0 && state.toolRunStart !== undefined) {
      parts.push(`tool running ${formatDuration(Math.max(0, now - state.toolRunStart))}`)
    }
  }
  return parts.join(' · ')
}
