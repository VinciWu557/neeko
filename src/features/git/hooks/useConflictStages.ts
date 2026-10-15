import { listen } from '@tauri-apps/api/event';
import { useCallback, useEffect, useState } from 'react';

import { GIT_STATUS_SNAPSHOT_EVENT } from '@/shared/events';
import { useFileChangedEvent } from '@/shared/hooks/useFileChangedEvent';
import { useGitRefresh } from '@/shared/hooks/useGitRefresh';
import type { ConflictStages, FileChangedEvent, GitStatusSnapshot } from '@/shared/types';
import type { ProjectCommands } from '@/shared/types/activeProject';
import { safeUnlisten } from '@/shared/utils/safeUnlisten';
import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

interface UseConflictStagesParams {
  commands?: ProjectCommands | null;
  workspace: WorkspaceSession;
  filePath: string;
}

/**
 * 冲突文件三态（index unmerged stages）的**无状态消费者** —— 与 `useDiffData` 同构：
 * 三刷新信号（`file-changed` + `git-status-snapshot` + Git 面板刷新）任一命中即重拉，
 * 组件不做跨挂载缓存。
 *
 * **R10（本 hook 的关键契约）**：读命令以 `Err` 表达「该 path 不是冲突」（已解决 / 非冲突）。
 * 这条必须映射为 `notConflicted`（**正常收敛**，UI 据此回退普通 diff 视图），**不是 `error`**
 * —— 把「已解决」画成错误等于给用户一个假警报。
 */
export function useConflictStages({ commands, workspace, filePath }: UseConflictStagesParams) {
  const [stages, setStages] = useState<ConflictStages | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notConflicted, setNotConflicted] = useState(false);
  // 刷新信号版本号：三信号命中时递增，驱动重新拉取。
  const [refreshTick, setRefreshTick] = useState(0);

  const projectId = workspace.projectId;

  const load = useCallback(async () => {
    if (!filePath) {
      setStages(null);
      setLoading(false);
      setError(null);
      setNotConflicted(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = commands
        ? await commands.getConflictStages(filePath)
        : await (await import('../api/gitApi')).getConflictStages(workspace, filePath);
      setStages(result);
      setNotConflicted(false);
    } catch (err) {
      // 读命令的 Err = 「不是冲突」（无 unmerged 条目）→ 正常收敛，不是错误态。
      // 已解决时后端与工作区都合法，残余 stages 必须清空以免继续渲染旧三侧。
      setStages(null);
      setNotConflicted(true);
      setError(null);
      console.debug('[useConflictStages] not conflicted (converged):', filePath, err);
    } finally {
      setLoading(false);
    }
  }, [commands, workspace, filePath]);

  // 文件内容变更（精确路径）→ 重拉
  useFileChangedEvent(
    useCallback(
      (ev: FileChangedEvent) => {
        if (!filePath) return;
        if (ev.project_id !== projectId) return;
        if (!ev.paths.includes(filePath)) return;
        setRefreshTick((t) => t + 1);
      },
      [projectId, filePath],
    ),
  );

  // 仓库状态事件（路径无关）→ 重拉（写后 unmerged 收敛主要靠这条）
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<GitStatusSnapshot>(GIT_STATUS_SNAPSHOT_EVENT, (event) => {
      if (cancelled) return;
      if (event.payload.project_id === projectId) setRefreshTick((t) => t + 1);
    }).then((un) => {
      if (cancelled) safeUnlisten(un)();
      else unlisten = safeUnlisten(un);
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [projectId]);

  // Git 面板刷新按钮 → 重拉
  useGitRefresh(
    useCallback(
      (pid: string) => {
        if (pid !== projectId) return;
        setRefreshTick((t) => t + 1);
      },
      [projectId],
    ),
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载 / 信号驱动重拉（项目既有模式）
    void load();
  }, [load, refreshTick]);

  return { stages, loading, error, notConflicted, reload: load };
}
