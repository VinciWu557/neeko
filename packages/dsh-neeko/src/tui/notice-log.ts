/**
 * The notices area: durable replies, and one status line that clears itself.
 *
 * ## Why this is its own module
 *
 * Two things live here that nothing else in the app owns:
 *
 * 1. **A bound.** Notices are user-triggerable without limit — `/help` alone
 *    appends eight lines per press — and every child participates in every
 *    repaint, so an unbounded list grows memory and per-frame cost for the whole
 *    session. The oldest child is dropped past {@linkcode DEFAULT_MAX}.
 * 2. **A lifetime.** One line reports the outcome of one action and expires. It
 *    is *reused* rather than re-appended, because a `ctrl+o` pressed while
 *    reading output would otherwise leave a stack of stale `transcript:
 *    expanded` lines above the prompt forever. pi keeps exactly one status line
 *    for the same reason; the expiry is the other half — a slot that is never
 *    cleared stops being a status and becomes history.
 *
 * Both were previously fields on `TuiApp` (`notices`, `statusLine`,
 * `statusTimer`) reached from a dozen call sites. They are a coherent concern
 * with their own invariant, which is what makes them a module.
 *
 * ## What it deliberately does not do
 *
 * It does not paint. `paint` and the components it appends are supplied by the
 * caller, so this has no dependency on a theme or a terminal and can be tested
 * with fake timers — the same split `ThemeController` and `ResumeController` use.
 *
 * @module dsh-neeko/tui/notice-log
 */

import { Container } from '@earendil-works/pi-tui'
import type { Component } from '@earendil-works/pi-tui'
import { Text } from '@earendil-works/pi-tui'

/**
 * Notices kept before the oldest is dropped.
 *
 * Sized for a session, not for a screen: a long run appends hundreds of lines and
 * only the recent ones are still interesting, but nothing the user just printed
 * should vanish underneath them.
 */
const DEFAULT_MAX = 64

/** How long a status line stays before clearing itself. */
const DEFAULT_STATUS_MS = 3_000

/** Tokens a durable notice can be painted with. */
type NoticeTone = 'text' | 'dim' | 'muted' | 'error'

interface NoticeLogOptions {
  /** Maximum children kept; defaults to {@linkcode DEFAULT_MAX}. */
  readonly max?: number
  /** Status-line lifetime in ms; defaults to {@linkcode DEFAULT_STATUS_MS}. */
  readonly statusMs?: number
  /** Paints one theme token. */
  readonly paint: (token: NoticeTone, text: string) => string
  /** Fired after every visible change, so the owner can repaint. */
  readonly onChange: () => void
}

/** Durable replies and the transient status line. */
export class NoticeLog {
  /** The container to mount; its children are what renders. */
  readonly container = new Container()
  private readonly max: number
  private readonly statusMs: number
  private readonly paint: (token: NoticeTone, text: string) => string
  private readonly onChange: () => void
  private statusLine: Text | undefined
  private statusTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: NoticeLogOptions) {
    this.max = options.max ?? DEFAULT_MAX
    this.statusMs = options.statusMs ?? DEFAULT_STATUS_MS
    this.paint = options.paint
    this.onChange = options.onChange
  }

  /**
   * Append one component, dropping the oldest past the bound.
   *
   * @param component - the child to mount.
   */
  add(component: Component): void {
    this.container.addChild(component)
    while (this.container.children.length > this.max) {
      const oldest = this.container.children[0]
      if (oldest === undefined) break
      this.container.removeChild(oldest)
    }
    this.onChange()
  }

  /**
   * Append one durable themed line.
   *
   * Durable on purpose: it stays until {@linkcode clear}, or until the bound
   * drops it. An expiring *error* would hide the reason a command failed.
   *
   * @param text - the message body.
   * @param tone - the token to paint it with.
   */
  notice(text: string, tone: NoticeTone = 'text'): void {
    this.add(new Text(this.paint(tone, text)))
  }

  /**
   * Report the state of one action on the single self-clearing line.
   *
   * The slot is reused while it is still mounted. It can be unmounted two ways —
   * {@linkcode clear}, and {@linkcode add}'s bound, which drops the oldest child
   * (and a line that has been sitting there is often the oldest). Updating an
   * unmounted component is a `setText()` nobody can see, so the pointer is
   * re-validated every call rather than trusted.
   *
   * @param text - the message body.
   */
  status(text: string): void {
    const mounted = this.statusLine !== undefined && this.container.children.includes(this.statusLine)
      ? this.statusLine
      : undefined
    if (mounted !== undefined) {
      mounted.setText(this.paint('muted', text))
    } else {
      // `paddingY: 0` on purpose: a status line sits among the notices and must
      // not push the prompt two rows down on every call.
      this.statusLine = new Text(this.paint('muted', text), 1, 0)
      this.container.addChild(this.statusLine)
      // Added directly rather than through `add()`: a transient line must not be
      // able to trigger the bound trim on the way in, or reporting one action
      // could evict the content the user was reading.
    }
    // One countdown, restarted by every call: the last action is the one worth
    // seeing, and its window starts when it happened.
    if (this.statusTimer !== undefined) clearTimeout(this.statusTimer)
    this.statusTimer = setTimeout(() => { this.clearStatus() }, this.statusMs)
    this.onChange()
  }

  /** Hide the status line and drop it from the container. */
  clearStatus(): void {
    if (this.statusTimer !== undefined) {
      clearTimeout(this.statusTimer)
      this.statusTimer = undefined
    }
    const line = this.statusLine
    this.statusLine = undefined
    if (line === undefined) return
    line.setText('')
    this.container.removeChild(line)
    this.onChange()
  }

  /**
   * Drop every notice, status line included.
   *
   * The status pointer goes with them: leaving it behind would make the next
   * {@linkcode status} call `setText()` on an unmounted component.
   */
  clear(): void {
    this.clearStatus()
    this.container.clear()
    this.onChange()
  }
}
