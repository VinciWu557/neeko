// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

import * as searchApi from '@/features/search/api/searchApi';
import type { SearchResponse } from '@/shared/types/search';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { useSearchStore, resetSearchState } from '../searchStore';

/** 测试用地址：主仓（`worktreePath = null`）—— 与 `run`/`next` 的入参形态一致。 */
const WS = WorkspaceSession.of('p-1', null);

function makeResponse(overrides: Partial<SearchResponse> = {}): SearchResponse {
  return {
    requestId: 'req-1',
    query: 'foo',
    projectId: 'p-1',
    matches: [
      {
        path: 'src/a.rs',
        matches: [{ path: 'src/a.rs', line: 3, column: 1, lineText: 'foo bar' }],
      },
    ],
    cursor: { offset: 10, totalPages: -1 },
    truncated: false,
    ...overrides,
  };
}

describe('searchStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSearchState();
  });

  it('run: fresh start writes results and cursor', async () => {
    vi.spyOn(searchApi, 'runSearch').mockResolvedValue(makeResponse());

    await useSearchStore.getState().run(WS, 'foo', { regex: false });

    const s = useSearchStore.getState();
    expect(s.requestId).toBe('req-1');
    expect(s.fileGroups).toHaveLength(1);
    expect(s.fileGroups[0].matches[0].lineText).toBe('foo bar');
    expect(s.offset).toBe(10);
    expect(s.status).toBe('idle');
    expect(s.query).toBe('foo');
  });

  it('run: sends options with a default mode so the backend can deserialize', async () => {
    const runSpy = vi.spyOn(searchApi, 'runSearch').mockResolvedValue(makeResponse());

    await useSearchStore.getState().run(WS, 'foo', {});

    const arg = runSpy.mock.calls[0][0];
    expect(arg.options).toBeDefined();
    expect(arg.options.mode).toBe('Content');
  });

  it('next: pagination appends without overwriting', async () => {
    const page1 = makeResponse({ cursor: { offset: 1, totalPages: -1 } });
    const page2 = makeResponse({
      requestId: 'req-2',
      matches: [
        { path: 'src/b.rs', matches: [{ path: 'src/b.rs', line: 9, column: 0, lineText: 'zzz' }] },
      ],
      cursor: { offset: 2, totalPages: -1 },
    });
    vi.spyOn(searchApi, 'runSearch').mockResolvedValueOnce(page1).mockResolvedValueOnce(page2);

    await useSearchStore.getState().run(WS, 'foo', {});
    await useSearchStore.getState().next(WS);

    const s = useSearchStore.getState();
    expect(s.fileGroups.map((f) => f.path)).toEqual(['src/a.rs', 'src/b.rs']);
    expect(s.offset).toBe(2);
  });

  it('same query repeated run clears old results', async () => {
    const page1 = makeResponse();
    vi.spyOn(searchApi, 'runSearch')
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(makeResponse({ requestId: 'req-2', matches: [] }));
    await useSearchStore.getState().run(WS, 'foo', {});
    await useSearchStore.getState().run(WS, 'foo', {});

    expect(useSearchStore.getState().fileGroups).toHaveLength(0);
  });

  it('switching query resets pagination', async () => {
    const runSpy = vi.spyOn(searchApi, 'runSearch').mockResolvedValue(makeResponse());

    await useSearchStore.getState().run(WS, 'aaa', {});
    await useSearchStore.getState().run(WS, 'bbb', {});

    expect(runSpy).toHaveBeenCalledTimes(2);
    // Second call should start from offset 0.
    expect(runSpy.mock.calls[1][0].offset).toBe(0);
  });

  it('run failure: enters error state', async () => {
    vi.spyOn(searchApi, 'runSearch').mockRejectedValue(new Error('boom'));

    await useSearchStore.getState().run(WS, 'foo', {});

    const s = useSearchStore.getState();
    expect(s.status).toBe('error');
    expect(s.error).toContain('boom');
  });

  it('stop: cancels in-flight search and calls backend', async () => {
    useSearchStore.setState({ requestId: 'req-live' });
    const stopSpy = vi.spyOn(searchApi, 'stopSearch').mockResolvedValue(undefined);

    await useSearchStore.getState().stop();

    expect(stopSpy).toHaveBeenCalledWith('req-live');
    expect(useSearchStore.getState().status).toBe('idle');
    expect(useSearchStore.getState().requestId).toBeNull();
  });

  it('clear: resets all state', () => {
    useSearchStore.setState({ fileGroups: [], query: 'foo', status: 'error' });
    useSearchStore.getState().clear();
    expect(useSearchStore.getState().query).toBe('');
    expect(useSearchStore.getState().status).toBe('idle');
    expect(useSearchStore.getState().fileGroups).toEqual([]);
  });

  /**
   * 回归钉（陈旧响应跨单元污染）：切单元后，旧单元的在飞响应迟到时**不得**写入 store。
   *
   * 两份结果的相对路径基于**不同根**（worktree A vs B），写进去就是把别的单元的文件
   * 当成本单元的事实。修法：`clear()` 不再重置 `requestCounter`（否则新请求重用旧 id，
   * 两个请求不可区分），且每次响应落地前用 `requestId` 做单射判定。
   */
  it('切单元后，旧单元的迟到响应被丢弃（不污染新单元结果）', async () => {
    const wtA = WorkspaceSession.of('p-1', '/wt/a');
    const wtB = WorkspaceSession.of('p-1', '/wt/b');
    let resolveA!: (v: unknown) => void;
    const pendingA = new Promise((r) => {
      resolveA = r as never;
    });

    vi.spyOn(searchApi, 'runSearch')
      .mockReturnValueOnce(pendingA as never)
      .mockResolvedValueOnce(
        makeResponse({
          requestId: 'req-b',
          matches: [],
        }),
      );

    const pending = useSearchStore.getState().run(wtA, 'foo', {});
    useSearchStore.getState().clear(); // 切单元
    await useSearchStore.getState().run(wtB, 'foo', {});

    // A 的响应此刻才到达
    resolveA(
      makeResponse({
        requestId: 'req-a',
        matches: [
          { path: 'FROM-OLD-ROOT.rs', matches: [{ path: 'x', line: 1, column: 1, lineText: '' }] },
        ],
      }),
    );
    await pending;

    expect(useSearchStore.getState().fileGroups.map((g) => g.path)).not.toContain(
      'FROM-OLD-ROOT.rs',
    );
  });
});
