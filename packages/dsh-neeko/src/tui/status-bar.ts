/**
 * Status bar — the line under the editor.
 *
 * Laid out like pi's footer (`components/footer.js`): **left** is the working
 * context (cwd + git branch), **middle** is the session's token/cost ledger,
 * **right** is the active route (provider) and model plus its reasoning level.
 *
 * ```
 * ~/work/dsh-neeko (main)
 * ↑2.4M ↓353k R379M CH99.9% $4.259 76.6%/1.0M        (magpie) group/auto-… • high
 * ```
 *
 * Two deliberate differences from pi:
 * - **Two lines, not one.** pi packs everything onto one line and truncates the
 *   left side when it overflows; a chat-first TUI on an 80-column terminal
 *   would lose the token ledger that way, so the context line is separate.
 * - **No `(auto)` / `xp` badges.** Those reflect pi features (auto-compaction,
 *   experimental toggles) that have no counterpart here.
 *
 * The formatting is a pure function so it is testable without a terminal.
 *
 * @module dsh-neeko/tui/status-bar
 */

import { homedir } from 'node:os'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

/** Aggregated token counters for the session. */
export interface TokenLedger {
  /** Uncached prompt tokens (`↑`). */
  readonly input: number
  /** Completion tokens (`↓`). */
  readonly output: number
  /** Cache-read tokens (`R`). */
  readonly cacheRead: number
  /** Cache-write tokens (`W`). */
  readonly cacheWrite: number
  /** Route-priced spend in USD, when the provider reports pricing. */
  readonly cost?: number
}

/** Everything the bar needs to render. */
export interface StatusFacts {
  /** Working directory of the session. */
  readonly cwd: string
  /** Current git branch, when the cwd is a repo. */
  readonly branch?: string
  /** Aggregated usage; omitted before the first response. */
  readonly ledger?: TokenLedger
  /** Latest cache-hit rate in percent (0-100), when computable. */
  readonly cacheHitRate?: number
  /** Tokens the current request occupies. */
  readonly contextTokens?: number
  /** The routed model's context window. */
  readonly contextWindow?: number
  /** Route name, shown in parentheses before the model. */
  readonly provider: string
  /** Model id. */
  readonly model: string
  /** Reasoning effort in effect, when the route supports it. */
  readonly reasoningEffort?: string
}

/**
 * Shorten a token count: 1234 → 1.2k, 2_400_000 → 2.4M, 1_000_000 → 1.0M.
 *
 * One decimal below ten units keeps `1.0M` distinguishable from `1M`-style
 * rounding, matching pi's footer exactly.
 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return '0'
  const units: readonly [number, string][] = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'k'],
  ]
  for (const [limit, suffix] of units) {
    if (count >= limit) {
      const value = count / limit
      // One decimal below 10 units (2.4M, 1.0M), none above (379M) — pi's rule.
      return `${value < 10 ? value.toFixed(1) : Math.round(value)}${suffix}`
    }
  }
  return String(Math.round(count))
}

/**
 * Replace the home directory with `~`, as parents do.
 * @param cwd - absolute working directory.
 * @param home - home directory (injected for tests).
 * @returns the display form.
 */
export function formatCwd(cwd: string, home: string = homedir()): string {
  if (home !== '' && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`
  }
  return cwd
}

/**
 * The left line: working directory plus the git branch.
 * @param facts - status facts.
 * @param home - home directory (tests).
 * @returns the context line.
 */
export function contextLine(facts: StatusFacts, home: string = homedir()): string {
  const path = formatCwd(facts.cwd, home)
  return facts.branch === undefined ? path : `${path} (${facts.branch})`
}

/**
 * The usage counters: `↑in ↓out Rread Wwrite CHhit% $cost`.
 *
 * Zero counters are omitted (pi's behaviour) so a fresh session shows only the
 * context figure instead of a row of zeros.
 *
 * @param facts - status facts.
 * @returns the counter text, or `''` before the first response.
 */
export function ledgerStats(facts: StatusFacts): string {
  const parts: string[] = []
  const ledger = facts.ledger
  if (ledger === undefined) return ''
  if (ledger.input > 0) parts.push(`↑${formatTokens(ledger.input)}`)
  if (ledger.output > 0) parts.push(`↓${formatTokens(ledger.output)}`)
  if (ledger.cacheRead > 0) parts.push(`R${formatTokens(ledger.cacheRead)}`)
  if (ledger.cacheWrite > 0) parts.push(`W${formatTokens(ledger.cacheWrite)}`)
  const hasCache = ledger.cacheRead > 0 || ledger.cacheWrite > 0
  if (hasCache && facts.cacheHitRate !== undefined) {
    parts.push(`CH${facts.cacheHitRate.toFixed(1)}%`)
  }
  if (ledger.cost !== undefined && ledger.cost > 0) {
    parts.push(`$${ledger.cost.toFixed(3)}`)
  }
  return parts.join(' ')
}

/**
 * The context-occupancy figure: `78.5%/1.0M`.
 *
 * Kept separate from {@linkcode ledgerStats} because it is the one segment that
 * gets a severity color — pi paints only this figure, not the whole ledger.
 *
 * @param facts - status facts.
 * @returns the figure, or `''` when the window is unknown.
 */
export function contextPart(facts: StatusFacts): string {
  if (facts.contextWindow === undefined || facts.contextWindow <= 0) return ''
  const percent = facts.contextTokens === undefined
    ? '?'
    : `${((facts.contextTokens / facts.contextWindow) * 100).toFixed(1)}`
  return `${percent}%/${formatTokens(facts.contextWindow)}`
}

/**
 * The whole ledger line as plain text (stats + context).
 * @param facts - status facts.
 * @returns the joined text; `''` when nothing is known.
 */
export function ledgerLine(facts: StatusFacts): string {
  return [ledgerStats(facts), contextPart(facts)].filter((part) => part !== '').join(' ')
}

/**
 * The right segment: `(provider) model • effort`.
 * @param facts - status facts.
 * @returns the route text.
 */
export function routeLine(facts: StatusFacts): string {
  const route = `(${facts.provider}) ${facts.model}`
  return facts.reasoningEffort === undefined ? route : `${route} • ${facts.reasoningEffort}`
}

/**
 * Whether the context figure should be colored as a warning.
 *
 * pi turns the percentage yellow above 70% and red above 90% — the same
 * thresholds are kept so the signal reads identically.
 *
 * @param facts - status facts.
 * @returns the severity, or `undefined` when it should stay in the text color.
 */
export function contextSeverity(facts: StatusFacts): 'warning' | 'error' | undefined {
  if (facts.contextTokens === undefined || facts.contextWindow === undefined || facts.contextWindow <= 0) {
    return undefined
  }
  const percent = (facts.contextTokens / facts.contextWindow) * 100
  if (percent > 90) return 'error'
  if (percent > 70) return 'warning'
  return undefined
}

/** Accumulate `assistant/message` usage rows into one ledger. */
export interface UsageCarrier {
  readonly usage?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cacheReadTokens?: number
    readonly cacheWriteTokens?: number
  }
}

/**
 * Fold every assistant message's `usage` into session totals.
 *
 * Mirrors pi's footer: totals cover the whole session (including retried
 * attempts), while the cache-hit rate uses the **latest** message only — an
 * average over the session would hide a cache that just stopped working.
 *
 * @param events - the session log.
 * @returns the ledger and the latest cache-hit rate.
 */
export function foldUsage(events: readonly { type: string; data: unknown }[]): {
  ledger: TokenLedger
  cacheHitRate: number | undefined
} {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let latest: number | undefined
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    // `assistant/message` carries `{ message, stream, usage? }`.
    const usage = (event.data as { usage?: UsageCarrier['usage'] }).usage
    if (usage === undefined) continue
    input += usage.inputTokens ?? 0
    output += usage.outputTokens ?? 0
    cacheRead += usage.cacheReadTokens ?? 0
    cacheWrite += usage.cacheWriteTokens ?? 0
    const prompt = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    latest = prompt > 0 ? ((usage.cacheReadTokens ?? 0) / prompt) * 100 : undefined
  }
  return { ledger: { input, output, cacheRead, cacheWrite }, cacheHitRate: latest }
}

/**
 * Build the two rendered lines of the status bar, width-aware.
 *
 * Layout (matches pi's footer):
 *
 * ```
 * ~/.neeko/worktrees/dsh-neeko (dsh-neeko)
 * ↑2.4M ↓364k R395M CH99.9% $4.259 78.5%/1.0M      (magpie) group/auto-… • high
 * ```
 *
 * The right segment is **flush right**; the left segment is truncated first
 * when the two collide (the model name is the more useful half — it tells you
 * what will answer next). Only the context percentage carries a severity color.
 *
 * @param facts - status facts.
 * @param options - theme painter + terminal width + home directory.
 * @returns one or two lines, the context line omitted when it would be empty.
 */
export function renderStatusBar(
  facts: StatusFacts,
  options: {
    readonly width: number
    readonly home?: string
    /** Timing segment (span / active / live state), prepended to the ledger. */
    readonly timing?: string
    readonly paint: (token: 'dim' | 'muted' | 'warning' | 'error', text: string) => string
  },
): readonly string[] {
  const { width, paint } = options
  const context = contextLine(facts, options.home ?? homedir())
  const route = routeLine(facts)
  const stats = ledgerStats(facts)
  const timing = options.timing ?? ''
  // Timing leads the ledger: it answers "how long has this been running", which
  // is the first thing you look for on a long turn.
  const statsWithTiming = [timing, stats].filter((part) => part !== '').join('  ')
  const contextText = contextPart(facts)
  const severity = contextSeverity(facts)

  // ── width arithmetic in PLAIN text only ────────────────────────────────────
  // `paint` output may contain escape sequences (or test tags). Measuring it
  // would skew the padding, so every decision below uses plain widths and
  // coloring is applied at the very end.
  const gap = 2
  const statsWidth = visibleWidth(statsWithTiming)
  const contextWidth = visibleWidth(contextText)
  const routeWidth = visibleWidth(route)
  const leftWidth = statsWidth + (statsWithTiming === '' || contextText === '' ? 0 : 1) + contextWidth

  let showStats = statsWithTiming !== ''
  let shownContext = contextText
  let truncated = false

  if (leftWidth + gap + routeWidth > width) {
    const room = Math.max(0, width - gap - routeWidth)
    if (room <= 0) {
      showStats = false
      shownContext = ''
    } else if (statsWidth > room) {
      // Counters are historical; the context figure is the live signal.
      showStats = false
      shownContext = contextWidth <= room ? contextText : truncateToWidth(contextText, room, '…')
      truncated = shownContext !== contextText
    } else {
      const contextRoom = room - statsWidth - (statsWithTiming === '' ? 0 : 1)
      if (contextWidth > contextRoom) {
        shownContext = contextRoom > 1 ? truncateToWidth(contextText, contextRoom, '…') : ''
        truncated = true
      }
    }
  }

  const shownStats = showStats ? statsWithTiming : ''
  const plainLeft = [shownStats, shownContext].filter((part) => part !== '').join(' ')
  const plainLeftWidth = visibleWidth(plainLeft)
  const padding = ' '.repeat(Math.max(gap, width - plainLeftWidth - routeWidth))
  void truncated

  const paintedStats = shownStats === '' ? '' : paint('muted', shownStats)
  const paintedContext = shownContext === ''
    ? ''
    : severity === undefined ? paint('muted', shownContext) : paint(severity, shownContext)
  const leftText = [paintedStats, paintedContext].filter((part) => part !== '').join(' ')
  const second = `${leftText}${padding}${paint('muted', route)}`

  return [paint('dim', context), second]
}
