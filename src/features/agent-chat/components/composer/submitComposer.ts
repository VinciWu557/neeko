import type { Editor } from '@tiptap/core';

import type { ComposerDocJson } from '@/shared/types/tab';

import { docToPromptText, docToRequestFiles } from './editorSchema';

/** 一次提交的内容：prompt 纯文本 + 由文档投影出的文件列表。 */
export interface ComposerSubmission {
  /** 序列化后的 prompt（命令 chip → `/name `、文件 chip → `@path `）。 */
  promptText: string;
  /**
   * 请求的 `files` 字段 —— **文档的投影**（`docToRequestFiles`），不是另存的附件
   * 列表。删掉 chip 就等于不再发送该文件，不存在「移除后仍在发」的分叉。
   */
  files: string[];
}

/**
 * 内容是否「实质为空」——**唯一判据**，发送前校验与发送按钮禁用都问它。
 *
 * # 为什么必须共用
 *
 * 曾经有两份：按钮用 `editor.isEmpty`（ProseMirror 语义），发送用
 * `promptText.trim().length === 0`（序列化语义）。两者在「只输入了空格」时
 * 不一致 —— `isEmpty` 为 `false`（有文本节点）但 trim 后为空，于是
 * **按钮可点、点了什么都不发生**。这正是本仓反复出现的「函数存在但什么都不做」。
 *
 * 判据取序列化后 trim：它才是「这条消息有没有内容」的真实定义。
 */
export function isComposerEmpty(doc: ComposerDocJson): boolean {
  return docToPromptText(doc).trim().length === 0;
}

/**
 * 发送路径的**单一实现**：Enter 键与发送按钮都调它。
 *
 * 分成两处实现会立刻分叉 —— 按钮走纯文本、Enter 走序列化（或反过来），
 * 于是「点按钮发的和按 Enter 发的不是同一个 prompt」。这正是本仓反复出现的
 * 「同一事实两个派生点」形态，故收敛成一个函数。
 *
 * @returns true = 已发送（编辑器已清空）；false = 内容为空，什么都没发生
 *          （空内容按 Enter 既不发送也不留空行）。
 */
export function submitComposer(
  editor: Editor,
  onSend: (submission: ComposerSubmission) => void,
): boolean {
  const doc = editor.getJSON() as ComposerDocJson;
  if (isComposerEmpty(doc)) return false;
  onSend({ promptText: docToPromptText(doc), files: docToRequestFiles(doc) });
  editor.commands.clearContent();
  return true;
}
