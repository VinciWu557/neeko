import { useProjectStore } from '@/shared/store/projectStore';
import { useActiveWorkspaceRoot } from '@/shared/store/workspaceStore';
import { resolveMarkdownBasePath } from '@/shared/utils/localAsset';

/**
 * markdown 图片相对路径的解析基准。
 *
 * 规则（`resolveMarkdownBasePath`）：显式传入的 `basePath`（md 文件目录 / skill 目录）
 * 优先，否则回落**当前Workspace根**（`useActiveWorkspaceRoot`，worktree 感知）。
 *
 * 为什么把查询收在 hook 里而不是让每个渲染点自己传：chat 消息 / PR 描述 / 会话消息
 * 都没有 md 文件语境，历史上正是因为「各渲染点自觉传 basePath」而三处漏传 ⇒ 图片全 404。
 * 统一在这里回落，渲染点只消费 `resolveAssetUrl(src, basePath)`。
 */
export function useAssetBasePath(explicit?: string): string | undefined {
  const projectId = useProjectStore((s) => s.activeProject?.id ?? null);
  const projectPath = useProjectStore((s) => s.activeProject?.path ?? null);
  const workspaceRoot = useActiveWorkspaceRoot(projectId, projectPath);
  return resolveMarkdownBasePath(explicit, workspaceRoot);
}
