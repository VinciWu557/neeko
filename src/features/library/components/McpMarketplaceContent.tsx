import { Loader2, AlertTriangle, Store } from 'lucide-react';
import React, { useCallback, useMemo } from 'react';

import {
  MCP_TRANSPORT_OPTIONS,
  useMcpMarketplace,
} from '@/features/library/hooks/useMcpMarketplace';
import { useMcpStore } from '@/features/library/store/mcpStore';
import { useScrollMemory } from '@/shared/hooks/useScrollMemory';
import { buildScrollKey } from '@/shared/utils/scrollMemory';

import McpMarketCard from './McpMarketCard';
import McpMarketplaceFilterRow from './McpMarketplaceFilterRow';
import McpMarketplacePagination from './McpMarketplacePagination';

const McpMarketplaceContent: React.FC = React.memo(() => {
  const {
    displayList,
    visibleList,
    loading,
    error,
    hasNext,
    hasPrev,
    currentPage,
    perPage,
    setPerPage,
    goToPage,
    nextPage,
    prevPage,
    searchQuery,
    isInstalled,
    sortMode,
    setSortMode,
    transportFilter,
    setTransportFilter,
  } = useMcpMarketplace();

  const openMcpInstall = useMcpStore((s) => s.openMcpInstall);

  const handleInstall = useCallback(
    async (name: string) => {
      try {
        const { fetchMcpRegistryServer } = await import('@/features/library/api/libraryApi');
        const detail = await fetchMcpRegistryServer(name);
        if (!detail.generated) return;
        openMcpInstall(
          {
            name: detail.summary.name,
            title: detail.summary.title,
            version: detail.summary.version,
          },
          detail.generated,
        );
      } catch (e) {
        console.error('Failed to fetch registry server detail:', e);
      }
    },
    [openMcpInstall],
  );

  // Transport options present in the current page (for the filter chips)
  const availableTransports = useMemo(() => {
    const present = new Set<string>();
    for (const s of displayList) {
      for (const t of s.transports) present.add(t);
    }
    return MCP_TRANSPORT_OPTIONS.filter((t) => present.has(t));
  }, [displayList]);

  // 滚动记忆：Library 常驻期引擎丢位置 / 卸载重建都恢复（marketplace 网格）。
  const scrollRef = useScrollMemory<HTMLDivElement>(
    buildScrollKey('library.mcp', null, 'marketplace'),
  );

  const isEmpty = !loading && !error && visibleList.length === 0;

  return (
    <div className="h-full min-h-0 flex flex-col overflow-hidden">
      {/* Safety banner */}
      <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-accent-yellow/10 border-b border-accent-yellow/20">
        <AlertTriangle className="h-3 w-3 text-accent-yellow shrink-0" />
        <span className="text-[10.5px] text-accent-yellow leading-snug">
          MCP servers can execute arbitrary code. Review the generated config before installing.
        </span>
      </div>

      {/* 过滤 / 排序行 — 对齐 Skills 市场的 SourceFilter/LeaderboardToggle 交互 */}
      {!loading && displayList.length > 0 && (
        <McpMarketplaceFilterRow
          transportFilter={transportFilter}
          onTransportFilterChange={setTransportFilter}
          availableTransports={availableTransports}
          sortMode={sortMode}
          onSortModeChange={setSortMode}
        />
      )}

      {/* Content area — 外层相对定位：翻页 loading 时叠加遮罩（保留旧内容不跳动） */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <div
          ref={scrollRef}
          className="h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain"
        >
          {loading && displayList.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-text-muted gap-2">
              <Loader2 className="h-5 w-5 animate-spin opacity-50" />
              <span className="text-[11px]">Loading…</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-text-muted gap-2 px-6">
              <span className="text-[var(--font-size)] text-accent-red">{error}</span>
            </div>
          ) : isEmpty ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-text-muted gap-2 px-6">
              <div className="w-11 h-11 rounded-xl bg-bg-hover flex items-center justify-center">
                <Store className="h-5 w-5 opacity-50" />
              </div>
              <span className="text-[var(--font-size)] text-text-secondary">
                {searchQuery || transportFilter ? 'No results' : 'No servers available'}
              </span>
            </div>
          ) : (
            <div
              className="p-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 content-start"
              role="list"
              aria-label={`Servers (${visibleList.length})`}
            >
              {visibleList.map((server) => (
                <div key={server.name} role="listitem" className="min-w-0 h-full">
                  <McpMarketCard
                    server={server}
                    isInstalled={isInstalled(server.name)}
                    onInstall={handleInstall}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 翻页 loading 遮罩：已有内容时叠加半透明层 + spinner，避免页面跳变 */}
        {loading && displayList.length > 0 && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg-primary/50">
            <Loader2 className="h-5 w-5 animate-spin opacity-60" />
          </div>
        )}
      </div>

      {/* Pagination — 游标栈语义（见 McpMarketplacePagination 注释） */}
      <McpMarketplacePagination
        currentPage={currentPage}
        pageCount={displayList.length}
        hasPrev={hasPrev}
        hasNext={hasNext}
        loading={loading}
        perPage={perPage}
        onPerPageChange={setPerPage}
        onGoToPage={goToPage}
        onPrevPage={prevPage}
        onNextPage={nextPage}
      />
    </div>
  );
});

McpMarketplaceContent.displayName = 'McpMarketplaceContent';

export default McpMarketplaceContent;
