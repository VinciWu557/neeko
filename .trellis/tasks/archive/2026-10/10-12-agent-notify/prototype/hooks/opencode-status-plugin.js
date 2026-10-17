/**
 * 原型模板 —— opencode 状态上报 plugin（源 B）。
 * 实施落点：由 `agent/hooks/writers/opencode.rs` 生成并写入
 * `<opencode configDir>/plugins/neeko-status.js`（独立文件即插拔，不改用户既有配置，D7）。
 * 文件头注释携带 Neeko 版本号，启动时内容 hash 不一致 → writer 重写。
 *
 * ⚠️ opencode plugin API 形态漂移快：`export const X = async (ctx) => ({ event })` 的
 * 事件总线形状与事件名（session.idle / permission.updated / session.error）以实施期
 * 官方文档 + 实测为准（design.md §2.5 映射表、§7 风险「hook 面漂移」）。
 *
 * 硬约束（T5，全部 fail-open）：
 * - 任何异常（endpoint 文件缺失/不可解析、网络失败、超时）一律吞掉 —— 绝不 throw 进
 *   opencode 运行时，绝不阻塞用户会话；
 * - 每次上报前重读 endpoint 文件（mtime+ino 缓存），Neeko 重启换端口后自动跟上；
 * - 短超时（800ms），不做重试/spool（MVP；落盘补发登记 E6）。
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── endpoint 坐标发现（跨 Neeko 重启存活，design.md §2.5）─────────────────────

const ENDPOINT_FILE = join(homedir(), ".neeko", "agent-hooks", "endpoint.env");
const REPORT_TIMEOUT_MS = 800;

let cache = { mtimeMs: 0, ino: 0, coords: null };

function readEndpoint() {
  try {
    const st = statSync(ENDPOINT_FILE);
    if (st.mtimeMs !== cache.mtimeMs || st.ino !== cache.ino) {
      const text = readFileSync(ENDPOINT_FILE, "utf8");
      const get = (key) => {
        const m = text.match(new RegExp(`^${key}=(.+)$`, "m"));
        return m ? m[1].trim() : undefined;
      };
      const port = get("NEEKO_AGENT_HOOK_PORT");
      const token = get("NEEKO_AGENT_HOOK_TOKEN");
      // WSL 内运行时 HOST 行由 Neeko 增补（design.md §7）；缺省 loopback
      const host = get("NEEKO_AGENT_HOOK_HOST") ?? "127.0.0.1";
      cache = { mtimeMs: st.mtimeMs, ino: st.ino, coords: port && token ? { url: `http://${host}:${port}/hook/opencode`, token } : null };
    }
  } catch {
    cache.coords = null; // Neeko 未运行/文件缺失 → 静默
  }
  return cache.coords;
}

// ── 上报（字段白名单，与 hook_ingest.rs 的 HookEnvelope 一一对应）──────────────

async function report(event, session, detail) {
  const coords = readEndpoint();
  if (!coords) return;
  try {
    await fetch(coords.url, {
      method: "POST",
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-neeko-agent-hook-token": coords.token,
      },
      body: JSON.stringify({
        agent_session_id: session?.id ?? "unknown",
        event,
        cwd: session?.directory ?? process.cwd(),
        // Neeko 自有 PTY/会话注入的 env 被原样回传 → 后端精确归属（D8 第 1 级）
        hints: {
          neeko_session_id: process.env.NEEKO_SESSION_ID ?? null,
          project_id: process.env.NEEKO_PROJECT_ID ?? null,
        },
        detail: typeof detail === "string" ? detail.slice(0, 500) : null, // 后端还会截到 200
      }),
    });
  } catch {
    // fail-open：Neeko 未运行/超时/拒绝 —— 与用户会话无关，静默
  }
}

// ── opencode plugin 入口（API 形态以实施期官方文档为准）────────────────────────

export const NeekoStatusPlugin = async () => ({
  event: async ({ event }) => {
    switch (event?.type) {
      case "session.idle": // 一轮完成（含等待用户下一句），映射 Completed
        void report("session.idle", event.properties);
        break;
      case "permission.updated": // 权限请求挂起，映射 ActionRequired
        if (event.properties?.status === "pending") {
          void report("permission.updated", event.properties, event.properties?.title);
        }
        break;
      case "session.error":
        void report("session.error", event.properties, event.properties?.error?.message);
        break;
      default:
      // 其余事件不上报（后端对未知事件也 fail-open 204，双保险）
    }
  },
});
