/**
 * 「需要注意」事件 → Neeko 通知上报（源 B 腿）。
 *
 * # 为什么在 dsh-neeko 里，而不是另起一个插件包
 *
 * 本包已经跑在 DSH 进程内、已经订阅了 `session/event` 与 `agent/status`，
 * 也已经有握手后的会话上下文。通知只是**同一批事件的第二个消费者** ——
 * 另起一个包会得到：第二份 `ctx.on` 订阅、第二套配置、第二个安装面。
 *
 * # 为什么不用 `approval/request` / `user-questions/request`（关键）
 *
 * 那两个是 cordis **waterfall**：第一个不调 `next()` 的监听器终结整条链。
 * 本包（`agent-handlers.ts`）自己就是这两个 waterfall 的 answerer，
 * 再挂一个监听器会把内置审批面板挤掉或把答案吞掉。
 *
 * `approval/asked` 是 `session.append()` 的**落库审计事件**，旁路可听、零副作用 ——
 * 这是 `dsh-messager` 的选择（`src/signals.ts`），已被社区验证。
 *
 * # 为什么完成信号来自 `agent/status` 而不是 `turn/end`
 *
 * `turn/end` 是**历史重建**用的事件（见 `dsh-adapter.ts::buildHistory`），
 * 实时路径只保证事件被 append，不保证「一轮结束」这个语义边界。
 * `agent/status` 的 `running → idle` 才是权威边沿（`dsh-messager/src/index.ts:282`）。
 *
 * # 失败策略：fail-open
 *
 * 通知是旁路能力。DSH 会 `await` 监听器，所以上报必须：
 * 800ms 超时、任何异常吞掉、永不阻塞会话。坐标缺失（Neeko 没开）→ 零请求。
 *
 * @module dsh-neeko/notify-reporter
 */

/** `ask_user_question` 的稳定工具名（提问 / 计划待审都经由它发起）。 */
export const ASK_USER_QUESTION_TOOL = 'ask_user_question'

/** Neeko 的语义通知键（与 `agent/chat/notify.rs::event_keys` 同一命名空间）。 */
export type NotifyEvent =
  | 'approval_requested'
  | 'input_requested'
  | 'turn_completed'
  | 'session_failed'

/** 一次上报的语义内容（不含会话身份；身份由调用方补齐）。 */
export interface NotifySignal {
  readonly event: NotifyEvent
  readonly detail: string | null
}

/** `HookEvent` 的 wire 形状（与 Neeko `ingest/event.rs` 逐字段对齐）。 */
export interface ReportBody {
  agent_session_id: string
  event: NotifyEvent
  cwd: string | null
  detail: string | null
  title: string | null
  hints: { neeko_session_id: string | null; project_id: string | null }
}

/** 上报字段上限（与既有 shim 模板同口径：detail 500 / title 200）。 */
const DETAIL_LIMIT = 500
const TITLE_LIMIT = 200

/** 订阅点看到的最小事件形状（避免把 DSH 的完整 `SessionEvent` 类型拖进纯函数）。 */
export interface ObservedEvent {
  readonly type?: string
  readonly data?: { readonly name?: unknown; readonly toolName?: unknown; readonly reason?: unknown }
}

/**
 * 把一条**会话事件**（`session/event`）翻译成通知信号；与「用户需要注意」无关的
 * 事件返回 `null`。
 *
 * 它**只覆盖 `session/event`**：`turn_completed`（时机在 `agent/status` 的
 * running→idle 边沿）与 `session_failed`（`agent/error`）属于其它宿主面，
 * 绑定点在 `notify-wiring.ts`。
 *
 * **单向纯函数**：不读时钟、不读环境、不写状态 —— 故可穷举断言。
 *
 * @param event - 一条 `session/event` 载荷。
 * @returns 语义事件与展示细节；无关事件为 `null`。
 */
export function notifyEventOf(event: ObservedEvent): NotifySignal | null {
  if (event.type === 'approval/asked') {
    const tool = typeof event.data?.toolName === 'string' ? event.data.toolName : null
    const reason = typeof event.data?.reason === 'string' ? event.data.reason : null
    return {
      event: 'approval_requested',
      detail: tool === null ? reason : reason === null ? tool : `${tool} — ${reason}`,
    }
  }
  if (event.type === 'tool/call' && event.data?.name === ASK_USER_QUESTION_TOOL) {
    return { event: 'input_requested', detail: ASK_USER_QUESTION_TOOL }
  }
  // 其余（含 `approval/request` waterfall 事件、纯展示事件、`turn/end`）一律不报。
  return null
}

/** 会话身份的最小形状。 */
export interface ObservedSession {
  readonly id?: string
  readonly header?: {
    readonly origin?: string
    readonly parentSession?: unknown
    readonly cwd?: string
  }
}

/**
 * 是否是子代理会话（子代理的等待与结束是父对话那一轮的内部步骤，不应单独打扰）。
 *
 * **必须用 `header.origin`，不能用 `header.parentSession`** ——
 * 分叉会话（`sessions.fork`）的 header 也带 `parentSession`，但 `origin` 为空，
 * 仍是顶层会话。用错字段 = 分叉会话永远不通知（`dsh-messager/src/index.ts:284` 的实测教训）。
 *
 * @param session - 会话（或它的 header 快照）。
 * @returns 子代理 → `true`。
 */
export function isSubagentSession(session: ObservedSession): boolean {
  return session.header?.origin === 'subagent'
}

/** {@link renderReportBody} 的入参。 */
export interface ReportInput {
  readonly agentSessionId: string
  readonly cwd: string | null
  readonly title: string | null
  readonly event: NotifyEvent
  readonly detail: string | null
  readonly env?: { readonly NEEKO_SESSION_ID?: string; readonly NEEKO_PROJECT_ID?: string }
}

/**
 * 组装 `POST /hook/{source}` 的请求体。
 *
 * **字段齐全是契约**：Neeko 的 `HookEvent` 六个字段全部存在（可为 `null`，
 * 但键必须在）。缺失字段会让 `validate()` 静默丢弃整条事件 —— 而 HTTP 仍回 204，
 * 表现为「装了但没通知」（Step 0 P6b 实测）。
 *
 * @param input - 语义内容 + 会话身份。
 * @returns 可直接 `JSON.stringify` 的请求体。
 */
export function renderReportBody(input: ReportInput): ReportBody {
  return {
    agent_session_id: input.agentSessionId,
    event: input.event,
    cwd: input.cwd,
    detail: truncate(input.detail, DETAIL_LIMIT),
    title: truncate(input.title, TITLE_LIMIT),
    hints: {
      neeko_session_id: input.env?.NEEKO_SESSION_ID ?? null,
      project_id: input.env?.NEEKO_PROJECT_ID ?? null,
    },
  }
}

/** 按字符数截断（`null` 透传）。 */
function truncate(value: string | null, limit: number): string | null {
  if (value === null) return null
  return value.length > limit ? value.slice(0, limit) : value
}
