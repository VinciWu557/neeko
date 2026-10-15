import { Plus, FolderGit2 } from 'lucide-react';
import React from 'react';

/**
 * `BranchSwitcherPanel` 的底部动作栏（New Branch / New Worktree）。
 *
 * 抽出的两个理由：
 * 1. 组件文件 300 行/ratchet 约束 —— 面板主体已接近上限，动作栏是边界清晰的一块；
 * 2. 它承载一条独立契约：**能力缺席时整体不渲染**。历史上状态栏宿主传 `() => {}`
 *    造出两个点了没反应的死按钮；把「有没有这个能力」表达成「渲染不渲染」收在这一处。
 */
interface BranchSwitcherActionsProps {
  /** 不传 = 无此能力 → 该入口不渲染。 */
  onNewBranch?: () => void;
  onNewWorktree?: () => void;
  /** 点击后关闭面板（由本组件统一调用，两个入口行为一致）。 */
  onClose: () => void;
}

const ACTION_CLASS =
  'flex-1 flex items-center justify-center gap-1.5 py-2 text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors duration-100';

const BranchSwitcherActions: React.FC<BranchSwitcherActionsProps> = ({
  onNewBranch,
  onNewWorktree,
  onClose,
}) => {
  if (!onNewBranch && !onNewWorktree) return null;
  return (
    <div className="flex border-t border-border">
      {onNewBranch && (
        <button
          className={ACTION_CLASS}
          onClick={() => {
            onNewBranch();
            onClose();
          }}
        >
          <Plus size={12} />
          New Branch
        </button>
      )}
      {onNewWorktree && (
        <button
          className={`${ACTION_CLASS} border-l border-border`}
          onClick={() => {
            onNewWorktree();
            onClose();
          }}
        >
          <FolderGit2 size={12} />
          New Worktree
        </button>
      )}
    </div>
  );
};

export default React.memo(BranchSwitcherActions);
