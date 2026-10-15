import { useCallback, useEffect, useRef } from 'react';

import { useSearchStore } from '@/features/search/store/searchStore';
import type { SearchFileGroup } from '@/shared/types/search';
import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

interface UseSearchPaginationDeps {
  /** 搜索地址（`next` 要把它原样交给后端）。 */
  workspace: WorkspaceSession | null;
  /** 当前渲染的分组数组 —— 只作 effect 依赖，用于「列表变短后补一页」重判。 */
  groups: SearchFileGroup[];
  /** 结果滚动容器。 */
  listRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * 搜索结果列表的**滚动触底分页**（无限下拉）。
 *
 * **为什么单独成 hook**：`SearchPanel` 同时承担「输入框 + 结果渲染」与「触底取下一页」两件事，
 * 加几行就会越过 300 行组件红线；且分页是纯行为、与渲染无关，`src/AGENTS.md` 前端架构约定 5
 * 要求「页面容器逻辑下沉到 hooks」。抽取只迁移原逻辑与依赖，行为零漂移。
 *
 * **地址的读法**：effect 依赖挂**原始值** `workspaceKey`，需要对象时从 `workspaceRef` 读 ——
 * 否则调用方每次渲染新建 `WorkspaceSession` 会让触底判定反复重跑。与 `useSearch` 同一模式
 * （`.trellis/spec/frontend/hook-guidelines.md`「常见错误 5」），镜像 ref 在单个 effect 中同步
 * （`src/AGENTS.md` 前端架构约定 3）。
 */
export function useSearchPagination({ workspace, groups, listRef }: UseSearchPaginationDeps) {
  const next = useSearchStore((s) => s.next);
  const hasMore = useSearchStore((s) => !s.truncated && s.offset > 0);
  const cursorOffset = useSearchStore((s) => s.offset);

  const workspaceKey = workspace?.key ?? null;
  const workspaceRef = useRef(workspace);
  useEffect(() => {
    workspaceRef.current = workspace;
  }, [workspace]);

  const autoLoadedRef = useRef(false);

  /** 触底（距底 48px）取下一页。 */
  const handleScroll = useCallback(() => {
    const el = listRef.current;
    const ws = workspaceRef.current;
    if (!el || !ws) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 48) {
      void next(ws);
    }
  }, [listRef, next]);

  // 结果不足以撑满视口时自动补一页（长列表由 handleScroll 驱动）。
  useEffect(() => {
    const ws = workspaceRef.current;
    if (!hasMore || !ws) return;
    const el = listRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight) {
      if (!autoLoadedRef.current) {
        autoLoadedRef.current = true;
        void next(ws);
      }
    } else {
      autoLoadedRef.current = false;
    }
  }, [groups, hasMore, listRef, next, workspaceKey, cursorOffset]);

  return { handleScroll };
}
