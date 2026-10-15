import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/shallow';

import { cn } from '@/lib/utils';
import { BranchIcon, ArrowDown, ArrowUp } from '@/shared/components/icons';
import { useGitStore } from '@/shared/store/gitStore';
import { useProjectStore } from '@/shared/store/projectStore';
import { useActiveWorkspaceKey } from '@/shared/store/workspaceStore';
import type { GitInfo } from '@/shared/types';

import { useBranchDisplay } from '../hooks/useBranchDisplay';

import BranchSwitcherPanel from './BranchSwitcherPanel';

interface BranchStatusBarWidgetProps {
  /** 不传 = 状态栏无弹窗宿主（见 `BranchItem`）→ 对应入口不渲染。 */
  onNewBranch?: () => void;
  onNewWorktree?: () => void;
  onCheckoutBranch: (branchName: string) => void;
}

function BranchStatusBarWidget({
  onNewBranch,
  onNewWorktree,
  onCheckoutBranch,
}: BranchStatusBarWidgetProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const spanRef = useRef<HTMLSpanElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties | undefined>(undefined);
  const [isOverflowing, setIsOverflowing] = useState(false);

  const activeProject = useProjectStore((s) => s.activeProject);
  const gitInfo: GitInfo | null = activeProject?.git_info ?? null;
  const projectId = activeProject?.id ?? null;

  // ahead/behind 按**Workspace**取（显示的分支就来自该单元的 HEAD）：
  // 旧实现读 `aheadBehind[projectId]` —— 键空间里从来没有这个键，徽标恒空。
  const workspaceKey = useActiveWorkspaceKey(projectId);
  const aheadBehind = useGitStore(
    useShallow((s) => (projectId ? (s.aheadBehind[workspaceKey ?? ''] ?? null) : null)),
  );

  // 分支行派生规则（displayBranch / availableBranches / aheadBehindMap / 切分支门）
  // 的唯一实现，与 `BranchInfo` 共用 —— 见 `useBranchDisplay`。
  const {
    isWorktreeActive,
    displayBranch,
    availableBranches,
    aheadBehindMap,
    favoriteBranches,
    toggleFavorite,
    canSwitchBranch,
  } = useBranchDisplay(projectId, gitInfo, aheadBehind);

  // Worktree cannot switch branches — disable panel when worktree is active
  const handleTogglePanel = useCallback(() => {
    if (!canSwitchBranch) return;
    setPanelOpen((v) => !v);
  }, [canSwitchBranch]);

  useEffect(() => {
    if (panelOpen && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setPanelStyle({
        position: 'fixed',
        bottom: window.innerHeight - rect.top + 4,
        left: rect.left,
      });
    } else {
      setPanelStyle(undefined);
    }
  }, [panelOpen]);

  useEffect(() => {
    const el = spanRef.current;
    if (!el) return;
    setIsOverflowing(el.scrollWidth > el.clientWidth);
  }, [displayBranch]);

  if (!gitInfo || !displayBranch) return null;

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cn(
          'flex items-center gap-1 hover:text-text-primary cursor-pointer transition-colors shrink-0',
          isWorktreeActive && 'opacity-70 cursor-default',
        )}
        onClick={handleTogglePanel}
        title={
          isWorktreeActive
            ? `Worktree branch: ${displayBranch} (read-only)`
            : `Current branch: ${displayBranch}`
        }
      >
        <BranchIcon size={12} className="shrink-0 text-accent-blue" />
        <span
          ref={spanRef}
          className="truncate max-w-[120px] font-mono text-[12px]"
          dir={isOverflowing ? 'rtl' : 'ltr'}
        >
          {displayBranch}
        </span>
        {aheadBehind && (aheadBehind.ahead > 0 || aheadBehind.behind > 0) && (
          <span className="flex items-center gap-1 text-[11px]">
            {aheadBehind.behind > 0 && (
              <span className="flex items-center gap-0.5 text-accent-blue">
                <ArrowDown size={9} />
                {aheadBehind.behind}
              </span>
            )}
            {aheadBehind.ahead > 0 && (
              <span className="flex items-center gap-0.5 text-accent-green">
                <ArrowUp size={9} />
                {aheadBehind.ahead}
              </span>
            )}
          </span>
        )}
      </button>

      {panelOpen &&
        panelStyle &&
        createPortal(
          <>
            <button
              className="fixed inset-0 z-[999] w-full h-full cursor-default"
              onClick={() => setPanelOpen(false)}
              aria-label="Close panel"
              type="button"
            />
            <div className="fixed z-[1000]" style={panelStyle}>
              <BranchSwitcherPanel
                branches={availableBranches}
                currentBranch={displayBranch}
                favoriteBranches={favoriteBranches}
                aheadBehind={aheadBehindMap}
                onCheckout={(name) => {
                  onCheckoutBranch(name);
                  setPanelOpen(false);
                }}
                onToggleFavorite={toggleFavorite}
                onNewBranch={
                  onNewBranch
                    ? () => {
                        setPanelOpen(false);
                        onNewBranch();
                      }
                    : undefined
                }
                onNewWorktree={
                  onNewWorktree
                    ? () => {
                        setPanelOpen(false);
                        onNewWorktree();
                      }
                    : undefined
                }
                onClose={() => setPanelOpen(false)}
              />
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

export { BranchStatusBarWidget };
export default BranchStatusBarWidget;
