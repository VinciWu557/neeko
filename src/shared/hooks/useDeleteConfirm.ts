import { useCallback, useState } from 'react';

/**
 * 删除确认状态机（列表项的「请求删除 → 弹框 → 确认 → 删除」）。
 *
 * 三处消费（prompts / MCP servers / tag groups）此前各自实现同一套
 * `pendingDeleteId` + `ConfirmDialog` 记账（其中 prompts 还在两个视图分支里逐字重复两份）；
 * 此处收敛为单一实现。文案由消费方注入（`entityLabel`），确认门槛可选：
 * 省略 = 总是确认；tag group 传 `count > 0`（空分组直接删除，不弹框）。
 */
export interface DeleteConfirmItem {
  id: string;
}

export interface UseDeleteConfirmDeps<T extends DeleteConfirmItem> {
  items: readonly T[];
  remove: (id: string) => Promise<void>;
  /** 通知出口（删除成功无通知；失败用带前缀的错误文案）。 */
  notify: (message: string, type?: 'info' | 'error') => void;
  /** 错误文案实体名：`Failed to delete ${entityLabel}: <cause>`。 */
  entityLabel: string;
  /** 确认门槛：返回 false 的条目直接删除（不弹框）；省略 = 总是确认。 */
  needsConfirm?: (item: T) => boolean;
}

export interface DeleteConfirm<T extends DeleteConfirmItem> {
  /** 待确认删除的条目（已解析自 items；null = 无弹框）。 */
  pending: T | null;
  request: (id: string) => void;
  confirm: () => void;
  cancel: () => void;
}

export function useDeleteConfirm<T extends DeleteConfirmItem>(
  deps: UseDeleteConfirmDeps<T>,
): DeleteConfirm<T> {
  const { items, remove, notify, entityLabel, needsConfirm } = deps;
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const removeById = useCallback(
    async (id: string) => {
      try {
        await remove(id);
      } catch (e) {
        notify(`Failed to delete ${entityLabel}: ${String(e)}`, 'error');
      }
    },
    [remove, notify, entityLabel],
  );

  const request = useCallback(
    (id: string) => {
      const item = items.find((i) => i.id === id);
      if (!item) return;
      if (needsConfirm && !needsConfirm(item)) {
        void removeById(id); // 低于门槛：直接删，不弹框
        return;
      }
      setPendingDeleteId(id);
    },
    [items, needsConfirm, removeById],
  );

  const confirm = useCallback(() => {
    if (!pendingDeleteId) return;
    const id = pendingDeleteId;
    // 先清 pending 再删：删除完成后 items 不再含该项，避免 pending 悬挂。
    setPendingDeleteId(null);
    void removeById(id);
  }, [pendingDeleteId, removeById]);

  const cancel = useCallback(() => setPendingDeleteId(null), []);

  const pending =
    (pendingDeleteId ? items.find((item) => item.id === pendingDeleteId) : undefined) ?? null;

  return { pending, request, confirm, cancel };
}
