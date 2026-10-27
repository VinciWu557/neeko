import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { installNotifyReporter, observedOf, type NotifyWiringContext } from '../src/notify-wiring.ts'

const ENDPOINT = 'NEEKO_AGENT_HOOK_PORT=9\nNEEKO_AGENT_HOOK_TOKEN=t\n'

/**
 * 通知上报必须**与运行模式无关**地挂载。
 *
 * 真机事故（2026-10-27）：`cordis.patch.yml` 里 `id: neeko`（`NeekoBridge`）在 `--tui`
 * 时被 `disabled` 掉，`id: neeko-tui` 顶上 —— 而当时通知逻辑写在 `NeekoBridge` 内部。
 * 后果：用户日常跑 `dsh --profile neeko --tui`，**通知代码一行都没跑**，且没有任何日志。
 *
 * 故上报被抽成本模块，由**两条腿各自**调用 `installNotifyReporter`：
 * bridge 在 `start()`，TUI 在 runner 启动处。任何一条腿忘了调，本文件的
 * `both runners install the reporter` 用例会红。
 */
function fakeCtx() {
  const handlers = new Map<string, Array<(...args: any[]) => void>>()
  const ctx: NotifyWiringContext = {
    on(name: string, listener: (...args: any[]) => void) {
      const list = handlers.get(name) ?? []
      list.push(listener)
      handlers.set(name, list)
      return () => {}
    },
  }
  const emit = (name: string, ...args: any[]) => {
    for (const fn of handlers.get(name) ?? []) fn(...args)
  }
  return { ctx, emit, handlers }
}

function reporter(sent: Array<{ url: string; body: string }>) {
  return {
    listDir: async () => ['a.env'],
    readFile: async () => ENDPOINT,
    fetch: async (url: string, init: { body: string }) => {
      sent.push({ url, body: init.body })
      return { status: 204 }
    },
    env: {},
  }
}

/**
 * 一条 `session/event` 的 `session` 是 `Session`（带 `header`）。
 */
const session = (id: string, origin?: string) => ({
  id,
  header: origin === undefined ? { cwd: '/w' } : { origin, cwd: '/w' },
})

/**
 * `agent/status` / `agent/error` 的 `payload.agent` 是 `Agent`：**没有 `header`**，
 * `header` 在 `agent.session` 上（`dsh-agent/lib/types/types.d.ts` 只给 `Agent` 一个 `id`，
 * `dsh-session` 才给 `Session` 一个 `header`）。
 *
 * 用真实形状而不是 `session()` —— 假形状会让「把 `Agent` 当 `Session` 读」这个缺陷
 * 在类型与单测上双双合法（`ObservedSession` 字段全 optional），2026-10-27 实测漏过。
 */
const agentOf = (id: string, origin?: string) => ({
  id,
  session: {
    id,
    header: origin === undefined ? { cwd: '/w' } : { origin, cwd: '/w' },
  },
})

describe('installNotifyReporter', () => {
  it('reports approval/asked as approval_requested', async () => {
    const sent: Array<{ url: string; body: string }> = []
    const { ctx, emit } = fakeCtx()
    installNotifyReporter(ctx, ['/e'], reporter(sent))
    emit('session/event', session('s1'), { type: 'approval/asked', data: { toolName: 'bash' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]?.body ?? '{}').event).toBe('approval_requested')
  })

  it('reports turn_completed on the running → idle edge', async () => {
    const sent: Array<{ url: string; body: string }> = []
    const { ctx, emit } = fakeCtx()
    installNotifyReporter(ctx, ['/e'], reporter(sent))
    emit('session/event', session('s1'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    emit('agent/status', { agent: agentOf('s1'), status: 'running' })
    emit('agent/status', { agent: agentOf('s1'), status: 'idle' })
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]?.body ?? '{}').event).toBe('turn_completed')
  })

  it('does not report when a session goes idle without a running phase', async () => {
    // 首次 idle（未经过 running）不是「完成」，报它就是误报。
    const sent: Array<{ url: string; body: string }> = []
    const { ctx, emit } = fakeCtx()
    installNotifyReporter(ctx, ['/e'], reporter(sent))
    emit('agent/status', { agent: agentOf('s1'), status: 'idle' })
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toHaveLength(0)
  })

  it('reports agent/error as session_failed', async () => {
    const sent: Array<{ url: string; body: string }> = []
    const { ctx, emit } = fakeCtx()
    installNotifyReporter(ctx, ['/e'], reporter(sent))
    emit('agent/error', { agent: agentOf('s1'), error: new Error('boom') })
    await new Promise((r) => setTimeout(r, 0))
    expect(JSON.parse(sent[0]?.body ?? '{}')).toMatchObject({
      event: 'session_failed',
      detail: 'boom',
    })
  })

  it('uses the session title captured from session/title', async () => {
    const sent: Array<{ url: string; body: string }> = []
    const { ctx, emit } = fakeCtx()
    installNotifyReporter(ctx, ['/e'], reporter(sent))
    emit('session/event', session('s1'), { type: 'session/title', data: { title: 'My task' } })
    emit('session/event', session('s1'), { type: 'approval/asked', data: { toolName: 'bash' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(JSON.parse(sent[0]?.body ?? '{}').title).toBe('My task')
  })

  it('never reports subagent sessions', async () => {
    const sent: Array<{ url: string; body: string }> = []
    const { ctx, emit } = fakeCtx()
    installNotifyReporter(ctx, ['/e'], reporter(sent))
    emit('session/event', session('sub', 'subagent'), { type: 'approval/asked', data: {} })
    emit('agent/status', { agent: agentOf('sub', 'subagent'), status: 'running' })
    emit('agent/status', { agent: agentOf('sub', 'subagent'), status: 'idle' })
    emit('agent/error', { agent: agentOf('sub', 'subagent'), error: new Error('boom') })
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toHaveLength(0)
  })

  it('keeps per-agent running state so one session cannot swallow another', async () => {
    const sent: Array<{ url: string; body: string }> = []
    const { ctx, emit } = fakeCtx()
    installNotifyReporter(ctx, ['/e'], reporter(sent))
    emit('session/event', session('a'), { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    emit('session/event', session('b'), { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    emit('agent/status', { agent: agentOf('a'), status: 'running' })
    emit('agent/status', { agent: agentOf('b'), status: 'running' })
    emit('agent/status', { agent: agentOf('a'), status: 'idle' })
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]?.body ?? '{}').agent_session_id).toBe('a')
  })

  it('does not report a completed turn when the turn ended in error', async () => {
    // 「结束」≠「完成」：`agent/status` 只给时机，`turn/end.reason` 给原因。
    // 只取时机会让失败轮先发 session_failed、紧接着再发 turn_completed
    // （与 `.trellis/spec/backend/agent-chat-transports.md` §4.6b 的 pi 缺陷同型）。
    const sent: Array<{ url: string; body: string }> = []
    const { ctx, emit } = fakeCtx()
    installNotifyReporter(ctx, ['/e'], reporter(sent))
    emit('session/event', session('s1'), { type: 'turn/end', data: { reason: { kind: 'error' } } })
    emit('agent/status', { agent: agentOf('s1'), status: 'running' })
    emit('agent/status', { agent: agentOf('s1'), status: 'idle' })
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toHaveLength(0)
  })

  it('does not report a completed turn when the user aborted it', async () => {
    const sent: Array<{ url: string; body: string }> = []
    const { ctx, emit } = fakeCtx()
    installNotifyReporter(ctx, ['/e'], reporter(sent))
    emit('session/event', session('s1'), { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    emit('agent/status', { agent: agentOf('s1'), status: 'running' })
    emit('agent/status', { agent: agentOf('s1'), status: 'idle' })
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toHaveLength(0)
  })

  it('reports the next completed turn after a failed one', async () => {
    // 失败状态不得污染下一轮（清零时机与 `agent_settled` 同款）。
    const sent: Array<{ url: string; body: string }> = []
    const { ctx, emit } = fakeCtx()
    installNotifyReporter(ctx, ['/e'], reporter(sent))
    emit('session/event', session('s1'), { type: 'turn/end', data: { reason: { kind: 'error' } } })
    emit('agent/status', { agent: agentOf('s1'), status: 'running' })
    emit('agent/status', { agent: agentOf('s1'), status: 'idle' })
    emit('session/event', session('s1'), { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    emit('agent/status', { agent: agentOf('s1'), status: 'running' })
    emit('agent/status', { agent: agentOf('s1'), status: 'idle' })
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0]?.body ?? '{}').event).toBe('turn_completed')
  })

  it('carries cwd from agent.session.header', async () => {
    // `Agent` 没有 `header`；读错位置会让 cwd 恒 null → Rust 归属链掉到最弱兜底。
    const sent: Array<{ url: string; body: string }> = []
    const { ctx, emit } = fakeCtx()
    installNotifyReporter(ctx, ['/e'], reporter(sent))
    emit('session/event', session('s1'), { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    emit('agent/status', { agent: agentOf('s1'), status: 'running' })
    emit('agent/status', { agent: agentOf('s1'), status: 'idle' })
    await new Promise((r) => setTimeout(r, 0))
    expect(JSON.parse(sent[0]?.body ?? '{}').cwd).toBe('/w')
  })

  it('passes the Neeko session hints from the process env', async () => {
    const sent: Array<{ url: string; body: string }> = []
    const { ctx, emit } = fakeCtx()
    const fx = reporter(sent)
    installNotifyReporter(ctx, ['/e'], {
      ...fx,
      env: { NEEKO_SESSION_ID: 'sess-1', NEEKO_PROJECT_ID: 'proj-1' },
    })
    emit('session/event', session('s1'), { type: 'approval/asked', data: { toolName: 'bash' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(JSON.parse(sent[0]?.body ?? '{}').hints).toEqual({
      neeko_session_id: 'sess-1',
      project_id: 'proj-1',
    })
  })

  it('subscribes exactly the three host surfaces it needs', () => {
    // 订阅面越少越好：每个多余的监听器都是 DSH 每轮要 await 一次的成本。
    const { ctx, handlers } = fakeCtx()
    installNotifyReporter(ctx, ['/e'], reporter([]))
    expect([...handlers.keys()].sort()).toEqual([
      'agent/error',
      'agent/status',
      'session/event',
    ])
  })
})

/**
 * **两条运行腿都必须装上报器**。
 *
 * 这是本次事故的直接防线：通知曾只装在 `NeekoBridge` 里，而 `--tui` 模式下
 * 那行 `cordis.patch.yml` 是 `disabled` 的 —— 用户日常模式零通知、零日志。
 */
describe('both runtime legs install the reporter', () => {
  const read = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')

  /**
   * 判据必须是**调用点**，不是标识符出现过。
   *
   * 第一版写 `toContain('installNotifyReporter')`，命中的是文件顶部的 `import` 语句 ——
   * 删掉真正的调用而保留 import，用例仍全绿。这正是 `quality-guidelines.md` §18(c)
   * 「判据要钉在不变量上」的反例，而本模块头把这条断言写成那次真机事故的**唯一防线**。
   */
  it('the bridge leg calls it with the host context', () => {
    expect(read('index.ts')).toMatch(/installNotifyReporter\(\s*this\.ctx,/)
  })

  it('the TUI leg calls it with its context', () => {
    expect(read('tui/runner.ts')).toMatch(/installNotifyReporter\(\s*ctx,/)
  })
})

describe('observedOf', () => {
  it('reads the header from agent.session', () => {
    expect(observedOf(agentOf('a'))).toEqual({ id: 'a', header: { cwd: '/w' } })
  })

  it('keeps the id when the agent has no session yet', () => {
    expect(observedOf({ id: 'a' })).toEqual({ id: 'a' })
  })
})
