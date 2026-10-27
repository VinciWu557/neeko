/**
 * 通知上报的**投递层**：坐标发现 + fan-out。
 *
 * 与 [`./notify-reporter`] 的分工：那边是**语义**（哪个事件值得打扰），
 * 这边是**传输**（往哪发、发不发得出去）。两者的失败后果不同 ——
 * 语义错了是误报，传输错了是静默丢失，而 HTTP 会回 204 把后者伪装成成功
 * （Step 0 P6b 实测：`/hook/dsh` 在 source 白名单缺行时正是这样）。
 *
 * # 坐标契约（与 Neeko `agent/hooks/ingest/endpoint.rs` 是同一契约的两端）
 *
 * ```
 * ~/.neeko/agent-hooks/endpoints/<instance_id>.env
 *   NEEKO_AGENT_HOOK_PORT=53124
 *   NEEKO_AGENT_HOOK_TOKEN=<uuid-v4>
 * ```
 *
 * 多实例：**每实例一个文件**，全部扫、逐个 POST。单坐标失败不影响其余
 * （Neeko 退出会留下死坐标，删它会造成重启窗口期丢事件 —— 故由上报端 fail-open 跳过）。
 *
 * # 为什么用可注入的 `ReporterEffects` 而不是直接 `node:fs`
 *
 * 上报是**旁路**，它不能因为读盘失败而打断 DSH 会话。把 IO 收进 effects 后：
 * ① 每条失败分支都能用纯函数单测覆盖（不必造真目录）；② 生产实现是薄薄一层真 fs。
 *
 * @module dsh-neeko/notify-transport
 */

import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ReportBody } from './notify-reporter.ts'

/** 一个上报坐标。 */
export interface Coord {
  readonly port: string
  readonly token: string
}

/** 投递层的外部依赖（测试替换点）。 */
export interface ReporterEffects {
  /** `fetch` —— 只需 `status`，不需要读 body。 */
  readFile: (path: string) => Promise<string>
  listDir: (path: string) => Promise<string[]>
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }>
  /** 进程环境（`NEEKO_AGENT_HOOK_ENDPOINT` 覆盖 / `NEEKO_SESSION_ID` 等）。 */
  env: Record<string, string | undefined>
}

/** 单次上报的超时预算 —— 与既有 shim 模板同口径（800ms）。 */
export const REPORT_TIMEOUT_MS = 800

/** 默认坐标目录（`$HOME/.neeko/agent-hooks/endpoints`）。 */
export function defaultEndpointsDir(): string {
  return join(homedir(), '.neeko', 'agent-hooks', 'endpoints')
}

/**
 * 解析一个坐标文件。
 *
 * 键必须**行首精确匹配**（`^KEY=`）：用子串/前缀匹配会把
 * `X_NEEKO_AGENT_HOOK_PORT` 之类也吃进来，得到一个不存在的端口。
 *
 * @param text - `.env` 文件内容（容忍 CRLF）。
 * @returns 坐标；缺任一键 → `null`。
 */
export function parseCoords(text: string): Coord | null {
  const get = (key: string): string | null => {
    const match = new RegExp(`^${key}=(.+)$`, 'm').exec(text)
    const value = match?.[1]
    return value === undefined ? null : value.trim()
  }
  const port = get('NEEKO_AGENT_HOOK_PORT')
  const token = get('NEEKO_AGENT_HOOK_TOKEN')
  return port === null || token === null ? null : { port, token }
}

/** `/hook/{source}` 的上报 URL（source 固定 `dsh`）。 */
export function reportUrl(port: string): string {
  return `http://127.0.0.1:${port}/hook/dsh`
}

/** 生产环境的 effects（真 fs + 真 fetch）。 */
export function defaultEffects(): ReporterEffects {
  return {
    readFile: async (path) => readFileSync(path, 'utf8'),
    listDir: async (path) => readdirSync(path),
    fetch: async (url, init) => {
      const response = await fetch(url, init)
      return { status: response.status }
    },
    env: process.env,
  }
}

/**
 * 收集全部坐标。
 *
 * 三条路径（与既有 shim 模板**同契约**，见 `neeko-pi-status.ts` / `neeko-report.mjs`）：
 * - `NEEKO_AGENT_HOOK_ENDPOINT` 指向单文件 → **只读它**（优先级最高）；
 * - `NEEKO_AGENT_HOOK_ENDPOINTS_DIR` 指向目录 → 只扫它（把坐标根整体搬走的调试/夹具环境）；
 * - 否则扫传入的候选目录。
 *
 * 漏掉第二个 env 的后果是单向的：搬过坐标根的机器上其余 7 个源正常、DSH 恒零请求。
 * 该名字与 Rust 侧 `templates/tests.rs` 的锚点同源，不是可选装饰。
 *
 * 任何读取失败都返回空数组（Neeko 未运行 → 静默），不抛。
 *
 * @param dirs - 候选坐标目录（通常只有一个；数组是为将来多根预留，不额外建机制）。
 * @param fx - 投递层依赖。
 * @returns 全部可用坐标。
 */
async function collectCoords(dirs: readonly string[], fx: ReporterEffects): Promise<Coord[]> {
  const override = fx.env.NEEKO_AGENT_HOOK_ENDPOINT
  if (override !== undefined && override !== '') {
    try {
      const coord = parseCoords(await fx.readFile(override))
      return coord === null ? [] : [coord]
    } catch {
      return []
    }
  }
  const overrideDir = fx.env.NEEKO_AGENT_HOOK_ENDPOINTS_DIR
  const roots = overrideDir !== undefined && overrideDir !== '' ? [overrideDir] : dirs
  const found: Coord[] = []
  for (const dir of roots) {
    let names: string[]
    try {
      names = await fx.listDir(dir)
    } catch {
      continue // 目录不存在 = 该实例没在跑
    }
    for (const name of names) {
      if (!name.endsWith('.env')) continue
      try {
        const coord = parseCoords(await fx.readFile(join(dir, name)))
        if (coord !== null) found.push(coord)
      } catch {
        // 单文件读失败：跳过该坐标，其余继续。
      }
    }
  }
  return found
}

/** 一次投递的失败（`status === 0` = 连不上/超时；`>= 400` = 服务端拒绝）。 */
export interface DeliveryFailure {
  readonly port: string
  readonly status: number
}

/**
 * 把一条通知 fan-out 到全部坐标。
 *
 * **契约：永不 reject**。DSH 会 `await` 监听器，任何异常都必须就地吞掉 ——
 * 上报失败的用户可见后果只能是「少一条通知」，不能是「会话卡住」。
 *
 * 但「永不 reject」不等于「永不报告」：返回值把每处失败如实交出去，由调用方
 * 决定是否输出诊断。丢弃状态码会让 401 / 白名单缺行 / 204-丢弃 与成功在代码里
 * 完全同形 —— 正是本任务 Step 0 P6b 踩到的假绿灯形态。
 *
 * @param dirs - 候选坐标目录。
 * @param body - 已渲染好的 `HookEvent` 请求体。
 * @param fx - 投递层依赖。
 * @returns 全部失败（空数组 = 全部成功或没有坐标）。
 */
export async function postToEndpoints(
  dirs: readonly string[],
  body: ReportBody,
  fx: ReporterEffects,
): Promise<readonly DeliveryFailure[]> {
  if (body.agent_session_id === '') return []
  const coords = await collectCoords(dirs, fx)
  if (coords.length === 0) return []
  const payload = JSON.stringify(body)
  const settled = await Promise.allSettled(
    coords.map(async (coord): Promise<DeliveryFailure | null> => {
      try {
        const { status } = await fx.fetch(reportUrl(coord.port), {
          method: 'POST',
          signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
          headers: {
            'content-type': 'application/json',
            'x-neeko-agent-hook-token': coord.token,
          },
          body: payload,
        })
        // 2xx 是既有契约（204）；其余如实上报。
        return status >= 400 ? { port: coord.port, status } : null
      } catch {
        // fail-open：单个坐标（含死坐标）失败不影响其余，也不影响会话。
        return { port: coord.port, status: 0 }
      }
    }),
  )
  return settled.flatMap((r) => (r.status === 'fulfilled' && r.value !== null ? [r.value] : []))
}
