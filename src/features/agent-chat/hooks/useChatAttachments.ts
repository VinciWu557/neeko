import { useCallback, useMemo, useState } from 'react';

import type { Attachment } from '../components/messageModel';

/**
 * 输入框附件（文件 / skill）的**一整组事实**：有哪些、怎么加、怎么删、
 * 派生计数、以及「怎么交给后端」。
 *
 * # 为什么整组抽出来
 *
 * 附件与消息流、审批、会话生命周期无耦合 —— 它只是 composer 的一个状态槽。
 * 留在 `useAgentChat` 里让那个 hook 继续贴着 ratchet 线，而每次新增一个
 * 附件来源（附件按钮、拖拽、@ 提及）都必须改它。
 *
 * # `id` 才是身份，`name` 只是展示
 *
 * 文件附件的 `id` 是**路径**：同名不同目录的两个文件必须能同时挂上，且后端
 * `ContextManifest.files` 的契约是「file paths」。把 `name` 当身份会让它们
 * 相互去重覆盖；把它当发送值会让后端收到一个无法定位的文件名。
 * 所以 `toRequestFiles` 明确取 `id` —— 这个决定只在这里做一次。
 *
 * skill 附件的情况不同：后端的 `skills` 字段就是 skill 的 name/id（不是路径），
 * 所以取 `name`。
 */
export interface ChatAttachments {
  /** 全部附件（文件 + skill）。 */
  attachments: Attachment[];
  /** 文件附件计数（composer 摘要用）。 */
  fileCount: number;
  /** skill 附件计数。 */
  skillCount: number;
  /** 附加一个文件（按路径去重）。 */
  addFile: (path: string, name: string) => void;
  /** 移除一个附件（按 `id`）。 */
  remove: (id: string) => void;
  /** 发给后端的路径 / skill 列表（契约的唯一产出点）。 */
  toRequestFiles: () => { files: string[]; skills: string[] };
}

export function useChatAttachments(): ChatAttachments {
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const addFile = useCallback((path: string, name: string) => {
    setAttachments((prev) =>
      prev.some((a) => a.type === 'FILE' && a.id === path)
        ? prev
        : [...prev, { id: path, type: 'FILE' as const, name, label: name }],
    );
  }, []);

  const remove = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const fileCount = useMemo(
    () => attachments.filter((a) => a.type === 'FILE').length,
    [attachments],
  );
  const skillCount = useMemo(
    () => attachments.filter((a) => a.type === 'SKILL').length,
    [attachments],
  );

  const toRequestFiles = useCallback(
    () => ({
      // 文件用 `id`（= 路径）；skill 用 `name`（后端字段就是 skill 标识）。
      files: attachments.filter((a) => a.type === 'FILE').map((a) => a.id),
      skills: attachments.filter((a) => a.type === 'SKILL').map((a) => a.name),
    }),
    [attachments],
  );

  return { attachments, fileCount, skillCount, addFile, remove, toRequestFiles };
}
