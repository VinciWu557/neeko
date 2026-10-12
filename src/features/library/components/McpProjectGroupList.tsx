import React, { useCallback } from 'react';

import { useMcpStore } from '@/features/library/store/mcpStore';
import { useSkillStore } from '@/features/skill/store';
import NavEmpty from '@/shared/components/nav/NavEmpty';
import NavSection from '@/shared/components/nav/NavSection';
import ProjectRailRow from '@/shared/components/nav/ProjectRailRow';
import { useProjectStore } from '@/shared/store/projectStore';
import type { ProjectId } from '@/shared/utils/workspaceRef';

/** Project group list inside the MCP navigation panel (selecting one opens the project view). */
const McpProjectGroupList: React.FC = React.memo(() => {
  const projects = useProjectStore((s) => s.projects);
  const mcpView = useMcpStore((s) => s.mcpView);
  const activeMcpProjectId = useMcpStore((s) => s.activeMcpProjectId);
  const setActiveMcpProjectId = useMcpStore((s) => s.setActiveMcpProjectId);
  const setActiveMcpTagGroup = useMcpStore((s) => s.setActiveMcpTagGroup);
  const setMcpView = useMcpStore((s) => s.setMcpView);
  const projectSkillCounts = useSkillStore((s) => s.projectSkillCounts);
  const projectSkillCountsLoading = useSkillStore((s) => s.projectSkillCountsLoading);
  const projectSkillCountsError = useSkillStore((s) => s.projectSkillCountsError);
  const projectTagGroupCounts = useSkillStore((s) => s.projectTagGroupCounts);
  const projectTagGroupCountsLoading = useSkillStore((s) => s.projectTagGroupCountsLoading);
  const projectTagGroupCountsError = useSkillStore((s) => s.projectTagGroupCountsError);

  const handleSelect = useCallback(
    (projectId: ProjectId) => {
      setActiveMcpProjectId(projectId);
      setActiveMcpTagGroup(null);
      setMcpView('project');
    },
    [setActiveMcpProjectId, setActiveMcpTagGroup, setMcpView],
  );

  return (
    <NavSection title="Projects">
      {projects.length === 0 ? (
        <NavEmpty>No projects loaded.</NavEmpty>
      ) : (
        projects.map((project) => (
          <ProjectRailRow
            key={project.id}
            project={project}
            active={mcpView === 'project' && project.id === activeMcpProjectId}
            diskCount={projectSkillCounts.get(project.id)}
            groupCount={projectTagGroupCounts.get(project.id)}
            diskLoading={projectSkillCountsLoading}
            groupLoading={projectTagGroupCountsLoading}
            skillError={projectSkillCountsError}
            tagGroupError={projectTagGroupCountsError}
            testIdPrefix="mcp-project-"
            onSelect={handleSelect}
          />
        ))
      )}
    </NavSection>
  );
});

McpProjectGroupList.displayName = 'McpProjectGroupList';

export default McpProjectGroupList;
