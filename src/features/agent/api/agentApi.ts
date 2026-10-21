import { invoke, convertFileSrc } from '@tauri-apps/api/core';

import type { AgentConfig } from '@/shared/types';
import type { SessionConfigOption } from '@/shared/types/agentChat';
import { getAgentIconSrc as getPresetIconSrc } from '@/shared/utils/agents';
import type { ProjectId } from '@/shared/utils/workspaceRef';

/** Information about a model supported by an agent. */
/**
 * 一个可选的模型条目 —— 与后端 `ModelInfo` 及 ACP `SessionConfigSelectOption` 一一对应。
 *
 * 早先这里还有 `provider_id` / `provider_name` / `context_window` /
 * `supported_reasoning_efforts` / `default_reasoning_effort` / `is_free`，全部由
 * opencode 的私有输出解析而来。它们不是模型条目的属性：ACP 用
 * `category: "model_config"`（上下文大小等）与 `"thought_level"`（推理档位）的
 * **会话配置项**表达，走 `configOptions` 而非模型列表。
 */
export interface ModelInfo {
  /** 模型标识。语义**不透明**：可能是 `provider/model` 复合串，也可能是 `default` 别名。 */
  id: string;
  /** 展示名（opencode 的解析实现会把 provider 前缀并入这里）。 */
  name: string;
  /** 可选说明。 */
  description?: string;
  /**
   * 可选**分组标识** —— 当 `id` 在列表内不唯一时，与它一起构成主键。
   *
   * Pi 的 rpc 列表里 `deepseek-v4-pro` 会同时出现在多个 provider 下
   * （实测 224 条 / 194 唯一 id）。React key 与选中判定都必须用
   * `id|group` 组合，否则会重复 key、多行同时高亮。
   */
  group?: string | null;
}

export function listAgents(): Promise<AgentConfig[]> {
  return invoke<AgentConfig[]>('list_agents');
}

/** List agents that support Agent Chat (declared chat_transport). */
export function listChatAgents(): Promise<AgentConfig[]> {
  return invoke<AgentConfig[]>('list_chat_agents');
}

/** List models an agent supports in Agent Chat. */
/**
 * `list_agent_models` 的返回类型。
 *
 * 早先返回 `ModelInfo[]`，空数组同时表示三种处境 —— 不支持、执行失败、还没加载。
 * UI 只能给出一个永久禁用的 "No models"，而三者对用户是完全不同的事实。
 */
export type ModelCatalogResult =
  | { kind: 'available'; models: ModelInfo[] }
  /** 支持模型选择，但列表只能在会话内取得（ACP 协议约束）。 */
  | { kind: 'session-scoped' }
  /** 该 agent 不支持选择模型。 */
  | { kind: 'unsupported' };

/**
 * 渲染层需要的配置项形状：从协议类型派生，**不独立声明字段**。
 *
 * 之前这里与 `shared/types/agentChat.ts` 的 `SessionConfigOption` 各写一份，且字段名
 * 不一致（`currentValue` vs `current_value`）—— 两份定义会各自漂移，而漂移不会报错。
 * 现在只做「把协议形状规整成渲染可用」的映射：`options` 保证非空数组、`type` 给出
 * 默认值，字段名沿用 `SessionConfigOption`（snake_case，与后端一致）。
 */
export type ModelConfigOption = Omit<SessionConfigOption, 'options' | 'category'> & {
  /** 恒为数组（协议里可缺省，渲染层不希望处理 null）。 */
  options: NonNullable<SessionConfigOption['options']>;
};

/** 拉取某 agent 的模型目录（结果形态见 {@link ModelCatalogResult}）。 */
export function listAgentModels(agentId: string): Promise<ModelCatalogResult> {
  return invoke<ModelCatalogResult>('list_agent_models', { agentId });
}

/** Discover OpenCode models dynamically. */
export function discoverOpencodeModels(binaryPath?: string): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>('discover_opencode_models', { binaryPath });
}

export function getAgent(agentId: string): Promise<AgentConfig> {
  return invoke<AgentConfig>('get_agent', { agentId });
}

export function addAgent(agent: AgentConfig): Promise<void> {
  return invoke<void>('add_agent', { agent });
}

export function removeAgent(agentId: string): Promise<void> {
  return invoke<void>('remove_agent', { agentId });
}

export function setProjectAgents(projectId: ProjectId, agentIds: string[]): Promise<void> {
  return invoke<void>('set_project_agents', { projectId, agentIds });
}

/**
 * Check whether agent CLIs exist in the project's execution environment
 * (Local / WSL / SSH). Prefer always passing `projectId` for the active project.
 */
export function checkAgentsInstalled(
  agentIds?: string[],
  projectId?: ProjectId | null,
): Promise<Record<string, boolean>> {
  return invoke<Record<string, boolean>>('check_agents_installed', {
    agentIds,
    projectId: projectId ?? null,
  });
}

export function importAgentIcon(sourcePath: string): Promise<string> {
  return invoke<string>('import_agent_icon', { sourcePath });
}

export function resolveAgentIconSrc(icon: string | null | undefined): string | null {
  const preset = getPresetIconSrc(icon);
  if (preset) return preset;
  if (!icon) return null;
  return convertFileSrc(icon);
}
