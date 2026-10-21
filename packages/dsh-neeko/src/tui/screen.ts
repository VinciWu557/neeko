/**
 * Which screen the TUI mounts, and the one place the default lives.
 *
 * ## The two screens
 *
 * `TuiMainScreen` appends to the terminal and never clears it — its own comment
 * says so ("First render - just output everything without clearing", see
 * `tui-main-screen.js`). Whatever was on screen before the TUI started therefore
 * stays visible above the UI, which is why starting there looks like a shell
 * command with an application printed underneath it rather than like an
 * application.
 *
 * `TuiAltScreen` enters with `?1049h` + `2J` + `H`, so its first frame is a clean
 * screen — but it has no scrollback, so the terminal draws no scrollbar for it.
 *
 * ## Why this is its own module
 *
 * The default used to be written **twice**: `runner.screenModeOf()` returned
 * `'main'` and `TuiApp.start()` wrote `screenMode ?? 'main'` again. Two copies of
 * a default do not disagree silently — but the moment one is edited they
 * disagree, and this package's own rule ("缺省值只在一个地方定义") was already
 * broken by them.
 *
 * So the decision moves here, in full. Every layer above reads
 * {@linkcode resolveScreen} and none of them supplies a value of its own:
 *
 * ```
 * startup          --main-screen / --fullscreen → screen (or no key at all)
 * cordis.patch.yml passes it through untouched
 * resolveScreen()  the ONE decision: config > env > default
 * TuiApp           executes the result, contributes no literal
 * ```
 *
 * ## Why the default is `main`
 *
 * The terminal owns scrolling: the transcript is appended to its scrollback, the
 * scrollbar is the terminal's own, and `PageUp` / the wheel / shift-selection all
 * behave the way they do in every other CLI. The alt screen has none of that — it
 * has no scrollback, so a terminal draws no scrollbar for it.
 *
 * This matches what pi actually runs, which is not what its source suggests:
 * `settings-defaults.js` ships `tuiMode: "fullscreen"`, but
 * `getTuiMode()` returns `"regular"` unless the stored value is literally
 * `"fullscreen"`, and a real profile pins `"tuiMode": "regular"`. Measured on a
 * pty: `pi` starts with no `?1049h`, and only `--tui-mode fullscreen` enters the
 * alt screen.
 *
 * The cost of `main` is that the alt screen is what clears the viewport on entry,
 * so the launching command stays visible above the banner. `TuiMainScreen` assumes
 * a clean screen and never clears. Clearing it here was tried and withdrawn: pi
 * does not do it (measured: zero `2J`, zero `3J` on startup), and the sequence
 * interferes with the renderer's own full-redraw path.
 *
 * @module dsh-neeko/tui/screen
 */

import {
  ScrollView,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  isViewportTUI,
} from '@earendil-works/pi-tui'
import type { Component, Terminal, TUI } from '@earendil-works/pi-tui'

/**
 * Which screen is mounted.
 *
 * Two values; "not stated" is `undefined` and is resolved by
 * {@linkcode resolveScreen} **before** anything mounts. Naming the two cases is
 * what makes the third one expressible — spelled as `mainScreen?: boolean`, the
 * absent value carried opposite meanings in different layers, which is how the
 * default became unreachable and the flag/env precedence inverted.
 */
export type ScreenMode = 'main' | 'fullscreen'

/**
 * The screen a run mounts when the user said nothing.
 *
 * Exported because it is the *single* definition: `resolveScreen` reads it, and
 * `TuiApp` executes that result without restating it. Tests assert this constant
 * rather than the literal, so changing the default is a one-line change every
 * layer follows.
 */
export const DEFAULT_SCREEN: ScreenMode = 'main'

/**
 * Decide the screen from what the user said.
 *
 * Precedence, most specific first: the resolved configuration, then the
 * consolidated environment variable, then the two legacy spellings.
 *
 * Both legacy variables keep meaning what they meant. When both are set the
 * conflict is a mistake in someone's shell profile, so it resolves the way the
 * flags resolve theirs: `main` wins, because it is the quieter screen (no alt
 * screen, no mouse reporting). Checking `MAIN_SCREEN` first *is* that rule — the
 * earlier code checked `FULLSCREEN` first, so its precedence was an accident of
 * implementation order.
 *
 * @param config - the resolved configuration; `screen` absent means "not stated".
 * @param env - environment to read; injected so the decision is testable without
 *   mutating the process's own variables.
 * @returns the screen to mount; never `undefined`.
 */
export function resolveScreen(
  config: { readonly screen?: ScreenMode | undefined },
  env: Readonly<Record<string, string | undefined>> = process.env,
): ScreenMode {
  if (config.screen !== undefined) return config.screen
  const selected = env['DSH_NEEKO_SCREEN']
  if (selected === 'main' || selected === 'fullscreen') return selected
  if (env['DSH_NEEKO_MAIN_SCREEN'] === '1') return 'main'
  if (env['DSH_NEEKO_FULLSCREEN'] === '1') return 'fullscreen'
  return DEFAULT_SCREEN
}

/**
 * Everything the screen needs, as one aggregate per region.
 *
 * Deliberately not an enumerated list of components: the defect that cost three
 * releases was "a panel was added to the app and forgotten here". An aggregate
 * cannot be forgotten — the app owns it, the screen receives it, and adding a
 * panel changes neither this type nor this module.
 */
export interface ScreenParts {
  /**
   * The whole scrolling document — banner, transcript, notices.
   *
   * One component, because pi's viewport scrolls the *document*
   * (`createChatViewport` wraps `documentContainer`). Wrapping only the
   * transcript leaves the banner pinned, so scrolling moves the conversation
   * under a stationary header instead of scrolling the screen.
   */
  readonly document: Component
  /**
   * Rows docked between the scrolling document and the input.
   *
   * A single container on purpose: this used to be enumerated field by field, and
   * every panel added to the app afterwards was silently absent in fullscreen
   * while its keys still worked. One slot cannot drift.
   */
  readonly aboveInput: Component
  /** The editor, or whatever currently occupies the input slot. */
  readonly input: Component
  /** Status bar below the input. */
  readonly footer: Component
  /** Forwarded keys; the mounted screen owns raw input while it is active. */
  readonly onInput: (data: string) => { consume?: boolean } | undefined
}

/**
 * The mounted surface.
 *
 * Generic in the renderer so a caller that needs alt-screen extras
 * (`getScreenLines`, `copyActiveSelectionToClipboard`) gets them from the type
 * instead of casting. The default mentions only what both screens have, which is
 * what keeps {@linkcode activeTui} screen-agnostic.
 */
export interface MountedScreen<T extends TUI = TUI> {
  /** The renderer actually driving the terminal. */
  readonly screen: T
  /**
   * The scrolling region, when the screen owns one.
   *
   * `undefined` on the main screen: the terminal owns the scrollback there, so an
   * application scrollbar would be a second scroll model that disagrees with the
   * first.
   */
  readonly scroll: ScrollView | undefined
  /** Enter raw mode and render. Mounting alone never touches the terminal. */
  start(): void
  /** Leave the screen. Always `preserveScreen`; see {@linkcode mountScreen}. */
  dispose(): void
}

/**
 * Mount the requested screen: build the tree, do not touch the terminal.
 *
 * **Mounting and starting are separate on purpose.** Mounting is composition —
 * which region goes where — and starting is raw mode plus the screen's entry
 * sequence (`?1049h` and a clear, for the alt screen). Keeping them apart is what
 * lets `TuiApp` paint the banner before any byte reaches the terminal, and it is
 * why a test can inspect a mounted tree without a TTY.
 *
 * The two shapes differ in exactly one thing — whether the regions are handed to
 * a layout — and that difference is expressed once, in the `if`.
 *
 * Overloaded per mode so the concrete renderer type survives: a caller that asks
 * for `fullscreen` can call `getScreenLines()` without a cast, and a caller that
 * does not care names `MountedScreen` and sees only the shared surface.
 *
 * @param terminal - the process terminal.
 * @param mode - the resolved screen; see {@linkcode resolveScreen}.
 * @param parts - the four regions plus the key forwarder.
 * @returns the mounted surface.
 */
export function mountScreen(
  terminal: Terminal,
  mode: 'main',
  parts: ScreenParts,
): MountedScreen<TuiMainScreen>
export function mountScreen(
  terminal: Terminal,
  mode: 'fullscreen',
  parts: ScreenParts,
): MountedScreen<TuiAltScreen>
export function mountScreen(
  terminal: Terminal,
  mode: ScreenMode,
  parts: ScreenParts,
): MountedScreen
export function mountScreen(
  terminal: Terminal,
  mode: ScreenMode,
  parts: ScreenParts,
): MountedScreen<TuiMainScreen> | MountedScreen<TuiAltScreen> {
  if (mode === 'main') return mountMain(terminal, parts)
  return mountAlt(terminal, parts)
}

/**
 * The terminal-owned screen: children go straight onto the renderer.
 *
 * No layout root and no `ScrollView`, because there is no viewport — the
 * terminal's own scrollback is the document. That is precisely why this screen
 * must not clear: `TuiMainScreen` appends, and appending to a screen still
 * showing the launching command is what the user sees.
 *
 * @param terminal - the process terminal.
 * @param parts - the four regions plus the key forwarder.
 * @returns the mounted surface.
 */
function mountMain(terminal: Terminal, parts: ScreenParts): MountedScreen<TuiMainScreen> {
  const tui = new TuiMainScreen(terminal)
  // Top-to-bottom, matching the alt screen's order so a component's visual
  // position does not depend on which screen is live.
  //
  // The document goes in whole — no window, no trimming — which is what pi's
  // `regular` mode does. Two earlier attempts to be cleverer both made the screen
  // worse, and both were measured:
  //
  // - A tail window (`rows - dock`) made the transcript a bounded viewport: rows
  //   past it were dropped, so scrolling up showed nothing that had been trimmed.
  // - Clearing the viewport on entry (`2J` + home) hid the launching command, but
  //   pi does not do it either (measured on a pty: zero `2J`, zero `3J`), and the
  //   clearing interacts badly with the renderer's own full-redraw path.
  //
  // The cost of going whole is that the renderer diffs more lines per frame. That
  // is pi's cost too, and it is the price of the terminal owning the scrollback.
  tui.addChild(parts.document)
  tui.addChild(parts.aboveInput)
  tui.addChild(parts.input)
  tui.addChild(parts.footer)
  tui.addInputListener((data) => parts.onInput(data))
  return {
    screen: tui,
    // `undefined` is the answer to "does this screen own a viewport": the
    // terminal owns the scrollback here, so no `ScrollView` exists and the app
    // keeps no scroll position. A separate boolean saying the same thing would
    // be a second source of truth for one fact.
    scroll: undefined,
    start: () => { tui.start() },
    // `preserveScreen` on both screens: the owner writes the final document
    // itself (see `TuiApp.stop`), so the renderer must not add a second copy.
    dispose: () => { tui.stop({ preserveScreen: true }) },
  }
}

/**
 * The viewport-owned screen: pi's `createChatViewport` layout.
 *
 * Two root entries, exactly as pi builds them: the scroll region grows into
 * whatever the dock does not take, and the dock is **one** `basis: "auto"`
 * entry rather than a flat list.
 *
 * Flattening the dock into the root stack is not equivalent: each entry then
 * carries its own `minSize`, and on a short terminal those minimums compete with
 * the transcript's single row instead of with the dock's total. Measured on a
 * 10-row terminal: flattened → the scroll region got 1 row, one dock entry → 6.
 *
 * @param terminal - the process terminal.
 * @param parts - the four regions plus the key forwarder.
 * @returns the mounted surface.
 */
function mountAlt(terminal: Terminal, parts: ScreenParts): MountedScreen<TuiAltScreen> {
  const screen = new TuiAltScreen(terminal)
  // pi's `createChatViewport`, entry for entry.
  //
  // The scroll region covers the **document only**; the editor, the pickers and
  // the footer are a fixed dock below it. So the composer stays put while the
  // conversation scrolls behind it — pi's behaviour, which is what this build
  // matches. An earlier round moved the composer *into* the scroll content so it
  // would follow the conversation; that is a different product decision, and it
  // left the input line off screen after a scroll-up with nothing to type into.
  const scroll = new ScrollView(parts.document, {
    follow: 'end',
    primary: true,
    overscroll: 'chain',
    scrollbar: 'auto',
  })
  // One `basis: "auto"` entry, not a flat list. Flattening is not equivalent: each
  // entry then carries its own `minSize`, and on a short terminal those minimums
  // compete with the transcript's single row instead of with the dock's total.
  // Measured on a 10-row terminal: flattened → the scroll region got 1 row, one
  // dock entry → 6.
  const dock = new VStack([
    { component: parts.aboveInput, shrink: 1, minSize: 0 },
    { component: parts.input, shrink: 1, minSize: 3 },
    { component: parts.footer, shrink: 1, minSize: 0 },
  ])
  if (isViewportTUI(screen)) {
    screen.setLayoutRoot(
      new VStack([
        { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: 'auto', grow: 0, shrink: 1, minSize: 1 },
      ]),
    )
  }
  screen.addInputListener((data) => parts.onInput(data))
  return {
    screen,
    scroll,
    start: () => { screen.start() },
    // `preserveScreen` on purpose — pi does the same when quitting from fullscreen
    // (`stopInteractiveTui`: `ui.stop({ preserveScreen: mode === 'fullscreen' })`).
    //
    // The alternative is supposed to print the final document back into scrollback,
    // but with a `VStack` layout root it does not: `afterTerminalStop()` calls
    // `render(width)`, which delegates to `layoutRoot.render()` — and a layout root
    // never measured by `renderLayoutFrame()` returns ONE line. Measured on a real
    // pty: 1426 bytes, banner only, the whole conversation gone.
    dispose: () => { screen.stop({ preserveScreen: true }) },
  }
}
