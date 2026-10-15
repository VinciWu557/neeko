import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useBranchDisplay } from '@/features/git/hooks/useBranchDisplay';
import { useGitStore } from '@/shared/store/gitStore';
import { useProjectStore } from '@/shared/store/projectStore';
import { useWorkspaceStore } from '@/shared/store/workspaceStore';
import type { GitInfo } from '@/shared/types';
import type { ProjectId } from '@/shared/utils/workspaceRef';

const P1 = 'p1' as ProjectId;
const WT = '/repo/.worktrees/dev';

/**
 * `useBranchDisplay` 是「分支行」两处渲染（Changes 面板 `BranchInfo` / 状态栏
 * `BranchStatusBarWidget`）共用的**派生规则唯一实现**。本文件直测它，而不是全靠那两个
 * 组件间接覆盖 —— 收敛后的规则一旦漂移，两处会**同时**出错且没有独立信号。
 */
function gitInfo(overrides: Partial<GitInfo> = {}): GitInfo {
  return {
    current_branch: 'main',
    branches: ['main', 'feature/x', 'feature/y'],
    worktrees: [{ path: WT, branch: 'feature/x', head: 'abc' }],
    git_provider: 'GitHub',
    ...overrides,
  } as GitInfo;
}

/** 铺前置：激活项目 = P1，激活单元 = 给定 worktree（null = 主仓）。 */
function seed(activePath: string | null, activeBranch = '') {
  useProjectStore.setState({ activeProjectId: P1 });
  if (activePath) {
    useWorkspaceStore.getState().setActiveWorkspace(P1, activePath, activeBranch);
  } else {
    useWorkspaceStore.setState({ byProject: {} });
  }
}

describe('useBranchDisplay — 分支行派生规则的唯一实现', () => {
  beforeEach(() => {
    useProjectStore.setState({ activeProjectId: null });
    useWorkspaceStore.setState({ byProject: {} });
    useGitStore.setState({ aheadBehind: {}, favoriteBranches: {} });
  });

  it('主仓单元：displayBranch = git_info.current_branch，可切分支', () => {
    seed(null);
    const { result } = renderHook(() => useBranchDisplay(P1, gitInfo(), null));
    expect(result.current.isWorktreeActive).toBe(false);
    expect(result.current.displayBranch).toBe('main');
    expect(result.current.canSwitchBranch).toBe(true);
  });

  it('worktree 单元：displayBranch = 该单元 HEAD，不可切分支（worktree 只读）', () => {
    seed(WT, 'feature/x');
    const { result } = renderHook(() => useBranchDisplay(P1, gitInfo(), null));
    expect(result.current.isWorktreeActive).toBe(true);
    expect(result.current.displayBranch).toBe('feature/x');
    expect(result.current.canSwitchBranch).toBe(false);
  });

  it('availableBranches 排除已被其它工作树占用的分支', () => {
    seed(null);
    const { result } = renderHook(() => useBranchDisplay(P1, gitInfo(), null));
    // feature/x 已被 WT 占用 ⇒ 只剩 main / feature/y
    expect(result.current.availableBranches).toEqual(['main', 'feature/y']);
  });

  it('aheadBehindMap 按 displayBranch 作键（worktree 下不是 main）', () => {
    seed(WT, 'feature/x');
    const { result } = renderHook(() => useBranchDisplay(P1, gitInfo(), { ahead: 3, behind: 1 }));
    expect(result.current.aheadBehindMap).toEqual({
      'feature/x': { ahead: 3, behind: 1 },
    });
  });

  it('aheadBehind 为空时 aheadBehindMap = {}（不是带空值的键）', () => {
    seed(null);
    const { result } = renderHook(() => useBranchDisplay(P1, gitInfo(), null));
    expect(result.current.aheadBehindMap).toEqual({});
  });

  it('gitInfo 为 null（非 git 项目）不抛错，displayBranch 为空串', () => {
    seed(null);
    const { result } = renderHook(() => useBranchDisplay(P1, null, null));
    expect(result.current.displayBranch).toBe('');
    expect(result.current.availableBranches).toEqual([]);
  });

  it('favoriteBranches 按 projectId 取，toggleFavorite 已绑定 projectId', () => {
    seed(null);
    useGitStore.setState({ favoriteBranches: { [P1]: ['main'] } });
    const { result } = renderHook(() => useBranchDisplay(P1, gitInfo(), null));
    expect(result.current.favoriteBranches).toEqual(['main']);

    act(() => result.current.toggleFavorite('feature/y'));
    expect(useGitStore.getState().favoriteBranches[P1]).toEqual(['main', 'feature/y']);
  });

  it('projectId 为 null 时 toggleFavorite 是安全 no-op（不写任何键）', () => {
    seed(null);
    const { result } = renderHook(() => useBranchDisplay(null, gitInfo(), null));
    expect(result.current.favoriteBranches).toEqual([]);
    act(() => result.current.toggleFavorite('main'));
    expect(useGitStore.getState().favoriteBranches).toEqual({});
  });

  it('同一单元、稳定引用入参 ⇒ 输出引用稳定（进 effect deps 安全）', () => {
    seed(null);
    // 生产形态：`gitInfo` 来自 store（zustand 不可变更新 ⇒ 引用稳定）；
    // 即便调用方 spread 出新对象，`branches` / `worktrees` **数组引用**也不变，
    // 因此内部两个 useMemo 命中，输出对象引用随之稳定。
    const info = gitInfo();
    const { result, rerender } = renderHook(() => useBranchDisplay(P1, info, null));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('入参引用变化（新数组）⇒ 输出随之重建（不伪装稳定）', () => {
    seed(null);
    const { result, rerender } = renderHook(() => useBranchDisplay(P1, gitInfo(), null));
    const first = result.current;
    rerender();
    // 不稳定性是**调用方的注入口责任**，本 hook 不做隐藏缓存（那会伪装成稳定）。
    expect(result.current).not.toBe(first);
  });
});
