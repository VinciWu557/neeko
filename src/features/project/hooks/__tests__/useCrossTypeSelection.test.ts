import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProjectStore } from '@/shared/store/projectStore';
import { useWorkspaceStore } from '@/shared/store/workspaceStore';
import { createProject } from '@/testing/factories';

import { useCrossTypeSelection } from '../useCrossTypeSelection';

function makeActions() {
  return {
    wslActions: {
      setWslDiffState: undefined,
      resetTransientState: vi.fn(),
      handleRefreshGit: vi.fn(),
      handleOpenWorktreeTerminal: vi.fn(),
      setActiveWorkspacePath: vi.fn(),
    },
    remoteActions: {
      resetTransientState: vi.fn(),
      handleRefreshGit: vi.fn(),
      handleOpenWorktreeTerminal: vi.fn(),
      setActiveWorkspacePath: vi.fn(),
    },
  };
}

describe('useCrossTypeSelection.handleSelectProject', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [], activeProjectId: null, activeProject: null });
    useWorkspaceStore.setState({ byProject: {} });
  });

  it('WSL 项目选中后设为活跃项目，且不经 local 的 selectProject', async () => {
    const project = createProject({
      id: 'p-wsl',
      environment: { type: 'Wsl', distro: 'Ubuntu' },
    });
    useProjectStore.setState({ projects: [project], activeProjectId: null, activeProject: null });

    const { wslActions, remoteActions } = makeActions();
    const selectProject = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useCrossTypeSelection({ wslActions, remoteActions, selectProject }),
    );

    await act(async () => {
      await result.current.handleSelectProject('p-wsl');
    });

    expect(useProjectStore.getState().activeProjectId).toBe('p-wsl');
    // WSL 路径不经 local 的 selectProject
    expect(selectProject).not.toHaveBeenCalled();
  });

  it('Remote 项目选中后同样设为活跃项目', async () => {
    const project = createProject({
      id: 'p-ssh',
      environment: {
        type: 'Remote',
        host: 'example.com',
        port: 22,
        username: 'u',
        auth: { type: 'password', password: 'p' },
      },
    });
    useProjectStore.setState({ projects: [project], activeProjectId: null, activeProject: null });

    const { wslActions, remoteActions } = makeActions();
    const selectProject = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useCrossTypeSelection({ wslActions, remoteActions, selectProject }),
    );

    await act(async () => {
      await result.current.handleSelectProject('p-ssh');
    });

    expect(useProjectStore.getState().activeProjectId).toBe('p-ssh');
  });
});
