import React from 'react';

import { MCP_PAGE_SIZE_OPTIONS } from '@/features/library/hooks/useMcpMarketplace';
import { cn } from '@/lib/utils';

interface McpMarketplacePaginationProps {
  currentPage: number;
  /** 当前页条目数 —— 游标分页无总数，标签只报本页数量。 */
  pageCount: number;
  hasPrev: boolean;
  hasNext: boolean;
  loading: boolean;
  perPage: number;
  onPerPageChange: (perPage: number) => void;
  onGoToPage: (page: number) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
}

/**
 * 市场分页条（范围 + 页码按钮 + prev/next + 每页条数）。
 * 从 McpMarketplaceContent 抽出（组件体积 ratchet），行为零漂移。
 *
 * 游标栈语义：页码只渲染「已访问过的页」，无总数概念 —— 与 Skills 市场的
 * 总数分页（features/skill 的 Pagination）模型不同源，故不强行复用。
 */
const McpMarketplacePagination: React.FC<McpMarketplacePaginationProps> = React.memo(
  ({
    currentPage,
    pageCount,
    hasPrev,
    hasNext,
    loading,
    perPage,
    onPerPageChange,
    onGoToPage,
    onPrevPage,
    onNextPage,
  }) => (
    <div className="shrink-0">
      <div className="flex items-center justify-between px-3 h-9 border-t border-border">
        <span className="text-[10.5px] text-text-muted tabular-nums">
          Page {currentPage} · {pageCount} server{pageCount !== 1 ? 's' : ''}
        </span>

        <div className="flex items-center gap-1">
          <button
            onClick={onPrevPage}
            disabled={!hasPrev || loading}
            className="p-1 rounded transition-colors text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-30 disabled:cursor-not-allowed"
            title="Previous page"
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          {/* 已访问页码按钮（游标栈缓存，可跳回）+ 下一页按钮 */}
          {Array.from({ length: currentPage }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => onGoToPage(p)}
              disabled={loading || p === currentPage}
              className={cn(
                'min-w-[24px] h-6 text-[11px] rounded transition-colors',
                p === currentPage
                  ? 'bg-bg-selected text-text-primary font-medium'
                  : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
                (loading || p === currentPage) && 'cursor-default',
              )}
            >
              {p}
            </button>
          ))}
          {hasNext && (
            <button
              onClick={() => onGoToPage(currentPage + 1)}
              disabled={loading}
              className="min-w-[24px] h-6 text-[11px] rounded transition-colors text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            >
              {currentPage + 1}
            </button>
          )}

          <button
            onClick={onNextPage}
            disabled={!hasNext || loading}
            className="p-1 rounded transition-colors text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-30 disabled:cursor-not-allowed"
            title="Next page"
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        <select
          value={perPage}
          onChange={(e) => onPerPageChange(Number(e.target.value))}
          disabled={loading}
          title="Per page"
          className="h-6 px-1 text-[10.5px] rounded-md bg-bg-hover/60 border border-transparent text-text-muted outline-none focus:border-border"
        >
          {MCP_PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>
    </div>
  ),
);

McpMarketplacePagination.displayName = 'McpMarketplacePagination';

export default McpMarketplacePagination;
