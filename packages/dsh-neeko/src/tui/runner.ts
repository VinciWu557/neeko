/**
 * TUI runner: the Cordis entry that mounts the interactive terminal UI.
 *
 * Structure mirrors the bridge's `apply`/`doActivate` (already validated on
 * dsh 0.2.0-rc.2), with two differences:
 * - The consumer is the local terminal, not a WebSocket client.
 * - The bridge and TUI rows are mutually exclusive in `cordis.patch.yml`
 *   (`disabled: !!js ctx.neekoStartup.tui …`), so this runner only ever starts
 *   when `--tui` was given; the guard is defense in depth, not the selector.
 *
 * @module dsh-neeko/tui/runner
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { planSession } from './session-plan.ts'
import { runStateOfStatus } from './program-status.ts'
import { loadKeybindingOverrides } from './keymap.ts'
import { resolveScreen } from './screen.ts'
import type { ScreenMode } from './screen.ts'
import { switchedSelection } from './model-switch.ts'
import { withReasoningEffort } from './thinking.ts'
import { titlesFromObservations } from './resume-list.ts'

/**
 * The slice of dsh's `llm` service the model picker consumes.
 *
 * `listProviders()` is synchronous and returns the *registered* routes, so it is
 * the authority on which providers are configured right now; `listModels()` is
 * per-provider and async (its adapter may be registered by another fiber).
 */
interface LlmCatalogue {
  listProviders(): readonly { id: string; name: string }[]
  listModels(provider: string): Promise<readonly { id: string; name: string; description?: string }[]>
  /**
   * Exact-route metadata, including `reasoning.efforts` when the adapter exposes
   * them. A catalogue entry (`listModels`) does not carry this: the effort set is
   * a property of the resolved model, and `resolveCallConfig` validates against
   * exactly that answer — so `/thinking` must ask here, not guess.
   *
   * Typed with dsh's own `LlmModelReasoningInfo` rather than a hand-written
   * narrow shape: a reshape upstream then fails to compile here instead of
   * silently yielding `undefined` (whose symptom would be an empty level list
   * with no error anywhere).
   */
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ reasoning?: LlmModelReasoningInfo }>
}
import { collectHostCommands, collectSkills, executeHostCommand } from './host-commands.ts'
import type { CommandExecuteRegistryLike, CommandRegistryLike, SkillRegistryLike } from './host-commands.ts'
import { contextWindowOf, dshVersion, gitBranch, readContextPressure } from './host-facts.ts'
import { foldUsage } from './status-bar.ts'
import {
  emptyTiming, onChunk, onGenerationEnd, onGenerationStart, onToolEnd,
  onToolStart, onUserMessage, timingLine,
} from './timing.ts'
import { feedEvent, restoreRows } from './transcript.ts'
import type { TranscriptState } from './transcript.ts'
import { buildHistory, readSessionEvents } from '../dsh-adapter.ts'
import { TuiApp } from './app.ts'
import type { ModelChoice } from './command-controller.ts'

/**
 * How many session titles are folded at once.
 *
 * Matches dsh's own prepared-session cache size: each title decompresses one
 * session artifact, and an unbounded fan-out over the whole corpus never
 * completes.
 */
const TITLE_CONCURRENCY = 5

/** Stable Cordis plugin name — must match the `neeko-tui` patch row. */
export const name = 'tui'

/**
 * Services required before the runner can start.
 *
 * `llm` is declared because the model catalogue — and therefore any model
 * switch — reads it. Without the declaration cordis does not wait for that
 * fiber, so `ctx.get('llm')` can resolve to `undefined` while the runner boots
 * and the catalogue silently comes back empty. `skills` / `commands` stay
 * optional: the TUI works without them (the menu just offers fewer entries).
 */
export const inject = ['agentDefaultModel', 'agents', 'llm']

/** Runner-facing configuration (resolved from the startup service). */
export interface TuiConfig {
  /** Resume this persisted session instead of creating a new one. */
  sessionId?: string
  /** Set by the `--tui` flag; the patch row also conditions on it. */
  tui?: boolean
  /**
   * The screen the user asked for, or absent to take the default (see
   * `screen.ts`). One field with one polarity, so no layer has to guess what
   * `undefined` means.
   */
  screen?: ScreenMode | undefined
}

/** Process-facing effects, replaced by tests. */
export interface RunnerIo {
  readonly stderr: { write(chunk: string): unknown }
  readonly exit: (code: number) => void
}

/**
 * The screen this run should mount.
 *
 * A named alias, not a second implementation: `resolveScreen` in `screen.ts` owns
 * the whole decision (configuration, then `DSH_NEEKO_SCREEN`, then the two legacy
 * variables, then the default). This function used to carry its own copy of that
 * logic *and* its own `'main'` default, which is how the flag and the environment
 * ended up inverted and why the default was unreachable from one layer.
 *
 * Kept as a named export because the runner reads better with it and because
 * existing call sites are in the boot path.
 *
 * @param config - the resolved configuration; `screen` absent means "not stated".
 * @returns the mode to mount; never `undefined`.
 */
export function screenModeOf(config: { readonly screen?: ScreenMode | undefined }): ScreenMode {
  return resolveScreen(config)
}

export const internals: { io: RunnerIo | undefined } = {
  io: undefined,
}

function io(): RunnerIo {
  return internals.io ?? {
    stderr: process.stderr,
    exit: (code: number) => process.exit(code),
  }
}

/**
 * The two interaction seams, typed against the real dsh contracts (same shape
 * as the bridge's `AgentEventSource` — a genuine agent-scoped Cordis context
 * satisfies this structurally, so no casts are needed).
 */
export interface AgentEventSource {
  on(
    name: 'approval/request',
    listener: (request: ApprovalRequest) => Promise<ApprovalOutcome>,
  ): () => void
  on(
    name: 'user-questions/request',
    listener: (request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>,
  ): () => void
}

/** Callbacks the app supplies; they own the actual interaction UI. */
export interface InteractionHooks {
  onApprovalRequest(request: ApprovalRequest): Promise<ApprovalOutcome>
  onQuestionRequest(request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>
}

/**
 * Compose one agent's setup: model selection plus the two interaction
 * waterfalls. Same wiring shape as the bridge's `setupAgent` /
 * `registerAgentHandlers`, pointed at the TUI's interaction UI instead of the
 * WebSocket waiters.
 *
 * @param agentCtx - the new agent's scoped context.
 * @param selection - the model selection to install.
 * @param hooks - callbacks into the running app.
 * @returns a disposer releasing everything this function registered.
 */
export function composeSetup(agentCtx: AgentEventSource & Context, selection: ModelSelectionRef, hooks: InteractionHooks): () => void {
  const modelDisposer = installModelSelection(agentCtx, selection)
  const approvalDisposer = agentCtx.on('approval/request', (request) => hooks.onApprovalRequest(request))
  const questionDisposer = agentCtx.on('user-questions/request', (request, next) =>
    hooks.onQuestionRequest(request, next))
  return () => {
    modelDisposer()
    approvalDisposer()
    questionDisposer()
  }
}

/**
 * Stop the screen, settle pending interactions, and flush the input queue.
 *
 * The drain is awaited by the caller: a Kitty key-release sequence still in stdin
 * when the process exits gets echoed by the shell as literal text (`9;5:3u`).
 *
 * @param app - the running app.
 * @returns a promise that resolves once stdin is quiet.
 */
async function stopApp(app: {
  stop(): void
  interactions: { cancelAll(): void }
  drainTerminalInput(): Promise<void>
}): Promise<void> {
  app.stop()
  app.interactions.cancelAll()
  await app.drainTerminalInput()
}

/** The slice of a writable stream {@linkcode exitAfterFlush} needs. */
export interface FlushStream {
  once(event: 'drain', listener: () => void): unknown
  readonly writableLength?: number
}

/** How long to wait for stdout before exiting regardless. */
const EXIT_FLUSH_TIMEOUT_MS = 2_000

/**
 * Write the final document, then exit once it has actually left the process.
 *
 * `process.stdout.write()` is asynchronous. Leaving an alt screen writes the
 * **whole conversation** back to scrollback in a single call — the largest write
 * of the run — so `process.exit()` immediately after it truncates exactly the
 * part the user wants to keep. Measured on a real pty: the printed document was
 * 1426 bytes (banner only) instead of banner + conversation.
 *
 * Three ways out, because a TUI must never hang on quit:
 * - the write callback fires → exit;
 * - the callback fires but the stream is backed up → wait for `drain`;
 * - nothing acknowledges within {@linkcode EXIT_FLUSH_TIMEOUT_MS} → exit anyway.
 *
 * @param options - the stream to drain, the exit hook, and the write to perform.
 */
export async function exitAfterFlush(options: {
  readonly stream: FlushStream
  readonly exit: (code: number) => void
  /** Perform the final writes; invoke the callback once they are accepted. */
  readonly write: (done: () => void) => void
  readonly timeoutMs?: number
}): Promise<void> {
  const { stream, exit, write } = options
  const timeoutMs = options.timeoutMs ?? EXIT_FLUSH_TIMEOUT_MS
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    // Node keeps the process alive for a pending timer; the TUI may have closed
    // stdin, so nothing else would. `unref` lets a truly idle process still exit.
    timer.unref?.()
    const onWritten = (): void => {
      // `write()`'s callback means "handed to the OS", not "drained": with a
      // full pipe buffer the bytes are still queued, and exiting now would cut
      // the document short.
      if ((stream.writableLength ?? 0) === 0) {
        finish()
        return
      }
      stream.once('drain', finish)
    }
    try {
      write(onWritten)
    } catch {
      // A closed stdout (EPIPE) must not keep the user stuck in the TUI.
      finish()
    }
  })
  exit(0)
}

/**
 * Mount the TUI runner.
 * @param ctx - plugin context carrying core services.
 * @param config - startup-resolved configuration.
 */
export function apply(ctx: Context, config: TuiConfig): void {
  const out = io()
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  // Defense in depth: the patch row already disables this runner without --tui.
  if (config.tui !== true) return

  void (async () => {
    try {
      await ctx.get('loader')?.await()
      const agents = ctx.get('agents')
      const defaultModel = ctx.get('agentDefaultModel')
      if (agents === undefined || defaultModel === undefined) {
        out.stderr.write('tui-runner: agents services unavailable\n')
        exit(1)
        return
      }

      const initial = defaultModel.currentSelection()
      // The session's working directory: read ONCE and threaded through every
      // consumer (session meta, skill discovery, branch, banner, completions).
      const cwd = process.cwd()
      // Mutable ref: `installModelSelection` reads `.current` at each step's
      // prompt assembly, so mutating it switches the model from the next step
      // (the running step keeps what it already assembled).
      const selectionRef: ModelSelectionRef = { current: initial, assembled: undefined }
      /** The route in effect right now — the ref wins once a switch happened. */
      const liveSelection = (): NonNullable<ModelSelectionRef['current']> =>
        selectionRef.current ?? initial
      const agentOptions = { provider: initial.provider, model: initial.model }
      const plan = planSession(config.sessionId)

      // Late-bound hooks: the waterfalls register in agents.create's `setup`
      // (below), but the app that answers them is constructed afterwards. The
      // holder starts in "decline" mode — a request arriving before the TUI is
      // up must fall through (next()) instead of hanging the agent.
      let app: TuiApp | undefined
      const hooks: InteractionHooks = {
        onApprovalRequest: (request) => {
          out.stderr.write(`tui-runner: approval/request for ${request.toolName}\n`)
          return app?.isRunning === true ? app.interactions.approve(request) : Promise.resolve('cancelled')
        },
        onQuestionRequest: (request, next) =>
          app?.isRunning === true ? app.interactions.ask(request) : next(),
      }

      const setup = (agentCtx: Parameters<typeof composeSetup>[0]): void => {
        composeSetup(agentCtx, selectionRef, hooks)
      }

      let handle: AgentHandle | undefined
      let resumeNote: string | undefined
      if (plan.kind === 'resume') {
        try {
          handle = await agents.resume({ resumeSessionId: SessionId(plan.sessionId), agentOptions, setup })
        } catch (error: unknown) {
          resumeNote = `session ${plan.sessionId} could not be resumed; started a fresh session`
          out.stderr.write(`tui-runner: ${resumeNote} (${error instanceof Error ? error.message : String(error)})\n`)
        }
      }
      if (handle === undefined) {
        handle = await agents.create({
          sessionId: SessionId(`session-${randomUUID()}`),
          meta: { cwd },
          agentOptions,
          setup,
        })
      }

      // Reassignable: `/resume` switches the whole attachment (agent, history,
      // transcript, timing) at runtime, and every consumer below reads this
      // binding rather than a captured one.
      // Reassignable: `/resume` rebuilds the attachment (agent, history,
      // transcript, timing) at runtime, and every consumer below reads these
      // bindings rather than captured copies.
      let current = handle
      let agent = current.agent
      await agent.whenIdle()

      // Restore history first: settled rows render before any live frame, so
      // the attach timeline (transcript's attachTime vs event time) cleanly
      // separates "was already in the log" from "will arrive as a delta".
      let transcript: TranscriptState = { attachTime: Date.now(), rows: [] }
      restoreRows(transcript, buildHistory(readSessionEvents(agent.session)))

      // Skills are an async catalogue, so they arrive as a **startup snapshot**
      // in the menu — collected before the app exists. Host commands are live:
      // `LiveSlashProvider` re-reads `listHostCommands` on every menu open.
      const skills = await collectSkills(ctx.get('skills') as SkillRegistryLike | undefined, cwd)

      // `statusFacts` folds the durable log on every refresh. The log is
      // append-only, so cache one fold per *new* event instead of folding the
      // whole history on every repaint (that makes a long session quadratic).
      let usageFold: { size: number; value: ReturnType<typeof foldUsage> } | undefined
      const usageLedger = (): ReturnType<typeof foldUsage> => {
        const events = readSessionEvents(agent.session)
        if (usageFold === undefined || usageFold.size !== events.length) {
          usageFold = { size: events.length, value: foldUsage(events) }
        }
        return usageFold.value
      }

      /**
       * The session corpus, typed to what this runner reads.
       *
       * Narrow on purpose: `listSessions` plus the optional per-session title
       * fold. A resolve failure is thrown (not swallowed) so the app can report
       * a real reason instead of showing an empty list.
       */
      type SessionCorpus = {
        listSessions(signal?: AbortSignal): Promise<readonly {
          header: { id: string; createdAt: number; cwd?: string }
          live: boolean
          persisted: boolean
        }[]>
        readTitle?(id: never, signal?: AbortSignal): Promise<{ title: string } | undefined>
        /**
         * Batch title fold: one corpus observation for many sessions.
         *
         * Much cheaper than `readTitle` per id — the persistence listing and the
         * per-source reads are shared across the batch, which is what makes a
         * pre-scan of the list affordable at all.
         */
        readTitleSnapshots?(ids: readonly never[], signal?: AbortSignal): Promise<readonly {
          sessionId: string
          status: 'fulfilled' | 'rejected'
          value?: { title?: { title: string } }
        }[]>
      }
      const sessionQuery = (): SessionCorpus => {
        const query = ctx.get('sessionQuery') as SessionCorpus | undefined
        if (query === undefined) throw new Error('the session query service is unavailable')
        return query
      }

      app = new TuiApp({
        getSelection: liveSelection,
        cwd,
        version: dshVersion(),
        // Attachments are content-addressed and verified on read, so the app
        // cannot decode them itself; it asks here and caches the bytes.
        readImage: async (attachmentId: string) => {
          const attachment = ctx.get('attachment') as {
            readImage(ref: { attachmentId: string }): Promise<{ ref: { mediaType: string }; data: Uint8Array }>
          } | undefined
          if (attachment === undefined) return undefined
          try {
            const stored = await attachment.readImage({ attachmentId } as never)
            return {
              base64: Buffer.from(stored.data).toString('base64'),
              mediaType: stored.ref.mediaType,
            }
          } catch {
            // A pruned or corrupt attachment must not break the transcript.
            return undefined
          }
        },
        // Host command surface: DSH plugins register commands (including
        // skills-as-commands); this TUI renders them in the same `/` menu and
        // dispatches through the registry so their semantics stay owned by the
        // plugin that defined them.
        listHostCommands: () => [...collectHostCommands(ctx.get('commands') as CommandRegistryLike | undefined, agent)],
        listSkills: () => [...skills],
        runHostCommand: (line: string) => executeHostCommand(
          ctx.get('commands') as CommandExecuteRegistryLike | undefined,
          agent,
          line,
        ),
        statusFacts: () => {
          // Ledger folds the durable log (pi does the same) — cached by
          // `usageLedger`; context pressure comes from the token meter, which
          // prices the live surface.
          const { ledger, cacheHitRate } = usageLedger()
          // DSH already tracks context occupancy: `sessionProjections` folds
          // the durable log into `contextPressure` (provider-anchored
          // `projectedTokens` + the route's `contextWindow`). Use it instead of
          // guessing — a hand-rolled window lookup had no value to report.
          const pressure = readContextPressure(ctx, agent.session)
          const route = liveSelection()
          const window = pressure?.contextWindow ?? contextWindowOf(ctx, route.provider, route.model)
          const contextTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
          const branch = gitBranch(cwd)
          return {
            cwd,
            ...(branch === undefined ? {} : { branch }),
            ledger,
            ...(cacheHitRate === undefined ? {} : { cacheHitRate }),
            ...(contextTokens === undefined ? {} : { contextTokens }),
            ...(route.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: String(route.reasoningEffort) }),
            ...(window === undefined ? {} : { contextWindow: window }),
          }
        },
        // `exactOptionalPropertyTypes`: omit the key rather than pass undefined.
        ...(process.env['DSH_NEEKO_THEME'] === undefined ? {} : { initialTheme: process.env['DSH_NEEKO_THEME'] }),
        screenMode: screenModeOf(config),
        // pi's `keybindings.json`, read once at boot. The app owns *applying*
        // them (via `installKeymap`); reading the file is a runner concern, which
        // is why `TuiApp` takes the parsed overrides rather than a path.
        keybindingOverrides: loadKeybindingOverrides(),
        getSessionId: () => String(agent.session.id),
        onSubmit: (text) => {
          const trimmed = text.trim()
          if (trimmed === '') return
          // `followup` queues the message as the next user turn (the TUI always
          // runs a live foreground agent; `steer` would only apply mid-turn).
          agent.followup(createUserMessage({
            content: [{ type: 'text', text: trimmed }],
            source: { kind: 'user' },
          }))
        },
        modelPicker: async () => {
          const llm = ctx.get('llm') as LlmCatalogue | undefined
          if (llm === undefined) throw new Error('llm service unavailable')
          const route = liveSelection()
          // Every *configured* provider, not just the active one: the picker is
          // how a user switches provider, so scoping it to `route.provider`
          // hides every alternative route (pi shows 195 models across all
          // providers, not 36 from one).
          const defaultSelection = ctx.get('agentDefaultModel')?.currentSelection()
          const rows: ModelChoice[] = []
          for (const provider of llm.listProviders()) {
            // One failing provider must not blank the whole catalogue.
            let models: Awaited<ReturnType<LlmCatalogue['listModels']>> = []
            try {
              models = await llm.listModels(provider.id)
            } catch {
              continue
            }
            for (const model of models) {
              rows.push({
                id: model.id,
                name: model.name,
                provider: provider.id,
                // `default` is the profile's configured selection, not a
                // provider-declared one — `LlmModelInfo` carries no such flag.
                isDefault: defaultSelection !== undefined
                  && defaultSelection.provider === provider.id
                  && defaultSelection.model === model.id,
              })
            }
          }
          return {
            models: rows,
            // Composite identity so the picker can mark the active row even
            // when two providers expose the same model id.
            current: `${route.provider}/${route.model}`,
          }
        },
        selectModel: (id: string) => {
          const route = liveSelection()
          // Only `provider` survives a model change; see `switchedSelection`
          // for why carrying `reasoningEffort` over makes the switch silent.
          selectionRef.current = switchedSelection(route, id)
          void defaultModel.saveSelection({ provider: route.provider, model: id }).catch(() => {})
        },
        setDefaultModel: (provider: string, id: string) => {
          // The panel lists every provider, so the row names its own route.
          void defaultModel.saveSelection({ provider, model: id }).catch(() => {})
        },
        // `/thinking`: the effort set is the *current* route's, read from the
        // adapter each time — a switch to another model changes it, and caching
        // would offer levels the new model rejects.
        reasoningSupport: async () => {
          const llm = ctx.get('llm') as LlmCatalogue | undefined
          if (llm === undefined) throw new Error('llm service unavailable')
          const route = liveSelection()
          const info = await llm.resolveModelInfo(route.provider, route.model)
          return info.reasoning
        },
        selectReasoningEffort: (effort: string | undefined) => {
          // Only the effort changes; `withReasoningEffort` drops the key when
          // clearing so the provider default applies (DSH reads absent effort as
          // "provider default", and an explicit one verbatim).
          selectionRef.current = withReasoningEffort(liveSelection(), effort)
        },
        // `/resume`: dsh owns the corpus (filesystem logs folded into a query
        // service); titles are per-session folds, so they are read in parallel
        // and a failing title must not drop the session from the list.
        // `/resume`: dsh owns the corpus. `listSessions()` is cheap (it reads one
        // header per stored session: 419 files in ~60 ms here), but a *title* is a
        // separate log read per session — doing that for the whole corpus is what
        // made the picker appear to hang. So titles are fetched lazily, in
        // batches, as the user moves the cursor (see `listSessions` +
        // `sessionTitles`).
        listSessions: async () => {
          const query = sessionQuery()
          const records = await query.listSessions()
          return records.map((record) => ({
            header: record.header,
            live: record.live,
            persisted: record.persisted,
          }))
        },
        // Titles for a bounded slice, with bounded concurrency.
        //
        // Each title is a log read that has to decompress the session artifact,
        // and dsh's own prepared-session cache defaults to 5 for exactly this
        // reason. Firing one read per session in parallel (424 here) does not
        // finish at all — measured: still pending after 40 s, which is why every
        // row showed the id fallback instead of its title.
        sessionTitles: async (ids: readonly string[]) => {
          const query = sessionQuery()
          const out: Record<string, string> = {}
          // Batch path first: it shares one corpus observation across every id,
          // and falls through to the per-id loop only when the service does not
          // expose it (an older dsh).
          if (typeof query.readTitleSnapshots === 'function') {
            try {
              const results = await query.readTitleSnapshots(ids as readonly never[])
              // The shape mapping is load-bearing (batch is the only affordable
              // path), so it lives in `resume-list` where it is unit-tested.
              return titlesFromObservations(results)
            } catch {
              // Fall through to the per-id reads rather than losing the page.
            }
          }
          const queue = [...ids]
          const worker = async (): Promise<void> => {
            for (;;) {
              const id = queue.shift()
              if (id === undefined) return
              try {
                const title = await query.readTitle?.(id as never)
                if (title !== undefined) out[id] = title.title
              } catch {
                // A session whose title cannot be folded is still resumable.
              }
            }
          }
          await Promise.all(
            Array.from({ length: Math.min(TITLE_CONCURRENCY, ids.length) }, () => worker()),
          )
          return out
        },
        // Switching rebuilds the attachment: the transcript is a projection of
        // one session's log, so it cannot be patched across a switch.
        resumeSession: (sessionId: string) => {
          void switchTo(sessionId)
        },
        onExit: () => {
          // Order matters: stop the TUI first — that restores raw mode and
          // pauses stdin, the handle keeping the event loop alive. `appExit` is
          // dsh's *graceful* disposer (it only sets `process.exitCode` and waits
          // for the loop to drain), so force the exit once it settles; a TUI
          // that waits on a lingering handle would hang on quit.
          //
          // The exit must wait for stdout: `stop()` writes the whole conversation
          // back to scrollback when it leaves the alt screen, and
          // `process.exit()` right after it truncated that document (measured
          // on a real pty: banner only, no conversation).
          //
          // The drain is awaited before the flush barrier: a Kitty key-release
          // sequence still in stdin when the process ends is echoed by the shell
          // as literal text (`9;5:3u`), and `drainInput` is what removes it.
          void stopApp(app!).then(() => exitAfterFlush({
            stream: process.stdout,
            exit: (code) => { void Promise.resolve(exit(code)).finally(() => process.exit(code)) },
            // `stop()` already wrote; this is the flush barrier, not a new write.
            write: (done) => { process.stdout.write('', done) },
          }))
        },
      })
      /**
       * Re-attach the whole TUI to another session.
       *
       * A transcript is a projection of *one* session's log, and the event
       * pumps, status facts and timing window are all bound to one agent — so a
       * switch rebuilds them rather than patching them. The old handle is
       * disposed first: two live agents would both answer `agent/status` and the
       * spinner would follow whichever fired last.
       *
       * Failure leaves the current session running: a bad id must not cost the
       * user their conversation.
       *
       * @param sessionId - the session to attach to.
       */
      async function switchTo(sessionId: string): Promise<void> {
        const live = app
        if (live === undefined) return
        try {
          const next = await agents!.resume({
            resumeSessionId: SessionId(sessionId),
            agentOptions: { provider: liveSelection().provider, model: liveSelection().model },
            setup,
          })
          await next.agent.whenIdle()
          const previous = current
          current = next
          agent = next.agent
          // A different session is a different measurement window and a
          // different log, so both caches belong to the old attachment.
          timing = emptyTiming()
          usageFold = undefined
          const restored: TranscriptState = { attachTime: Date.now(), rows: [] }
          restoreRows(restored, buildHistory(readSessionEvents(agent.session)))
          transcript = restored
          live.mountTranscript(restored)
          live.refreshStatus()
          live.requestRender()
          // Release the old attachment only after the new one is live, so a
          // failed switch cannot leave the TUI attached to nothing.
          await previous.dispose().catch(() => {})
        } catch (error: unknown) {
          out.stderr.write(`tui-runner: /resume ${sessionId} failed (${error instanceof Error ? error.message : String(error)})\n`)
          live.notify(`could not resume ${sessionId}: ${error instanceof Error ? error.message : String(error)}`, 'error')
        }
      }

      app.mountTranscript(transcript)
      // Session timing (pi-timing's model): generation spans are measured from
      // the attempt's start frame to its end frame, tool time counts contiguous
      // runs once (parallel tools share a wall clock), and `active` excludes
      // idle gaps.
      let timing = emptyTiming()
      // Live event pumps: host-level subscriptions, filtered to the agent we are
      // currently attached to. `agent` is reassigned by `/resume`, so these
      // filters keep working across a switch without re-subscribing (which would
      // leak a listener per switch).
      ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        const now = Date.now()
        if (event.type === 'user/message') {
          // DSH stamps every event; use it rather than our own clock so a
          // resumed session's origin matches the log.
          onUserMessage(timing, event.time)
        } else if (event.type === 'tool/call') {
          onToolStart(timing, now)
        } else if (event.type === 'tool/result') {
          onToolEnd(timing, now)
        }
        feedEvent(transcript, { kind: 'event', event })
        // The turn's end is the only place a run's **outcome** exists. Without this,
        // `done` and `error` were declared on the run state and never set: the
        // terminal showed the same thing for a finished turn and a failed one.
        app.reportSessionEvent(event)
        // A session event is a real state change: fold the facts (expensive) and
        // apply the timing segment in the SAME repaint.
        app.refreshStatus(timingLine(timing, now))
        app.requestRender()
      })
      ctx.on('agent/assistant-stream', ({ agent: owner, frame }) => {
        if (owner !== agent) return
        const now = Date.now()
        if (frame.type === 'start') onGenerationStart(timing, now)
        else if (frame.type === 'end') onGenerationEnd(timing, now)
        else if (frame.chunk.type === 'text-delta') onChunk(timing, now, 'text')
        else if (frame.chunk.type === 'reasoning-delta') onChunk(timing, now, 'reasoning')
        feedEvent(transcript, { kind: 'stream', frame })
        // Per-chunk path: only the timing ticks. Re-reading facts here would
        // fold the durable log once per token (see StatusController docs).
        //
        // No explicit `requestRender()`: `updateTiming` already notifies, and the
        // transcript flush is coalesced on its own window. Rendering twice per
        // token is what made streaming feel sluggish.
        app.updateTiming(timingLine(timing, now))
      })
      ctx.on('agent/status', ({ agent: owner, status }) => {
        if (owner !== agent) return
        app.setWorking(runStateOfStatus(status))
      })

      app.start()
    } catch (error: unknown) {
      out.stderr.write(`tui-runner: ${error instanceof Error ? error.message : String(error)}\n`)
      exit(1)
    }
  })()
}
