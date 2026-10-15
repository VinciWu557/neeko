import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConflictStages, FileChangedEvent } from '@/shared/types';
import type { ProjectCommands } from '@/shared/types/project';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { useConflictStages } from '../useConflictStages';

const { fileChangedCallbacks } = vi.hoisted(() => ({
  fileChangedCallbacks: [] as Array<(ev: FileChangedEvent) => void>,
}));

vi.mock('@/shared/hooks/useFileChangedEvent', () => ({
  useFileChangedEvent: (cb: (ev: FileChangedEvent) => void) => {
    if (!fileChangedCallbacks.includes(cb)) fileChangedCallbacks.push(cb);
  },
}));

const { gitRefreshCallbacks } = vi.hoisted(() => ({
  gitRefreshCallbacks: [] as Array<(projectId: string) => void>,
}));

vi.mock('@/shared/hooks/useGitRefresh', () => ({
  useGitRefresh: (cb: (projectId: string) => void) => {
    if (!gitRefreshCallbacks.includes(cb)) gitRefreshCallbacks.push(cb);
  },
}));

const { mockListen, statusSnapshotListeners } = vi.hoisted(() => {
  const statusSnapshotListeners: Array<(event: { payload: { project_id: string } }) => void> = [];
  const mockListen = (
    eventName: string,
    cb: (event: { payload: { project_id: string } }) => void,
  ) => {
    if (eventName === 'git-status-snapshot') statusSnapshotListeners.push(cb);
    return Promise.resolve(() => {});
  };
  return { mockListen, statusSnapshotListeners };
});

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => mockListen(...(args as Parameters<typeof mockListen>)),
}));

const WS = WorkspaceSession.of('p1', null);

function stages(): ConflictStages {
  return {
    path: 'src/a.ts',
    kind: 'both_modified',
    ancestor: { path: 'src/a.ts', content: 'base\n', size: 5, is_binary: false, truncated: false },
    ours: { path: 'src/a.ts', content: 'ours\n', size: 5, is_binary: false, truncated: false },
    theirs: { path: 'src/a.ts', content: 'theirs\n', size: 7, is_binary: false, truncated: false },
    merged: 'merged',
    regions: [],
    truncated: false,
    region_mergeable: true,
  };
}

const getConflictStages = vi.hoisted(() => vi.fn());
const commands = { getConflictStages } as unknown as ProjectCommands;

describe('useConflictStages', () => {
  beforeEach(() => {
    fileChangedCallbacks.length = 0;
    gitRefreshCallbacks.length = 0;
    statusSnapshotListeners.length = 0;
    getConflictStages.mockReset();
  });

  it('loads stages for the addressed file and exposes them', async () => {
    getConflictStages.mockResolvedValueOnce(stages());

    const { result } = renderHook(() =>
      useConflictStages({ commands, workspace: WS, filePath: 'src/a.ts' }),
    );

    await waitFor(() => expect(result.current.stages?.kind).toBe('both_modified'));
    expect(result.current.loading).toBe(false);
    expect(result.current.notConflicted).toBe(false);
    expect(result.current.error).toBeNull();
    expect(getConflictStages).toHaveBeenCalledWith('src/a.ts');
  });

  it('maps a rejected read to notConflicted convergence, NOT error (R10)', async () => {
    // 后端契约：path 无 unmerged 条目 → Err（已解决 / 非冲突）——正常收敛，不是错误。
    getConflictStages.mockRejectedValueOnce('path `src/a.ts` has no unmerged entries');

    const { result } = renderHook(() =>
      useConflictStages({ commands, workspace: WS, filePath: 'src/a.ts' }),
    );

    await waitFor(() => expect(result.current.notConflicted).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.stages).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('reloads when file-changed fires for this file', async () => {
    getConflictStages.mockResolvedValueOnce(stages());
    renderHook(() => useConflictStages({ commands, workspace: WS, filePath: 'src/a.ts' }));
    await waitFor(() => expect(getConflictStages).toHaveBeenCalledTimes(1));

    getConflictStages.mockResolvedValueOnce(stages());
    act(() => {
      for (const cb of fileChangedCallbacks) {
        cb({ workspace_key: String(WS.key), project_id: 'p1', paths: ['src/a.ts'] });
      }
    });
    await waitFor(() => expect(getConflictStages).toHaveBeenCalledTimes(2));
  });

  it('reloads when git-status-snapshot fires for this project', async () => {
    getConflictStages.mockResolvedValueOnce(stages());
    renderHook(() => useConflictStages({ commands, workspace: WS, filePath: 'src/a.ts' }));
    await waitFor(() => expect(getConflictStages).toHaveBeenCalledTimes(1));

    getConflictStages.mockResolvedValueOnce(stages());
    act(() => {
      for (const cb of statusSnapshotListeners) {
        cb({ payload: { project_id: 'p1' } });
      }
    });
    await waitFor(() => expect(getConflictStages).toHaveBeenCalledTimes(2));
  });

  it('reloads when the Git panel refresh button fires for this project', async () => {
    getConflictStages.mockResolvedValueOnce(stages());
    renderHook(() => useConflictStages({ commands, workspace: WS, filePath: 'src/a.ts' }));
    await waitFor(() => expect(getConflictStages).toHaveBeenCalledTimes(1));

    getConflictStages.mockResolvedValueOnce(stages());
    act(() => {
      for (const cb of gitRefreshCallbacks) cb('p1');
    });
    await waitFor(() => expect(getConflictStages).toHaveBeenCalledTimes(2));
  });

  it('an err clears a previously loaded conflict view (resolved → converge)', async () => {
    getConflictStages.mockResolvedValueOnce(stages());
    const { result } = renderHook(() =>
      useConflictStages({ commands, workspace: WS, filePath: 'src/a.ts' }),
    );
    await waitFor(() => expect(result.current.stages).not.toBeNull());

    getConflictStages.mockRejectedValueOnce('not conflicted');
    act(() => {
      for (const cb of statusSnapshotListeners) cb({ payload: { project_id: 'p1' } });
    });
    await waitFor(() => expect(result.current.notConflicted).toBe(true));
    expect(result.current.stages).toBeNull();
  });
});
