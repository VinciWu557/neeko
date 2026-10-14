import { useCallback } from 'react';

import type { CommitFileChange, StashActionResult, StashEntry } from '@/features/git/types';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, Minus, Plus } from '@/shared/components/icons';
import { useScrollMemory } from '@/shared/hooks/useScrollMemory';
import { buildScrollKey } from '@/shared/utils/scrollMemory';
import type { WorkspaceKey } from '@/shared/utils/workspaceRef';

import { formatRelativeTime } from './gitlog/commitListUtils';
import { commitStatusIcon } from './gitlog/commitStatusIcon';

/** 滚动视图身份：全局唯一 surface 常量（owner 段按 Workspace 隔离）。 */
const SCROLL_SURFACE = 'dock.git.stash';

interface StashPanelProps {
  stashes: StashEntry[];
  loading: boolean;
  error: string | null;
  expandedSelector: string | null;
  expandedFiles: CommitFileChange[];
  filesLoading: boolean;
  filesError: string | null;
  onToggle: (selector: string) => void;
  actionLoading: boolean;
  onApply: (selector: string) => Promise<StashActionResult | null>;
  onPop: (selector: string) => Promise<StashActionResult | null>;
  /** 点击文件：打开 diff tab（与 history 打开 diff 文件一致）。 */
  onOpenStashDiff: (selector: string, filePath: string) => void;
  onShowToast?: (message: string, type?: 'info' | 'error') => void;
  onRefreshGit: () => Promise<void>;
  /** 本面板渲染的 Workspace key（滚动记忆按工作区隔离）。 */
  workspaceKey: WorkspaceKey;
}

/** Stash 页签：列表 + 展开文件变更 + 底部 Apply/Pop 操作栏；点击文件打开 diff tab。 */
function StashPanel({
  stashes,
  loading,
  error,
  expandedSelector,
  expandedFiles,
  filesLoading,
  filesError,
  onToggle,
  actionLoading,
  onApply,
  onPop,
  onOpenStashDiff,
  onShowToast,
  onRefreshGit,
  workspaceKey,
}: StashPanelProps) {
  const selected = stashes.find((s) => s.selector === expandedSelector) ?? null;
  const busy = actionLoading;

  // 滚动记忆：Dock 面板互切（保活期引擎丢位置）与卸载重建都恢复；按 Workspace 隔离。
  const scrollRef = useScrollMemory<HTMLDivElement>(buildScrollKey(SCROLL_SURFACE, workspaceKey));

  const handleApply = useCallback(async () => {
    if (!selected || busy) return;
    const result = await onApply(selected.selector);
    if (!result) return; // 并发守卫拒绝
    if (result.success) {
      onShowToast?.(`已应用 ${selected.selector}，条目保留`, 'info');
      void onRefreshGit();
    } else {
      onShowToast?.(result.message || '应用失败', 'error');
    }
  }, [selected, busy, onApply, onShowToast, onRefreshGit]);

  const handlePop = useCallback(async () => {
    if (!selected || busy) return;
    const result = await onPop(selected.selector);
    if (!result) return;
    if (result.success) {
      onShowToast?.('已弹出，条目移除', 'info');
      void onRefreshGit();
    } else {
      onShowToast?.(result.message || '弹出失败', 'error');
    }
  }, [selected, busy, onPop, onShowToast, onRefreshGit]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="px-2 py-1 text-[calc(var(--font-size)-1px)] text-text-muted">
            Loading stashes…
          </div>
        ) : error ? (
          <div className="px-2 py-1 text-[calc(var(--font-size)-1px)] text-danger">{error}</div>
        ) : stashes.length === 0 ? (
          <div className="px-2 py-1 text-[calc(var(--font-size)-1px)] text-text-muted">
            No stashes
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {stashes.map((stash) => {
              const isExpanded = expandedSelector === stash.selector;
              return (
                <li
                  key={stash.selector}
                  className={cn('rounded', isExpanded ? 'bg-bg-hover' : 'hover:bg-bg-hover')}
                >
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-1.5 px-1.5 py-1 text-left"
                    onClick={() => onToggle(stash.selector)}
                  >
                    <span className="shrink-0 text-text-muted">
                      {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </span>
                    <span className="shrink-0 rounded bg-accent-purple/15 px-1 py-px text-[calc(var(--font-size)-3px)] font-medium leading-none text-accent-purple">
                      {stash.selector}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[var(--font-size)] leading-tight text-text-primary">
                      {stash.message || stash.hash}
                    </span>
                    <span className="shrink-0 text-[calc(var(--font-size)-2px)] text-text-muted">
                      {stash.branch}
                    </span>
                    <span
                      className="shrink-0 text-[calc(var(--font-size)-2px)] text-text-muted"
                      title={stash.timestamp}
                    >
                      {formatRelativeTime(stash.timestamp)}
                    </span>
                  </button>
                  {isExpanded ? (
                    <div className="ml-5 px-1.5 pb-1.5">
                      {filesLoading ? (
                        <div className="py-1 text-[calc(var(--font-size)-2px)] text-text-muted">
                          Loading files…
                        </div>
                      ) : filesError ? (
                        <div className="py-1 text-[calc(var(--font-size)-2px)] text-danger">
                          {filesError}
                        </div>
                      ) : expandedFiles.length === 0 ? (
                        <div className="py-1 text-[calc(var(--font-size)-2px)] text-text-muted">
                          No files in stash
                        </div>
                      ) : (
                        <ul className="flex flex-col">
                          {expandedFiles.map((file) => {
                            const statusInfo = commitStatusIcon(file.status, 10);
                            const i = file.path.lastIndexOf('/');
                            const name = i >= 0 ? file.path.slice(i + 1) : file.path;
                            const dir = i >= 0 ? file.path.slice(0, i) : '';
                            return (
                              <li key={file.path}>
                                <button
                                  type="button"
                                  className="flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-bg-hover"
                                  onClick={() => onOpenStashDiff(stash.selector, file.path)}
                                  title="点击打开 diff tab"
                                >
                                  <span className={statusInfo.color}>{statusInfo.icon}</span>
                                  <span className="max-w-[9rem] shrink-0 truncate font-mono text-[calc(var(--font-size)-1px)] text-text-primary">
                                    {name}
                                  </span>
                                  <span className="min-w-0 flex-1 truncate font-mono text-[calc(var(--font-size)-2px)] text-text-muted">
                                    {dir}
                                  </span>
                                  <span className="flex shrink-0 items-center gap-1 font-mono text-[calc(var(--font-size)-2px)]">
                                    <span className="flex items-center gap-px text-accent-green">
                                      <Plus size={9} />
                                      {file.additions}
                                    </span>
                                    <span className="flex items-center gap-px text-accent-red">
                                      <Minus size={9} />
                                      {file.deletions}
                                    </span>
                                  </span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 底部操作栏：Apply 保留条目 / Pop 应用并移除 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border/40 px-2 py-1.5">
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[calc(var(--font-size)-1px)]',
            selected ? 'font-mono text-accent-purple' : 'text-text-muted',
          )}
        >
          {selected ? selected.selector : '请先选择一条 stash'}
        </span>
        <button
          type="button"
          disabled={!selected || busy}
          className={cn(
            'shrink-0 rounded border px-2.5 py-1 text-[calc(var(--font-size)-1px)] transition-colors',
            'border-accent-green/35 text-accent-green hover:bg-accent-green/10 disabled:pointer-events-none disabled:opacity-45',
          )}
          onClick={() => void handleApply()}
        >
          Apply
        </button>
        <button
          type="button"
          disabled={!selected || busy}
          className={cn(
            'shrink-0 rounded border px-2.5 py-1 text-[calc(var(--font-size)-1px)] transition-colors',
            'border-accent-red/40 text-accent-red hover:bg-accent-red/10 disabled:pointer-events-none disabled:opacity-45',
          )}
          onClick={() => void handlePop()}
        >
          Pop
        </button>
      </div>
    </div>
  );
}

export default StashPanel;
