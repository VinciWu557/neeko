/**
 * Fullscreen mode: the alternate-screen viewport where clicking a row expands it.
 *
 * ## Why a mode, not a setting
 *
 * pi-tui's README states the constraint directly: `TuiMainScreen` "does not
 * capture mouse input because the terminal owns its scrollback". Reporting a
 * click is a protocol-level trade — once the terminal reports a click it stops
 * *acting* on it, so native selection, copy and the right-click menu are gone,
 * and no escape mode keeps both.
 *
 * `TuiAltScreen` is the supported answer: it owns the viewport, its own selection
 * and copy (OSC 52 by default), application scrolling, and hit-testing. Nothing
 * is lost on exit either — stopping an alt screen "restores the main buffer and
 * prints the complete final document", so the conversation still lands in the
 * terminal's scrollback.
 *
 * That makes fullscreen an opt-in `TUI` choice for the user, exactly where
 * click-to-expand belongs.
 *
 * @module dsh-neeko/tui/fullscreen
 */

import { ScrollView, TuiAltScreen, VStack, isViewportTUI } from '@earendil-works/pi-tui'
import type { Component, Terminal } from '@earendil-works/pi-tui'

/** What the fullscreen surface needs from the app. */
export interface FullscreenOptions {
  readonly terminal: Terminal
  /**
   * Everything that scrolls, as one component: the banner **and** the transcript.
   *
   * One container rather than `header` + `transcript` fields, because pi's own
   * viewport scrolls the whole document (`createChatViewport` wraps
   * `documentContainer` — header plus chat). Wrapping only the transcript leaves
   * the banner pinned, so scrolling moves the conversation under a stationary
   * header instead of scrolling the screen.
   */
  readonly document: Component
  /**
   * Rows docked between the scrolling document and the input.
   *
   * A single container on purpose: this list used to be enumerated field by
   * field (`notices`, then a panel slot…) and every panel added to `TuiApp`
   * afterwards was silently absent here — `/thinking` and `/theme` rendered
   * nothing in fullscreen while their keys still worked, because the panel was
   * mounted into the *main* screen's tree, which is stopped while the alt screen
   * owns the terminal. One slot cannot drift.
   */
  readonly aboveInput?: Component | undefined
  /** The editor, or whatever currently occupies the input slot. */
  readonly input: Component
  /** Status bar below the input. */
  readonly footer: Component
  /** Forwarded keys; the alt screen owns raw input while it is active. */
  readonly onInput: (data: string) => { consume?: boolean } | undefined
}

/** The mounted fullscreen surface. */
export interface Fullscreen {
  readonly screen: TuiAltScreen
  /** The scrolling region, for scroll-position questions. */
  readonly scroll: ScrollView
  /** Leave the alt screen; the final document is printed into scrollback. */
  dispose(): void
}

/**
 * Mount the alt-screen viewport.
 *
 * Layout mirrors pi's `createChatViewport`: a **grow** region holding the
 * scrolling document, then a dock of fixed rows (panels, editor, footer). The
 * document — banner included — is what scrolls, so the whole screen scrolls
 * rather than the conversation moving under a pinned header.
 *
 * `copyOnSelect` stays on and no `copySelection` is supplied, so pi-tui writes the
 * selection through OSC 52 — the terminal's own clipboard channel, which works
 * over SSH and needs no platform command.
 *
 * @param options - components to lay out and the key forwarder.
 * @returns the mounted surface.
 */
export function mountFullscreen(options: FullscreenOptions): Fullscreen {
  const { terminal, document, aboveInput, input, footer, onInput } = options
  const screen = new TuiAltScreen(terminal)
  const scroll = new ScrollView(document, {
    follow: 'end',
    primary: true,
    scrollbar: 'auto',
    overscroll: 'chain',
  })

  // Two entries, exactly as pi's `createChatViewport` builds them: the scroll
  // region grows into whatever the dock does not take, and the dock is **one**
  // `basis: "auto"` entry rather than a flat list.
  //
  // Flattening the dock into the root stack is not equivalent: each entry then
  // carries its own `minSize`, and on a short terminal those minimums compete
  // with the transcript's one row instead of with the dock's total. The dock also
  // keeps its own internal order, so adding a panel cannot reorder anything.
  const dock = new VStack([
    ...(aboveInput === undefined ? [] : [{ component: aboveInput, shrink: 1, minSize: 0 }]),
    { component: input, shrink: 1, minSize: 3 },
    { component: footer, shrink: 1, minSize: 0 },
  ])
  const children = [
    { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: 'auto' as const, grow: 0, shrink: 1, minSize: 1 },
  ]

  if (isViewportTUI(screen)) screen.setLayoutRoot(new VStack(children))
  screen.addInputListener((data) => onInput(data))
  screen.start()

  return {
    screen,
    scroll,
    dispose(): void {
      // `preserveScreen` on purpose — pi does the same when it quits from
      // fullscreen (`stopInteractiveTui`: `ui.stop({ preserveScreen: mode ===
      // 'fullscreen' })`).
      //
      // The alternative (`stop()` without it) is supposed to print the final
      // document back into scrollback, but with a `VStack` layout root it does
      // not: `afterTerminalStop()` calls `render(width)`, which delegates to
      // `layoutRoot.render()` — and a layout root that was never measured by
      // `renderLayoutFrame()` returns ONE line. Measured: 1 row (banner only)
      // instead of the conversation. Leaving the alt screen is the caller's job
      // here: `TuiApp.exitFullscreen()` restarts the main screen and repaints the
      // whole transcript into real scrollback, which is both correct and what
      // the user asked for.
      screen.stop({ preserveScreen: true })
    },
  }
}
