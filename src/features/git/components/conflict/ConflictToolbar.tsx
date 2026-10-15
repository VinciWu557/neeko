import React from 'react';

import { FileWarning } from '@/shared/components/icons';
import type { ConflictKind, TakeSide } from '@/shared/types';

interface ConflictToolbarProps {
  fileName: string;
  filePath: string;
  kind: ConflictKind;
  regionCount: number;
  /** 尚未决议的区域数（区域决议是全函数，>0 时 Apply 禁用）。 */
  undecidedCount?: number;
  truncated: boolean;
  onOpenFile?: () => void;
  /** 当前整文件草稿（仅不可区域合并且可决议时展示）。 */
  wholeFileTake?: TakeSide | null;
  /** 整文件二选一（undefined = 不渲染整文件决议按钮，如 rename/rename）。 */
  onTakeWholeFile?: (take: TakeSide) => void;
  /** 是否有待提交草稿（区域或整文件）。 */
  canApply?: boolean;
  pending?: boolean;
  onApply?: () => void;
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
 * 冲突视图工具栏：文件名 + 冲突类型 + 区域计数 + 「在编辑器打开」逃生门 + 截断提示
 * + 决议（整文件二选一 / 区域草稿 Apply）。
 *
 * 决议按钮的可见性由调用方控制（`onTakeWholeFile` 为 undefined 即不渲染）——
 * rename/rename 不渲染决议按钮（T19 非目标）。
 */
const ConflictToolbar: React.FC<ConflictToolbarProps> = ({
  fileName,
  filePath,
  kind,
  regionCount,
  undecidedCount = 0,
  truncated,
  onOpenFile,
  wholeFileTake,
  onTakeWholeFile,
  canApply,
  pending,
  onApply,
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
          {undecidedCount > 0 ? ` · ${undecidedCount} undecided` : ''}
        </span>
      ) : null}
      {onTakeWholeFile ? (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-pressed={wholeFileTake === 'ours'}
            className={`rounded border px-2 py-0.5 text-[calc(var(--font-size)-2px)] ${
              wholeFileTake === 'ours'
                ? 'border-accent-yellow bg-accent-yellow/15 text-accent-yellow'
                : 'border-border/50 text-text-muted hover:bg-bg-hover hover:text-text-primary'
            }`}
            onClick={() => onTakeWholeFile('ours')}
          >
            Take Ours
          </button>
          <button
            type="button"
            aria-pressed={wholeFileTake === 'theirs'}
            className={`rounded border px-2 py-0.5 text-[calc(var(--font-size)-2px)] ${
              wholeFileTake === 'theirs'
                ? 'border-accent-yellow bg-accent-yellow/15 text-accent-yellow'
                : 'border-border/50 text-text-muted hover:bg-bg-hover hover:text-text-primary'
            }`}
            onClick={() => onTakeWholeFile('theirs')}
          >
            Take Theirs
          </button>
        </span>
      ) : null}
      {onApply ? (
        <button
          type="button"
          disabled={!canApply || pending}
          className={`${onTakeWholeFile ? '' : 'ml-auto '}shrink-0 rounded border border-accent-yellow/60 px-2 py-0.5 text-[calc(var(--font-size)-2px)] text-accent-yellow disabled:opacity-40 ${
            canApply && !pending ? 'hover:bg-accent-yellow/15' : ''
          }`}
          onClick={onApply}
        >
          {pending ? 'Applying…' : 'Apply'}
        </button>
      ) : null}
      {onOpenFile ? (
        <button
          type="button"
          title="Open File"
          className={`${onTakeWholeFile || onApply ? '' : 'ml-auto '}shrink-0 rounded border border-border/50 px-2 py-0.5 text-[calc(var(--font-size)-2px)] text-text-muted hover:bg-bg-hover hover:text-text-primary`}
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
