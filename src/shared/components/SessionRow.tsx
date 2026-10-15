import React from 'react';

import { cn } from '@/lib/utils';
import { TerminalIcon, FolderGitIcon } from '@/shared/components/icons';
import SessionChips from '@/shared/components/SessionChips';

type SessionKind = 'local' | 'worktree';

interface SessionRowProps {
  kind: SessionKind;
  label: string;
  branch?: string;
  isActive?: boolean;
  /**
   * 待 push 提交数（相对 `@{upstream}`）。**只在激活行展示**（`isActive`）——
   * 该数字的值只有激活单元才会被写入 store（见 `useAheadBehindSync` / `useGitStatusEventsSync`），
   * 因此这个门与数据来源同一定义，不是视觉偏好。
   */
  ahead?: number;
  // 注：曾有 `changes?: { add, del }`（+A / -D 行级统计）。G4 把 numstat 移出 status 热路径后
  // 它的数据源（`FileChange.additions/deletions`）恒为 0，chip 永不渲染，已整体删除。
  shortcut?: string;
  title?: string;
  onClick?: (e: React.MouseEvent) => void;
  /**
   * 编辑态替换 label + branch 区（linked worktree 的行内重命名）。
   * 由调用方拥有状态与输入框 ref —— 展示组件不持有输入状态。
   */
  editing?: React.ReactNode;
  /** 双击 label 的语义（worktree = 开始重命名；local 不传）。 */
  onLabelDoubleClick?: (e: React.MouseEvent) => void;
  /** label 的 title（如 "Double-click to rename"）。 */
  labelTitle?: string;
  /** 删除中：整行播放淡出并把交互关掉（`wt-deleting`）。 */
  deleting?: boolean;
  /** 行尾追加内容（如 worktree 的 trash 按钮 / loading spinner）；显示在 chip 区右侧 */
  trailing?: React.ReactNode;
}

const SessionRow: React.FC<SessionRowProps> = ({
  kind,
  label,
  branch,
  isActive = false,
  ahead,
  shortcut,
  title,
  onClick,
  editing,
  onLabelDoubleClick,
  labelTitle,
  deleting = false,
  trailing,
}) => {
  const Icon = kind === 'worktree' ? FolderGitIcon : TerminalIcon;
  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        'group flex items-center gap-2.5 pl-4 pr-3 py-2 mx-1.5 rounded-md cursor-pointer transition-colors',
        deleting && 'wt-deleting',
        isActive ? 'bg-bg-selected' : 'hover:bg-bg-hover',
      )}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (onClick) onClick(e as unknown as React.MouseEvent<HTMLDivElement>);
        }
      }}
      title={title}
    >
      <span
        className={cn(
          'w-7 h-7 rounded-md flex items-center justify-center shrink-0',
          isActive ? 'text-text-primary' : 'text-text-muted',
        )}
        style={{
          backgroundColor: isActive ? 'var(--bg-selected)' : 'transparent',
        }}
      >
        <Icon size={16} />
      </span>
      <div className="flex-1 min-w-0">
        {editing ?? (
          <>
            <div
              className="text-[var(--font-size)] font-semibold text-text-primary truncate"
              onDoubleClick={onLabelDoubleClick}
              title={labelTitle}
            >
              {label}
            </div>
            {branch && (
              <div className="text-[0.85em] font-mono text-text-muted truncate">{branch}</div>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isActive && ahead !== undefined && <SessionChips.Ahead ahead={ahead} />}
        {shortcut && (
          <span className="hidden group-hover:inline-flex">
            <SessionChips.Kbd>{shortcut}</SessionChips.Kbd>
          </span>
        )}
        {trailing}
      </div>
    </div>
  );
};

export default React.memo(SessionRow);
