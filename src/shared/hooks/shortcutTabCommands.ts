import { useEditorStore } from '@/shared/store/editorStore';
import { selectActiveTabId } from '@/shared/store/editorTabSelectors';
import { useProjectStore } from '@/shared/store/projectStore';
import { activeWorkspaceKeyOf } from '@/shared/store/workspaceStore';
import { resolveNextTabId } from '@/shared/utils/cycleEditorTab';

/**
 * 快捷键的 **editor tab 命令面**（从 `useKeyboardShortcuts` 抽出）。
 *
 * 为什么独立成文件：`useKeyboardShortcuts.ts` 的单一职责是「键盘事件 → action 分派」，
 * 而这三个函数是「对当前 tab 空间做一次编辑器操作」——它们是另一类职责。
 * 原先寄居在同一文件把体积推过 300 行红线（护栏 `check_component_size` 是 **ratchet**：
 * 只许缩小，抬基线不算修），所以按仓内既有先例抽出（对照
 * `app/hooks/closeActiveTabCommand.ts` —— 同样是从 hook 里抽出的模块级命令）。
 *
 * 三个函数都不做「该往哪个 tab」的第二次决策：`resolveActiveTabKey` 走
 * `activeWorkspaceKeyOf` 这一唯一派生点（激活态单源，见
 * `.trellis/spec/frontend/state-management.md`），`cycleTab` 的下一个 tab 由
 * `resolveNextTabId` 纯函数算出。
 */

/**
 * 当前视图的 tab 空间键（= 激活 Workspace 的 `session.key`）。
 * 事件到达时现取（不闭包捕获），避免项目 / worktree 切换后持有过期键。
 * 无激活项目 → null（调用方据此 no-op，不制造伪身份）。
 */
export function resolveActiveTabKey(): string | null {
  const currentProjectId = useProjectStore.getState().activeProjectId ?? null;
  if (!currentProjectId) return null;
  return activeWorkspaceKeyOf(currentProjectId);
}

/** 在聚焦的编辑器组内循环 tab（IDEA Alt+Left/Right 语义）。 */
export function cycleTab(direction: 1 | -1): void {
  const editor = useEditorStore.getState();
  const tabKey = resolveActiveTabKey();
  if (!tabKey) return;

  const projectTabs = editor.tabs[tabKey];
  if (!projectTabs || projectTabs.tabs.length === 0) return;

  const nextId = resolveNextTabId({
    tabIds: projectTabs.tabs.map((t) => t.id),
    // 前台由布局派生（`selectActiveTabId`），不再读已删除的空间级投影。
    activeTabId: selectActiveTabId(editor, tabKey),
    layout: editor.editorLayout[tabKey] ?? null,
    direction,
  });
  if (nextId) editor.activateTab(tabKey, nextId);
}

/** 把当前激活 tab 分屏到右侧。 */
export function splitActiveTabRight(): void {
  const editor = useEditorStore.getState();
  const tabKey = resolveActiveTabKey();
  if (!tabKey) return;
  // 前台由布局派生（`selectActiveTabId`），不再读已删除的空间级投影。
  const tabId = selectActiveTabId(editor, tabKey);
  if (!tabId) return;
  editor.splitRight(tabKey, tabId);
}

/** 取消当前 tab 空间的分屏。 */
export function unsplitActiveEditor(): void {
  const tabKey = resolveActiveTabKey();
  if (!tabKey) return;
  useEditorStore.getState().unsplit(tabKey);
}
