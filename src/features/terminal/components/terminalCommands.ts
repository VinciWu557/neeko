import { emit } from '@tauri-apps/api/event';

import { terminalInputEvent } from '@/shared/utils/terminalEvents';
import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

import {
  firstTerminalEntryOfSession,
  log,
  resolveTerminalEntry,
  terminalKeyLabel,
} from './terminalCache';

/**
 * 写侧执行路径统一入口。地址一律由 `session` 派生（`terminalAddress`），
 * 不再有裸 `projectId` 前缀扫描 —— 跨 session 串写在前缀上不可表达。
 */
export function sendToTerminal(
  session: WorkspaceSession,
  text: string,
  tabId?: string | null,
): void {
  const entry = tabId ? resolveTerminalEntry(session, tabId) : firstTerminalEntryOfSession(session);
  const sessionId = entry?.sessionId ?? null;

  if (!sessionId) {
    log(
      `sendToTerminal: no session for ${terminalKeyLabel(session.key)}${tabId ? `:${tabId}` : ''}`,
    );
    return;
  }

  const bytes = Array.from(new TextEncoder().encode(text));
  emit(terminalInputEvent(sessionId), bytes).catch((err) => {
    log(`sendToTerminal error: ${err}`);
  });
}

/** Bracketed-paste start marker: wrapped input lands in the buffer, never executes. */
export const BRACKETED_PASTE_START = '\x1b[200~';
/** Bracketed-paste end marker. */
export const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * Wrap text in bracketed-paste markers so the shell pastes it as one
 * buffer edit (multi-line stays multi-line, nothing auto-executes).
 */
export function wrapBracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

/**
 * Emit bracketed-paste bytes to an already-resolved terminal session.
 * Shares sendToTerminal's transport, never appends `\r`.
 */
export function pasteToTerminalSession(sessionId: string, text: string): void {
  const bytes = Array.from(new TextEncoder().encode(wrapBracketedPaste(text)));
  emit(terminalInputEvent(sessionId), bytes).catch((err) => {
    log(`pasteToTerminalSession error: ${err}`);
  });
}

/**
 * Paste text into the active terminal's PTY without executing it
 * (bracketed-paste wrapped). Same session lookup as sendToTerminal;
 * sendToTerminal itself is untouched (its trailing-`\r` paths stay intact).
 *
 * @returns true when a session matched and bytes were emitted, false otherwise.
 */
export function pasteToTerminal(
  session: WorkspaceSession,
  text: string,
  tabId?: string | null,
): boolean {
  const entry = tabId ? resolveTerminalEntry(session, tabId) : firstTerminalEntryOfSession(session);
  const sessionId = entry?.sessionId ?? null;

  if (!sessionId) {
    log(
      `pasteToTerminal: no session for ${terminalKeyLabel(session.key)}${tabId ? `:${tabId}` : ''}`,
    );
    return false;
  }

  pasteToTerminalSession(sessionId, text);
  return true;
}
