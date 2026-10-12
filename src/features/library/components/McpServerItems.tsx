import { Edit3, MoreHorizontal, Server, TestTube, Trash2 } from 'lucide-react';
import React from 'react';

import { cn } from '@/lib/utils';
import type { McpServer } from '@/shared/types/mcpServer';
import { tagChipClass } from '@/shared/utils/tagColors';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui';

/**
 * MCP server 条目的两种呈现（grid 卡片 / list 行）。
 * 从 McpListSection 抽出（组件体积 ratchet），行为零漂移；两者共用同一组 props 契约。
 * tag 配色不再自带副本：改用 `@/shared/utils/tagColors`（与 skill 侧同一实现）。
 */

interface McpServerItemProps {
  server: McpServer;
  onEdit: () => void;
  onTest: () => void;
  onDelete: () => void;
  testing: boolean;
}

export const McpCard: React.FC<McpServerItemProps> = React.memo(
  ({ server, onEdit, onTest, onDelete, testing }) => {
    const isRemote = server.transport === 'http' || server.transport === 'sse';
    const chips = server.tags.slice(0, 4);
    const displayDesc = server.description?.trim() || 'No description';

    return (
      <div
        className={cn(
          'group flex flex-col h-full min-h-[140px] rounded-lg cursor-pointer',
          'bg-bg-primary transition-colors duration-150',
          'border border-border',
          'hover:bg-bg-hover/40',
        )}
      >
        <div className="flex flex-col flex-1 gap-2 px-3.5 pt-3.5 pb-2 min-h-0">
          <div className="flex items-center gap-2">
            <Server className="h-3.5 w-3.5 text-accent-blue shrink-0" />
            <h3 className="flex-1 min-w-0 text-[13px] font-semibold text-text-primary truncate leading-none">
              {server.name}
            </h3>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover',
                    'opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100',
                    'data-[state=open]:bg-bg-hover data-[state=open]:text-text-primary',
                    'transition-opacity shrink-0',
                  )}
                  title="Actions"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={6} className="w-[160px]">
                <DropdownMenuItem onSelect={onTest} disabled={testing}>
                  <TestTube /> {testing ? 'Testing...' : 'Test'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onEdit}>
                  <Edit3 /> Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={onDelete}
                  className="text-accent-red data-[highlighted]:text-accent-red"
                >
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <p
            className={cn(
              'text-[12px] leading-relaxed line-clamp-2 min-h-[2.5em]',
              server.description ? 'text-text-secondary' : 'text-text-muted italic',
            )}
            title={displayDesc}
          >
            {displayDesc}
          </p>

          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="inline-flex items-center text-[11px] leading-none px-2 py-1 rounded-md font-medium bg-accent-blue/10 text-accent-blue border border-accent-blue/20">
              {server.transport}
            </span>
            {isRemote && server.url && (
              <span
                className="text-[11px] text-text-muted truncate max-w-[120px]"
                title={server.url}
              >
                {server.url}
              </span>
            )}
            {!isRemote && server.command && (
              <span className="text-[11px] text-text-muted font-mono truncate max-w-[120px]">
                {server.command}
              </span>
            )}
          </div>

          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {chips.map((tag) => (
                <span
                  key={tag}
                  className={cn(
                    'inline-flex items-center text-[11px] leading-none px-2 py-1 rounded-md font-medium',
                    tagChipClass(tag),
                  )}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-3.5 py-2.5 mt-auto border-t border-border text-[11px]">
          <span className="text-text-muted">{isRemote ? 'Remote' : 'Local'}</span>
          <span className="text-text-muted">·</span>
          <span className="text-text-muted">
            {server.scope === 'project' && server.projectId ? 'Project' : 'Global'}
          </span>
        </div>
      </div>
    );
  },
);

McpCard.displayName = 'McpCard';

export const McpListItem: React.FC<McpServerItemProps> = React.memo(
  ({ server, onEdit, onTest, onDelete, testing }) => {
    const isRemote = server.transport === 'http' || server.transport === 'sse';

    return (
      <div className="group flex items-center gap-3 px-3 py-2 rounded-lg border border-border bg-bg-primary hover:bg-bg-hover transition-colors">
        <Server className="h-4 w-4 text-accent-blue shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[var(--font-size)] font-semibold text-text-primary truncate">
              {server.name}
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-blue/10 text-accent-blue border border-accent-blue/20 font-medium">
              {server.transport}
            </span>
            {server.description && (
              <span className="text-[11px] text-text-muted truncate hidden sm:inline">
                {server.description}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {isRemote && server.url ? (
              <span className="text-[11px] text-text-muted font-mono truncate">{server.url}</span>
            ) : (
              <span className="text-[11px] text-text-muted font-mono truncate">
                {server.command}
              </span>
            )}
            {server.tags.length > 0 && (
              <span className="text-[11px] text-text-muted">
                {server.tags.slice(0, 3).join(', ')}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            type="button"
            className="h-7 px-2 text-[11px] font-medium rounded-md bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25 flex items-center gap-1 disabled:opacity-50"
            onClick={onTest}
            disabled={testing}
            title="Test connection"
          >
            <TestTube className="h-3 w-3" /> {testing ? 'Testing...' : 'Test'}
          </button>
          <button
            type="button"
            className="h-7 w-7 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover flex items-center justify-center"
            onClick={onEdit}
            title="Edit"
          >
            <Edit3 className="h-3 w-3" />
          </button>
          <button
            type="button"
            className="h-7 w-7 rounded-md text-text-muted hover:text-accent-red hover:bg-bg-hover flex items-center justify-center"
            onClick={onDelete}
            title="Delete"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    );
  },
);

McpListItem.displayName = 'McpListItem';
