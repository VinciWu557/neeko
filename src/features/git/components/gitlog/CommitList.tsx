import { memo, useCallback, useMemo, useState } from 'react';

import type { CommitDetail, CommitEntry, CommitFileChange } from '@/features/git/types';
import { useScrollMemory } from '@/shared/hooks/useScrollMemory';
import { buildScrollKey } from '@/shared/utils/scrollMemory';
import type { WorkspaceKey } from '@/shared/utils/workspaceRef';

import CommitGraph, { BRANCH_SPACING, NODE_RADIUS, computeRowMaxX } from './CommitGraph';
import { CommitListItem } from './CommitListItem';
import { CommitListEmpty, CommitListLoading } from './CommitListStates';
import { TEXT_AFTER_DOT_GAP, graphWidthForCols } from './commitListUtils';
import { useCommitLayout } from './useCommitLayout';
import { useCommitMenu } from './useCommitMenu';
import { useExpandPanel } from './useExpandPanel';
import { useVirtualScroll } from './useVirtualScroll';

interface CommitListProps {
  commits: CommitEntry[];
  selectedHash: string | null;
  selectedExpanded: boolean;
  detail: CommitDetail | null;
  files: CommitFileChange[];
  detailLoading: boolean;
  detailError: string | null;
  onSelectCommit: (hash: string) => void;
  onOpenDiff: (filePath: string) => void;
  onPinFile: (filePath: string) => void;
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
  searchQuery: string;
  focusedFileIndex?: number;
  onClearSearch?: () => void;
  /** 本列表渲染的 Workspace key（滚动记忆按工作区隔离）。 */
  workspaceKey: WorkspaceKey;
}

/**
 * 组合层：hooks 编排 + 虚拟窗口渲染。
 * hoveredHash 必须留在本层——CommitGraph overlay 消费它做 dot 高亮。
 */
const CommitList: React.FC<CommitListProps> = ({
  commits,
  selectedHash,
  selectedExpanded,
  detail,
  files,
  detailLoading,
  detailError,
  onSelectCommit,
  onOpenDiff,
  onPinFile,
  loading,
  hasMore,
  onLoadMore,
  loadingMore,
  searchQuery,
  focusedFileIndex = -1,
  onClearSearch,
  workspaceKey,
}) => {
  const [hoveredHash, setHoveredHash] = useState<string | null>(null);

  const filteredCommits = useMemo(() => {
    if (!searchQuery.trim()) return commits;
    const q = searchQuery.toLowerCase();
    return commits.filter(
      (c) =>
        c.message.toLowerCase().includes(q) ||
        c.author.toLowerCase().includes(q) ||
        c.short_hash.toLowerCase().includes(q),
    );
  }, [commits, searchQuery]);

  const selectedRowIndex = useMemo(() => {
    if (!selectedHash || !selectedExpanded) return -1;
    return filteredCommits.findIndex((c) => c.hash === selectedHash);
  }, [filteredCommits, selectedHash, selectedExpanded]);

  const { expandRef, expandHeight } = useExpandPanel({
    selectedHash,
    selectedExpanded,
    detail,
    files,
    detailLoading,
    detailError,
  });

  const { containerRef, sentinelRef, handleScroll, startIndex, endIndex, offsetY, totalHeight } =
    useVirtualScroll({
      rowCount: filteredCommits.length,
      selectedRowIndex,
      expandHeight,
      hasMore,
      loadingMore,
      onLoadMore,
    });

  const { menuRef, isMenuOpen, openMenu, closeMenu } = useCommitMenu();

  // 滚动记忆：Dock 面板互切（保活期引擎丢位置）与卸载重建都恢复；按 Workspace 隔离。
  // 与虚拟化的测量 ref 合并为单一回调 ref（两个 consumer：视口测量 + 记忆机制）。
  const scrollRef = useScrollMemory<HTMLDivElement>(
    buildScrollKey('dock.git.history', workspaceKey),
  );
  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef(node);
      scrollRef(node);
    },
    [containerRef, scrollRef],
  );

  // 每行最大 graph X（竖线 + 交叉曲线实际路径），文字恒在其右侧
  const rowMaxX = useMemo(() => computeRowMaxX(filteredCommits), [filteredCommits]);

  const { maxColUsed } = useCommitLayout(filteredCommits);
  const { fullWidth: rowGraphFullWidth, visibleWidth: rowGraphWidth } = useMemo(
    () => graphWidthForCols(maxColUsed, BRANCH_SPACING, NODE_RADIUS),
    [maxColUsed],
  );

  if (loading && commits.length === 0) {
    return <CommitListLoading />;
  }

  if (filteredCommits.length === 0) {
    return <CommitListEmpty searching={Boolean(searchQuery)} onClearSearch={onClearSearch} />;
  }

  return (
    <div className="h-full overflow-auto" ref={setContainerRef} onScroll={handleScroll}>
      {/* w-full + min-w-0 保证长路径截断而非撑宽面板 */}
      <div className="relative w-full min-w-0" style={{ height: totalHeight }}>
        {/* Graph 在行背景之上，hover/选中永不遮 dot */}
        <div
          className="absolute left-0 top-0 shrink-0 z-30 overflow-x-auto overflow-y-hidden pointer-events-none"
          style={{ width: rowGraphWidth }}
        >
          <div style={{ width: rowGraphFullWidth }}>
            <CommitGraph
              commits={filteredCommits}
              selectedHash={selectedHash}
              onSelectCommit={onSelectCommit}
              hoveredHash={hoveredHash}
              expandAfterRow={selectedRowIndex}
              expandOffsetY={expandHeight}
            />
          </div>
        </div>

        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {filteredCommits.slice(startIndex, endIndex + 1).map((commit, sliceIdx) => {
            const rowIdx = startIndex + sliceIdx;
            const textLeft = (rowMaxX[rowIdx] ?? 0) + TEXT_AFTER_DOT_GAP;
            return (
              <CommitListItem
                key={commit.hash}
                commit={commit}
                textLeft={textLeft}
                isSelected={commit.hash === selectedHash}
                isExpanded={commit.hash === selectedHash && selectedExpanded}
                isHovered={hoveredHash === commit.hash}
                onHoveredChange={setHoveredHash}
                onSelectCommit={onSelectCommit}
                detail={detail}
                files={files}
                detailLoading={detailLoading}
                detailError={detailError}
                focusedFileIndex={focusedFileIndex}
                expandRef={expandRef}
                onOpenDiff={onOpenDiff}
                onPinFile={onPinFile}
                menuOpen={isMenuOpen(commit.hash)}
                menuRef={menuRef}
                onToggleMenu={() => (isMenuOpen(commit.hash) ? closeMenu() : openMenu(commit.hash))}
              />
            );
          })}

          {hasMore ? (
            <div
              ref={sentinelRef}
              className="py-2 text-center text-[var(--font-size)] text-text-muted"
              style={{ position: 'absolute', top: totalHeight - 32, width: '100%' }}
            >
              {loadingMore ? 'Loading more…' : ''}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export default memo(CommitList);
