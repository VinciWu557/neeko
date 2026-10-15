/**
 * Tauri IPC bridge for file search commands.
 *
 * `runSearch` returns an active page; repeat with the returned cursor to page
 * through results. `stopSearch` cancels an in-flight search by request id.
 */
import { invoke } from '@tauri-apps/api/core';

import type { SearchOptions, SearchResponse } from '@/shared/types/search';
import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

export const SEARCH_COMMANDS = {
  run: 'search_run',
  stop: 'search_stop',
} as const;

/** Start or continue a paginated search.
 *
 * `workspace` 是**地址**（`{ projectId, worktreePath }`）—— 后端据此取根
 * （≡ `worktreePath ?? project.path`）。与 `gitApi` / `fileApi` 同形；
 * 传裸 `projectId` 会让 worktree 视图扫到主仓（且结果路径基准错位）。 */
export async function runSearch(params: {
  workspace: WorkspaceSession;
  query: string;
  requestId: string;
  options?: SearchOptions;
  offset?: number;
  limit?: number;
}): Promise<SearchResponse> {
  return invoke<SearchResponse>(SEARCH_COMMANDS.run, {
    workspace: params.workspace,
    query: params.query,
    requestId: params.requestId,
    options: params.options ?? null,
    offset: params.offset ?? null,
    limit: params.limit ?? null,
  });
}

/** Cancel an in-flight search by request id. */
export async function stopSearch(requestId: string): Promise<void> {
  return invoke<void>(SEARCH_COMMANDS.stop, { requestId });
}
