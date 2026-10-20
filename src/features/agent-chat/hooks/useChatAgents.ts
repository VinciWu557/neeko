import { useEffect, useMemo, useState } from 'react';

import { listChatAgents } from '@/features/agent/api/agentApi';
import { AGENT_IDS } from '@/shared/constants/agentIds';
import type { AgentConfig } from '@/shared/types/agent';

/**
 * 可对话 agent 列表 + 当前选中项的派生视图。
 *
 * # 为什么抽出来
 *
 * 这两件事都是**只读派生**：拉一次列表，再按 `agentId` 投影出展示用的三元组。
 * 它们与消息流、审批、附件无关，留在 `useAgentChat` 里只是让那个文件更长。
 *
 * # 为什么 fallback 用 mockAgent
 *
 * `agentId` 尚未落定时（首帧 / 会话未建），UI 仍需要一个可渲染的图标与名字。
 * 用 mockAgent 是既有约定 —— 它必定存在于内置列表里，且不产生真实网络副作用。
 */
export interface ChatAgentsState {
  /** 全部可对话 agent。 */
  chatAgents: AgentConfig[];
  /** 当前选中的展示三元组（id / name / icon）。 */
  selectedAgent: { id: string; name: string; icon?: string | null };
}

export function useChatAgents(agentId: string | undefined): ChatAgentsState {
  const [chatAgents, setChatAgents] = useState<AgentConfig[]>([]);

  useEffect(() => {
    let disposed = false;
    void listChatAgents()
      .then((agents) => {
        if (!disposed) setChatAgents(agents);
      })
      .catch(() => {
        if (!disposed) setChatAgents([]);
      });
    return () => {
      disposed = true;
    };
  }, []);

  const selectedAgent = useMemo(() => {
    const found = agentId ? chatAgents.find((a) => a.id === agentId) : undefined;
    if (found) {
      return { id: found.id, name: found.name, icon: found.icon };
    }
    const fallback = agentId ?? AGENT_IDS.mockAgent;
    return { id: fallback, name: fallback, icon: null };
  }, [chatAgents, agentId]);

  return { chatAgents, selectedAgent };
}
