import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useWorktreeRowState } from '@/shared/hooks/useWorktreeRowState';

const WT = '/repo/.worktrees/dev';

/** 造一个 `React.MouseEvent` 只需 `stopPropagation`（hook 只用这一个成员）。 */
function fakeEvent() {
  return { stopPropagation: vi.fn() } as unknown as React.MouseEvent;
}

describe('useWorktreeRowState — worktree 行交互状态机（本地/WSL/SSH 共用的唯一实现）', () => {
  describe('重命名', () => {
    it('startRename 以路径末段预填，并广播 stopPropagation（不冒泡成选中行）', () => {
      const { result } = renderHook(() => useWorktreeRowState(vi.fn(), vi.fn()));
      const e = fakeEvent();
      act(() => result.current.startRename(WT, e));
      expect(e.stopPropagation).toHaveBeenCalled();
      expect(result.current.renaming).toBe(WT);
      expect(result.current.renameValue).toBe('dev');
    });

    it('commitRename 把「新目录名」交给 onRename（不是全路径）', () => {
      const onRename = vi.fn();
      const { result } = renderHook(() => useWorktreeRowState(onRename, vi.fn()));
      act(() => result.current.startRename(WT, fakeEvent()));
      act(() => result.current.setRenameValue('renamed'));
      act(() => result.current.commitRename());
      expect(onRename).toHaveBeenCalledWith(WT, 'renamed');
      expect(result.current.renaming).toBeNull();
    });

    it('改名空操作的两条路都不触发 onRename：名字未变 / 名字为空', () => {
      const onRename = vi.fn();
      const { result } = renderHook(() => useWorktreeRowState(onRename, vi.fn()));

      // 名字未变（等于当前末段）
      act(() => result.current.startRename(WT, fakeEvent()));
      act(() => result.current.commitRename());
      expect(onRename).not.toHaveBeenCalled();

      // 名字为空白
      act(() => result.current.startRename(WT, fakeEvent()));
      act(() => result.current.setRenameValue('   '));
      act(() => result.current.commitRename());
      expect(onRename).not.toHaveBeenCalled();
    });

    it('cancelRename 清空编辑态，不触发 onRename', () => {
      const onRename = vi.fn();
      const { result } = renderHook(() => useWorktreeRowState(onRename, vi.fn()));
      act(() => result.current.startRename(WT, fakeEvent()));
      act(() => result.current.cancelRename());
      expect(result.current.renaming).toBeNull();
      expect(result.current.renameValue).toBe('');
      expect(onRename).not.toHaveBeenCalled();
    });
  });

  describe('删除确认', () => {
    it('无 onCheckDirty 时直接按「不脏」弹确认（不调任何 async）', async () => {
      const { result } = renderHook(() => useWorktreeRowState(vi.fn(), vi.fn()));
      await act(async () => {
        await result.current.handleRemove(WT, 'dev', fakeEvent());
      });
      expect(result.current.confirmDelete).toEqual({ path: WT, branch: 'dev', isDirty: false });
    });

    it('有 onCheckDirty 时按返回值标脏', async () => {
      const { result } = renderHook(() =>
        useWorktreeRowState(vi.fn(), vi.fn(), () => Promise.resolve(true)),
      );
      await act(async () => {
        await result.current.handleRemove(WT, 'dev', fakeEvent());
      });
      expect(result.current.confirmDelete).toMatchObject({ isDirty: true });
    });

    it('脏检查抛错 → 降级为「不脏」仍可弹确认（不阻断删除流程）', async () => {
      const { result } = renderHook(() =>
        useWorktreeRowState(vi.fn(), vi.fn(), () => Promise.reject(new Error('boom'))),
      );
      await act(async () => {
        await result.current.handleRemove(WT, 'dev', fakeEvent());
      });
      expect(result.current.confirmDelete).toMatchObject({ isDirty: false });
    });

    it('confirmRemove 关弹窗 + 置删除态 + 调 onRemove，成功后立即收尾（delay=0）', async () => {
      const onRemove = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useWorktreeRowState(vi.fn(), onRemove));
      await act(async () => {
        await result.current.handleRemove(WT, 'dev', fakeEvent());
      });
      await act(async () => {
        await result.current.confirmRemove(WT, 'dev');
      });
      expect(onRemove).toHaveBeenCalledWith(WT, 'dev');
      expect(result.current.confirmDelete).toBeNull();
      expect(result.current.deleting).toBeNull();
    });

    it('远端形态（delay>0）：删除成功后 spinner 保留到延迟结束才清', async () => {
      vi.useFakeTimers();
      try {
        const onRemove = vi.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() => useWorktreeRowState(vi.fn(), onRemove, undefined, 800));

        await act(async () => {
          await result.current.confirmRemove(WT, 'dev');
        });
        // 延迟未到：仍在删除态（掩盖父级异步刷新窗口，避免行「闪回」）
        expect(result.current.deleting).toBe(WT);

        await act(async () => {
          vi.advanceTimersByTime(800);
        });
        expect(result.current.deleting).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('onRemove 拒绝也不把 spinner 永久卡住（finally 收尾）', async () => {
      const onRemove = vi.fn().mockRejectedValue(new Error('failed'));
      const { result } = renderHook(() => useWorktreeRowState(vi.fn(), onRemove));

      await act(async () => {
        await result.current.confirmRemove(WT, 'dev');
      });
      // 域侧自行处理失败（本地弹 toast / 远端 console.error），状态机只保证收尾。
      await waitFor(() => expect(result.current.deleting).toBeNull());
    });

    it('dismissConfirmDelete 关弹窗', async () => {
      const { result } = renderHook(() => useWorktreeRowState(vi.fn(), vi.fn()));
      await act(async () => {
        await result.current.handleRemove(WT, 'dev', fakeEvent());
      });
      act(() => result.current.dismissConfirmDelete());
      expect(result.current.confirmDelete).toBeNull();
    });
  });
});
