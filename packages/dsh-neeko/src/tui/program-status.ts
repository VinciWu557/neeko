/**
 * The terminal's own status channels: window title, tab spinner, and the Program
 * Status Protocol (OSC 7501).
 *
 * ## Why one object owns all three
 *
 * These are the things a *terminal* can show that an in-window status line cannot:
 * the tab title, a spinner the tab bar draws (so a two-minute turn is visible from
 * another window), and a one-line "this program is doing X" the terminal renders
 * itself. All three answer the same question — what is this program doing — so all
 * three must be derived from one model. Writing them from two places is how they
 * come to disagree.
 *
 * ## The model, and why it is a derivation
 *
 * Copied from pi's `ProgramStatusReporter`. Two inputs:
 *
 * | input | meaning |
 * | --- | --- |
 * | {@linkcode setRunState} | the agent is running, or settled with an outcome |
 * | {@linkcode setBlocked} | dialogs waiting for the user, keyed by source |
 *
 * The reported status is a **function of those two** on every call, never a
 * mutation of the previous status. "Blocked beats working" and "settling restores
 * whatever the run ended as" then fall out of the code instead of being maintained
 * in parallel with it.
 *
 * The previous shape had `setWorking()` and `syncBlockedStatus()` each computing
 * *and* writing `setProgress`/`setProgramStatus`. They disagreed: the blocked path
 * wrote `blocked || working`, so a run that settled while a dialog was open left the
 * spinner turning. The same defect class had already cost this repo one refactor
 * (three parallel selector flags → one `PanelHost`), so it is not worth a second.
 *
 * ## Blocked is keyed, not a boolean
 *
 * A question asked while an approval is pending is the newer thing on screen, and
 * closing it must reveal the approval again rather than clearing the state. A
 * `Map` in insertion order gives "most recent wins" and "removing one reveals the
 * previous" without any extra bookkeeping — pi's own choice.
 *
 * @module dsh-neeko/tui/program-status
 */

import type { ProgramStatus } from '@earendil-works/pi-tui'
import { turnEndFailure } from '../dsh-adapter.ts'

/** How this program names itself in the Program Status Protocol. */
const APP_NAME = 'dsh-neeko'

/**
 * What the agent is doing, as the terminal needs to know it.
 *
 * `done` and `error` are separate because they are separate facts: a terminal that
 * reports `done` for a failed turn tells the user the opposite of the truth, and
 * `error` is the one status worth leaving on screen until the next run.
 */
export type RunState =
  | { readonly state: 'idle' }
  | { readonly state: 'working'; readonly message?: string }
  | { readonly state: 'done' }
  | { readonly state: 'error'; readonly message?: string }

/** A dialog holding the run, as reported to the terminal. */
export interface BlockedDialog {
  readonly kind?: 'permission' | 'question'
  readonly message?: string
}

/**
 * The terminal capabilities this module uses.
 *
 * Narrower than `Terminal` on purpose: a fake for these three methods is a few
 * lines, and nothing here can accidentally start driving the real renderer.
 */
export interface StatusTerminal {
  setTitle(title: string): void
  setProgress(active: boolean): void
  setProgramStatus(status: ProgramStatus): void
}

/** The cwd basename and session id the window title is built from. */
export interface SessionIdentity {
  readonly directory: string
  readonly sessionId: string
}

/**
 * Derive and publish the terminal's status channels.
 *
 * One instance per app; every input is a setter, and every setter ends in the same
 * {@linkcode ProgramStatusReporter.report}.
 */
export class ProgramStatusReporter {
  private runState: RunState = { state: 'idle' }
  /** Open dialogs in the order they opened; the last one is what the user sees. */
  private readonly blocked = new Map<string, BlockedDialog>()
  /** Last status actually sent, so an unchanged derivation costs nothing. */
  private lastStatus: string | undefined
  /** Last spinner state actually sent. Tracked separately: see {@linkcode report}. */
  private lastProgress: boolean | undefined

  constructor(private readonly terminal: StatusTerminal) {}

  /**
   * Record what the run is doing.
   *
   * @param state - the run state just observed.
   */
  setRunState(state: RunState): void {
    this.runState = state
    this.report()
  }

  /**
   * Record or clear one dialog.
   *
   * Reopening a source replaces it rather than duplicating it, which is what a
   * re-asked question does.
   *
   * @param source - a stable key, e.g. `'approval'` or `'question'`.
   * @param dialog - the dialog, or `undefined` to clear that source.
   */
  setBlocked(source: string, dialog: BlockedDialog | undefined): void {
    // Delete first: `Map.set` keeps the original insertion position, so replacing a
    // source without deleting would leave it looking older than a dialog opened
    // after it.
    this.blocked.delete(source)
    if (dialog !== undefined) this.blocked.set(source, dialog)
    this.report()
  }

  /**
   * Clear one dialog.
   *
   * A named method rather than `setBlocked(source, undefined)` so a call site reads
   * as what it is. Closing reveals whatever was open before it, because the map's
   * order is preserved.
   *
   * @param source - the key passed to {@linkcode setBlocked}.
   */
  clearBlocked(source: string): void {
    if (!this.blocked.delete(source)) return
    this.report()
  }

  /**
   * Forget the previous session's state.
   *
   * `/resume` switches sessions, and a leftover `error` from the previous one would
   * describe a run that no longer exists.
   */
  reset(): void {
    this.runState = { state: 'idle' }
    this.blocked.clear()
    // Drop the dedup caches: they record what the **terminal** was last told, and a
    // session switch is exactly the case where that belief no longer holds. Without
    // this, a fresh session whose status matches the departed one sends nothing and
    // the terminal keeps describing a session that is gone.
    this.lastStatus = undefined
    this.lastProgress = undefined
    this.report()
  }

  /**
   * Name the window after the session.
   *
   * The directory separates two projects; the session id separates two sessions in
   * one project. Both are needed — a title of just `dsh-neeko` made every window
   * identical in a tab bar.
   *
   * @param session - the cwd basename and session id.
   */
  setSession(session: SessionIdentity): void {
    if (session.sessionId === '') {
      this.terminal.setTitle(session.directory)
      return
    }
    this.terminal.setTitle(`${session.directory} — ${session.sessionId}`)
  }

  /**
   * Derive the status from the current inputs and publish it.
   *
   * Public because the terminal can lose its status — a restart re-queries support
   * for OSC 7501 — so the app needs a way to re-assert the current one without
   * changing anything.
   */
  report(): void {
    const status = this.currentStatus()
    // Dedup both channels: a keystroke-level reporter would otherwise write an escape
    // sequence per keystroke to a terminal that already knows.
    //
    // The spinner needs its own guard rather than sharing the status's. It is not
    // idempotent — `Terminal.setProgress(false)` writes the clear sequence *and*
    // stops a timer, `true` writes the active sequence *and* arms one — so calling it
    // unconditionally was a write per report. Measured: four reports of an unchanged
    // state produced four writes.
    const key = JSON.stringify(status)
    if (key !== this.lastStatus) {
      this.lastStatus = key
      this.terminal.setProgramStatus(status)
    }
    // The spinner means "this program is busy", so it follows the **run**, not the
    // reported status: a turn that settled while a dialog was still open is not busy
    // any more, and leaving the tab spinner turning would say otherwise. `blocked`
    // is the dialog's news, carried by OSC 7501 where the terminal can act on it.
    const spinning = this.runState.state === 'working'
    if (spinning !== this.lastProgress) {
      this.lastProgress = spinning
      this.terminal.setProgress(spinning)
    }
  }

  /**
   * The status implied by the current inputs.
   *
   * Precedence: a waiting dialog wins over the run, because the user is the one who
   * has to act.
   *
   * @returns the status to send.
   */
  private currentStatus(): ProgramStatus {
    const dialog = [...this.blocked.values()].at(-1)
    if (dialog !== undefined) {
      return {
        state: 'blocked',
        app: APP_NAME,
        kind: dialog.kind ?? 'permission',
        ...(dialog.message === undefined ? {} : { message: dialog.message }),
      }
    }
    const { state } = this.runState
    const message = 'message' in this.runState ? this.runState.message : undefined
    return message === undefined
      ? { state, app: APP_NAME }
      : { state, app: APP_NAME, message }
  }
}

/**
 * The run state implied by a turn's end reason.
 *
 * This is the only place `done` and `error` come from. `runStateOfStatus` answers
 * `running`/`idle` — whether work is in flight *now* — which cannot distinguish a
 * turn that finished from one that failed: both are "not running".
 *
 * The wording is **not** re-derived here. `turnEndFailure()` already turns the same
 * reason into the transcript's failure row, and two descriptions of one failure are
 * two things to keep in sync. The `Error: ` prefix is stripped because the terminal
 * status already says it is an error; the message is the detail.
 *
 * @param reason - the `turn/end` reason, in whatever shape the agent loop produced.
 * @returns the run state to report.
 */
export function runStateOfTurnEnd(reason: unknown): RunState {
  if (typeof reason === 'object' && reason !== null && (reason as { kind?: unknown }).kind === 'aborted') {
    // The user stopped the turn. Reporting `error` would put a failure in the
    // terminal for something they did on purpose.
    return { state: 'idle' }
  }
  const failure = turnEndFailure(reason)
  if (failure === undefined) return { state: 'done' }
  // One line: the status channel is a single line, and a provider message can carry
  // newlines. Only the first line is the headline.
  const first = failure.replace(/^Error: /u, '').split('\n', 1)[0] ?? failure
  return { state: 'error', message: first }
}

/**
 * The run state implied by a session event, or `undefined` when it carries none.
 *
 * A pure function rather than an `if` inside the runner's subscription: measured,
 * deleting that `if` changed no test, because `runner.ts` is end-to-end glue over a
 * live agent and nothing can reach the line to notice. Here it is reachable, and the
 * subscription becomes one call that cannot be wrong in an interesting way.
 *
 * @param event - one session event.
 * @returns the state to report, or `undefined` to leave the current one alone.
 */
export function runStateOfEvent(event: { type: string; data?: unknown }): RunState | undefined {
  if (event.type !== 'turn/end') return undefined
  const reason = (event.data as { reason?: unknown } | undefined)?.reason
  return runStateOfTurnEnd(reason)
}

/**
 * Apply one session event to the reporter.
 *
 * The runner's subscription is a single call to this, which is the point: an `if`
 * inside `runEvent` could be deleted with **no test going red** (measured) because
 * `runner.ts` is end-to-end glue over a live agent and nothing reaches it. Here the
 * "report only when the event carries an outcome" rule is testable, and the
 * subscription has no logic left to get wrong.
 *
 * @param reporter - the terminal status reporter.
 * @param event - one session event.
 * @returns whether the reporter was told anything new.
 */
export function applySessionEvent(
  reporter: ProgramStatusReporter,
  event: { type: string; data?: unknown },
): boolean {
  const outcome = runStateOfEvent(event)
  if (outcome === undefined) return false
  reporter.setRunState(outcome)
  return true
}

/**
 * The run state implied by a DSH agent status.
 *
 * DSH reports `running` / `idle`; the richer outcomes (`done`, `error`) come from
 * the turn's own end reason, so they are set by the caller rather than derived here.
 *
 * @param status - the status the runner observed.
 * @returns the run state to report.
 */
export function runStateOfStatus(status: string): RunState {
  return status === 'running' ? { state: 'working' } : { state: 'idle' }
}
