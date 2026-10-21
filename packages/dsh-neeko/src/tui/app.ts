/**
 * TuiApp: screen assembly, lifecycle, and top-level key arbitration.
 *
 * ## What this file is, and is not
 *
 * It once owned six unrelated concerns (identity banner, status bar, theme
 * picker, transcript repaint, command dispatch, model catalogue). Each now has
 * its own module:
 *
 * | Concern | Owner |
 * | --- | --- |
 * | active theme + picker state | `ThemeController` |
 * | picker | `theme-selector.ts` (a mounted `SelectList`) |
 * | status facts + bar layout | `StatusController` |
 * | command routing + model catalogue | `CommandController` |
 * | slash-menu liveness + pi-tui shape | `slash-provider.ts` |
 * | approval / question state + panel | `interactions.ts` |
 * | event → transcript rows | `transcript.ts` |
 * | screen geometry + key arbitration | this file |
 *
 * What remains here is what cannot be delegated: **who owns the screen**, and
 * **which subsystem gets the keyboard**. Everything else in this file is
 * mounting, wiring an `onChange`, or performing one effect after a pure
 * decision made elsewhere.
 *
 * Layout:
 *
 * ```
 * TuiMainScreen
 *  ├─ banner      (mark, version, model, cwd, session, hints)
 *  ├─ messages    (transcript rows — owned by mountTranscript)
 *  ├─ notices     (local command replies — owned by addNotice; scrolls with the
 *  │               conversation, because a reply belongs to the exchange it answers)
 *  ├─ working     (one-line activity hint)
 *  ├─ interaction (approval / question panel)
 *  ├─ themeText   (theme picker panel)
 *  ├─ editor      (focused by default)
 *  └─ status      (context / ledger / route, width-aware)
 * ```
 *
 * The transcript and the notices are deliberately **separate containers**:
 * `mountTranscript` clears its container on every flush, so anything written
 * there by a command would vanish on the next repaint.
 *
 * @module dsh-neeko/tui/app
 */

import { CURSOR_MARKER, TuiMainScreen } from '@earendil-works/pi-tui'
import type { KeybindingsConfig, KeybindingsManager } from '@earendil-works/pi-tui'
import { Container } from '@earendil-works/pi-tui'
import { Text } from '@earendil-works/pi-tui'
import { ProcessTerminal } from '@earendil-works/pi-tui'
import type { Terminal } from '@earendil-works/pi-tui'
import { matchesKey, isKeyRelease, isKeyRepeat } from '@earendil-works/pi-tui'
import type { Component, TUI } from '@earendil-works/pi-tui'
import { buildCommands } from './commands.ts'
import { LiveSlashProvider } from './slash-provider.ts'
import { NoticeLog } from './notice-log.ts'
import { rowSignature, syncChildren, visibleRows } from './row-cache.ts'
import { ResumeController } from './resume-controller.ts'
import { buildModelPanel, handleModelPanelKey } from './model-panel.ts'
import type { ModelPanel } from './model-panel.ts'
import { markdownThemeOf, selectListThemeOf } from './theme.ts'
import { renderBanner } from './banner.ts'
import type { TranscriptRow, TranscriptState } from './transcript.ts'
import { renderRow, setKeyReader } from './message-view.ts'
import { Composer, composerTheme } from './composer.ts'
import { StatusIndicator } from './status-indicator.ts'
import { PanelHost } from './panel-host.ts'
import { basename } from 'node:path'
import { tmpdir } from 'node:os'
import { pasteClipboard, platformClipboard } from './clipboard.ts'
import { suspendToBackground } from './suspend.ts'
import { onEndOfInput, onInterrupt } from './exit-keys.ts'
import { ProgramStatusReporter, applySessionEvent } from './program-status.ts'
import type { RunState } from './program-status.ts'
import { buildViewTree } from './view-tree.ts'
import { createSubsystems } from './subsystems.ts'
import type { RenderOptions } from './message-view.ts'
import { TranscriptFold } from './fold.ts'
import { actionScope, formatHotkeys, installKeymap, routeKey } from './keymap.ts'
import type { KeyScope } from './keymap.ts'
import { mountScreen, resolveScreen } from './screen.ts'
import type { MountedScreen, ScreenMode, ScreenParts } from './screen.ts'
import { InteractionManager, interactionIntent, renderInteractionPanel } from './interactions.ts'
import { ThemeController } from './theme-controller.ts'
import { StatusController } from './status-controller.ts'
import type { LiveStatusFacts } from './status-controller.ts'
import { CommandController } from './command-controller.ts'
import type { ModelChoice } from './command-controller.ts'
import { resumeHint } from './resume-hint.ts'
import { cycleThinking, thinkingChoices, thinkingOutcome } from './thinking.ts'
import type { ReasoningSupport } from './thinking.ts'
import { ThinkingSelector } from './thinking-selector.ts'
import { ThemeSelector } from './theme-selector.ts'
import { ResumeSelector } from './resume-selector.ts'
import type { ResumeSource } from './resume-list.ts'
import type { Theme } from './theme.ts'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'

/**
 * Compile-time exhaustiveness check.
 *
 * Assigning a value that is not `never` is a type error, so adding a variant to
 * a union without handling it fails the build instead of falling through at
 * runtime.
 *
 * @param value - the value that should be impossible to reach.
 * @param context - what was being switched on, for the message.
 */
function assertNever(value: never, context: string): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`)
}

/** Coalesced repaint interval for streaming events, in ms. */
const REPAINT_FLUSH_MS = 50

/**
 * Rows the editor's inline completion menu shows before it scrolls.
 *
 * Ten matches pi's model picker, which prints `(1/205)` beneath a ten-row window.
 */
const AUTOCOMPLETE_MAX_VISIBLE = 10

/**
 * Spinner frames for an in-flight reasoning block.
 *
 * The braille cycle pi-tui's own `Loader` uses: eight glyphs of equal width, so
 * the row never jitters as the frame advances.
 */
export type { ModelChoice }

export interface TuiAppOptions {
  /**
   * The route in effect **right now** (`provider/model`).
   *
   * A getter, not a value: `/model <id>` swaps the runner's selection ref and
   * every paint (banner, status bar) must read the new route — a snapshot
   * taken at construction would keep showing the boot model forever.
   */
  readonly getSelection: () => ModelSelection
  readonly getSessionId: () => string
  /**
   * The working directory of this session.
   *
   * A fact about the *session*, supplied by its owner — the app must not read
   * `process.cwd()` itself: the banner, path completion and the status bar would
   * then be three independent claims about where the session lives.
   */
  readonly cwd: string
  /** Send a non-command line to the model. */
  readonly onSubmit: (text: string) => void
  /** Load the model catalogue (for `/model` validation and completion). */
  readonly modelPicker: () => Promise<{ models: ModelChoice[]; current: string }>
  /** Switch the live selection to one model id (validated by the app). */
  readonly selectModel: (id: string) => void
  /**
   * Persist one model as the profile default (`Ctrl+S` in the panel).
   *
   * Separate from {@linkcode selectModel}: switching is a session-local change,
   * writing the default survives restarts and edits the profile on disk.
   */
  readonly setDefaultModel?: ((provider: string, id: string) => void) | undefined
  /**
   * The live selection's reasoning effort support for the **current** model.
   *
   * Async and host-owned: dsh answers `llm.resolveModelInfo(provider, model)`,
   * and those efforts are the only set a level may be picked from — a hard-coded
   * list would offer levels `resolveCallConfig` rejects before the request even
   * leaves the process. `undefined` means the model has no reasoning support.
   */
  readonly reasoningSupport?: (() => Promise<ReasoningSupport | undefined>) | undefined
  /** Apply one reasoning effort to the live selection (`undefined` clears it). */
  readonly selectReasoningEffort?: ((effort: string | undefined) => void) | undefined
  /**
   * List the sessions available to resume, newest first.
   *
   * Host-owned: dsh folds this from its session corpus
   * (`ctx.sessionQuery.listSessions()`), including titles that have to be read
   * per session. `undefined` means this build cannot enumerate them.
   */
  readonly listSessions?: (() => Promise<readonly ResumeSource[]>) | undefined
  /**
   * Fold titles for a bounded slice of session ids.
   *
   * Separate from {@linkcode listSessions} because a title costs one log read
   * per session: asking for all 419 of them at list time made the picker look
   * frozen. The picker therefore asks only for the rows it is about to show.
   */
  readonly sessionTitles?: ((ids: readonly string[]) => Promise<Readonly<Record<string, string>>>) | undefined
  /** Switch this TUI to another session by id. */
  readonly resumeSession?: ((sessionId: string) => void) | undefined
  /**
   * Read one attachment's bytes.
   *
   * Supplied by the runner, which owns the attachment service. Reading is async
   * (and verified against the recorded reference), so the app pre-fetches and
   * re-flushes — a render never blocks on I/O.
   */
  readonly readImage?: ((attachmentId: string) => Promise<{ base64: string; mediaType: string } | undefined>) | undefined
  /** Theme to start with; `/theme` switches it at runtime. */
  readonly initialTheme?: string
  /**
   * Which screen to mount; absent takes the default.
   *
   * The type is {@linkcode ScreenMode} rather than a boolean whose default this
   * class gets to define: the default is a project-wide decision
   * ({@linkcode DEFAULT_SCREEN}), and two layers disagreeing about what
   * `undefined` means is exactly how the flag and the environment ended up
   * inverted. The app performs the decision, it does not make it — there is no
   * `?? 'main'` here for that reason (a structural test pins it).
   */
  readonly screenMode?: ScreenMode
  /** Harness version shown in the startup banner. */
  readonly version: string
  /** Live status snapshot for the bar under the editor. */
  readonly statusFacts: () => LiveStatusFacts
  /** Commands registered by DSH plugins. */
  readonly listHostCommands?: () => readonly { name: string; description: string; inputHint?: string }[]
  /** Skills exposed by the host, surfaced as `/skill:<name>`. */
  readonly listSkills?: () => readonly { name: string; description: string }[]
  /** Run a slash line against the host command registry. */
  readonly runHostCommand?: (line: string) => Promise<{ kind: 'success' | 'error'; text?: string } | undefined>
  /** Invoked on Ctrl+C / Ctrl+D — the owner stops the app and exits. */
  readonly onExit: () => void
  /**
   * The terminal to render to; defaults to the process's own.
   *
   * Injected for the same reason the rest of `TuiAppOptions` is: the app should
   * depend on the `Terminal` contract, not construct`ProcessTerminal` itself —
   * which is also what lets tests exercise real rendering without touching the
   * developer's TTY.
   */
  readonly terminal?: Terminal
  /**
   * Per-action key overrides, as parsed from the user's `keybindings.json`.
   *
   * Threaded in rather than read here: this class must not touch the filesystem,
   * and a test needs to install a rebind without one. Absent means "pi's
   * defaults", which is also what {@linkcode installKeymap} does on its own.
   */
  readonly keybindingOverrides?: KeybindingsConfig
  /**
   * Override {@linkcode STATUS_NOTICE_MS} (tests use a short one).
   *
   * A number rather than a disable switch: "never expires" would put the stack
   * of stale status lines back, which is the defect this exists to fix.
   */
  readonly statusNoticeMs?: number
}

/**
 * The interactive screen. Starts raw mode on {@linkcode TuiApp.start}, restores
 * the terminal on {@linkcode TuiApp.stop}.
 */
export class TuiApp {
  private tui: TuiMainScreen
  /** The main screen's mount record; `start()`/`dispose()` go through it. */
  private mainScreen: MountedScreen<TuiMainScreen> | undefined
  /**
   * The screen this run uses, resolved once at construction.
   *
   * A field rather than a read of `options.screenMode` at each use: the option is
   * absent when the user said nothing, and re-resolving it (or worse, applying
   * `?? something` locally) is what put two copies of the default in the code.
   */
  private readonly screenMode: ScreenMode
  private readonly editor: Composer
  private readonly banner: Container
  private readonly messages: Container
  /**
   * The scrolling document: banner + transcript, in that order.
   *
   * One container because the viewport scrolls the whole screen (pi does the
   * same: its `documentContainer` holds the header and the chat). Keeping the
   * banner outside the scroll region pinned it, so scrolling slid the conversation
   * under a stationary header.
   */
  private readonly document: Container
  /** Durable replies and the self-clearing status line. */
  private readonly noticeLog: NoticeLog
  /**
   * The rows between the transcript and the input: notices, the activity line,
   * the interaction panel, the theme and thinking pickers.
   *
   * One container because both renderers mount it — the main screen as a child,
   * the alt screen as its `aboveInput` slot. The old `mountFullscreen()` took an
   * enumerated component list, which is what made `/thinking` and `/theme`
   * invisible in fullscreen while their keys still worked. `screenParts()` hands
   * the same aggregates to both screens, so that class of bug is gone.
   */
  private readonly aboveInput: Container
  /**
   * The editor's slot, owned by the app and mounted by whichever screen is live.
   *
   * A container rather than the editor itself, because the input surface is
   * *replaceable*: the model panel takes the editor's place while it is open.
   * Handing the renderers a fixed component meant `replaceInputSlot()` had to
   * guess where that component was mounted, and it guessed wrong in fullscreen —
   * the editor belongs to the alt screen's `input` slot there, not to `tui`, so
   * `/model` mounted the panel into the stopped main screen. Nothing was drawn
   * while the panel still held the keyboard: "the model list is gone and the app
   * is stuck". (The same mistake hid `/thinking` and `/theme`, see
   * {@linkcode aboveInput}.)
   */
  private readonly inputSlot: Container
  private readonly interactionText: Text
  private readonly themeText: Text
  /** Its own panel line: a picker that renders into another's slot is a trap. */
  private readonly thinkingText: Text
  /**
   * The dock's single occupant, and the only place "a panel is open" is recorded.
   *
   * Three parallel `Selector | undefined` fields used to answer that question, and
   * they could disagree — a key would then be forwarded to a panel that had already
   * been replaced. See `panel-host.ts`.
   */
  private readonly panels: PanelHost
  /** Its own panel line, like the other two selectors. */
  /** The dock's permanent rows in mount order (`view-tree.ts`). */
  private readonly dockRows: readonly Component[]
  /** `/resume`: listing, paged title enrichment and the picker. */
  private readonly resumeList: ResumeController

  /** Theme state, catalogue and picker. */
  private readonly themes: ThemeController
  /** Status facts and the width-aware bar. */
  private readonly status: StatusController
  /** Command routing and the model catalogue. */
  private readonly commands: CommandController
  /** Approval / question state. */
  readonly interactions = new InteractionManager()
  /**
   * The installed keybinding registry.
   *
   * Held so the app can (a) match through the live bindings instead of literals
   * and (b) hand the same manager to `/hotkeys`. The registry is also global
   * (pi-tui's `getKeybindings()`), which is what makes `Editor` and the alt
   * screen follow a rebind — one install, three consumers, no second table.
   */
  private readonly keybindings: KeybindingsManager

  private exited = false
  /** When `ctrl+c` was last pressed, for the double-press window (`exit-keys.ts`). */
  private lastInterrupt: number | undefined
  private scheduleRender: (() => void) | undefined
  /**
   * Index of the first transcript row the view may paint (see
   * {@linkcode mountTranscript}). Advanced by `/clear` so a cleared view stays
   * cleared across repaints while new rows still show up.
   */
  private visibleFrom = 0
  /** The bound transcript, kept so `/clear` can measure the watermark. */
  private transcript: TranscriptState | undefined
  /** The open model panel, if any (it owns the keyboard while visible). */
  private modelPanel: ModelPanel | undefined
  private readonly terminal: Terminal
  /**
   * The terminal's own status channels (title, tab spinner, OSC 7501).
   *
   * One owner, and it *derives* the status from the run state plus the open
   * dialogs rather than being told the answer — two writers of "should the spinner
   * be on" is one writer too many (see `program-status.ts`).
   */
  private readonly programStatus: ProgramStatusReporter
  /**
   * The alt-screen surface, while fullscreen is on.
   *
   * `undefined` means the main screen is the live one. The field being a
   * {@linkcode MountedScreen} rather than a renderer is what lets
   * {@linkcode activeTui} answer "who is on screen" without knowing either
   * pi-tui class.
   */
  private fullscreen: MountedScreen | undefined
  /** Attachment bytes already read, keyed by id (render reads this cache). */
  private readonly imageCache = new Map<string, { base64: string; mediaType: string }>()
  /** Ids currently being read, so one image is fetched once. */
  private readonly imagePending = new Set<string>()
  /**
   * What the transcript shows expanded.
   *
   * Held here rather than in the row model: expansion is a *view* preference, so
   * a re-flush (which rebuilds every component) must not lose it, and the
   * transcript itself stays a pure projection of session events.
   */
  private readonly fold = new TranscriptFold()
  /**
   * Rendered component per row, keyed by the row object.
   *
   * A flush used to rebuild every component from scratch, which costs ~30 ms for
   * 600 rows — more than half of the 50 ms repaint budget, and it grows with the
   * conversation. A row only changes when its own content or its render inputs
   * change, so the component is reused while a cheap signature matches.
   */
  private readonly rowComponents = new WeakMap<TranscriptRow, { signature: string; component: Component }>()

  constructor(private readonly options: TuiAppOptions) {
    this.terminal = options.terminal ?? new ProcessTerminal()
    this.programStatus = new ProgramStatusReporter(this.terminal)
    // Before anything reads it: `Editor` and `TuiAltScreen` resolve bindings
    // through pi-tui's global registry on every keystroke, so a late install
    // leaves them on defaults while the app thinks it is configured.
    this.keybindings = installKeymap(options.keybindingOverrides ?? {})
    // The fold hint on a folded tool result names the *live* binding. Rendering is
    // a pure function of its arguments, so the reader is injected here instead of
    // imported there: one seam, and a test can set it without a registry.
    setKeyReader((action) => this.keybindings.getKeys(action as never))
    // The screen is decided once, here, by the one function that owns the
    // decision. This class contributes no default of its own: it used to write
    // `?? 'main'` while `runner` returned `'main'` too, and two copies of a
    // default is what the module comment in `screen.ts` is about.
    this.screenMode = resolveScreen({ screen: options.screenMode })
    // The four controllers, built in one call (`subsystems.ts`): which subsystems
    // exist is a different question from what is on screen, and answering both in
    // one constructor body made neither readable.
    const subsystems = createSubsystems({
      ...options,
      showStatus: (text) => { this.showStatus(text) },
      addNotice: (text, tone) => { this.addNotice(text, tone) },
    })
    this.themes = subsystems.themes
    this.commands = subsystems.commands
    this.resumeList = subsystems.resumeList
    this.status = subsystems.status

    // The widget tree is one static structure, so it is built in one call rather
    // than threaded through this constructor (`view-tree.ts`).
    const tree = buildViewTree({
      paint: (token, text) => this.themes.current.fg(token, text),
      onChange: () => { this.requestRender() },
      ...(options.statusNoticeMs === undefined ? {} : { statusNoticeMs: options.statusNoticeMs }),
    })
    this.banner = tree.banner
    this.messages = tree.messages
    this.document = tree.document
    this.noticeLog = tree.noticeLog
    this.inputSlot = tree.inputSlot
    this.aboveInput = tree.dock
    this.interactionText = tree.interactionText
    this.themeText = tree.themeText
    this.thinkingText = tree.thinkingText
    this.dockRows = tree.dockRows
    // pi's model list shows ten rows before scrolling (`(1/205)` below them);
    // the editor renders the same list, so the same bound applies here.
    // The editor is handed a *proxy* for the renderer, not the main screen.
    //
    // `Editor` stores its `tui` in the constructor and uses it for
    // `requestRender()` (notably when the autocomplete menu opens). Fullscreen
    // swaps the live renderer, so a captured reference would keep repainting the
    // stopped main screen — the menu would compute its rows and never appear.
    // The composer paints its own border from the active theme and embeds the
    // activity indicator in it (`composer.ts`). A theme switch has to rebuild the
    // editor theme, which `repaintChrome()` does.
    this.editor = new Composer(this.rendererProxy, composerTheme(this.themes.current), this.themes.current, {
      autocompleteMaxVisible: AUTOCOMPLETE_MAX_VISIBLE,
    })

    this.panels = new PanelHost({
      dock: this.aboveInput,
      restore: () => { this.restoreDock() },
      requestRender: () => { this.requestRender() },
    })
    this.restoreDock()
    this.inputSlot.addChild(this.editor)

    // The main screen is mounted EAGERLY even when fullscreen is the choice.
    //
    // Two reasons, both learned the hard way: `/fullscreen` can switch back at
    // runtime (`exitFullscreen()` needs a mounted main screen to restart), and
    // `TuiApp`'s own `tui` field is what `clearTranscript()` and
    // `printFinalDocument()` reach for. Whether it is *started* is decided in
    // {@linkcode start}, not here — construction and mounting are separate
    // concerns from raw mode.
    this.tui = this.mountMainScreen()

    this.editor.onSubmit = (text: string) => { void this.submit(text) }
    this.installAutocomplete()

    this.interactions.onChange = () => {
      this.refreshInteraction()
      // A pending approval is the one state a user must see from outside the
      // window: `working` says "wait", `blocked` says "it needs you".
      this.syncBlockedStatus()
    }
    this.themes.onChange = () => this.repaintChrome()
    this.status.onChange = () => this.requestRender()
    // Warm the catalogue so `/model ` completes without a round trip.
    void this.commands.ensureModels()
  }

  /**
   * Mount the terminal-owned screen through the same entry point as the alt
   * screen.
   *
   * Built from the same four aggregates, in the same order, so a region's visual
   * position never depends on which screen is live. Whether this screen is
   * *started* is decided in {@linkcode start}: construction and mounting are
   * separate concerns from raw mode.
   *
   * @returns the mounted main screen, not yet started.
   */
  private mountMainScreen(): TuiMainScreen {
    const mounted = mountScreen(this.terminal, 'main', this.screenParts())
    mounted.screen.setFocus(this.editor)
    this.mainScreen?.dispose()
    this.mainScreen = mounted
    return mounted.screen
  }

  /**
   * The four regions plus the key forwarder, as one value.
   *
   * One builder for both screens: a region added to the app is therefore on both,
   * which is what makes `mountScreen`'s aggregate signature worth having. The
   * earlier code enumerated these fields at each call site, and a panel added to
   * the app was silently absent from whichever list nobody updated.
   *
   * @returns the regions the screen will mount.
   */
  private screenParts(): ScreenParts {
    return {
      document: this.document,
      aboveInput: this.aboveInput,
      input: this.inputSlot,
      footer: this.status.component,
      onInput: (data) => this.handleInput(data),
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Enter raw mode and start rendering. */
  start(): void {
    // Clear first, then draw: the TUI should own the screen it opens on.
    //
    // pi does not do this — measured, it issues no clear sequence at all, and looks
    // clean on a 30-row terminal only because its startup header is 26 lines. On a
    // 50- or 70-row terminal the same `pi` leaves the previous shell session visible
    // below its output. So "match pi" and "open on a clean screen" are different
    // requirements; this build takes the second, using pi-tui's own
    // `Terminal.clearScreen()`.
    //
    // The cost, stated rather than hidden: scrollback from before the launch is
    // gone. That is what "only the TUI" means, and the resume hint printed on exit is
    // how the conversation is found again.
    //
    // Once only — `requestRender` runs many times a second and must not clear, or the
    // transcript accumulated since startup would be wiped on every frame.
    this.terminal.clearScreen()
    this.paintBanner()
    this.status.refresh()
    // The terminal's own channels, before the first frame: a window that opens
    // untitled is indistinguishable from every other one in a tab bar.
    this.programStatus.setSession({
      directory: basename(this.cwd()),
      sessionId: this.options.getSessionId(),
    })
    this.programStatus.report()
    // Fullscreen starts *instead of* the main screen, not on top of it: the two
    // renderers share one terminal, so whichever starts last owns the mode.
    //
    // `screenMode` was already resolved in the constructor — there is no default
    // to apply here. That asymmetry is deliberate: a default restated at a second
    // site is how the flag and the environment ended up inverted once already.
    if (this.screenMode === 'fullscreen') {
      this.enterFullscreen()
      return
    }
    this.mainScreen?.start()
    this.requestRender()
  }

  /** Whether the screen is currently rendering (raw mode on). */
  get isRunning(): boolean {
    return !this.exited
  }

  /** Leave raw mode; safe to call twice. */
  stop(): void {
    if (this.exited) return
    this.exited = true
    // Leave the alt screen too, if it is the live one.
    //
    // `this.tui` is the *main* screen and it is already stopped while fullscreen
    // is on, so stopping only it left the terminal in the alternate buffer: the
    // shell then drew its prompt into a screen the user could not see, and every
    // subsequent write looked like garbage.
    //
    // The conversation has to land in the terminal's own scrollback. Two ways
    // are closed:
    //
    // 1. pi-tui's "print the final document" on the alt screen yields ONE line
    //    for a `VStack` layout root (see `screen.ts`) — the conversation is
    //    gone (measured: 1426 bytes = banner only).
    // 2. Restarting the main screen calls `terminal.start()`, which re-sends the
    //    capability queries (Kitty protocol / device attributes / cell size).
    //    Their replies arrive after we exit, nothing parses them, and the shell
    //    prints the bytes literally: `7u 62;22;52c 34;16t`.
    //
    // So: leave the alt screen, then write the document ourselves.
    // Fullscreen owns its own buffer, so the conversation has to be written back to
    // the terminal's one on the way out — nothing else will put it there.
    const leavingAltScreen = this.fullscreen !== undefined
    this.resumeMainScreenQuietly()
    // A live timer keeps the event loop alive and would fire into a stopped
    // screen; clear the status line on the way out.
    this.noticeLog.clearStatus()
    if (leavingAltScreen) this.printFinalDocument()
    else this.printResumeHint()
  }

  /**
   * Flush the terminal's pending input queue.
   *
   * Called by the owner **before** exiting, and awaited: the process must not end
   * while the queue is non-empty.
   *
   * A third variant of the same class of defect as the two above. While the Kitty
   * keyboard protocol is on, the terminal reports **key releases** as CSI-u
   * sequences (`9;5:3u` = ctrl+tab released). A release that lands between the
   * last render and `process.exit` is still sitting in stdin when the shell takes
   * over, and the shell echoes it literally — `9;5:3u9;` on screen.
   *
   * `drainInput` is the supported fix: it disables the protocol *first* (so no
   * further releases are generated), waits for the queue to go quiet, and
   * discards what arrived.
   *
   * @returns a promise that resolves once the queue is drained or times out.
   */
  drainTerminalInput(): Promise<void> {
    return this.terminal.drainInput()
  }

  /**
   * Write the whole document to the main screen — the fullscreen exit path.
   *
   * Reached only when leaving the alt screen: that buffer is discarded by the
   * terminal, so without this the conversation is gone. Rendered straight from this
   * app's own containers rather than through `TuiMainScreen.start()`, because that
   * path yields one line for a `VStack` root (see {@linkcode stop}).
   */
  private printFinalDocument(): void {
    const width = Math.max(1, this.terminal.columns)
    // Both aggregates, not their parts one by one: a component added to either
    // must not be able to go missing from the final document.
    const document = [
      this.document,
      this.aboveInput,
      // The slot, not the editor: `/model` puts a panel there, and printing the
      // editor would then render a component that is not mounted — the panel
      // would be missing from the final document.
      this.inputSlot,
      this.status.component,
    ]
      .flatMap((component) => component.render(width))
      // pi-tui's fake-cursor markers are render-time protocol, not text.
      .map((line) => line.replaceAll(CURSOR_MARKER, ''))
    if (document.length === 0) return
    const hint = resumeHint({ sessionId: this.options.getSessionId() })
    if (hint !== undefined) document.push('', this.themes.current.fg('muted', hint))
    // `\n`, not `\r\n`: the terminal is in cooked mode by now, so its ONLCR
    // translation turns `\n` into `\r\n` for us. Writing `\r\n` produced `\r\r\n`
    // (a blank line between every row) on a real pty.
    this.terminal.write(`${document.join('\n')}\n`)
  }

  /**
   * Leave one line in the scrollback saying how to come back — and nothing else.
   *
   * This is the main-screen exit path. The transcript is already in the terminal's
   * own scrollback, so printing it again only stacks old headers above the next
   * launch. pi prints exactly this hint and nothing more — verified against the real
   * binary: `pi` then `ctrl+d` writes `<u \r\r\nbash-3.2$ `.
   *
   * @returns nothing.
   */
  private printResumeHint(): void {
    const hint = resumeHint({ sessionId: this.options.getSessionId() })
    if (hint === undefined) return
    // `\n`, not `\r\n`: the terminal is in cooked mode by now, so its ONLCR
    // translation turns `\n` into `\r\n` for us. Writing `\r\n` produced `\r\r\n`
    // (a blank line between every row) on a real pty.
    this.terminal.write(`${this.themes.current.fg('muted', hint)}\n`)
  }

  /**
   * Return to the main screen **without** restarting the terminal.
   *
   * Used by {@linkcode stop}, where re-running `TuiBase.start()` would re-send
   * capability queries whose replies land on the shell's prompt after exit (they
   * are no longer consumed as input).
   */
  private resumeMainScreenQuietly(): void {
    if (this.fullscreen === undefined) return
    this.fullscreen.dispose()
    this.fullscreen = undefined
  }

  /**
   * The renderer that is actually on screen.
   *
   * While fullscreen is on, the main screen is stopped — a repaint request sent
   * to it goes nowhere, so the transcript would only catch up when the alt
   * screen happened to repaint for another reason (which read as "nothing streams
   * until the answer is finished").
   */
  private get activeTui(): TUI {
    return this.fullscreen?.screen ?? this.tui
  }

  /**
   * A renderer handle that always resolves to the live one.
   *
   * Only the members `Editor` actually touches are forwarded — `requestRender`
   * and `terminal` — so the proxy cannot silently diverge from the real
   * interface as pi-tui grows.
   */
  private get rendererProxy(): TUI {
    // Cached: `Editor` stores what it is given, so a fresh object per access
    // would churn needlessly while still pointing at the right renderer.
    if (this._rendererProxy === undefined) {
      const self = this
      this._rendererProxy = {
        // Both members `Editor` reads: the row count for its height cap, and the
        // repaint hook for its autocomplete menu.
        get terminal(): TUI['terminal'] { return self.activeTui.terminal },
        requestRender: (force?: boolean) => { self.activeTui.requestRender(force) },
      } as unknown as TUI
    }
    return this._rendererProxy
  }

  private _rendererProxy: TUI | undefined

  /** Schedule a repaint (coalesced by the active renderer). */
  requestRender(): void {
    this.scheduleRender?.()
    this.activeTui.requestRender()
  }

  // ── command submission ─────────────────────────────────────────────────────

  /**
   * Route one editor submission.
   *
   * The classification is exhaustive over `CommandOutcome`, so a new command
   * kind cannot be silently ignored.
   *
   * @param text - the raw editor line.
   */
  private async submit(text: string): Promise<void> {
    // An active interaction owns the editor. Guarding on `busy` (not on the
    // specific view) is what makes this a real invariant: the earlier version
    // only handled questions, so a pending approval let the submitted line
    // through to the model — it happened to be unreachable because `handleInput`
    // swallows Enter first, but relying on the caller's behaviour is exactly how
    // the two previous defects in this file slipped in.
    if (this.interactions.busy) {
      this.editor.setText('')
      if (this.interactions.current?.kind === 'question') {
        // The submitted line IS the answer.
        this.interactions.answerQuestion(text)
      } else {
        this.addNotice('answer the pending prompt first (y / n / esc)', 'error')
      }
      return
    }
    const action = this.commands.classify(text)
    // Clear before dispatching, whatever the kind.
    //
    // This used to run only past the `prompt` branch, so a normal message left
    // its text in the buffer: the editor still held "hello" after submitting,
    // `isAtStartOfMessage()` stayed false, and typing `/` no longer opened the
    // command menu until another character moved the cursor off that state.
    this.editor.setText('')
    if (action.kind === 'prompt') {
      this.options.onSubmit(text)
      return
    }
    switch (action.kind) {
      case 'notice':
        this.addNotice(action.text, 'text')
        return
      case 'clear':
        this.clearTranscript()
        return
      case 'exit':
        this.options.onExit()
        return
      case 'model-picker':
        await this.openModelPanel()
        return
      case 'select-model':
        await this.applyModelById(action.id)
        return
      case 'theme-picker':
        this.openThemePicker()
        return
      case 'thinking':
        await this.applyThinking(action.argument)
        return
      case 'resume':
        await this.applyResume(action.argument)
        return
      case 'toggle-fullscreen':
        this.toggleFullscreen()
        return
      case 'hotkeys':
        this.addNotice(formatHotkeys(this.keybindings).join('\n'), 'text')
        return
      case 'apply-theme':
        this.applyThemeByName(action.name)
        return
      case 'host': {
        const result = await this.commands.runOnHost(action.line)
        if (result === undefined) {
          this.addNotice(`unknown command: /${action.name} (try /help)`, 'error')
        } else {
          this.addNotice(result.text, result.ok ? 'text' : 'error')
        }
        return
      }
      default:
        // A new `CommandAction` must be handled here. Without this branch a
        // missing case was silently ignored — the command simply did nothing.
        return assertNever(action, 'unhandled command action')
    }
  }

  /**
   * `ctrl+v` — put the clipboard into the editor.
   *
   * Reports every non-success outcome, because silence is indistinguishable from a
   * broken key: a user who presses `ctrl+v` on an empty clipboard must be told the
   * clipboard is empty, not left wondering whether the binding works.
   */
  private async pasteFromClipboard(): Promise<void> {
    const result = await pasteClipboard({
      clipboard: platformClipboard(),
      directory: tmpdir(),
    })
    switch (result.kind) {
      case 'files':
      case 'image':
      case 'text':
        // Same call pi uses: insert at the caret, so a paste in the middle of a
        // sentence does not jump to the end.
        this.editor.insertTextAtCursor(result.text)
        this.requestRender()
        return
      case 'empty':
        this.addNotice('the clipboard has nothing to paste', 'error')
        return
      case 'unavailable':
        this.addNotice('this platform has no readable clipboard', 'error')
        return
      case 'error':
        this.addNotice(`clipboard paste failed: ${result.message}`, 'error')
    }
  }

  /**
   * `ctrl+t` — show or hide reasoning blocks.
   *
   * Reports the new state: a toggle whose only effect is on rows the user may not be
   * looking at is otherwise indistinguishable from a dead key.
   */
  private toggleThinking(): void {
    const visible = this.fold.toggleThinking()
    // Fold state is read while rows render, so a transcript repaint is the whole
    // effect. `scheduleRender` (what `toggleFold` uses) is that repaint; the banner
    // and the status bar are untouched by a fold change.
    this.showStatus(`thinking: ${visible ? 'visible' : 'hidden'}`)
    this.scheduleRender?.()
  }

  /**
   * `shift+tab` — advance the thinking level in place.
   *
   * The levels come from the adapter's `reasoning.efforts` for the current route; a
   * model with none gets a notice rather than an invented level.
   */
  private async cycleThinkingLevel(): Promise<void> {
    const read = this.options.reasoningSupport
    if (read === undefined) {
      this.addNotice('this build cannot read the model\'s reasoning settings', 'error')
      return
    }
    let support: ReasoningSupport | undefined
    try {
      support = await read()
    } catch (error: unknown) {
      this.addNotice(
        `could not read reasoning settings: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
      return
    }
    const next = cycleThinking(this.options.getSelection().reasoningEffort, support)
    if (next === undefined) {
      this.addNotice(`model ${this.options.getSelection().model} has no reasoning levels`, 'error')
      return
    }
    // Reuses the `/thinking <level>` path so both routes validate the same way; a
    // second copy of "apply an effort" would drift. The status line is reported
    // **after** success only — `commitThinking` reports its own failure, and printing
    // the level anyway told the user it worked when it had not.
    if (this.commitThinking(next)) this.showStatus(`thinking level: ${next}`)
  }

  /**
   * Whether a panel is covering the input row.
   *
   * The exit keys care because pi binds `app.clear` on the editor, so a picker
   * unfocuses it and the key never arrives. Here the exit scope sits above the
   * pickers (so `ctrl+c` works from anywhere), which means the rule has to ask
   * explicitly instead.
   *
   * @returns whether any panel owns the keyboard.
   */
  private panelOpen(): boolean {
    return this.modelPanel !== undefined || this.panels.isOpen
  }

  /**
   * `ctrl+c` — clear the draft, or leave if pressed twice quickly.
   *
   * `pi`'s exact rule (see `exit-keys.ts`): answering the first press with a
   * shutdown throws away a half-typed message, and this key is the one every
   * terminal user reaches for to abandon one.
   */
  private handleInterrupt(): void {
    const { action, remember } = onInterrupt(this.now(), this.lastInterrupt)
    this.lastInterrupt = remember
    switch (action.kind) {
      case 'exit':
        this.options.onExit()
        return
      case 'clear':
        // The draft only: an open panel closes on `escape`, and pi's own
        // `clearEditor` does not touch panels either.
        this.editor.setText('')
        this.requestRender()
    }
  }

  /**
   * `ctrl+d` — leave, but only from an empty editor.
   *
   * A binding cannot see the text, so the condition lives here rather than in
   * `keymap.ts` (pi enforces it inside its `CustomEditor`, which pi-tui's plain
   * `Editor` has no equivalent of).
   */
  private handleEndOfInput(): void {
    if (onEndOfInput(this.editor.getText() !== '').kind === 'exit') this.options.onExit()
  }

  /**
   * The clock, isolated so the double-press window is testable.
   *
   * @returns milliseconds.
   */
  private now(): number {
    return Date.now()
  }

  /**
   * `ctrl+z` — suspend to the background.
   *
   * Sends `SIGTSTP` to this process, which is what the shell's job control expects;
   * `fg` then brings the TUI back and `resume()` repaints, because the terminal was
   * resized or written to while we were stopped.
   *
   * Windows has no Unix job control, so pi shows a status message there instead of
   * pretending to suspend. Refusing loudly is better than a keystroke that appears to
   * work and leaves the user staring at an unchanged screen.
   */
  private handleSuspend(): void {
    suspendToBackground({
      stopRendering: () => { this.activeTui.stop() },
      startRendering: () => { this.activeTui.start() },
      requestRender: () => { this.requestRender() },
      notify: (message, level) => { this.addNotice(message, level) },
    })
  }

  /**
   * Switch to the next or previous model without opening the picker.
   *
   * pi's `app.model.cycleForward`. Reads the catalogue through the same
   * `ensureModels` the picker uses, so a cycle before the first `/model` still
   * works.
   *
   * @param delta - `1` forward, `-1` backward.
   */
  private async cycleModel(delta: 1 | -1): Promise<void> {
    const models = await this.commands.ensureModels()
    const next = this.commands.cycleModel(this.options.getSelection().model, delta)
    if (next === undefined) {
      this.addNotice(
        models.length === 0 ? 'models are not available from this provider yet' : 'no other model to switch to',
        'error',
      )
      return
    }
    this.options.selectModel(next)
    this.repaintChrome()
    this.showStatus(`model → ${next}`)
  }

  /**
   * `/model`: open the model panel over the input area.
   *
   * The panel replaces the editor's place on screen (pi's `openPicker` shape):
   * a header, a filter box, the list, the highlighted row's name and a key hint.
   * Inline completion cannot carry a filter box or a detail line, and a centred
   * overlay would float over the conversation instead of standing in for the
   * input surface.
   */
  private async openModelPanel(): Promise<void> {
    // `ensureModels` does not cache an empty result, so this call is already the
    // retry: the warm-up at construction is the attempt that fails while the
    // provider adapter is still registering.
    const models = await this.commands.ensureModels()
    if (models.length === 0) {
      this.addNotice('models are not available from this provider yet', 'error')
      return
    }
    this.closeModelPanel()
    const current = this.options.getSelection()
    const panel = buildModelPanel({
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        isCurrent: model.id === current.model,
      })),
      theme: this.themes.current,
      onSelect: (id) => {
        this.closeModelPanel()
        void this.applyModelById(id)
      },
      onCancel: () => { this.closeModelPanel() },
      onSetDefault: (model) => {
        // Staying open is deliberate: the confirmation lands in the panel's own
        // status line, so the user sees the write land without losing their place.
        this.options.setDefaultModel?.(model.provider, model.id)
      },
    })
    this.modelPanel = panel
    // The panel takes the editor's *slot* rather than floating over it: it is a
    // replacement for the input surface, so it has to sit exactly where the input
    // sits (directly above the status bar) and push nothing out of place.
    //
    // Deliberately *not* focusing the filter box: pi-tui routes keys straight to
    // the focused component, which would bypass `handleModelPanelKey` and leave
    // the list unfiltered. The panel drives both children itself.
    this.replaceInputSlot(panel.component)
    this.requestRender()
  }

  /** Put the editor back (idempotent). */
  private closeModelPanel(): void {
    if (this.modelPanel === undefined) return
    this.replaceInputSlot(this.editor)
    this.modelPanel = undefined
    this.requestRender()
  }

  /**
   * Enter or leave the alt-screen viewport.
   *
   * Two screens exist because they trade one thing: the main screen leaves
   * selection, copy and the right-click menu to the terminal but cannot report a
   * click, while the alt screen owns the viewport (so a card is clickable and
   * scrolling is the app's) at the cost of the terminal's scrollback. pi exposes
   * the same toggle, and `/fullscreen` is the runtime switch for it.
   */
  private toggleFullscreen(): void {
    if (this.fullscreen !== undefined) {
      this.exitFullscreen()
      this.showStatus('fullscreen off — terminal scrollback restored')
      return
    }
    this.enterFullscreen()
  }

  /**
   * Swap the main screen for the alt screen.
   *
   * The main screen is stopped *first*: both renderers drive the same terminal,
   * and whichever calls `stop()` last resets raw mode out from under the other.
   *
   * All four regions are handed over as aggregates, so a panel added to
   * {@linkcode aboveInput} or {@linkcode inputSlot} is on the alt screen
   * automatically. The earlier signature took them one by one, and every panel
   * added afterwards was silently missing in fullscreen while its keys still
   * worked.
   *
   * Idempotent, so {@linkcode start} can call it directly when fullscreen is the
   * resolved screen.
   */
  private enterFullscreen(): void {
    if (this.fullscreen !== undefined) return
    this.tui.stop()
    this.fullscreen = mountScreen(this.terminal, 'fullscreen', this.screenParts())
    this.fullscreen.start()
    this.fullscreen.screen.setFocus(this.editor)
    this.fullscreen.screen.requestRender(true)
  }

  /**
   * Return to the main screen.
   *
   * A full repaint is required rather than a diff: the main screen stopped with a
   * frame that no longer matches anything on disk, so every row has to be
   * written again.
   *
   * `dispose()` deliberately does **not** print the final document (see
   * `screen.ts`: a `VStack` layout root that was never measured renders one
   * line). The conversation reaches scrollback from {@linkcode stop}, which
   * writes it itself.
   */
  private exitFullscreen(): void {
    if (this.fullscreen === undefined) return
    this.fullscreen.dispose()
    this.fullscreen = undefined
    this.mainScreen?.start()
    this.tui.setFocus(this.editor)
    this.requestRender()
  }

  /**
   * Put `component` into the input slot.
   *
   * Only {@linkcode inputSlot}'s child changes — the slot itself stays mounted by
   * whichever screen is live, so this works identically in main-screen and
   * fullscreen mode. Swapping the slot's *parent* instead (removing and
   * re-appending the editor to `tui`) is what made the model panel invisible in
   * fullscreen.
   *
   * @param component - the input-slot occupant (editor, or the model panel).
   */
  private replaceInputSlot(component: Component): void {
    this.inputSlot.clear()
    this.inputSlot.addChild(component)
  }

  /**
   * `/model <id>`: validate against the live catalogue, then switch.
   *
   * Validation happens *here* rather than in the runner because the catalogue
   * belongs to this subsystem (it is what `/model ` completes from) — an id the
   * user could not have picked from the menu is a typo, not a route.
   *
   * @param id - the model id as submitted (tab completion inserts it verbatim).
   */
  private async applyModelById(id: string): Promise<void> {
    const models = await this.commands.ensureModels()
    const match = models.find((model) => model.id === id || model.name === id)
    if (match === undefined) {
      this.addNotice(
        models.length === 0
          ? 'no models available for this provider'
          : `unknown model "${id}" (type /model to browse)`,
        'error',
      )
      return
    }
    // `selectModel` is host-owned and can fail (persisting the selection). An
    // uncaught throw here rejected the whole submission with no visible effect,
    // so pressing enter looked like it did nothing at all.
    try {
      this.options.selectModel(match.id)
    } catch (error: unknown) {
      this.addNotice(
        `model switch failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
      return
    }
    // The banner bakes colors + the route into strings; a switch repaints it.
    this.repaintChrome()
    this.showStatus(`model → ${match.provider}/${match.id}`)
  }

  // ── reasoning effort (`/thinking`) ─────────────────────────────────────────

  /**
   * `/thinking [level]`: open the selector, or apply one level.
   *
   * The level list is the adapter's (`llm.resolveModelInfo`), so this is the
   * only place that knows how to ask for it; the four outcomes are decided by
   * the pure `thinkingOutcome()`.
   *
   * @param argument - the text after `/thinking`.
   */
  private async applyThinking(argument: string): Promise<void> {
    const support = this.options.reasoningSupport;
    if (support === undefined) {
      this.addNotice('this build cannot read the model\'s reasoning settings', 'error')
      return;
    }
    let resolved: ReasoningSupport | undefined
    try {
      resolved = await support()
    } catch (error: unknown) {
      this.addNotice(
        `could not read reasoning settings: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
      return
    }
    const current = this.options.getSelection().reasoningEffort
    const outcome = thinkingOutcome(argument, resolved, current)
    switch (outcome.kind) {
      case 'unsupported':
        this.addNotice(`model ${this.options.getSelection().model} has no reasoning levels`, 'error')
        return
      case 'unknown':
        this.addNotice(outcome.message, 'error')
        return
      case 'unchanged':
        this.showStatus(`thinking level: ${outcome.effort} (already set)`)
        return
      case 'picker':
        this.openThinkingPicker(resolved, current)
        return
      case 'apply':
        if (this.commitThinking(outcome.effort)) {
          this.showStatus(`thinking level: ${outcome.effort ?? 'default'}`)
        }
        return
    }
  }

  /**
   * Apply one effort to the live selection.
   *
   * @param effort - the effort to apply, or `undefined` to clear.
   * @returns whether it was applied; the caller must not report success otherwise.
   */
  private commitThinking(effort: string | undefined): boolean {
    const apply = this.options.selectReasoningEffort
    if (apply === undefined) {
      this.addNotice('this build cannot change the reasoning level', 'error')
      return false
    }
    try {
      apply(effort)
    } catch (error: unknown) {
      this.addNotice(
        `thinking level not applied: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
      return false
    }
    // The status bar carries the effort; repaint it so the change is visible
    // without waiting for the next session event.
    this.repaintChrome()
    return true
  }

  /**
   * Open the thinking-level selector over the transcript.
   *
   * pi's shape (`ThinkingSelectorComponent`): a bordered panel with a filter input
   * above a `SelectList`, mounted in `aboveInput` — the dock, because it is
   * transient and must stay visible while the transcript scrolls.
   *
   * The previous version painted a string into `thinkingText`. That worked but
   * could not filter, could not page, and re-derived the cursor from an index;
   * `SelectList` already does all three, and `/model` uses the same component, so
   * the two menus now behave identically.
   *
   * @param support - the model's reasoning support.
   * @param current - the effort in effect, for the `✓` marker and the cursor.
   */
  private openThinkingPicker(
    support: ReasoningSupport | undefined,
    current: string | undefined,
  ): void {
    const choices = thinkingChoices(support, current)
    if (choices.length === 0) {
      this.addNotice(`model ${this.options.getSelection().model} has no reasoning levels`, 'error')
      return
    }
    const theme = this.themes.current
    const selector = new ThinkingSelector(
      choices.map((choice) => ({
        id: choice.id,
        name: choice.name,
        ...(choice.description === undefined ? {} : { description: choice.description }),
      })),
      current,
      theme,
      selectListThemeOf(theme),
      (id) => {
        this.closeThinkingPicker()
        if (this.commitThinking(id)) this.showStatus(`thinking level: ${id ?? 'default'}`)
      },
      () => { this.closeThinkingPicker() },
      support?.defaultEffort,
    )
    selector.focused = true
    this.thinkingText.setText('')
    this.panels.show(selector)
  }

  /** Close the selector and restore the dock. */
  private closeThinkingPicker(): void {
    this.panels.hide()
  }

  /**
   * Mount the dock's permanent rows, in order.
   *
   * One method rather than four `addChild` calls at each site: a selector that
   * takes the dock over calls `clear()`, and every row it removed has to come
   * back. The previous code re-added them inline in the constructor only, so a
   * closed selector left the dock empty.
   */
  private restoreDock(): void {
    for (const row of this.dockRows) this.aboveInput.addChild(row)
  }

  // ── session switch (`/resume`) ─────────────────────────────────────────────

  /**
   * `/resume [id]`: open the session list, or resume one id directly.
   *
   * The state machine lives in {@linkcode ResumeController} — this supplies the
   * host calls and paints the panel. What is left here is the two things the
   * controller cannot know: where the panel is drawn and how a status line reads.
   *
   * @param argument - the text after `/resume`.
   */
  private async applyResume(argument: string): Promise<void> {
    await this.resumeList.open(argument)
    this.renderResumePicker()
  }

  /**
   * Mount or refresh the `/resume` picker.
   *
   * A `SelectList` between two rules (`resume-selector.ts`), replacing the
   * hand-windowed string: `SelectList` already computes its visible range from
   * the cursor, and computing it twice meant the visible rows and the highlighted
   * row were produced by different code — they disagreed after a page.
   *
   * The rows change under the user (a page of titles arrives asynchronously), so
   * this rebuilds in place and keeps the cursor; see `ResumeSelector.setChoices`.
   */
  private renderResumePicker(): void {
    const view = this.resumeList.view
    if (view === undefined) {
      this.closeResumePicker()
      return
    }
    const palette = this.themes.current
    const selectTheme = selectListThemeOf(palette)
    const onSelect = (id: string): void => {
      this.resumeList.close()
      this.resumeList.resume(id)
      this.closeResumePicker()
    }
    const onCancel = (): void => {
      this.resumeList.close()
      this.closeResumePicker()
    }
    // Already mounted means a page of titles arrived (or the cursor moved): update
    // it in place. Otherwise this is the open, so build the panel.
    const mounted = this.panels.current
    if (mounted instanceof ResumeSelector) {
      // `view.index` is the controller's cursor and it is authoritative: the
      // component must show *that* row, or enter resumes a session the user is not
      // looking at.
      mounted.setChoices(view.choices, selectTheme, onSelect, onCancel, view.index)
      this.requestRender()
      return
    }
    this.panels.show(new ResumeSelector({
      choices: view.choices,
      selected: view.choices[view.index]?.id,
      currentId: this.options.getSessionId(),
      selectTheme,
      palette,
      onSelect,
      onCancel,
    }))
  }

  /** Unmount the picker and restore the dock. */
  private closeResumePicker(): void {
    this.panels.hide()
  }

  /**
   * Route one key against the open session picker.
   *
   * The controller decides what the key means; this repaints after it, because a
   * move may have paged in new titles.
   */
  private handleResumePickerKey(data: string): { consume?: boolean } | undefined {
    if (this.resumeList.view === undefined) return undefined
    // The controller still decides what the key *means* (it owns the paging and
    // the title cache); the component only decides what is highlighted.
    this.resumeList.handleKey((name) => matchesKey(data, name))
    this.renderResumePicker()
    return { consume: true }
  }

  // ── theme ──────────────────────────────────────────────────────────────────

  /**
   * Open the theme selector.
   *
   * pi's shape (`ThemeSelectorComponent`): a `SelectList` between two rules,
   * mounted in the dock. The previous version painted a string into `themeText`,
   * which could not do the one thing that makes a theme picker usable — preview.
   * `onPreview` recolours the TUI as the cursor moves, so a theme is chosen by
   * looking at it rather than by reading its name.
   */
  private openThemePicker(): void {
    if (this.themes.openPicker() === undefined) return
    const palette = this.themes.current
    const selector = new ThemeSelector({
      themes: this.themes.catalogue.map((choice) => ({
        name: choice.name,
        appearance: choice.appearance,
        ...(choice.sourcePath === undefined ? {} : { sourcePath: choice.sourcePath }),
      })),
      current: palette.name,
      selectTheme: selectListThemeOf(palette),
      palette,
      onSelect: (name) => {
        this.themes.apply(name)
        this.closeThemePicker()
      },
      onCancel: () => {
        // Cancel restores the theme the picker opened on: a preview that stuck
        // after `esc` would make escape mean "keep the last thing I hovered".
        this.themes.apply(this.themePickerOrigin ?? palette.name)
        this.closeThemePicker()
      },
      onPreview: (name) => {
        this.themePickerOrigin ??= palette.name
        this.themes.apply(name)
      },
    })
    this.themeText.setText('')
    this.panels.show(selector)
  }

  /** The theme in effect when the picker opened, for `esc` to restore. */
  private themePickerOrigin: string | undefined

  /** Close the theme selector and restore the dock. */
  private closeThemePicker(): void {
    this.themePickerOrigin = undefined
    this.themes.closePicker()
    this.panels.hide()
    this.refreshInteraction()
  }

  private applyThemeByName(name: string): void {
    const applied = this.themes.apply(name)
    if (applied === undefined) {
      this.addNotice(`unknown theme "${name}" (try /theme)`, 'error')
      return
    }
    this.showStatus(`theme → ${name}`)
  }

  /** Repaint everything whose colors are baked into strings. */
  private repaintChrome(): void {
    this.paintBanner()
    this.status.refresh()
    this.requestRender()
  }

  /** (Re)paint the startup banner (colors are baked into its strings). */
  private paintBanner(): void {
    this.banner.clear()
    const route = this.options.getSelection()
    const { lines } = renderBanner(this.themes.current, {
      version: this.options.version,
      model: `${route.provider}/${route.model}`,
      cwd: this.cwd(),
      sessionId: this.options.getSessionId(),
    })
    for (const line of lines) this.banner.addChild(new Text(line, 0, 0))
  }

  /**
   * The directory path completions and the banner run against (the session cwd).
   */
  private cwd(): string {
    return this.options.cwd
  }

  // ── transcript + notices ───────────────────────────────────────────────────

  /**
   * Bind the transcript: rebuild the messages container from its rows on every
   * repaint, coalesced to one flush per {@linkcode REPAINT_FLUSH_MS}.
   *
   * `/clear` is a **view** operation, so it is modelled as a watermark rather
   * than a one-off `Container.clear()`: the flush rebuilds from `rows` on every
   * tick, so clearing the container alone made the whole conversation reappear
   * on the next event. {@linkcode visibleFrom} is the index of the first row
   * that may be painted; the rows (and the session log) are untouched.
   *
   * @param state - the transcript state owned by the runner.
   */
  mountTranscript(state: TranscriptState): void {
    this.transcript = state
    // A newly bound transcript is a new view: a watermark left over from a
    // previous binding would hide rows that start at index 0 again (a cleared
    // view followed by a shorter row list rendered as permanently blank).
    this.visibleFrom = 0
    let scheduled: ReturnType<typeof setTimeout> | undefined
    const flush = (): void => {
      scheduled = undefined
      const theme = this.themes.current
      const md = markdownThemeOf(theme)
      // Rows added after a clear are kept; only the pre-clear prefix is hidden.
      const live = visibleRows(state, this.visibleFrom)
      // Everything folds by default; `ctrl+o` opens the whole transcript and a
      // click opens one row. This is the whole point: a transcript that is
      // expanded by default is unreadable the moment a tool returns a file.
      //
      // One options object per frame, and the theme itself rather than an adapter
      // over it: the renderers paint straight through `Theme.fg` / `Theme.bg`
      // (`message-view.ts`), so there is no capability object to keep in sync.
      const options: RenderOptions = {
        fold: this.fold,
        imageData: (image) => this.imageCache.get(image.attachmentId),
        onToggle: (target) => { this.toggleRow(target) },
      }
      const rendered = live.map((row) => {
        const signature = rowSignature({
          row,
          themeName: theme.name,
          fold: this.fold,
          attachTime: state.attachTime,
        })
        const cached = this.rowComponents.get(row)
        if (cached !== undefined && cached.signature === signature) return cached.component
        const component = renderRow(row, theme, md, options)
        this.rowComponents.set(row, { signature, component })
        return component
      })
      syncChildren(this.messages, rendered)
      // Queue reads for images this frame could not resolve, then repaint once
      // they land. Doing it here (not in `renderRow`) keeps rendering pure.
      for (const row of live) this.prefetchImages(row)
      // Repaint only. `requestRender()` would also re-arm `scheduleRender`, so the
      // flush would schedule itself forever — a full rebuild every 50 ms even
      // when nothing changed, which is what made the screen feel sluggish.
      this.activeTui.requestRender()
    }
    this.scheduleRender = (): void => {
      if (scheduled !== undefined) return
      scheduled = setTimeout(flush, REPAINT_FLUSH_MS)
    }
    flush()
  }

  /**
   * Append one component to the notices area.
   *
   * The bound and the container live in {@linkcode NoticeLog}; this exists for
   * callers that already hold a component (the runner's own messages).
   *
   * @param component - the child to mount.
   */
  addMessage(component: Component): void {
    this.noticeLog.add(component)
  }

  /**
   * Report one durable line (content or error) to the user.
   *
   * Public because the runner owns failures the app cannot see — a session
   * switch that dsh rejected, for instance. Durable on purpose: an expiring error
   * would hide the reason a command failed.
   *
   * @param text - the message body.
   * @param tone - theme token to color it with.
   */
  notify(text: string, tone: 'text' | 'dim' | 'muted' | 'error' = 'text'): void {
    this.noticeLog.notice(text, tone)
  }

  /**
   * Append one themed notice line.
   *
   * @param text - the message body.
   * @param tone - theme token to color it with.
   */
  private addNotice(text: string, tone: 'text' | 'dim' | 'muted' | 'error'): void {
    this.noticeLog.notice(text, tone)
  }

  /**
   * Report the state of one action on the single self-clearing line.
   *
   * @param text - the message body.
   */
  private showStatus(text: string): void {
    this.noticeLog.status(text)
  }

  /**
   * Hide every row currently in the transcript (the session log is untouched).
   *
   * Moves the visibility watermark past the current rows, so the next flush
   * paints nothing while rows produced afterwards still appear.
   * `clearOnShrink` + `renderNow(true)` are both required: the main screen keeps
   * painted lines in the terminal scrollback, so an empty component tree alone
   * leaves the old conversation visible. The forced redraw emits `ESC[2J`
   * (viewport) + `ESC[3J` (scrollback).
   */
  clearTranscript(): void {
    this.visibleFrom = this.transcript?.rows.length ?? 0
    // `clearOnShrink` forces a full redraw (clear viewport + clear scrollback)
    // whenever the tree shrinks. That is exactly what `/clear` needs — and
    // exactly what must not stay on afterwards: with it enabled, any render that
    // happens to produce fewer lines repaints the whole screen and wipes the
    // scrollback the conversation is supposed to live in.
    //
    // So it is enabled for one render and turned off immediately: the redraw has
    // already happened by the time `renderNow` returns.
    this.tui.setClearOnShrink(true)
    this.messages.clear()
    // Drops the notices and the status line together: the line was mounted
    // among them, so its pointer and countdown have to go with the container or
    // the next `showStatus()` would call `setText()` on an unmounted component.
    this.noticeLog.clear()
    this.tui.renderNow(true)
    this.tui.setClearOnShrink(false)
  }

  // ── status + activity ──────────────────────────────────────────────────────

  /**
   * Apply one streaming tick: only the timing segment changed.
   *
   * The cheap path — safe on every chunk. It must NOT re-read the status facts:
   * that would fold the whole durable log, read session projections and touch
   * `git HEAD` once per token (measured: 50 calls → 50 fact reads).
   *
   * @param timing - the timing segment, or `''` to hide it.
   */
  updateTiming(timing: string): void {
    // Transcript content changes on the same ticks (a streamed token appends to
    // an open row), so this schedules both surfaces on the one coalescing window
    // rather than firing a second repaint per token.
    this.status.setTiming(timing)
    this.scheduleRender?.()
  }

  /**
   * Apply one session change: fresh facts, optionally with a new timing segment
   * in the same repaint.
   *
   * The expensive path — call it on session events (a new event, a turn
   * boundary, a model switch), never per chunk.
   *
   * @param timing - the timing segment to apply with the facts, if it changed.
   */
  refreshStatus(timing?: string): void {
    this.status.refresh(timing)
  }

  /**
   * Show or hide the activity indicator in the editor's top border.
   *
   * pi's shape (`CustomEditor.renderTopBorder`): the status rides *inside* the
   * composer's frame, so it costs no transcript row. The previous build put it on
   * its own line above the editor, which on a short terminal pushed the input off
   * screen exactly while the user wanted to type.
   *
   * The indicator owns its own animation timer (`Loader`), so starting it here is
   * the only place a periodic repaint is armed — and stopping it is what prevents
   * one from outliving the work.
   *
   * @param text - the label, or `''` to detach the indicator.
   */
  setWorking(state: RunState): void {
    // The in-window indicator and the terminal's own channels answer the same
    // question, so this is where the one state fans out to both — but only the
    // indicator is decided here. `ProgramStatusReporter` owns the terminal side
    // (spinner, OSC 7501), because three channels derived in two places is how
    // they come to disagree.
    const text = state.state === 'working' ? state.message ?? 'working…' : ''
    if (text === '') this.editor.setIndicator(undefined)
    else this.editor.setIndicator(new StatusIndicator(this.activeTui, this.themes.current, text))
    this.programStatus.setRunState(state)
    this.requestRender()
  }

  /**
   * Feed one session event to the terminal status reporter.
   *
   * Most events carry no outcome; `turn/end` does. The rule lives in
   * `applySessionEvent` so it is testable — the runner is end-to-end glue and an
   * `if` there can be deleted with no test noticing.
   *
   * @param event - one session event.
   */
  reportSessionEvent(event: { type: string; data?: unknown }): void {
    applySessionEvent(this.programStatus, event)
  }

  /**
   * Mirror the pending-dialog state onto the terminal.
   *
   * Called whenever the interaction state changes: a pending approval is the one
   * transition a user must see from **outside** the window, because that is the
   * only channel that can bring them back to it.
   */
  private syncBlockedStatus(): void {
    if (this.interactions.busy) {
      this.programStatus.setBlocked('interaction', { message: 'waiting for your answer' })
      return
    }
    this.programStatus.clearBlocked('interaction')
  }

  /** Refresh the inline interaction panel from the manager's current view. */
  refreshInteraction(): void {
    this.interactionText.setText(renderInteractionPanel(this.interactions.current))
    this.requestRender()
  }

  // ── slash-command discovery ────────────────────────────────────────────────

  private installAutocomplete(): void {
    // Argument completions render INSIDE the editor's frame (pi-tui draws them
    // under the input row, within its borders) — that is how pi shows the model
    // picker. An overlay would float over the transcript and detach the list
    // from the text being typed.
    //
    // The provider rebuilds its command table per request (`LiveSlashProvider`),
    // so `listHostCommands` is read when the menu opens — not frozen when the
    // editor is constructed.
    this.editor.setAutocompleteProvider(new LiveSlashProvider(
      this.cwd(),
      () => buildCommands({
        listHostCommands: () => [...(this.options.listHostCommands?.() ?? [])],
        listSkills: () => [...(this.options.listSkills?.() ?? [])],
        listThemes: () => this.themes.catalogue.map((choice) => choice.name),
      }),
    ))
  }

  // ── key arbitration ────────────────────────────────────────────────────────

  /**
   * Top-level routing: a priority stack, first consumer wins.
   *
   * ## Why a stack instead of a cascade
   *
   * This was an `if` chain with an early `return` per modal surface: exit, then
   * the model panel, then the pickers, then `ctrl+o`, then the interaction keys.
   * It worked, but "the panel must see keys before the app" was encoded as *line
   * order inside one function*, so adding a surface meant editing this method —
   * the same closed-set problem the transcript entry types had. It also meant the
   * app's own keys could not be rebound: they were `matchesKey(data, 'ctrl+c')`
   * literals, invisible to `keybindings.json`.
   *
   * A {@linkcode KeyScope} list fixes both: priority is list order (declarative
   * and testable), and matching goes through the installed registry, so a user's
   * binding reaches every consumer at once.
   *
   * The order is exactly what the cascade encoded:
   *
   * 1. **exit** — always, from every surface. A modal panel must not be able to
   *    trap the user, and the old cascade checked the exit keys before the panels
   *    for this reason. Putting it back at the top is not "special-casing a
   *    key": it is the one action whose scope is "everywhere", and a stack is
   *    exactly the right place to say so;
   * 2. **modal surfaces** — a picker standing in for the editor must not leak
   *    typing into the hidden input row;
   * 3. **interaction** — a pending approval or question owns the keyboard, since
   *    the view behind it is not what the user is looking at;
   * 4. **app actions** — fold;
   * 5. **editor** — reached by *not* consuming, which is what `undefined` means.
   *
   * Note the two halves of `app.*` are deliberately in different places: exit is
   * universal, fold is not. Collapsing them into one scope at the top would let
   * `ctrl+o` steal the key from an open panel.
   *
   * @param data - the raw input chunk from the terminal.
   * @returns `{ consume: true }` when something took the key; `undefined` lets
   *   pi-tui forward it to the focused component.
   */
  private handleInput(data: string): { consume?: boolean } | undefined {
    // Kitty protocol reports presses, releases and repeats on the same channel.
    // A release must never re-trigger an action: holding `ctrl+c` would otherwise
    // fire `onExit` on every release frame.
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined
    return routeKey(this.keyScopes, data) ? { consume: true } : undefined
  }

  /**
   * The live priority stack.
   *
   * Built per keystroke rather than cached: two of the four scopes close over
   * state that changes (`modelPanel`, `interactions.current`) and a third over
   * the picker that is open. Rebuilding is four object literals; caching it would
   * be a stale-reference bug waiting to happen.
   */
  private get keyScopes(): readonly KeyScope[] {
    return [
      // Exit is universal: it must work from inside any modal surface, which is
      // where a user reaches for it. See the ordering note above.
      // Suspend sits above even exit: it is the one action that must work from a
      // modal panel too. A user who wants to step away from a pending approval
      // should not have to answer it first, and the alternative (ctrl+c) discards
      // the session.
      actionScope('suspend', {
        'app.suspend': () => { this.handleSuspend() },
      }, this.keybindings),
      // A modal panel owns `ctrl+c`, exactly as pi's `app.clear` never fires while a
      // picker holds focus. Yielding rather than swallowing keeps the scope's answer
      // truthful: it consumed the key only if it acted on it, so the panel below gets
      // it and the double-press window is not armed by a press the user cannot see
      // the effect of.
      this.panelOpen()
        ? { name: 'exit', handle: () => false }
        : actionScope('exit', {
            'app.clear': () => { this.handleInterrupt() },
            'app.exit': () => { this.handleEndOfInput() },
          }, this.keybindings),
      { name: 'model-panel', handle: (data) => this.scopeModelPanel(data) },
      { name: 'pickers', handle: (data) => this.scopePickers(data) },
      { name: 'interaction', handle: (data) => this.handleInteractionKey(data) !== undefined },
      // Fold is *not* universal: a pending approval or question owns the keyboard
      // first, because the transcript behind it is not what the user is looking
      // at.
      //
      // Filtered here rather than inside the handler on purpose. A handler that
      // checks `busy` itself reports "consumed" even though nothing happened —
      // the key then vanishes instead of falling through to whoever else might
      // want it. Declining keeps a scope's answer truthful: it consumed this key
      // only if it acted on it.
      // Clipboard is deliberately outside the `busy` guard below. Pasting while an
      // approval is pending is a plausible thing to want (the user is composing a
      // reply *about* the approval), and unlike fold it does not compete for the
      // transcript's attention — it writes into the editor, which the approval
      // panel does not cover.
      actionScope('clipboard', {
        'app.clipboard.pasteImage': () => { void this.pasteFromClipboard() },
      }, this.keybindings),
      this.interactions.busy
        ? { name: 'view', handle: () => false }
        : actionScope('view', {
            'app.tools.expand': () => { this.toggleFold() },
            // `/model` already did this; the key was the only thing missing.
            'app.model.select': () => { void this.openModelPanel() },
            'app.model.cycleForward': () => { void this.cycleModel(1) },
            'app.model.cycleBackward': () => { void this.cycleModel(-1) },
            'app.thinking.toggle': () => { this.toggleThinking() },
            'app.thinking.cycle': () => { void this.cycleThinkingLevel() },
          }, this.keybindings),
    ]
  }

  /**
   * The model panel's claim on the keyboard.
   *
   * @param data - the input chunk.
   * @returns whether the panel consumed it (always true while it is open).
   */
  private scopeModelPanel(data: string): boolean {
    if (this.modelPanel === undefined) return false
    // Modal: it must see every key, or typing leaks into the (hidden) input row.
    handleModelPanelKey(this.modelPanel, data, (name) => matchesKey(data, name))
    this.requestRender()
    return true
  }

  /**
   * The three selectors' claim on the keyboard.
   *
   * @param data - the input chunk.
   * @returns whether an open picker consumed it.
   */
  private scopePickers(data: string): boolean {
    // `/resume` keeps its own routing: the controller owns the paging and the
    // title cache, so a key has to reach it *and* the component.
    if (this.resumeList.view !== undefined) {
      this.handleResumePickerKey(data)
      return true
    }
    // Everything else is "forward to whatever the dock is hosting".
    return this.panels.handleKey(data)
  }

  /**
   * Expand or collapse the whole transcript.
   *
   * pi binds `ctrl+o` to `app.tools.expand`, whose handler broadcasts
   * `setExpanded()` to every expandable child — one global switch, not a cursor.
   * The same key here means the same thing: no selected row to track, and the
   * key restores a uniform view (per-row clicks are dropped, see
   * {@linkcode TranscriptFold.toggleAll}).
   */
  private toggleFold(): void {
    const expanded = this.fold.toggleAll()
    // One status line, updated in place and expiring (see
    // {@linkcode showStatus}). An *appended* notice here is what the user
    // reported: every press left another `transcript: expanded / collapsed`
    // line above the prompt that never went away.
    this.showStatus(`transcript: ${expanded ? 'expanded' : 'collapsed'}`)
    this.scheduleRender?.()
  }

  /**
   * Read the bytes for any image on `row` that is not cached yet.
   *
   * One read per attachment: a re-flush happens on every stream chunk, so an
   * uncached id would otherwise be requested dozens of times per second.
   *
   * @param row - the row to scan for images.
   */
  private prefetchImages(row: TranscriptRow): void {
    const read = this.options.readImage
    if (read === undefined) return
    const images = row.kind === 'user' || row.kind === 'tool' ? row.images ?? [] : []
    for (const image of images) {
      const id = image.attachmentId
      if (this.imageCache.has(id) || this.imagePending.has(id)) continue
      this.imagePending.add(id)
      void read(id).then((data) => {
        this.imagePending.delete(id)
        if (data === undefined) return
        this.imageCache.set(id, data)
        this.scheduleRender?.()
      }).catch(() => { this.imagePending.delete(id) })
    }
  }

  /**
   * Flip one row's expansion.
   *
   * The fold holds the *overrides*, so opening a row is an insert and closing it
   * a delete; the global switch decides the default they invert.
   *
   * @param row - the clicked row.
   */
  private toggleRow(row: TranscriptRow): void {
    this.fold.toggle(row)
    this.scheduleRender?.()
  }

  /**
   * Route one key against the pending interaction.
   *
   * The decision itself lives in `interactionIntent()` (pure, tested); this
   * method only performs the effect. ESC now cancels questions too — it used
   * to cancel approvals only, so a pending question could not be dismissed at
   * all (the only way out was quitting the whole TUI).
   */
  private handleInteractionKey(data: string): { consume?: boolean } | undefined {
    const digit = /^[1-9]$/.exec(data)?.[0]
    const intent = interactionIntent(
      this.interactions.current,
      (name) => matchesKey(data, name),
      digit === undefined ? undefined : Number(digit),
    )
    switch (intent.kind) {
      case 'pass-through':
        return undefined
      case 'ignore':
        return { consume: true }
      case 'allow-approval':
        this.interactions.allowApproval()
        return { consume: true }
      case 'reject-approval':
        this.interactions.rejectApproval()
        return { consume: true }
      case 'cancel':
        this.interactions.cancelByUser()
        return { consume: true }
      case 'answer-option':
        this.interactions.answerQuestion(intent.label)
        return { consume: true }
    }
  }
}

/** Re-export for callers that only import the app (runner/tests). */
export type { Theme }
