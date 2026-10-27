/**
 * 通知上报的**挂载层**：把「DSH 事件 → 语义信号 → HTTP」这条链接到任意 cordis 上下文上。
 *
 * # 为什么必须是独立模块（真机事故，2026-10-27）
 *
 * 通知逻辑最初写在 `NeekoBridge`（`id: neeko`）内部。但 `cordis.patch.yml` 里那一行
 * 在 `--tui` 时是 **`disabled`** 的：
 *
 * ```yaml
 * - id: neeko
 *   disabled: !!js ...cmdlineArgs.includes('--tui')...
 * - id: neeko-tui          # ← 用户日常跑这个
 *   disabled: !!js !...includes('--tui')...
 * ```
 *
 * 后果：用户用 `dsh --profile neeko --tui` 跑，**通知代码一行都没执行过**，
 * 且没有任何日志 —— 表现为「配置都对，就是没通知」。
 *
 * 故上报抽成本模块，由**两条腿各自**调用：
 *
 * | 腿 | 入口 |
 * | --- | --- |
 * | bridge（headless / 非 TUI） | `index.ts::start()` |
 * | TUI (`--tui`) | `tui/runner.ts` 启动处 |
 *
 * 防线：`tests/notify-wiring.spec.ts::both runtime legs install the reporter`
 * 断言两处都**调用了** `installNotifyReporter`（不是「文件里出现过这个名字」）。
 *
 * @module dsh-neeko/notify-wiring
 */

import { isSubagentSession, notifyEventOf, renderReportBody } from './notify-reporter.ts'
import type { NotifyEvent, ObservedEvent, ObservedSession } from './notify-reporter.ts'
import { defaultEffects, postToEndpoints } from './notify-transport.ts'
import type { ReporterEffects } from './notify-transport.ts'

/**
 * 上报失败/跳过时的诊断出口。
 *
 * 为什么需要它：通知是**旁路**，失败必须吞掉（不能打断会话）；但「静默」和
 * 「坏了」在用户眼里是同一个现象 —— 本任务真机上就因此误判过两轮。故保留一条
 * 极廉价的 stderr 痕迹，只在 `NEEKO_NOTIFY_DEBUG=1` 时输出。
 */
const DEBUG = process.env['NEEKO_NOTIFY_DEBUG'] === '1'

/** 诊断输出（仅调试开关打开时）。 */
function debug(message: string): void {
  if (DEBUG) process.stderr.write(`dsh-neeko[notify] ${message}\n`)
}

/**
 * 挂载所需的最小 cordis 面。
 *
 * 用结构化子集而不是 `Context`：两条腿传进来的上下文各自带了别的服务，
 * 本模块只需要「订阅」这一件事 —— 收窄签名让「它能干什么」在类型上可见。
 */
export interface NotifyWiringContext {
  on(name: string, listener: (...args: any[]) => void): () => void
}

/** 挂载时的运行时参数。 */
export interface NotifyWiringOptions {
  /** 坐标目录（默认 `~/.neeko/agent-hooks/endpoints`）。 */
  readonly endpointsDirs: readonly string[]
  /** 投递依赖（默认真 fs + 真 fetch；测试注入）。 */
  readonly effects?: ReporterEffects
}

/**
 * `agent/*` 两个面给的载荷（`@deepseek-ai/dsh-agent` 的 `Agent`）。
 *
 * **`Agent` 没有 `header`**（`dsh-agent/lib/types/types.d.ts` 只有 `id`；
 * `runtime-types.d.ts` 再加 `options/session/inbox/status/ctx`），`header` 在
 * `agent.session` 上（`dsh-session/lib/types/index.d.ts`）。
 */
interface ObservedAgent extends ObservedSession {
  readonly session?: ObservedSession
}

/**
 * `Agent` → 上报用的最小会话视图。
 *
 * 为什么必须显式归一：`Agent` 与 `Session` 都有 `id`，所以把 `Agent` 当 `Session`
 * 用**类型上完全合法**（`ObservedSession` 字段全 optional），运行时才暴露 ——
 * `header` 恒 `undefined` ⇒ 子代理过滤失效（`isSubagentSession` 恒 false）且
 * `cwd` 恒 `null`（Rust 归属链掉到最弱兜底）。2026-10-27 实测缺陷。
 *
 * @param agent - `agent/status` / `agent/error` 的 `payload.agent`。
 * @returns `header` 取自 `agent.session`（缺失时只剩 `id`）。
 */
export function observedOf(agent: ObservedAgent): ObservedSession {
  const header = agent.session?.header ?? agent.header
  const id = agent.id ?? agent.session?.id
  if (header === undefined) return id === undefined ? {} : { id }
  return id === undefined ? { header } : { id, header }
}

/** 一次挂载的内部状态。 */
interface ReporterState {
  /** 每个 agent 上一拍的运行态（按 id 分开，避免多 agent 互相吞边沿）。 */
  readonly running: Map<string, boolean>
  /** 每个会话最近一次 `session/title`。 */
  readonly titles: Map<string, string>
  /**
   * 每个会话最近一轮 `turn/end` 的结果（`completed` / 其它）。
   *
   * 为什么必须跨事件记：DSH 的**时机**（`agent/status` 的 `running → idle`）与
   * **原因**（`turn/end.reason`）是两条事件。只取时机会把失败轮与用户中止轮
   * 一律报成「完成」—— 与 `.trellis/spec/backend/agent-chat-transports.md` §4.6b
   * 记的 pi 缺陷同型（失败不可被追认为完成）。
   */
  readonly lastTurn: Map<string, string>
}

/**
 * 把上报接到一个 cordis 上下文上。
 *
 * 订阅三个面（`session/event` / `agent/status` / `agent/error`，全部**旁路可听、零副作用**）：
 * - `session/event` → 记 `session/title` 与 `turn/end` 的原因；
 *   `approval/asked` / `tool/call` 上报
 * - `agent/status` → `running → idle` 边沿上报 `turn_completed`（仅当上一轮 completed）
 * - `agent/error` → 上报 `session_failed`
 *
 * **永不抛、永不阻塞**：DSH 会 `await` 监听器，上报失败的用户可见后果只能是一条
 * 通知少了，不能是会话卡住。
 *
 * @param ctx - 宿主上下文（bridge 或 TUI）。
 * @param endpointsDirs - 候选坐标目录。
 * @param effects - 投递依赖（默认生产实现）。
 * @returns 解绑函数（宿主退出时调用）。
 */
export function installNotifyReporter(
  ctx: NotifyWiringContext,
  endpointsDirs: readonly string[],
  effects?: ReporterEffects,
): () => void {
  const fx = effects ?? defaultEffects()
  const state: ReporterState = { running: new Map(), titles: new Map(), lastTurn: new Map() }
  const options: NotifyWiringOptions = {
    endpointsDirs,
    ...(effects === undefined ? {} : { effects }),
  }

  /** 发一条通知（fire-and-forget）。 */
  const report = (session: ObservedSession, event: NotifyEvent, detail: string | null): void => {
    if (isSubagentSession(session)) return
    const agentSessionId = typeof session.id === 'string' ? session.id : ''
    if (agentSessionId === '') return
    const body = renderReportBody({
      agentSessionId,
      cwd: typeof session.header?.cwd === 'string' ? session.header.cwd : null,
      title: state.titles.get(agentSessionId) ?? null,
      event,
      detail,
      // `hints` 的来源是**进程环境**：Neeko 拉起 DSH 时注入 `NEEKO_SESSION_ID` /
      // `NEEKO_PROJECT_ID`，命中即精确归属到既有会话实例（Rust 侧第 1 级判据）。
      env: {
        ...(fx.env.NEEKO_SESSION_ID === undefined
          ? {}
          : { NEEKO_SESSION_ID: fx.env.NEEKO_SESSION_ID }),
        ...(fx.env.NEEKO_PROJECT_ID === undefined
          ? {}
          : { NEEKO_PROJECT_ID: fx.env.NEEKO_PROJECT_ID }),
      },
    })
    debug(`report event=${event} session=${agentSessionId} title=${JSON.stringify(body.title)}`)
    void postToEndpoints(options.endpointsDirs, body, fx).then((failures) => {
      // `postToEndpoints` 契约上不 reject；但「HTTP 回了 4xx/5xx」与「204 成功」
      // 必须可区分 —— 204 但事件被白名单丢弃是本任务踩过的假绿灯形态。
      if (failures.length > 0) {
        debug(`delivery failures: ${failures.map((f) => `${f.port}:${f.status}`).join(' ')}`)
      }
    })
  }

  const disposers: Array<() => void> = []

  disposers.push(
    ctx.on('session/event', (session: ObservedSession, event: unknown) => {
      if (isSubagentSession(session)) return
      const shape = event as { type?: string; data?: Record<string, unknown> }
      const id = typeof session.id === 'string' ? session.id : ''
      if (shape.type === 'session/title') {
        const title = shape.data?.['title']
        if (id !== '' && typeof title === 'string' && title !== '') {
          state.titles.set(id, title)
        }
        return
      }
      if (shape.type === 'turn/end') {
        // 记下本轮结果；`agent/status` 落到 idle 时才决定报不报「完成」。
        const kind = (shape.data?.['reason'] as { kind?: unknown } | undefined)?.kind
        if (id !== '' && typeof kind === 'string') state.lastTurn.set(id, kind)
        return
      }
      const signal = notifyEventOf(shape as ObservedEvent)
      if (signal === null) return
      report(session, signal.event, signal.detail)
    }),
  )

  disposers.push(
    ctx.on('agent/status', (payload: { agent?: ObservedAgent; status?: string }) => {
      const agent = payload?.agent
      if (agent === undefined) return
      const observed = observedOf(agent)
      const id = typeof observed.id === 'string' ? observed.id : ''
      if (id === '') return
      const isRunning = payload.status === 'running'
      const wasRunning = state.running.get(id) === true
      state.running.set(id, isRunning)
      // 只有真发生 running → idle 才是「一轮结束」；首次 idle 不算。
      if (!wasRunning || isRunning) return
      // 结束 ≠ 完成：`error` / `aborted` 的轮次由 `agent/error` 或**不报**承担，
      // 否则失败会被追认成成功（且两条互斥文案同时到达）。
      const outcome = state.lastTurn.get(id)
      state.lastTurn.delete(id)
      if (outcome === undefined || outcome === 'completed') {
        report(observed, 'turn_completed', null)
      }
    }),
  )

  disposers.push(
    ctx.on('agent/error', (payload: { agent?: ObservedAgent; error?: unknown }) => {
      const agent = payload?.agent
      if (agent === undefined) return
      const message = payload.error instanceof Error ? payload.error.message : String(payload.error)
      report(observedOf(agent), 'session_failed', message.slice(0, 300))
    }),
  )

  debug(`reporter installed (dirs=${endpointsDirs.join(',') || '(none)'})`)

  return () => {
    while (disposers.length > 0) disposers.pop()?.()
  }
}
