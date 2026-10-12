import { emit } from '@tauri-apps/api/event';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';

import { reportFrontendError } from '@/shared/utils/errorReporting';
import { safeDisposeTerminal } from '@/shared/utils/terminal';
import { terminalInputEvent } from '@/shared/utils/terminalEvents';
import type { TerminalInputController } from '@/shared/utils/terminalInput';
import { WorkspaceSession, workspaceKeyLabel } from '@/shared/utils/workspaceRef';
import type { ProjectId } from '@/shared/utils/workspaceRef';

import { getAgent } from '../../agent/api/agentApi';
import { closeTerminalSession } from '../api/terminalApi';

import type { TerminalCache } from './terminalTypes';

// =============================================================================
// Factory — shared by local / WSL / remote cache modules
// =============================================================================
/** Minimal common shape that all three cache types satisfy. */
interface CacheEntry {
  term: Terminal;
  sessionId: string | null;
  inputController: TerminalInputController | null;
  unlisten?: (() => void) | null;
  unlistenOutput?: (() => void) | null;
  unlistenClosed?: (() => void) | null;
}
export interface CacheBackendOptions {
  /** Close a terminal session */
  closeSession: (sessionId: string) => Promise<void>;
  /** Log prefix, e.g. "[WSL]", "[SSH]", "[Terminal]" */
  logPrefix: string;
}
export function createTerminalCacheBackend<TCache extends CacheEntry>(
  options: CacheBackendOptions,
) {
  const { closeSession, logPrefix } = options;

  // ---- internal maps ----
  const cache = new Map<string, TCache>();
  const rebuildCallbacks = new Map<string, () => void>();
  const wrapperRefs = new Map<string, HTMLDivElement>();

  // ---- utilities ----

  function log(msg: string) {
    const ts = new Date().toLocaleTimeString();
    console.debug(`['${ts}'] ${logPrefix} ${msg}`);
  }

  function destroyCache(key: string): void {
    const entry = cache.get(key);
    if (!entry) return;

    if (entry.unlisten) entry.unlisten();
    if (entry.unlistenOutput) entry.unlistenOutput();
    if (entry.unlistenClosed) entry.unlistenClosed();

    entry.inputController?.dispose();
    safeDisposeTerminal(entry.term);

    if (entry.sessionId) {
      closeSession(entry.sessionId).catch((err) =>
        reportFrontendError('terminal.closeSession', err),
      );
    }

    cache.delete(key);
    rebuildCallbacks.delete(key);
    wrapperRefs.delete(key);

    log(`Cache destroyed for ${key}`);
  }

  /** 精确键刷新（键由 terminal 寻址层 mint，本层不再做前缀消解）。 */
  function refreshTerminal(key: string): void {
    const entry = cache.get(key);
    if (!entry) return;

    const rebuildCb = rebuildCallbacks.get(key);

    if (entry.unlisten) entry.unlisten();
    if (entry.unlistenOutput) entry.unlistenOutput();
    if (entry.unlistenClosed) entry.unlistenClosed();
    entry.inputController?.dispose();

    if (entry.sessionId) {
      closeSession(entry.sessionId).catch((err) =>
        reportFrontendError('terminal.closeSession', err),
      );
    }

    safeDisposeTerminal(entry.term);

    cache.delete(key);
    rebuildCallbacks.delete(key);
    wrapperRefs.delete(key);

    log(`Cache destroyed for ${key}`);

    rebuildCb?.();
  }

  function launchAgentInTerminal(key: string, command: string, args: string[]): void {
    const entry = cache.get(key);
    if (!entry?.sessionId) return;

    const sessionId = entry.sessionId;
    const ctrlC = Array.from(new TextEncoder().encode('\x03'));
    // 静默豁免：终端高频输入，尽力而为，失败无需上报
    emit(terminalInputEvent(sessionId), ctrlC).catch(() => {});

    setTimeout(() => {
      const cmdStr = [command, ...args].join(' ') + '\r';
      const bytes = Array.from(new TextEncoder().encode(cmdStr));
      // 静默豁免：终端高频输入，尽力而为，失败无需上报
      emit(terminalInputEvent(sessionId), bytes).catch(() => {});
    }, 50);
  }

  return {
    cache,
    rebuildCallbacks,
    wrapperRefs,
    destroyCache,
    refreshTerminal,
    launchAgentInTerminal,
    log,
  };
}

// =============================================================================
// Local terminal cache — instance and exports
// =============================================================================

const backend = createTerminalCacheBackend<TerminalCache>({
  closeSession: closeTerminalSession,
  logPrefix: '[Terminal]',
});

export const terminalCache = backend.cache;
export const terminalRebuildCallbacks = backend.rebuildCallbacks;
export const terminalWrapperRefs = backend.wrapperRefs;

export const log = backend.log;

// =============================================================================
// WSL terminal cache — instance and exports
// =============================================================================

export interface WslTerminalCache {
  term: Terminal;
  fitAddon: FitAddon;
  element: HTMLElement;
  sessionId: string | null;
  unlisten: (() => void) | null;
  unlistenOutput: (() => void) | null;
  unlistenClosed: (() => void) | null;
  inputController: TerminalInputController | null;
}

const wslBackend = createTerminalCacheBackend<WslTerminalCache>({
  closeSession: closeTerminalSession,
  logPrefix: '[WSL]',
});

export const wslTerminalCache = wslBackend.cache;
export const wslRebuildCallbacks = wslBackend.rebuildCallbacks;
export const wslWrapperRefs = wslBackend.wrapperRefs;

// =============================================================================
// Remote terminal cache — instance and exports
// =============================================================================

export interface RemoteTerminalCache {
  term: Terminal;
  fitAddon: FitAddon;
  element: HTMLElement;
  sessionId: string | null;
  unlisten: (() => void) | null;
  unlistenOutput: (() => void) | null;
  unlistenClosed: (() => void) | null;
  inputController: TerminalInputController | null;
}

const remoteBackend = createTerminalCacheBackend<RemoteTerminalCache>({
  closeSession: closeTerminalSession,
  logPrefix: '[SSH]',
});

export const remoteTerminalCache = remoteBackend.cache;
export const remoteRebuildCallbacks = remoteBackend.rebuildCallbacks;
export const remoteWrapperRefs = remoteBackend.wrapperRefs;

// =============================================================================
// Terminal addressing — env-blind address → physical cache key (single mint)
// =============================================================================

/**
 * 段分隔符（唯一）：`session.key` + SEP + `tabId` + SEP + `paneId`。
 *
 * **不用 `:` 作段界**：editor tabId 本身含 `:`（如 `proj:src/a.ts`）——
 * `…SEP A :p1`（tab=A, pane=p1）与 `…SEP A:p1 :p2`（tab=`A:p1`）前缀同形，
 * 按 tab 清理会过度命中。统一 SEP 后 tab 前缀是 `…SEP A SEP`，两者不可混淆。
 * `session.key` 的内部分隔符是 NUL（`WORKSPACE_KEY_SEP`），与 SEP 不同，反解无歧义。
 */
export const TERMINAL_KEY_SEP = '\u0001';

/** 唯一 mint：terminal 地址（env-blind，身份唯一输入是 `session`）。 */
export function terminalAddress(session: WorkspaceSession, tabId: string, paneId = 'p1'): string {
  return `${session.key}${TERMINAL_KEY_SEP}${tabId}${TERMINAL_KEY_SEP}${paneId}`;
}

/** session 级扫描前缀（③ 面：生命周期销毁 / 刷新）。 */
export function terminalAddressPrefix(session: WorkspaceSession): string {
  return `${session.key}${TERMINAL_KEY_SEP}`;
}

/** tab 级扫描前缀（③ 面：按 tab 清理）。 */
export function terminalAddressPrefixOfTab(session: WorkspaceSession, tabId: string): string {
  return `${terminalAddressPrefix(session)}${tabId}${TERMINAL_KEY_SEP}`;
}

export interface DecodedTerminalKey {
  session: WorkspaceSession;
  tabId: string;
  paneId: string;
}

/**
 * 唯一 codec（terminal key → 分量）。
 *
 * **不得复用 `WorkspaceSession.fromKey`**：它会把 `\u0001tabId\u0001p1` 当成
 * `worktreePath`（非 null）⇒ 伪 worktree session。本函数只从第一个 SEP 切分。
 */
export function decodeTerminalKey(key: string): DecodedTerminalKey | null {
  const first = key.indexOf(TERMINAL_KEY_SEP);
  if (first < 0) return null;
  const session = WorkspaceSession.fromKey(key.slice(0, first));
  if (!session) return null;
  const rest = key.slice(first + 1);
  const second = rest.indexOf(TERMINAL_KEY_SEP);
  if (second <= 0) return null;
  const paneId = rest.slice(second + 1);
  if (paneId === '') return null;
  return { session, tabId: rest.slice(0, second), paneId };
}

/**
 * 日志 / 提示用可读标签（对照 `workspaceKeyLabel`）。
 * NUL 与 SEP 直接进日志会让日志文件被 `file(1)` 判成 data（同 workspaceKeyLabel 的既有理由）。
 */
export function terminalKeyLabel(key: string): string {
  const decoded = decodeTerminalKey(key);
  if (decoded) {
    return `${workspaceKeyLabel(decoded.session.key)} :: ${decoded.tabId} :: ${decoded.paneId}`;
  }
  return '<invalid terminal key>';
}

interface TerminalBackendHandle {
  cache: Map<string, CacheEntry>;
  wrapperRefs: Map<string, HTMLDivElement>;
  rebuildCallbacks: Map<string, () => void>;
  destroyCache: (key: string) => void;
  refreshTerminal: (key: string) => void;
  launchAgentInTerminal: (key: string, cmd: string, args: string[]) => void;
}

/**
 * 三个物理 Map（传输归属，非寻址维度）。键在它们之间**唯一**（一个 terminal 只属一个 env），
 * 所以整个地址层可以只靠键/前缀在 Map 中查找，**不需要读 projectStore 反推 env**
 * （移除隐藏 store 依赖与「env 未知就静默 no-op」的泄漏面）。
 */
function allBackends(): TerminalBackendHandle[] {
  return [backend, wslBackend, remoteBackend] as unknown as TerminalBackendHandle[];
}

/** 精确键唯一命中其物理 Map；未命中 → null。 */
function backendForKey(key: string): TerminalBackendHandle | null {
  for (const bk of allBackends()) {
    if (bk.cache.has(key)) return bk;
  }
  return null;
}

/**
 * 唯一 resolve：精确键在三个物理 Map 中唯一命中。
 *
 * **tabId 必填、无隐式 fallback** —— session 内 fallback 只由 `terminalRouting` 的前台仲裁
 * 承担（避免同一语义两处实现而漂移）。跨 session 串写在前缀上不可表达（前缀 = 整串
 * `session.key` + SEP，嵌套 worktree `/wt/a` 不匹配 `/wt/a-b`）。
 */
export function resolveTerminalEntry(
  session: WorkspaceSession,
  tabId: string,
  paneId = 'p1',
): CacheEntry | null {
  const key = terminalAddress(session, tabId, paneId);
  return backendForKey(key)?.cache.get(key) ?? null;
}

/** 该 session 内首个终端键（按 Map 插入顺序）；无 → null。跨 session 不可表达。 */
export function firstTerminalKeyOfSession(session: WorkspaceSession): string | null {
  const prefix = terminalAddressPrefix(session);
  for (const bk of allBackends()) {
    for (const key of bk.cache.keys()) {
      if (key.startsWith(prefix)) return key;
    }
  }
  return null;
}

/** 该 session 内首个终端条目；无 → null。 */
export function firstTerminalEntryOfSession(session: WorkspaceSession): CacheEntry | null {
  const key = firstTerminalKeyOfSession(session);
  return key ? (backendForKey(key)?.cache.get(key) ?? null) : null;
}

/**
 * ③ 面：切换该 session 内某 tab 的 agent（WSL/Remote 共用——键唯一命中其物理 Map）。
 *
 * WSL/Remote 的 agent 切换不重建 PTY，只清缓存并触发 pane 重建回调；
 * 无 wrapper 时降级为「向该键下发 agent 命令」。
 */
export async function switchAgentInSessionTerminal(
  session: WorkspaceSession,
  tabId: string | null,
  agentId: string,
  agentCommandOverrides?: Record<string, string>,
): Promise<void> {
  const resolvedKey = tabId ? terminalAddress(session, tabId) : firstTerminalKeyOfSession(session);
  if (!resolvedKey) return;
  const bk = backendForKey(resolvedKey);
  if (!bk) return;

  const wrapper = bk.wrapperRefs.get(resolvedKey);
  if (!wrapper) {
    const agent = await getAgent(agentId).catch(() => null);
    if (agent) {
      const cmd = agentCommandOverrides?.[agent.id] ?? agent.command;
      bk.launchAgentInTerminal(resolvedKey, cmd, agent.args);
    }
    return;
  }

  const oldCache = bk.cache.get(resolvedKey);
  if (oldCache) {
    oldCache.unlisten?.();
    oldCache.unlistenOutput?.();
    oldCache.unlistenClosed?.();
    oldCache.inputController?.dispose();
  }

  bk.cache.delete(resolvedKey);

  while (wrapper.firstChild) {
    wrapper.removeChild(wrapper.firstChild);
  }

  bk.rebuildCallbacks.get(resolvedKey)?.();

  if (oldCache?.sessionId) {
    closeTerminalSession(oldCache.sessionId).catch((err) =>
      reportFrontendError('terminal.closeSession', err),
    );
  }
  if (oldCache?.term) safeDisposeTerminal(oldCache.term);
}

function destroyTerminalsByPrefix(prefix: string): void {
  for (const bk of allBackends()) {
    for (const key of Array.from(bk.cache.keys())) {
      if (key.startsWith(prefix)) bk.destroyCache(key);
    }
  }
}

/** ③ 面：销毁该 session 下全部终端（删 worktree / 清 tab 空间）。 */
export function destroyTerminalsForSession(session: WorkspaceSession): void {
  destroyTerminalsByPrefix(terminalAddressPrefix(session));
}

/**
 * ③ 面：销毁某项目**所有 workspace**（主仓 + 全部 worktree、全 env）的终端。
 * 用于「关项目 / 删 entry」——项目级关闭语义就是所有单元。
 * 前缀 = `projectId` + NUL（session.key 的第一段），UUID 后接 NUL 使跨项目无歧义。
 */
export function destroyTerminalsForProject(projectId: ProjectId): void {
  // 主 checkout 的 session.key 就是 `<projectId>\0`（第一段 + NUL）——
  // 由唯一 mint 投影得到，不在本模块重拼 NUL。
  destroyTerminalsByPrefix(WorkspaceSession.of(projectId, null).key);
}

/** ③ 面：销毁该 session 下某个 tab 的终端（关闭单个 tab）。 */
export function destroyTerminalsForTab(session: WorkspaceSession, tabId: string): void {
  destroyTerminalsByPrefix(terminalAddressPrefixOfTab(session, tabId));
}

/** ③ 面：刷新该 session 的终端；给定 tabId 精确，否则首个（agent 切换 / 重建自愈）。 */
export function refreshTerminalForSession(session: WorkspaceSession, tabId?: string | null): void {
  const key = tabId ? terminalAddress(session, tabId) : firstTerminalKeyOfSession(session);
  if (key) backendForKey(key)?.refreshTerminal(key);
}

/**
 * 精确键刷新任意 env 的终端（键在三个物理 Map 中唯一命中其一）。
 * 供自愈路径使用 —— 调用方持有 strategy 的完整键，无需知道 env。
 */
export function refreshTerminalEntry(key: string): void {
  backendForKey(key)?.refreshTerminal(key);
}
