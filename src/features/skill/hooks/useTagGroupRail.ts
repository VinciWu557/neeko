import { useCallback, useMemo, useState } from 'react';

import { useSkillStore } from '@/features/skill/store';
import { useTagGroupCrud } from '@/shared/hooks/useTagGroupCrud';

import { notifySkills } from '../utils/skillNotify';

/**
 * Skills 左栏 Tags 的交互（从 SkillsPanel 抽出）。
 *
 * 组合：共享的 `useTagGroupCrud`（草稿状态 + CRUD + 智能确认，与 MCP 左栏同源）
 * + Skills 侧独有能力：多选选择模型与「同步到 agents」。
 *
 * 状态留在 hooks 层而非区块组件内：NavSection 折叠时不渲染 children，
 * 草稿（新建名 / 重命名值）不随折叠丢失。
 */
export function useTagGroupRail() {
  const tagGroups = useSkillStore((s) => s.tagGroups);
  const activeTagGroupIds = useSkillStore((s) => s.activeTagGroupIds);
  const setActiveTagGroupIds = useSkillStore((s) => s.setActiveTagGroupIds);
  const setActiveSkillView = useSkillStore((s) => s.setActiveSkillView);
  const setActiveAgentId = useSkillStore((s) => s.setActiveAgentId);
  const deleteTagGroup = useSkillStore((s) => s.deleteTagGroup);
  const updateTagGroup = useSkillStore((s) => s.updateTagGroup);
  const createTagGroup = useSkillStore((s) => s.createTagGroup);
  const syncTagGroup = useSkillStore((s) => s.syncTagGroup);

  const [syncingId, setSyncingId] = useState<string | null>(null);

  // 入口归一：count = 磁盘 skill 数，共享 CRUD 的智能确认即 count > 0。
  const railGroups = useMemo(
    () => tagGroups.map((g) => ({ id: g.id, name: g.name, count: g.skill_count })),
    [tagGroups],
  );

  const crud = useTagGroupCrud({
    items: railGroups,
    create: createTagGroup,
    rename: updateTagGroup,
    remove: deleteTagGroup,
    notify: notifySkills,
  });

  const handleTagGroupSelect = useCallback(
    (id: string) => {
      const wasActive = activeTagGroupIds.includes(id);
      setActiveTagGroupIds(wasActive ? [] : [id]);
      setActiveSkillView('local');
      setActiveAgentId(null);
    },
    [activeTagGroupIds, setActiveTagGroupIds, setActiveSkillView, setActiveAgentId],
  );

  const handleSync = useCallback(
    async (id: string, name: string) => {
      setSyncingId(id);
      try {
        await syncTagGroup(id);
        notifySkills(`Synced "${name}" to agents`);
      } catch (err) {
        notifySkills(`Failed to sync tag group: ${String(err)}`, 'error');
      } finally {
        setSyncingId(null);
      }
    },
    [syncTagGroup],
  );

  return { crud, railGroups, syncingId, handleSync, handleTagGroupSelect };
}
