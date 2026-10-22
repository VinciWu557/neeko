import { useCallback, useEffect, useState } from 'react';

import type { ModelInfo } from '@/features/agent/api/agentApi';
import { useEditorStore } from '@/shared/store/editorStore';

/**
 * 「当前选中模型」的状态 + 跨 tab 切换的持久化。
 *
 * # 为什么必须持久化
 *
 * `PaneContent` 只渲染 `activeTab` —— 切走就卸载 `AgentChatTabView`，组件局部
 * state 随之丢失。切回来重新挂载时若从 `null` 起步，`useSelectedModelSync` 会落到
 * `models[0]`（agent 下发的首选），用户看到「切个 tab 我的模型自己变了」。
 *
 * # 为什么不能只靠会话的 `configOptions.current_value`
 *
 * 它只在 `availability === 'ready'` 时可信：静默会话重建期间（切 agent、会话失效）
 * 拿不到。而且它描述的是「会话**正在用**哪个」—— 用户选了但还没发消息时两者
 * 本就该不同。
 *
 * # 为什么持久化放 effect 而不是 `selectModel`
 *
 * 有两个写入来源，都必须覆盖：
 * - 用户点选（`useModelSelection.selectModel`）
 * - 会话主动换模型（`useSelectedModelSync`，如 rate limit fallback）
 *
 * 后者若不持久化，切走再回来会显示用户上次手选的模型、而会话实际在跑另一个 ——
 * 那正是「UI 显示 A、实际跑 B」。放在 `selectedModel` 变化的 effect 上，两个来源
 * 自动都覆盖，且**只有一个写点**。
 *
 * # 只存 id
 *
 * `name` / `group` 等展示字段由列表按 id 反查。存整份 `ModelInfo` 会在 agent
 * 更新模型名后变成过期快照。
 */
export interface SelectedModelState {
  /** 当前选中模型；`null` = 还没落定（由 `useSelectedModelSync` 填）。 */
  selectedModel: ModelInfo | null;
  setSelectedModel: (model: ModelInfo | null) => void;
  /**
   * 丢掉当前选择（切换 agent 时调用）。
   *
   * # 为什么必须清
   *
   * 旧 agent 的模型 id 对新 agent 可能根本不存在（Pi 的 `deepseek-v4-pro` 与
   * opencode 的 `anthropic/claude-sonnet-4-5` 毫无交集）。留着它有两个后果：
   *
   * 1. `useAgentSessionLifecycle` 会把它当 `modelId` 传给 `agent_chat_open`，
   *    ACP 在 `create()` 里预切模型 → 新 agent 收到一个不认识的 id；
   * 2. UI 显示一个列表里根本没有的模型（`useSelectedModelSync` 的 `models.find`
   *    找不到 → 回落到 `models[0]`，但持久化值仍是旧的）。
   *
   * 清成 `null` 之后 `useSelectedModelSync` 会落到新 agent 的首选模型。
   */
  clear: () => void;
}

export function useSelectedModel(
  tabKey: string,
  tabId: string,
  initialModelId: string | undefined,
): SelectedModelState {
  // 初值取自 tab data：只有 id，展示字段先按 id 占位 —— `useSelectedModelSync`
  // 会拿列表里的真实条目替换它（同一个 id，UI 不会闪）。
  const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(() =>
    initialModelId ? { id: initialModelId, name: initialModelId } : null,
  );

  // 唯一写点：用户点选与会话主动换模型都经过 `selectedModel` 变化。
  //
  // `null` 也要写（`modelId: undefined`）：切换 agent 清空选择后，tab data 若
  // 留着旧 id，切回来重新挂载会把它当初值复活 —— 表现是「换了 agent，模型名
  // 还是上一个 agent 的」。
  useEffect(() => {
    useEditorStore.getState().updateTab(tabKey, tabId, { modelId: selectedModel?.id });
  }, [selectedModel, tabKey, tabId]);

  const clear = useCallback(() => setSelectedModel(null), []);

  return { selectedModel, setSelectedModel, clear };
}
