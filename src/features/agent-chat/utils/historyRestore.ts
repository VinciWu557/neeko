import type { ModelInfo } from '@/features/agent/api/agentApi';
import { resolveModelById } from '@/shared/utils/modelTarget';

/**
 * 把历史会话记录的 model 字符串匹配回 `ModelInfo`。
 *
 * 历史记录里可能是 `providerID/modelID` 复合串，也可能就是模型 id。`ModelInfo.id`
 * 的语义是**不透明**的（opencode 的复合串本身就带 provider 前缀，Claude 可能是
 * `default` 别名），因此这里不做 provider 拆解匹配 —— 按整串全等，再退化到单段 id。
 * 无匹配返回 `undefined`（回落 agent 默认模型）。
 *
 * 重名歧义（同一裸 id 出现在多个 provider 下）交给 `resolveModelById` ——
 * 历史记录同样只有裸 id，无法分辨 group，那是协议层的上限。
 */
export function matchModel(
  models: ModelInfo[],
  historyModel: string | null | undefined,
): ModelInfo | undefined {
  if (!historyModel) return undefined;
  const [, ...rest] = historyModel.split('/');
  const bareId = rest.join('/') || historyModel;
  return resolveModelById(models, historyModel) ?? resolveModelById(models, bareId);
}
