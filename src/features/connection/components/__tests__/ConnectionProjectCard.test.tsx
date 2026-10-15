import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import ConnectionProjectCard from '@/features/connection/components/ConnectionProjectCard';
import { useGitStore } from '@/shared/store/gitStore';
import { useProjectStore } from '@/shared/store/projectStore';
import { useWorkspaceStore } from '@/shared/store/workspaceStore';
import type { FileChange, GitStatusSnapshot, WSLProject } from '@/shared/types';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';
import { invoke } from '@/testing/tauriCore';

/** 某Workspace的权威 status（主仓 worktree_path = null）。 */
function makeSnapshot(
  projectId: string,
  worktreePath: string | null,
  entries: FileChange[],
): GitStatusSnapshot {
  return {
    workspace_key: WorkspaceSession.of(projectId, worktreePath ?? null).key,
    version: 1,
    project_id: projectId,
    worktree_path: worktreePath,
    branch: 'main',
    entries,
    truncated: false,
  };
}

const MODIFIED: FileChange = {
  path: 'src/A.tsx',
  status: 'Modified',
  additions: 4,
  deletions: 1,
};

function makeWslProject(overrides: Partial<WSLProject> = {}): WSLProject {
  return {
    id: 'wsl-p1',
    name: 'demo',
    path: '/home/user/demo',
    distro: 'Ubuntu',
    entry_id: 'entry-1',
    selected_agents: [],
    selected_ide: null,
    git_info: {
      current_branch: 'main',
      branches: ['main'],
      worktrees: [
        {
          path: '/home/user/wts/feature-x',
          branch: 'feature/x',
          head: 'abc',
        },
      ],
      // 注意：GitInfo 不再有 changed_files / is_clean —— 未提交变更属于每个工作树，
      // 经 projectStore.statuses[WorkspaceSession.of(projectId, (worktreePath) ?? null).key] 按单元投递。
    },
    ...overrides,
  };
}

describe('ConnectionProjectCard (WSL)', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue([]);
    // reset store（工作树单元状态只有 byProject 一份表示）
    useWorkspaceStore.setState({ byProject: {} });
    useProjectStore.setState({ statuses: {} });
    useGitStore.setState({
      aheadBehind: {},
    });
  });

  it('展开后渲染 local 主终端行与 worktree 行', async () => {
    const project = makeWslProject();
    useProjectStore.getState().applyStatus(makeSnapshot(project.id, null, [MODIFIED]));
    render(
      <ConnectionProjectCard
        project={project}
        entryId="entry-1"
        source={{ type: 'wsl', distro: 'Ubuntu' }}
        isActive={false}
        onSelectProject={vi.fn()}
        onRemoveProject={vi.fn()}
      />,
    );
    // 等待 mount 后异步 worktree/分支数据加载完成（同时 flush 其 setState）
    await waitFor(() => {
      expect(screen.getByText('local')).toBeInTheDocument();
    });

    // git_info 存在 → 自动展开
    expect(screen.getByText('local')).toBeInTheDocument();
    // worktree 目录名
    expect(screen.getByText('feature-x')).toBeInTheDocument();
  });

  it('点击 local 行触发 onSelectProject (传入 distro + project)', async () => {
    const project = makeWslProject();
    const onSelectProject = vi.fn();
    render(
      <ConnectionProjectCard
        project={project}
        entryId="entry-1"
        source={{ type: 'wsl', distro: 'Ubuntu' }}
        isActive={false}
        onSelectProject={onSelectProject}
        onRemoveProject={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('local')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('local'));
    expect(onSelectProject).toHaveBeenCalledWith(project.id);
  });

  it('点击 worktree 行触发 onOpenWorktreeTerminal (传入 distro)', async () => {
    const project = makeWslProject();
    const onOpenWorktreeTerminal = vi.fn();
    render(
      <ConnectionProjectCard
        project={project}
        entryId="entry-1"
        source={{ type: 'wsl', distro: 'Ubuntu' }}
        isActive={false}
        onSelectProject={vi.fn()}
        onRemoveProject={vi.fn()}
        onOpenWorktreeTerminal={onOpenWorktreeTerminal}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('feature-x')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('feature-x'));
    expect(onOpenWorktreeTerminal).toHaveBeenCalledWith(
      'Ubuntu',
      '/home/user/wts/feature-x',
      'feature/x',
    );
  });

  it('active + 无 active worktree 时 local 行显示 ↑N（来自 store 的 aheadBehind）', async () => {
    const project = makeWslProject();
    // 键 = Workspace身份（主仓单元）。旧键是 `wsl:Ubuntu:wsl-p1` —— 三个写入点各用一种
    // connectionId 约定，读侧拼不出写侧的键，徽标因此时有时无。
    useGitStore.setState({
      aheadBehind: { [WorkspaceSession.of(project.id, null).key]: { ahead: 3, behind: 0 } },
    });
    render(
      <ConnectionProjectCard
        project={project}
        entryId="entry-1"
        source={{ type: 'wsl', distro: 'Ubuntu' }}
        isActive
        onSelectProject={vi.fn()}
        onRemoveProject={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('↑3')).toBeInTheDocument();
    });

    expect(screen.getByText('↑3')).toBeInTheDocument();
  });

  it('active worktree 时 local 行不显示 ↑N，而 **worktree 行**显示它自己的 ↑N', async () => {
    const project = makeWslProject();
    const wtPath = '/home/user/wts/feature-x';
    useWorkspaceStore.getState().setActiveWorkspace(project.id, wtPath);
    // 两个单元的键都给值：主仓的数字**不得**泄漏到 worktree 视图的 local 行上，
    // 而 worktree 行读的正是**它自己单元**的键（与 local 行同一条规则，只换单元）。
    useGitStore.setState({
      aheadBehind: {
        [WorkspaceSession.of(project.id, null).key]: { ahead: 3, behind: 0 },
        [WorkspaceSession.of(project.id, wtPath ?? null).key]: { ahead: 9, behind: 0 },
      },
    });
    render(
      <ConnectionProjectCard
        project={project}
        entryId="entry-1"
        source={{ type: 'wsl', distro: 'Ubuntu' }}
        isActive
        onSelectProject={vi.fn()}
        onRemoveProject={vi.fn()}
      />,
    );
    // worktree 行展示它自己单元的待 push 提交数
    await waitFor(() => {
      expect(screen.getByText('↑9')).toBeInTheDocument();
    });
    // 主仓的数字不得出现在 worktree 视图里
    expect(screen.queryByText('↑3')).not.toBeInTheDocument();
  });
});
