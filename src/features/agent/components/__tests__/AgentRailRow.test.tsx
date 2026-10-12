import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentDiskSkill, AgentSkillGroup } from '@/shared/types';

import AgentRailRow from '../AgentRailRow';

function diskSkill(name: string): AgentDiskSkill {
  return { name, description: null, path: `/tmp/${name}`, managed: true, skill_id: null };
}

function makeGroup(overrides: Partial<AgentSkillGroup> = {}): AgentSkillGroup {
  return {
    agent_id: 'opencode',
    agent_name: 'OpenCode',
    agent_icon: null,
    agent_enabled: true,
    agent_skill_path: null,
    skills: [],
    ...overrides,
  };
}

describe('AgentRailRow', () => {
  it('渲染名称与技能数，点击回调 onSelect，testId 透传', () => {
    const onSelect = vi.fn();
    render(
      <AgentRailRow
        group={makeGroup({ skills: [diskSkill('a'), diskSkill('b')] })}
        active={false}
        onSelect={onSelect}
        testId="mcp-agent-row-opencode"
      />,
    );

    const row = screen.getByTestId('mcp-agent-row-opencode');
    expect(screen.getByText('OpenCode')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();

    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith('opencode');
  });

  it('未启用 → 显示 disabled 徽标；启用时不显示', () => {
    const { unmount } = render(
      <AgentRailRow
        group={makeGroup({ agent_enabled: false })}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('disabled')).toBeInTheDocument();
    unmount();

    render(
      <AgentRailRow
        group={makeGroup({ agent_enabled: true })}
        active={false}
        onSelect={() => {}}
      />,
    );
    expect(screen.queryByText('disabled')).not.toBeInTheDocument();
  });

  it('可解析图标 → <img> 指向 convertFileSrc 结果', () => {
    const view = render(
      <AgentRailRow
        group={makeGroup({ agent_icon: '/custom/my-agent.png' })}
        active={false}
        onSelect={() => {}}
      />,
    );
    // 图标分支映射必须落到 img 查询（同 DiagnosticsPanel.test 的图标断言范式）
    // eslint-disable-next-line testing-library/no-node-access, testing-library/no-container
    const img = view.container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toContain('/custom/my-agent.png');
  });

  it('无图标 → 不渲染 img，Terminal 兜底图标在场', () => {
    const view = render(
      <AgentRailRow group={makeGroup({ agent_icon: null })} active={false} onSelect={() => {}} />,
    );
    // eslint-disable-next-line testing-library/no-node-access, testing-library/no-container
    expect(view.container.querySelector('img')).toBeNull();
    // eslint-disable-next-line testing-library/no-node-access, testing-library/no-container
    expect(view.container.querySelector('svg')).not.toBeNull();
  });
});
