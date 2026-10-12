import { LayoutGrid, List, Plus, RefreshCw, Search } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  deployMcpToAgent,
  listDeployedMcp,
  removeDeployedMcp,
} from '@/features/library/api/libraryApi';
import { useMcpStore } from '@/features/library/store/mcpStore';
import { cn } from '@/lib/utils';
import { useScrollMemory } from '@/shared/hooks/useScrollMemory';
import { useNotificationStore } from '@/shared/store/notificationStore';
import { useProjectStore } from '@/shared/store/projectStore';
import { buildScrollKey } from '@/shared/utils/scrollMemory';
import { Button } from '@/ui/Button';

import McpAgentServerList from './McpAgentServerList';
import McpImportToAgentDialog from './McpImportToAgentDialog';

interface McpAgentContentProps {
  agentId: string;
}

/** Narrow the untyped deployer boundary (`Vec<serde_json::Value>`) to named entries. */
function isDeployedEntry(value: unknown): value is { name: string } {
  return (
    typeof value === 'object' && value !== null && 'name' in value && typeof value.name === 'string'
  );
}

const McpAgentContent: React.FC<McpAgentContentProps> = React.memo(({ agentId }) => {
  const mcpServers = useMcpStore((s) => s.mcpServers);
  const setMcpView = useMcpStore((s) => s.setMcpView);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const [deployedNames, setDeployedNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [importOpen, setImportOpen] = useState(false);

  // 滚动记忆：已部署列表按 agent × 项目隔离；Library 常驻期引擎丢位置 / 卸载重建都恢复。
  const scrollRef = useScrollMemory<HTMLDivElement>(
    buildScrollKey('library.mcp', agentId, activeProjectId ?? 'global'),
  );

  const refreshDeployed = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listDeployedMcp(agentId, activeProjectId ?? undefined);
      setDeployedNames(result.filter(isDeployedEntry).map((entry) => entry.name));
    } catch {
      setDeployedNames([]);
    } finally {
      setLoading(false);
    }
  }, [agentId, activeProjectId]);

  useEffect(() => {
    void refreshDeployed();
  }, [refreshDeployed]);

  const deployedServers = useMemo(
    () => mcpServers.filter((s) => deployedNames.includes(s.name)),
    [mcpServers, deployedNames],
  );

  const availableServers = useMemo(
    () => mcpServers.filter((s) => !deployedNames.includes(s.name)),
    [mcpServers, deployedNames],
  );

  const filteredDeployed = useMemo(() => {
    if (!searchQuery.trim()) return deployedServers;
    const q = searchQuery.toLowerCase();
    return deployedServers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q) ||
        s.transport.includes(q),
    );
  }, [deployedServers, searchQuery]);

  const handleUndeploy = useCallback(
    async (serverName: string) => {
      try {
        await removeDeployedMcp(serverName, agentId, activeProjectId ?? undefined);
        useNotificationStore.getState().addNotification({
          type: 'info',
          title: 'MCP Undeploy',
          message: "Removed '" + serverName + "' from agent",
        });
        await refreshDeployed();
      } catch (e) {
        useNotificationStore.getState().addNotification({
          type: 'error',
          title: 'Undeploy Failed',
          message: String(e),
        });
      }
    },
    [agentId, activeProjectId, refreshDeployed],
  );

  const handleImport = useCallback(
    async (serverIds: string[]) => {
      for (const sid of serverIds) {
        try {
          await deployMcpToAgent(sid, agentId, activeProjectId ?? undefined);
        } catch (e) {
          useNotificationStore.getState().addNotification({
            type: 'error',
            title: 'Deploy Failed',
            message: String(e),
          });
        }
      }
      useNotificationStore.getState().addNotification({
        type: 'info',
        title: 'MCP Deploy',
        message: 'Deployed ' + serverIds.length + ' server(s) to agent',
      });
      setImportOpen(false);
      await refreshDeployed();
    },
    [agentId, activeProjectId, refreshDeployed],
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <span className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
          Agent:
        </span>
        <span className="text-[var(--font-size)] font-semibold text-text-primary">{agentId}</span>
        <span className="inline-flex items-center h-5 px-2 rounded-full text-[10px] font-medium bg-bg-hover text-text-muted border border-border">
          {deployedServers.length} deployed
        </span>
        <button
          type="button"
          onClick={() => setMcpView('installed')}
          className="ml-auto text-[11px] text-accent-blue hover:text-accent-blue/80 transition-colors"
        >
          ← Back to all
        </button>
      </div>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0 flex-wrap">
        <div className="relative flex-1 min-w-[160px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted pointer-events-none" />
          <input
            type="text"
            placeholder="Search deployed MCP servers..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full h-8 pl-8 pr-3 rounded-lg bg-bg-hover/50 border border-border/80 text-text-primary placeholder:text-text-muted outline-none focus:border-border focus:bg-bg-primary transition-colors text-[var(--font-size)]"
          />
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={() => void refreshDeployed()}
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover"
            title="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setViewMode('grid')}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              viewMode === 'grid'
                ? 'bg-bg-selected text-text-primary'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
            )}
            title="Grid view"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setViewMode('list')}
            className={cn(
              'p-1.5 rounded-md transition-colors',
              viewMode === 'list'
                ? 'bg-bg-selected text-text-primary'
                : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
            )}
            title="List view"
          >
            <List className="h-3.5 w-3.5" />
          </button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setImportOpen(true)}
            className="h-8 px-3 ml-1 text-xs gap-1.5 font-medium"
          >
            <Plus className="h-3.5 w-3.5" /> Add MCP Server
          </Button>
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-text-muted text-[var(--font-size)]">
            Loading...
          </div>
        ) : filteredDeployed.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full min-h-[200px] text-text-muted gap-2 px-6">
            <p className="text-[var(--font-size)] text-text-secondary text-center">
              {deployedServers.length === 0
                ? 'No MCP servers deployed to this agent yet.'
                : 'No servers match the current search.'}
            </p>
          </div>
        ) : (
          <McpAgentServerList
            servers={filteredDeployed}
            viewMode={viewMode}
            onUndeploy={handleUndeploy}
          />
        )}
      </div>
      {importOpen && (
        <McpImportToAgentDialog
          agentId={agentId}
          availableServers={availableServers}
          onClose={() => setImportOpen(false)}
          onImport={handleImport}
        />
      )}
    </div>
  );
});

McpAgentContent.displayName = 'McpAgentContent';

export default McpAgentContent;
