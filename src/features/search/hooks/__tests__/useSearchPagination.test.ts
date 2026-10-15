import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as searchApi from '@/features/search/api/searchApi';
import { resetSearchState, useSearchStore } from '@/features/search/store/searchStore';
import type { SearchFileGroup } from '@/shared/types/search';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { useSearchPagination } from '../useSearchPagination';

vi.mock('@/features/search/api/searchApi', async () => {
  const actual = await vi.importActual<typeof searchApi>('@/features/search/api/searchApi');
  return { ...actual, runSearch: vi.fn(), stopSearch: vi.fn() };
});

const runMock = vi.mocked(searchApi.runSearch);

/** 测试用地址（主仓）。 */
const WS = WorkspaceSession.of('p-1', null);

/** 后端一页的返回值（`truncated: false` + offset 前进 ⇒ `hasMore` 保持为真）。 */
function page() {
  return {
    requestId: 'req-x',
    query: 'foo',
    matches: [] as SearchFileGroup[],
    cursor: { offset: 20, totalPages: -1 },
    truncated: false,
  };
}

/**
 * 伪造滚动容器：`clientHeight` / `scrollHeight` 在 jsdom 里是只读的 0，
 * 按仓库既有写法直接结构体转型（见 `useVirtualScroll.test.ts`）。
 */
function listRef(metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }) {
  return {
    current: metrics as unknown as HTMLDivElement,
  } as React.RefObject<HTMLDivElement | null>;
}

/** 让 store 处于「已有一页结果、可继续翻页」的状态。 */
function seedPaged() {
  useSearchStore.setState({ query: 'foo', status: 'idle', offset: 10, truncated: false });
}

describe('useSearchPagination —— 搜索触底分页（SearchPanel 的容器逻辑）', () => {
  beforeEach(() => {
    resetSearchState();
    runMock.mockReset().mockResolvedValue(page());
  });

  it('触底（距底 ≤48px）取下一页，且带的是**当前单元的地址**', async () => {
    seedPaged();
    const ref = listRef({ scrollTop: 100, clientHeight: 100, scrollHeight: 200 }); // 200 ≥ 152
    const { result } = renderHook(() =>
      useSearchPagination({ workspace: WS, groups: [], listRef: ref }),
    );

    await act(async () => {
      result.current.handleScroll();
    });

    expect(runMock).toHaveBeenCalledWith(expect.objectContaining({ workspace: WS }));
  });

  it('未触底不取下一页', async () => {
    seedPaged();
    const ref = listRef({ scrollTop: 0, clientHeight: 50, scrollHeight: 300 }); // 50 < 252
    const { result } = renderHook(() =>
      useSearchPagination({ workspace: WS, groups: [], listRef: ref }),
    );

    await act(async () => {
      result.current.handleScroll();
    });

    expect(runMock).not.toHaveBeenCalled();
  });

  it('无激活单元（workspace=null）时触底是空操作', async () => {
    seedPaged();
    const ref = listRef({ scrollTop: 100, clientHeight: 100, scrollHeight: 200 });
    const { result } = renderHook(() =>
      useSearchPagination({ workspace: null, groups: [], listRef: ref }),
    );

    await act(async () => {
      result.current.handleScroll();
    });

    expect(runMock).not.toHaveBeenCalled();
  });

  it('结果撑不满视口时自动补一页，且**只补一次**（autoLoaded 闸门）', async () => {
    seedPaged();
    const ref = listRef({ scrollTop: 0, clientHeight: 100, scrollHeight: 50 }); // 短于视口
    const { rerender } = renderHook(
      ({ groups }: { groups: SearchFileGroup[] }) =>
        useSearchPagination({ workspace: WS, groups, listRef: ref }),
      { initialProps: { groups: [] as SearchFileGroup[] } },
    );

    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));

    // 结果分组变化会让 effect 重跑；闸门必须挡住第二次自动补页。
    rerender({ groups: [{ path: 'src/a.ts', matches: [] }] });

    await act(async () => {});
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it('列表长于视口时不自动补页（交由用户滚动触发）', async () => {
    seedPaged();
    const ref = listRef({ scrollTop: 0, clientHeight: 100, scrollHeight: 400 });
    renderHook(() => useSearchPagination({ workspace: WS, groups: [], listRef: ref }));

    await act(async () => {});
    expect(runMock).not.toHaveBeenCalled();
  });

  it('无可翻页（offset=0 / 已 truncated）时不自动补页', async () => {
    useSearchStore.setState({ query: 'foo', status: 'idle', offset: 0, truncated: true });
    const ref = listRef({ scrollTop: 0, clientHeight: 100, scrollHeight: 50 });
    renderHook(() => useSearchPagination({ workspace: WS, groups: [], listRef: ref }));

    await act(async () => {});
    expect(runMock).not.toHaveBeenCalled();
  });
});
