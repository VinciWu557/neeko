import React, { useCallback, useMemo } from 'react';

import { useMcpStore } from '@/features/library/store/mcpStore';
import TagGroupRail from '@/shared/components/nav/TagGroupRail';
import { useNotify } from '@/shared/hooks/useNotify';
import { useTagGroupCrud } from '@/shared/hooks/useTagGroupCrud';

/**
 * MCP 导航面板的 Tags 区块。
 * CRUD 走共享的 `useTagGroupCrud` + `TagGroupRail`（与 Skills 左栏同源）；
 * 本侧只贡献差异数据：单值选择模型、空态/确认文案，且不提供同步能力（MCP 无 sync 概念）。
 */

/** 删除确认正文（MCP 侧文案，无成员数插值）——模块级常量，保持 props 引用稳定。 */
const describeMcpTagDelete = () => (
  <p className="text-sm text-text-secondary">
    Are you sure you want to delete this tag group? Servers in the group will not be deleted.
  </p>
);

const McpTagGroupTree: React.FC = React.memo(() => {
  const mcpTagGroups = useMcpStore((s) => s.mcpTagGroups);
  const activeMcpTagGroup = useMcpStore((s) => s.activeMcpTagGroup);
  const setActiveMcpTagGroup = useMcpStore((s) => s.setActiveMcpTagGroup);
  const setMcpView = useMcpStore((s) => s.setMcpView);
  const createMcpTagGroup = useMcpStore((s) => s.createMcpTagGroup);
  const updateMcpTagGroup = useMcpStore((s) => s.updateMcpTagGroup);
  const deleteMcpTagGroup = useMcpStore((s) => s.deleteMcpTagGroup);

  const { notify } = useNotify();

  // 入口归一：count = server 数，共享 CRUD 的智能确认即 count > 0。
  const railGroups = useMemo(
    () => mcpTagGroups.map((g) => ({ id: g.id, name: g.name, count: g.serverCount })),
    [mcpTagGroups],
  );

  const create = useCallback(
    async (name: string) => {
      await createMcpTagGroup({ name });
    },
    [createMcpTagGroup],
  );
  const rename = useCallback(
    async (id: string, name: string) => {
      await updateMcpTagGroup(id, { name });
    },
    [updateMcpTagGroup],
  );

  const crud = useTagGroupCrud({
    items: railGroups,
    create,
    rename,
    remove: deleteMcpTagGroup,
    notify,
  });

  const handleSelect = useCallback(
    (id: string) => {
      setActiveMcpTagGroup(activeMcpTagGroup === id ? null : id);
      setMcpView('installed');
    },
    [activeMcpTagGroup, setActiveMcpTagGroup, setMcpView],
  );

  return (
    <TagGroupRail
      crud={crud}
      groups={railGroups}
      activeIds={activeMcpTagGroup ? [activeMcpTagGroup] : []}
      onSelect={handleSelect}
      emptyText="Group servers by role (Backend, Frontend...)"
      confirmTitle="Delete Tag Group"
      describeDelete={describeMcpTagDelete}
    />
  );
});

McpTagGroupTree.displayName = 'McpTagGroupTree';

export default McpTagGroupTree;
