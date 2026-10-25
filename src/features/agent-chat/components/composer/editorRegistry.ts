import type { Editor } from '@tiptap/core';

/**
 * 富文本 composer 的编辑器注册表 —— 外部「往输入框塞文本」的唯一入口。
 *
 * # 为什么需要它
 *
 * 草稿的唯一真相是 tab data 的 `composerDoc`（`mergeTabData` 登记），编辑器本身
 * 是**非受控**的（design §4 单向闸门：store 回流永不回写编辑器）。于是「把文本
 * 投进正在编辑的 composer」这件事无法经 state 完成 —— 必须拿到编辑器实例。
 *
 * 形态照抄仓内同构先例（`agent-chat/api/agentInputRegistry.ts`、
 * `editor/api/aiActionRegistry.ts`）：身份键 + 注册/注销 + 未命中返回 false。
 * 调用方（`useAgentInputRegistration` 的 handler）据 false 降级到 clipboard。
 *
 * # 为什么键是 `(tabKey, tabId)` 而不是拼串
 *
 * `tabId` 本身含 `:`（见 `agentInputRegistry` 的 docstring：拼串会撞上 10-12
 * 决议 Q7 判死的同形缺陷），所以用嵌套 Map：外层是 tab 空间 `WorkspaceKey`，
 * 内层是 tabId。两个值都由调用方**已经持有**的身份直接下传，不从字符串反解
 * （红线 12）。
 */
const editors = new Map<string, Map<string, Editor>>();

/** 编辑器就绪时登记（同一身份重复登记以后者为准 —— StrictMode 重挂载的先来者是死实例）。 */
export function registerComposerEditor(tabKey: string, tabId: string, editor: Editor): void {
  let tabs = editors.get(tabKey);
  if (!tabs) {
    tabs = new Map<string, Editor>();
    editors.set(tabKey, tabs);
  }
  tabs.set(tabId, editor);
}

/** 注销：仅当登记的仍是同一个实例时才摘除（避免旧实例卸载时摘掉新实例）。 */
export function unregisterComposerEditor(tabKey: string, tabId: string, editor: Editor): void {
  const tabs = editors.get(tabKey);
  if (!tabs) return;
  if (tabs.get(tabId) !== editor) return;
  tabs.delete(tabId);
  if (tabs.size === 0) editors.delete(tabKey);
}

/**
 * 取某个 composer 的编辑器实例（未挂载/已销毁 → `null`）。
 *
 * 存在的理由：**「谁持有编辑器」必须只有一个答案**。发送按钮曾经自己存一份
 * `editorRef`（经 `onReady` prop 拿），而本注册表也存一份 —— 两条路各自演化时
 * 就会出现「按钮发的和 Enter 发的不是同一个编辑器」。
 */
export function getComposerEditor(tabKey: string, tabId: string): Editor | null {
  const editor = editors.get(tabKey)?.get(tabId);
  return editor && !editor.isDestroyed ? editor : null;
}

/**
 * 在光标处插入一段文本（带尾随空格，与拖拽/面板投递的既有形态一致）。
 *
 * @returns true = 有活着的编辑器且插入成功；false = 该 (tabKey, tabId) 没有
 *          登记（composer 未挂载/已销毁），调用方必须按「没落地」降级。
 */
export function insertIntoComposer(tabKey: string, tabId: string, text: string): boolean {
  const editor = editors.get(tabKey)?.get(tabId);
  if (!editor || editor.isDestroyed) return false;
  // 纯文本插入：不解析 HTML（投递内容是路径/提示词，`<b>` 之类必须字面保留）。
  editor.chain().focus().insertContent(`${text} `).run();
  return true;
}
