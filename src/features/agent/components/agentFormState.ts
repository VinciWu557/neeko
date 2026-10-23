/**
 * Agent 表单的编辑态：`AgentConfig` ⇄ 可编辑控件的双向投影。
 *
 * # 为什么单独成文件
 *
 * `AgentForm.tsx` 受 `check_component_size` 的 ratchet 约束（只许缩小）。
 * 而这些纯函数与组件本身无关：它们不碰 React，只做数据形状转换，可以脱离
 * 组件单独测。和同目录的 `agentFormChat.ts`（CHAT 启动配置）是同一族。
 *
 * # 为什么 argv 字段直接是 `string[]`
 *
 * 旧实现把它们压成空格分隔的一行文本。那条投影**不幂等**（见 `argList.ts`
 * 的表），于是每次「打开设置页 → 保存」都在静默改写用户配置。
 *
 * 判据是**投影是否单射**：
 * - `argv`（`args` / chat 启动命令 / 三件套）→ 文本 是**有损**的，必须存数组；
 * - `env`（`KEY=value` 多行）→ 对象的投影是幂等的（除了设计上就要 trim 的
 *   首尾空白），保留文本态即可 —— 它承载的是「多行」这个天然布局，不是一个
 *   会丢边界的序列。
 */

import type { AgentConfig } from '@/shared/types/agent';

import { formatChatLaunch, formatEnvText } from './agentFormChat';

/** 新建时的空白编辑态。 */
export function emptyFormState(): FormState {
  return {
    id: '',
    name: '',
    icon: 'cli.svg',
    enabled: true,
    command: '',
    args: [],
    chatArgv: [],
    chatEnvText: '',
    chatInprocess: false,
    promptArgs: [],
    postPromptArgs: [],
    modelListArgs: [],
    skillPath: '',
    detectionCmd: '',
    deploySkills: '{{projectPath}}/.agent/skills',
    deployCommands: '',
    deployMcp: '',
  };
}

/** 表单的编辑态字段。argv 类字段是数组，不做有损投影。 */
export interface FormState {
  id: string;
  name: string;
  command: string;
  /** CLI 参数（终端 TUI 的 `args`）。 */
  args: string[];
  icon: string;
  enabled: boolean;
  /** chat 启动命令的 argv（`program` + `args`）；空 = 无 CHAT 能力。 */
  chatArgv: string[];
  /** chat 专属环境变量（多行 `KEY=value`；该投影幂等，保留文本态）。 */
  chatEnvText: string;
  /** 该 chat 由进程内实现提供（无 argv）；与空命令行互斥。 */
  chatInprocess: boolean;
  promptArgs: string[];
  postPromptArgs: string[];
  modelListArgs: string[];
  skillPath: string;
  detectionCmd: string;
  deploySkills: string;
  deployCommands: string;
  deployMcp: string;
}

/** 空数组 → `null`（后端契约：`None` 表示「没有这个能力」）。 */
export function toNullableArgs(args: readonly string[]): string[] | null {
  return args.length > 0 ? [...args] : null;
}

/** `AgentConfig` → 编辑态。 */
export function toFormState(form: AgentConfig): FormState {
  return {
    id: form.id,
    name: form.name,
    command: form.command,
    args: [...(form.args ?? [])],
    icon: form.icon ?? 'cli.svg',
    enabled: form.enabled,
    chatArgv: formatChatLaunch(form.chat, form.command),
    chatEnvText: formatEnvText(form.chat?.env),
    chatInprocess: form.chat?.inprocess === true,
    promptArgs: [...(form.prompt_args ?? [])],
    postPromptArgs: [...(form.post_prompt_args ?? [])],
    modelListArgs: [...(form.model_list_args ?? [])],
    skillPath: form.skill_path ?? '',
    detectionCmd: form.detection?.type === 'command' ? form.detection.target : '',
    deploySkills: form.deploy?.skills ?? '{{projectPath}}/.agent/skills',
    deployCommands: form.deploy?.commands ?? '',
    deployMcp: form.deploy?.mcp_config ?? '',
  };
}
