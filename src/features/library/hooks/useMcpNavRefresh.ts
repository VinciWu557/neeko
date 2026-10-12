import { useEffect } from 'react';

import { useMcpStore } from '@/features/library/store/mcpStore';

/**
 * MCP 左栏自身的刷新（tag groups，含 serverCount）。
 * skill-store 计数（agents / projects / tag group 绑定数）由 `useSkillCountRefresh`
 * 负责 —— 与 Skills 左栏共用同一实现，此处不重复。
 */
export function useMcpNavRefresh(): void {
  const refreshMcpTagGroups = useMcpStore((s) => s.refreshMcpTagGroups);

  useEffect(() => {
    void refreshMcpTagGroups();
  }, [refreshMcpTagGroups]);
}
