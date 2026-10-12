import { Search } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import type { McpServer } from '@/shared/types/mcpServer';
import { Button } from '@/ui/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/Dialog';

interface McpImportToAgentDialogProps {
  agentId: string;
  availableServers: McpServer[];
  onClose: () => void;
  onImport: (serverIds: string[]) => Promise<void>;
}

/**
 * 把未部署的 MCP server 勾选部署到指定 agent（搜索 + 传输过滤 + 全选 + 批量提交）。
 * 从 McpAgentContent 抽出（组件体积 ratchet），行为零漂移。
 */
const McpImportToAgentDialog: React.FC<McpImportToAgentDialogProps> = React.memo(
  ({ agentId, availableServers, onClose, onImport }) => {
    const [query, setQuery] = useState('');
    const [transportFilter, setTransportFilter] = useState<'all' | 'stdio' | 'http' | 'sse'>('all');
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [importing, setImporting] = useState(false);

    const filtered = useMemo(() => {
      let list = availableServers;
      if (query.trim()) {
        const q = query.toLowerCase();
        list = list.filter(
          (s) => s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q),
        );
      }
      if (transportFilter !== 'all') {
        list = list.filter((s) => s.transport === transportFilter);
      }
      return list;
    }, [availableServers, query, transportFilter]);

    const toggleAll = useCallback(() => {
      if (selected.size === filtered.length) setSelected(new Set());
      else setSelected(new Set(filtered.map((s) => s.id)));
    }, [filtered, selected]);

    const toggle = useCallback((id: string) => {
      setSelected((prev) => {
        const n = new Set(prev);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      });
    }, []);

    const handleImport = useCallback(async () => {
      if (selected.size === 0) return;
      setImporting(true);
      try {
        await onImport(Array.from(selected));
      } finally {
        setImporting(false);
      }
    }, [selected, onImport]);

    return (
      <Dialog open onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Add MCP Servers to {agentId}</DialogTitle>
          </DialogHeader>
          <div className="px-4 py-2 space-y-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted pointer-events-none" />
              <input
                type="text"
                placeholder="Search servers..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full h-8 pl-8 pr-3 rounded-lg bg-bg-hover/50 border border-border/80 text-text-primary placeholder:text-text-muted outline-none focus:border-border focus:bg-bg-primary transition-colors text-[var(--font-size)]"
              />
            </div>
            <div className="flex gap-1">
              {(['all', 'stdio', 'http', 'sse'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTransportFilter(t)}
                  className={cn(
                    'h-7 px-2.5 text-[11px] font-medium rounded-md border transition-colors',
                    transportFilter === t
                      ? 'bg-accent-blue/15 text-accent-blue border-accent-blue/40'
                      : 'text-text-muted border-border hover:bg-bg-hover',
                  )}
                >
                  {t === 'all' ? 'All' : t}
                </button>
              ))}
            </div>
            <div className="max-h-[300px] overflow-y-auto space-y-1">
              <label className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-text-muted cursor-pointer hover:bg-bg-hover rounded">
                <input
                  type="checkbox"
                  checked={selected.size === filtered.length && filtered.length > 0}
                  onChange={toggleAll}
                  className="accent-accent-blue"
                  aria-label="Select all"
                />
                <span>Select all ({filtered.length})</span>
              </label>
              {filtered.map((server) => (
                <label
                  key={server.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-bg-hover transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(server.id)}
                    onChange={() => toggle(server.id)}
                    className="accent-accent-blue"
                    aria-label={server.name}
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-[var(--font-size)] font-medium text-text-primary">
                      {server.name}
                    </span>
                    <span className="ml-2 text-[11px] text-text-muted">{server.transport}</span>
                  </div>
                </label>
              ))}
              {filtered.length === 0 && (
                <p className="text-[11px] text-text-muted text-center py-4">No servers available</p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={selected.size === 0 || importing}
              onClick={() => void handleImport()}
            >
              {importing ? 'Deploying...' : 'Deploy (' + selected.size + ')'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  },
);

McpImportToAgentDialog.displayName = 'McpImportToAgentDialog';

export default McpImportToAgentDialog;
