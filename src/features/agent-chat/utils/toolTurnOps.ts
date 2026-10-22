import type { ToolCard } from '../types';

import { normalizeToolName } from './toolNames';

/**
 * 一次 `tool_start` 对**话轮账本**的影响（纯函数）。
 *
 * # 为什么抽出来
 *
 * 这两件事（去重、计数归类）是纯判定，不碰 React 状态。抽出来的收益：
 *
 * 1. **可穷举测试** —— 计数归类有 4 个分支（read/search/grep → searched，
 *    edit/write → edited，其余 → ran），在 `useTurnStream` 里只能靠造完整
 *    事件流才测得到。
 * 2. **`useTurnStream` 保持 300 行红线内**（ratchet：新文件不得越线）。
 *
 * # 计数归类为什么按归一化名
 *
 * `normalizeToolName` 把 opencode 等框架的原始名（`edit` / `exec_command`…）
 * 对齐标准名。计数必须用归一化后的名字，否则历史恢复（`historyConvert`）
 * 与 live 流两条链路会算出不同的话轮摘要。
 */
type ToolBucket = 'searched' | 'edited' | 'ran';

/** 工具名 → 话轮计数归类（内部实现，对外只暴露 `recordToolStart`）。 */
function bucketOfTool(rawName: string): ToolBucket {
  const name = normalizeToolName(rawName);
  if (name === 'read_file' || name === 'search' || name === 'grep') return 'searched';
  if (name === 'edit_file' || name === 'write_file') return 'edited';
  return 'ran';
}

/** 话轮内的工具计数。 */
export interface TurnCounts {
  ran: number;
  edited: number;
  searched: number;
}

/**
 * 把一次 `tool_start` 记入账本。
 *
 * # 去重是必需的
 *
 * 同一 `callId` 可能因后端重复 `ToolStart`（opencode serve 的
 * `pending` + `running` 两个状态各发一次）而到达两次。已有该 callId 即视为
 * 重复 —— 否则同一个任务会渲染成两行、计数也会翻倍。
 *
 * @returns 新建的 `ToolCard`；若判定为重复则返回 `null`（调用方丢弃本次）。
 */
export function recordToolStart(
  rawName: string,
  callId: string,
  title: string,
  seen: ToolCard[],
  counts: TurnCounts,
): ToolCard | null {
  if (seen.some((t) => t.callId === callId)) return null;

  const name = normalizeToolName(rawName);
  counts[bucketOfTool(rawName)] += 1;
  return { callId, name, title, status: 'running' };
}
