import { useEffect, useState } from 'react';

import { listAgentModels, type ModelInfo } from '../api/agentApi';

/**
 * 按 agent 拉取其可用模型列表。
 *
 * ## 为什么抽成共享 hook
 *
 * 「agent 变了 → 重新取模型列表」这段逻辑在本仓已存在两份实现
 * （`agent-chat/hooks/useAgentChat.ts`、`editor/components/TranslationView.tsx`），
 * 设置页要再加第三份。三份的坑完全一样：**必须防 setState-after-unmount**
 * （拉取是异步的，agent 频繁切换时前一个请求可能后到，把旧列表盖在新选择上）。
 *
 * ## 失败为什么静默
 *
 * 模型列表是**可选项的便利**，不是功能前提：取不到时选择器退回「agent 默认」，
 * 翻译照常可用。弹错误提示反而干扰 —— 用户并没有主动要求模型列表。
 */
export interface AgentModelsResult {
  models: ModelInfo[];
  /** 拉取中（选择器可据此显示占位）。 */
  loading: boolean;
}

export function useAgentModels(agentId: string | null | undefined): AgentModelsResult {
  /**
   * 一次拉取结果 + 它属于哪个 agent。
   *
   * 带上 `agentId` 是为了**派生**「当前列表是否已过期」：只存列表本身的话，
   * agent 切换瞬间列表仍是旧 agent 的，而清空只能靠 effect 里同步 setState
   * （React 反模式：级联渲染）。
   */
  const [entry, setEntry] = useState<{
    agentId: string;
    models: ModelInfo[];
    loading: boolean;
  } | null>(null);

  useEffect(() => {
    // 无 agent（如「使用默认」）→ 无模型可选。
    // 直接 return，不在这里 setState：同步 setState 会触发级联渲染，
    // 而「没有 agent 就没有模型」是**可派生**的事实，交给返回值算。
    if (!agentId) return;

    let cancelled = false;
    listAgentModels(agentId)
      .then((list) => {
        // 关键：切 agent 后旧请求可能晚到。不判 cancelled 会把旧列表盖在新选择上，
        // 表现为「换了 agent，模型下拉里还是上一个 agent 的模型」。
        if (!cancelled) {
          setEntry({ agentId, models: list, loading: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEntry({ agentId, models: [], loading: false });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // 派生而非存储：`entry.agentId` 与当前 agent 不符时，列表属于上一个 agent，
  // 一律视为「还在加载」——这样不需要在 effect 里同步 setState 清空。
  const fresh = entry !== null && entry.agentId === agentId;
  return {
    models: fresh ? entry.models : [],
    loading: Boolean(agentId) && !fresh,
  };
}
