import { describe, expect, it, vi } from 'vitest'
import { TuiApp } from '../src/tui/app.ts'
import type { TuiAppOptions } from '../src/tui/app.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

/**
 * `/resume` glue: slash line → app → host, and picker keys → resume.
 *
 * Separate from `tui-resume-list.spec.ts` (the pure row projection) because the
 * state machine being correct on its own has never been enough here: every TUI
 * defect in this project lived between a correct module and a correct screen.
 */

const record = (over: { id?: string; live?: boolean; title?: string } = {}) => ({
  header: { id: over.id ?? 'session-a', createdAt: Date.now() - 60_000, cwd: '/work/one' },
  live: over.live ?? false,
  persisted: true,
  ...(over.title === undefined ? {} : { title: over.title }),
})

function makeApp(over: Partial<TuiAppOptions> = {}): {
  app: TuiApp
  submit: (text: string) => Promise<void>
  key: (data: string) => { consume?: boolean } | undefined
  resume: ReturnType<typeof vi.fn>
  panel: () => string
  notices: () => string
} {
  const resume = vi.fn()
  const app = new TuiApp({
    getSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp/w',
    getSessionId: () => 'session-current',
    onSubmit: () => {},
    onExit: () => {},
    version: '0',
    statusFacts: () => ({ cwd: '/tmp/w' }),
    modelPicker: async () => ({ models: [], current: '' }),
    selectModel: () => {},
    listSessions: async () => [
      record({ id: 'session-current', live: true, title: 'current work' }),
      record({ id: 'session-old', title: 'older work' }),
    ],
    resumeSession: resume,
    terminal: new FakeTerminal(),
    ...over,
  } as TuiAppOptions)
  const call = <T>(name: string, ...args: unknown[]): T => {
    const fn = (app as unknown as Record<string, ((...a: unknown[]) => T) | undefined>)[name]
    if (fn === undefined) throw new Error(`TuiApp has no method ${name}`)
    return fn.apply(app, args)
  }
  return {
    app,
    resume,
    submit: (text) => call('submit', text),
    key: (data) => call('handleInput', data),
    panel: () => (app as unknown as { resumeText: { render(w: number): string[] } })
      .resumeText.render(120).join('\n').trim(),
    notices: () => (app as unknown as { noticeLog: { container: { children: { render(w: number): string[] }[] } } })
      .noticeLog.container.children.map((child) => child.render(200).join('\n')).join('\n'),
  }
}

/**
 * Wait until `predicate` holds, up to `limit` ms.
 *
 * These tests exercise async enrichment (titles land after the panel is built),
 * and a fixed `setTimeout(40)` is a false-passer: it is enough on an idle machine
 * and not enough under load, which showed up as an unrelated-looking flake.
 *
 * @param predicate - condition to wait for.
 * @param limit - budget in milliseconds.
 */
async function settle(predicate: () => boolean, limit = 1_000): Promise<void> {
  const deadline = Date.now() + limit
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('/resume (bare) opens the session list', () => {
  it('lists the sessions with the live one marked', async () => {
    const { submit, panel } = makeApp()
    await submit('/resume')
    expect(panel()).toContain('Resume session')
    expect(panel()).toContain('current work')
    expect(panel()).toContain('older work')
    expect(panel()).toMatch(/→ ✓ current work/u)
  })

  it('starts the cursor on the session in use, wherever it sits', async () => {
    // The live session is deliberately NOT the first row: with it first, an
    // implementation that always returns index 0 would pass this test too.
    const { submit, panel } = makeApp({
      listSessions: async () => [
        record({ id: 'session-newest', title: 'newest work' }),
        record({ id: 'session-current', live: true, title: 'current work' }),
      ],
    })
    await submit('/resume')
    const rows = panel().split('\n').filter((line) => /work/u.test(line))
    expect(rows[0]).not.toContain('→')
    expect(rows[1]).toContain('→ ✓')
  })

  it('resumes the highlighted session on enter', async () => {
    const { submit, key, resume } = makeApp()
    await submit('/resume')
    key('\x1b[B') // down → the older session
    key('\r')
    expect(resume).toHaveBeenCalledWith('session-old')
  })

  it('closes on escape without switching', async () => {
    const { submit, key, resume, panel } = makeApp()
    await submit('/resume')
    key('\x1b')
    expect(panel()).toBe('')
    expect(resume).not.toHaveBeenCalled()
  })

  it('owns the keyboard while open', async () => {
    const { submit, key, panel } = makeApp()
    await submit('/resume')
    expect(key('x')).toEqual({ consume: true })
    expect(panel()).toContain('Resume session')
  })

  it('says so when there is nothing to resume', async () => {
    // An empty panel would own the keyboard with no way to see why.
    const { submit, panel, notices } = makeApp({ listSessions: async () => [] })
    await submit('/resume')
    expect(panel()).toBe('')
    expect(notices()).toContain('no sessions to resume')
  })

  it('surfaces a listing failure instead of an empty list', async () => {
    const { submit, notices } = makeApp({
      listSessions: async () => { throw new Error('corpus unavailable') },
    })
    await submit('/resume')
    expect(notices()).toContain('corpus unavailable')
  })
})

describe('/resume <id>', () => {
  it('resumes a full id directly', async () => {
    const { submit, resume } = makeApp()
    await submit('/resume session-old')
    expect(resume).toHaveBeenCalledWith('session-old')
  })

  it('accepts the shortened id the picker shows', async () => {
    // Rows fall back to the id *without* dsh's `session-` prefix when a session
    // has no title, so typing what you see has to resolve.
    const { submit, resume } = makeApp({
      getSessionId: () => 'session-current',
      listSessions: async () => [
        record({ id: 'session-a', title: 'has a title' }),
        record({ id: 'session-9f3c1d2e' }),
      ],
    })
    await submit('/resume 9f3c1d2e')
    expect(resume).toHaveBeenCalledWith('session-9f3c1d2e')
  })

  it('rejects an unknown id and points at the picker', async () => {
    const { submit, resume, notices } = makeApp()
    await submit('/resume nope')
    expect(resume).not.toHaveBeenCalled()
    expect(notices()).toContain('unknown session')
  })

  it('does not re-attach the session already in use', async () => {
    // Re-attaching rebuilds the transcript and loses the scroll position for no
    // benefit; say "already here" instead.
    const { submit, resume, notices } = makeApp()
    await submit('/resume session-current')
    expect(resume).not.toHaveBeenCalled()
    expect(notices()).not.toContain('could not resume')
  })

  it('surfaces a rejected switch', async () => {
    const { submit, notices } = makeApp({
      resumeSession: () => { throw new Error('session is mid-turn') },
    })
    await submit('/resume session-old')
    expect(notices()).toContain('mid-turn')
  })
})

describe('resume is offered with the other selectors', () => {
  it('appears in /help', async () => {
    const { submit, notices } = makeApp()
    await submit('/help')
    expect(notices()).toContain('/resume')
  })
})

describe('titles load by page, not all at once', () => {
  /**
   * A title is one session-artifact read and decompress. On a real 424-session
   * profile the all-at-once version never finished (still pending after 40 s),
   * and a fixed head window left every scrolled-to row on its id fallback. So
   * the fetch follows the visible window, and fetched pages are cached.
   */
  // These sessions have history (a title), so the default filter keeps them —
  // the empty-session filter is exercised separately below.
  const many = (count: number) => Array.from({ length: count }, (_, i) =>
    record({ id: `session-${String(i).padStart(8, '0')}`, title: `Session ${i}` }))

  it('does not request the whole corpus when the picker opens', async () => {
    // Opening folds one *judge page* — bigger than the render window, because
    // the empty-session filter has to see past the run of fresh launches at the
    // top, but nowhere near the 500 sessions available.
    const titles = vi.fn(async (ids: readonly string[]) =>
      Object.fromEntries(ids.map((id) => [id, `T:${id.slice(-8)}`])))
    const { submit } = makeApp({ listSessions: async () => many(500), sessionTitles: titles })
    await submit('/resume')
    await settle(() => titles.mock.calls.length > 0)
    const asked = titles.mock.calls.flatMap((call) => call[0] as readonly string[])
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.length).toBeLessThan(500)
    expect(new Set(asked).size).toBe(asked.length) // no id requested twice
  })

  it('does not re-request a page it already has', async () => {
    // The cache is what makes scrolling back free.
    const titles = vi.fn(async (ids: readonly string[]) =>
      Object.fromEntries(ids.map((id) => [id, `T:${id.slice(-8)}`])))
    const { submit, key } = makeApp({ listSessions: async () => many(100), sessionTitles: titles })
    await submit('/resume')
    await settle(() => titles.mock.calls.length > 0)
    const first = titles.mock.calls.length
    key('\x1b[B') // within the same window
    key('\x1b[A')
    await settle(() => false, 60)
    expect(titles.mock.calls.length).toBe(first)
  })

  it('fetches more as the cursor scrolls past the pre-scanned head', async () => {
    const titles = vi.fn(async (ids: readonly string[]) =>
      Object.fromEntries(ids.map((id) => [id, `T:${id.slice(-8)}`])))
    // The head is pre-scanned on open, so scrolling has to go past it before a
    // new page is needed.
    const { submit, key } = makeApp({ listSessions: async () => many(600), sessionTitles: titles })
    await submit('/resume')
    await settle(() => titles.mock.calls.length > 0)
    const before = titles.mock.calls.length
    for (let i = 0; i < 200; i += 1) key('\x1b[B')
    await settle(() => titles.mock.calls.length > before, 2_000)
    expect(titles.mock.calls.length).toBeGreaterThan(before)
  })

  it('shows the fetched titles for the visible rows', async () => {
    const { submit, panel } = makeApp({
      listSessions: async () => many(30),
      sessionTitles: async (ids: readonly string[]) =>
        Object.fromEntries(ids.map((id) => [id, `Title ${id.slice(-8)}`])),
    })
    await submit('/resume')
    await settle(() => panel().includes('Title 00000000'))
    expect(panel()).toContain('Title 00000000')
  })

  it('keeps the list when a page fails', async () => {
    const { submit, panel, notices } = makeApp({
      listSessions: async () => many(30),
      sessionTitles: async () => { throw new Error('title service down') },
    })
    await submit('/resume')
    await settle(() => notices().includes('title service down'))
    expect(panel()).toContain('Resume session')
    expect(notices()).toContain('title service down')
  })

  it('drops a page that lands after the picker was reopened', async () => {
    // The panel is open again, so "it is open" is not enough to tell a fresh page
    // from a stale one — the generation counter is. Without it the old page's
    // rows would repaint over the new picker's.
    // The first call is the pre-scan, which the picker awaits; answer it so the
    // panel opens, then leave the *page* fetch hanging.
    // Odd calls are pre-scans (the picker awaits them) and resolve immediately;
    // even calls are page fetches and are left hanging so a stale one can land.
    let call = 0
    const releases: ((v: Record<string, string>) => void)[] = []
    const { submit, key, panel } = makeApp({
      listSessions: async () => many(30),
      sessionTitles: () => new Promise((resolve) => {
        call += 1
        if (call % 2 === 1) resolve({})
        else releases.push(resolve)
      }),
    })
    await submit('/resume')
    key('\x1b') // close while page 1 is in flight
    await submit('/resume') // reopen; a second page is now in flight
    // Answer ONLY the stale page.
    releases[0]?.({ 'session-00000000': 'STALE-FROM-OLD-PICKER' })
    await settle(() => false, 80)
    expect(panel()).toContain('Resume session')
    expect(panel()).not.toContain('STALE-FROM-OLD-PICKER')
  })
})

describe('paging window matches the rendered window', () => {
  /**
   * The two `listWindow` calls (render + title fetch) must agree. If the fetch
   * window is even one row narrower than the painted one, the last visible row
   * never gets a title and stays on its id fallback forever — which is exactly
   * what "the list shows no titles" looked like from the outside.
   */
  it('requests a title for every row it paints', async () => {
    const titles = vi.fn(async (ids: readonly string[]) =>
      Object.fromEntries(ids.map((id) => [id, `T${id.slice(-4)}`])))
    const { submit } = makeApp({
      listSessions: async () => Array.from({ length: 30 }, (_, i) =>
        record({ id: `session-${String(i).padStart(8, '0')}` })),
      sessionTitles: titles,
    })
    await submit('/resume')
    await settle(() => titles.mock.calls.length > 0)
    // 10 painted rows ⇒ at least 10 ids asked for (plus any margin).
    expect((titles.mock.calls[0]?.[0] as readonly string[]).length).toBeGreaterThanOrEqual(10)
  })

  it('keeps an id fallback identifiable when a title is missing', async () => {
    // A session listed before its title has been folded must not render as a
    // blank row. Reached via `/resume all`: by default a title-less session is
    // filtered out (see the empty-session cases below).
    const { submit, panel } = makeApp({
      listSessions: async () => [
        record({ id: 'session-current', live: true, title: 'current work' }),
        record({ id: 'session-ffffffff' }),
      ],
      sessionTitles: async () => ({}),
    })
    await submit('/resume all')
    await settle(() => panel().includes('ffffffff'))
    expect(panel()).toContain('current work')
    expect(panel()).toContain('ffffffff')
  })
})

describe('empty sessions do not bury the useful ones', () => {
  /**
   * Every launch that exits without a prompt leaves a session behind, and they
   * sort newest-first — on the machine this was built on, 451 sessions where the
   * newest ten were all empty. Listing them put nothing identifiable on screen.
   *
   * The filter runs when titles land, not when the panel opens: deciding "has
   * history" up front would mean folding titles for a large slice of the corpus,
   * and sixty of those did not finish in two seconds on a real profile.
   */
  const mixed = () => [
    record({ id: 'session-current', live: true }),      // empty, but it is "here"
    record({ id: 'session-emptya' }),                   // empty
    record({ id: 'session-named1', title: 'fix the parser' }),
    record({ id: 'session-named2', title: 'why is resume slow' }),
  ]

  it('hides sessions with no conversation once their titles are known', async () => {
    const { submit, panel } = makeApp({
      listSessions: async () => mixed(),
      sessionTitles: async () => ({}),
    })
    await submit('/resume')
    await settle(() => !panel().includes('emptya'))
    expect(panel()).toContain('fix the parser')
    expect(panel()).not.toContain('emptya')
  })

  it('always keeps the session this TUI is attached to', async () => {
    // Hiding "here" from its own picker would read as a bug.
    const { submit, panel } = makeApp({ listSessions: async () => mixed() })
    await submit('/resume')
    await settle(() => !panel().includes('emptya'))
    expect(panel()).toContain('[current]')
  })

  it('shows everything on /resume all', async () => {
    const { submit, panel } = makeApp({ listSessions: async () => mixed() })
    await submit('/resume all')
    await settle(() => panel().includes('emptya'))
    expect(panel()).toContain('emptya')
    expect(panel()).toContain('fix the parser')
  })

  it('shows only the attached session when nothing else has history', async () => {
    // There is deliberately no "fall back to everything" branch: that fallback
    // is what kept the panel full of empty sessions on a working machine.
    const { submit, panel } = makeApp({
      listSessions: async () => [record({ id: 'session-current', live: true }), record({ id: 'session-09876543' })],
      sessionTitles: async () => ({}),
    })
    await submit('/resume')
    await settle(() => !panel().includes('09876543'))
    expect(panel()).toContain('[current]')
    expect(panel()).not.toContain('09876543')
  })
})
