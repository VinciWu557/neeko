import { useCallback } from 'react';

import { useAgentModels } from '@/features/agent';
import type { ModelInfo } from '@/features/agent/api/agentApi';
import type { SessionConfigOption } from '@/shared/types/agentChat';
import { modelConfigIdFrom } from '@/shared/types/agentChat';
import { modelWriteOf, type ModelAvailability } from '@/shared/utils/modelTarget';

import { useModelsForPicker } from './useModelsForPicker';
import { useSelectedModelSync } from './useSelectedModelSync';

/**
 * 模型选择的**写入**侧：点选模型时下发到会话。
 *
 * # 为什么必须真的下发
 *
 * 推理档位是**随模型变**的。实测（pi 1.3.0）：
 *
 * | 模型 | `get_available_thinking_levels` |
 * | --- | --- |
 * | reasoning 模型 | `["low","high","max"]` |
 * | 非 reasoning 模型 | `["off"]` |
 *
 * 档位由后端在切模型后 `refresh_configs` 重拉。若点选只改本地 state，pi 根本
 * 不知道换了模型，档位会停在旧模型那一组。
 *
 * # 与 `useSelectedModelSync` 的分工
 *
 * - 本 hook：**用户 → 会话**（点选即下发）
 * - `useSelectedModelSync`：**会话 → UI**（agent 主动换模型时跟随，且不被无关刷新打回）
 *
 * # 写回目标由 `modelWriteOf` 给出，本地不判"能不能写"
 *
 * 不可写时它返回 `null` —— 此时**控件本就不该可点**（渲染层用 `writabilityOf`
 * 从同一个 union 派生）。这里再判一次只为防御渲染层漏门控，不是主路径。
 */
export interface ModelSelection {
  /** 点选模型：先本地响应，再下发会话。 */
  selectModel: (model: ModelInfo) => void;
  /** 当前可选的模型列表（会话内优先，回落到会话外快照）。 */
  models: ModelInfo[];
}

export function useModelSelection(params: {
  agentId: string | undefined;
  sessionConfigOptions: SessionConfigOption[];
  /** 模型/配置项的可用状态（唯一判据，来自 `useSessionConfigOptions`）。 */
  availability: ModelAvailability;
  selectedModel: ModelInfo | null;
  setSelectedModel: (model: ModelInfo) => void;
  setConfigOption: (configId: string, value: string | boolean) => void;
}): ModelSelection {
  const {
    agentId,
    sessionConfigOptions,
    availability,
    selectedModel,
    setSelectedModel,
    setConfigOption,
  } = params;

  // 两个来源合并：会话外快速路径（仅 opencode 有）+ 会话内 configOptions（权威）。
  const { models: catalogModels } = useAgentModels(agentId);
  const models = useModelsForPicker(availability, sessionConfigOptions, catalogModels);

  // 会话 → UI 的跟随（agent 主动换模型时跟上，且不被无关刷新打回）。
  useSelectedModelSync(availability, models, sessionConfigOptions, selectedModel, setSelectedModel);

  const selectModel = useCallback(
    (model: ModelInfo) => {
      // 本地先响应，让按钮立刻显示新模型（协议的响应会带全量配置回来校准）。
      setSelectedModel(model);

      // 写回目标由可用状态直接给出 —— 与渲染层的门控**同一个 union**，
      // 不再需要先推 `source` 再推 `writable`（那是两份必然漂移的 switch）。
      const write = modelWriteOf(availability, model);
      if (!write) {
        // 不该发生：不可写时渲染层已禁用该列表（同一个 `writabilityOf`）。
        // 留一行日志而不是静默吞掉，便于发现门控回归。
        console.warn('[agent-chat] model list is display-only; selection ignored', model.id);
        return;
      }

      switch (write.kind) {
        case 'config_value': {
          // 读与写必须用同一套定位（category 优先、id 兜底），否则「列得出来但切不动」。
          const configId = modelConfigIdFrom(sessionConfigOptions);
          if (configId) setConfigOption(configId, write.value);
          break;
        }
        case 'turn_param':
          // serve 的写回在下一次 `Turn` 上（`model_id` 请求参数）——
          // `setSelectedModel` 已经让它进入 `handleSend` 的载荷。
          break;
      }
    },
    [sessionConfigOptions, availability, setSelectedModel, setConfigOption],
  );

  return { selectModel, models };
}
