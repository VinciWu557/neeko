import { useCallback } from 'react';

import { useAgentModels } from '@/features/agent';
import type { ModelInfo } from '@/features/agent/api/agentApi';
import type { SessionConfigOption } from '@/shared/types/agentChat';
import { modelConfigIdFrom } from '@/shared/types/agentChat';

import { useModelsForPicker } from './useModelsForPicker';
import { useSelectedModelSync } from './useSelectedModelSync';

/**
 * 模型选择的**写入**侧：点选模型时立刻下发 `set_config_option`。
 *
 * # 为什么不是只改本地 state
 *
 * 推理档位是**随模型变**的。实测（pi 1.3.0）：
 *
 * | 模型 | `get_available_thinking_levels` |
 * | --- | --- |
 * | reasoning 模型 | `["low","high","max"]` |
 * | 非 reasoning 模型 | `["off"]` |
 *
 * 档位列表由后端在切模型后 `refresh_configs` 重拉。若点选只改本地 state，
 * pi 根本不知道换了模型，档位就一直停在旧模型那一组 —— 表现是「选了模型，
 * 思考等级还是上一个模型的」。
 *
 * # 与 `useSelectedModelSync` 的分工
 *
 * - 本 hook：**用户 → 会话**（点选即下发）
 * - `useSelectedModelSync`：**会话 → UI**（agent 主动换模型时跟随，且不被无关刷新打回）
 *
 * 两者合起来才闭合，缺一半就是「界面对了但 agent 没变」或「agent 变了但界面没跟」。
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
  selectedModel: ModelInfo | null;
  setSelectedModel: (model: ModelInfo) => void;
  setConfigOption: (configId: string, value: string | boolean) => void;
}): ModelSelection {
  const { agentId, sessionConfigOptions, selectedModel, setSelectedModel, setConfigOption } =
    params;

  // 两个来源合并：会话外快速路径（仅 opencode 有）+ 会话内 configOptions（权威）。
  const { models: catalogModels } = useAgentModels(agentId);
  const models = useModelsForPicker(sessionConfigOptions, catalogModels);

  // 会话 → UI 的跟随（agent 主动换模型时跟上，且不被无关刷新打回）。
  useSelectedModelSync(models, sessionConfigOptions, selectedModel, setSelectedModel);

  const selectModel = useCallback(
    (model: ModelInfo) => {
      // 本地先响应，让按钮立刻显示新模型（协议的响应会带全量配置回来校准）。
      setSelectedModel(model);
      // 读与写必须用同一套定位（category 优先、id 兜底），否则「列得出来但切不动」。
      const configId = modelConfigIdFrom(sessionConfigOptions);
      if (configId) setConfigOption(configId, model.id);
    },
    [sessionConfigOptions, setSelectedModel, setConfigOption],
  );

  return { selectModel, models };
}
