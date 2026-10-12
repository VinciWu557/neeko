import { Star } from 'lucide-react';
import React from 'react';

import type { McpMarketSortMode } from '@/features/library/hooks/useMcpMarketplace';
import { cn } from '@/lib/utils';

interface McpMarketplaceFilterRowProps {
  transportFilter: string | null;
  onTransportFilterChange: (value: string | null) => void;
  /** 当前页出现过的传输方式（chip 只渲染存在的项）。 */
  availableTransports: readonly string[];
  sortMode: McpMarketSortMode;
  onSortModeChange: (mode: McpMarketSortMode) => void;
}

/**
 * 市场过滤 / 排序行（传输方式 chips + 排序按钮）。
 * 从 McpMarketplaceContent 抽出（组件体积 ratchet），行为零漂移；
 * 交互对齐 Skills 市场的 SourceFilter / LeaderboardToggle。
 */
const McpMarketplaceFilterRow: React.FC<McpMarketplaceFilterRowProps> = React.memo(
  ({
    transportFilter,
    onTransportFilterChange,
    availableTransports,
    sortMode,
    onSortModeChange,
  }) => (
    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onTransportFilterChange(null)}
          className={cn(
            'h-6 px-2 text-[11px] rounded-md transition-colors',
            transportFilter === null
              ? 'bg-bg-selected text-text-primary'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
        >
          All
        </button>
        {availableTransports.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onTransportFilterChange(transportFilter === t ? null : t)}
            className={cn(
              'h-6 px-2 text-[11px] rounded-md transition-colors',
              transportFilter === t
                ? 'bg-bg-selected text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onSortModeChange('recent')}
          className={cn(
            'h-6 px-2 text-[11px] rounded-md transition-colors',
            sortMode === 'recent'
              ? 'bg-bg-selected text-text-primary'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
        >
          Recent
        </button>
        <button
          type="button"
          onClick={() => onSortModeChange('alpha')}
          className={cn(
            'h-6 px-2 text-[11px] rounded-md transition-colors',
            sortMode === 'alpha'
              ? 'bg-bg-selected text-text-primary'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
        >
          A–Z
        </button>
        <button
          type="button"
          onClick={() => onSortModeChange('popular')}
          className={cn(
            'flex items-center gap-1 h-6 px-2 text-[11px] rounded-md transition-colors',
            sortMode === 'popular'
              ? 'bg-bg-selected text-text-primary'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
        >
          <Star className="h-3 w-3 shrink-0" />
          Popular
        </button>
        <button
          type="button"
          onClick={() => onSortModeChange('downloads')}
          className={cn(
            'h-6 px-2 text-[11px] rounded-md transition-colors',
            sortMode === 'downloads'
              ? 'bg-bg-selected text-text-primary'
              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
          )}
        >
          Downloads
        </button>
      </div>
    </div>
  ),
);

McpMarketplaceFilterRow.displayName = 'McpMarketplaceFilterRow';

export default McpMarketplaceFilterRow;
