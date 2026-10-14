import { useCallback } from 'react';

import { useAppContext, useTerminalInsert } from '@/shared/contexts';
import { useCopyToClipboard } from '@/shared/hooks/useCopyToClipboard';
import type { PromptInsertTarget, PromptResource } from '@/shared/types/library';

/**
 * 把一个「已成形的 prompt」投递进工作区：terminal → agent 输入 → clipboard 兜底。
 *
 * 变量解析不在此处（属 `usePromptInsert`）：本 hook 只负责落地最终文本。消费方是
 * `PromptDialogHost` 与 `LibraryPanelWrapper` —— 投递语义只允许这一处定义。
 */
export function useInsertPromptToWorkspace() {
  const { showToast } = useAppContext();
  const copyToClipboard = useCopyToClipboard();
  const { api } = useTerminalInsert();

  return useCallback(
    (prompt: PromptResource, target: PromptInsertTarget = 'agent') => {
      if (target === 'terminal') {
        if (api.insertToTerminal?.(prompt.content)) {
          showToast(`Inserted "${prompt.name}" to terminal`, 'info');
          return;
        }
        // Terminal unavailable — fall through to agent insert.
        showToast('No active terminal — inserting to agent input', 'info');
      }

      // 判据是**「落地了吗」**，不是「函数存在吗」。旧写法判后者 —— 而
      // `insertToAgentInput` 由 ProjectView 恒注册（恒存在），于是「composer 优先 →
      // 降级 Agent CLI → 两边都没」这条链返回 false 时仍被当成成功，
      // 连 clipboard 兜底都进不去、也不弹 toast：用户按 Enter 什么也没发生。
      // （决议 Q5=A：投递接收端改为身份注册表后，成败才是结构上能回答的问题。）
      if (api.insertToAgentInput?.(prompt.content)) return;

      // Fallback: copy to clipboard.
      void copyToClipboard(prompt.content, 'prompt').then((ok) => {
        if (ok) showToast('Prompt copied to clipboard', 'info');
      });
    },
    [showToast, copyToClipboard, api],
  );
}
