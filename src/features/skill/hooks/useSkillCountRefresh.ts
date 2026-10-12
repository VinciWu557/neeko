import { useEffect, useMemo } from 'react';

import { useSkillStore } from '@/features/skill/store';
import { useProjectStore } from '@/shared/store/projectStore';

import { notifySkills } from '../utils/skillNotify';

/**
 * Skill 计数刷新 —— Skills 左栏与 MCP 左栏共用一份实现。
 *
 * 两栏都渲染 skill-store 的计数数据（agent 技能数 / project 技能数 / tag group 绑定数），
 * 此前各持一份逐行重复的 effect（MCP 侧副本连 projectsKey 派生都相同）。刷新实现与
 * 错误通知收敛于此：标题统一为 Skills（错误数据即 skill-store 数据），改动只有一处。
 *
 * 时序：在面板组件内调用 —— 随面板挂载 / 项目列表变化触发，
 * 不随 NavSection 折叠/展开而挂载卸载。
 */
export function useSkillCountRefresh(): void {
  const projects = useProjectStore((s) => s.projects);
  const refreshAgentSkills = useSkillStore((s) => s.refreshAgentSkills);
  const refreshProjectSkillCounts = useSkillStore((s) => s.refreshProjectSkillCounts);
  const refreshProjectTagGroupCounts = useSkillStore((s) => s.refreshProjectTagGroupCounts);

  const projectsKey = useMemo(
    () => projects.map((project) => `${project.id}:${project.path}`).join('\n'),
    [projects],
  );

  // Left-rail counts: agents once on mount; project counts when project list changes.
  useEffect(() => {
    void refreshAgentSkills().catch((e) => {
      notifySkills(`Failed to load agent skill counts: ${String(e)}`, 'error');
    });
  }, [refreshAgentSkills]);

  useEffect(() => {
    void refreshProjectSkillCounts().catch((e) => {
      notifySkills(`Failed to load project skill counts: ${String(e)}`, 'error');
    });
    void refreshProjectTagGroupCounts().catch((e) => {
      notifySkills(`Failed to load project tag group counts: ${String(e)}`, 'error');
    });
  }, [projectsKey, refreshProjectSkillCounts, refreshProjectTagGroupCounts]);
}
