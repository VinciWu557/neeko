import type { FileTab } from '@/shared/types';
import { isPdfFile } from '@/shared/utils/fileTree';
import { workspaceRootOf } from '@/shared/utils/workspaceRef';

import EditorHeader from './EditorHeader';
import ImageFileView from './ImageFileView';
import PdfFileView from './PdfFileView';
import UneditableFileView from './UneditableFileView';

/** 只读兜底视图类型；`null` = 正常可编辑。 */
export type FileEditorFallbackKind = 'image' | 'binary' | 'oversized' | 'pdf';

/**
 * 判定落到哪个兜底视图（顺序固定且次序本身是契约）：
 * pdf → 二进制图片 → 其他二进制 → 超大文本。
 *
 * PDF 必须排在 `is_binary` **之前**：部分合法 PDF 的前 8KB 内没有 NUL 字节，
 * `is_binary` 会是 false，按二进制分支判会把它送进文本编辑器。
 */
export function fileEditorFallbackKind(
  tab: FileTab,
  isBinaryImage: boolean,
): FileEditorFallbackKind | null {
  if (isPdfFile(tab.filePath)) return 'pdf';
  if (tab.content.is_binary) return isBinaryImage ? 'image' : 'binary';
  if (tab.content.size > 512 * 1024) return 'oversized';
  return null;
}

interface Props {
  kind: FileEditorFallbackKind;
  tab: FileTab;
  /** 项目登记路径（主 checkout 根）。worktree 单元必须再经 `workspaceRootOf` 投影。 */
  projectPath: string | null;
}

/**
 * 二进制（本地图片 / PDF 走预览）/ 超大文件的只读兜底视图。
 *
 * 路径基准是**该 tab 工作树的根**，不是 `projectPath`：linked worktree 里同一相对路径
 * 指向工作树里的文件，拼主仓根会解析到另一个文件（或不存在的路径）。
 * 派生点唯一 —— `workspaceRootOf(tab.workspace.key, projectPath)`。
 */
export default function FileEditorFallback({ kind, tab, projectPath }: Props) {
  const workspaceRoot = projectPath ? workspaceRootOf(tab.workspace.key, projectPath) : undefined;

  if (kind === 'pdf') {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <EditorHeader
          filePath={tab.filePath}
          projectPath={projectPath}
          isDirty={false}
          isMd={false}
          isHtml={false}
          isSvg={false}
          isJson={false}
          previewMode="preview"
          onTogglePreview={() => {}}
        />
        <PdfFileView
          filePath={tab.filePath}
          fileName={tab.fileName}
          projectId={tab.workspace.projectId}
        />
      </div>
    );
  }

  if (kind === 'image') {
    return (
      <div className="flex-1 flex flex-col">
        <EditorHeader
          filePath={tab.filePath}
          projectPath={projectPath}
          isDirty={false}
          isMd={false}
          isHtml={false}
          isSvg={false}
          isJson={false}
          previewMode="preview"
          onTogglePreview={() => {}}
        />
        <ImageFileView
          filePath={tab.filePath}
          basePath={workspaceRoot}
          fileName={tab.fileName}
          projectId={tab.workspace.projectId}
        />
      </div>
    );
  }
  return (
    <UneditableFileView
      filePath={tab.filePath}
      projectPath={projectPath}
      size={tab.content.size}
      message={
        kind === 'binary'
          ? 'Binary file — cannot be displayed'
          : 'File too large to edit (> 500 KB)'
      }
    />
  );
}
