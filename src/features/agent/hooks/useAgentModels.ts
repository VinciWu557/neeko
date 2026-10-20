import { useEffect, useState } from 'react';

import { listAgentModels, type ModelCatalogResult } from '../api/agentApi';

/**
 * 按 agent 拉取模型目录。
 *
 * ## 为什么抽成共享 hook
 *
 * 「agent 变了 → 重新取模型列表」这段逻辑在本仓已存在两份实现
 * （`agent-chat/hooks/useAgentChat.ts`、`editor/components/TranslationView.tsx`），
 * 设置页要再加第三份。三份的坑完全一样：**必须防 setState-after-unmount**
 * （拉取是异步的，agent 频繁切换时前一个请求可能后到，把旧列表盖在新选择上）。
 *
 * ## 为什么返回 `result` 而不是 `models`
 *
 * 三种处境对用户完全不同，压成空数组就无法区分：
 *
 * | 情况 | 用户该看到的 |
 * | --- | --- |
 * | 有列表 | 正常下拉 |
 * | `session-scoped` | 「模型在会话内可选」——协议限制，不是故障 |
 * | `unsupported` | 「此 Agent 不支持选择模型」——说明原因，不可操作 |
 * | 拉取失败 | 「无法获取模型列表」+ 可重试 |
 *
 * 前三者来自后端（`ModelCatalogResult`），第四者由本 hook 合成 —— 失败发生在
 * IPC 层，后端根本没机会回答。**失败必须可见**：静默降级会让「后端报错」看起来像
 * 「这个 agent 本来就没有模型」。
 */
export type AgentModelsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'available'; models: Extract<ModelCatalogResult, { kind: 'available' }>['models'] }
  | { kind: 'session-scoped' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };

export interface AgentModelsResult {
  state: AgentModelsState;
  /** 便捷视图：仅在 `available` 时非空。 */
  models: Extract<ModelCatalogResult, { kind: 'available' }>['models'];
  loading: boolean;
  /** 重新拉取（错误态下的「重试」）。 */
  reload: () => void;
}

export function useAgentModels(agentId: string | null | undefined): AgentModelsResult {
  /**
   * 一次拉取结果 + 它属于哪个 agent。
   *
   * 带上 `agentId` 是为了**派生**「当前列表是否已过期」：只存列表本身的话，
   * agent 切换瞬间列表仍是旧 agent 的，而清空只能靠 effect 里同步 setState
   * （React 反模式：级联渲染）。
   */
  const [entry, setEntry] = useState<{ agentId: string; state: AgentModelsState } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // 无 agent（如「使用默认」）→ 无模型可选。
    // 直接 return，不在这里 setState：同步 setState 会触发级联渲染，
    // 而「没有 agent 就没有模型」是**可派生**的事实，交给返回值算。
    if (!agentId) return;

    let cancelled = false;
    listAgentModels(agentId)
      .then((result) => {
        // 关键：切 agent 后旧请求可能晚到。不判 cancelled 会把旧列表盖在新选择上，
        // 表现为「换了 agent，模型下拉里还是上一个 agent 的模型」。
        if (!cancelled) setEntry({ agentId, state: result });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setEntry({
          agentId,
          state: {
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, attempt]);

  // 派生而非存储：`entry.agentId` 与当前 agent 不符时，结果属于上一个 agent，
  // 一律视为「还在加载」——这样不需要在 effect 里同步 setState 清空。
  const fresh = entry !== null && entry.agentId === agentId;
  const state: AgentModelsState = !agentId
    ? { kind: 'unsupported' }
    : !fresh
      ? { kind: 'loading' }
      : entry.state;

  return {
    state,
    models: state.kind === 'available' ? state.models : [],
    loading: state.kind === 'loading',
    reload: () => setAttempt((n) => n + 1),
  };
}
