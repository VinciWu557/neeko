/**
 * `/resume` — the sessions a user can switch back into, as rows.
 *
 * ## Where the list comes from
 *
 * dsh keeps sessions in a filesystem-backed corpus and exposes it as
 * `ctx.sessionQuery.listSessions()`, which answers
 * {@linkcode SessionRecord}[`] = `{ header, live, persisted }` **newest-first**
 * (the ordering is the backend's, and re-sorting here would second-guess it).
 *
 * The header carries `id` / `createdAt` / `cwd` but **no title** — dsh folds
 * titles from the log, one `readTitle()` per session — so the readable label is
 * assembled here from (title, cwd, age) rather than assumed to exist.
 *
 * ## Why a projection and not a component
 *
 * The runner owns fetching (I/O, cancellation), the app owns the picker
 * (keys, mount), and this module owns only *what a row says*. That keeps the
 * whole thing assertable without a terminal, which is where the previous
 * rounds' defects hid.
 *
 * @module dsh-neeko/tui/resume-list
 */

/** The slice of dsh's `SessionRecord` this module reads. */
export interface ResumeSource {
  readonly header: {
    readonly id: string
    readonly createdAt: number
    readonly cwd?: string
  }
  /** Whether the id currently exists in the live store (i.e. this session). */
  readonly live: boolean
  /** Whether the persistence backend lists it — resumable across restarts. */
  readonly persisted: boolean
  /** Folded title, when the caller fetched one. */
  readonly title?: string
}

/** One session the picker offers. */
export interface ResumeChoice {
  readonly id: string
  /** The row's text, already formatted. */
  readonly text: string
  /** True for the session this TUI is attached to. */
  readonly current: boolean
  /**
   * Whether this session has any conversation to go back to.
   *
   * dsh folds a title from the first user message, so "no title" means "nobody
   * ever said anything here". Those entries are still resumable, but they are
   * noise: a machine that starts the TUI often accumulates them (every launch
   * that exits without a prompt), and they sort newest-first, so they bury the
   * sessions a user actually wants.
   */
  readonly hasHistory: boolean
}

/** Suffix marking the session in use. */
const CURRENT_MARKER = '[current]'

/**
 * A coarse age, the way pi's session list shows it.
 *
 * Exact timestamps are noise in a picker: what a user needs is "is this the one
 * from this morning or last month".
 *
 * @param createdAt - epoch ms.
 * @param now - the clock to measure against (injectable for tests).
 * @returns `now` / `5m` / `3h` / `2d`.
 */
export function relativeAge(createdAt: number, now: number): string {
  // Clamped at zero: a session created by a machine whose clock is slightly
  // ahead would otherwise read as a negative age.
  const elapsed = Math.max(0, now - createdAt)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * The last path segment of a cwd.
 *
 * The full path is unreadable in a single row and the distinguishing part is the
 * tail — the same reason transcript rows relativize paths.
 *
 * @param cwd - absolute working directory, or `undefined`.
 * @returns the basename, or `''`.
 */
function shortCwd(cwd: string | undefined): string {
  if (cwd === undefined) return ''
  const trimmed = cwd.replace(/[/\\]+$/, '')
  if (trimmed === '') return ''
  const parts = trimmed.split(/[/\\]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * Format one session as a single-line row.
 *
 * A title is not guaranteed (a session can be listed before any title event
 * exists), and an unidentified row cannot be picked, so the id's leading segment
 * is the fallback.
 *
 * @param source - the session record.
 * @param now - the clock, for the age.
 * @returns one line of text.
 */
export function resumeRowText(source: ResumeSource, now: number): string {
  const title = source.title === undefined || source.title.trim() === ''
    ? source.header.id.replace(/^session-/, '').slice(0, 8)
    : source.title
  const parts = [title.replace(/\s+/gu, ' ').trim()]
  const cwd = shortCwd(source.header.cwd)
  if (cwd !== '') parts.push(cwd)
  parts.push(relativeAge(source.header.createdAt, now))
  if (source.live) parts.push(CURRENT_MARKER)
  return parts.join(' · ')
}

/**
 * Project dsh's records onto picker rows.
 *
 * @param sources - records in the order the backend returned them.
 * @param now - the clock, for the ages.
 * @returns one choice per session; empty when the corpus is empty.
 */
export function toResumeChoices(sources: readonly ResumeSource[], now: number): ResumeChoice[] {
  return sources.map((source) => ({
    id: source.header.id,
    text: resumeRowText(source, now),
    current: source.live,
    hasHistory: source.title !== undefined && source.title.trim() !== '',
  }))
}

/**
 * Narrow the list to sessions worth showing.
 *
 * `includeEmpty` exists because an empty session is not useless — it may be the
 * one this TUI is attached to right now (a fresh launch with no prompt yet), and
 * hiding the current session from its own picker would be confusing. So the
 * current session always survives the filter.
 *
 * @param choices - every session, newest first.
 * @param includeEmpty - keep sessions that never had a conversation.
 * @returns the rows to show; never empty unless the input was.
 */
export function visibleResumeChoices(
  choices: readonly ResumeChoice[],
  includeEmpty: boolean,
): readonly ResumeChoice[] {
  if (includeEmpty) return choices
  // The attached session stays even when it has no conversation yet: hiding
  // "here" from its own picker reads as a bug. Everything else without a title
  // is filtered, and there is deliberately **no fallback to the unfiltered
  // list** — that fallback is what kept the panel full of empty sessions, since
  // the newest ten on a working machine are usually all fresh launches.
  return choices.filter((choice) => choice.hasHistory || choice.current)
}

/**
 * Where the cursor starts.
 *
 * The live session, so the most likely "not that one" case is visible at a
 * glance; the newest session otherwise (index 0, the backend's order).
 *
 * @param choices - the projected rows.
 * @returns the index to open the picker on.
 */
export function initialResumeIndex(choices: readonly ResumeChoice[]): number {
  const current = choices.findIndex((choice) => choice.current)
  return current < 0 ? 0 : current
}

/** One entry of dsh's batch title answer (`readTitleSnapshots`). */
export interface TitleObservation {
  readonly sessionId: string
  readonly status: 'fulfilled' | 'rejected'
  readonly value?: { readonly title?: { readonly title: string } }
}

/**
 * Turn a batch title answer into the `id → title` map the picker uses.
 *
 * Rejected entries and empty titles are simply absent: one unreadable session
 * must not cost the rest of the batch its titles, and a session without a title
 * is a session without history (the row falls back to its id).
 *
 * The batch call exists because the per-id path could not fold 60 ids inside two
 * seconds on a real profile — it shares one corpus observation across the whole
 * batch. That makes reading its shape correctly load-bearing, so it lives here
 * where it can be tested without a session service.
 *
 * @param results - the batch answer, in request order.
 * @returns titles keyed by session id; only non-empty fulfilled ones.
 */
export function titlesFromObservations(
  results: readonly TitleObservation[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    const title = result.value?.title?.title
    if (title === undefined || title === '') continue
    out[result.sessionId] = title
  }
  return out
}
