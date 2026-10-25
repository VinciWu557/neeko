/**
 * The `/resume` subsystem: listing, paged title enrichment, and the picker.
 *
 * ## Why this is not in `TuiApp`
 *
 * It was 279 lines of the app class — the largest single block — and none of it
 * needed to be there. The state it owns (which listing, which page is in flight,
 * which generation is current, where the cursor is) has a lifecycle of its own:
 * it starts when `/resume` is typed and ends when the panel closes, which is
 * exactly the lifetime of a controller.
 *
 * ## The two hard constraints, and where they come from
 *
 * **Titles are expensive.** A title is one session-artifact read and decompress.
 * On a 424-session profile, asking for all of them never finished (still pending
 * after 40 s), and asking for a fixed head window left every scrolled-to row
 * stranded on its id. So pages follow the visible window, and the cache makes
 * scrolling back free.
 *
 * **Answers arrive after the question stops mattering.** The panel is usable
 * before any title lands; a page from a previous open therefore has to be
 * droppable. `generation` is bumped on every open and close, and a page whose
 * generation is stale is discarded rather than applied.
 *
 * ## What it deliberately does not do
 *
 * No rendering and no terminal: painting stays with the caller through
 * `onStatus` / `onNotice`, so this module is testable without a pty — the same
 * split `ThemeController` uses.
 *
 * @module dsh-neeko/tui/resume-controller
 */

import {
  initialResumeIndex,
  toResumeChoices,
  visibleResumeChoices,
} from './resume-list.ts'
import type { ResumeChoice, ResumeSource } from './resume-list.ts'
import { movedIndex, pickerIntent } from './picker.ts'

/**
 * How long the host may take to list sessions or read one page of titles.
 *
 * A hung host must not leave the panel waiting forever with no way back.
 */
const HOST_TIMEOUT_MS = 30_000

/**
 * Titles read before the panel opens, so the "has history" filter has something
 * to filter on.
 *
 * Uses the batch API: this is the one title read that delays the panel, and the
 * per-id path could not fold 60 ids inside two seconds on a real profile.
 */
const PRESCAN = 150

/** Rows the picker can show at once, which is also one page's radius. */
const PANEL_ROWS = 10

/** The picker's open state. */
export interface ResumePickerView {
  readonly choices: readonly ResumeChoice[]
  readonly index: number
  /** Show sessions with no conversation as well. */
  readonly includeEmpty: boolean
}

export interface ResumeControllerOptions {
  /** The host's session listing, newest first. */
  readonly listSessions: () => Promise<readonly ResumeSource[]>
  /** Batch title reader; absent means rows stay on their id fallback. */
  readonly sessionTitles?: ((ids: readonly string[]) => Promise<Readonly<Record<string, string>>>) | undefined
  /** Hand one id to the host. */
  readonly resumeSession: (sessionId: string) => void
  /** The session in use, so resuming it can be a no-op. */
  readonly currentSessionId: () => string
  /** Report the outcome of an action (`resuming X`). */
  readonly onStatus: (text: string) => void
  /** Report a problem the user has to see. */
  readonly onNotice: (text: string, tone: 'text' | 'muted' | 'error') => void
  /** Clock, injectable so row ages are stable in tests. */
  readonly now?: () => number
}

/**
 * Resolve `work`, or reject once `ms` elapse.
 *
 * The timer is cleared on the normal path: `Promise.race` alone leaves it armed,
 * and an armed timer is a handle the process has to wait out.
 *
 * @param work - the pending operation.
 * @param ms - budget in milliseconds.
 * @param what - the operation's name, for the message.
 * @returns the operation's result, or a rejection when it overruns.
 */
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`${what} timed out after ${ms}ms`)) }, ms)
    timer.unref?.()
    work.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * Does `wanted` name this session?
 *
 * Accepts the full id and the id without dsh's `session-` prefix; the picker
 * shows the shortened form, so typing what you see has to work.
 *
 * @param source - one listed session.
 * @param wanted - the typed argument.
 * @returns true when this is the session meant.
 */
function sessionMatches(source: ResumeSource, wanted: string): boolean {
  const id = source.header.id
  const lowered = wanted.toLowerCase()
  return id.toLowerCase() === lowered
    || id.replace(/^session-/u, '').toLowerCase() === lowered
}

/** The `/resume` state machine. */
export class ResumeController {
  private readonly options: ResumeControllerOptions
  private readonly now: () => number
  /** The listing the open panel was built from. */
  private sources: readonly ResumeSource[] = []
  /** Titles already read, keyed by session id. */
  private readonly titleCache = new Map<string, string>()
  /** Ids whose title is being read right now, so a page is not requested twice. */
  private readonly pending = new Set<string>()
  /**
   * Bumped on every open and close.
   *
   * A title page is a network-ish read that lands after the user may have closed
   * the panel and opened another; applying it then would resurrect a closed panel
   * or title the wrong listing.
   */
  private generation = 0
  private picker: ResumePickerView | undefined

  constructor(options: ResumeControllerOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
  }

  /** What the picker shows, or `undefined` when closed. */
  get view(): ResumePickerView | undefined {
    return this.picker
  }

  /** The listing backing the open panel, for a caller that re-renders it. */
  get listing(): readonly ResumeSource[] {
    return this.sources
  }

  /**
   * `/resume <argument>`: resume one id, or open the picker.
   *
   * `all` is a view flag rather than a session id, so it is decided before the id
   * lookup — an id named `all` cannot exist, but reading it as one first would
   * make the flag unreachable.
   *
   * @param argument - the text after `/resume`, already trimmed by the caller.
   */
  async open(argument: string): Promise<void> {
    // Captured so the awaits below can tell "closed while I was waiting" from
    // "still wanted". Without it a `close()` during a title read left `open`
    // running to completion and then re-opening the panel it had just dismissed.
    const generation = this.generation
    let sources: readonly ResumeSource[]
    try {
      sources = await withTimeout(this.options.listSessions(), HOST_TIMEOUT_MS, 'listing sessions')
    } catch (error: unknown) {
      this.options.onNotice(`could not list sessions: ${describe(error)}`, 'error')
      return
    }
    const wanted = argument.trim()
    const includeEmpty = wanted === 'all'
    if (wanted !== '' && !includeEmpty) {
      const match = sources.find((source) => sessionMatches(source, wanted))
      if (match === undefined) {
        this.options.onNotice(`unknown session "${wanted}" (type /resume to browse)`, 'error')
        return
      }
      this.resume(match.header.id)
      return
    }
    // Fold the head before deciding what to show: the filter keys on "has a
    // title", so an unfiltered first render would be nothing but the run of
    // empty launches that sort newest.
    await this.rescan(sources)
    // Closed (or replaced) while titles were being read: whoever asked is gone,
    // and opening a panel now would resurrect one the user dismissed.
    if (generation !== this.generation) return
    const every = toResumeChoices(this.titled(sources), this.now())
    const choices = visibleResumeChoices(every, includeEmpty)
    if (choices.length === 0) {
      this.options.onNotice('no sessions to resume', 'muted')
      return
    }
    const hidden = every.length - choices.length
    if (hidden > 0) {
      // Say it, or the shorter list reads as "my session is missing".
      this.options.onNotice(
        `hiding ${hidden} session(s) with no conversation — /resume all to show them`,
        'muted',
      )
    }
    this.sources = sources
    this.generation += 1
    this.pending.clear()
    this.picker = { choices, index: initialResumeIndex(choices), includeEmpty }
    // Titles arrive after the panel is already usable: waiting for all of them
    // is what made `/resume` look like a dead key.
    void this.fillPage(this.now())
  }

  /**
   * Handle one keystroke while the picker owns the keyboard.
   *
   * `pickerIntent()` supplies the key→intent mapping and `movedIndex()` the
   * clamp, so this only says where the cursor comes from and what confirming
   * means — the same split `runPickerKey()` performs for the app.
   *
   * @param isKey - predicate: does this key data match a named key?
   * @returns true when the picker was open (it always consumes while open).
   */
  handleKey(isKey: (name: 'escape' | 'up' | 'down' | 'enter') => boolean): boolean {
    const view = this.picker
    if (view === undefined) return false
    const intent = pickerIntent(isKey)
    switch (intent.kind) {
      case 'close':
        this.close()
        return true
      case 'move':
        this.picker = {
          choices: view.choices,
          index: movedIndex(view.index, intent.delta, view.choices.length),
          includeEmpty: view.includeEmpty,
        }
        // Paged: only the window the cursor scrolled into is fetched.
        void this.fillPage(this.now())
        return true
      case 'confirm': {
        const chosen = view.choices[view.index]
        this.close()
        if (chosen !== undefined) this.resume(chosen.id)
        return true
      }
      case 'ignore':
        return true
    }
  }

  /** Dismiss the panel. Any page still in flight will be discarded. */
  close(): void {
    this.generation += 1
    this.picker = undefined
  }

  /**
   * Hand one session id to the host.
   *
   * The switch itself belongs to the runner (it owns the agent and the
   * transcript), so this only validates and reports. Resuming the session
   * already in use is a no-op rather than a reload: re-attaching would rebuild
   * the transcript for no reason and lose the scroll position.
   *
   * @param sessionId - the session to attach to.
   */
  resume(sessionId: string): void {
    if (sessionId === this.options.currentSessionId()) {
      this.options.onStatus(`already on ${sessionId}`)
      return
    }
    try {
      this.options.resumeSession(sessionId)
    } catch (error: unknown) {
      this.options.onNotice(`could not resume session: ${describe(error)}`, 'error')
      return
    }
    this.options.onStatus(`resuming ${sessionId}`)
  }

  /**
   * Read titles for the visible window, one page at a time.
   *
   * The cost has to follow what is on screen, not the size of the corpus: asking
   * for everything never finished, and a fixed window left scrolled-to rows
   * stranded. Cached ids are skipped, and an in-flight page is not requested
   * twice.
   *
   * @param now - the clock the rows were built with, so ages stay stable.
   */
  private async fillPage(now: number): Promise<void> {
    const load = this.options.sessionTitles
    const view = this.picker
    if (load === undefined || view === undefined || this.sources.length === 0) return
    const page = windowIds(this.sources, view, PANEL_ROWS)
      .filter((id) => !this.titleCache.has(id) && !this.pending.has(id))
    if (page.length === 0) return
    const generation = this.generation
    for (const id of page) this.pending.add(id)
    let titles: Readonly<Record<string, string>>
    try {
      titles = await withTimeout(load(page), HOST_TIMEOUT_MS, 'reading session titles')
      // A page whose generation is stale belongs to a panel that has since been
      // closed or replaced; applying it would title the wrong list.
      if (generation !== this.generation) return
      for (const [id, title] of Object.entries(titles)) this.titleCache.set(id, title)
    } catch (error: unknown) {
      for (const id of page) this.pending.delete(id)
      // The list is already usable; a failed page must not replace it. Say why
      // the rows are still showing ids, though — silence reads as "no titles
      // exist" rather than "the read failed".
      this.options.onNotice(`session titles unavailable: ${describe(error)}`, 'error')
      return
    }
    for (const id of page) this.pending.delete(id)
    const current = this.picker
    if (current === undefined) return
    this.picker = {
      choices: this.choicesWithTitles(now, current.includeEmpty),
      index: current.index,
      includeEmpty: current.includeEmpty,
    }
  }

  /**
   * Fold titles for the head of the listing, so the filter can run.
   *
   * No timeout of its own beyond the host one: this read decides what the panel
   * contains, and a partial scan would silently show empty sessions while looking
   * like it had filtered them. A failure leaves the cache as it was.
   *
   * @param sources - the listing, newest first.
   */
  private async rescan(sources: readonly ResumeSource[]): Promise<void> {
    const load = this.options.sessionTitles
    if (load === undefined) return
    const page = sources
      .slice(0, PRESCAN)
      .map((source) => source.header.id)
      .filter((id) => !this.titleCache.has(id))
    if (page.length === 0) return
    try {
      const titles = await load(page)
      for (const [id, title] of Object.entries(titles)) this.titleCache.set(id, title)
    } catch {
      // Keep whatever is cached; ids are a usable fallback.
    }
  }

  /**
   * The picker's rows with every cached title applied.
   *
   * Rebuilt from the listing rather than mutated in place so the id fallback and
   * the enriched text always agree about what is known. The filter is re-applied
   * because titles are what make a row "have history" — otherwise hidden sessions
   * would reappear as soon as their title arrived.
   *
   * @param now - the clock, for the ages.
   * @param includeEmpty - keep sessions with no title.
   */
  private choicesWithTitles(now: number, includeEmpty: boolean): readonly ResumeChoice[] {
    const every = toResumeChoices(this.titled(this.sources), now)
    return visibleResumeChoices(every, includeEmpty)
  }

  /**
   * The listing with every cached title applied.
   *
   * @param sources - the raw listing.
   * @returns sources ready for `toResumeChoices`.
   */
  private titled(sources: readonly ResumeSource[]): readonly ResumeSource[] {
    // `exactOptionalPropertyTypes`: omit the key rather than pass `undefined`.
    return sources.map((source) => {
      const title = this.titleCache.get(source.header.id)
      return title === undefined ? source : { ...source, title }
    })
  }
}

/**
 * The ids one page covers: the rendered window plus a margin either side.
 *
 * The panel shows `RESUME_PANEL_MAX_VISIBLE` rows, so that slice is what the
 * cursor can reach without scrolling. The margin means a single arrow press does
 * not immediately need another network-ish read, and the cache makes coming back
 * free. Deliberately **not** every visible choice: the filter keeps sessions with
 * history, which can be the whole corpus, and reading all of them is the thing
 * that never finished.
 *
 * @param sources - the listing.
 * @param view - the open picker.
 * @param pageSize - rows the panel can show at once.
 * @returns ids to read titles for.
 */
function windowIds(
  sources: readonly ResumeSource[],
  view: ResumePickerView,
  pageSize: number,
): string[] {
  const visible = view.choices.map((choice) => choice.id)
  const margin = pageSize
  const from = Math.max(0, view.index - margin)
  const to = Math.min(visible.length, view.index + margin + 1)
  const ids = new Set(visible.slice(from, to))
  return sources.map((source) => source.header.id).filter((id) => ids.has(id))
}

/**
 * A human-readable message for an unknown throwable.
 *
 * @param error - whatever was thrown.
 * @returns its message, or its string form.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
