import { invoke } from '@tauri-apps/api/core';

import type { SessionStore } from '@/shared/types';
import { runConfigWrite } from '@/shared/utils/configWriteGate';
import type { ProjectId } from '@/shared/utils/workspaceRef';

export function saveConfig(config: Record<string, unknown>): Promise<void> {
  return invoke<void>('save_config', { config });
}

/**
 * 对 `config.json` 做一次**排队的**读-改-写。
 *
 * `config.json` 是**一份**多域共享文件且按整份覆盖写入，故「读-改-写」必须整体
 * 进入全局串行门（`runConfigWrite`），否则与其它写入者交叠时会互删对方的键。
 * 放在 API 层而不是组件里：这是 `config.json` 的**写入契约**，不是某个组件的 UI 逻辑，
 * 任何调用方都不该重新实现它（也就不会忘）。
 */
export async function patchConfig(
  patch:
    | Partial<Record<string, unknown>>
    | ((current: Record<string, unknown>) => Partial<Record<string, unknown>>),
): Promise<void> {
  await runConfigWrite(async () => {
    const current = await loadConfig();
    const delta = typeof patch === 'function' ? patch(current) : patch;
    await saveConfig({ ...current, ...delta });
  });
}

export function loadConfig(): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>('load_config');
}

export function saveSession(
  sidebarWidth?: number | null,
  worktreeState?: Record<string, string> | null,
): Promise<void> {
  return invoke<void>('save_session', { sidebarWidth, worktreeState });
}

export function loadSession(): Promise<SessionStore> {
  return invoke<SessionStore>('load_session');
}

export function getConfigDir(): Promise<string> {
  return invoke<string>('get_config_dir');
}

export function greet(name: string): Promise<string> {
  return invoke<string>('greet', { name });
}

export function saveVcsSettings(
  projectId: ProjectId,
  settings: Record<string, unknown>,
): Promise<void> {
  return invoke<void>('save_vcs_settings_command', { projectId, settings });
}

export function loadVcsSettings(projectId: ProjectId): Promise<Record<string, unknown>> {
  return invoke<Record<string, unknown>>('load_vcs_settings_command', { projectId });
}
