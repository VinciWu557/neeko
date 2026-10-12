import { useCallback, useState } from 'react';

import { useDeleteConfirm } from './useDeleteConfirm';

/**
 * Tag group CRUD 状态机（Skills 左栏与 MCP 左栏共用）。
 *
 * 此前两侧各持一份实现且四项行为分歧，此处统一取 Skills 侧的富变体：
 * - **智能确认**：仅当分组仍有成员（`count > 0`）时弹确认框；空分组直接删除；
 * - **成功/失败均有通知**；错误文案带操作前缀（`Failed to create/rename/delete tag group:`）；
 * - **重命名未变化短路**：值没变（或为空）直接收起输入，不调 store；
 * - 创建成功后收起输入（草稿清空）。
 *
 * 依赖注入（skill → useSkillStore；MCP → useMcpStore），
 * 选择模型（多选数组 vs 单值）与同步能力不属于 CRUD，留在各侧组合层。
 */
export interface TagGroupCrudItem {
  id: string;
  name: string;
  /** 组内成员数：> 0 触发删除确认（两侧语义相同：skill 数 / server 数）。 */
  count: number;
}

export interface TagGroupCrudDeps {
  items: readonly TagGroupCrudItem[];
  create: (name: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** 通知出口：Skills 侧用 notifySkills（title=Skills），MCP 侧用 useNotify。 */
  notify: (message: string, type?: 'info' | 'error') => void;
}

/** 智能确认门槛：仍有成员的分组才弹确认框（模块级常量，保持引用稳定）。 */
const tagGroupHasMembers = (item: TagGroupCrudItem): boolean => item.count > 0;

export interface TagGroupCrud {
  creating: boolean;
  newName: string;
  renamingId: string | null;
  renameValue: string;
  /** 待确认删除的分组（按键解析自 items；null = 无待确认弹框）。 */
  pendingDelete: TagGroupCrudItem | null;
  startCreate: () => void;
  cancelCreate: () => void;
  setNewName: (value: string) => void;
  submitCreate: () => Promise<void>;
  startRename: (item: TagGroupCrudItem) => void;
  setRenameValue: (value: string) => void;
  /**
   * 提交重命名：值由受控输入在调用点显式传入（与草稿状态解耦 → 处理器身份稳定，
   * 供行组件 memo 生效）；空值或未变化时短路收起输入。
   */
  submitRename: (id: string, value: string) => Promise<void>;
  cancelRename: () => void;
  requestDelete: (id: string) => void;
  confirmDelete: () => void;
  cancelDelete: () => void;
}

export function useTagGroupCrud(deps: TagGroupCrudDeps): TagGroupCrud {
  const { items, create, rename, remove, notify } = deps;

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const startCreate = useCallback(() => setCreating(true), []);

  const cancelCreate = useCallback(() => {
    setCreating(false);
    setNewName('');
  }, []);

  const submitCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await create(name);
      setNewName('');
      setCreating(false);
      notify(`Created tag group "${name}"`);
    } catch (e) {
      notify(`Failed to create tag group: ${String(e)}`, 'error');
    }
  }, [newName, create, notify]);

  const startRename = useCallback((item: TagGroupCrudItem) => {
    setRenamingId(item.id);
    setRenameValue(item.name);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameValue('');
  }, []);

  const submitRename = useCallback(
    async (id: string, value: string) => {
      const name = value.trim();
      const current = items.find((item) => item.id === id);
      if (!name || name === current?.name) {
        setRenamingId(null);
        return;
      }
      try {
        await rename(id, name);
        setRenamingId(null);
        notify(`Renamed to "${name}"`);
      } catch (e) {
        notify(`Failed to rename tag group: ${String(e)}`, 'error');
      }
    },
    // 不依赖 renameValue：处理器身份与草稿解耦（行组件 memo 生效的前提），
    // 草稿值由受控输入在调用点显式传入。
    [items, rename, notify],
  );

  // 删除记账走共享状态机（与 prompts / MCP servers 同一实现）；
  // 智能确认：仍有成员（count > 0）才弹框，空分组直接删。
  const del = useDeleteConfirm<TagGroupCrudItem>({
    items,
    remove,
    notify,
    entityLabel: 'tag group',
    needsConfirm: tagGroupHasMembers,
  });

  return {
    creating,
    newName,
    renamingId,
    renameValue,
    pendingDelete: del.pending,
    startCreate,
    cancelCreate,
    setNewName,
    submitCreate,
    startRename,
    setRenameValue,
    submitRename,
    cancelRename,
    requestDelete: del.request,
    confirmDelete: del.confirm,
    cancelDelete: del.cancel,
  };
}
