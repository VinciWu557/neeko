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
 *  ├─ notices     (local command replies — owned by addNotice)
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

import { TuiMainScreen } from '@earendil-works/pi-tui'
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
import { renderThemePicker, themePickerIntent } from './theme-picker.ts'
import { buildModelPanel, handleModelPanelKey } from './model-panel.ts'
import type { ModelPanel } from './model-panel.ts'
import { markdownThemeOf } from './theme.ts'
import { renderBanner } from './banner.ts'
import type { TranscriptRow, TranscriptState } from './transcript.ts'
import { renderOptionsFor, renderRow } from './transcript-view.ts'
import { mountFullscreen } from './fullscreen.ts'
import type { Fullscreen } from './fullscreen.ts'
import { InteractionManager, interactionIntent, renderInteractionPanel } from './interactions.ts'
import { ThemeController } from './theme-controller.ts'
import { StatusController } from './status-controller.ts'
import type { LiveStatusFacts } from './status-controller.ts'
import { CommandController } from './command-controller.ts'
import type { ModelChoice } from './command-controller.ts'
import type { Theme } from './theme.ts'

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

/**
 * Upper bound on notice components kept below the transcript.
 *
 * Sized so a long session of command replies stays visible without letting the
 * container grow without limit (see {@linkcode TuiApp.addMessage}).
 */
const MAX_NOTICE_COMPONENTS = 64

export type { ModelChoice }

export interface TuiAppOptions {
  /**
   * The route in effect **right now** (`provider/model`).
   *
   * A getter, not a value: `/model <id>` swaps the runner's selection ref and
   * every paint (banner, status bar) must read the new route — a snapshot
   * taken at construction would keep showing the boot model forever.
   */
  readonly getSelection: () => { readonly provider: string; readonly model: string }
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
   * Enter fullscreen on start.
   *
   * Fullscreen is where clicking a row works (the alt screen owns its own
   * selection and copy, so reporting the pointer costs nothing native there). A
   * user who prefers that as the default should not have to type `/fullscreen`
   * every launch; `/fullscreen` still toggles it back off.
   */
  readonly initialFullscreen?: boolean
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
  private readonly notices: Container
  private readonly working: Text
  private readonly interactionText: Text
  private readonly themeText: Text

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
   * Rows the user explicitly expanded with `ctrl+o`.
   *
   * Held here rather than in the row model: expansion is a *view* preference, so
   * a re-flush (which rebuilds every component) must not lose it, and the
   * transcript itself stays a pure projection of session events.
   */
  private readonly expandedRows = new WeakSet<TranscriptRow>()
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
    this.status = new StatusController({
      readFacts: options.statusFacts,
      route: () => options.getSelection(),
      theme: () => this.themes.current,
    })

    this.banner = new Container()
    this.messages = new Container()
    // Local command replies live apart from `messages`: mountTranscript clears
    // its container on every flush, so anything written there would be wiped.
    this.notices = new Container()
    this.working = new Text('')
    this.interactionText = new Text('')
    this.themeText = new Text('')
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

    this.tui.addChild(this.banner)
    this.tui.addChild(this.messages)
    this.tui.addChild(this.notices)
    this.tui.addChild(this.working)
    this.tui.addChild(this.interactionText)
    this.tui.addChild(this.themeText)
    this.tui.addChild(this.editor)
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
    if (this.options.initialFullscreen === true) {
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
    // subsequent write looked like garbage. `dispose()` also prints the final
    // document back into scrollback.
    this.exitFullscreen()
    this.tui.stop()
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
      }
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
      this.addNotice('fullscreen off — terminal scrollback restored', 'muted')
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
      header: this.banner,
      transcript: this.messages,
      notices: this.notices,
      input: this.editor,
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
   * Put `component` where the editor normally sits: after the transcript, before
   * the status bar.
   *
   * `addChild` appends, so the status bar is detached first and re-attached to
   * keep it last — otherwise repeated opens would stack copies of it.
   *
   * @param component - the input-slot occupant (editor, or the model panel).
   */
  private replaceInputSlot(component: Component): void {
    this.tui.removeChild(this.editor)
    if (this.modelPanel !== undefined) this.tui.removeChild(this.modelPanel.component)
    this.tui.removeChild(this.status.component)
    this.tui.addChild(component)
    this.tui.addChild(this.status.component)
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
    this.addNotice(`model → ${match.provider}/${match.id}`, 'muted')
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
    this.addNotice(`theme → ${name}`, 'muted')
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
      const live = state.rows.slice(this.visibleFrom)
      // Everything folds by default; a click (or `ctrl+o`) opens one row. This is
      // the whole point: a transcript that is expanded by default is unreadable
      // the moment a tool returns a file.
      const options = renderOptionsFor({
        theme,
        expanded: this.expandedRows,
        cwd: this.cwd(),
        spinnerFrame: this.spinnerFrame,
        imageData: (image) => this.imageCache.get(image.attachmentId),
        onToggle: (target) => { this.toggleRow(target) },
      })
      const rendered = live.map((row) => {
        const signature = this.rowSignature(row, theme.name, state)
        const cached = this.rowComponents.get(row)
        if (cached !== undefined && cached.signature === signature) return cached.component
        const component = renderRow(row, { fg: (token, text) => theme.fg(token, text) }, md, options)
        this.rowComponents.set(row, { signature, component })
        return component
      })
      this.syncChildren(this.messages, rendered)
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
   * Make `container` hold exactly `next`, touching as little as possible.
   *
   * `clear()` + re-`addChild` rebuilds the child array on every flush and runs an
   * `indexOf` per removal. Matching by index keeps the array's identity, so the
   * flush touches only the slots that differ. (pi-tui's `Container` keeps no line
   * cache of its own, so the win is the array work, not memoised lines.)
   *
   * @param container - the container to reconcile.
   * @param next - the children it should end up with.
   */
  private syncChildren(container: Container, next: readonly Component[]): void {
    const current = container.children
    for (let i = 0; i < next.length; i += 1) {
      if (current[i] === next[i]) continue
      const existing = current[i]
      if (existing === undefined) container.addChild(next[i] as Component)
      else container.children[i] = next[i] as Component
    }
    // Drop any trailing children a shorter transcript left behind.
    while (container.children.length > next.length) {
      const last = container.children[container.children.length - 1]
      if (last === undefined) break
      container.removeChild(last)
    }
  }

  /**
   * A cheap fingerprint of everything that changes how one row renders.
   *
   * Deliberately *not* a deep hash: it must be far cheaper than the render it
   * guards. Row content mutates in place (streaming appends to `text`), so the
   * mutable fields go in by value while identity comes from the row object.
   *
   * @param row - the row being rendered.
   * @param themeName - a theme switch repaints every string.
   * @param state - carries the attach time, which a restore re-uses.
   * @returns a string that differs whenever the output would differ.
   */
  private rowSignature(row: TranscriptRow, themeName: string, state: TranscriptState): string {
    const expanded = this.expandedRows.has(row) ? '1' : '0'
    if (row.kind === 'assistant') {
      // `thinking.length`/`text.length` change on every streamed token, which is
      // exactly when this row must be rebuilt.
      return `a|${themeName}|${expanded}|${row.done ? '1' : '0'}|${this.spinnerFrame}|` +
        `${row.text.length}|${row.thinking.length}`
    }
    if (row.kind === 'tool') {
      const images = row.images?.length ?? 0
      return `t|${themeName}|${expanded}|${row.status}|${images}|` +
        `${row.result?.length ?? -1}|${state.attachTime}`
    }
    const images = row.images?.length ?? 0
    return `u|${themeName}|${expanded}|${row.content.length}|${images}`
  }

  /**
   * Append one component to the notices area.
   *
   * Bounded: notices are user-triggerable without limit (`/help` alone appends
   * eight lines each time), and every child participates in every repaint, so an
   * unbounded list grows both memory and per-frame cost for the whole session.
   * Oldest entries are dropped first.
   */
  addMessage(component: Component): void {
    this.notices.addChild(component)
    while (this.notices.children.length > MAX_NOTICE_COMPONENTS) {
      const oldest = this.notices.children[0]
      if (oldest === undefined) break
      this.notices.removeChild(oldest)
    }
    this.requestRender()
  }

  /**
   * Append one themed notice line.
   * @param text - the message body.
   * @param tone - theme token to color it with.
   */
  private addNotice(text: string, tone: 'text' | 'dim' | 'muted' | 'error'): void {
    this.addMessage(new Text(this.themes.current.fg(tone, text)))
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
    this.notices.clear()
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
   * Top-level routing. Priority: exit → theme picker → interaction → editor.
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
    if (this.themes.isPickerOpen) return this.handleThemePickerKey(data)
    // `ctrl+o` toggles the newest foldable row, then repaints. Placed after the
    // modal surfaces: an open panel or prompt owns the keyboard first.
    if (matchesKey(data, 'ctrl+o')) {
      this.toggleFold()
      return { consume: true }
    }
    return this.handleInteractionKey(data)
  }

  /**
   * Expand or collapse the newest row.
   *
   * Targeting "the newest row" rather than a cursor keeps the key stateless —
   * there is no selected row to track, and the thing the user just watched
   * happen is the thing they want to re-read. This is the keyboard route to the
   * same toggle a click performs.
   */
  private toggleFold(): void {
    const rows = this.transcript?.rows.slice(this.visibleFrom) ?? []
    const newest = rows[rows.length - 1]
    if (newest === undefined) return
    this.toggleRow(newest)
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
   * Rows fold by default and the set holds the *exceptions*, so opening one is an
   * insert and closing it is a delete. Keeping the exceptions (rather than the
   * folded set) is what makes the default cheap: a row added later is folded
   * without touching the set.
   *
   * @param row - the clicked (or newest) row.
   */
  private toggleRow(row: TranscriptRow): void {
    if (this.expandedRows.has(row)) this.expandedRows.delete(row)
    else this.expandedRows.add(row)
    this.scheduleRender?.()
  }

  private handleThemePickerKey(data: string): { consume?: boolean } | undefined {
    const intent = themePickerIntent((name) => matchesKey(data, name))
    switch (intent.kind) {
      case 'close':
        this.closeThemePicker()
        return { consume: true }
      case 'move':
        this.themes.movePicker(intent.delta)
        this.renderThemePicker()
        return { consume: true }
      case 'confirm':
        this.confirmThemePicker()
        return { consume: true }
      case 'ignore':
        // The picker owns the keyboard: never let a stray key reach the editor.
        return { consume: true }
    }
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
    this.addNotice(`theme → ${choice.name} (${origin})`, 'muted')
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
