import { Server } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';

import { useLibraryStore } from '@/features/library/store/libraryStore';
import { useMcpStore } from '@/features/library/store/mcpStore';
import DeleteConfirmDialog from '@/shared/components/DeleteConfirmDialog';
import { useDeleteConfirm } from '@/shared/hooks/useDeleteConfirm';
import { useNotify } from '@/shared/hooks/useNotify';
import { useNotificationStore } from '@/shared/store/notificationStore';
import type { McpServer } from '@/shared/types/mcpServer';

import { sortResources } from '../utils/resourceSort';

import { McpCard, McpListItem } from './McpServerItems';

interface McpListSectionProps {
  onEdit?: (server: McpServer) => void;
}

const McpListSection: React.FC<McpListSectionProps> = React.memo(({ onEdit }) => {
  const mcpServers = useMcpStore((s) => s.mcpServers);
  const loading = useMcpStore((s) => s.mcpServersLoading);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const viewMode = useLibraryStore((s) => s.viewMode);
  const sortMode = useLibraryStore((s) => s.sortMode);
  const deleteMcpServer = useMcpStore((s) => s.deleteMcpServer);
  const testMcpConnection = useMcpStore((s) => s.testMcpConnection);

  const { notify } = useNotify();
  const [testingId, setTestingId] = useState<string | null>(null);

  // 删除确认走共享状态机（与 prompts / tag groups 同一实现）；servers 总是确认。
  const del = useDeleteConfirm({
    items: mcpServers,
    remove: deleteMcpServer,
    notify,
    entityLabel: 'MCP server',
  });

  const filtered = useMemo(() => {
    let list = [...mcpServers];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.command.toLowerCase().includes(q) ||
          s.description?.toLowerCase().includes(q) ||
          s.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    return sortResources(list, sortMode, {
      name: (s) => s.name,
      usage: (s) => s.usageCount,
      updated: (s) => s.updatedAt,
    });
  }, [mcpServers, searchQuery, sortMode]);

  const handleTest = useCallback(
    async (id: string) => {
      setTestingId(id);
      try {
        const result = await testMcpConnection(id);
        // 直连 store：测试结果需要 'warning' 类型，useNotify 只覆盖 info/error。
        useNotificationStore.getState().addNotification({
          type: result.commandFound ? 'info' : 'warning',
          title: 'MCP Test',
          message: result.message,
        });
      } catch (e) {
        useNotificationStore.getState().addNotification({
          type: 'error',
          title: 'Test Failed',
          message: String(e),
        });
      } finally {
        setTestingId(null);
      }
    },
    [testMcpConnection],
  );

  if (loading && mcpServers.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-[var(--font-size)]">
        Loading MCP servers...
      </div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-text-muted gap-2 px-6">
        <Server className="h-8 w-8 opacity-30" />
        <p className="text-[var(--font-size)] text-text-secondary text-center">
          {mcpServers.length === 0
            ? 'No MCP servers yet. Add servers to connect your agents to tools.'
            : 'No MCP servers match the current filters.'}
        </p>
      </div>
    );
  }

  return (
    <>
      <div
        className={
          viewMode === 'grid'
            ? 'p-3 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2 content-start'
            : 'flex flex-col gap-1 p-2'
        }
      >
        {filtered.map((server) =>
          viewMode === 'grid' ? (
            <McpCard
              key={server.id}
              server={server}
              onEdit={() => onEdit?.(server)}
              onTest={() => void handleTest(server.id)}
              onDelete={() => del.request(server.id)}
              testing={testingId === server.id}
            />
          ) : (
            <McpListItem
              key={server.id}
              server={server}
              onEdit={() => onEdit?.(server)}
              onTest={() => void handleTest(server.id)}
              onDelete={() => del.request(server.id)}
              testing={testingId === server.id}
            />
          ),
        )}
      </div>
      <DeleteConfirmDialog
        pending={del.pending}
        onCancel={del.cancel}
        onConfirm={del.confirm}
        title="Delete MCP server?"
        describe={(server) => (
          <p className="text-sm text-text-secondary">
            Are you sure you want to delete{' '}
            <span className="font-medium text-text-primary">{server.name}</span>? This cannot be
            undone.
          </p>
        )}
      />
    </>
  );
});

McpListSection.displayName = 'McpListSection';

export default McpListSection;
