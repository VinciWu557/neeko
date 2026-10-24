import { useMemo } from 'react';

import { useAgentStore } from '@/shared/store/agentStore';
import { isChatEnabled, type AgentConfig } from '@/shared/types/agent';

/**
 * 可对话 agent 列表 + 当前选中项的派生视图。
 *
 * # 为什么抽出来
 *
 * 这两件事都是**只读派生**：拉一次列表，再按 `agentId` 投影出展示用的三元组。
 * 它们与消息流、审批、附件无关，留在 `useAgentChat` 里只是让那个文件更长。
 *
 * # 为什么不再 fallback 到 `mockAgent`
 *
 * 旧实现把「还没有数据」伪装成「当前是 mockAgent」：`agentId` 未落定时硬编码
 * 返回 `AGENT_IDS.mockAgent`，于是首帧总是显示 mock 的名字与图标 —— 与用户实际
 * 选的 agent 无关。
 *
 * 正确语义是**未知**：列表加载出来之前没有「当前 agent」这回事。现在的顺序是
 *
 * 1. `agentId` 命中列表 → 用它的真实数据；
 * 2. 列表已加载但 `agentId` 未落定 → 取**列表首项**（后端给的就是默认顺序）；
 * 3. 列表还没到 → 空壳（渲染方显示占位图标）。
 *
 * 硬编码一个真实存在的 agent 名字比显示「未知」更糟：它会让用户以为选中了
 * mockAgent，而实际会话用的是别的。
 */
export interface ChatAgentsState {
  /** 全部可对话 agent。 */
  chatAgents: AgentConfig[];
  /** 当前选中的展示三元组（id / name / icon）。 */
  selectedAgent: { id: string; name: string; icon?: string | null };
}

export function useChatAgents(agentId: string | undefined): ChatAgentsState {
  // 从 **agentStore** 派生，而不是自己 `listChatAgents()` 一次。
  //
  // 曾经是「空依赖 useEffect + 独立 useState」：只在挂载时拉一次，于是
  // 用户在设置里关掉某个 agent 的 chat 后保存，这个列表仍是旧的 ——
  // 选中那一项才由 `adapter_for` 报错，而它看起来完全正常。
  // 现在 `saveAgent()` 的 refresh 直接反映到这里。
  const all = useAgentStore((s) => s.agents);
  const chatAgents = useMemo(() => (all ?? []).filter(isChatEnabled), [all]);

  const selectedAgent = useMemo(() => {
    // 1. 命中真实数据
    const found = agentId ? chatAgents.find((a) => a.id === agentId) : undefined;
    if (found) {
      return { id: found.id, name: found.name, icon: found.icon };
    }
    // 2. `agentId` 未落定（或不在列表里）→ 用列表首项，而不是硬编码某个 agent
    const first = chatAgents[0];
    if (first) {
      return { id: first.id, name: first.name, icon: first.icon };
    }
    // 3. 列表还没到 → 空壳（渲染方用占位图标）
    return { id: agentId ?? '', name: agentId ?? '', icon: null };
  }, [chatAgents, agentId]);

  return { chatAgents, selectedAgent };
}
