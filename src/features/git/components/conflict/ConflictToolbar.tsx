import React from 'react';

import { FileWarning } from '@/shared/components/icons';
import type { ConflictKind } from '@/shared/types';

interface ConflictToolbarProps {
  fileName: string;
  filePath: string;
  kind: ConflictKind;
  regionCount: number;
  truncated: boolean;
  onOpenFile?: () => void;
}

function kindLabel(kind: ConflictKind): string {
  switch (kind) {
    case 'both_modified':
      return 'Both modified';
    case 'both_added':
      return 'Both added';
    case 'modify_delete':
      return 'Modified / deleted';
    case 'rename_rename':
      return 'Rename / rename';
    case 'binary':
      return 'Binary conflict';
  }
}

/**
 * 冲突视图工具栏：文件名 + 冲突类型 + 区域计数 + 「在编辑器打开」逃生门 + 截断提示。
 *
 * 只读版（Layer 1）：**不接决议按钮**（Layer 2 子任务承接）。
 */
const ConflictToolbar: React.FC<ConflictToolbarProps> = ({
  fileName,
  filePath,
  kind,
  regionCount,
  truncated,
  onOpenFile,
}) => (
  <div className="flex shrink-0 flex-col border-b border-border/35">
    <div className="flex items-center gap-2 px-3 py-1.5">
      <FileWarning size={14} className="shrink-0 text-accent-yellow" />
      <span
        className="min-w-0 truncate text-[var(--font-size)] font-semibold text-text-primary"
        title={filePath}
      >
        {fileName}
      </span>
      <span className="shrink-0 rounded bg-accent-yellow/15 px-1.5 py-0.5 text-[calc(var(--font-size)-3px)] font-medium text-accent-yellow">
        {kindLabel(kind)}
      </span>
      {regionCount > 0 ? (
        <span className="shrink-0 text-[calc(var(--font-size)-2px)] text-text-muted">
          {regionCount} {regionCount === 1 ? 'region' : 'regions'}
        </span>
      ) : null}
      {onOpenFile ? (
        <button
          type="button"
          title="Open File"
          className="ml-auto shrink-0 rounded border border-border/50 px-2 py-0.5 text-[calc(var(--font-size)-2px)] text-text-muted hover:bg-bg-hover hover:text-text-primary"
          onClick={onOpenFile}
        >
          Open File
        </button>
      ) : null}
    </div>
    {truncated ? (
      <div
        role="status"
        className="border-t border-border/35 bg-bg-secondary px-3 py-1 text-[calc(var(--font-size)-2px)] text-accent-yellow"
      >
        Conflict content truncated: result exceeds the size limit.
      </div>
    ) : null}
  </div>
);

export default React.memo(ConflictToolbar);
