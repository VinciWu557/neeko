import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { readDirTree } from '@/features/file/api/fileApi';
import { fileTreeOwner, useFileStore } from '@/features/file/store';
import { FILE_TREE_CHANGED_EVENT } from '@/shared/events';
import { activeWorkspaceSession, activeWorkspaceKeyOf } from '@/shared/store/workspaceStore';
import type { ProjectView, FileTreeChangedEvent } from '@/shared/types';
import { DEFAULT_TREE_DEPTH } from '@/shared/types/file';
import { safeUnlisten } from '@/shared/utils/safeUnlisten';
import type { ProjectId } from '@/shared/utils/workspaceRef';

export interface UseFileTreeSyncOptions {
  project: ProjectView | null;
  activeProjectId: ProjectId | null;
  /** 文件树根路径（worktree 或项目根） */
  fileRootPath: string | null;
  /** 面板在 dock 中是否激活（激活时才发起首次加载） */
  isActive: boolean;
}

/**
 * 文件树同步编排（Local / WSL / Remote 完全同一条路径）。
 *
 * 内聚目录加载 / file-tree-changed 事件刷新 / 手动刷新，使 FilesPanelWrapper
 * 保持薄适配、可独立测试。
 *
 * **加载与刷新的唯一写入面是 `useFileStore`** —— 不再按项目类型分流：
 * 历史上 Local 经 `onLoadFileTree`（context → `useFileView.loadFileTree`）而
 * WSL/Remote 直接 `store.loadDir/refreshTree`，两条路各自维护“何时加载 / 是否强制”，
 * 任何一边改语义（如 force 的含义）就会只有一类项目生效。地址（owner）与读取
 * 命令（`readDirTree` 按 `ExecTarget` 路由）本来就三端同源，分流没有存在理由。
 *
 * - 加载器：统一走 `readDirTree`，注入 store（store 不感知命令差异）；
 * - 首次加载 effect：面板激活 / 切项目 / 切 worktree 时触发，prev refs 防冗余；
 * - 刷新：统一走 `store.refreshTree`（重载根 + 已展开目录）；
 * - 事件监听：仅本地项目响应 file-tree-changed（WSL/Remote 不经过本地 watcher），
 *   静默定向重载命中桶。
 */
export function useFileTreeSync({
  project,
  activeProjectId,
  fileRootPath,
  isActive,
}: UseFileTreeSyncOptions) {
  const makeLoader = useCallback(
    (pid: ProjectId, dirPath: string) => () =>
      readDirTree(
        activeWorkspaceSession(pid),
        dirPath || null,
        // S2-0：非根目录单层读取 —— 刷新成本 O(变更)，与 dirCache 一级条目语义一致；
        // 根目录按 DEFAULT_TREE_DEPTH 预扫（初始结构成型），S5 起 ignored 由后端标注。
        // Local / WSL / Remote 同一条后端命令，深度语义只需一份。
        dirPath ? 1 : DEFAULT_TREE_DEPTH,
      ),
    [],
  );

  /**
   * 树所属的**项目身份单点**：Local 取 `activeProjectId`（本地项目可能尚未进入
   * 统一项目表），WSL/Remote 取 `project.id`。此前这一判断在 5 处各自书写，
   * 任何一处改规则就会出现「树按 A 项目寻址、事件按 B 项目过滤」的错配。
   */
  const treeProjectId = project ? (project.type === 'Local' ? activeProjectId : project.id) : null;

  const prevProjectIdRef = useRef<string | null>(null);
  const prevIsActiveRef = useRef(false);
  const prevFileRootPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isActive || !project || !fileRootPath) {
      prevIsActiveRef.current = isActive;
      return;
    }

    const projectId = treeProjectId;
    const justBecameActive = !prevIsActiveRef.current && isActive;
    const sameProject = prevProjectIdRef.current === projectId;
    const fileRootPathChanged = fileRootPath !== prevFileRootPathRef.current;

    // 首次加载 / 切项目 / 切 worktree：三端同一条 `store.loadDir`。
    // 幂等由 store 保证（同一 owner 已 loaded 即跳过；owner 跳变则缓存与
    // 展开态一起作废后重载）。仅当 projectId 与 fileRootPath 都未变（如 git 刷新
    // 引起的对象新引用）时才跳过，避开冗余读取。
    if (treeProjectId) {
      if (justBecameActive || !sameProject || fileRootPathChanged) {
        const owner = fileTreeOwner(treeProjectId, fileRootPath);
        void useFileStore.getState().loadDir(owner, '', makeLoader(treeProjectId, ''));
      }
    }

    prevProjectIdRef.current = projectId ?? null;
    prevIsActiveRef.current = isActive;
    prevFileRootPathRef.current = fileRootPath;
  }, [isActive, project, treeProjectId, fileRootPath, makeLoader]);

  // 监听后端 file-tree-changed 事件（文件新增/删除/重命名），静默刷新目录树
  // 静默刷新：不切换 loading 态，旧树保持展示直到新数据到达，避免闪烁
  // 仅本地项目响应此事件（WSL/Remote 不经过本地 notify watcher）
  useEffect(() => {
    const unlistenPromise = listen<FileTreeChangedEvent>(FILE_TREE_CHANGED_EVENT, (event) => {
      const { project_id, workspace_key, dirs } = event.payload;
      // 只响应当前活动项目的事件 + 仅本地项目（WSL/Remote 不经过本地 notify watcher）
      if (!activeProjectId || project_id !== activeProjectId) return;
      // 按**Workspace**定址：树的作用域含工作树根路径，收别的单元的事件会用它
      // 不相关的目录集合重载当前树（相对路径在两个工作树里同形不同义）。
      if (workspace_key !== activeWorkspaceKeyOf(activeProjectId)) return;
      if (!project || project.type !== 'Local') return;
      // 移除 isActive 限制：即使文件面板未激活，文件变更仍应触发刷新，
      // 确保用户切换到文件面板时看到的是最新状态。
      if (!fileRootPath) return;
      // 静默刷新：后端携带受影响目录集合时定向重载命中桶（S2-2，成本 O(变更)）；
      // dirs 为空 = 变更范围未知（watcher overflow），退回全量兜底。
      const owner = fileTreeOwner(activeProjectId, fileRootPath);
      void useFileStore
        .getState()
        .refreshTree(owner, (dirPath) => makeLoader(activeProjectId, dirPath), {
          silent: true,
          dirs,
        });
    });
    return () => {
      unlistenPromise.then((unlisten) => safeUnlisten(unlisten)());
    };
  }, [activeProjectId, project, fileRootPath, makeLoader]);

  // 手动刷新：三端一致走 store.refreshTree（重载根 + 已展开目录，失败保留旧内容
  // + error 态，不置空）。不再按项目类型分流到 context。
  const handleRefresh = useCallback(() => {
    if (!treeProjectId || !fileRootPath) return;
    const owner = fileTreeOwner(treeProjectId, fileRootPath);
    void useFileStore
      .getState()
      .refreshTree(owner, (dirPath) => makeLoader(treeProjectId, dirPath));
  }, [treeProjectId, fileRootPath, makeLoader]);

  // 本面板视图的**单一寻址面**：项目身份（`treeProjectId`）、owner 与目录 loader
  // 同源（同一 project/root 解析），供上层（useDirExpansion / FilesPanel / Wrapper）
  // 直接使用 —— 调用方不再各自拼 owner、不再各自写「Local 取 activeProjectId」
  // 的项目身份判断，也不分 Local / WSL / Remote 各拿一个 loader。
  const treeOwner = useMemo(
    () => (treeProjectId && fileRootPath ? fileTreeOwner(treeProjectId, fileRootPath) : null),
    [treeProjectId, fileRootPath],
  );

  const makeDirLoader = useCallback(
    (dirPath: string) =>
      treeProjectId
        ? makeLoader(treeProjectId, dirPath)
        : () =>
            Promise.reject(
              new Error(
                `cannot load directory "${dirPath}": no active project ` +
                  `(project=${project?.id ?? 'null'}, root=${fileRootPath ?? 'null'})`,
              ),
            ),
    [treeProjectId, makeLoader, project, fileRootPath],
  );

  return { handleRefresh, treeOwner, treeProjectId, makeDirLoader };
}
