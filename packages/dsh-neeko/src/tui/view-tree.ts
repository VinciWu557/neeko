/**
 * The widget tree: every container and text row the app mounts.
 *
 * ## Why this is a value, not fields on the app
 *
 * The tree has one shape and it never changes after construction, but it used to
 * be assembled inside a 113-line constructor mixed with controller wiring. That
 * made two different questions ("which subsystems exist" and "what is on screen")
 * answerable only by reading the same function, and it hid the fact that the tree
 * is a static structure:
 *
 * ```
 * document      ← what scrolls (banner, transcript, notices)
 * ├─ banner
 * ├─ messages     (rebuilt by every flush — see `row-cache.ts`)
 * └─ notices      (command replies; must be a separate container)
 * aboveInput    ← the dock: permanent rows, or one selector
 * inputSlot     ← the editor, or a panel standing in for it
 * status        ← the status bar
 * ```
 *
 * Grouping it here also gives {@linkcode dockRows} one definition, which is what
 * a selector needs to put the permanent rows back.
 *
 * ## What it is not
 *
 * Not a controller: it holds no behaviour beyond building the containers.
 * Mounting is `screen.ts`'s job and filling is the app's.
 *
 * @module dsh-neeko/tui/view-tree
 */

import { Container, Text } from '@earendil-works/pi-tui'
import type { Component } from '@earendil-works/pi-tui'
import { NoticeLog } from './notice-log.ts'
import type { Theme } from './theme.ts'

/** Everything the app mounts, by region. */
export interface ViewTree {
  /** The banner, repainted on a theme switch. */
  readonly banner: Container
  /** The transcript rows; `mountTranscript` replaces its children on every flush. */
  readonly messages: Container
  /**
   * What scrolls: banner + messages + notices.
   *
   * One component rather than three siblings, because pi's viewport scrolls the
   * *document* — three siblings would let a screen pin the banner and scroll only
   * the conversation underneath it.
   */
  readonly document: Container
  /** Command replies, which scroll with the conversation. */
  readonly noticeLog: NoticeLog
  /** The dock: permanent rows, or one selector. */
  readonly dock: Container
  /** The editor's place; a panel stands in for it here. */
  readonly inputSlot: Container
  /**
   * The approval/question panel.
   *
   * A row of its own, not a selector: it is driven by the interaction state
   * machine and can coexist with nothing else.
   */
  readonly interactionText: Text
  /**
   * The selectors' one-line slots.
   *
   * Named, not anonymous: each is written by its own subsystem (`/theme` repaints
   * the chrome, `/thinking` opens a panel). They are *not* where the selectors
   * render — those mount on the dock — these are the lines that report a result
   * after the selector closes. `/resume` has no line: its feedback is the
   * transcript itself, and it carried an unused `Text` until this was noticed.
   */
  readonly themeText: Text
  readonly thinkingText: Text
  /** The permanent dock rows in mount order, so a selector can put them back. */
  readonly dockRows: readonly Component[]
}

/** What {@linkcode buildViewTree} needs from the app. */
export interface ViewTreeOptions {
  /** Paints one theme token, for the notice log's status line. */
  readonly paint: (token: Parameters<Theme['fg']>[0], text: string) => string
  /** Called when the notice log's contents change. */
  readonly onChange: () => void
  /** Override the status line's lifetime (tests use a short one). */
  readonly statusNoticeMs?: number | undefined
}

/**
 * Build the widget tree.
 *
 * @param options - the two callbacks the notice log needs.
 * @returns the tree, with `document` already containing its three regions.
 */
export function buildViewTree(options: ViewTreeOptions): ViewTree {
  const banner = new Container()
  const messages = new Container()
  const document = new Container()
  document.addChild(banner)
  document.addChild(messages)
  // Local command replies scroll with the conversation, so they belong to the
  // document — *not* to the fixed rows above the editor.
  //
  // They were mounted in the dock until a `/compact` reply ("No compactable
  // history yet.") was found pinned under the transcript, never scrolling with the
  // conversation it answered. pi does not write command outcomes to a fixed area
  // either: `/compact` calls `session.compact()` and the result arrives as a chat
  // entry.
  //
  // A container of its own is still required: `mountTranscript` rebuilds
  // `messages` on every flush, so a reply written there would vanish on the next
  // repaint.
  const noticeLog = new NoticeLog({
    ...(options.statusNoticeMs === undefined ? {} : { statusMs: options.statusNoticeMs }),
    paint: options.paint,
    onChange: options.onChange,
  })
  document.addChild(noticeLog.container)

  const inputSlot = new Container()
  const dock = new Container()
  const interactionText = new Text('')
  const themeText = new Text('')
  const thinkingText = new Text('')
  return {
    banner,
    messages,
    document,
    noticeLog,
    dock,
    inputSlot,
    interactionText,
    themeText,
    thinkingText,
    // One list, in mount order, because a selector that clears the dock has to put
    // them back and the order is part of the layout.
    dockRows: [interactionText, themeText, thinkingText],
  }
}
