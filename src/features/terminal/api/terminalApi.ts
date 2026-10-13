import { invoke } from '@tauri-apps/api/core';

import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

/** Mirrors the Rust crate::terminal::types::TerminalSession struct */
export interface TerminalSession {
  id: string;
  pid: number | null;
  status: 'Idle' | 'Running' | 'Failed';
  history: string[];
  agent: {
    id: string;
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
    icon: string | null;
    enabled: boolean;
    skill_path?: string | null;
    prompt_args?: string[] | null;
    post_prompt_args?: string[] | null;
    is_builtin?: boolean;
  } | null;
}

/**
 * Create a terminal session addressed by Workspace.
 *
 * 运行根（cwd）由后端从 `workspace` 派生：缺省 = 工作树根 / 项目根；`workingDir`
 * 为可选的 Workspace 内子目录覆盖（交互终端传 `null`）。
 */
export function createTerminalSession(
  workspace: WorkspaceSession,
  cols: number,
  rows: number,
  shell?: string | null,
  workingDir?: string | null,
  command?: string | null,
): Promise<TerminalSession> {
  return invoke<TerminalSession>('create_terminal_session', {
    workspace,
    cols,
    rows,
    shell,
    workingDir,
    command,
  });
}

export function closeTerminalSession(sessionId: string): Promise<void> {
  return invoke<void>('close_terminal_session', { sessionId });
}

export function resizeTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>('resize_terminal', { sessionId, cols, rows });
}

/**
 * Pulls all buffered terminal output for a session as raw bytes (credit-pull
 * protocol). Backend returns a binary `tauri::ipc::Response` — zero JSON
 * serialization overhead; empty ArrayBuffer means "queue drained".
 */
export function drainTerminal(sessionId: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('terminal_drain', { sessionId });
}

/**
 * Long-poll drain: 无数据时后端挂起至数据到达/超时（而非立即返回空）。
 * 会话已关闭/不存在时后端返回 NotFound（reject）。二进制响应，零 JSON。
 */
export function drainTerminalWait(sessionId: string, timeoutMs: number): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('terminal_drain_wait', { sessionId, timeoutMs });
}
