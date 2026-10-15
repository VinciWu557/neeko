import React from 'react';

import { useActiveProject } from '@/features/project';
import { SearchPanel } from '@/features/search';
import { useActiveWorkspaceSession } from '@/shared/store/workspaceStore';

/**
 * Search dock 面板适配层：把「当前视图是哪个 Workspace」派生成搜索地址。
 *
 * **搜索根 = 激活单元根**（`worktreePath ?? project.path`，≡ Rust `WorkspaceRef::root()`），
 * 与 file / terminal / git 域的运行根同一定义。worktree 激活时扫的就是该 worktree；
 * 曾经传裸 `projectId`（后端直取 `project.path`）会让 worktree 视图扫主仓，且结果路径
 * 相对主仓根、点击打开却相对单元根解析 —— 同一份结果里两种基准。
 *
 * 地址铸造点是唯一 mint，**且必须是 React 形态** [`useActiveWorkspaceSession`]（`useShallow`
 * 保证同一单元跨渲染引用稳定）—— 渲染期调命令式 `activeWorkspaceSession` 会每次新建对象，
 * 把下游 `useSearch` 的防抖 effect 反复重置（搜索饿死，实测复现）。与
 * `ConversationsPanelWrapper` 的 tab 键取法同源。
 */
const SearchPanelWrapper: React.FC = React.memo(() => {
  const { project } = useActiveProject();

  // 渲染期需要身份值时经唯一 mint 取（不得手拼 `{ projectId, worktreePath }`）。
  const workspace = useActiveWorkspaceSession(project?.id ?? null);

  return <SearchPanel workspace={workspace} />;
});
SearchPanelWrapper.displayName = 'SearchPanelWrapper';

export default SearchPanelWrapper;
export { SearchPanelWrapper };
