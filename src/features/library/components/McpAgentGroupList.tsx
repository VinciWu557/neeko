import React, { useCallback } from 'react';

import { AgentRailRow } from '@/features/agent';
import { useMcpStore } from '@/features/library/store/mcpStore';
import { useSkillStore } from '@/features/skill/store';
import NavEmpty from '@/shared/components/nav/NavEmpty';
import NavSection from '@/shared/components/nav/NavSection';

/** Agent group list inside the MCP navigation panel (selecting one opens the agent view). */
const McpAgentGroupList: React.FC = React.memo(() => {
  const agentGroups = useSkillStore((s) => s.agentSkillGroups);
  const mcpView = useMcpStore((s) => s.mcpView);
  const activeMcpAgentId = useMcpStore((s) => s.activeMcpAgentId);
  const setActiveMcpAgentId = useMcpStore((s) => s.setActiveMcpAgentId);
  const setActiveMcpTagGroup = useMcpStore((s) => s.setActiveMcpTagGroup);
  const setMcpView = useMcpStore((s) => s.setMcpView);

  const handleSelect = useCallback(
    (agentId: string) => {
      setActiveMcpAgentId(agentId);
      setActiveMcpTagGroup(null);
      setMcpView('agent');
    },
    [setActiveMcpAgentId, setActiveMcpTagGroup, setMcpView],
  );

  return (
    <NavSection title="Agents">
      {agentGroups.length === 0 ? (
        <NavEmpty>No agents configured.</NavEmpty>
      ) : (
        agentGroups.map((group) => (
          <AgentRailRow
            key={group.agent_id}
            group={group}
            active={mcpView === 'agent' && group.agent_id === activeMcpAgentId}
            onSelect={handleSelect}
            testId={`mcp-agent-row-${group.agent_id}`}
          />
        ))
      )}
    </NavSection>
  );
});

McpAgentGroupList.displayName = 'McpAgentGroupList';

export default McpAgentGroupList;
