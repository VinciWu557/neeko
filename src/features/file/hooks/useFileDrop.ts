/**
 * File/Directory drag-to-input: stores the dragged path in a module-level
 * variable during dragStart, then pastes it into the agent composer (优先)
 * 或当前 session 的前台终端 when the drag ends.
 *
 * - Uses "dragend" (guaranteed to fire, no preventDefault needed).
 * - Does NOT auto-submit (no \r) — path is pasted, user can edit.
 *
 * **不再有「焦点在文本元素」这条启发式**（原 `isTextInputElement`）：xterm 的输入载体
 * 本身就是 `<textarea class="xterm-helper-textarea">`，终端聚焦时该判据恒为 true，
 * 于是文本被投给一个零监听者的 DOM 事件后丢弃 —— 拖文件到终端与拖到 agent 输入
 * **两端都是静默 no-op**。见 design §1.1（连带 defect）。仲裁一律走身份（红线 12）。
 */

import { useEffect } from 'react';

import { insertToSessionAgent } from '@/features/agent-chat/api/insertToSessionAgent';
import { insertToSessionTerminal } from '@/features/terminal';
import { activeWorkspaceSession } from '@/shared/store/workspaceStore';
import type { ProjectId } from '@/shared/utils/workspaceRef';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

interface DragPayload {
  path: string;
  projectId: ProjectId;
}

let pendingDrag: DragPayload | null = null;

export function setDragFile(path: string, projectId: ProjectId): void {
  pendingDrag = { path, projectId };
}

// ---------------------------------------------------------------------------
// Hook — mount once at the top of the component tree (ProjectView)
// ---------------------------------------------------------------------------

export function useFileDrop(): void {
  useEffect(() => {
    const handleDragEnd = () => {
      if (!pendingDrag) return;
      const { path, projectId } = pendingDrag;
      pendingDrag = null;

      const session = activeWorkspaceSession(projectId);
      const text = path + ' ';

      // Priority 1: agent 目标（composer 优先，内部降级 Agent CLI 终端）。
      // Priority 2: 本 session 的前台终端。两者都走唯一仲裁（决议 R1/Q2），
      // 不再有任何「猜焦点在哪个元素」的代理判据。
      if (insertToSessionAgent(session, text).ok) return;
      insertToSessionTerminal(session, text);
    };

    document.addEventListener('dragend', handleDragEnd);
    return () => document.removeEventListener('dragend', handleDragEnd);
  }, []);
}
