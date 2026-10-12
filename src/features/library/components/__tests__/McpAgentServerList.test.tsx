import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { McpServer } from '@/shared/types/mcpServer';

import McpAgentServerList from '../McpAgentServerList';

function makeServer(name: string, overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: `id-${name}`,
    name,
    description: `${name} desc`,
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

describe('McpAgentServerList', () => {
  it('grid 视图渲染名称 / 传输方式 / scope，Undeploy 触发回调', () => {
    const onUndeploy = vi.fn();
    render(
      <McpAgentServerList
        servers={[makeServer('fs', { scope: 'project' })]}
        viewMode="grid"
        onUndeploy={onUndeploy}
      />,
    );

    expect(screen.getByText('fs')).toBeInTheDocument();
    expect(screen.getByText('stdio')).toBeInTheDocument();
    expect(screen.getByText('project')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Undeploy/ }));
    expect(onUndeploy).toHaveBeenCalledWith('fs');
  });

  it('list 视图渲染并触发 Undeploy', () => {
    const onUndeploy = vi.fn();
    render(
      <McpAgentServerList
        servers={[makeServer('db', { transport: 'http' })]}
        viewMode="list"
        onUndeploy={onUndeploy}
      />,
    );

    expect(screen.getByText('db')).toBeInTheDocument();
    expect(screen.getByText('http')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Undeploy/ }));
    expect(onUndeploy).toHaveBeenCalledWith('db');
  });
});
