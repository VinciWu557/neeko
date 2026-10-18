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
import type { Component } from '@earendil-works/pi-tui'
import { buildCommands } from './commands.ts'
import { LiveSlashProvider } from './slash-provider.ts'
import { renderThemePicker, themePickerIntent } from './theme-picker.ts'
import { markdownThemeOf } from './theme.ts'
import { renderBanner } from './banner.ts'
import { renderRow, type TranscriptState } from './transcript.ts'
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
  /** Theme to start with; `/theme` switches it at runtime. */
  readonly initialTheme?: string
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
  /** In-flight catalogue reload, so per-keystroke reads share one request. */
  private modelReload: Promise<void> | undefined

  constructor(private readonly options: TuiAppOptions) {
    this.tui = new TuiMainScreen(options.terminal ?? new ProcessTerminal())
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
    this.editor = new Editor(this.tui, editorTheme)

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
    this.status.onChange = () => this.tui.requestRender()
    // Warm the catalogue so `/model ` completes without a round trip.
    void this.commands.ensureModels()
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Enter raw mode and start rendering. */
  start(): void {
    this.paintBanner()
    this.status.refresh()
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
    this.tui.stop()
  }

  /** Schedule a repaint (coalesced by the TUI). */
  requestRender(): void {
    this.scheduleRender?.()
    this.tui.requestRender()
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
    if (action.kind === 'prompt') {
      this.options.onSubmit(text)
      return
    }
    this.editor.setText('')
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
        await this.showModelHint()
        return
      case 'select-model':
        await this.applyModelById(action.id)
        return
      case 'theme-picker':
        this.openThemePicker()
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
   * `/model` with no argument: list what can be selected.
   *
   * The catalogue is retried here because it is warmed at construction, when the
   * provider adapter is often not registered yet (measured: the read fails at t0
   * and succeeds at t200). Reporting "no models" for a transient condition was
   * indistinguishable from "this TUI has no model support", so an empty result
   * is retried once before it is reported.
   *
   * Selection itself goes through the editor's inline argument completion —
   * pi-tui renders matches inside the editor's frame, and seeding text
   * programmatically cannot reproduce that (`setText` cancels completions).
   */
  private async showModelHint(): Promise<void> {
    // `ensureModels` does not cache an empty result, so this call is already the
    // retry: the warm-up at construction is the attempt that fails while the
    // provider adapter is still registering.
    const models = await this.commands.ensureModels()
    if (models.length === 0) {
      this.addNotice('models are not available from this provider yet', 'error')
      return
    }
    const current = this.options.getSelection()
    const rows = models.map((model) => {
      const active = model.id === current.model ? '✓ ' : '  '
      return `${active}${model.provider}/${model.id}`
    })
    this.addNotice(
      [`Models (${models.length}) — ${current.provider}/${current.model}`, ...rows,
        '', 'type /model <name> and press tab to filter'].join('\n'),
      'dim',
    )
  }

  /**
   * Retry the catalogue load in the background.
   *
   * The provider adapter that backs `llm.listModels()` is registered by another
   * fiber than this runner, so an early read throws `no adapter registered for
   * provider …` (measured: fails at t0, returns the real list at t200). The
   * completion path is synchronous and can only serve what is cached, so every
   * empty read schedules one reload here; the next keystroke finds the list.
   *
   * Concurrent calls collapse onto one in-flight load — the completion handler
   * runs on every keystroke, and firing a request per key would be wasteful
   * exactly while the adapter is still settling.
   */
  private async reloadModels(): Promise<void> {
    this.modelReload ??= this.commands.ensureModels().then((models) => {
      this.modelReload = undefined
      if (models.length > 0) this.requestRender()
    })
    await this.modelReload
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
      const rendered = state.rows.slice(this.visibleFrom).map((row) => renderRow(row, {
        fg: (token, text) => theme.fg(token, text),
      }, md))
      this.messages.clear()
      for (const component of rendered) this.messages.addChild(component)
      this.requestRender()
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
    this.status.setTiming(timing)
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
        listModels: () => {
          // The catalogue is warmed at construction, but the provider adapter is
          // registered by ANOTHER fiber: a read at that moment fails with "no
          // adapter registered for provider …" (measured: fails at t0, returns
          // 36 models at t200). A completion request is synchronous, so it can
          // only report what is cached — kick off a reload when the cache is
          // still empty, and the next keystroke sees the real list.
          if (this.commands.modelCatalogue.length === 0) void this.reloadModels()
          return this.commands.modelCatalogue.map((model) => ({
            value: model.id,
            label: model.id,
            description: model.provider,
            provider: model.provider,
            id: model.id,
          }))
        },
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
    if (this.themes.isPickerOpen) return this.handleThemePickerKey(data)
    return this.handleInteractionKey(data)
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
