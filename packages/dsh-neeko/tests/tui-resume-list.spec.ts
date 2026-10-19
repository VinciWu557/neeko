import { describe, expect, it } from 'vitest'
import { relativeAge, resumeRowText, titlesFromObservations, toResumeChoices } from '../src/tui/resume-list.ts'

/**
 * `/resume` — the list of sessions a user can switch back into.
 *
 * Pure projection of dsh's own answer. `ctx.sessionQuery.listSessions()` returns
 * `SessionRecord` = `{ header, live, persisted }` in newest-first order, and the
 * header carries no title, so a readable label means one extra `readTitle()` per
 * row. Everything here is formatting and selection; the fetching lives in the
 * runner.
 *
 * A session listed but not `persisted` is *creatable* from dsh's perspective
 * (`persisted` means "the backend currently lists it"), so it is offered — but a
 * live one is marked, because resuming is a switch away from what you are using.
 */

const now = 1_700_000_000_000

function record(over: {
  id?: string
  createdAt?: number
  cwd?: string
  live?: boolean
  persisted?: boolean
  title?: string
} = {}) {
  return {
    header: {
      id: over.id ?? 'session-1',
      createdAt: over.createdAt ?? now - 60_000,
      ...(over.cwd === undefined ? {} : { cwd: over.cwd }),
    },
    live: over.live ?? false,
    persisted: over.persisted ?? true,
    ...(over.title === undefined ? {} : { title: over.title }),
  }
}

describe('relativeAge', () => {
  it('reports the coarse bucket a session list needs', () => {
    // Exact timestamps are noise in a picker; pi shows the same coarse buckets.
    expect(relativeAge(now, now)).toBe('now')
    expect(relativeAge(now - 5 * 60_000, now)).toBe('5m')
    expect(relativeAge(now - 3 * 3_600_000, now)).toBe('3h')
    expect(relativeAge(now - 2 * 86_400_000, now)).toBe('2d')
  })

  it('never goes negative when a clock runs behind', () => {
    // A resumed session's createdAt can be microseconds in the future on a
    // machine whose clock moved; "now" is the honest floor.
    expect(relativeAge(now + 60_000, now)).toBe('now')
  })
})

describe('resumeRowText', () => {
  it('shows the title, the cwd and the age', () => {
    const text = resumeRowText(record({ title: 'Fix the parser', cwd: '/work/repo' }), now)
    expect(text).toContain('Fix the parser')
    expect(text).toContain('repo')
    expect(text).toContain('1m')
  })

  it('falls back to the id when the session has no title', () => {
    // A session can be listed before any title event exists; an empty row would
    // be unpickable.
    const text = resumeRowText(record({ id: 'session-abcdef123456' }), now)
    expect(text).toContain('abcdef')
  })

  it('marks the session currently in use', () => {
    // Resuming a live session is a no-op the user should be able to see.
    expect(resumeRowText(record({ title: 't', live: true }), now)).toContain('[current]')
    expect(resumeRowText(record({ title: 't', live: false }), now)).not.toContain('[current]')
  })

  it('keeps one row per session', () => {
    // The panel is a single-line-per-entry list; a newline would break the
    // cursor's row math.
    expect(resumeRowText(record({ title: 'a\nb' }), now)).not.toContain('\n')
  })
})

describe('toResumeChoices', () => {
  it('preserves the newest-first order dsh returned', () => {
    // Re-sorting here would second-guess the corpus ordering.
    const choices = toResumeChoices(
      [record({ id: 'new', createdAt: now }), record({ id: 'old', createdAt: now - 86_400_000 })],
      now,
    )
    expect(choices.map((choice) => choice.id)).toEqual(['new', 'old'])
  })

  it('marks exactly the live session as current', () => {
    const choices = toResumeChoices([record({ id: 'a' }), record({ id: 'b', live: true })], now)
    expect(choices.filter((choice) => choice.current).map((choice) => choice.id)).toEqual(['b'])
  })

  it('is empty for an empty corpus', () => {
    // The app turns this into a notice rather than an empty panel.
    expect(toResumeChoices([], now)).toEqual([])
  })
})

describe('titlesFromObservations (dsh batch title answer)', () => {
  /**
   * The batch call is the only affordable title path — the per-id one could not
   * fold 60 ids inside two seconds on a real profile — so reading its shape
   * correctly is load-bearing, and it is tested here rather than through a
   * session service.
   */
  it('keeps fulfilled titles', () => {
    expect(titlesFromObservations([
      { sessionId: 'a', status: 'fulfilled', value: { title: { title: 'hello' } } },
      { sessionId: 'b', status: 'fulfilled', value: { title: { title: 'fix the parser' } } },
    ])).toEqual({ a: 'hello', b: 'fix the parser' })
  })

  it('drops rejected entries without failing the batch', () => {
    // One unreadable session must not cost the rest of the page its titles.
    expect(titlesFromObservations([
      { sessionId: 'a', status: 'rejected' },
      { sessionId: 'b', status: 'fulfilled', value: { title: { title: 'kept' } } },
    ])).toEqual({ b: 'kept' })
  })

  it('ignores a value on a rejected entry', () => {
    // `status` is the only authority: dsh isolates a failure per session, and a
    // partially-read entry must not be presented as a title.
    expect(titlesFromObservations([
      { sessionId: 'a', status: 'rejected', value: { title: { title: 'stale' } } },
    ])).toEqual({})
  })

  it('drops a fulfilled entry with no folded title', () => {
    // A session with no title has no history; the row falls back to its id.
    expect(titlesFromObservations([
      { sessionId: 'a', status: 'fulfilled' },
      { sessionId: 'b', status: 'fulfilled', value: {} },
      { sessionId: 'c', status: 'fulfilled', value: { title: { title: '' } } },
    ])).toEqual({})
  })

  it('is empty for an empty batch', () => {
    expect(titlesFromObservations([])).toEqual({})
  })
})
