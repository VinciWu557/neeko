import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as searchApi from '@/features/search/api/searchApi';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { useSearch } from '../useSearch';

/** 测试用地址（主仓）；与 `useSearch` 的入参形态一致。 */
const WS = WorkspaceSession.of('p-1', null);

vi.mock('@/features/search/api/searchApi', async () => {
  const actual = await vi.importActual<typeof searchApi>('@/features/search/api/searchApi');
  return {
    ...actual,
    runSearch: vi.fn(),
    stopSearch: vi.fn(),
  };
});

const runMock = vi.mocked(searchApi.runSearch);
const stopMock = vi.mocked(searchApi.stopSearch);

function mockPage(requestId = 'req-1') {
  return {
    requestId,
    query: 'foo',
    projectId: 'p-1',
    matches: [],
    cursor: { offset: 0, totalPages: 1 },
    truncated: false,
  };
}

describe('useSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runMock.mockResolvedValue(mockPage());
    stopMock.mockResolvedValue(undefined);
  });

  it('防抖：输入停顿 300ms 后才触发搜索', async () => {
    const { result } = renderHook(() => useSearch(WS));

    act(() => result.current.setQuery('foo'));
    expect(runMock).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 320));
    });
    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: WS,
        query: 'foo',
        options: { mode: 'Content' },
        offset: 0,
        limit: 100,
      }),
    );
  });

  it('空 query 不触发搜索', async () => {
    const { result } = renderHook(() => useSearch(WS));

    act(() => result.current.setQuery('   '));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    expect(runMock).not.toHaveBeenCalled();
  });

  it('无 project 时不触发搜索', async () => {
    const { result } = renderHook(() => useSearch(null));

    act(() => result.current.setQuery('foo'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    expect(runMock).not.toHaveBeenCalled();
  });

  it('卸载时取消进行中的搜索', async () => {
    const { result, unmount } = renderHook(() => useSearch(WS));

    act(() => result.current.setQuery('foo'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320));
    });

    unmount();
    expect(stopMock).toHaveBeenCalled();
  });

  it('worktree 地址原样透传后端（搜索结果基准 = 该单元根）', async () => {
    const wt = WorkspaceSession.of('p-1', '/repo/.worktrees/dev');
    const { result } = renderHook(() => useSearch(wt));

    act(() => result.current.setQuery('foo'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320));
    });

    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
    // 回归钉：曾经传裸 projectId（后端直取 project.path）⇒ worktree 视图扫到主仓，
    // 且结果相对主仓根、点击打开却相对单元根解析（两种基准）。
    expect(runMock.mock.calls[0][0].workspace).toBe(wt);
  });

  it('切换单元时丢掉上一个单元的搜索结果（基准已变）', async () => {
    const wtA = WorkspaceSession.of('p-1', '/repo/.worktrees/a');
    const wtB = WorkspaceSession.of('p-1', '/repo/.worktrees/b');
    const { result, rerender } = renderHook(({ ws }: { ws: WorkspaceSession }) => useSearch(ws), {
      initialProps: { ws: wtA },
    });

    act(() => result.current.setQuery('foo'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 320));
    });
    expect(result.current.committed).toBe('foo');

    rerender({ ws: wtB });
    // 结果、查询与已提交状态一并归零：旧结果里混着旧根的相对路径。
    await waitFor(() => expect(result.current.committed).toBe(''));
    expect(result.current.query).toBe('');
    expect(result.current.fileGroups).toEqual([]);
  });

  /**
   * 回归钉（重渲染风暴饿死）：防抖 effect 必须依赖**原始值** `workspace.key`，
   * 不得依赖 `workspace` 对象本身 —— 调用方每次渲染新建 `WorkspaceSession`
   * （如渲染期调命令式 `activeWorkspaceSession`）会不断重置 300ms 窗口，
   * 搜索结果永远发不出去（已在实现前用风暴用例实测复现）。
   */
  it('重渲染风暴中防抖仍会触发（依赖原始 key 而非对象身份）', async () => {
    const { result, rerender } = renderHook(
      ({ ws }: { ws: WorkspaceSession }) => useSearch(ws),
      // 每次渲染传入**新建的**同身份对象（模拟不稳定的 workspace 引用）
      { initialProps: { ws: WorkspaceSession.of('p-1', null) } },
    );

    act(() => result.current.setQuery('foo'));
    // 1.2s 内每 60ms 重渲一次（对象每次都是新的），始终没有 300ms 静默窗口
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      rerender({ ws: WorkspaceSession.of('p-1', null) });
    }

    expect(runMock).toHaveBeenCalledTimes(1);
  });
});
