import React, { type ReactNode } from 'react';

import DiffTable from './DiffTable';
import DiffTruncatedNotice from './DiffTruncatedNotice';
import type { SelectionMode } from './diffViewUtils';
import SplitDiffTable from './SplitDiffTable';
import type { DiffHunk, DiffResult, ViewMode } from './types';

interface DiffContentProps {
  diffResult: DiffResult;
  viewMode: ViewMode;
  language: string;
  languageReady: boolean;
  selectedLines: Set<string>;
  onToggleLine: (blockIdx: number, lineIdx: number) => void;
  onDragCommit: (keys: Set<string>, mode: SelectionMode) => void;
  fullHunks?: DiffHunk[];
  expandedSections: Set<string>;
  onToggleSection: (hunkIdx: number, lineIdx: number) => void;
  selectionActionBar?: () => ReactNode;
  /** 行 key 前缀（多文件视图区分块；单文件视图省略 → 用 DiffTable 默认）。 */
  blockIdPrefix?: string;
}

/**
 * diff 内容区 = 截断提示 + unified / split 表格。单文件（`SingleDiffBody`）与多文件
 * （`FileDiffSection`）**共用同一实现**，避免「提示 / 表格」两份渲染漂移（曾导致截断到 0 hunk 时静默）。
 *
 * 截断提示与 hunk 数**正交**：只要 `truncated` 就置顶渲染，0 hunk（单行即超预算）时只显示提示。
 */
const DiffContent: React.FC<DiffContentProps> = ({
  diffResult,
  viewMode,
  language,
  languageReady,
  selectedLines,
  onToggleLine,
  onDragCommit,
  fullHunks,
  expandedSections,
  onToggleSection,
  selectionActionBar,
  blockIdPrefix,
}) => (
  <>
    <DiffTruncatedNotice truncated={diffResult.truncated} />
    {diffResult.hunks.length > 0 ? (
      viewMode === 'unified' ? (
        <DiffTable
          diffResult={diffResult}
          language={language}
          languageReady={languageReady}
          selectedLines={selectedLines}
          onToggleLine={onToggleLine}
          onDragCommit={onDragCommit}
          blockIdPrefix={blockIdPrefix}
          fullHunks={fullHunks}
          expandedSections={expandedSections}
          onToggleSection={onToggleSection}
          selectionActionBar={selectionActionBar}
        />
      ) : (
        <SplitDiffTable
          diffResult={diffResult}
          language={language}
          languageReady={languageReady}
          selectedLines={selectedLines}
          onToggleLine={onToggleLine}
          onDragCommit={onDragCommit}
          blockIdPrefix={blockIdPrefix}
          fullHunks={fullHunks}
          expandedSections={expandedSections}
          onToggleSection={onToggleSection}
          selectionActionBar={selectionActionBar}
        />
      )
    ) : null}
  </>
);

export default React.memo(DiffContent);
