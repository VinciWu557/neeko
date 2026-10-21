/**
 * `ctrl+z` — suspend the process to the background.
 *
 * ## Why this is not just `process.kill(0, 'SIGTSTP')`
 *
 * Three things have to be true at once, and each was found by measurement:
 *
 * 1. **The signal must go to the process *group*** (`0`), not to `process.pid`.
 *    A process signalling itself with `SIGTSTP` is the one case Node turns into a
 *    no-op — verified with a bare Node script in a pty, with and without raw mode:
 *    the process keeps running, with or without a handler installed.
 * 2. **The event loop must stay alive while stopped.** Stopping the TUI can leave
 *    Node with no ref'd handle; the process then exits on `fg` before `SIGCONT` can
 *    restore the terminal.
 * 3. **`SIGINT` must be ignored while stopped,** or `ctrl+c` at the shell kills the
 *    backgrounded process instead of being handled after `fg`.
 *
 * The net effect, checked for real in a shell-backed pty: the shell prints
 * `[1]+ Stopped dsh --profile neeko --tui` and returns its prompt. Whether the
 * process *actually* stops is the kernel's decision and cannot be asserted from a
 * unit test, which is why this module exposes the two decisions that *can* be:
 * which pid receives the signal, and the Windows refusal.
 *
 * ## Windows
 *
 * There is no Unix job control, so pi shows a status message and does nothing. That
 * is the right call: a keystroke that appears to work and leaves the screen
 * unchanged is worse than one that explains itself.
 *
 * @module dsh-neeko/tui/suspend
 */

/**
 * The process primitives, grouped so a test can replace the set in one place.
 *
 * Grouped rather than spread across the top level: `stopRendering` and `notify` are
 * what the *app* provides, while these five are what the *OS* does. Mixing them in
 * one flat object made the call site read as a five-line ceremony of things it does
 * not own.
 */
export interface ProcessSignals {
  /** Send a signal. `pid: 0` addresses the process group. */
  kill(pid: number, signal: NodeJS.Signals): boolean
  /** Register a listener; returns nothing the caller needs. */
  on(signal: 'SIGINT', listener: () => void): unknown
  /** Register a listener that fires once. */
  once(signal: 'SIGCONT', listener: () => void): unknown
  /** Remove a listener registered with {@linkcode on}. */
  removeListener(signal: 'SIGINT' | 'SIGCONT', listener: () => void): unknown
  /** Long timer used only to keep the event loop alive. */
  keepAlive(delayMs: number): { cancel(): void }
}

/** The real process. */
const REAL_SIGNALS: ProcessSignals = {
  kill: (pid, signal) => process.kill(pid, signal),
  on: (signal, listener) => process.on(signal, listener),
  once: (signal, listener) => process.once(signal, listener),
  removeListener: (signal, listener) => process.removeListener(signal, listener),
  keepAlive: (delayMs) => {
    const handle = setInterval(() => {}, delayMs)
    return { cancel: () => { clearInterval(handle) } }
  },
}

/** The side effects, injected so both decisions are testable. */
export interface SuspendHooks {
  /** Stop drawing and restore the terminal to normal mode. */
  stopRendering(): void
  /** Resume drawing after `SIGCONT`. */
  startRendering(): void
  /** Repaint the frame the terminal lost while we were stopped. */
  requestRender(): void
  /** Report something to the user. */
  notify(message: string, level: 'error'): void
  /** The platform, so Windows can be refused. Defaults to `process.platform`. */
  platform?: string
  /** The process primitives. Defaults to the real process. */
  signals?: ProcessSignals
}

/**
 * How long the keep-alive interval waits.
 *
 * A single long timer, not a tick: this exists only to keep a ref'd handle alive,
 * so its period is irrelevant beyond being longer than any plausible suspension.
 */
const KEEP_ALIVE_MS = 2 ** 30

/**
 * Suspend to the background.
 *
 * Returns immediately on Windows (after reporting) — there is nothing to suspend.
 *
 * @param hooks - the side effects.
 */
export function suspendToBackground(hooks: SuspendHooks): void {
  if ((hooks.platform ?? process.platform) === 'win32') {
    hooks.notify('suspending is not available on Windows terminals', 'error')
    return
  }

  const signals = hooks.signals ?? REAL_SIGNALS
  // Keep the event loop alive: without a ref'd handle, stopping the TUI can leave
  // Node with nothing to wait on and the process exits on `fg` before `SIGCONT`.
  const keepAlive = signals.keepAlive(KEEP_ALIVE_MS)
  // `ctrl+c` at the shell must not kill the backgrounded process.
  const ignoreInterrupt = (): void => {}
  const onResume = (): void => {
    keepAlive.cancel()
    signals.removeListener('SIGINT', ignoreInterrupt)
    hooks.startRendering()
    hooks.requestRender()
  }
  signals.on('SIGINT', ignoreInterrupt)
  signals.once('SIGCONT', onResume)

  try {
    hooks.stopRendering()
    // `0` is the process **group**. Sending `SIGTSTP` to `process.pid` reaches only
    // this process, and Node turns a self-signal into a no-op; the group is also
    // what the parent shell's job control watches.
    signals.kill(0, 'SIGTSTP')
  } catch (error: unknown) {
    // Undo *everything*, including the `SIGCONT` listener. Leaving it armed would
    // resume a TUI that never stopped, and a later real suspend would then resume
    // twice — the second `start()` on a stopped screen.
    keepAlive.cancel()
    signals.removeListener('SIGINT', ignoreInterrupt)
    signals.removeListener('SIGCONT', onResume)
    hooks.notify(
      `could not suspend: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    )
  }
}
