import { homeDir } from '@tauri-apps/api/path';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useCopyToClipboard } from '@/shared/hooks/useCopyToClipboard';
import { useNotificationStore } from '@/shared/store/notificationStore';
import type { FileNode, DirTreeResult } from '@/shared/types';

import { displayHomePath, getParentPath } from '../utils/fileTreeUtils';

import { useDirExpansion } from './useDirExpansion';
import { useFileContextMenu } from './useFileContextMenu';
import { useFileInlineEdit } from './useFileInlineEdit';

export interface UseFilePanelStateParams {
  projectPath?: string | null;
  /** 数据归属 `${projectId}:${rootPath}`（展开态与目录缓存的共同坐标系） */
  owner: string | null;
  activeFilePath: string | null;
  onSelectFile: (filePath: string) => void;
  onRefresh: () => void;
  /** 目录加载器（store.loadDir 的 loader 入参）：读取深度等语义由上层决定 */
  makeDirLoader: (dirPath: string) => () => Promise<DirTreeResult>;
  /** 目录缓存读取探针（FilesPanel 注入 useFileStore.dirs）：包链自动展开/收起用它
   *  判断「单子目录链」；缺省返回空（测试/无目录上下文时包链 walk 为 no-op）。 */
  readDir?: (dirPath: string) => FileNode[];
  projectType?: 'Local' | 'Wsl' | 'Remote' | null;
  onOpenInBrowser?: (filePath: string) => void;
  onOpenInSystemBrowser?: (filePath: string) => void;
  onRevealInExplorer?: (filePath: string) => void;
  onCreateFile?: (dirPath: string, name: string) => Promise<void> | void;
  onCreateDirectory?: (dirPath: string, name: string) => Promise<void> | void;
  onDeletePath?: (path: string, isDir: boolean) => Promise<void> | void;
  onRenamePath?: (path: string, newName: string) => Promise<void> | void;
}

/**
 * FilesPanel 的全部状态与事件处理逻辑。
 * 将 UI 渲染层与 Tauri 数据交互彻底解耦（维度 10）。
 */
export function useFilePanelState(params: UseFilePanelStateParams) {
  const {
    projectPath,
    owner,
    activeFilePath,
    onSelectFile,
    onRefresh,
    makeDirLoader,
    readDir = () => [],
    projectType,
    onOpenInBrowser,
    onOpenInSystemBrowser,
    onRevealInExplorer,
    onCreateFile,
    onCreateDirectory,
    onDeletePath,
    onRenamePath,
  } = params;

  // 目录展开态（存于 store，按 owner 分槽）+ 展开命令编排（含包视图链 / 联动）
  const { expandedDirs, expandDir, expandPathParents, handleToggleDir, collapseAll, canCollapse } =
    useDirExpansion({ owner, makeLoader: makeDirLoader, readDir });

  // 用户 home 目录（用于路径展示时替换为 ~）
  const [homeDirPath, setHomeDirPath] = useState('');
  const copyToClipboard = useCopyToClipboard();

  useEffect(() => {
    let cancelled = false;
    homeDir()
      .then((h) => {
        if (!cancelled) setHomeDirPath(h);
      })
      .catch(() => {
        /* 获取失败时保持完整路径展示 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 展示用路径：非 Windows 平台下将 home 前缀替换为 ~（tooltip 仍显示完整路径）
  const displayPath = useMemo(() => {
    if (!projectPath) return null;
    const isWindows = /win/i.test(navigator.userAgent);
    return displayHomePath(projectPath, homeDirPath, isWindows);
  }, [projectPath, homeDirPath]);

  // 右键上下文菜单状态
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    node: FileNode;
  } | null>(null);
  // 当前选中节点（用于 Delete 按钮）
  const [selectedNode, setSelectedNode] = useState<{ path: string; isDir: boolean } | null>(null);
  // 显式定位信号：locateFile 每次调用递增（定位按钮与自动定位共用入口）。
  // FileTreeList 以「信号未消费」识别显式定位请求 —— 目标文件已是选中项时选中
  // 不再变化，仅靠选中变化驱动的滚动会早退（按钮定位不滚的根因）。
  const [locateSignal, setLocateSignal] = useState(0);
  // 待确认删除的节点（弹出确认对话框）
  const [confirmDelete, setConfirmDelete] = useState<{ path: string; isDir: boolean } | null>(null);

  // 刷新：展开状态保留（内容刷新由 store.loadDir 幂等处理）
  const handleRefresh = useCallback(() => {
    onRefresh();
  }, [onRefresh]);

  // 右键菜单处理
  const handleContextMenu = useCallback((position: { x: number; y: number }, node: FileNode) => {
    setSelectedNode({ path: node.path, isDir: node.is_dir });
    setContextMenu({ position, node });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleSelectNode = useCallback((path: string, isDir: boolean) => {
    setSelectedNode({ path, isDir });
  }, []);

  // 取消选中（点击文件面板外任意处）：新建目标回到根（getCreationDir 对 null 返回 ''）。
  const clearSelection = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // 定位：复用「点击选中」逻辑（selectedNode → selectedPath → isSelected 高亮），
  // 额外展开父目录。与手动点击文件的选中路径完全一致，不另起一套高亮。
  // 文件树为「初始有限深度（DEFAULT_TREE_DEPTH）+ 按目录懒加载」，深于初始
  // 深度的目标文件其祖先目录可能从未 loadDir —— 展开与加载必须同步（expandPathParents
  // 逐级 expandDir）；加载完成后 rows 变化触发 FileTreeList 滚动 effect（idx<0 时
  // 不消费 seq、不记 prev）自动重跑滚到目标行。
  const locateFile = useCallback(
    async (path: string) => {
      // 显式定位请求：递增信号（无论目标是否已选中，未消费信号即驱动滚动）
      setLocateSignal((s) => s + 1);
      handleSelectNode(path, false);
      await expandPathParents(path);
    },
    [handleSelectNode, expandPathParents],
  );

  // 关闭删除确认对话框（不执行删除）
  const closeDeleteConfirm = useCallback(() => {
    setConfirmDelete(null);
  }, []);

  // 新建目标的默认目录：选中目录 → 该目录内；选中文件 → 其所在目录；未选中 → 根目录
  const getCreationDir = useCallback(() => {
    if (!selectedNode) return '';
    return selectedNode.isDir ? selectedNode.path : getParentPath(selectedNode.path);
  }, [selectedNode]);

  // 内联编辑（新建 / 重命名）状态机：输入态、校验、失败提示都在子 hook 内
  const inlineEdit = useFileInlineEdit({
    onCreateFile,
    onCreateDirectory,
    onRenamePath,
    // 重命名成功后同步选中节点到新路径（若停留旧路径，Delete/新建目标会指向已不存在的节点）。
    // 直接复用 handleSelectNode（签名一致）——不包内联箭头，保持回调身份稳定。
    onRenamed: handleSelectNode,
    expandDir,
  });

  // 删除（确认对话框已由调用方收口）：失败弹通知，成功后清选中
  const handleDelete = useCallback(
    async (path: string, isDir: boolean) => {
      try {
        await onDeletePath?.(path, isDir);
        setSelectedNode(null);
      } catch (e) {
        useNotificationStore.getState().addNotification({
          type: 'error',
          title: 'Delete',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [onDeletePath],
  );

  // 右键菜单项构造（按节点种类 + 项目能力 + 可用回调决定），独立子 hook
  const startDeleteConfirm = useCallback(
    (target: { path: string; isDir: boolean }) => setConfirmDelete(target),
    [],
  );
  const buildContextMenuItems = useFileContextMenu({
    projectPath,
    projectType,
    onSelectFile,
    onOpenInBrowser,
    onOpenInSystemBrowser,
    onRevealInExplorer,
    onCreateFile,
    onCreateDirectory,
    onDeletePath,
    onRenamePath,
    startCreating: inlineEdit.startCreating,
    startRenaming: inlineEdit.startRenaming,
    startDeleteConfirm,
    copyToClipboard,
  });

  // 当前打开的文件名（用于头部展示）
  const activeFileName = activeFilePath
    ? activeFilePath.split(/[\\/]/).pop() || activeFilePath
    : null;

  return {
    expandedDirs,
    displayPath,
    contextMenu,
    selectedNode,
    confirmDelete,
    activeFileName,
    handleRefresh,
    handleToggleDir,
    expandDir,
    handleContextMenu,
    collapseAll,
    closeContextMenu,
    handleSelectNode,
    clearSelection,
    locateFile,
    locateSignal,
    getCreationDir,
    handleDelete,
    closeDeleteConfirm,
    buildContextMenuItems,
    canCollapse,
    // 内联编辑整组透传（输入态 + 提交/取消动作）
    ...inlineEdit,
  };
}
