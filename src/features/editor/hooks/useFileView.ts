import { useState, useRef, useEffect } from 'react';

import { useProjectStore } from '@/shared/store/projectStore';
import { useActiveWorkspaceSession } from '@/shared/store/workspaceStore';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { useFileViewTabOps } from './useFileViewTabOps';

/**
 * useFileView — 文件视图 hook
 *
 * Local / WSL / Remote 统一走 `fileApi`（后端按 `ExecTarget` 路由三端），
 * 不再经 ProjectCommands 文件双通道（R7）。
 */
export function useFileView() {
  const activeProject = useProjectStore((state) => state.activeProject);
  const activeProjectId = useProjectStore((state) => state.activeProjectId);
  const [error, setError] = useState<string | null>(null);

  // Unified current project ID — covers local/WSL/remote via unified store
  const currentProjectId = activeProjectId ?? activeProject?.id ?? null;

  // 当前视图单元的**身份值单点**（workspaceStore 唯一构造器，响应式）：地址、组键、refs 都由它派生。
  const workspace = useActiveWorkspaceSession(currentProjectId);

  // Composite tab key: worktree gets its own independent tab space
  const tabKey = workspace
    ? WorkspaceSession.of(workspace.projectId, workspace.worktreePath ?? null).key
    : null;

  // Refs for callbacks (avoids stale closures)
  const tabKeyRef = useRef(tabKey);
  const workspaceRef = useRef(workspace);

  // Ref 同步集中：所有 refs 在单个 effect 中同步（前端架构约定 3）。
  useEffect(() => {
    tabKeyRef.current = tabKey;
    workspaceRef.current = workspace;
  }, [tabKey, workspace]);

  const {
    openFile,
    closeTab,
    activateTab,
    updateTabContent,
    saveFile,
    saveTabById,
    setTabDirty,
    clearFileView,
  } = useFileViewTabOps({
    tabKeyRef,
    workspaceRef,
    setError,
  });

  return {
    error,
    openFile,
    closeTab,
    activateTab,
    updateTabContent,
    saveFile,
    saveTabById,
    setTabDirty,
    clearFileView,
  };
}
