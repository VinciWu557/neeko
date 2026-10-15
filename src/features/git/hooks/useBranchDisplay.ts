import { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/shallow';

import { useGitStore } from '@/shared/store/gitStore';
import { useActiveCheckoutBranch, useActiveCheckoutPath } from '@/shared/store/workspaceStore';
import type { AheadBehind, GitInfo } from '@/shared/types';
import { filterWorktreeBranches, isActiveWorktree } from '@/shared/utils';
import type { ProjectId } from '@/shared/utils/workspaceRef';

/**
 * 「分支行」两处渲染（Changes 面板的 `BranchInfo` 与状态栏的 `BranchStatusBarWidget`）
 * 共用的**派生规则唯一实现**。
 *
 * 为什么必须收敛：这四条规则曾在两处各写一份副本 —— `isWorktreeActive` + `displayBranch`
 * 的三元、`filterWorktreeBranches` 的调用、`aheadBehindMap` 的构造、以及「worktree 不可切分支」
 * 的门。副本初期等价，任一侧单独修改（例如给 worktree 分支名加后缀、或 ahead/behind 改成
 * 显示 behind）都会让另一侧静默失效，且**不报任何错**（`.trellis/spec/guides/code-reuse-thinking-guide.md`
 * 的「模式 5：同一派生规则抄成多份」）。
 *
 * 本 hook 只做派生，不做渲染、不发命令：两处的视觉与交互差异（pill vs button、portal 定位）
 * 留在各自组件里，那是**刻意的**差异，不该被抽象吞掉。
 *
 * `currentBranch` 也一并外露 —— 它曾是本 hook 内部的一行表达式，而 `BranchInfo` 又在自己
 * 里重算了一遍同一个式（「同一派生规则抄成多份」的漏网之鱼）。
 */
export interface BranchDisplay {
  /** 是否处于 linked worktree 单元（worktree 不可切分支）。 */
  isWorktreeActive: boolean;
  /** 项目当前分支（主仓 HEAD）；worktree 单元下不代表显示分支。 */
  currentBranch: string;
  /** 应展示的分支名：worktree 单元取其 HEAD，主仓取项目当前分支。 */
  displayBranch: string;
  /** 排除已被其它工作树占用的分支（`git checkout` 会失败的那些）。 */
  availableBranches: string[];
  /** `BranchSwitcherPanel` 需要的「分支 → 领先/落后」表。 */
  aheadBehindMap: Record<string, { ahead: number; behind: number }>;
  /** 收藏分支（按 projectId）。 */
  favoriteBranches: string[];
  /** 切换收藏态（已绑定 projectId）。 */
  toggleFavorite: (branchName: string) => void;
  /** 打开分支选择器的统一门：worktree 单元下一律拒绝。 */
  canSwitchBranch: boolean;
}

export function useBranchDisplay(
  projectId: ProjectId | null,
  gitInfo: GitInfo | null,
  aheadBehind: AheadBehind | null,
): BranchDisplay {
  const activeCheckoutPath = useActiveCheckoutPath();
  const activeCheckoutBranch = useActiveCheckoutBranch();
  const isWorktreeActive = isActiveWorktree(activeCheckoutPath);

  const currentBranch = gitInfo?.current_branch ?? '';
  const displayBranch = isWorktreeActive ? activeCheckoutBranch : currentBranch;

  const favoriteBranches = useGitStore(
    useShallow((s) => (projectId ? (s.favoriteBranches[projectId] ?? []) : [])),
  );
  const rawToggleFavorite = useGitStore((s) => s.toggleFavorite);
  const toggleFavorite = useCallback(
    (branchName: string) => {
      if (!projectId) return;
      rawToggleFavorite(projectId, branchName);
    },
    [projectId, rawToggleFavorite],
  );

  const availableBranches = useMemo(
    () => filterWorktreeBranches(gitInfo?.branches ?? [], gitInfo?.worktrees ?? []),
    [gitInfo?.branches, gitInfo?.worktrees],
  );

  const aheadBehindMap = useMemo(() => {
    if (!aheadBehind || !displayBranch) return {};
    return { [displayBranch]: { ahead: aheadBehind.ahead, behind: aheadBehind.behind } };
  }, [aheadBehind, displayBranch]);

  return useMemo(
    () => ({
      isWorktreeActive,
      currentBranch,
      displayBranch,
      availableBranches,
      aheadBehindMap,
      favoriteBranches,
      toggleFavorite,
      canSwitchBranch: !isWorktreeActive,
    }),
    [
      isWorktreeActive,
      currentBranch,
      displayBranch,
      availableBranches,
      aheadBehindMap,
      favoriteBranches,
      toggleFavorite,
    ],
  );
}
