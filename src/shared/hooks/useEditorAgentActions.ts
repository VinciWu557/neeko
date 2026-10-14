import { useCallback, useState } from 'react';

import { activeWorkspaceSession } from '@/shared/store/workspaceStore';
import type { ProjectId } from '@/shared/utils/workspaceRef';

// eslint-disable-next-line import/no-restricted-paths -- shared hook sends terminal commands via terminal feature
import { sendToTerminal } from '../../features/terminal/components/terminalCommands';
// eslint-disable-next-line import/no-restricted-paths -- shared hook needs the single foreground arbitration
import { foregroundAgentCliTab } from '../../features/terminal/components/terminalRouting';

interface PendingAction {
  message: string;
  projectId: ProjectId;
}

export function useEditorAgentActions() {
  const [pending, setPending] = useState<PendingAction | null>(null);

  /**
   * 本 session 内的 Agent CLI tab —— **委托唯一前台仲裁**（决议 Q2）。
   *
   * 此前它自带一套「数组顺序首个（不排序）」的口径，与 `foregroundTerminalTab` 的
   * order 升序不一致 —— 同一时刻「插入落哪」与「agent 消息落哪」可以不是一个 tab。
   * 命令式路径读 store 快照（见 hook-guidelines「Store 快照模式」），不在渲染路径订阅
   * `tabs` 整张表。
   */
  const findAgentTab = useCallback((projectId: ProjectId) => {
    return foregroundAgentCliTab(activeWorkspaceSession(projectId));
  }, []);

  const sendToAgent = useCallback(
    (projectId: ProjectId, message: string) => {
      const target = findAgentTab(projectId);
      if (target) {
        sendToTerminal(activeWorkspaceSession(projectId), `${message}\r`, target.tab.id);
        return true;
      }
      setPending({ message, projectId });
      return false;
    },
    [findAgentTab],
  );

  const clearPending = useCallback(() => {
    setPending(null);
  }, []);

  return { sendToAgent, pending, clearPending };
}
