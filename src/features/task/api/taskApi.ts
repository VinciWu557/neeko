import { invoke } from '@tauri-apps/api/core';

import type { TaskConfig } from '@/shared/types';
import type { ProjectId, WorkspaceSession } from '@/shared/utils/workspaceRef';

import type { DiscoveredTask } from '../types';

export function getTaskConfigs(projectPath?: string | null): Promise<TaskConfig[]> {
  return invoke<TaskConfig[]>('get_task_configs', { projectPath });
}

export function discoverTaskConfigs(projectPath: string): Promise<DiscoveredTask[]> {
  return invoke<DiscoveredTask[]>('discover_task_configs', { projectPath });
}

export function importDiscoveredTask(
  task: DiscoveredTask,
  projectPath: string,
  projectId?: ProjectId | null,
): Promise<TaskConfig> {
  return invoke<TaskConfig>('import_discovered_task', {
    task,
    projectPath,
    projectId: projectId ?? null,
  });
}

export function saveTaskConfig(config: TaskConfig, projectPath?: string | null): Promise<void> {
  return invoke<void>('save_task_config', { config, projectPath });
}

export function deleteTaskConfig(
  id: string,
  scope: string,
  projectPath?: string | null,
): Promise<void> {
  return invoke<void>('delete_task_config', { id, scope, projectPath });
}

/** Stop a process session started for a task (shared terminal manager close). */
export function stopTask(sessionId: string): Promise<void> {
  return invoke<void>('stop_task', { sessionId });
}

/** Mirrors terminal session DTO — kept local so task does not import terminal feature. */
export interface TaskProcessSession {
  id: string;
  pid: number | null;
  status: string;
}

/**
 * Start a dedicated process for a task command at the Workspace run root
 * (`sh -c` / `cmd /c` via terminal manager).
 *
 * 运行根由后端从 `workspace` 派生：`workingDir` 为可选的 Workspace 内子目录覆盖
 * （语言 runner 模块根），缺省传 `null` ⇒ 用工作树根 / 项目根。
 * Output is streamed on `terminal-output-{id}`; exit on `terminal-closed-{id}`.
 */
export function startTaskProcessSession(
  workspace: WorkspaceSession,
  cols: number,
  rows: number,
  workingDir: string | null,
  command: string,
): Promise<TaskProcessSession> {
  return invoke<TaskProcessSession>('create_terminal_session', {
    workspace,
    cols,
    rows,
    shell: null,
    workingDir,
    command,
  });
}

export function stopTaskProcessSession(sessionId: string): Promise<void> {
  // Same manager as interactive terminals; stop_task closes the session.
  return invoke<void>('stop_task', { sessionId });
}

/**
 * Pulls buffered process output as raw bytes (credit-pull protocol).
 * Mirrors the terminal feature's `terminal_drain` command — kept local so
 * task does not import the terminal feature (same rationale as
 * {@link TaskProcessSession}).
 */
export function drainTaskProcessOutput(sessionId: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('terminal_drain', { sessionId });
}

/**
 * Long-poll drain: 无数据时后端挂起至数据到达/超时。镜像终端侧
 * `terminal_drain_wait` 命令——保持本地镜像约定，不导入 terminal feature。
 */
export function drainTaskProcessOutputWait(
  sessionId: string,
  timeoutMs: number,
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('terminal_drain_wait', { sessionId, timeoutMs });
}
