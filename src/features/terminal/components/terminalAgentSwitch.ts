import { useEditorStore } from '@/shared/store/editorStore';
import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

import {
  decodeTerminalKey,
  firstTerminalKeyOfSession,
  switchAgentInSessionTerminal,
  terminalAddress,
} from './terminalCache';

/**
 * 唯一 agent 切换**能力**（env-blind）。
 *
 * 调用方只给 `(session, tabId, agentId)`，**不感知 local / WSL / Remote** ——
 * 环境由 session 归属的物理 backend 在底层承接（`terminalCache.backendForKey`）。
 *
 * 机制只有一套（与 WSL/Remote 一致）：
 * 1. 把目标 agent 落到 tab 身份（`editorStore.updateTab(..., { agentId })`）；
 * 2. 交给底层物理切换：清掉该键的 PTY 并触发 pane 重建；pane 重建后按 tab.agentId 自动拉起
 *    agent（未挂载 DOM、无 wrapper 时退化为直接向该键下发 agent 命令）。
 *
 * 不再有「local 走 imperative 重建、远端走 rebuild」两套语义。
 */
export async function switchAgentInTerminal(
  session: WorkspaceSession,
  tabId: string | null,
  agentId: string,
  agentCommandOverrides?: Record<string, string>,
): Promise<void> {
  const key = tabId ? terminalAddress(session, tabId) : firstTerminalKeyOfSession(session);
  if (!key) return;

  const targetTabId = decodeTerminalKey(key)?.tabId ?? null;
  if (targetTabId) {
    // 目标 agent 先落到 tab 身份：重建后 pane 依 tab.agentId 自动启动该 agent。
    useEditorStore.getState().updateTab(session.key, targetTabId, { agentId });
  }

  await switchAgentInSessionTerminal(session, targetTabId, agentId, agentCommandOverrides);
}
