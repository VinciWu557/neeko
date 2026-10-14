import {
  foregroundAgentChatTabs,
  foregroundAgentCliTab,
  insertToTerminalTarget,
  type InsertToSessionTerminalResult,
} from '@/features/terminal';
import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

import { insertAgentInput } from './agentInputRegistry';

/**
 * agent 目标投递的唯一编排（决议 Q1）：**composer 优先 → 降级 Agent CLI 终端 → 显式 false**。
 *
 * **为什么住在 agent-chat 侧**（10-13 结构整理 S1）：terminal 域只提供「有序序列上的前台仲裁」
 * （`foregroundTerminalTab` / `foregroundAgentCliTab` / `foregroundAgentChatTabs`）与「把文本写进
 * 指定目标」（`insertToTerminalTarget`）。把 composer（agent-chat 的输入框）作为首选目标的编排
 * 留在 terminal 域，会让 terminal **反向依赖** agent-chat。迁到 agent-chat 后依赖方向单向：
 * agent-chat（高层编排）→ terminal（低层仲裁）。本文件因此可以 import terminal 门面 +
 * 同域的 `agentInputRegistry`，而 terminal 域不再 import agent-chat。
 *
 * 存在的理由：被删除的 `INSERT_TO_AGENT_INPUT_EVENT` 有三个派发点、**全历史零个监听者**
 * （`git log --all -S"addEventListener(INSERT_TO_AGENT_INPUT_EVENT"` → 0 条），
 * 而 `useInsertPromptToWorkspace` 判的是「函数存在吗」（恒存在）而非「落地了吗」——
 * 于是连 clipboard 兜底都进不去，用户按 Enter 什么也没发生。
 * 本函数返回**真实成败**，使那条降级链重新可达。
 */
export function insertToSessionAgent(
  session: WorkspaceSession,
  text: string,
): InsertToSessionTerminalResult {
  // 沿 order 升序逐个试 composer：未挂载的 composer 不存在于 registry（返回 false）→ 下一个候选。
  for (const candidate of foregroundAgentChatTabs(session)) {
    if (insertAgentInput(session, candidate.tab.id, text)) {
      return {
        ok: true,
        landedTabTitle: candidate.tab.title,
        isFallback: candidate.isFallback,
      };
    }
  }

  const cli = foregroundAgentCliTab(session);
  if (!cli) return { ok: false };
  return insertToTerminalTarget(session, cli, text);
}
