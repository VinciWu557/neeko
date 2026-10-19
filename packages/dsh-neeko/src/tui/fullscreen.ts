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
  /** Banner rows above the transcript. */
  readonly header: Component
  /** The transcript container; it is the region that scrolls. */
  readonly transcript: Component
  /** Anything that must sit between transcript and input (pending prompt, notices). */
  readonly notices?: Component | undefined
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
 * Layout follows the README's shape: one `grow` region (the transcript) so the
 * input keeps its height, and `shrink: 0` on the fixed rows so a long
 * conversation never pushes the editor off screen. `basis`/`minSize` guard the
 * degenerate case of a very short terminal.
 *
 * `copyOnSelect` stays on and no `copySelection` is supplied, so pi-tui writes the
 * selection through OSC 52 — the terminal's own clipboard channel, which works
 * over SSH and needs no platform command.
 *
 * @param options - components to lay out and the key forwarder.
 * @returns the mounted surface.
 */
export function mountFullscreen(options: FullscreenOptions): Fullscreen {
  const { terminal, header, transcript, notices, input, footer, onInput } = options
  const screen = new TuiAltScreen(terminal)
  const scroll = new ScrollView(transcript, {
    follow: 'end',
    primary: true,
    scrollbar: 'auto',
    overscroll: 'chain',
  })

  const children = [
    { component: header, basis: 'auto' as const, shrink: 1, minSize: 1 },
    { component: scroll, basis: 0, grow: 1, minSize: 1 },
    ...(notices === undefined ? [] : [{ component: notices, basis: 'auto' as const, shrink: 1, minSize: 1 }]),
    { component: input, basis: 'auto' as const, shrink: 0, minSize: 1 },
    { component: footer, basis: 'auto' as const, shrink: 0, minSize: 1 },
  ]

  if (isViewportTUI(screen)) screen.setLayoutRoot(new VStack(children))
  screen.addInputListener((data) => onInput(data))
  screen.start()

  return {
    screen,
    scroll,
    dispose(): void {
      // `stop()` restores the main buffer *and* prints the final document, so the
      // conversation stays in the terminal's scrollback.
      screen.stop()
    },
  }
}
