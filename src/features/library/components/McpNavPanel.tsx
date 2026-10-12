import React from 'react';

import { useSkillCountRefresh } from '@/features/skill';

import { useMcpNavRefresh } from '../hooks/useMcpNavRefresh';

import McpAgentGroupList from './McpAgentGroupList';
import McpProjectGroupList from './McpProjectGroupList';
import McpTagGroupTree from './McpTagGroupTree';
import McpViewSwitcher from './McpViewSwitcher';

/**
 * MCP navigation panel — pure composition: view switcher + tag group tree +
 * agent group list + project group list.
 *
 * 刷新职责已按来源拆分（此前为三个内联 effect）：
 * - MCP 自身数据（tag groups）→ `useMcpNavRefresh`
 * - skill-store 计数（agents / projects）→ `useSkillCountRefresh`，与 Skills 左栏共用
 */
const McpNavPanel: React.FC = React.memo(() => {
  useMcpNavRefresh();
  useSkillCountRefresh();

  return (
    <nav className="py-2 px-1.5" aria-label="MCP views">
      <McpViewSwitcher />
      <McpTagGroupTree />
      <McpAgentGroupList />
      <McpProjectGroupList />
    </nav>
  );
});

McpNavPanel.displayName = 'McpNavPanel';

export default McpNavPanel;
