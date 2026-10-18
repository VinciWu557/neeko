import { useCallback } from 'react';

import type { ContextMenuItem } from '@/shared/components/ContextMenu';
import {
  Globe,
  FolderOpen,
  FileText,
  FilePlus,
  FolderPlus,
  Trash2,
  Pencil,
  Copy,
  ClipboardCopy,
  ExternalLink,
} from '@/shared/components/icons';
import type { FileNode } from '@/shared/types';
import { canonicalFsPath } from '@/shared/utils/fileRef';

import { getParentPath } from '../utils/fileTreeUtils';

interface UseFileContextMenuParams {
  projectPath?: string | null;
  projectType?: 'Local' | 'Wsl' | 'Remote' | null;
  onSelectFile: (filePath: string) => void;
  onOpenInBrowser?: (filePath: string) => void;
  onOpenInSystemBrowser?: (filePath: string) => void;
  onRevealInExplorer?: (filePath: string) => void;
  onCreateFile?: (dirPath: string, name: string) => Promise<void> | void;
  onCreateDirectory?: (dirPath: string, name: string) => Promise<void> | void;
  onDeletePath?: (path: string, isDir: boolean) => Promise<void> | void;
  onRenamePath?: (path: string, newName: string) => Promise<void> | void;
  /** 进入「新建」内联输入（目标目录 + 类型） */
  startCreating: (dirPath: string, kind: 'file' | 'dir') => void;
  /** 进入「重命名」内联输入 */
  startRenaming: (target: { path: string; isDir: boolean; name: string }) => void;
  /** 进入「删除」确认 */
  startDeleteConfirm: (target: { path: string; isDir: boolean }) => void;
  copyToClipboard: (text: string, label: string) => Promise<boolean>;
}

/**
 * 文件树右键菜单构造（FilesPanel 内聚子 hook）。
 *
 * 菜单项集合只由「节点种类（文件/目录/HTML）+ 项目能力（Local/Remote）+ 回调是否提供」
 * 决定，与面板其余状态无关 —— 独立成 hook 使 `useFilePanelState` 只做状态编排。
 * 顺序与分组（separator 位置）是 UX 契约：打开/浏览器 → 复制 → 定位 → 增删改。
 */
export function useFileContextMenu({
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
  startCreating,
  startRenaming,
  startDeleteConfirm,
  copyToClipboard,
}: UseFileContextMenuParams) {
  return useCallback(
    (node: FileNode): ContextMenuItem[] => {
      const items: ContextMenuItem[] = [];
      const isHtmlFile = !node.is_dir && /\.(html|htm)$/i.test(node.name);

      if (!node.is_dir) {
        items.push({
          label: 'Open in Editor',
          icon: FileText,
          action: () => onSelectFile(node.path),
        });
      }

      // HTML 预览仅本地项目：WSL/Remote 的文件不在本端可服务路径上
      if (isHtmlFile && projectType === 'Local') {
        if (onOpenInBrowser) {
          items.push({
            label: 'Open in App Browser',
            icon: Globe,
            action: () => onOpenInBrowser(node.path),
          });
        }
        if (onOpenInSystemBrowser) {
          items.push({
            label: 'Open in System Browser',
            icon: ExternalLink,
            action: () => onOpenInSystemBrowser(node.path),
          });
        }
      }

      items.push({ separator: true });

      items.push({
        label: 'Copy Path',
        icon: Copy,
        action: () => {
          const absPath = projectPath ? canonicalFsPath(projectPath, node.path) : node.path;
          void copyToClipboard(absPath, 'path');
        },
      });

      if (projectPath) {
        items.push({
          label: 'Copy Relative Path',
          icon: ClipboardCopy,
          // node.path 已经是相对于项目根的相对路径，直接复制
          action: () => {
            void copyToClipboard(node.path, 'path');
          },
        });
      }

      if (projectType === 'Local' && onRevealInExplorer) {
        items.push({ separator: true });
        items.push({
          label: 'Reveal in File Manager',
          icon: FolderOpen,
          action: () => onRevealInExplorer(node.path),
        });
      }

      // 文件/目录创建（右键方式）：目标目录 = 目录节点自身 / 文件节点所在目录
      if (onCreateFile || onCreateDirectory) {
        items.push({ separator: true });
        const targetDir = node.is_dir ? node.path : getParentPath(node.path);
        if (onCreateFile) {
          items.push({
            label: 'New File',
            icon: FilePlus,
            action: () => startCreating(targetDir, 'file'),
          });
        }
        if (onCreateDirectory) {
          items.push({
            label: 'New Folder',
            icon: FolderPlus,
            action: () => startCreating(targetDir, 'dir'),
          });
        }
      }

      if (onRenamePath) {
        items.push({ separator: true });
        items.push({
          label: 'Rename',
          icon: Pencil,
          action: () => startRenaming({ path: node.path, isDir: node.is_dir, name: node.name }),
        });
      }

      if (onDeletePath) {
        items.push({ separator: true });
        items.push({
          label: 'Delete',
          icon: Trash2,
          action: () => startDeleteConfirm({ path: node.path, isDir: node.is_dir }),
        });
      }

      return items;
    },
    [
      projectType,
      projectPath,
      onSelectFile,
      onOpenInBrowser,
      onOpenInSystemBrowser,
      onRevealInExplorer,
      onCreateFile,
      onCreateDirectory,
      onDeletePath,
      onRenamePath,
      startCreating,
      startRenaming,
      startDeleteConfirm,
      copyToClipboard,
    ],
  );
}
