import { useEditorStore } from '@/shared/store/editorStore';
import type { Tab } from '@/shared/types';
import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { resolveTerminalEntry } from './terminalCache';
import { pasteToTerminalSession } from './terminalCommands';

/**
 * terminal 插入路由 —— 唯一前台仲裁点。
 *
 * 与 `terminalCache.resolveTerminalEntry`（低层精确 resolve）分工：
 * 本模块只回答「该往 session 内哪个 tab 插」，低层只回答「该 tab 的 PTY 在哪」。
 * **fallback 语义只在这里实现一次**，避免两处实现漂移。
 *
 * `tabs[session.key]` 是 editor store 的 workspace 空间键（与 `session.key` 同源），
 * 因此跨 session 串写在构造上不可表达。
 */

export interface ForegroundTerminal {
  tab: Tab;
  isFallback: boolean;
}

/**
 * 该 session 内的插入目标：前台 terminal tab；无前台 → 同 session 首个 terminal（按 order）；
 * 无 terminal → null。**禁止跨 session**（tabs 键即 session.key）。
 */
export function foregroundTerminalTab(session: WorkspaceSession): ForegroundTerminal | null {
  const projectTabs = useEditorStore.getState().tabs[session.key];
  if (!projectTabs) return null;

  const terminals = projectTabs.tabs.filter((t) => t.data.kind === 'terminal');
  if (terminals.length === 0) return null;

  const active = terminals.find((t) => t.id === projectTabs.activeTabId);
  if (active) return { tab: active, isFallback: false };

  const first = [...terminals].sort((a, b) => a.order - b.order)[0];
  return first ? { tab: first, isFallback: true } : null;
}

export interface InsertToSessionTerminalResult {
  ok: boolean;
  /** fallback 或精确命中时的实际落点标题（调用方 toast 用）。 */
  landedTabTitle?: string;
  /** true = 无前台 terminal，落到了 session 内首个 terminal。 */
  isFallback?: boolean;
}

/**
 * 唯一编排：route（前台仲裁）→ resolve（精确 PTY）→ paste。
 *
 * 无前台/无终端/PTY 未就绪 → `{ ok: false }`（显式失败，调用方 toast/降级）。
 * fallback 命中时返回落点与 `isFallback`，由调用方决定是否提示。
 */
export function insertToSessionTerminal(
  session: WorkspaceSession,
  text: string,
): InsertToSessionTerminalResult {
  const target = foregroundTerminalTab(session);
  if (!target) return { ok: false };

  const entry = resolveTerminalEntry(session, target.tab.id);
  if (!entry?.sessionId) return { ok: false };

  pasteToTerminalSession(entry.sessionId, text);
  return { ok: true, landedTabTitle: target.tab.title, isFallback: target.isFallback };
}
