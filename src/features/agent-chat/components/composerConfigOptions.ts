import type { ModelConfigOption } from '@/features/agent/api/agentApi';
import type { SessionConfigOption } from '@/shared/types/agentChat';

// 本文件原来内联在 ChatComposer.tsx，为给补全弹层腾出 ratchet 行数预算而外移；
// 只有定义搬家，调用点与行为零变化（sessionOptionsWiring.test.ts 钉住调用点）。

/**
 * 从 `configOptions` 里挑出**模型 popover 内**要渲染的配置项。
 *
 * 判定靠 `category`，**不靠 `id`** —— 规范明说 category 是 UX 提示但 id 没有
 * 命名约束（实测 Codex 用 `reasoning_effort`、OpenCode 用 `effort`）。
 *
 * **只收 `model_config`，不收 `thought_level`**：推理档位在输入框的工具条上有
 * 自己的选择器（`ThinkingLevelSelector`），那才是用户改它的地方。两处都渲染会
 * 出现两个控件指向同一个 `configId` —— 改一处另一处不跟着动，看起来像"没生效"。
 */
export function modelConfigOptionsOf(
  options: SessionConfigOption[] | undefined,
): ModelConfigOption[] {
  if (!options) return [];
  return options
    .filter((o) => o.category === 'model_config')
    .map((o) => ({
      id: o.id,
      name: o.name,
      description: o.description,
      type: o.type ?? 'select',
      currentValue: o.currentValue,
      options: o.options ?? [],
    }));
}

/**
 * 取会话的真实推理档位（`category: "thought_level"`），供输入框工具条的选择器使用。
 *
 * 返回 `null` 表示该 agent 没有档位概念 —— 调用方应**隐藏**选择器，而不是
 * 显示一组写死的选项后再被后端拒绝。
 *
 * 档位是**动态**的：可选值随当前模型变化（Pi 实测 `low/high/max`，别的模型
 * 可能是 `minimal/medium`），所以每次 `config_option_update` 都要重新读。
 */
export function thoughtLevelOptionOf(
  options: SessionConfigOption[] | undefined,
): ModelConfigOption | null {
  const found = options?.find((o) => o.category === 'thought_level');
  if (!found) return null;
  return {
    id: found.id,
    name: found.name,
    description: found.description,
    type: found.type ?? 'select',
    currentValue: found.currentValue,
    options: found.options ?? [],
  };
}

/**
 * 取会话的真实**模式**（`category: "mode"`，如 plan / build），供输入框工具条使用。
 *
 * 返回 `null` 表示该 agent 没有模式概念 —— 调用方应**隐藏**选择器。
 *
 * # 为什么不能沿用硬编码的 `AGENT_MODES`
 *
 * 旧实现把 `build/plan` 写死在前端，`onChange` 只改 React state、从不发给后端。
 * 那不只是「没用」——它让用户以为自己在 plan 模式下操作，而 agent 侧完全没变。
 *
 * # 当前没有任何内置 agent 下发它
 *
 * Pi 的 rpc 没有这个概念（`get_state` 只有 `followUpMode` / `steeringMode`，
 * 那是队列语义不是 plan/build）；opencode serve 也不发。所以这条链今天
 * **不会显示**任何东西 —— 这是正确行为：不支持的 agent 不该出现一个点不动的控件。
 * 传输侧一旦下发，UI 自动出现，无需改这里。
 */
export function modeOptionOf(options: SessionConfigOption[] | undefined): ModelConfigOption | null {
  const found = options?.find((o) => o.category === 'mode');
  if (!found) return null;
  return {
    id: found.id,
    name: found.name,
    description: found.description,
    type: found.type ?? 'select',
    currentValue: found.currentValue,
    options: found.options ?? [],
  };
}
