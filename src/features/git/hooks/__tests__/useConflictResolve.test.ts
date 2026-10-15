import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ProjectCommands } from '@/shared/types/project';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { useConflictResolve } from '../useConflictResolve';

const WS = WorkspaceSession.of('p1', null);

function makeCommands(resolveConflict: ReturnType<typeof vi.fn>) {
  return { resolveConflict } as unknown as ProjectCommands;
}

describe('useConflictResolve — 决议草稿状态模型', () => {
  it('区域决议与整文件决议互斥', () => {
    const commands = makeCommands(vi.fn());
    const { result } = renderHook(() =>
      useConflictResolve({ commands, workspace: WS, filePath: 'f.txt' }),
    );

    act(() => result.current.selectRegion(0, 'ours'));
    expect(result.current.regions.get(0)).toBe('ours');
    expect(result.current.wholeFile).toBeNull();

    // 选整文件 → 清空区域草稿
    act(() => result.current.selectWholeFile('theirs'));
    expect(result.current.wholeFile).toBe('theirs');
    expect(result.current.regions.size).toBe(0);

    // 再选区域 → 清空整文件草稿
    act(() => result.current.selectRegion(1, 'both'));
    expect(result.current.wholeFile).toBeNull();
    expect(result.current.regions.get(1)).toBe('both');
  });

  it('canApply 区域决议需覆盖全部区域；整文件只需选一侧', () => {
    const commands = makeCommands(vi.fn());
    const { result } = renderHook(() =>
      useConflictResolve({ commands, workspace: WS, filePath: 'f.txt', regionCount: 2 }),
    );
    expect(result.current.canApply).toBe(false);
    act(() => result.current.selectRegion(0, 'theirs'));
    expect(result.current.canApply).toBe(false); // 只决议 1/2
    expect(result.current.undecidedCount).toBe(1);
    act(() => result.current.selectRegion(1, 'ours'));
    expect(result.current.canApply).toBe(true); // 2/2
    expect(result.current.undecidedCount).toBe(0);
  });

  it('整文件决议不受 regionCount 限制（选中即 canApply）', () => {
    const commands = makeCommands(vi.fn());
    const { result } = renderHook(() =>
      useConflictResolve({ commands, workspace: WS, filePath: 'f.txt', regionCount: 3 }),
    );
    act(() => result.current.selectWholeFile('ours'));
    expect(result.current.canApply).toBe(true);
  });

  it('apply 提交整文件决议（wire 形态 kind=whole_file）并在成功后清空草稿 + onResolved', async () => {
    const resolveConflict = vi.fn().mockResolvedValue(undefined);
    const onResolved = vi.fn();
    const commands = makeCommands(resolveConflict);
    const { result } = renderHook(() =>
      useConflictResolve({ commands, workspace: WS, filePath: 'f.txt', onResolved }),
    );

    act(() => result.current.selectWholeFile('theirs'));
    await act(async () => {
      await result.current.apply();
    });

    expect(resolveConflict).toHaveBeenCalledWith('f.txt', {
      kind: 'whole_file',
      take: 'theirs',
    });
    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(result.current.wholeFile).toBeNull();
    expect(result.current.canApply).toBe(false);
  });

  it('apply 提交区域决议（decisions 为 [id, take] 元组数组）', async () => {
    const resolveConflict = vi.fn().mockResolvedValue(undefined);
    const commands = makeCommands(resolveConflict);
    const { result } = renderHook(() =>
      useConflictResolve({ commands, workspace: WS, filePath: 'f.txt', regionCount: 2 }),
    );

    act(() => result.current.selectRegion(0, 'ours'));
    act(() => result.current.selectRegion(2, 'both'));
    await act(async () => {
      await result.current.apply();
    });

    expect(resolveConflict).toHaveBeenCalledWith('f.txt', {
      kind: 'regions',
      decisions: [
        [0, 'ours'],
        [2, 'both'],
      ],
    });
  });

  it('区域未覆盖全部时 apply 是 no-op（不提交半截决议）', async () => {
    const resolveConflict = vi.fn();
    const commands = makeCommands(resolveConflict);
    const { result } = renderHook(() =>
      useConflictResolve({ commands, workspace: WS, filePath: 'f.txt', regionCount: 2 }),
    );
    act(() => result.current.selectRegion(0, 'ours'));
    await act(async () => {
      await result.current.apply();
    });
    expect(resolveConflict).not.toHaveBeenCalled();
  });

  it('apply 失败 → 保留草稿（可重试）+ 上报错误，不静默', async () => {
    const resolveConflict = vi.fn().mockRejectedValue('boom');
    const onShowToast = vi.fn();
    const onResolved = vi.fn();
    const commands = makeCommands(resolveConflict);
    const { result } = renderHook(() =>
      useConflictResolve({ commands, workspace: WS, filePath: 'f.txt', onResolved, onShowToast }),
    );

    act(() => result.current.selectWholeFile('ours'));
    await act(async () => {
      await result.current.apply();
    });

    expect(onShowToast).toHaveBeenCalledWith('boom', 'error');
    expect(onResolved).not.toHaveBeenCalled();
    // 草稿保留 → 用户可重试
    expect(result.current.wholeFile).toBe('ours');
    expect(result.current.pending).toBe(false);
  });

  it('空草稿 apply 是 no-op（不调用命令）', async () => {
    const resolveConflict = vi.fn();
    const commands = makeCommands(resolveConflict);
    const { result } = renderHook(() =>
      useConflictResolve({ commands, workspace: WS, filePath: 'f.txt' }),
    );
    await act(async () => {
      await result.current.apply();
    });
    expect(resolveConflict).not.toHaveBeenCalled();
  });
});
