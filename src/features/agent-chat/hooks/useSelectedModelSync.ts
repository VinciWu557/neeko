import { useEffect } from 'react';

import type { ModelInfo } from '@/features/agent/api/agentApi';
import type { SessionConfigOption } from '@/shared/types/agentChat';
import { currentModelFromConfigOptions } from '@/shared/types/agentChat';

/**
 * 让「选中的模型」与会话的真实状态保持一致。
 *
 * # 两件不同的事
 *
 * 1. **会话当前值优先**：agent 可以主动换模型（rate limit fallback），此时
 *    `configOptions.current_value` 是权威。UI 不跟上就会出现「显示 A、实际跑 B」。
 * 2. **否则保留用户选择**：还在列表里就不覆盖 —— 否则用户选一次就被默认值顶掉。
 * 3. **都没有才落到第一个**：agent 下发的顺序即首选顺序。
 *
 * # 为什么单独一个 hook
 *
 * 这是「选哪个」的**策略**，与「有哪些」（`useAgentModels` / `useModelsForPicker`）
 * 是不同职责。混在一起的后果是可测试性变差：策略需要针对三种输入组合分别断言，
 * 而列表获取只需断言「拉到了没有」。
 */
export function useSelectedModelSync(
  models: ModelInfo[],
  sessionConfigOptions: SessionConfigOption[],
  selectedModel: ModelInfo | null,
  setSelectedModel: (model: ModelInfo) => void,
): void {
  useEffect(() => {
    if (models.length === 0) return;

    // 1. 会话当前值是权威
    const authoritative = currentModelFromConfigOptions(sessionConfigOptions);
    if (authoritative && authoritative !== selectedModel?.id) {
      const match = models.find((m) => m.id === authoritative);
      if (match) {
        setSelectedModel(match);
        return;
      }
    }

    // 2. 已有选择且仍在列表里 → 保留
    if (selectedModel && models.some((m) => m.id === selectedModel.id)) return;

    // 3. 落到 agent 下发的首选
    setSelectedModel(models[0]);
    // selectedModel 只用于「是否保留」，不作为触发条件（否则选一次就再跑一轮）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, sessionConfigOptions]);
}
