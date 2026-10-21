import { describe, expect, it } from 'vitest'
import { ProgramStatusReporter } from '../src/tui/program-status.ts'
import type { ProgramStatus } from '@earendil-works/pi-tui'

/**
 * The terminal's status channels, derived from one model instead of written from
 * two places.
 *
 * ## Why this is a class with one output
 *
 * The previous shape had `setWorking()` and `syncBlockedStatus()` each computing
 * *and* writing `setProgress`/`setProgramStatus`. Two copies of "should the tab
 * spinner be on" is one copy too many: they disagreed — the blocked path forgot
 * that a `blocked` activity also means busy — and the same defect had already been
 * fixed once in this repo by collapsing three flags into one `PanelHost`.
 *
 * The model, copied from pi's `ProgramStatusReporter`:
 *
 * | input | meaning |
 * | --- | --- |
 * | run state | the agent is running / settled with an outcome |
 * | open blocks | dialogs waiting for the user, most recent wins |
 *
 * The rendered status is a **function of those two**, never a mutation of the last
 * one. That is what makes "blocked beats working" and "settling restores whatever
 * the run ended as" fall out instead of being maintained.
 *
 * ## What is asserted
 *
 * The derivation and the dedup — not the OSC bytes, which `pi-tui` owns.
 */

/** A reporter over a terminal that records both channels. */
function reporter(): {
  status: ProgramStatusReporter
  statuses: string[]
  sent: ProgramStatus[]
  progress: boolean[]
} {
  const statuses: string[] = []
  const sent: ProgramStatus[] = []
  const progress: boolean[] = []
  const status = new ProgramStatusReporter({
    setTitle: () => {},
    setProgress: (active) => { progress.push(active) },
    setProgramStatus: (value) => { statuses.push(value.state); sent.push(value) },
  })
  return { status, statuses, sent, progress }
}

describe('the reporter derives the status instead of being told it', () => {
  it('rests at idle before anything runs', () => {
    const { status, statuses } = reporter()
    status.report()
    expect(statuses).toEqual(['idle'])
  })

  it('reports working while a run is active', () => {
    const { status, statuses, progress } = reporter()
    status.setRunState({ state: 'working' })
    expect(statuses.at(-1)).toBe('working')
    expect(progress.at(-1)).toBe(true)
  })

  it('reports blocked while a dialog waits, even though the run is active', () => {
    // The distinction the whole feature exists for: `working` says "busy, wait",
    // `blocked` says "it needs you". A terminal only brings the user back for the
    // second one.
    const { status, statuses } = reporter()
    status.setRunState({ state: 'working' })
    status.setBlocked('approval', { kind: 'permission', message: 'run bash?' })
    expect(statuses.at(-1)).toBe('blocked')
  })

  it('reports the most recent dialog when several are open', () => {
    // A question asked while an approval is pending is the newer thing on screen, so
    // the terminal must show *that* one. Asserting only `state === 'blocked'` passed
    // even when the reporter picked the oldest — the message is the part that says
    // which dialog the user is actually being asked about.
    const { status, sent } = reporter()
    status.setBlocked('approval', { kind: 'permission', message: 'run bash?' })
    status.setBlocked('question', { kind: 'question', message: 'which file?' })
    expect(sent.at(-1)).toMatchObject({ state: 'blocked', message: 'which file?' })
    // Closing the newer one reveals the older, rather than clearing the state.
    status.clearBlocked('question')
    expect(sent.at(-1)).toMatchObject({ state: 'blocked', message: 'run bash?' })
  })

  it('replaces a re-opened dialog instead of stacking it', () => {
    // A re-asked question reuses its source key. Stacking copies would make the
    // terminal show a dialog that was already answered.
    const { status, sent } = reporter()
    status.setBlocked('question', { kind: 'question', message: 'first' })
    status.setBlocked('question', { kind: 'question', message: 'second' })
    status.clearBlocked('question')
    expect(sent.at(-1)?.state).not.toBe('blocked')
  })

  it('treats a re-opened source as the newest, not its original position', () => {
    // `Map.set` on an existing key keeps the original insertion order, so
    // re-opening a source without deleting it first would leave it looking older
    // than a dialog opened after it — and the terminal would show the wrong one.
    const { status, sent } = reporter()
    status.setBlocked('approval', { kind: 'permission', message: 'approval' })
    status.setBlocked('question', { kind: 'question', message: 'question' })
    status.setBlocked('approval', { kind: 'permission', message: 'approval again' })
    expect(sent.at(-1)).toMatchObject({ message: 'approval again' })
  })

  it('returns to the run state once the last dialog closes', () => {
    const { status, statuses } = reporter()
    status.setRunState({ state: 'working' })
    status.setBlocked('approval', { kind: 'permission' })
    status.clearBlocked('approval')
    expect(statuses.at(-1)).toBe('working')
  })

  it('reports the run outcome once it settles', () => {
    // `done` and `error` are different facts, and a terminal that says "done" for a
    // failed turn tells the user the opposite of the truth. Asserting the whole
    // record, because `error` collapsing into `done` passed a state-only check.
    const { status, sent } = reporter()
    status.setRunState({ state: 'working' })
    status.setRunState({ state: 'error', message: 'rate limited' })
    expect(sent.at(-1)).toMatchObject({ state: 'error', message: 'rate limited' })
  })

  it('reports done when a run simply finishes', () => {
    // The other side of the pair: a distinguished `error` is only meaningful if
    // `done` is reachable too.
    const { status, sent } = reporter()
    status.setRunState({ state: 'working' })
    status.setRunState({ state: 'done' })
    expect(sent.at(-1)).toMatchObject({ state: 'done' })
  })

  it('stops the spinner when the run settles, even after being blocked', () => {
    // The bug this replaces: the blocked path computed progress as
    // `blocked || working`, so a run that settled while a dialog was open left the
    // spinner turning forever.
    const { status, progress } = reporter()
    status.setRunState({ state: 'working' })
    status.setBlocked('approval', { kind: 'permission' })
    status.setRunState({ state: 'done' })
    expect(progress.at(-1)).toBe(false)
  })

  it('does not re-send an unchanged status', () => {
    // Every keystroke can report; an unconditional write means an escape sequence
    // per keystroke to a terminal that already knows.
    const { status, statuses } = reporter()
    status.setRunState({ state: 'working' })
    const before = statuses.length
    status.report()
    status.report()
    expect(statuses.length).toBe(before)
  })

  it('forgets the previous session on reset', () => {
    // `/resume` switches sessions; a leftover `error` from the one before would
    // describe a run that no longer exists.
    const { status, statuses } = reporter()
    status.setRunState({ state: 'error', message: 'boom' })
    status.reset()
    expect(statuses.at(-1)).toBe('idle')
  })
})

describe('the window title', () => {
  const titles = (name: string, id: string): string[] => {
    const seen: string[] = []
    const status = new ProgramStatusReporter({
      setTitle: (title) => { seen.push(title) },
      setProgress: () => {},
      setProgramStatus: () => {},
    })
    status.setSession({ directory: name, sessionId: id })
    return seen
  }

  it('names both the directory and the session', () => {
    // Two windows in one project must be distinguishable, so the id is not optional;
    // two projects must be distinguishable without reading the id, so both are there.
    const [title] = titles('project', 'abc')
    expect(title).toContain('project')
    expect(title).toContain('abc')
  })

  it('trails a separator only when there is a session id', () => {
    const [title] = titles('project', '')
    expect(title).toBe('project')
  })
})

describe('the turn outcome reaches the terminal', () => {
  /**
   * `error` was declared and never produced. The declaration shipped, the tests
   * covered only `working`/`idle`, and a mutation that turned `error` into `done`
   * passed until the assertion was tightened — because nothing ever *set* it.
   *
   * The real source is the turn's own end reason, which `transcript.ts` already
   * renders as a `failure` row via `turnEndFailure()`. The fact existed; it just
   * never reached the reporter. This is the mapping that closes that gap, asserted
   * against the adapter's own vocabulary rather than a copy of it.
   */
  it('maps a failed turn to error, carrying the first line of the message', async () => {
    const { runStateOfTurnEnd } = await import('../src/tui/program-status.ts')
    const { turnEndFailure } = await import('../src/dsh-adapter.ts')
    const reason = { kind: 'error', error: { message: 'rate limited\nretry later', code: 'RATE_LIMIT' } }
    const state = runStateOfTurnEnd(reason)
    expect(state.state).toBe('error')
    // The terminal shows one line; a multi-line provider message must not break it.
    expect(state).toMatchObject({ message: expect.stringContaining('rate limited') })
    expect((state as { message: string }).message).not.toContain('\n')
    // Same wording as the transcript's failure row, first line only: two
    // descriptions of one failure would be two things to keep in sync, and the
    // status channel is one line while the provider message was two.
    const rowText = turnEndFailure(reason)
    expect(rowText).toBeDefined()
    const rowFirstLine = rowText?.replace(/^Error: /u, '').split('\n', 1)[0]
    expect((state as { message: string }).message).toBe(rowFirstLine)
  })

  it('maps an aborted turn to idle rather than error', async () => {
    // The user pressed escape; the turn did not fail, it stopped. Reporting `error`
    // would put a red line in the terminal for something the user did on purpose.
    const { runStateOfTurnEnd } = await import('../src/tui/program-status.ts')
    expect(runStateOfTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }).state).toBe('idle')
  })

  it('maps a completed turn to done', async () => {
    const { runStateOfTurnEnd } = await import('../src/tui/program-status.ts')
    expect(runStateOfTurnEnd({ kind: 'completed' }).state).toBe('done')
    // A turn that ended for a reason this build does not model is still a normal end.
    expect(runStateOfTurnEnd(undefined).state).toBe('done')
  })
})

describe('run state from a session event', () => {
  /**
   * The runner subscribes to a stream of session events and must translate each one
   * into a run-state change — most events are irrelevant, `turn/end` is the one that
   * carries the outcome.
   *
   * That translation lives in a pure function rather than inline in the subscription
   * for one measured reason: when it was an `if` inside `runEvent`, deleting it
   * changed **no test**. `runner.ts` is end-to-end glue over a live agent, so nothing
   * could reach the line to notice. A pure function is reachable, and then the
   * subscription is one call that cannot be wrong in an interesting way.
   */
  it('ignores events that carry no outcome', async () => {
    const { runStateOfEvent } = await import('../src/tui/program-status.ts')
    expect(runStateOfEvent({ type: 'tool/call', data: {} })).toBeUndefined()
    expect(runStateOfEvent({ type: 'user/message', data: {} })).toBeUndefined()
  })

  it('derives the outcome from turn/end', async () => {
    const { runStateOfEvent } = await import('../src/tui/program-status.ts')
    const failed = runStateOfEvent({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'connection reset' } } },
    })
    expect(failed).toMatchObject({ state: 'error' })
    const finished = runStateOfEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(finished).toMatchObject({ state: 'done' })
  })
})

describe('applying a session event to the reporter', () => {
  /**
   * This is the last link in the chain and the one that was missing: `runStateOfEvent`
   * was correct and reachable, but the runner's subscription could stop calling it and
   * nothing would fail. `applySessionEvent` is what the runner calls, so it is what a
   * test can hold.
   */
  it('reports an outcome and says so', async () => {
    const { applySessionEvent } = await import('../src/tui/program-status.ts')
    const { status, sent } = reporter()
    const applied = applySessionEvent(status, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'boom' } } },
    })
    expect(applied).toBe(true)
    expect(sent.at(-1)).toMatchObject({ state: 'error' })
  })

  it('leaves the status alone for an event with no outcome', async () => {
    // A tool call is a state change for the transcript, not for the terminal's
    // status; re-reporting on it would be one escape sequence per tool.
    const { applySessionEvent } = await import('../src/tui/program-status.ts')
    const { status, sent } = reporter()
    status.setRunState({ state: 'working' })
    const before = sent.length
    const applied = applySessionEvent(status, { type: 'tool/call', data: {} })
    expect(applied).toBe(false)
    expect(sent.length).toBe(before)
  })
})

describe('the spinner is deduplicated like the status', () => {
  /**
   * `Terminal.setProgress` is **not** idempotent: `false` writes the clear sequence
   * and stops a timer, `true` writes the active sequence and arms one. So a
   * `report()` that calls it unconditionally writes an escape sequence on every
   * keystroke-level report — exactly what the status dedup was added to avoid, and
   * the spinner was left outside it.
   *
   * pi's own reporter has this shape too (`setProgramStatus` is deduped, `setProgress`
   * is called from `interactive-mode` only on the run's transitions), which is the
   * behaviour being restored here.
   */
  it('does not rewrite the spinner when the run state is unchanged', () => {
    const { status, progress } = reporter()
    status.setRunState({ state: 'working' })
    const writes = progress.length
    // A tool call, a status refresh, an interaction change — all re-report.
    status.report()
    status.report()
    status.report()
    expect(progress.length).toBe(writes)
  })

  it('still writes the spinner on a real transition', () => {
    // The other half: dedup must not swallow the transition it exists to allow.
    const { status, progress } = reporter()
    status.setRunState({ state: 'working' })
    status.setRunState({ state: 'done' })
    expect(progress.at(-1)).toBe(false)
    expect(progress.length).toBe(2)
  })
})

describe('reset re-asserts rather than trusting the cache', () => {
  /**
   * `reset()` exists because `/resume` switches sessions. If it left the dedup
   * caches alone, a session whose status happened to match the previous one would
   * send nothing — and the terminal would keep describing the session that is gone.
   * The caches are an optimisation over "what the terminal currently believes", so
   * anything that invalidates that belief must clear them.
   */
  it('re-sends the status even when it matches what was sent before', () => {
    // The exact case the caches would swallow: report `idle`, then reset (which is
    // also `idle`). Without clearing the caches nothing is sent, and a terminal that
    // has been handed to a new session keeps the old session's last line.
    const { status, sent, progress } = reporter()
    status.setRunState({ state: 'idle' })
    const before = sent.length
    status.reset()
    expect(sent.length).toBe(before + 1)
    expect(sent.at(-1)).toMatchObject({ state: 'idle' })
    expect(progress.at(-1)).toBe(false)
  })
})
