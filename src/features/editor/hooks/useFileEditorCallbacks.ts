import { closeSearchPanel, openSearchPanel, searchPanelOpen } from '@codemirror/search';
import type { EditorView } from '@codemirror/view';
import { useCallback, type RefObject } from 'react';

import { useCopyToClipboard } from '@/shared/hooks/useCopyToClipboard';
import { useNotificationStore } from '@/shared/store/notificationStore';

import { useFileActionsContext } from '../FileActionsContext';

interface Params {
  /** CodeMirror 视图引用（页内搜索需要它开合查找面板）。 */
  editorViewRef: RefObject<EditorView | null>;
}

/** FileEditor 的视图级交互回调：内部链接跳转 / 页内搜索 / 复制选中文本。 */
export function useFileEditorCallbacks({ editorViewRef }: Params) {
  // Markdown / HTML preview 模式下点击内部链接时打开目标文件
  const { onFileSelect } = useFileActionsContext();
  const handleInternalLinkClick = useCallback(
    async (absPath: string) => {
      if (!onFileSelect) return;
      const ok = await onFileSelect(absPath);
      if (!ok) {
        useNotificationStore
          .getState()
          .addNotification({ type: 'error', title: 'Cannot Open File', message: absPath });
      }
    },
    [onFileSelect],
  );

  // 页内内容搜索：标题栏「搜索」按钮开合 CodeMirror 查找面板（Ctrl+F 由 searchKeymap 承担）
  const handleOpenSearch = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) return;
    if (searchPanelOpen(view.state)) closeSearchPanel(view);
    else openSearchPanel(view);
  }, [editorViewRef]);

  // 复制选中文本：单一真值是当前 selection（不再为它另存一份文本 state ——
  // 那会与 selectionLines 构成同一事实的双表示）。
  // 剪贴板写入复用唯一入口 useCopyToClipboard（Tauri 插件优先免权限提示）。
  const copyToClipboard = useCopyToClipboard();
  const handleCopySelection = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) return;
    const range = view.state.selection.main;
    if (range.empty) return;
    void copyToClipboard(view.state.sliceDoc(range.from, range.to));
  }, [editorViewRef, copyToClipboard]);

  return { handleInternalLinkClick, handleOpenSearch, handleCopySelection };
}
