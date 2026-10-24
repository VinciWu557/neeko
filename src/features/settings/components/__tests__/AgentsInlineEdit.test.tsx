import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentStore } from '@/shared/store/agentStore';
import type { AgentConfig } from '@/shared/types';

import { createAgent } from '../../../../testing/factories';
import BuiltInAgentsSection from '../BuiltInAgentsSection';
import CustomAgentsSection from '../CustomAgentsSection';

vi.mock('@/features/agent/api/agentApi', () => ({
  importAgentIcon: vi.fn(),
  resolveAgentIconSrc: () => null,
}));

/**
 * 编辑表单的**行内锚定**：点击哪一行的铅笔，表单就出现在那一行下方，
 * 列表本体不再被整块替换 —— 表单和被编辑 agent 必须在同一视口内可同时感知。
 */

const noop = () => {};

function customProps() {
  return {
    skillPathEditingAgentId: null,
    skillPathInputValue: '',
    onSkillPathInputValueChange: noop,
    onSaveAgent: vi.fn().mockResolvedValue(undefined),
    onToggleAgentEnabled: vi.fn().mockResolvedValue(undefined),
    onRemoveAgent: noop,
    onSelectSkillPath: noop,
    onStartEditSkillPath: noop,
    onSaveSkillPath: noop,
    onCancelSkillPathEdit: noop,
  };
}

function builtinProps() {
  return {
    getEffectiveAgent: (a: AgentConfig) => a,
    onSaveBuiltinAgent: vi.fn().mockResolvedValue(undefined),
    onToggleAgentEnabled: vi.fn().mockResolvedValue(undefined),
    onResetBuiltinAgent: noop,
    skillPathEditingAgentId: null,
    skillPathInputValue: '',
    onSkillPathInputValueChange: noop,
    onSelectSkillPath: noop,
    onStartEditSkillPath: noop,
    onSaveSkillPath: noop,
    onCancelSkillPathEdit: noop,
  };
}

/** 「表单在该行之后 / 行被高亮」是 DOM 层级与 class 断言，需要 Node 访问。 */
function rowAfter(text: string): { next: Element | null; cls: string } {
  // eslint-disable-next-line testing-library/no-node-access -- 结构关系断言（DOM 层级）
  const row = screen.getByText(text).parentElement;
  return {
    // eslint-disable-next-line testing-library/no-node-access -- 结构关系断言（DOM 层级）
    next: row?.nextElementSibling ?? null,
    // eslint-disable-next-line testing-library/no-node-access -- class 结构断言
    cls: row?.className ?? '',
  };
}

describe('CustomAgentsSection inline edit', () => {
  const custom = createAgent({
    id: 'custom:oc',
    name: 'My OC',
    command: 'oc',
    is_builtin: false,
  });

  beforeEach(() => {
    useAgentStore.getState().setAgents([custom]);
  });

  it('opens the form under the edited row and keeps the list visible', () => {
    render(<CustomAgentsSection {...customProps()} />);

    fireEvent.click(screen.getByTitle('Edit'));

    expect(screen.getByText('Edit Agent · custom:oc')).toBeInTheDocument();
    // 列表不被替换：被编辑的行仍然可见。
    expect(screen.getByText('My OC')).toBeInTheDocument();
    // 表单锚定在该行下方（同一列表容器内，位于该行之后），编辑行高亮。
    const { next, cls } = rowAfter('My OC');
    expect(next?.textContent).toContain('Edit Agent · custom:oc');
    expect(cls).toContain('bg-accent-blue/5');
  });

  it('toggles the form off when the pencil is clicked again', () => {
    render(<CustomAgentsSection {...customProps()} />);

    fireEvent.click(screen.getByTitle('Edit'));
    fireEvent.click(screen.getByTitle('Edit'));

    expect(screen.queryByText('Edit Agent · custom:oc')).not.toBeInTheDocument();
    expect(screen.getByText('My OC')).toBeInTheDocument();
  });

  it('renders the create form above the list instead of replacing it', () => {
    render(<CustomAgentsSection {...customProps()} />);

    fireEvent.click(screen.getByText('Add Agent'));

    expect(screen.getByText('Create Custom Agent')).toBeInTheDocument();
    expect(screen.getByText('My OC')).toBeInTheDocument();

    // 从新建切到行内编辑：新建表单关闭。
    fireEvent.click(screen.getByTitle('Edit'));
    expect(screen.queryByText('Create Custom Agent')).not.toBeInTheDocument();
    expect(screen.getByText('Edit Agent · custom:oc')).toBeInTheDocument();
  });
});

describe('row enable switch', () => {
  it('toggles a custom agent without opening the edit form', () => {
    const props = customProps();
    useAgentStore
      .getState()
      .setAgents([
        createAgent({ id: 'custom:oc', name: 'My OC', command: 'oc', is_builtin: false }),
      ]);
    render(<CustomAgentsSection {...props} />);

    const rowSwitch = screen.getByRole('switch', { name: 'My OC enabled' });
    expect(rowSwitch).toBeChecked();

    fireEvent.click(rowSwitch);

    // 意图上报给统一的启停 handler（写路径与错误策略在 hook 收口）。
    expect(props.onToggleAgentEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'custom:oc' }),
      false,
    );
    // 编辑表单不被拉起。
    expect(screen.queryByText('Edit Agent · custom:oc')).not.toBeInTheDocument();
  });

  it('closes the inline form when toggling the edited row (single writer)', () => {
    render(<CustomAgentsSection {...customProps()} />);

    fireEvent.click(screen.getByTitle('Edit'));
    expect(screen.getByText('Edit Agent · custom:oc')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'My OC enabled' }));

    // 表单是打开时刻的快照：不同步收起，随后的 Save 会把旧 enabled 写回。
    expect(screen.queryByText('Edit Agent · custom:oc')).not.toBeInTheDocument();
  });

  it('dims a disabled custom row', () => {
    useAgentStore.getState().setAgents([
      createAgent({
        id: 'custom:oc',
        name: 'My OC',
        command: 'oc',
        is_builtin: false,
        enabled: false,
      }),
    ]);
    render(<CustomAgentsSection {...customProps()} />);

    expect(screen.getByText('My OC')).toHaveClass('opacity-50');
    expect(screen.getByRole('switch', { name: 'My OC enabled' })).not.toBeChecked();
  });

  it('toggles a builtin agent through the override save path', () => {
    const props = builtinProps();
    const builtin = createAgent({
      id: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      is_builtin: true,
    });
    render(<BuiltInAgentsSection builtinAgents={[builtin]} {...props} />);

    fireEvent.click(screen.getByRole('switch', { name: 'Claude Code enabled' }));

    expect(props.onToggleAgentEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'claude-code' }),
      false,
    );
  });

  it('closes the builtin inline form when toggling the edited row (single writer)', () => {
    const builtin = createAgent({
      id: 'claude-code',
      name: 'Claude Code',
      command: 'claude',
      is_builtin: true,
    });
    render(<BuiltInAgentsSection builtinAgents={[builtin]} {...builtinProps()} />);

    fireEvent.click(screen.getByTitle('Edit built-in agent'));
    expect(screen.getByText('Edit Built-in Agent · claude-code')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Claude Code enabled' }));

    expect(screen.queryByText('Edit Built-in Agent · claude-code')).not.toBeInTheDocument();
  });
});

describe('BuiltInAgentsSection inline edit', () => {
  const builtin = createAgent({
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    is_builtin: true,
  });

  it('opens the form under the edited row and keeps the list visible', () => {
    render(<BuiltInAgentsSection builtinAgents={[builtin]} {...builtinProps()} />);

    fireEvent.click(screen.getByTitle('Edit built-in agent'));

    expect(screen.getByText('Edit Built-in Agent · claude-code')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    const { next, cls } = rowAfter('Claude Code');
    expect(next?.textContent).toContain('Edit Built-in Agent · claude-code');
    expect(cls).toContain('bg-accent-blue/5');
  });

  it('toggles the form off when the pencil is clicked again', () => {
    render(<BuiltInAgentsSection builtinAgents={[builtin]} {...builtinProps()} />);

    fireEvent.click(screen.getByTitle('Edit built-in agent'));
    fireEvent.click(screen.getByTitle('Edit built-in agent'));

    expect(screen.queryByText('Edit Built-in Agent · claude-code')).not.toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });
});
