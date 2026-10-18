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
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { planSession } from './session-plan.ts'
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

/** Stable Cordis plugin name — must match the `neeko-tui` patch row. */
export const name = 'tui'

/** Services required before the runner can start. */
export const inject = ['agentDefaultModel', 'agents']

/** Runner-facing configuration (resolved from the startup service). */
export interface TuiConfig {
  /** Resume this persisted session instead of creating a new one. */
  sessionId?: string
  /** Set by the `--tui` flag; the patch row also conditions on it. */
  tui?: boolean
}

/** Process-facing effects, replaced by tests. */
export interface RunnerIo {
  readonly stderr: { write(chunk: string): unknown }
  readonly exit: (code: number) => void
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

/** Stop the screen and settle any pending interaction (idempotent). */
function stopApp(app: { stop(): void; interactions: { cancelAll(): void } }): void {
  app.stop()
  app.interactions.cancelAll()
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

      const agent = handle.agent
      await agent.whenIdle()

      // Restore history first: settled rows render before any live frame, so
      // the attach timeline (transcript's attachTime vs event time) cleanly
      // separates "was already in the log" from "will arrive as a delta".
      const transcript: TranscriptState = { attachTime: Date.now(), rows: [] }
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

      app = new TuiApp({
        getSelection: liveSelection,
        cwd,
        version: dshVersion(),
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
          const llm = ctx.get('llm') as { listModels(provider: string): Promise<readonly { id: string; name: string; description?: string }[]> } | undefined
          if (llm === undefined) throw new Error('llm service unavailable')
          const route = liveSelection()
          const models = await llm.listModels(route.provider)
          return {
            models: models.map((model) => ({
              id: model.id,
              name: model.name,
              provider: route.provider,
            })),
            // Composite identity so the picker can mark the active row even
            // when two providers expose the same model id.
            current: `${route.provider}/${route.model}`,
          }
        },
        selectModel: (id: string) => {
          const route = liveSelection()
          // Only the model changes hands; reasoning effort belongs to the route.
          selectionRef.current = { ...route, model: id }
          void defaultModel.saveSelection({ provider: route.provider, model: id }).catch(() => {})
        },
        onExit: () => {
          // Order matters: stop the TUI first — that restores raw mode and
          // pauses stdin, the handle keeping the event loop alive. `appExit` is
          // dsh's *graceful* disposer (it only sets `process.exitCode` and waits
          // for the loop to drain), so force the exit once it settles; a TUI
          // that waits on a lingering handle would hang on quit.
          stopApp(app!)
          void Promise.resolve(exit(0)).finally(() => process.exit(0))
        },
      })
      app.mountTranscript(transcript)
      // Session timing (pi-timing's model): generation spans are measured from
      // the attempt's start frame to its end frame, tool time counts contiguous
      // runs once (parallel tools share a wall clock), and `active` excludes
      // idle gaps.
      const timing = emptyTiming()
      // Live event pumps: host-level subscriptions, filtered to the live agent
      // (same shape as the bridge's start()).
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
        app.updateTiming(timingLine(timing, now))
        app.requestRender()
      })
      ctx.on('agent/status', ({ agent: owner, status }) => {
        if (owner !== agent) return
        app.setWorking(status === 'running' ? 'working…' : '')
      })

      app.start()
    } catch (error: unknown) {
      out.stderr.write(`tui-runner: ${error instanceof Error ? error.message : String(error)}\n`)
      exit(1)
    }
  })()
}
