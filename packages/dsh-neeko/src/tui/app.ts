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
 * | picker text + keys | `theme-picker.ts` |
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
import { Editor } from '@earendil-works/pi-tui'
import { Container } from '@earendil-works/pi-tui'
import { Text } from '@earendil-works/pi-tui'
import { ProcessTerminal } from '@earendil-works/pi-tui'
import type { Terminal } from '@earendil-works/pi-tui'
import type { SelectListTheme } from '@earendil-works/pi-tui'
import { matchesKey, isKeyRelease, isKeyRepeat } from '@earendil-works/pi-tui'
import type { Component, TUI } from '@earendil-works/pi-tui'
import { buildCommands } from './commands.ts'
import { LiveSlashProvider } from './slash-provider.ts'
import { renderThemePicker } from './theme-picker.ts'
import { renderPanel, runPickerKey } from './picker.ts'
import { listWindow, overflowMarkers } from './window.ts'
import { NoticeLog } from './notice-log.ts'
import { rowSignature, syncChildren, visibleRows } from './row-cache.ts'
import { ResumeController } from './resume-controller.ts'
import { buildModelPanel, handleModelPanelKey } from './model-panel.ts'
import type { ModelPanel } from './model-panel.ts'
import { markdownThemeOf } from './theme.ts'
import { renderBanner } from './banner.ts'
import type { TranscriptRow, TranscriptState } from './transcript.ts'
import { renderOptionsFor, renderRow } from './transcript-view.ts'
import type { ThemeCapabilities } from './transcript-view.ts'
import { TranscriptFold } from './fold.ts'
import { mountFullscreen } from './fullscreen.ts'
import type { Fullscreen, ScreenMode } from './fullscreen.ts'
import { InteractionManager, interactionIntent, renderInteractionPanel } from './interactions.ts'
import { ThemeController } from './theme-controller.ts'
import { StatusController } from './status-controller.ts'
import type { LiveStatusFacts } from './status-controller.ts'
import { CommandController } from './command-controller.ts'
import type { ModelChoice } from './command-controller.ts'
import { resumeHint } from './resume-hint.ts'
import { renderThinkingPicker, thinkingChoices, thinkingOutcome } from './thinking.ts'
import type { ThinkingPickerView, ReasoningSupport } from './thinking.ts'
import type { ResumeSource } from './resume-list.ts'
import type { Theme } from './theme.ts'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'

/** Plain (colorless) select-list theme; a real palette is R3 scope. */
const selectListTheme: SelectListTheme = {
  selectedPrefix: (text: string) => `> ${text}`,
  selectedText: (text: string) => text,
  description: (text: string) => text,
  scrollInfo: (text: string) => text,
  noMatch: (text: string) => text,
}

/** Plain (colorless) editor theme; a real palette is R3 scope. */
const editorTheme = {
  borderColor: (text: string) => text,
  selectList: selectListTheme,
}

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

/** Session rows rendered before the panel scrolls (matches the theme picker). */
const RESUME_PANEL_MAX_VISIBLE = 10

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
const THINKING_FRAMES: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Frame interval; 80 ms reads as motion without spending frames on one blink. */
const THINKING_INTERVAL_MS = 80



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
   * Which screen to mount; absent takes the default, the main screen.
   *
   * The type is {@linkcode ScreenMode} rather than a boolean whose default this
   * class gets to define: the default is a project-wide decision, and two layers
   * disagreeing about what `undefined` means is exactly how the flag and the
   * environment ended up inverted. The app performs the decision, it does not
   * make it.
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
  private readonly tui: TuiMainScreen
  private readonly editor: Editor
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
   * the alt screen as its `aboveInput` slot. Enumerating these panels in
   * `mountFullscreen()` is what made `/thinking` and `/theme` invisible in the
   * default fullscreen mode while their keys still worked.
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
  private readonly working: Text
  private readonly interactionText: Text
  private readonly themeText: Text
  /** Its own panel line: a picker that renders into another's slot is a trap. */
  private readonly thinkingText: Text
  /**
   * The open `/thinking` selector, if any.
   *
   * A panel rather than a full-height list: adapter effort sets are a handful of
   * entries, so a `SelectList` with search would be more chrome than content.
   * It owns the keyboard while open (checked in key arbitration alongside the
   * theme picker).
   */
  private thinkingPicker: ThinkingPickerView | undefined
  /** Its own panel line, like the other two selectors. */
  private readonly resumeText: Text
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

  private exited = false
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
  /**
   * The single status line, or `undefined` when nothing is reporting.
   *
   * A view concern like {@linkcode fold}: the flush rebuilds row components, so
   * this cannot live in the notices container's contents or it would be lost.
   */
  /** Countdown that hides {@linkcode statusLine}; one at a time. */
  private readonly terminal: Terminal
  /** The alt-screen surface, while fullscreen is on. */
  private fullscreen: Fullscreen | undefined
  /** Attachment bytes already read, keyed by id (render reads this cache). */
  private readonly imageCache = new Map<string, { base64: string; mediaType: string }>()
  /** Ids currently being read, so one image is fetched once. */
  private readonly imagePending = new Set<string>()
  /** Current spinner glyph; advanced by {@linkcode spinnerTimer}. */
  private spinnerFrame = THINKING_FRAMES[0] ?? '⠋'
  /** Drives {@linkcode spinnerFrame} while something is still streaming. */
  private spinnerTimer: ReturnType<typeof setInterval> | undefined
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
    this.tui = new TuiMainScreen(this.terminal)
    this.themes = new ThemeController(
      options.initialTheme === undefined ? {} : { initialTheme: options.initialTheme },
    )
    this.commands = new CommandController({
      loadModels: async () => (await options.modelPicker()).models,
      ...(options.runHostCommand === undefined ? {} : { runHostCommand: options.runHostCommand }),
    })
    // The controller owns the listing and the paging; the app supplies the host
    // calls and the two ways a result becomes visible.
    this.resumeList = new ResumeController({
      // The host may decline to offer session switching at all (`--session`
      // builds); that is reported once, not per keystroke.
      listSessions: options.listSessions ?? (async () => {
        throw new Error('this build cannot list sessions')
      }),
      ...(options.sessionTitles === undefined ? {} : { sessionTitles: options.sessionTitles }),
      resumeSession: (sessionId) => { options.resumeSession?.(sessionId) },
      currentSessionId: () => options.getSessionId(),
      onStatus: (text) => { this.showStatus(text) },
      onNotice: (text, tone) => { this.addNotice(text, tone) },
    })
    this.status = new StatusController({
      readFacts: options.statusFacts,
      route: () => options.getSelection(),
      theme: () => this.themes.current,
    })

    this.banner = new Container()
    this.messages = new Container()
    this.document = new Container()
    this.document.addChild(this.banner)
    this.document.addChild(this.messages)
    // Local command replies scroll with the conversation, so they live in the
    // document — *not* in the fixed rows above the editor.
    //
    // They were mounted in `aboveInput` until a `/compact` reply ("No
    // compactable history yet.") was found pinned under the transcript, never
    // scrolling with the conversation it answered. pi does not write command
    // outcomes to a fixed area either: `/compact` calls `session.compact()` and
    // the result arrives as a chat entry.
    //
    // A separate container from `messages` is still required: `mountTranscript`
    // rebuilds its container on every flush, so a reply written there would vanish
    // on the next repaint.
    this.noticeLog = new NoticeLog({
      ...(options.statusNoticeMs === undefined ? {} : { statusMs: options.statusNoticeMs }),
      paint: (token, text) => this.themes.current.fg(token, text),
      onChange: () => { this.requestRender() },
    })
    this.document.addChild(this.noticeLog.container)
    this.inputSlot = new Container()
    this.aboveInput = new Container()
    this.working = new Text('')
    this.interactionText = new Text('')
    this.themeText = new Text('')
    this.thinkingText = new Text('')
    this.resumeText = new Text('')
    // pi's model list shows ten rows before scrolling (`(1/205)` below them);
    // the editor renders the same list, so the same bound applies here.
    // The editor is handed a *proxy* for the renderer, not the main screen.
    //
    // `Editor` stores its `tui` in the constructor and uses it for
    // `requestRender()` (notably when the autocomplete menu opens). Fullscreen
    // swaps the live renderer, so a captured reference would keep repainting the
    // stopped main screen — the menu would compute its rows and never appear.
    this.editor = new Editor(this.rendererProxy, editorTheme, {
      autocompleteMaxVisible: AUTOCOMPLETE_MAX_VISIBLE,
    })

    this.tui.addChild(this.document)
    this.aboveInput.addChild(this.working)
    this.aboveInput.addChild(this.interactionText)
    this.aboveInput.addChild(this.themeText)
    this.aboveInput.addChild(this.thinkingText)
    this.aboveInput.addChild(this.resumeText)
    this.tui.addChild(this.aboveInput)
    this.inputSlot.addChild(this.editor)
    this.tui.addChild(this.inputSlot)
    this.tui.addChild(this.status.component)
    this.tui.setFocus(this.editor)

    this.editor.onSubmit = (text: string) => { void this.submit(text) }
    this.installAutocomplete()
    this.tui.addInputListener((data) => this.handleInput(data))

    this.interactions.onChange = () => this.refreshInteraction()
    this.themes.onChange = () => this.repaintChrome()
    this.status.onChange = () => this.activeTui.requestRender()
    // Warm the catalogue so `/model ` completes without a round trip.
    void this.commands.ensureModels()
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Enter raw mode and start rendering. */
  start(): void {
    this.paintBanner()
    this.status.refresh()
    // Fullscreen starts *instead of* the main screen, not on top of it: the two
    // renderers share one terminal, so whichever starts last owns the mode.
    //
    // The default is the terminal-owned main screen: it needs no mount step at
    // all, because `TuiMainScreen` simply appends to the terminal and the
    // terminal keeps the scrollback. Only the alt screen has to be entered.
    if ((this.options.screenMode ?? 'main') === 'fullscreen') {
      this.enterFullscreen()
      return
    }
    this.tui.start()
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
    this.syncSpinner(false)
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
    //    for a `VStack` layout root (see `fullscreen.ts`) — the conversation is
    //    gone (measured: 1426 bytes = banner only).
    // 2. Restarting the main screen calls `terminal.start()`, which re-sends the
    //    capability queries (Kitty protocol / device attributes / cell size).
    //    Their replies arrive after we exit, nothing parses them, and the shell
    //    prints the bytes literally: `7u 62;22;52c 34;16t`.
    //
    // So: leave the alt screen, then write the document ourselves.
    this.resumeMainScreenQuietly()
    // A live timer keeps the event loop alive and would fire into a stopped
    // screen; clear the status line on the way out.
    this.noticeLog.clearStatus()
    this.printFinalDocument()
  }

  /**
   * Write the transcript to the terminal's normal buffer, then stop.
   *
   * Rendered straight from this app's own containers (document, dock, input slot,
   * status) rather than through `TuiMainScreen.start()` — see {@linkcode stop}
   * for why that path is unusable on quit.
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
    // pi closes its TUI with a one-line "how do I get back in" (§`resume-hint`),
    // and so do we — as the last row of the printed document, so it stays in the
    // terminal's scrollback next to the conversation it refers to.
    const hint = resumeHint({ sessionId: this.options.getSessionId() })
    if (hint !== undefined) document.push('', this.themes.current.fg('muted', hint))
    // `\n`, not `\r\n`: the terminal is in cooked mode by now, so its ONLCR
    // translation turns `\n` into `\r\n` for us. Writing `\r\n` produced `\r\r\n`
    // (a blank line between every row) on a real pty.
    this.terminal.write(`${document.join('\n')}\n`)
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
   * The main screen never reports pointer clicks (that would take selection,
   * copy and the right-click menu away from the terminal). Fullscreen is the
   * opt-in place for click-to-expand: the alt screen owns its own selection and
   * copy model, so a click costs nothing native — at the cost of scrollback,
   * which is why this is a mode the user asks for rather than the default.
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
   * Idempotent, so boot can call it directly when fullscreen is the default.
   */
  private enterFullscreen(): void {
    if (this.fullscreen !== undefined) return
    this.tui.stop()
    this.fullscreen = mountFullscreen({
      terminal: this.terminal,
      document: this.document,
      aboveInput: this.aboveInput,
      input: this.inputSlot,
      footer: this.status.component,
      onInput: (data) => this.handleInput(data),
    })
    this.fullscreen.screen.setFocus(this.editor)
    this.fullscreen.screen.requestRender(true)
  }

  /**
   * Return to the main screen.
   *
   * `dispose()` prints the final document into scrollback, so the conversation
   * survives the switch. A full repaint is required rather than a diff: the main
   * screen stopped with a frame that no longer matches anything on disk.
   */
  private exitFullscreen(): void {
    if (this.fullscreen === undefined) return
    this.fullscreen.dispose()
    this.fullscreen = undefined
    this.tui.start()
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
        this.commitThinking(outcome.effort)
        return
    }
  }

  /**
   * Apply one effort to the live selection.
   *
   * `undefined` clears it, which the DSH contract reads as "provider default" —
   * the same rule `switchedSelection` follows when changing models.
   *
   * @param effort - the effort to apply, or `undefined` to clear.
   */
  private commitThinking(effort: string | undefined): void {
    const apply = this.options.selectReasoningEffort
    if (apply === undefined) {
      this.addNotice('this build cannot change the reasoning level', 'error')
      return
    }
    try {
      apply(effort)
    } catch (error: unknown) {
      this.addNotice(
        `thinking level not applied: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      )
      return
    }
    // The status bar carries the effort; repaint it so the change is visible
    // without waiting for the next session event.
    this.repaintChrome()
    this.showStatus(`thinking level: ${effort ?? 'default'}`)
  }

  private openThinkingPicker(
    support: ReasoningSupport | undefined,
    current: string | undefined,
  ): void {
    const choices = thinkingChoices(support, current)
    if (choices.length === 0) {
      this.addNotice(`model ${this.options.getSelection().model} has no reasoning levels`, 'error')
      return
    }
    // Start on the level in effect so enter-without-moving is a no-op rather
    // than a silent change.
    const active = choices.findIndex((choice) => choice.current)
    this.thinkingPicker = { choices, index: active < 0 ? 0 : active }
    this.renderThinkingPicker()
  }

  private renderThinkingPicker(): void {
    const view = this.thinkingPicker
    if (view === undefined) return
    this.thinkingText.setText(renderThinkingPicker(view, this.themes.current))
    this.requestRender()
  }

  private closeThinkingPicker(): void {
    this.thinkingPicker = undefined
    this.thinkingText.setText('')
    this.requestRender()
  }

  /**
   * Route one key against the open thinking picker.
   *
   * `runPickerKey()` owns the routing (and the clamped cursor rule); this only
   * supplies where the cursor comes from and what confirming does.
   */
  private handleThinkingPickerKey(data: string): { consume?: boolean } | undefined {
    const view = this.thinkingPicker
    return runPickerKey({
      state: view === undefined ? undefined : { index: view.index, length: view.choices.length },
      data,
      isKey: (name) => matchesKey(data, name),
      onMove: (index) => {
        if (view === undefined) return
        this.thinkingPicker = { choices: view.choices, index }
        this.renderThinkingPicker()
      },
      onClose: () => { this.closeThinkingPicker() },
      onConfirm: () => {
        const chosen = view?.choices[view.index]
        this.closeThinkingPicker()
        if (chosen !== undefined) this.commitThinking(chosen.id)
      },
    })
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

  /** Paint the open `/resume` panel, or clear the line when it is closed. */
  private renderResumePicker(): void {
    const view = this.resumeList.view
    if (view === undefined) {
      this.resumeText.setText('')
      this.requestRender()
      return
    }
    // Windowed like the theme catalogue: the corpus here is every session on the
    // machine (426 on this one), and rendering them all would push the editor
    // off screen while the picker still owned the keyboard.
    const window = listWindow(view.choices.length, view.index, RESUME_PANEL_MAX_VISIBLE)
    const [hiddenAbove, hiddenBelow] = overflowMarkers(window, (token, text) => this.themes.current.fg(token, text))
    this.resumeText.setText(renderPanel({
      title: 'Resume session',
      rows: view.choices.slice(window.start, window.end).map((choice) => ({
        text: choice.text,
        active: choice.current,
      })),
      index: window.cursorRow,
      theme: this.themes.current,
      hint: window.total > window.end - window.start
        ? `↑/↓ move · ${window.total} total`
        : undefined,
      notes: [hiddenAbove, hiddenBelow].filter((marker) => marker !== ''),
    }))
    this.requestRender()
  }

  /**
   * Route one key against the open session picker.
   *
   * The controller decides what the key means; this repaints after it, because a
   * move may have paged in new titles.
   */
  private handleResumePickerKey(data: string): { consume?: boolean } | undefined {
    if (this.resumeList.view === undefined) return undefined
    this.resumeList.handleKey((name) => matchesKey(data, name))
    this.renderResumePicker()
    return { consume: true }
  }

  // ── theme ──────────────────────────────────────────────────────────────────

  private openThemePicker(): void {
    if (this.themes.openPicker() === undefined) return
    this.renderThemePicker()
  }

  private renderThemePicker(): void {
    const view = this.themes.picker
    if (view === undefined) return
    this.themeText.setText(renderThemePicker(view, this.themes.current))
    this.requestRender()
  }

  private closeThemePicker(): void {
    this.themes.closePicker()
    this.themeText.setText('')
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
      const options = renderOptionsFor({
        theme,
        fold: this.fold,
        spinnerFrame: this.spinnerFrame,
        imageData: (image) => this.imageCache.get(image.attachmentId),
        onToggle: (target) => { this.toggleRow(target) },
      })
      // One capability object per frame, not per row: both `fg` and `bold` come
      // from the theme, and this runs inside the repaint loop. Arrow wrappers are
      // required (not `theme.fg` itself) because `Theme`'s members are methods
      // bound to their instance; the shape is otherwise exactly
      // `ThemeCapabilities`.
      const capabilities: ThemeCapabilities = {
        fg: (token, text) => theme.fg(token, text),
        bold: (text) => theme.bold(text),
      }
      const rendered = live.map((row) => {
        const signature = rowSignature({
          row,
          themeName: theme.name,
          fold: this.fold,
          spinnerFrame: this.spinnerFrame,
          attachTime: state.attachTime,
        })
        const cached = this.rowComponents.get(row)
        if (cached !== undefined && cached.signature === signature) return cached.component
        const component = renderRow(row, capabilities, md, options)
        this.rowComponents.set(row, { signature, component })
        return component
      })
      syncChildren(this.messages, rendered)
      // Queue reads for images this frame could not resolve, then repaint once
      // they land. Doing it here (not in `renderRow`) keeps rendering pure.
      for (const row of live) this.prefetchImages(row)
      this.syncSpinner(live.some((row) => row.kind === 'assistant' && !row.done))
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
    this.tui.setClearOnShrink(true)
    this.messages.clear()
    // Drops the notices and the status line together: the line was mounted
    // among them, so its pointer and countdown have to go with the container or
    // the next `showStatus()` would call `setText()` on an unmounted component.
    this.noticeLog.clear()
    this.tui.renderNow(true)
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

  /** Update the working/status line; empty string hides it. */
  setWorking(text: string): void {
    this.working.setText(text)
    this.requestRender()
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
   * Top-level routing. Priority: exit → model panel → theme picker → fold →
   * interaction → editor.
   *
   * Returning `undefined` lets pi-tui pass the key to the focused component
   * (the editor); `{ consume: true }` swallows it.
   */
  private handleInput(data: string): { consume?: boolean } | undefined {
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined
    if (matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+d')) {
      this.options.onExit()
      return { consume: true }
    }
    // The model panel is a modal surface standing in for the editor: it must see
    // every key first, or typing would leak into the (hidden) input row.
    if (this.modelPanel !== undefined) {
      handleModelPanelKey(this.modelPanel, data, (name) => matchesKey(data, name))
      this.requestRender()
      return { consume: true }
    }
    if (this.resumeList.view !== undefined) return this.handleResumePickerKey(data)
    if (this.thinkingPicker !== undefined) return this.handleThinkingPickerKey(data)
    if (this.themes.isPickerOpen) return this.handleThemePickerKey(data)
    // `ctrl+o` flips the whole transcript, then repaints. A pending approval or
    // question owns the keyboard first: the view behind it is not the surface
    // the user is looking at.
    if (!this.interactions.busy && matchesKey(data, 'ctrl+o')) {
      this.toggleFold()
      return { consume: true }
    }
    return this.handleInteractionKey(data)
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
   * Run the spinner only while something is actually streaming.
   *
   * A timer that outlives the work keeps repainting a settled transcript at
   * {@linkcode THINKING_INTERVAL_MS} forever — measurable CPU for an animation
   * nobody can see. Starting/stopping on demand is what makes the window between
   * "streaming" and "idle" the only time it costs anything.
   *
   * @param active - whether an unfinished assistant row is on screen.
   */
  private syncSpinner(active: boolean): void {
    if (!active) {
      if (this.spinnerTimer !== undefined) {
        clearInterval(this.spinnerTimer)
        this.spinnerTimer = undefined
      }
      this.spinnerFrame = THINKING_FRAMES[0] ?? '⠋'
      return
    }
    if (this.spinnerTimer !== undefined) return
    let index = 0
    this.spinnerTimer = setInterval(() => {
      index = (index + 1) % THINKING_FRAMES.length
      this.spinnerFrame = THINKING_FRAMES[index] ?? THINKING_FRAMES[0] ?? '⠋'
      this.activeTui.requestRender()
    }, THINKING_INTERVAL_MS)
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

  private handleThemePickerKey(data: string): { consume?: boolean } | undefined {
    const view = this.themes.picker
    return runPickerKey({
      state: view === undefined ? undefined : { index: view.index, length: view.choices.length },
      data,
      isKey: (name) => matchesKey(data, name),
      // The controller owns this cursor, so it takes the delta itself (and
      // applies the same clamp); recomputing an index here would be a second
      // copy of the cursor rule.
      onMove: (_index, delta) => {
        this.themes.movePicker(delta)
        this.renderThemePicker()
      },
      onClose: () => { this.closeThemePicker() },
      onConfirm: () => { this.confirmThemePicker() },
    })
  }

  private confirmThemePicker(): void {
    const choice = this.themes.picker?.choices[this.themes.picker.index]
    const applied = this.themes.confirmPicker()
    this.closeThemePicker()
    if (choice === undefined) return
    if (applied === undefined) {
      this.addNotice(`theme "${choice.name}" could not be resolved`, 'error')
      return
    }
    const origin = choice.sourcePath === undefined ? 'built-in' : 'custom'
    this.showStatus(`theme → ${choice.name} (${origin})`)
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
