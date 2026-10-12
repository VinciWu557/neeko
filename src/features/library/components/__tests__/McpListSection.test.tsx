import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLibraryStore } from '@/features/library/store/libraryStore';
import { useMcpStore } from '@/features/library/store/mcpStore';
import type { McpServer } from '@/shared/types/mcpServer';

import McpListSection from '../McpListSection';

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

describe('McpListSection — 删除流', () => {
  beforeEach(() => {
    useMcpStore.setState({ mcpServers: [makeServer('Alpha')], mcpServersLoading: false });
    useLibraryStore.setState({
      searchQuery: '',
      viewMode: 'list',
      sortMode: 'recent',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('点击删除 → 弹确认框（含名称）→ 确认调用 deleteMcpServer', async () => {
    const deleteMcpServer = vi
      .spyOn(useMcpStore.getState(), 'deleteMcpServer')
      .mockResolvedValue(undefined);
    render(<McpListSection />);

    fireEvent.click(screen.getByTitle('Delete'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete MCP server?')).toBeInTheDocument();
    expect(within(dialog).getByText('Alpha')).toBeInTheDocument();
    expect(deleteMcpServer).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteMcpServer).toHaveBeenCalledWith('id-Alpha'));
  });

  it('取消确认框 → 不删除', async () => {
    const deleteMcpServer = vi
      .spyOn(useMcpStore.getState(), 'deleteMcpServer')
      .mockResolvedValue(undefined);
    render(<McpListSection />);

    fireEvent.click(screen.getByTitle('Delete'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(deleteMcpServer).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
