import { useCallback, useMemo } from 'react';

import { useEditorStore } from '@/shared/store/editorStore';
import { selectActiveTab } from '@/shared/store/editorTabSelectors';
import { relativeToRoot } from '@/shared/utils/fileRef';

/**
 * useLocateFileInTree — "locate current file in the file tree" wiring.
 *
 * Reads the currently active editor tab for `tabKey`; when it is a file tab,
 * returns its path so the Files panel can run the SAME selection flow as a
 * manual click (`handleSelectNode` + parent expansion). Locating is therefore
 * just "auto-finding" the file — everything after (highlight, scroll) reuses
 * the click-selection path instead of a separate active-file highlight.
 *
 * tab 的 filePath 恒为 canonical 绝对路径，而树节点路径相对树根
 * （worktree ?? 项目根）：`rootPath` 传入树根，路径在其下时剥根转相对再匹配。
 */
export function useLocateFileInTree(tabKey: string | null, rootPath?: string | null) {
  const activeTab = useEditorStore(
    useCallback(
      (s) => {
        if (!tabKey) return null;
        // 前台由布局派生（`selectActiveTab`）—— 同时订阅 `tabs` 与 `editorLayout`，
        // 前台切换才能触发重渲（旧读点只订阅 `tabs`，靠空间级投影的变化通知）。
        return selectActiveTab(s, tabKey);
      },
      [tabKey],
    ),
  );

  const filePath = useMemo(
    () =>
      activeTab?.data.kind === 'file'
        ? relativeToRoot(rootPath ?? '', activeTab.data.filePath)
        : null,
    [activeTab, rootPath],
  );

  return {
    /** True when the active tab is a file tab (locate button enabled). */
    canLocateFile: filePath !== null,
    /** 当前激活 file tab 的树相对路径；非 file tab 时为 null */
    filePath,
  };
}
