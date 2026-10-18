import { describe, expect, it } from 'vitest'
import {
  contextLine, contextPart, contextSeverity, foldUsage, formatCwd, formatTokens,
  ledgerLine, ledgerStats, renderStatusBar, routeLine,
} from '../src/tui/status-bar.ts'
import type { StatusFacts } from '../src/tui/status-bar.ts'

/**
 * The status bar's formatting rules, transcribed from pi's footer so the two
 * surfaces read the same. The shape under test:
 *
 * ```
 * ~/work/dsh-neeko (main)
 * ↑2.4M ↓353k R379M CH99.9% $4.259 76.6%/1.0M    (magpie) group/auto-… • high
 * ```
 */

const facts = (overrides: Partial<StatusFacts> = {}): StatusFacts => ({
  cwd: '/home/dev/work/dsh-neeko',
  branch: 'main',
  provider: 'magpie',
  model: 'group/auto-deepseek-v4-1-flash',
  reasoningEffort: 'high',
  ...overrides,
})

describe('formatTokens', () => {
  it('uses one decimal below ten units and none above', () => {
    expect(formatTokens(2_400_000)).toBe('2.4M')
    expect(formatTokens(379_000_000)).toBe('379M')
    expect(formatTokens(353_000)).toBe('353k')
    expect(formatTokens(1_000)).toBe('1.0k')
    expect(formatTokens(1_000_000)).toBe('1.0M')
  })

  it('keeps small counts as integers', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(0)).toBe('0')
  })

  it('never prints NaN or Infinity', () => {
    expect(formatTokens(Number.NaN)).toBe('0')
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0')
    expect(formatTokens(-5)).toBe('0')
  })
})

describe('formatCwd', () => {
  it('replaces the home directory with ~', () => {
    expect(formatCwd('/home/dev/work', '/home/dev')).toBe('~/work')
    expect(formatCwd('/home/dev', '/home/dev')).toBe('~')
  })

  it('leaves a path outside home alone', () => {
    expect(formatCwd('/srv/app', '/home/dev')).toBe('/srv/app')
  })

  it('does not treat a sibling prefix as inside home', () => {
    // `/home/developer` must not become `~eloper`.
    expect(formatCwd('/home/developer', '/home/dev')).toBe('/home/developer')
  })
})

describe('contextLine', () => {
  it('appends the branch in parentheses', () => {
    expect(contextLine(facts(), '/home/dev')).toBe('~/work/dsh-neeko (main)')
  })

  it('omits the parentheses outside a repo', () => {
    const noBranch: StatusFacts = { cwd: '/home/dev/work/dsh-neeko', provider: 'magpie', model: 'm' }
    expect(contextLine(noBranch, '/home/dev')).toBe('~/work/dsh-neeko')
  })
})

describe('ledgerLine', () => {
  const ledger = { input: 2_400_000, output: 353_000, cacheRead: 379_000_000, cacheWrite: 1000, cost: 4.259 }

  it('renders the full ledger in pi order', () => {
    const line = ledgerLine(facts({ ledger, cacheHitRate: 99.9, contextTokens: 766_000, contextWindow: 1_000_000 }))
    expect(line).toBe('↑2.4M ↓353k R379M W1.0k CH99.9% $4.259 76.6%/1.0M')
  })

  it('omits zero counters instead of printing zeros', () => {
    const line = ledgerLine(facts({
      ledger: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextTokens: 0,
      contextWindow: 1_000_000,
    }))
    expect(line).toBe('↑10 0.0%/1.0M')
    expect(line).not.toContain('↓')
    expect(line).not.toContain('CH')
  })

  it('shows only the context figure before the first response', () => {
    expect(ledgerLine(facts({ contextWindow: 1_000_000 }))).toBe('?%/1.0M')
  })

  it('shows nothing when the window is unknown too', () => {
    expect(ledgerLine(facts())).toBe('')
  })

  it('hides the cache-hit rate unless cache tokens exist', () => {
    const line = ledgerLine(facts({
      ledger: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      cacheHitRate: 50,
      contextWindow: 1000,
      contextTokens: 100,
    }))
    expect(line).not.toContain('CH')
  })
})

describe('routeLine', () => {
  it('renders provider, model and reasoning effort', () => {
    expect(routeLine(facts())).toBe('(magpie) group/auto-deepseek-v4-1-flash • high')
  })

  it('omits the effort dot when the route has no reasoning level', () => {
    const noEffort: StatusFacts = { cwd: '/x', provider: 'magpie', model: 'group/auto-deepseek-v4-1-flash' }
    expect(routeLine(noEffort)).toBe('(magpie) group/auto-deepseek-v4-1-flash')
  })
})

describe('contextSeverity', () => {
  it('stays neutral below 70%', () => {
    expect(contextSeverity(facts({ contextTokens: 500, contextWindow: 1000 }))).toBeUndefined()
  })

  it('warns above 70% and errors above 90% (pi thresholds)', () => {
    expect(contextSeverity(facts({ contextTokens: 750, contextWindow: 1000 }))).toBe('warning')
    expect(contextSeverity(facts({ contextTokens: 950, contextWindow: 1000 }))).toBe('error')
  })

  it('stays neutral when the window is unknown', () => {
    expect(contextSeverity(facts({ contextTokens: 950 }))).toBeUndefined()
    expect(contextSeverity(facts({ contextTokens: 1, contextWindow: 0 }))).toBeUndefined()
  })
})

describe('foldUsage', () => {
  const message = (usage?: Record<string, number>) => ({ type: 'assistant/message', data: usage === undefined ? {} : { usage } })

  it('sums usage across every assistant message', () => {
    const { ledger } = foldUsage([
      message({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 }),
      message({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 15, cacheWriteTokens: 2 }),
    ])
    expect(ledger).toEqual({ input: 300, output: 30, cacheRead: 20, cacheWrite: 3 })
  })

  it('uses the latest message for the cache-hit rate, not a session average', () => {
    // A cache that just broke must show 0%, not the healthy historical average.
    const { cacheHitRate } = foldUsage([
      message({ inputTokens: 0, outputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 0 }),
      message({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ])
    expect(cacheHitRate).toBe(0)
  })

  it('ignores events without usage and non-assistant rows', () => {
    const { ledger } = foldUsage([
      { type: 'user/message', data: {} },
      message(undefined),
      { type: 'tool/result', data: { usage: { inputTokens: 999 } } },
    ])
    expect(ledger).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('leaves the hit rate undefined when the prompt is empty', () => {
    expect(foldUsage([message({ inputTokens: 0, outputTokens: 5 })]).cacheHitRate).toBeUndefined()
  })
})

/** Strip the paint escapes this suite emits. */
function plainLine(line: string): string {
  return line.replace(/\x1b\[[a-z0-9;]*m/g, '')
}

describe('renderStatusBar — layout', () => {
  // Zero-width, ANSI-shaped tags: real paint() adds escape sequences that
  // visibleWidth ignores. Emitting the same *shape* keeps every width
  // assertion honest while still letting tests read which token was used.
  const paint = (token: string, text: string): string => `\x1b[${token}m${text}\x1b[0m`
  const wide = facts({
    ledger: { input: 2_400_000, output: 364_000, cacheRead: 395_000_000, cacheWrite: 0, cost: 4.259 },
    cacheHitRate: 99.9,
    contextTokens: 785_000,
    contextWindow: 1_000_000,
  })

  it('renders two lines: context above, ledger + route below', () => {
    const lines = renderStatusBar(wide, { width: 140, home: '/home/dev', paint })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('~/work/dsh-neeko (main)')
    expect(lines[1]).toContain('↑2.4M')
  })

  it('flushes the route to the right edge', () => {
    const lines = renderStatusBar(wide, { width: 120, home: '/home/dev', paint })
    const second = plainLine(lines[1]!)
    expect(second.length).toBe(120)
    expect(second.trimEnd().endsWith('• high')).toBe(true)
    // A visible gap separates the two segments.
    expect(second).toMatch(/1\.0M {2,}\(magpie\)/)
  })

  it('colors only the context percentage, never the whole ledger', () => {
    const lines = renderStatusBar(wide, { width: 140, home: '/home/dev', paint })
    // 78.5% is above 70 → warning; the nearby counters stay `muted`.
    expect(lines[1]).toContain('\x1b[warningm78.5%/1.0M')
    expect(lines[1]).toContain('\x1b[mutedm↑2.4M')
  })

  it('leaves the context uncolored below the warning threshold', () => {
    const calm = facts({ contextTokens: 100_000, contextWindow: 1_000_000 })
    const lines = renderStatusBar(calm, { width: 120, home: '/home/dev', paint })
    expect(lines[1]).not.toContain('\x1b[warningm')
    expect(lines[1]).toContain('\x1b[mutedm10.0%/1.0M')
  })

  it('truncates the ledger, not the route, when space runs out', () => {
    const lines = renderStatusBar(wide, { width: 60, home: '/home/dev', paint })
    const second = plainLine(lines[1]!)
    expect(second).toContain('• high')
    // The ledger gives way before the route does.
    expect(lines[1]).not.toContain('↑2.4M')
    expect(second.length).toBeLessThanOrEqual(60)
  })

  it('still prints the context line when the route is long', () => {
    const lines = renderStatusBar(wide, { width: 200, home: '/home/dev', paint })
    expect(lines[0]).toContain('~/work/dsh-neeko')
  })
})
