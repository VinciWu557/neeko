import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { notifyEventOf, type NotifyEvent } from '../src/notify-reporter.ts'
import { parseCoords, postToEndpoints, reportUrl } from '../src/notify-transport.ts'

/**
 * **跨栈 wire 契约护栏**：本包与 Neeko 之间那四个字符串常量，一处改名必须变红。
 *
 * # 为什么这条必须存在
 *
 * 坐标键、token 头、`/hook/{source}` 路由段、四个 `event_key` 全部是**双端各写一份
 * 字面量**。既有 7 个源靠 `agent/hooks/templates/tests.rs` 的锚点测试绑住 —— 那些断言
 * 引用 Rust 侧的**常量本身**。但本包住在 `packages/`（不纳入根门禁），也不在
 * `templates/` 下，于是**没有任何一条测试把两侧绑在一起**：改 Rust 常量名，包侧
 * 静默断裂，两侧测试各自全绿。
 *
 * 这正是根 `AGENTS.md` 红线 5（Event 名常量化）的判据精神：名字只允许来自单一源。
 * 红线字面只覆盖 Tauri Event 名，本文件把同一判据用在 hook wire 契约上。
 *
 * # 为什么读源码而不是复制一份常量
 *
 * 「断言字面量与另一处字面量相等」需要**两个**字面量；从 Rust 源码里取出来的那个
 * 才是权威源。读不到源码即失败（不静默跳过）—— `packages/` 与 `src-tauri/` 同仓，
 * 读不到说明目录结构变了，那时该有人重看这条断言。
 */

const RUST_HOOKS = new URL('../../../src-tauri/src/agent/hooks/', import.meta.url)

/** 从 Rust 源里取 `pub const NAME: &str = "value";` 的值；缺失即抛。 */
function rustConst(file: string, name: string): string {
  const source = readFileSync(new URL(file, RUST_HOOKS), 'utf8')
  const match = new RegExp(`pub const ${name}: &str = "([^"]+)";`).exec(source)
  if (match?.[1] === undefined) {
    throw new Error(`未找到 ${file} 的 pub const ${name} —— 契约源头改了名字？`)
  }
  return match[1]
}

/** `event_keys` 模块里的全部常量值（Rust 侧是唯一的 `event_key` 命名空间）。 */
function rustEventKeys(): string[] {
  const source = readFileSync(new URL('../../../src-tauri/src/agent/chat/notify.rs', import.meta.url), 'utf8')
  const module = source.split('pub mod event_keys {')[1]?.split('\n}')[0] ?? ''
  return [...module.matchAll(/pub const \w+: &str = "([^"]+)";/g)].map((m) => m[1] as string)
}

describe('hook wire contract mirrors the Rust constants', () => {
  it('reads the coordinate keys from the Rust source', () => {
    // 这两个键是坐标文件的两行（Rust 侧 `endpoint::render` 写、本包读）。
    expect(rustConst('ingest/endpoint.rs', 'ENV_KEY_PORT')).toBe('NEEKO_AGENT_HOOK_PORT')
    expect(rustConst('ingest/endpoint.rs', 'ENV_KEY_TOKEN')).toBe('NEEKO_AGENT_HOOK_TOKEN')
    expect(rustConst('ingest/endpoint.rs', 'ENV_KEY_OVERRIDE')).toBe('NEEKO_AGENT_HOOK_ENDPOINT')
  })

  it('parses a coordinate file written by the Rust renderer', () => {
    // 用 Rust 侧的**实际输出格式**（`{PORT}={}\n{TOKEN}={}\n`）造夹具，而不是手写一份。
    const port = rustConst('ingest/endpoint.rs', 'ENV_KEY_PORT')
    const token = rustConst('ingest/endpoint.rs', 'ENV_KEY_TOKEN')
    expect(parseCoords(`${port}=53124\n${token}=abc-123\n`)).toEqual({
      port: '53124',
      token: 'abc-123',
    })
  })

  it('sends the token header the Rust gate reads', async () => {
    const header = rustConst('ingest/validation.rs', 'TOKEN_HEADER')
    const seen: Record<string, string> = {}
    await postToEndpoints(
      ['/e'],
      {
        agent_session_id: 's1',
        event: 'turn_completed',
        cwd: null,
        detail: null,
        title: null,
        hints: { neeko_session_id: null, project_id: null },
      },
      {
        readFile: async () => 'NEEKO_AGENT_HOOK_PORT=1\nNEEKO_AGENT_HOOK_TOKEN=t\n',
        listDir: async () => ['a.env'],
        env: {},
        fetch: async (_url, init) => {
          Object.assign(seen, init.headers)
          return { status: 204 }
        },
      },
    )
    expect(seen[header]).toBe('t')
  })

  it('routes to the source segment the ingest whitelist knows', () => {
    // `reportUrl` 硬编码 `/hook/dsh`；白名单键是 `HOOK_TARGETS` 里那一行的 `source`。
    // 断言**后缀相等**而不是 `toContain` —— `dshx` 也 contain `/hook/dsh`。
    const data = readFileSync(new URL('targets/data.rs', RUST_HOOKS), 'utf8')
    const source = /source: "(dsh)"/.exec(data)?.[1]
    expect(source).toBe('dsh')
    expect(reportUrl('53124')).toBe(`http://127.0.0.1:53124/hook/${source}`)
  })

  it('uses only event keys the notification projection can classify', () => {
    // Rust 侧 `ingest/notify.rs::classify` 只认 `event_keys` 里的值；本包发别的任何
    // 字符串都会被 fail-open 静默丢弃（204 假绿灯）。
    const known = rustEventKeys()
    const emitted: NotifyEvent[] = [
      ...new Set(
        [
          notifyEventOf({ type: 'approval/asked', data: {} })?.event,
          notifyEventOf({ type: 'tool/call', data: { name: 'ask_user_question' } })?.event,
          // `turn_completed` / `session_failed` 由 `notify-wiring` 产生（不经 `notifyEventOf`）。
          'turn_completed',
          'session_failed',
        ].filter((v): v is NotifyEvent => v !== undefined),
      ),
    ]
    expect(emitted).toHaveLength(4)
    for (const key of emitted) expect(known).toContain(key)
  })
})
