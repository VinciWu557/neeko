import { useEffect, useMemo, useRef, useState } from 'react';

import { useFileStore } from '@/features/file/store';
import { useSearchStore } from '@/features/search/store/searchStore';
import type { SearchFileGroup, SearchOptions } from '@/shared/types/search';
import { getFileName } from '@/shared/utils/fileTree';
import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

const DEBOUNCE_MS = 300;

export type ShowToastFn = (message: string, type?: 'info' | 'error') => void;

/** Serialize options for dependency identity (avoid object-identity churn). */
function optionsKey(options: SearchOptions): string {
  return JSON.stringify(options);
}

/** Collect all file paths from the flat directory cache. */
function collectAllFiles(dirs: Record<string, { path: string; is_dir: boolean }[]>): string[] {
  const files: string[] = [];
  for (const entries of Object.values(dirs)) {
    for (const entry of entries) {
      if (!entry.is_dir) {
        files.push(entry.path);
      }
    }
  }
  return files;
}

/** Filter files by name matching the query. */
function filterFilesByName(files: string[], query: string): SearchFileGroup[] {
  const q = query.toLowerCase();
  const groups: SearchFileGroup[] = [];
  for (const path of files) {
    // basename 走共享 helper（会先归一 `\`）—— 不在此处自造 `split('/').pop()`。
    const fileName = getFileName(path);
    if (fileName.toLowerCase().includes(q)) {
      groups.push({
        path,
        matches: [], // No content matches for file name results
      });
    }
  }
  return groups;
}

/**
 * Debounced, life-cycle-safe search driver.
 *
 * Searches both file names (locally) and content (backend) simultaneously.
 * File name matches are displayed first, followed by content matches.
 *
 * **地址 = `WorkspaceSession`**（与 file / git 域同形）：文件名匹配读 `fileStore`
 * （其 owner 已含单元根），内容匹配交给后端 —— 两条链路的根由此**同源**。
 * 传入 `session.key` 作为重置依赖：切换 worktree 时必须丢掉上一个单元的搜索结果
 * （否则结果里混着旧根的相对路径，点开会打到另一个对象）。
 */
export function useSearch(
  workspace: WorkspaceSession | null,
  showToast: ShowToastFn,
  options: SearchOptions = {},
) {
  const workspaceKey = workspace?.key ?? null;
  const [query, setQuery] = useState('');
  const [committed, setCommitted] = useState('');
  const [fileNameMatches, setFileNameMatches] = useState<SearchFileGroup[]>([]);

  const run = useSearchStore((s) => s.run);
  const stop = useSearchStore((s) => s.stop);
  const clear = useSearchStore((s) => s.clear);
  const fileGroups = useSearchStore((s) => s.fileGroups);
  const status = useSearchStore((s) => s.status);
  const truncated = useSearchStore((s) => s.truncated);
  const error = useSearchStore((s) => s.error);

  const fileDirs = useFileStore((s) => s.dirs);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest-value 镜像：防抖 effect 在 300ms 后要读**最新** options / workspace，但它的依赖
  // 只挂原始值（`optionsSignature` / `workspaceKey`）—— 对象身份变化不该重置防抖窗口。
  // 两个镜像 ref 在**同一个 effect** 中同步（`src/AGENTS.md` 前端架构约定 3「Ref 同步集中」）；
  // 不能改成渲染期赋值：`react-hooks/refs` 是 error。
  const optionsRef = useRef(options);
  const workspaceRef = useRef(workspace);
  useEffect(() => {
    optionsRef.current = options;
    workspaceRef.current = workspace;
  }, [options, workspace]);

  // All files from the file tree cache.
  const allFiles = useMemo(() => collectAllFiles(fileDirs), [fileDirs]);

  // Serialized options for dependency identity (avoid object-identity churn).
  const optionsSignature = useMemo(() => optionsKey(options), [options]);

  // 切换单元 ⇒ 丢掉上一个单元的搜索结果与本地文件名匹配（两者基准都已变）。
  // 只靠 store 内的 `clear` 不够：`fileNameMatches` 是本 hook 的本地 state。
  const prevWorkspaceKeyRef = useRef<string | null>(workspaceKey);
  useEffect(() => {
    if (prevWorkspaceKeyRef.current === workspaceKey) return;
    prevWorkspaceKeyRef.current = workspaceKey;
    clear();
    setFileNameMatches([]);
    setQuery('');
    setCommitted('');
  }, [workspaceKey, clear]);

  // 为什么 workspace 要从 ref 读（而不是进防抖 effect 的依赖）：调用方每次渲染新建
  // `WorkspaceSession`（如渲染期调命令式 mint）会把防抖 effect 反复重置，300ms 窗口永
  // 远等不到 ⇒ 搜索被**饿死**（已用重渲染风暴实测复现）。镜像同步见上方合并后的 effect。

  // Debounced trigger: restart search once the query settles. All state
  // updates happen inside the timeout callback (never synchronously in the
  // effect body) so the debounce window also covers query clearing.
  //
  // 依赖是 `workspaceKey`（字符串）而非 `workspace`（对象）：同一单元的任何重建都不该重置防抖窗口。
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const target = workspaceRef.current;
      if (!target || !query.trim()) {
        setFileNameMatches([]);
        return;
      }
      setCommitted(query);
      // Always search file names locally.
      setFileNameMatches(filterFilesByName(allFiles, query));
      // Always search content via backend.
      void run(target, query, optionsRef.current);
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, workspaceKey, optionsSignature, allFiles, run]);

  // Cancel the backend request when the panel unmounts.
  useEffect(() => {
    return () => {
      void stop();
    };
  }, [stop]);

  // Show errors via the global toast notification.
  useEffect(() => {
    if (error) {
      showToast(error, 'error');
    }
  }, [error, showToast]);

  // Combined results: file name matches first, then content matches.
  const combinedGroups = useMemo(() => {
    return [...fileNameMatches, ...fileGroups];
  }, [fileNameMatches, fileGroups]);

  const totalMatches = useMemo(() => {
    const fileNameCount = fileNameMatches.length;
    const contentCount = fileGroups.reduce((sum, g) => sum + g.matches.length, 0);
    return fileNameCount + contentCount;
  }, [fileNameMatches, fileGroups]);

  const clearAll = () => {
    clear();
    setFileNameMatches([]);
    setQuery('');
  };

  return {
    query,
    setQuery,
    committed,
    fileGroups: combinedGroups,
    fileNameMatches,
    status,
    truncated,
    clear: clearAll,
    totalMatches,
  };
}
