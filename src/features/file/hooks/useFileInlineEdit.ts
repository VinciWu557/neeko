import { useCallback, useState } from 'react';

import { useNotificationStore } from '@/shared/store/notificationStore';

/** 内联新建输入态：目标目录（'' = 根）+ 类型 */
interface CreatingState {
  dirPath: string;
  kind: 'file' | 'dir';
}

/** 内联重命名态：节点路径 + 原类型 + 当前输入值 */
interface RenamingState {
  path: string;
  isDir: boolean;
  name: string;
}

interface UseFileInlineEditParams {
  onCreateFile?: (dirPath: string, name: string) => Promise<void> | void;
  onCreateDirectory?: (dirPath: string, name: string) => Promise<void> | void;
  onRenamePath?: (path: string, newName: string) => Promise<void> | void;
  /** 重命名成功后同步选中节点到新路径（签名与 `handleSelectNode` 一致，便于直接复用） */
  onRenamed: (path: string, isDir: boolean) => void;
  /** 在目录内新建前展开它（展开态 + 内容就绪，输入行才有位置可插） */
  expandDir: (dirPath: string) => Promise<void>;
}

/**
 * 文件树内联编辑（新建 / 重命名）状态机（FilesPanel 内聚子 hook）。
 *
 * 只负责「输入态 → 提交 → 通知」这条链路：名称校验（trim / 空 / 未变）与失败
 * 提示在此收口，CRUD 命令由上层回调注入 —— 编辑态与命令实现彼此独立。
 */
export function useFileInlineEdit({
  onCreateFile,
  onCreateDirectory,
  onRenamePath,
  onRenamed,
  expandDir,
}: UseFileInlineEditParams) {
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [creatingValue, setCreatingValue] = useState('');
  const [renaming, setRenaming] = useState<RenamingState | null>(null);

  const startCreating = useCallback(
    (dirPath: string, kind: 'file' | 'dir') => {
      setCreating({ dirPath, kind });
      setCreatingValue('');
      // 在目录内新建时展开该目录，让内联输入行可见。展开必须与内容就绪同步
      // （store.expandDir 唯一入口）—— 否则目录展开但子项空白，输入行无处插入。
      if (dirPath) void expandDir(dirPath);
    },
    [expandDir],
  );

  const submitCreating = useCallback(async () => {
    if (!creating) return;
    const name = creatingValue.trim();
    if (!name) return;
    const { dirPath, kind } = creating;
    setCreating(null);
    setCreatingValue('');
    try {
      if (kind === 'file') {
        await onCreateFile?.(dirPath, name);
      } else {
        await onCreateDirectory?.(dirPath, name);
      }
    } catch (e) {
      useNotificationStore.getState().addNotification({
        type: 'error',
        title: kind === 'file' ? 'New File' : 'New Folder',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [creating, creatingValue, onCreateFile, onCreateDirectory]);

  const cancelCreating = useCallback(() => {
    setCreating(null);
    setCreatingValue('');
  }, []);

  const startRenaming = useCallback((target: RenamingState) => setRenaming(target), []);

  const handleRenamingChange = useCallback((value: string) => {
    setRenaming((prev) => (prev ? { ...prev, name: value } : prev));
  }, []);

  const submitRenaming = useCallback(async () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    const { path, isDir } = renaming;
    const oldName = path.split('/').pop() ?? path;
    // 名字为空或未变化：直接退出编辑（不触命令、不弹提示）
    if (!name || name === oldName) {
      setRenaming(null);
      return;
    }
    setRenaming(null);
    try {
      await onRenamePath?.(path, name);
      // 重命名成功后选中节点更新为新路径（否则选中停留在已不存在的旧路径）
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      onRenamed(parent ? `${parent}/${name}` : name, isDir);
    } catch (e) {
      useNotificationStore.getState().addNotification({
        type: 'error',
        title: 'Rename',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [renaming, onRenamePath, onRenamed]);

  const cancelRenaming = useCallback(() => {
    setRenaming(null);
  }, []);

  return {
    creating,
    creatingValue,
    setCreatingValue,
    renaming,
    startCreating,
    submitCreating,
    cancelCreating,
    startRenaming,
    handleRenamingChange,
    submitRenaming,
    cancelRenaming,
  };
}
