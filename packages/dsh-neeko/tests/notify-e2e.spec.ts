import { describe, expect, it } from 'vitest'
import {
  isSubagentSession,
  notifyEventOf,
  renderReportBody,
} from '../src/notify-reporter.ts'
import { postToEndpoints, parseCoords, reportUrl } from '../src/notify-transport.ts'

/**
 * 端到端（**无网络、无 DSH 运行时**）：把「一条 host 事件」走到「一份 HTTP 请求体」。
 *
 * 这条链有三个各自会静默失败的环节，本文件把它们串起来一起钉住：
 *
 * 1. **语义**（`notifyEventOf`）：选错事件 → 永不触发或抢走审批面板；
 * 2. **形状**（`renderReportBody`）：少一个字段 → Neeko 返回 204 但丢弃事件；
 * 3. **投递**（`postToEndpoints`）：坐标读不到 → 零请求，且**看起来像成功**。
 *
 * 第 2 条是 Step 0 P6b 实测到的真实事故：`/hook/dsh` 的 source 白名单缺行时，
 * 服务端返回 204 而事件被静默丢掉。只看状态码会得到假绿灯，故这里断言的是
 * **请求体本身**。
 */
describe('宿主事件 → Neeko 上报（全链路，无网络）', () => {
  const endpointText = 'NEEKO_AGENT_HOOK_PORT=53124\nNEEKO_AGENT_HOOK_TOKEN=tok-1\n'

  function harness() {
    const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = []
    const fx = {
      env: {} as Record<string, string | undefined>,
      readFile: async () => endpointText,
      listDir: async () => ['instance.env'],
      fetch: async (url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({ url, init })
        return { status: 204 }
      },
    }
    return { fx, calls }
  }

  it('reports an approval as approval_requested with the six HookEvent fields', async () => {
    const session = { id: 'session-abc', header: { cwd: '/work/proj' } }
    const signal = notifyEventOf({
      type: 'approval/asked',
      data: { toolName: 'bash', reason: 'needs network' },
    })
    expect(signal).not.toBeNull()

    const { fx, calls } = harness()
    const body = renderReportBody({
      agentSessionId: session.id,
      cwd: session.header.cwd,
      title: 'Refactor the parser',
      event: signal!.event,
      detail: signal!.detail,
    })
    await postToEndpoints(['/endpoints'], body, fx)

    expect(calls).toHaveLength(1)
    const first = calls[0]
    expect(first).toBeDefined()
    expect(first?.url).toBe(reportUrl('53124'))
    expect(first?.init.headers['x-neeko-agent-hook-token']).toBe('tok-1')
    const sent = JSON.parse(first?.init.body ?? '{}')
    expect(sent).toMatchObject({
      agent_session_id: 'session-abc',
      event: 'approval_requested',
      cwd: '/work/proj',
      detail: 'bash — needs network',
      title: 'Refactor the parser',
    })
    expect(Object.keys(sent).sort()).toEqual(
      ['agent_session_id', 'cwd', 'detail', 'event', 'hints', 'title'].sort(),
    )
  })

  it('reports ask_user_question as input_requested', async () => {
    const signal = notifyEventOf({ type: 'tool/call', data: { name: 'ask_user_question' } })
    expect(signal).toEqual({ event: 'input_requested', detail: 'ask_user_question' })
  })

  it('reports a finished turn as turn_completed', async () => {
    // 完成信号来自 `agent/status` 的 running→idle 边沿（不是 turn/end）。
    const { fx, calls } = harness()
    const body = renderReportBody({
      agentSessionId: 'session-abc',
      cwd: null,
      title: null,
      event: 'turn_completed',
      detail: null,
    })
    await postToEndpoints(['/endpoints'], body, fx)
    expect(JSON.parse(calls[0]?.init.body ?? '{}').event).toBe('turn_completed')
  })

  it('reports an agent failure as session_failed with the message', async () => {
    const { fx, calls } = harness()
    const body = renderReportBody({
      agentSessionId: 'session-abc',
      cwd: null,
      title: null,
      event: 'session_failed',
      detail: 'model returned 500',
    })
    await postToEndpoints(['/endpoints'], body, fx)
    expect(JSON.parse(calls[0]?.init.body ?? '{}')).toMatchObject({
      event: 'session_failed',
      detail: 'model returned 500',
    })
  })

  it('never reports a subagent session', async () => {
    const subagent = { id: 'session-child', header: { origin: 'subagent' } }
    expect(isSubagentSession(subagent)).toBe(true)
    // 分叉会话的 header 也带 `parentSession`，但它是顶层会话 —— 判据必须只认 `origin`
    // （用错字段会让分叉会话永远不通知）。接线层的过滤见
    // `notify-wiring.spec.ts::never reports subagent sessions`。
    const fork = { id: 'session-fork', header: { parentSession: 'session-parent' } }
    expect(isSubagentSession(fork)).toBe(false)
  })

  it('is a no-op when Neeko is not running (no endpoint directory)', async () => {
    const { fx, calls } = harness()
    fx.listDir = async () => {
      throw new Error('ENOENT')
    }
    const body = renderReportBody({
      agentSessionId: 'session-abc',
      cwd: null,
      title: null,
      event: 'turn_completed',
      detail: null,
    })
    await expect(postToEndpoints(['/missing'], body, fx)).resolves.toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('the coordinate contract matches what Neeko writes', () => {
    // 与 `agent/hooks/ingest/endpoint.rs::render` 同一格式。
    expect(parseCoords(endpointText)).toEqual({ port: '53124', token: 'tok-1' })
    expect(reportUrl('53124')).toBe('http://127.0.0.1:53124/hook/dsh')
  })

  it('does not touch the network when the coordinate file is unreadable', async () => {
    const { fx, calls } = harness()
    fx.readFile = async () => {
      throw new Error('EACCES')
    }
    const body = renderReportBody({
      agentSessionId: 'session-abc',
      cwd: null,
      title: null,
      event: 'turn_completed',
      detail: null,
    })
    await postToEndpoints(['/endpoints'], body, fx)
    expect(calls).toHaveLength(0)
  })

  it('a dead coordinate does not stop the live one', async () => {
    const delivered: string[] = []
    const fx = {
      env: {},
      readFile: async (p: string) =>
        p.includes('dead')
          ? 'NEEKO_AGENT_HOOK_PORT=1\nNEEKO_AGENT_HOOK_TOKEN=d\n'
          : 'NEEKO_AGENT_HOOK_PORT=2\nNEEKO_AGENT_HOOK_TOKEN=l\n',
      listDir: async () => ['dead.env', 'live.env'],
      fetch: async (url: string) => {
        if (url.includes(':1/')) throw new Error('ECONNREFUSED')
        delivered.push(url)
        return { status: 204 }
      },
    }
    const body = renderReportBody({
      agentSessionId: 'session-abc',
      cwd: null,
      title: null,
      event: 'turn_completed',
      detail: null,
    })
    await postToEndpoints(['/endpoints'], body, fx)
    expect(delivered).toEqual([reportUrl('2')])
  })
})
