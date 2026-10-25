import { useCallback, useMemo, useState } from 'react';

import type { Attachment } from '../components/messageModel';

/**
 * composer 的 **skill 附件**槽（文件不再走这里）。
 *
 * # 文件附件为什么被移走
 *
 * 文件曾在此维护一份 `attachments` 状态（`@` 提及与附件按钮都往里写）。那是
 * **第二份表示**：编辑器里的 `@path` chip 才是用户看得见、删得掉的真相，而这份
 * state 与它没有任何同步 —— 退格删掉 chip 后附件仍在，且照样随消息的 `files`
 * 字段发出去（「以为移除了、实际没有」）。
 *
 * 现在文件由**文档投影**产出（`composer/editorSchema.ts` 的 `docToRequestFiles`）：
 * chip 在文档里存在 ⇔ 文件在请求里存在。本 hook 只剩 skill。
 *
 * # 已知缺口（不是本任务范围）
 *
 * 当前**没有任何 skill 附件的生产者**（全仓无 `addSkill` 调用点），所以这里的
 * `skills` 恒为空数组。保留它是为了不把「skill 注入」这条后端契约（
 * `ContextManifest.skills`）连同 UI 一起删掉 —— 那属于后续接 skill 选择器的任务。
 *
 * # `id` 才是身份，`name` 只是展示
 *
 * skill 附件的情况：后端的 `skills` 字段就是 skill 的 name/id（不是路径），
 * 所以取 `name`。
 */
export interface ChatAttachments {
  /** skill 附件计数（composer 摘要行用）。 */
  skillCount: number;
  /** 发给后端的 skill 列表（契约的唯一产出点）。 */
  toRequestSkills: () => string[];
}

export function useChatAttachments(): ChatAttachments {
  // 当前无 addSkill 生产者，state 恒为空；保留槽位是为了不删掉后端
  // `ContextManifest.skills` 契约（见模块文档的「已知缺口」）。
  const [attachments] = useState<Attachment[]>([]);

  const skillCount = useMemo(
    () => attachments.filter((a) => a.type === 'SKILL').length,
    [attachments],
  );

  const toRequestSkills = useCallback(
    () => attachments.filter((a) => a.type === 'SKILL').map((a) => a.name),
    [attachments],
  );

  return { skillCount, toRequestSkills };
}
