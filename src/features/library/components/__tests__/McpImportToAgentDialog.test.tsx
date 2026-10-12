import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { McpServer } from '@/shared/types/mcpServer';

import McpImportToAgentDialog from '../McpImportToAgentDialog';

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

type DialogProps = Parameters<typeof McpImportToAgentDialog>[0];

function setupDialog(overrides: Partial<DialogProps> = {}) {
  const props: DialogProps = {
    agentId: 'claude-code',
    availableServers: [makeServer('fs'), makeServer('db', { transport: 'http' })],
    onClose: vi.fn(),
    onImport: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<McpImportToAgentDialog {...props} />);
  return props;
}

describe('McpImportToAgentDialog', () => {
  it('全选 → Deploy(n) → 提交全部 id', async () => {
    const props = setupDialog();

    fireEvent.click(screen.getByLabelText('Select all'));
    expect(screen.getByText('Select all (2)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Deploy (2)' }));
    await waitFor(() => {
      expect(props.onImport).toHaveBeenCalledWith(['id-fs', 'id-db']);
    });
  });

  it('传输过滤 chip 缩窄列表（stdio 项被 http 过滤移除）', () => {
    setupDialog();

    fireEvent.click(screen.getByRole('button', { name: 'http' }));

    expect(screen.queryByText('fs')).not.toBeInTheDocument();
    expect(screen.getByText('db')).toBeInTheDocument();
  });

  it('无可用服务器 → 空态；未选择时 Deploy 禁用；Cancel 关闭', () => {
    const props = setupDialog({ availableServers: [] });

    expect(screen.getByText('No servers available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deploy (0)' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onClose).toHaveBeenCalled();
  });
});
