import { describe, expect, it, vi } from 'vitest'
import { parseCoords, postToEndpoints, reportUrl, type ReporterEffects } from '../src/notify-transport.ts'

/**
 * 上报投递层：坐标解析 + fan-out。
 *
 * 与 `notify-reporter.ts`（纯映射）分开测的理由：那一层是**语义**（哪个事件值得打扰），
 * 这一层是**传输**（往哪发、发不发得出去）。两者的失败后果完全不同：
 * 语义错了是误报，传输错了是静默丢失 —— 而 HTTP 会回 204 把后者伪装成成功。
 */
describe('parseCoords', () => {
  it('reads the two keys the endpoint file carries', () => {
    const text = 'NEEKO_AGENT_HOOK_PORT=53124\nNEEKO_AGENT_HOOK_TOKEN=abc-123\n'
    expect(parseCoords(text)).toEqual({ port: '53124', token: 'abc-123' })
  })

  it('tolerates CRLF and surrounding whitespace', () => {
    // 坐标文件由 Rust 侧原子写，理论上永远 LF；但用户可能用编辑器打开过它。
    const text = 'NEEKO_AGENT_HOOK_PORT=53124\r\nNEEKO_AGENT_HOOK_TOKEN=abc-123\r\n'
    expect(parseCoords(text)).toEqual({ port: '53124', token: 'abc-123' })
  })

  it('returns null when either key is missing', () => {
    expect(parseCoords('NEEKO_AGENT_HOOK_PORT=53124\n')).toBeNull()
    expect(parseCoords('NEEKO_AGENT_HOOK_TOKEN=x\n')).toBeNull()
    expect(parseCoords('')).toBeNull()
  })

  it('does not match keys by substring', () => {
    // 以前缀匹配会把 `X_NEEKO_AGENT_HOOK_PORT` 也吃进来。
    const text = 'X_NEEKO_AGENT_HOOK_PORT=1\nX_NEEKO_AGENT_HOOK_TOKEN=2\n'
    expect(parseCoords(text)).toBeNull()
  })
})

describe('reportUrl', () => {
  it('targets the dsh source segment', () => {
    expect(reportUrl('53124')).toBe('http://127.0.0.1:53124/hook/dsh')
  })
})

describe('postToEndpoints', () => {
  const body = {
    agent_session_id: 's1',
    event: 'turn_completed' as const,
    cwd: '/w',
    detail: null,
    title: null,
    hints: { neeko_session_id: null, project_id: null },
  }

  function effects(overrides: Partial<ReporterEffects> = {}): {
    fx: ReporterEffects
    fetch: ReturnType<typeof vi.fn>
  } {
    const fetch = vi.fn(async () => ({ status: 204 }))
    const fx: ReporterEffects = {
      fetch,
      readFile: async () => 'NEEKO_AGENT_HOOK_PORT=1\nNEEKO_AGENT_HOOK_TOKEN=t\n',
      listDir: async () => ['a.env'],
      env: {},
      ...overrides,
    }
    return { fx, fetch: fetch as unknown as ReturnType<typeof vi.fn> }
  }

  it('posts once per coordinate with the token header', async () => {
    const { fx, fetch } = effects()
    await postToEndpoints(['/endpoints'], body, fx)
    expect(fetch).toHaveBeenCalledTimes(1)
    const call = fetch.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(call[0]).toBe('http://127.0.0.1:1/hook/dsh')
    expect(call[1].headers['x-neeko-agent-hook-token']).toBe('t')
    expect(JSON.parse(call[1].body)).toEqual(body)
  })

  it('fans out to every endpoint directory (multi-instance)', async () => {
    const { fx, fetch } = effects({
      listDir: async () => ['a.env', 'b.env'],
      readFile: async (p: string) =>
        p.includes('a.env')
          ? 'NEEKO_AGENT_HOOK_PORT=1\nNEEKO_AGENT_HOOK_TOKEN=a\n'
          : 'NEEKO_AGENT_HOOK_PORT=2\nNEEKO_AGENT_HOOK_TOKEN=b\n',
    })
    await postToEndpoints(['/endpoints'], body, fx)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('fails open when a directory cannot be listed', async () => {
    // Neeko 没运行 → 目录不存在。必须零请求、不抛。
    const { fx, fetch } = effects({ listDir: async () => { throw new Error('ENOENT') } })
    await expect(postToEndpoints(['/nope'], body, fx)).resolves.toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps delivering to healthy endpoints when one is dead', async () => {
    let call = 0
    const { fx } = effects({
      listDir: async () => ['a.env', 'b.env'],
      readFile: async (p: string) =>
        p.includes('a.env')
          ? 'NEEKO_AGENT_HOOK_PORT=1\nNEEKO_AGENT_HOOK_TOKEN=a\n'
          : 'NEEKO_AGENT_HOOK_PORT=2\nNEEKO_AGENT_HOOK_TOKEN=b\n',
      fetch: async (url: string) => {
        call += 1
        if (String(url).includes(':1/')) throw new Error('ECONNREFUSED')
        return { status: 204 }
      },
    })
    const failures = await postToEndpoints(['/endpoints'], body, fx)
    expect(call).toBe(2)
    // 死坐标进失败清单（status 0 = 连不上），活坐标不出现。
    expect(failures).toEqual([{ port: '1', status: 0 }])
  })

  it('never rejects even when every endpoint throws', async () => {
    const { fx } = effects({
      fetch: async () => {
        throw new Error('boom')
      },
    })
    const failures = await postToEndpoints(['/endpoints'], body, fx)
    expect(failures).toEqual([{ port: '1', status: 0 }])
  })

  it('reports an HTTP rejection instead of swallowing it', async () => {
    // 契约「永不 reject」不等于「永不报告」：401 / 白名单缺行与成功必须可区分，
    // 否则 204 假绿灯的形态在代码里完全同形（Step 0 P6b 实测事故）。
    const { fx } = effects({ fetch: async () => ({ status: 401 }) })
    await expect(postToEndpoints(['/endpoints'], body, fx)).resolves.toEqual([
      { port: '1', status: 401 },
    ])
  })

  it('treats 2xx as success', async () => {
    const { fx } = effects({ fetch: async () => ({ status: 204 }) })
    await expect(postToEndpoints(['/endpoints'], body, fx)).resolves.toEqual([])
  })

  it('honours the endpoints-directory override', async () => {
    // `NEEKO_AGENT_HOOK_ENDPOINTS_DIR` 与既有 shim 模板同契约：把坐标根整体搬走时
    // 仍要能投递。此前只实现单文件覆盖 → 该类环境里 DSH 恒零请求（其余 7 个源正常）。
    const dirs: string[] = []
    const { fx } = effects({
      env: { NEEKO_AGENT_HOOK_ENDPOINTS_DIR: '/moved' },
      listDir: async (p: string) => {
        dirs.push(p)
        return []
      },
    })
    await postToEndpoints(['/default'], body, fx)
    expect(dirs).toEqual(['/moved'])
  })

  it('skips files that are not .env', async () => {
    const { fx, fetch } = effects({ listDir: async () => ['readme.txt', 'stale.env.bak'] })
    await postToEndpoints(['/endpoints'], body, fx)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('honours the single-file override (debug / test fixtures)', async () => {
    // `NEEKO_AGENT_HOOK_ENDPOINT` 指向单个文件时只读它、不扫目录（与既有 shim 同契约）。
    const { fx, fetch } = effects({
      env: { NEEKO_AGENT_HOOK_ENDPOINT: '/one.env' },
      listDir: async () => {
        throw new Error('must not scan when override is set')
      },
    })
    await postToEndpoints(['/endpoints'], body, fx)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('does nothing without an agent session id', async () => {
    const { fx, fetch } = effects()
    await postToEndpoints(['/endpoints'], { ...body, agent_session_id: '' }, fx)
    expect(fetch).not.toHaveBeenCalled()
  })
})
