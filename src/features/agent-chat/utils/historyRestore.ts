import type { ModelInfo } from '@/features/agent/api/agentApi';

/**
 * 把历史会话记录的 model 字符串匹配回 `ModelInfo`。
 *
 * 历史记录里可能是 `providerID/modelID` 复合串，也可能就是模型 id。`ModelInfo.id`
 * 的语义是**不透明**的（opencode 的复合串本身就带 provider 前缀，Claude 可能是
 * `default` 别名），因此这里不做 provider 拆解匹配 —— 按整串全等，再退化到单段 id。
 * 无匹配返回 `undefined`（回落 agent 默认模型）。
 */
export function matchModel(
  models: ModelInfo[],
  historyModel: string | null | undefined,
): ModelInfo | undefined {
  if (!historyModel) return undefined;
  const [, ...rest] = historyModel.split('/');
  const bareId = rest.join('/') || historyModel;
  return (
    models.find((m) => m.id === historyModel) || models.find((m) => m.id === bareId) || undefined
  );
}
