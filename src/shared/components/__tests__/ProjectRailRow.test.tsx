import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { getProjectInitials } from '@/shared/utils/projectAvatar';
import { createProject } from '@/testing/factories';

import ProjectRailRow from '../nav/ProjectRailRow';

type RowProps = ComponentProps<typeof ProjectRailRow>;

/** props 工厂（不 render，避免 testing-library/no-render-in-setup 范式冲突）。 */
function baseProps(overrides: Partial<RowProps> = {}): RowProps {
  return {
    project: createProject({ name: 'neeko' }),
    active: false,
    diskCount: 2,
    groupCount: 3,
    diskLoading: false,
    groupLoading: false,
    skillError: null,
    tagGroupError: null,
    testIdPrefix: 'mcp-project-',
    onSelect: () => {},
    ...overrides,
  };
}

describe('ProjectRailRow', () => {
  it('testId 由前缀单一派生（row / metrics / 双计数），渲染名称/头像/指标并可选中', () => {
    const onSelect = vi.fn();
    const project = createProject({ name: 'neeko' });
    render(<ProjectRailRow {...baseProps({ project, onSelect })} />);

    const row = screen.getByTestId(`mcp-project-row-${project.id}`);
    expect(screen.getByText('neeko')).toBeInTheDocument();
    expect(screen.getByText(getProjectInitials('neeko'))).toBeInTheDocument();
    expect(screen.getByTestId(`mcp-project-disk-count-${project.id}`)).toHaveTextContent('2');
    expect(screen.getByTestId(`mcp-project-group-count-${project.id}`)).toHaveTextContent('3g');
    expect(row).toHaveAttribute('title', '2 skills on disk · 3 tag groups bound');

    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(project.id);
  });

  it('未加载（loading 且无值）→ 双指标显示 …', () => {
    const project = createProject();
    render(
      <ProjectRailRow
        {...baseProps({
          project,
          diskCount: undefined,
          groupCount: undefined,
          diskLoading: true,
          groupLoading: true,
        })}
      />,
    );

    expect(screen.getByTestId(`mcp-project-disk-count-${project.id}`)).toHaveTextContent('…');
    expect(screen.getByTestId(`mcp-project-group-count-${project.id}`)).toHaveTextContent('…');
  });

  it('错误 → 指标聚集红色、aria 用错误字形、title 取错误文案', () => {
    const project = createProject();
    render(<ProjectRailRow {...baseProps({ project, skillError: 'scan failed' })} />);

    const metrics = screen.getByTestId(`mcp-project-metrics-${project.id}`);
    expect(metrics).toHaveClass('text-accent-red');
    expect(metrics).toHaveAttribute('aria-label', '! on disk, ! bound');
    expect(screen.getByTestId(`mcp-project-row-${project.id}`)).toHaveAttribute(
      'title',
      'scan failed',
    );
  });

  it('active → 组数蓝色强调；单数文案', () => {
    const project = createProject();
    render(
      <ProjectRailRow {...baseProps({ project, active: true, diskCount: 1, groupCount: 1 })} />,
    );

    expect(screen.getByTestId(`mcp-project-group-count-${project.id}`)).toHaveClass(
      'text-accent-blue/90',
    );
    expect(screen.getByTestId(`mcp-project-row-${project.id}`)).toHaveAttribute(
      'title',
      '1 skill on disk · 1 tag group bound',
    );
  });
});
