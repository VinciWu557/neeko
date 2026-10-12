import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { McpServer } from '@/shared/types/mcpServer';
import type { ProjectId } from '@/shared/utils/workspaceRef';

import { McpCard, McpListItem } from '../McpServerItems';

function makeServer(name: string, overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: `id-${name}`,
    name,
    description: `${name} tools`,
    command: 'npx',
    url: null,
    args: [],
    env: {},
    transport: 'stdio',
    scope: 'global',
    projectId: null,
    tags: [],
    enabled: true,
    usageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function cardProps(overrides: Record<string, unknown> = {}) {
  return {
    onEdit: vi.fn(),
    onTest: vi.fn(),
    onDelete: vi.fn(),
    testing: false,
    ...overrides,
  };
}

/** Radix DropdownMenu 触发器监听 pointerdown（fireEvent.click 不会打开菜单）。 */
function openActionsMenu() {
  fireEvent.pointerDown(screen.getByTitle('Actions'), { button: 0, ctrlKey: false });
}

describe('McpCard（grid 条目）', () => {
  it('渲染名称 / 描述 / 传输方式 / 命令 / scope 页脚 / 标签 chips', () => {
    render(
      <McpCard
        server={makeServer('filesystem', { description: 'fs tools', tags: ['fs', 'tool'] })}
        {...cardProps()}
      />,
    );

    expect(screen.getByText('filesystem')).toBeInTheDocument();
    expect(screen.getByText('fs tools')).toBeInTheDocument();
    expect(screen.getByText('stdio')).toBeInTheDocument();
    expect(screen.getByText('npx')).toBeInTheDocument();
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Global')).toBeInTheDocument();
    expect(screen.getByText('fs')).toBeInTheDocument();
    expect(screen.getByText('tool')).toBeInTheDocument();
  });

  it('远程 + 项目作用域：渲染 url 与 Remote/Project 页脚', () => {
    render(
      <McpCard
        server={makeServer('remote', {
          transport: 'http',
          url: 'https://mcp.example.com',
          scope: 'project',
          projectId: 'p1' as ProjectId,
        })}
        {...cardProps()}
      />,
    );

    expect(screen.getByText('https://mcp.example.com')).toBeInTheDocument();
    expect(screen.getByText('Remote')).toBeInTheDocument();
    expect(screen.getByText('Project')).toBeInTheDocument();
  });

  it('操作菜单：点击 Test 触发回调', () => {
    const props = cardProps();
    render(<McpCard server={makeServer('filesystem')} {...props} />);

    openActionsMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Test' }));
    expect(props.onTest).toHaveBeenCalledTimes(1);
  });

  it('操作菜单：点击 Delete 触发回调', () => {
    const props = cardProps();
    render(<McpCard server={makeServer('filesystem')} {...props} />);

    openActionsMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it('testing=true：菜单 Test 项显示 Testing… 且禁用', () => {
    render(<McpCard server={makeServer('filesystem')} {...cardProps({ testing: true })} />);

    openActionsMenu();
    const item = screen.getByRole('menuitem', { name: /Testing\.\.\./ });
    expect(item).toHaveAttribute('data-disabled');
  });
});

describe('McpListItem（list 行）', () => {
  it('渲染并可触发 Test / Edit / Delete', () => {
    const props = cardProps();
    render(<McpListItem server={makeServer('filesystem')} {...props} />);

    fireEvent.click(screen.getByTitle('Test connection'));
    expect(props.onTest).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle('Edit'));
    expect(props.onEdit).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle('Delete'));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
  });

  it('testing=true：Test 按钮禁用并显示 Testing…', () => {
    render(<McpListItem server={makeServer('filesystem')} {...cardProps({ testing: true })} />);

    const testBtn = screen.getByTitle('Test connection');
    expect(testBtn).toBeDisabled();
    expect(testBtn).toHaveTextContent('Testing...');
  });
});
