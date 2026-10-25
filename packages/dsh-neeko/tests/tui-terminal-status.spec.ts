import { describe, expect, it } from 'vitest'
import type { Terminal } from '@earendil-works/pi-tui'
import { TuiApp } from '../src/tui/app.ts'
import { suspendToBackground } from '../src/tui/suspend.ts'
import type { SuspendHooks } from '../src/tui/suspend.ts'
import { FakeTerminal } from './support/fake-terminal.ts'

/**
 * The terminal's own status channels: window title, system progress, and the
 * Program Status Protocol (OSC 7501).
 *
 * ## Why bother
 *
 * These are the three things a *terminal* can show that an in-window status line
 * cannot: the tab title, a spinner in the tab bar / taskbar (so a long turn is
 * visible from another window), and a one-line "this program is doing X" that the
 * terminal itself renders. pi uses all three; this build called none of them, so a
 * turn that takes two minutes looked idle the moment the user switched tabs.
 *
 * ## What these tests pin
 *
 * The **mapping** from agent lifecycle to terminal state, not the escape sequences
 * — `pi-tui` owns those, and asserting them would pin its implementation. What
 * matters here is that a pending approval reports `blocked` rather than `working`:
 * that is the difference between "busy, wait" and "it needs you".
 */

/** Record what the app asked the terminal to do. */
interface Recorded {
  titles: string[]
  progress: boolean[]
  statuses: string[]
}

/**
 * An app over a terminal that records the three channels.
 *
 * @param overrides - app options to override.
 * @returns the app, the recording, and a key driver.
 */
function makeApp(overrides: Record<string, unknown> = {}): {
  app: TuiApp
  recorded: Recorded
  press: (data: string) => unknown
} {
  const recorded: Recorded = { titles: [], progress: [], statuses: [] }
  // `Object.create`, not a spread: `FakeTerminal`'s methods live on its prototype,
  // so spreading the instance would copy the fields and lose every method.
  const base = new FakeTerminal({ columns: 80, rows: 24 })
  const terminal = Object.create(base) as Terminal
  // The three channels under test; everything else stays the fake's.
  terminal.setTitle = (title: string) => { recorded.titles.push(title) }
  terminal.setProgress = (active: boolean) => { recorded.progress.push(active) }
  terminal.setProgramStatus = (status) => { recorded.statuses.push(status.state) }
  const app = new TuiApp({
    getSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/work/project',
    getSessionId: () => 'session-abc',
    onSubmit: () => {},
    onExit: () => {},
    version: '1.2.3',
    statusFacts: () => ({ cwd: '/work/project' }),
    modelPicker: async () => ({ models: [], current: '' }),
    selectModel: () => {},
    terminal,
    ...overrides,
  } as never)
  const route = (app as unknown as { handleInput(d: string): unknown }).handleInput
  return { app, recorded, press: (data) => route.call(app, data) }
}

describe('the window title names the session', () => {
  it('is set on start', () => {
    const { app, recorded } = makeApp()
    app.start()
    expect(recorded.titles.length).toBeGreaterThan(0)
  })

  it('names the cwd, so two windows are distinguishable', () => {
    // A title of just "dsh-neeko" makes every window look the same in a tab bar.
    const { app, recorded } = makeApp()
    app.start()
    expect(recorded.titles.join('\n')).toContain('project')
  })

  it('names the session, so two sessions in one directory differ', () => {
    const { app, recorded } = makeApp()
    app.start()
    expect(recorded.titles.join('\n')).toContain('session-abc')
  })
})

describe('the system progress indicator follows the turn', () => {
  it('is off before anything runs', () => {
    const { app, recorded } = makeApp()
    app.start()
    expect(recorded.progress.at(-1) ?? false).toBe(false)
  })

  it('turns on while working and off when the turn ends', () => {
    // This is what makes a long turn visible from another window.
    const { app, recorded } = makeApp()
    app.start()
    app.setWorking({ state: 'working', message: 'working…' })
    expect(recorded.progress.at(-1)).toBe(true)
    app.setWorking({ state: 'idle' })
    expect(recorded.progress.at(-1)).toBe(false)
  })
})

describe('the program status reports what the agent is waiting on', () => {
  it('reports idle at rest', () => {
    // pi's own `restingStatus` starts at `idle` and returns to it when a run
    // settles without an error, so this build does the same. (`clear` exists in the
    // protocol for a program that wants to disappear entirely; a TUI the user is
    // sitting in front of is still there, and `idle` says so.)
    const { app, recorded } = makeApp()
    app.start()
    expect(recorded.statuses.at(-1)).toBe('idle')
  })

  it('reports working during a turn', () => {
    const { app, recorded } = makeApp()
    app.start()
    app.setWorking({ state: 'working', message: 'working…' })
    expect(recorded.statuses.at(-1)).toBe('working')
  })

  it('reports blocked while an approval is pending', () => {
    // The one distinction that matters: `working` means "busy, wait", `blocked`
    // means "it needs you". A terminal that shows the second one brings the user
    // back; a spinner does not.
    const { app, recorded } = makeApp()
    app.start()
    void app.interactions.approve({ toolName: 'bash' } as never)
    expect(recorded.statuses.at(-1)).toBe('blocked')
    app.interactions.cancelByUser()
  })

  it('returns to idle after the approval settles', async () => {
    const { app, recorded } = makeApp()
    app.start()
    const pending = app.interactions.approve({ toolName: 'bash' } as never)
    app.interactions.allowApproval()
    await pending
    expect(recorded.statuses.at(-1)).toBe('idle')
  })
})

describe('the run outcome reaches the terminal through the app', () => {
  /**
   * The chain has three links: the runner calls `app.reportSessionEvent`, the app
   * forwards to `applySessionEvent`, the reporter derives. Testing only the middle
   * link leaves the end that can silently stop forwarding — measured: deleting the
   * forward from the app changed no test, because every assertion started one link
   * further in.
   */
  it('forwards turn/end to the terminal status', () => {
    const { app, recorded } = makeApp()
    app.start()
    app.reportSessionEvent({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'connection reset' } } },
    })
    expect(recorded.statuses.at(-1)).toBe('error')
  })

  it('leaves the status alone for an event that carries no outcome', () => {
    const { app, recorded } = makeApp()
    app.start()
    const before = recorded.statuses.length
    app.reportSessionEvent({ type: 'tool/call', data: {} })
    expect(recorded.statuses.length).toBe(before)
  })
})

// eslint-disable-next-line prefer-const -- assigned inside onceSignal below
let onResume: (() => void) | undefined
function hooks(overrides: Partial<SuspendHooks> = {}): {
  calls: { pid: number; signal: string }[]
  notices: string[]
  stopped: boolean[]
  signals: string[]
  intervals: { created: number; cancelled: number[] }
  resume: () => void
} {
  const calls: { pid: number; signal: string }[] = []
  const notices: string[] = []
  const stopped: boolean[] = []
  const signals: string[] = []
  const intervals = { created: 0, cancelled: [] as number[] }
  onResume = undefined
  suspendToBackground({
    platform: 'darwin',
    stopRendering: () => { stopped.push(false) },
    startRendering: () => { stopped.push(true) },
    requestRender: () => {},
    notify: (message) => { notices.push(message) },
    signals: {
      kill: (pid, signal) => { calls.push({ pid, signal }); return true },
      on: (signal) => { signals.push(`on:${signal}`) },
      once: (signal, listener) => { signals.push(`once:${signal}`); onResume = listener },
      removeListener: (signal) => { signals.push(`off:${signal}`) },
      keepAlive: () => {
        intervals.created += 1
        const id = intervals.created
        return { cancel: () => { intervals.cancelled.push(id) } }
      },
    },
    ...overrides,
  })
  return { calls, notices, stopped, signals, intervals, resume: () => onResume?.() }
}

describe('suspending to the background', () => {
  /**
   * `app.suspend` (`ctrl+z`) is the one action that cannot be unit-tested end to
   * end: whether a process actually stops is the kernel's decision, and Node has
   * already made it impossible for a process to stop *itself* — `process.kill` with
   * `SIGTSTP` only invokes handlers, it never suspends (measured: a bare Node
   * process in a pty keeps running through its own `SIGTSTP`, with and without raw
   * mode). What makes it work in practice is the terminal's own job control: the
   * key arrives as `\x1a`, the app signals its **process group**, and the parent
   * shell notices the stop.
   *
   * That was verified for real in a shell-backed pty: `[1]+ Stopped dsh --profile
   * neeko --tui` followed by the prompt. These tests pin the two decisions that make
   * that possible and that a refactor could silently break.
   */
  /** Hooks that record instead of touching the process. */

  it('signals the process group, not its own pid', () => {
    // `0` is the group. A process signalling *itself* with `SIGTSTP` is exactly the
    // case Node turns into a no-op — measured with a bare Node script in a pty, with
    // and without raw mode: it keeps running either way. The group is also what the
    // parent shell's job control watches, which is what produces `[1]+ Stopped`.
    const { calls } = hooks()
    expect(calls).toEqual([{ pid: 0, signal: 'SIGTSTP' }])
  })

  it('stops rendering before signalling', () => {
    // A stopped process cannot answer the terminal, so the screen must be handed back
    // to normal mode first or the shell prompt lands on a half-drawn frame.
    const { stopped } = hooks()
    expect(stopped).toEqual([false])
  })

  it('keeps the loop alive and ignores ctrl+c while stopped', () => {
    // Without a ref'd handle Node can exit on `fg` before `SIGCONT` restores the
    // terminal; without ignoring `SIGINT`, ctrl+c at the shell kills the job.
    const { signals, intervals } = hooks()
    // A timer must actually be created — asserting only that the signal handlers are
    // registered passed even when the keep-alive was deleted, because the handler
    // still ran and simply had nothing to clear.
    expect(intervals.created).toBe(1)
    expect(signals).toContain('on:SIGINT')
    expect(signals).toContain('once:SIGCONT')
  })

  it('clears the keep-alive and the ctrl+c handler on resume', () => {
    // Both exist only for the duration of the stop; leaking either means a timer
    // that never fires again but keeps the process alive, and a ctrl+c that stays
    // ignored after the user is back.
    const { signals, intervals, resume } = hooks()
    resume()
    expect(intervals.cancelled).toEqual([intervals.created])
    expect(signals).toContain('off:SIGINT')
  })

  it('refuses on Windows instead of pretending', () => {
    // Windows terminals have no Unix job control. A keystroke that appears to work
    // and leaves the screen unchanged is worse than one that explains itself.
    const { calls, notices } = hooks({ platform: 'win32' })
    expect(notices.join('\n')).toMatch(/Windows/u)
    // No signal at all: pretending to suspend would blank nothing and confuse more.
    expect(calls).toEqual([])
  })
})

describe('a failed suspend leaves nothing behind', () => {
  /**
   * When `kill` throws, the suspend never happened — so the keep-alive timer and the
   * `SIGINT` listener must be removed, and the `SIGCONT` listener must **not** stay
   * armed. A stale `SIGCONT` listener would call `startRendering()` on a signal that
   * was never going to arrive to resume what was never stopped, and a later real
   * suspend would then resume twice.
   *
   * The first version cleaned up the timer and `SIGINT` but left `SIGCONT` attached.
   */
  it('removes the SIGCONT listener when the signal cannot be sent', () => {
    const cancelled: number[] = []
    const registered = new Set<string>()
    let resumed: (() => void) | undefined
    let starts = 0
    suspendToBackground({
      platform: 'darwin',
      stopRendering: () => {},
      startRendering: () => { starts += 1 },
      requestRender: () => {},
      notify: () => {},
      signals: {
        kill: () => { throw new Error('EPERM') },
        on: (signal) => { registered.add(`on:${signal}`) },
        once: (signal, listener) => { registered.add(`once:${signal}`); resumed = listener },
        removeListener: (signal) => { registered.delete(`on:${signal}`); registered.delete(`once:${signal}`) },
        keepAlive: () => {
          const id = cancelled.length + 1
          return { cancel: () => { cancelled.push(id) } }
        },
      },
    })
    expect(cancelled).toEqual([1]) // the timer was released
    expect(registered.has('on:SIGINT')).toBe(false) // ctrl+c is honoured again
    // A stale SIGCONT listener must be gone: firing it would resume a TUI that never
    // stopped, and would double-resume on the next real suspend. Asserted on the
    // registry rather than by invoking the captured listener — the capture still
    // references the function after it is removed, so invoking it proves nothing.
    expect(registered.has('once:SIGCONT')).toBe(false)
    expect(starts).toBe(0)
  })
})
