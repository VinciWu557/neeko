import { Trash2 } from 'lucide-react';
import React from 'react';

import type { McpServer } from '@/shared/types/mcpServer';

interface McpAgentServerListProps {
  servers: McpServer[];
  viewMode: 'grid' | 'list';
  onUndeploy: (serverName: string) => void;
}

/**
 * 已部署服务器列表（grid / list 两种视图 + Undeploy 操作）。
 * 从 McpAgentContent 抽出（组件体积 ratchet），行为零漂移。
 */
const McpAgentServerList: React.FC<McpAgentServerListProps> = React.memo(
  ({ servers, viewMode, onUndeploy }) =>
    viewMode === 'grid' ? (
      <div className="p-3 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2 content-start">
        {servers.map((server) => (
          <div
            key={server.id}
            className="group flex flex-col rounded-lg border border-border bg-bg-primary hover:bg-bg-hover transition-colors p-3 gap-2 border-l-[3px] border-l-accent-blue"
          >
            <span className="text-[var(--font-size)] font-semibold text-text-primary truncate">
              {server.name}
            </span>
            {server.description && (
              <p className="text-[11px] text-text-muted line-clamp-2">{server.description}</p>
            )}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent-blue/10 text-accent-blue border border-accent-blue/20">
                {server.transport}
              </span>
              <span className="text-[10px] text-text-muted">{server.scope}</span>
            </div>
            <div className="flex items-center gap-1 mt-auto pt-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                type="button"
                className="flex-1 h-7 text-[11px] font-medium rounded-md border border-red/30 text-red hover:bg-red/10 flex items-center justify-center gap-1"
                onClick={() => void onUndeploy(server.name)}
              >
                <Trash2 className="h-3 w-3" /> Undeploy
              </button>
            </div>
          </div>
        ))}
      </div>
    ) : (
      <div className="flex flex-col gap-1 p-2">
        {servers.map((server) => (
          <div
            key={server.id}
            className="group flex items-center gap-3 px-3 py-2 rounded-lg border border-border bg-bg-primary hover:bg-bg-hover transition-colors border-l-[3px] border-l-accent-blue"
          >
            <div className="flex-1 min-w-0">
              <span className="text-[var(--font-size)] font-semibold text-text-primary">
                {server.name}
              </span>
              <span className="ml-2 text-[11px] text-text-muted">{server.transport}</span>
            </div>
            <button
              type="button"
              className="text-[10px] px-2 py-1 rounded border border-red/30 text-red hover:bg-red/10 transition-colors shrink-0"
              onClick={() => void onUndeploy(server.name)}
            >
              <Trash2 className="h-3 w-3" /> Undeploy
            </button>
          </div>
        ))}
      </div>
    ),
);

McpAgentServerList.displayName = 'McpAgentServerList';

export default McpAgentServerList;
