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
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { planSession } from './session-plan.ts'
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
export function composeSetup(agentCtx: AgentEventSource & Context, selection: Parameters<typeof installModelSelection>[1]['current'], hooks: InteractionHooks): () => void {
  const modelDisposer = installModelSelection(agentCtx, { current: selection, assembled: undefined })
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

      const selection = defaultModel.currentSelection()
      const agentOptions = { provider: selection.provider, model: selection.model }
      const plan = planSession(config.sessionId)

      const setup = (agentCtx: Parameters<typeof composeSetup>[0]): void => {
        composeSetup(agentCtx, selection, hooks)
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
          meta: { cwd: process.cwd() },
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

      // Late-bound hooks: the waterfalls register in agents.create's `setup`
      // (below), but the app that answers them is constructed afterwards. The
      // holder starts in "decline" mode — a request arriving before the TUI is
      // up must fall through (next()) instead of hanging the agent.
      let app: TuiApp | undefined
      const hooks: InteractionHooks = {
        onApprovalRequest: (request) =>
          app?.isRunning === true ? app.interactions.approve(request) : Promise.resolve('cancelled'),
        onQuestionRequest: (request, next) =>
          app?.isRunning === true ? app.interactions.ask(request) : next(),
      }

      app = new TuiApp({
        agent,
        selection,
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
        onExit: () => {
          app!.stop()
          app!.interactions.cancelAll()
          exit(0)
        },
      })
      app.mountTranscript(transcript)
      // Live event pumps: host-level subscriptions, filtered to the live agent
      // (same shape as the bridge's start()).
      ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        feedEvent(transcript, { kind: 'event', event })
        app.requestRender()
      })
      ctx.on('agent/assistant-stream', ({ agent: owner, frame }) => {
        if (owner !== agent) return
        feedEvent(transcript, { kind: 'stream', frame })
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
