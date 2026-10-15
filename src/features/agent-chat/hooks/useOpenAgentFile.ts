import { useCallback } from 'react';

import { readFileContent } from '@/features/file/api/fileApi';
import { useEditorStore } from '@/shared/store/editorStore';
import { activeWorkspaceSession } from '@/shared/store/workspaceStore';
import { canonicalFsPath } from '@/shared/utils/fileRef';
import { getFileName, getTabId } from '@/shared/utils/fileTree';
import type { ProjectId } from '@/shared/utils/workspaceRef';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

/**
 * 点击 agent 消息里的 `read_file` 路径 → 在编辑器打开该文件
 * （复用 editorStore + readFileContent，对齐 terminalLinks）。
 *
 * 单独成文件的原因：`AgentChatTabView.tsx` 的单一职责是「渲染 agent chat 页面」，
 * 「把消息里的路径解析成编辑器 tab」是另一类职责；且留在组件里会把文件推过 300 行
 * 红线（护栏 `check_component_size` 是 ratchet：新债不登记，只能抽）。
 *
 * **一次捕获当前视图单元的值**：身份基准、组键、读取地址全部由它派生。基准若用项目根
 * 而读取用 worktree 根，后端 InProject containment 拒绝 —— 相对路径被拼成主仓同名文件
 * 身份，worktree 下静默打不开。
 */
export function useOpenAgentFile(params: {
  projectId: ProjectId;
  projectPath: string;
}): (rawPath: string) => void {
  const { projectId, projectPath } = params;

  return useCallback(
    (rawPath: string) => {
      void (async () => {
        const workspace = activeWorkspaceSession(projectId);
        const filePath = canonicalFsPath(workspace.worktreePath ?? projectPath, rawPath);
        const tabKey = WorkspaceSession.of(projectId, workspace.worktreePath ?? null).key;
        const tabId = getTabId(tabKey, filePath);
        const existing = useEditorStore.getState().tabs[tabKey];
        if (existing?.tabs.some((t) => t.id === tabId)) {
          useEditorStore.getState().activateTab(tabKey, tabId);
          return;
        }
        try {
          const content = await readFileContent(workspace, filePath);
          useEditorStore.getState().addTab({
            id: tabId,
            scope: { kind: 'workspace', session: workspace },
            title: getFileName(filePath),
            data: {
              kind: 'file',
              filePath,
              fileName: getFileName(filePath),
              content,
              isDirty: false,
            },
          });
        } catch {
          // 读取失败时忽略：不阻塞流式渲染，等待下一次事件或手动重试。
        }
      })();
    },
    [projectId, projectPath],
  );
}
