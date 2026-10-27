import { describe, expect, it } from 'vitest'
import {
  ASK_USER_QUESTION_TOOL,
  isSubagentSession,
  notifyEventOf,
  renderReportBody,
  type NotifyEvent,
} from '../src/notify-reporter.ts'

/**
 * 通知上报的事件映射（纯函数）。
 *
 * 这些用例钉住三件事，每件都对应一次真实踩坑：
 *
 * 1. **用 `approval/asked` 而不是 `approval/request`** —— 后者是 cordis waterfall，
 *    注册监听器会抢走内置审批面板（`dsh-neeko` 自己就是 answerer）。
 * 2. **子代理会话必须用 `header.origin` 判** —— 分叉会话的 header 也带
 *    `parentSession`，用错字段会让分叉会话永远不通知。
 * 3. **`agent/status` 的 running→idle 才是完成信号** —— 不是 `turn/end`
 *    （那是历史重建用的事件，实时路径不保证顺序）。
 */
describe('notifyEventOf', () => {
  it('maps approval/asked to approval_requested', () => {
    const got = notifyEventOf({
      type: 'approval/asked',
      data: { toolName: 'bash', reason: 'needs network' },
    })
    expect(got).toEqual({
      event: 'approval_requested',
      detail: 'bash — needs network',
    })
  })

  it('maps approval/asked without a reason to just the tool name', () => {
    const got = notifyEventOf({ type: 'approval/asked', data: { toolName: 'edit_file' } })
    expect(got).toEqual({ event: 'approval_requested', detail: 'edit_file' })
  })

  it('maps an ask_user_question tool call to input_requested', () => {
    const got = notifyEventOf({
      type: 'tool/call',
      data: { name: ASK_USER_QUESTION_TOOL },
    })
    expect(got).toEqual({ event: 'input_requested', detail: ASK_USER_QUESTION_TOOL })
  })

  it('ignores tool calls for every other tool', () => {
    expect(notifyEventOf({ type: 'tool/call', data: { name: 'bash' } })).toBeNull()
  })

  it('never maps the approval/request waterfall event', () => {
    // 静态契约：这个事件名不该出现在任何映射里（它由 bridge 的 answerer 持有，
    // 第三方再监听会抢走内置审批面板）。
    expect(notifyEventOf({ type: 'approval/request', data: { toolName: 'bash' } })).toBeNull()
  })

  it('ignores presentation-only events', () => {
    for (const type of ['session/title', 'assistant/message', 'tool/result', 'step/start', 'step/end']) {
      expect(notifyEventOf({ type, data: {} })).toBeNull()
    }
  })

  it('does not treat turn/end as a notify event', () => {
    // `turn/end` 不产生通知 —— 它只被 `notify-wiring` 记下**原因**，由
    // `agent/status` 的 running→idle 边沿决定报不报「完成」（见
    // `notify-wiring.spec.ts::does not report a completed turn when the turn ended in error`）。
    expect(notifyEventOf({ type: 'turn/end', data: { reason: 'completed' } })).toBeNull()
  })

  it('survives events with no data payload', () => {
    expect(notifyEventOf({ type: 'approval/asked' })).toEqual({
      event: 'approval_requested',
      detail: null,
    })
  })
})

describe('isSubagentSession', () => {
  it('flags sessions whose header says origin=subagent', () => {
    expect(isSubagentSession({ header: { origin: 'subagent' } })).toBe(true)
  })

  it('keeps top-level sessions even when they carry parentSession (fork)', () => {
    // 分叉会话的 header 有 parentSession，但 origin 为空 —— 仍是顶层会话，
    // 任务完成应当通知。用 parentSession 判会漏掉它们。
    expect(isSubagentSession({ header: { parentSession: 'session-x' } })).toBe(false)
  })

  it('treats a session without a header as top-level', () => {
    expect(isSubagentSession({})).toBe(false)
  })
})

describe('renderReportBody', () => {
  const base = {
    agentSessionId: 'session-abc',
    cwd: '/work/proj',
    title: 'My session',
    event: 'turn_completed' as NotifyEvent,
    detail: null,
  }

  it('emits the six HookEvent fields Neeko validates', () => {
    const body = renderReportBody(base)
    expect(Object.keys(body).sort()).toEqual(
      ['agent_session_id', 'cwd', 'detail', 'event', 'hints', 'title'].sort(),
    )
    expect(body.agent_session_id).toBe('session-abc')
    expect(body.event).toBe('turn_completed')
    expect(body.cwd).toBe('/work/proj')
    expect(body.title).toBe('My session')
  })

  it('truncates long detail to 500 chars', () => {
    const body = renderReportBody({ ...base, detail: 'x'.repeat(900) })
    expect(body.detail).toHaveLength(500)
  })

  it('truncates long title to 200 chars', () => {
    const body = renderReportBody({ ...base, title: 'y'.repeat(500) })
    expect(body.title).toHaveLength(200)
  })

  it('passes env hints through, missing ones as null', () => {
    const body = renderReportBody({
      ...base,
      env: { NEEKO_SESSION_ID: 'n-1' },
    })
    expect(body.hints).toEqual({ neeko_session_id: 'n-1', project_id: null })
  })

  it('keeps nulls rather than dropping keys (Neeko tolerates null, not absence)', () => {
    const body = renderReportBody({ ...base, title: null, cwd: null })
    expect(body.title).toBeNull()
    expect(body.cwd).toBeNull()
    expect('title' in body).toBe(true)
  })
})

/**
 * `renderReportBody` 不得读取模块级可变状态。
 *
 * 标题 / 运行态 / 上一轮结果都住在 `notify-wiring.ts` 的 `ReporterState`（挂载实例
 * 私有，随 `installNotifyReporter` 生命周期），跨会话串味的用例见
 * `notify-wiring.spec.ts::keeps per-agent running state so one session cannot swallow another`。
 *
 * 本文件保留一条**反证钉子**：`renderReportBody` 的标题必须由调用方传进来 ——
 * 若它自己读共享缓存，跨会话串味将无法通过清空字段修复。
 */
describe('renderReportBody is free of module-level state', () => {
  it('takes the title from its input, never from a shared cache', () => {
    const first = renderReportBody({
      agentSessionId: 'a',
      cwd: null,
      title: 'first session',
      event: 'turn_completed',
      detail: null,
    })
    const second = renderReportBody({
      agentSessionId: 'b',
      cwd: null,
      title: null,
      event: 'turn_completed',
      detail: null,
    })
    expect(first.title).toBe('first session')
    expect(second.title).toBeNull()
  })
})
