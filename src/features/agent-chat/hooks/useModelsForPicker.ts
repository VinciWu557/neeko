import { useMemo } from 'react';

import type { ModelInfo } from '@/features/agent/api/agentApi';
import type { SessionConfigOption } from '@/shared/types/agentChat';
import { modelsFromConfigOptions } from '@/shared/types/agentChat';

/**
 * 模型选择器要展示的列表 —— 两个来源按「会话内优先」合并。
 *
 * # 为什么是两个来源
 *
 * | 来源 | 何时有 | 权威性 |
 * | --- | --- | --- |
 * | 会话内 `configOptions` | 会话建立后 | **权威**：ACP 的模型列表只在这里，且会随 agent 主动变更（rate limit fallback）而变 |
 * | 会话外快速路径 | 任意时刻 | 预览：只有带独立列模型命令的 agent 才有（目前仅 opencode） |
 *
 * ACP agent 的快速路径返回 `SessionScoped`（空列表），所以**没有会话时它们的下拉
 * 就是空的**——这不是 bug，是协议约束（没有独立的「列模型」方法）。会话一旦建立，
 * 列表立刻从 `configOptions` 填充。
 *
 * # 为什么会话内优先
 *
 * 会话内的选项是 agent 当下的真实状态。会话外命令是「这台机器上装了什么」的快照，
 * 可能包含当前 agent 并未启用的模型，也可能缺少 agent 运行时才发现的模型。
 */
export function useModelsForPicker(
  sessionConfigOptions: SessionConfigOption[],
  catalogModels: ModelInfo[],
): ModelInfo[] {
  return useMemo(() => {
    const fromSession = modelsFromConfigOptions(sessionConfigOptions);
    return fromSession.length > 0 ? fromSession : catalogModels;
  }, [sessionConfigOptions, catalogModels]);
}
