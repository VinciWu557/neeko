import { useMemo } from 'react';

import type { ModelInfo } from '@/features/agent/api/agentApi';
import type { SessionConfigOption } from '@/shared/types/agentChat';
import { modelsFromConfigOptions } from '@/shared/types/agentChat';
import type { ModelAvailability } from '@/shared/utils/modelTarget';

/**
 * 模型选择器要展示的列表 —— 两个来源按 **`availability`** 决定取哪一份。
 *
 * # 为什么入参是 `availability` 而不是自己数 `options.length`
 *
 * 列表来源与写回语义是**同一个事实**：`availability` 已经回答了「这份列表从哪来、
 * 怎么写」。再多一个 `options.length > 0` 的判断依据，就会出现两者不一致：
 *
 * | availability | options | 旧判据取的来源 | `modelWriteOf` 的语义 | 结果 |
 * | --- | --- | --- | --- | --- |
 * | `ready` | 空 | catalog | `config_value` | 复合串被当裸名下发 → agent 拒绝 |
 * | `pending` | 非空（残留） | session | `null` | 列表能点但写不了 |
 * | `per-turn` | 非空（残留） | session | `turn_param` | 裸名被当复合串 → 拆出空 provider |
 *
 * 实测 10 种组合只有 2 种一致。收成一个判据后不可能分歧 —— 这正是
 * `quality-guidelines.md` §12「正交状态字段应收成一个 union」的延伸：
 * **派生点也必须是唯一**。
 *
 * # 为什么会话内优先
 *
 * 会话内的选项是 agent 当下的真实状态；会话外命令是「这台机器上装了什么」的快照，
 * 可能包含当前 agent 未启用的模型，也可能缺少运行时才发现的模型。
 *
 * ACP agent 的快速路径返回 `SessionScoped`（空列表），所以**没有会话时它们的下拉
 * 就是空的** —— 这不是 bug，是协议约束（没有独立的「列模型」方法）。
 */
export function useModelsForPicker(
  availability: ModelAvailability,
  sessionConfigOptions: SessionConfigOption[],
  catalogModels: ModelInfo[],
): ModelInfo[] {
  return useMemo(() => {
    // `ready` / `per-turn` 都可能有会话内选项；只有 `ready` 代表「会话内的列表是
    // 权威的裸名 id」。`per-turn` 的写回走每轮参数，其 id 语义来自**目录**
    // （`provider/model`），所以它必须用 `catalogModels`。
    if (availability === 'ready') {
      // `ready` 的语义是「**会话内列表是权威且可写**」。所以只返回会话内那份。
      //
      // 握手完成但 agent 没下发模型项（或该项为空）时，**不退回目录**：
      // 此刻写回通道是 `config_value`（要裸名），而目录 id 是 `provider/model`
      // 复合串 —— 展示出来就是「能点但切不动」（R3 禁止的组合）。
      // 宁可不显示：空列表 + 空态文案，比一串点不动的模型诚实。
      //
      // 这是 `ready` 与「有列表」必须绑定的原因：`availability` 决定写回语义，
      // 列表必须服从它，而不是自己再决定一次。
      return modelsFromConfigOptions(sessionConfigOptions);
    }
    // `no-config` / `per-turn` / `pending`：写回要么不存在、要么走每轮参数，
    // 两者的 id 语义都来自**目录**，所以用 `catalogModels`。
    return catalogModels;
  }, [availability, sessionConfigOptions, catalogModels]);
}
