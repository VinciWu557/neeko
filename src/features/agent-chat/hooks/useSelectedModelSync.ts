import { useEffect, useRef } from 'react';

import type { ModelInfo } from '@/features/agent/api/agentApi';
import type { SessionConfigOption } from '@/shared/types/agentChat';
import { currentModelFromConfigOptions } from '@/shared/types/agentChat';
import { hasModelId, resolveModelById, type ModelAvailability } from '@/shared/utils/modelTarget';

/**
 * 让「选中的模型」与会话的真实状态保持一致。
 *
 * # 两件不同的事
 *
 * 1. **会话当前值变化时跟随**：agent 可以主动换模型（rate limit fallback），
 *    此时 `configOptions.current_value` 是权威。UI 不跟上就会出现「显示 A、实际跑 B」。
 * 2. **否则保留用户选择**：还在列表里就不覆盖 —— 否则用户选一次就被默认值顶掉。
 * 3. **都没有才落到第一个**：agent 下发的顺序即首选顺序。
 *
 * # 为什么必须判「当前值**变了**」而不是「当前值存在」
 *
 * `configOptions` 会因为**与模型无关的原因**刷新 —— 最典型的是切推理档位：
 * 后端 `refresh_configs` 会重拉模型列表与档位（档位可选项随模型变化，必须重拉），
 * 顺带把模型项的 `current_value` 也重报一遍。
 *
 * 若判据是「当前值存在且 ≠ 已选」，这次刷新就会把用户刚选的新模型**打回**会话当前值
 * —— 表现为「选完模型再选思考等级，模型自己变了」。而 `current_value` 描述的是
 * **会话正在用的**模型，用户选了还没发消息时两者本就该不同。
 *
 * # 为什么单独一个 hook
 *
 * 这是「选哪个」的**策略**，与「有哪些」（`useAgentModels` / `useModelsForPicker`）
 * 是不同职责。混在一起的后果是可测试性变差：策略需要针对三种输入组合分别断言，
 * 而列表获取只需断言「拉到了没有」。
 */
export function useSelectedModelSync(
  availability: ModelAvailability,
  models: ModelInfo[],
  sessionConfigOptions: SessionConfigOption[],
  selectedModel: ModelInfo | null,
  setSelectedModel: (model: ModelInfo) => void,
): void {
  // 上一次见到的「会话当前模型」。只有它**真的变了**才覆盖用户选择 ——
  // 否则任何与模型无关的配置刷新都会把用户刚选的模型打回去（见文件头注释）。
  const lastAuthoritativeRef = useRef<string | null>(null);

  useEffect(() => {
    if (models.length === 0) return;

    // 1. 会话当前值**变化**时跟随（首次拿到也跟随）
    //
    // 只有 `ready` 才有「会话内当前值」这回事：`per-turn` 的列表来自目录、
    // `pending` 的会话还没就绪 —— 那两种状态下 `configOptions` 里的
    // `current_value` 只能是切换 agent 时的**残留**。
    //
    // 注：下面的 `models.find` 也会过滤掉不在列表里的残留 id，所以这条判据
    // 是**防御性**的（删掉它现有测试仍全绿）。保留理由：它让「读会话内当前值」
    // 这个动作的**前提**在代码里显式可见，而不是隐含依赖下游过滤。
    // 真正的行为约束由 `useModelsForPicker` 的来源判据保证。
    const authoritative =
      availability === 'ready' ? currentModelFromConfigOptions(sessionConfigOptions) : null;
    const previous = lastAuthoritativeRef.current;
    if (authoritative) lastAuthoritativeRef.current = authoritative;

    // 跟随的条件：这个当前值**与用户已选的不同**，且它不是我们上一轮已经
    // 处理过的那个值。
    //
    // `previous` 的作用只有一个：识别「同一个当前值被重复报告」。切推理档位时
    // 后端会重拉整份 configOptions（档位可选项随模型变，必须重拉），模型项的
    // `current_value` 原样重报一遍 —— 那不是「agent 换了模型」，不该覆盖用户
    // 刚选的新模型。
    const sameAsBefore = previous !== null && authoritative === previous;
    // 已经是用户选中的那个值 → 无事可做（避免每次刷新都触发一次 setState）
    const alreadySelected = authoritative != null && authoritative === selectedModel?.id;
    if (authoritative != null && !sameAsBefore && !alreadySelected) {
      // **歧义消解走唯一入口**：同一裸 id 可能对应多条（不同 provider）。
      // 直接 `models.find(m => m.id === authoritative)` 会按数组顺序命中，
      // 于是高亮跳到另一行（实际跑的模型没变）。见 `resolveModelById`。
      const match = resolveModelById(models, authoritative, selectedModel);
      if (match) {
        setSelectedModel(match);
        return;
      }
    }

    // 2. 已有选择且仍在列表里 → 保留
    if (selectedModel && hasModelId(models, selectedModel.id)) return;

    // 3. 落到 agent 下发的首选
    setSelectedModel(models[0]);
    // selectedModel 只用于「是否保留」，不作为触发条件（否则选一次就再跑一轮）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availability, models, sessionConfigOptions]);
}
