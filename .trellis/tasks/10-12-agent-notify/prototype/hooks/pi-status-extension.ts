/**
 * 原型模板 —— pi 状态上报 extension（源 B）。
 * 实施落点：由 `agent/hooks/writers/pi.rs` 生成并写入
 * `~/.pi/agent/extensions/neeko-status.ts`（独立文件即插拔，D7；Neeko 已有向 `~/.pi/skills`
 * 部署资产的先例 —— providers.rs，同一「用户级配置客人」模式与清理义务）。
 *
 * ⚠️ pi 无 settings-hook 面（orca 调研结论），扩展 API（事件名 agent_start/agent_end/ask、
 * 注册方式）漂移快：以实施期 pi 官方文档 + 实测为准，writer 文件头登记验证版本。
 *
 * 硬约束与 opencode 模板完全一致（T5）：fail-open、每次上报前重读 endpoint（mtime+ino 缓存）、
 * 800ms 超时、不重试。两份模板的公共上报核心实施期评估是否抽成 writer 共享片段注入
 * （生成物仍保持单文件自包含 —— hook 脚本不能依赖 Neeko 安装目录以外的模块解析）。
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENDPOINT_FILE = join(homedir(), ".neeko", "agent-hooks", "endpoint.env");
const REPORT_TIMEOUT_MS = 800;

let cache: { mtimeMs: number; ino: number; coords: { url: string; token: string } | null } = {
  mtimeMs: 0,
  ino: 0,
  coords: null,
};

function readEndpoint(): { url: string; token: string } | null {
  try {
    const st = statSync(ENDPOINT_FILE);
    if (st.mtimeMs !== cache.mtimeMs || st.ino !== cache.ino) {
      const text = readFileSync(ENDPOINT_FILE, "utf8");
      const get = (key: string): string | undefined =>
        text.match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]?.trim();
      const port = get("NEEKO_AGENT_HOOK_PORT");
      const token = get("NEEKO_AGENT_HOOK_TOKEN");
      const host = get("NEEKO_AGENT_HOOK_HOST") ?? "127.0.0.1"; // WSL 场景由 Neeko 增补
      cache = {
        mtimeMs: st.mtimeMs,
        ino: st.ino,
        coords: port && token ? { url: `http://${host}:${port}/hook/pi`, token } : null,
      };
    }
  } catch {
    cache.coords = null; // Neeko 未运行 → 静默
  }
  return cache.coords;
}

interface ReportPayload {
  agent_session_id: string;
  event: string;
  cwd?: string;
  hints: { neeko_session_id: string | null; project_id: string | null };
  detail?: string | null;
}

async function report(payload: ReportPayload): Promise<void> {
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
      body: JSON.stringify(payload),
    });
  } catch {
    // fail-open：静默
  }
}

const basePayload = (sessionId?: string) => ({
  agent_session_id: sessionId ?? "unknown",
  cwd: process.cwd(),
  hints: {
    neeko_session_id: process.env.NEEKO_SESSION_ID ?? null, // Neeko 自有会话注入 → 精确归属
    project_id: process.env.NEEKO_PROJECT_ID ?? null,
  },
});

// ── pi extension 入口（API 形态以实施期官方文档为准，示意注册三个生命周期事件）────

export default function neekoStatus(pi: any): void {
  // 一轮结束（lifecycle → done）：映射 Completed / turn_completed
  pi.on("agent_end", (e: any) => {
    void report({ ...basePayload(e?.sessionId), event: "agent_end" });
  });

  // ask/权限类工具挂起（→ blocked/waiting）：映射 ActionRequired / approval_requested
  pi.on("ask", (e: any) => {
    void report({
      ...basePayload(e?.sessionId),
      event: "ask",
      detail: typeof e?.message === "string" ? e.message.slice(0, 500) : null,
    });
  });

  // 错误终止：映射 Failed / session_failed
  pi.on("error", (e: any) => {
    void report({
      ...basePayload(e?.sessionId),
      event: "error",
      detail: typeof e?.error?.message === "string" ? e.error.message.slice(0, 500) : null,
    });
  });
}
