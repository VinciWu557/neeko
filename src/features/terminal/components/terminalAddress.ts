import { WorkspaceSession, workspaceKeyLabel } from '@/shared/utils/workspaceRef';

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
