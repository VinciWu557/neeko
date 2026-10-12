import { Download, Package } from 'lucide-react';
import React, { useCallback } from 'react';

import { AgentRailRow } from '@/features/agent';
import { useSkillStore } from '@/features/skill/store';
import CountLabel from '@/shared/components/nav/CountLabel';
import NavEmpty from '@/shared/components/nav/NavEmpty';
import NavRow from '@/shared/components/nav/NavRow';
import NavSection from '@/shared/components/nav/NavSection';
import ProjectRailRow from '@/shared/components/nav/ProjectRailRow';
import TagGroupRail from '@/shared/components/nav/TagGroupRail';
import { useScrollMemory } from '@/shared/hooks/useScrollMemory';
import type { TagGroupCrudItem } from '@/shared/hooks/useTagGroupCrud';
import { useProjectStore } from '@/shared/store/projectStore';
import type { SkillView } from '@/shared/types';
import { buildScrollKey } from '@/shared/utils/scrollMemory';
import type { ProjectId } from '@/shared/utils/workspaceRef';

import { useSkillCountRefresh } from '../hooks/useSkillCountRefresh';
import { useTagGroupRail } from '../hooks/useTagGroupRail';

/** 删除确认正文（技能侧文案），注入给共享 TagGroupRail。 */
const describeSkillTagDelete = (group: TagGroupCrudItem) => (
  <p className="text-sm text-text-secondary">
    This tag still has{' '}
    <span className="font-medium text-text-primary">
      {group.count} skill{group.count === 1 ? '' : 's'}
    </span>{' '}
    bound to it. Are you sure you want to delete it? All skill associations will be removed.
  </p>
);

interface NavItem {
  key: SkillView;
  label: string;
  icon: React.ElementType;
  count?: number;
}

/**
 * Skills left rail — structure inspired by Skills Manager: primary nav + Tags (tag groups).
 * 拆分（组件体积 ratchet，均为「迁移 JSX 与依赖」，行为零漂移）：
 * - Tags 交互 → `useTagGroupRail`（组合共享 `useTagGroupCrud` + 本侧选择/同步；草稿状态留在 hooks 层）
 * - 左栏计数副作用 → `useSkillCountRefresh`（与 MCP 左栏共用；时序仍随面板挂载）
 * - 区块/行组件 → 共享件：Tags = `TagGroupRail`；Agent = `AgentRailRow`；Project = `ProjectRailRow`
 */
const SkillsPanel: React.FC = React.memo(() => {
  const activeSkillView = useSkillStore((s) => s.activeSkillView);
  const skills = useSkillStore((s) => s.skills);
  const activeTagGroupIds = useSkillStore((s) => s.activeTagGroupIds);
  const setActiveSkillView = useSkillStore((s) => s.setActiveSkillView);
  const setActiveTagGroupIds = useSkillStore((s) => s.setActiveTagGroupIds);
  const setActiveAgentId = useSkillStore((s) => s.setActiveAgentId);
  const agentGroups = useSkillStore((s) => s.agentSkillGroups);
  const activeAgentId = useSkillStore((s) => s.activeAgentId);
  const projectSkillCounts = useSkillStore((s) => s.projectSkillCounts);
  const projectSkillCountsLoading = useSkillStore((s) => s.projectSkillCountsLoading);
  const projectSkillCountsError = useSkillStore((s) => s.projectSkillCountsError);
  const projectTagGroupCounts = useSkillStore((s) => s.projectTagGroupCounts);
  const projectTagGroupCountsLoading = useSkillStore((s) => s.projectTagGroupCountsLoading);
  const projectTagGroupCountsError = useSkillStore((s) => s.projectTagGroupCountsError);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const selectProject = useProjectStore((s) => s.selectProject);

  const { crud, railGroups, syncingId, handleSync, handleTagGroupSelect } = useTagGroupRail();

  useSkillCountRefresh();

  // 滚动记忆：左栏自身的滚动容器（Library 常驻期引擎丢位置 / 卸载重建都恢复）。
  const scrollRef = useScrollMemory<HTMLDivElement>(buildScrollKey('library.skillRail'));

  const navItems: NavItem[] = [
    { key: 'local', label: 'Installed', icon: Package, count: skills.length },
    { key: 'marketplace', label: 'Marketplace', icon: Download },
  ];

  /** Single active destination in the rail — Library / Tag / Agent / Project are exclusive. */
  const selectLibrary = useCallback(() => {
    setActiveSkillView('local');
    setActiveTagGroupIds([]);
    setActiveAgentId(null);
  }, [setActiveSkillView, setActiveTagGroupIds, setActiveAgentId]);

  const selectMarketplace = useCallback(() => {
    setActiveSkillView('marketplace');
    setActiveTagGroupIds([]);
    setActiveAgentId(null);
  }, [setActiveSkillView, setActiveTagGroupIds, setActiveAgentId]);

  const selectAgent = useCallback(
    (agentId: string) => {
      setActiveAgentId(agentId);
      setActiveSkillView('agents');
      setActiveTagGroupIds([]);
    },
    [setActiveAgentId, setActiveSkillView, setActiveTagGroupIds],
  );

  const selectProjectNav = useCallback(
    (projectId: ProjectId) => {
      selectProject(projectId);
      setActiveSkillView('project');
      setActiveTagGroupIds([]);
      setActiveAgentId(null);
    },
    [selectProject, setActiveSkillView, setActiveTagGroupIds, setActiveAgentId],
  );

  return (
    <div className="flex flex-col h-full">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {/* Primary nav */}
        <nav className="py-2 px-1.5" aria-label="Skill views">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive =
              activeSkillView === item.key &&
              (item.key !== 'local' || activeTagGroupIds.length === 0);
            return (
              <NavRow
                key={item.key}
                active={isActive}
                gapClassName="gap-2.5"
                onSelect={() => (item.key === 'local' ? selectLibrary() : selectMarketplace())}
                leading={<Icon className="h-3.5 w-3.5 shrink-0 opacity-90" />}
              >
                <span className="truncate flex-1 font-medium">{item.label}</span>
                {item.count !== undefined && <CountLabel loading={false} count={item.count} />}
              </NavRow>
            );
          })}
        </nav>

        {/* Tags = Tag Groups */}
        <TagGroupRail
          crud={crud}
          groups={railGroups}
          activeIds={activeSkillView === 'local' ? activeTagGroupIds : []}
          onSelect={handleTagGroupSelect}
          emptyText="Group skills by role (Backend, Frontend…)"
          confirmTitle="Delete tag with skills?"
          describeDelete={describeSkillTagDelete}
          syncingId={syncingId}
          onSync={handleSync}
        />

        {/* Agent list */}
        <NavSection title="Agents">
          {agentGroups.length === 0 ? (
            <NavEmpty>No agents configured.</NavEmpty>
          ) : (
            agentGroups.map((group) => (
              <AgentRailRow
                key={group.agent_id}
                group={group}
                active={activeAgentId === group.agent_id && activeSkillView === 'agents'}
                onSelect={selectAgent}
              />
            ))
          )}
        </NavSection>

        {/* Project list */}
        <NavSection title="Projects">
          {projects.length === 0 ? (
            <NavEmpty>No projects loaded.</NavEmpty>
          ) : (
            projects.map((project) => (
              <ProjectRailRow
                key={project.id}
                project={project}
                active={activeProjectId === project.id && activeSkillView === 'project'}
                diskCount={projectSkillCounts.get(project.id)}
                groupCount={projectTagGroupCounts.get(project.id)}
                diskLoading={projectSkillCountsLoading}
                groupLoading={projectTagGroupCountsLoading}
                skillError={projectSkillCountsError}
                tagGroupError={projectTagGroupCountsError}
                testIdPrefix="project-skill-"
                onSelect={selectProjectNav}
              />
            ))
          )}
        </NavSection>
      </div>
    </div>
  );
});

SkillsPanel.displayName = 'SkillsPanel';

export default SkillsPanel;
