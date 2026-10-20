import { describe, expect, it, vi } from 'vitest'
import { ResumeController } from '../src/tui/resume-controller.ts'
import type { ResumeSource } from '../src/tui/resume-list.ts'

/**
 * The `/resume` state machine, without a terminal.
 *
 * `tui-resume-glue.spec.ts` already covers the same behaviour through `TuiApp`,
 * but it can only see it mixed with key arbitration and rendering. This file
 * pins the controller's own contract: what it owns, what it asks the host for,
 * and when it gives up on a stale answer.
 *
 * The split matters because the session corpus is the one place where a wrong
 * guess costs seconds — a title is a session-artifact decompress, and the panel
 * must be usable before any of them land.
 */

const source = (id: string, title?: string): ResumeSource => ({
  header: { id, createdAt: 1_000, cwd: '/work/one' },
  live: false,
  persisted: true,
  ...(title === undefined ? {} : { title }),
})

/** A controller wired to fakes; every collaborator is observable. */
function makeController(over: {
  sources?: readonly ResumeSource[]
  titles?: (ids: readonly string[]) => Promise<Readonly<Record<string, string>>>
  resumeSession?: (id: string) => void
  currentId?: string
} = {}) {
  const calls = { titles: [] as (readonly string[])[], status: [] as string[], notices: [] as string[] }
  const controller = new ResumeController({
    listSessions: async () => over.sources ?? [source('a'), source('b')],
    ...(over.titles === undefined ? {} : {
      sessionTitles: async (ids: readonly string[]) => {
        calls.titles.push(ids)
        return over.titles!(ids)
      },
    }),
    resumeSession: over.resumeSession ?? (() => {}),
    currentSessionId: () => over.currentId ?? 'current',
    onStatus: (text) => { calls.status.push(text) },
    onNotice: (text, tone) => { calls.notices.push(`${tone}:${text}`) },
  })
  return { controller, calls }
}

describe('ResumeController.open', () => {
  it('opens the picker without reading every title in the corpus', async () => {
    // The whole reason this is paged: 424 sessions never finished.
    const many = Array.from({ length: 424 }, (_, i) => source(`s${i}`))
    const { controller, calls } = makeController({
      sources: many,
      titles: async (ids) => Object.fromEntries(ids.map((id) => [id, `T ${id}`])),
    })
    await controller.open('')
    expect(controller.view).toBeDefined()
    const asked = calls.titles.reduce((total, page) => total + page.length, 0)
    expect(asked).toBeLessThanOrEqual(150)
  })

  it('titles the sessions that have history and hides the rest', async () => {
    const { controller } = makeController({
      sources: [source('titled'), source('empty')],
      titles: async () => ({ titled: 'A real conversation' }),
    })
    await controller.open('')
    expect(controller.view?.choices.map((choice) => choice.text).join('\n')).toContain('real conversation')
    expect(controller.view?.choices.some((choice) => choice.id === 'empty')).toBe(false)
  })

  it('shows empty sessions when the filter is off', async () => {
    const { controller } = makeController({
      sources: [source('titled'), source('empty')],
      titles: async () => ({ titled: 'A real conversation' }),
    })
    await controller.open('all')
    expect(controller.view?.choices.some((choice) => choice.id === 'empty')).toBe(true)
  })

  it('says how many it hid instead of showing a shorter list', async () => {
    const { controller, calls } = makeController({
      sources: [source('titled'), source('empty')],
      titles: async () => ({ titled: 'A real conversation' }),
    })
    await controller.open('')
    expect(calls.notices.join('\n')).toContain('1 session(s) with no conversation')
  })

  it('reports an empty corpus as nothing to resume, not as an empty panel', async () => {
    const { controller, calls } = makeController({ sources: [] })
    await controller.open('')
    expect(controller.view).toBeUndefined()
    expect(calls.notices.join('\n')).toContain('no sessions to resume')
  })

  it('surfaces a listing failure', async () => {
    const controller = new ResumeController({
      listSessions: async () => { throw new Error('host is down') },
      sessionTitles: async () => ({}),
      resumeSession: () => {},
      currentSessionId: () => 'current',
      onStatus: () => {},
      onNotice: (text, tone) => { expect(tone).toBe('error'); expect(text).toContain('host is down') },
    })
    await controller.open('')
    expect(controller.view).toBeUndefined()
  })
})

describe('ResumeController.open with a session id', () => {
  it('resumes the id directly, without opening a panel', async () => {
    const resumeSession = vi.fn()
    const { controller } = makeController({
      sources: [source('abc12345')],
      resumeSession,
    })
    await controller.open('abc12345')
    expect(resumeSession).toHaveBeenCalledTimes(1)
    expect(controller.view).toBeUndefined()
  })

  it('rejects an id nobody can be, and points at the picker', async () => {
    const resumeSession = vi.fn()
    const { controller, calls } = makeController({ resumeSession })
    await controller.open('nope')
    expect(resumeSession).not.toHaveBeenCalled()
    expect(calls.notices.join('\n')).toContain('unknown session "nope"')
  })
})

describe('ResumeController.resume', () => {
  it('does not re-attach the session already in use', async () => {
    // Re-attaching rebuilds the transcript for no reason and loses scroll.
    const resumeSession = vi.fn()
    const { controller, calls } = makeController({ resumeSession, currentId: 'live' })
    controller.resume('live')
    expect(resumeSession).not.toHaveBeenCalled()
    expect(calls.status.join('\n')).toContain('already on live')
  })

  it('reports a rejected switch instead of appearing to succeed', async () => {
    const { controller, calls } = makeController({
      resumeSession: () => { throw new Error('session gone') },
    })
    controller.resume('gone')
    expect(calls.notices.join('\n')).toContain('could not resume session: session gone')
  })
})

describe('ResumeController key routing', () => {
  const isKey = (name: string) => (data: string) => data === name

  it('moves the cursor with clamping', async () => {
    const { controller } = makeController({
      sources: [source('a'), source('b')],
      titles: async () => ({ a: 'A', b: 'B' }),
    })
    await controller.open('')
    controller.handleKey(isKey('down'))
    // Already on the last row: clamping keeps the motion the user made rather
    // than jumping the window back to the top.
    expect(controller.view?.index).toBe(1)
    controller.handleKey(isKey('down'))
    expect(controller.view?.index).toBe(1)
  })

  it('closes on escape without switching', async () => {
    const resumeSession = vi.fn()
    const { controller } = makeController({ resumeSession })
    await controller.open('')
    controller.handleKey(isKey('escape'))
    expect(controller.view).toBeUndefined()
    expect(resumeSession).not.toHaveBeenCalled()
  })

  it('resumes the highlighted row on confirm', async () => {
    const resumeSession = vi.fn()
    const { controller } = makeController({
      // A session with no title has no history, so it is filtered out of the
      // default view — a row has to exist before enter can pick it.
      titles: async (ids) => Object.fromEntries(ids.map((id) => [id, `T ${id}`])),
      resumeSession,
    })
    await controller.open('')
    controller.handleKey(isKey('enter'))
    expect(resumeSession).toHaveBeenCalledTimes(1)
  })
})

describe('ResumeController stale-answer guard', () => {
  it('does not open a panel that was dismissed while titles were loading', async () => {
    // `open` awaits the pre-scan, so a `close()` can land between the listing
    // arriving and the panel being installed. Without the generation check the
    // panel appears *after* the user dismissed it — and then holds the keyboard.
    let releasePrescan: ((titles: Record<string, string>) => void) | undefined
    const { controller } = makeController({
      sources: [source('a')],
      titles: () => new Promise((resolve) => { releasePrescan = resolve }),
    })
    const opening = controller.open('')
    // `open` awaits the listing, then the pre-scan: both have to yield before the
    // title call exists.
    for (let i = 0; i < 10 && releasePrescan === undefined; i += 1) await Promise.resolve()
    expect(releasePrescan).toBeTypeOf('function')
    controller.close()
    releasePrescan?.({ a: 'late title' })
    await opening
    expect(controller.view).toBeUndefined()
  })

  it('drops a title page that lands after the picker closed', async () => {
    // A page in flight from a previous open must not resurrect a closed panel.
    let release: ((titles: Record<string, string>) => void) | undefined
    const { controller } = makeController({
      sources: [source('a')],
      titles: () => new Promise((resolve) => { release = resolve }),
    })
    // Not awaited: the point is what happens to this call's *work*, and in
    // production the host always answers. Awaiting it here would only pin the
    // test to the fake's never-resolving promise.
    void controller.open('')
    // Let `open` reach its title read before dismissing.
    await Promise.resolve()
    controller.close()
    expect(controller.view).toBeUndefined()
    release?.({ a: 'late title' })
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.view).toBeUndefined()
  })
})
