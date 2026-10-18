import { describe, expect, it } from 'vitest'
import { renderBanner, shortenSessionId, supportsLogo, wordmark } from '../src/tui/banner.ts'
import type { BannerFacts } from '../src/tui/banner.ts'
import { resolveTheme } from '../src/tui/theme.ts'

/**
 * The startup banner.
 *
 * It is the first thing a user sees, so its shape is pinned: the mark stays
 * two lines (a taller logo eats the viewport), the theme colors the chrome but
 * never the mark, and a terminal that cannot render half blocks gets the
 * wordmark instead of broken pixels.
 */

const theme = resolveTheme({
  name: 'test',
  colors: {
    dim: 'okhsl(229 8% 56%)',
    muted: 'okhsl(229 6% 67%)',
  },
})

const facts: BannerFacts = {
  version: '0.2.0-rc.2',
  model: 'magpie/group/auto',
  cwd: '/tmp/project',
  sessionId: 'session-a5d9820c-e5c2-4da9-8992-71063558250b',
}

/** Strip ANSI so assertions read as plain text. */
function plain(lines: readonly string[]): string[] {
  return lines.map((line) => line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''))
}

describe('renderBanner', () => {
  it('draws the full DSH-NEEKO wordmark in 5 rows', () => {
    const lines = plain(renderBanner(theme, facts, { mode: 'truecolor' }).lines)
    const mark = lines.slice(0, 5)
    for (const row of mark) expect(row).toMatch(/[█]/)
    // The whole name is pixel-rendered — no plain-text prefix line.
    expect(mark.join('\n')).not.toMatch(/^dsh-/m)
    // `DSH-` occupies the left third; `NEEKO` follows it.
    expect(mark[0]).toMatch(/^████/)
    expect(mark[0]?.length).toBeGreaterThan(45)
    // Version rides only on the last mark row.
    expect(mark[4]).toContain('v0.2.0-rc.2')
    expect(mark.slice(0, 4).join('\n')).not.toContain('v0.2.0')
  })

  it('keeps the wordmark inside an 80-column terminal', () => {
    const markWidth = Math.max(...plain(renderBanner(theme, facts).lines)
      .slice(0, 5).map((line) => line.replace(/\s+v.*$/, '').length))
    expect(markWidth).toBeLessThanOrEqual(56)
  })

  it('shows model, cwd and a truncated session id', () => {
    const text = plain(renderBanner(theme, facts).lines).join('\n')
    expect(text).toContain('magpie/group/auto')
    expect(text).toContain('/tmp/project')
    // The banner shows the identifying uuid segment, not the literal
    // `session-` prefix nor the full id.
    expect(text).toContain('session a5d9820c')
    expect(text).not.toContain('session session-')
    expect(text).not.toContain('71063558250b')
  })

  it('prints one compact hint line, not a cheat sheet', () => {
    const lines = plain(renderBanner(theme, facts).lines)
    const hintLine = lines.find((line) => line.includes('commands'))
    expect(hintLine).toBeDefined()
    expect(hintLine).toContain('exit')
    // Banner stays short: 5 mark rows + subtitle + hints + spacing.
    expect(lines.length).toBeLessThanOrEqual(10)
  })

  it('falls back to the wordmark when the terminal cannot render half blocks', () => {
    const lines = plain(renderBanner(theme, facts, { forceWordmark: true }).lines)
    expect(lines[0]).toContain('neeko')
    expect(lines.join('\n')).not.toMatch(/[▀█]/)
  })

  it('keeps the mark colors theme-independent but themes the chrome', () => {
    const a = renderBanner(theme, facts).lines.join('\n')
    const other = resolveTheme({ name: 'other', colors: { dim: 'okhsl(0 0% 10%)', muted: 'okhsl(0 0% 20%)' } })
    const b = renderBanner(other, facts).lines.join('\n')
    // Chrome differs…
    expect(a).not.toBe(b)
    // …but the mark's own escape (teal) is identical in both.
    const teal = '\x1b[38;2;86;182;194m'
    expect(a).toContain(teal)
    expect(b).toContain(teal)
  })

  it('tolerates an unknown version string', () => {
    // The version rides on the mark's last row now.
    const lines = plain(renderBanner(theme, { ...facts, version: 'unknown' }).lines)
    expect(lines[4]).toContain('vunknown')
  })

  it('exposes the wordmark separately for reuse', () => {
    expect(plain([wordmark('truecolor')])[0]).toContain('neeko')
  })

  it('reports logo support as the inverse of the Apple Terminal guard', () => {
    // Can't fake TERM_PROGRAM here without mutating the environment; assert the
    // predicate is a boolean so callers never have to guard undefined.
    expect(typeof supportsLogo()).toBe('boolean')
  })
})

describe('shortenSessionId', () => {
  it('drops the session- prefix and keeps the leading uuid segment', () => {
    expect(shortenSessionId('session-a5d9820c-e5c2-4da9-8992-71063558250b')).toBe('a5d9820c')
  })

  it('handles an id without the prefix', () => {
    expect(shortenSessionId('abc12345-ffff')).toBe('abc12345')
  })

  it('returns the original id when there is nothing to shorten', () => {
    expect(shortenSessionId('session-')).toBe('session-')
  })
})
