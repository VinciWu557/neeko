import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMcpStore } from '@/features/library/store/mcpStore';
import { initialSkillState, useSkillStore } from '@/features/skill/store';
import { useProjectStore } from '@/shared/store/projectStore';
import { createProject } from '@/testing/factories';

import McpNavPanel from '../McpNavPanel';

/**
 * 四个刷新动作的 spy 组装点。
 * MCP 面板的刷新职责已按来源拆为 `useMcpNavRefresh`（tag groups）+
 * `useSkillCountRefresh`（与 Skills 左栏共用）——本套用例钉住这条接线。
 */
function stubRefreshes() {
  return {
    refreshMcpTagGroups: vi
      .spyOn(useMcpStore.getState(), 'refreshMcpTagGroups')
      .mockResolvedValue(undefined),
    refreshAgentSkills: vi
      .spyOn(useSkillStore.getState(), 'refreshAgentSkills')
      .mockResolvedValue(undefined),
    refreshProjectSkillCounts: vi
      .spyOn(useSkillStore.getState(), 'refreshProjectSkillCounts')
      .mockResolvedValue(undefined),
    refreshProjectTagGroupCounts: vi
      .spyOn(useSkillStore.getState(), 'refreshProjectTagGroupCounts')
      .mockResolvedValue(undefined),
  };
}

describe('McpNavPanel', () => {
  beforeEach(() => {
    useSkillStore.setState(initialSkillState);
    useProjectStore.setState({ projects: [], activeProjectId: null, activeProject: null });
    useMcpStore.setState({
      mcpView: 'installed',
      mcpTagGroups: [],
      mcpServers: [],
      activeMcpAgentId: null,
      activeMcpProjectId: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('挂载 → MCP tag groups 与 skill 三计数各刷新一次', () => {
    const spies = stubRefreshes();

    render(<McpNavPanel />);

    expect(spies.refreshMcpTagGroups).toHaveBeenCalledTimes(1);
    expect(spies.refreshAgentSkills).toHaveBeenCalledTimes(1);
    expect(spies.refreshProjectSkillCounts).toHaveBeenCalledTimes(1);
    expect(spies.refreshProjectTagGroupCounts).toHaveBeenCalledTimes(1);
  });

  it('项目列表变化 → 仅 project 计数重刷（agents 不重刷）', () => {
    const spies = stubRefreshes();
    render(<McpNavPanel />);

    act(() => {
      useProjectStore.setState({ projects: [createProject({ path: '/tmp/other' })] });
    });

    expect(spies.refreshProjectSkillCounts).toHaveBeenCalledTimes(2);
    expect(spies.refreshProjectTagGroupCounts).toHaveBeenCalledTimes(2);
    expect(spies.refreshAgentSkills).toHaveBeenCalledTimes(1);
  });

  it('三个分区渲染：tag / agent（共享行）/ project 行', () => {
    stubRefreshes();
    useMcpStore.setState({
      mcpTagGroups: [{ id: 'tg-1', name: 'Backend', sortOrder: 0, serverCount: 2 }],
    });
    useSkillStore.setState({
      agentSkillGroups: [
        {
          agent_id: 'opencode',
          agent_name: 'OpenCode',
          agent_icon: null,
          agent_enabled: true,
          agent_skill_path: null,
          skills: [],
        },
      ],
    });
    useProjectStore.setState({ projects: [createProject()] });

    render(<McpNavPanel />);

    // Tags 默认展开；Agents / Projects 默认折叠，先点击标题展开
    expect(screen.getByText('Backend')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Agents'));
    expect(screen.getByTestId('mcp-agent-row-opencode')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Projects'));
    expect(screen.getByTestId('mcp-project-row-test-project-id')).toBeInTheDocument();
  });

  it('tag 删除走智能确认：有 server 时弹 MCP 文案确认框', () => {
    stubRefreshes();
    useMcpStore.setState({
      mcpTagGroups: [{ id: 'tg-1', name: 'Backend', sortOrder: 0, serverCount: 2 }],
    });

    render(<McpNavPanel />);
    fireEvent.click(screen.getByTitle('Delete tag'));

    expect(screen.getByText('Delete Tag Group')).toBeInTheDocument();
    expect(screen.getByText(/Servers in the group will not be deleted/)).toBeInTheDocument();
  });
});
