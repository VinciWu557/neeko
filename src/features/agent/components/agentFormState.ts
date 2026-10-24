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

import type { AgentConfig, ChatLaunch, WireFormat } from '@/shared/types/agent';

import { formatChatLaunch, formatEnvText } from './agentFormChat';
import { trimArgList } from './argList';

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
    chatEnabled: 'default',
    chatWireFormat: 'content-length',
    promptArgs: [],
    postPromptArgs: [],
    modelListArgs: [],
    skillPath: '',
    detectionType: 'command',
    detectionTarget: '',
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
  /**
   * 仅内置 agent 有意义：出厂有 chat 时是否启用。
   *
   * **三态**，禁止压成 `boolean`：`'default'` 表示跟随出厂定义。压成布尔会让
   * 「打开表单 → 保存」把 `null` 写成 `true`，此后出厂默认的任何变化都追不上
   *（反向的「旧快照回滚出厂升级」）。
   */
  chatEnabled: ChatEnabledChoice;
  /**
   * ACP 帧格式的用户选择（仅 ACP 传输的自定义 agent 可编辑；提交时只对 ACP
   * 携带，见 `buildChatLaunch`）。
   *
   * **两态直接用 `WireFormat`**：`'content-length'` 是协议默认值，缺省与显式
   * 选择在语义上等价（不存在 `chatEnabled` 那种「跟随出厂」第三态），无需
   * 再造一层 choice 类型。显式落盘 `'content-length'` 的意义在于让后端装载期
   * 迁移短路 —— opencode 命名的配置不会被重新推断成 NDJSON。
   */
  chatWireFormat: WireFormat;
  promptArgs: string[];
  postPromptArgs: string[];
  modelListArgs: string[];
  skillPath: string;
  /** 安装检测方式（后端 `Detection` 的判别式）。 */
  detectionType: 'command' | 'directory';
  /** 检测目标（命令名或目录模板）。 */
  detectionTarget: string;
  deploySkills: string;
  deployCommands: string;
  deployMcp: string;
}

/**
 * 内置 agent 的 CHAT 开关三态。
 *
 * `'default'` = 跟随出厂定义（后端 `chat_enabled: null`）。
 */
export type ChatEnabledChoice = 'default' | 'on' | 'off';

/** 后端 `Option<bool>` → 三态（**不做有损投影**）。 */
export function toChatEnabledChoice(value: boolean | null | undefined): ChatEnabledChoice {
  if (value === false) return 'off';
  if (value === true) return 'on';
  return 'default';
}

/** 三态 → 后端 `Option<bool>`。 */
export function fromChatEnabledChoice(choice: ChatEnabledChoice): boolean | null {
  if (choice === 'default') return null;
  return choice === 'on';
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
    chatEnabled: toChatEnabledChoice(form.chat_enabled),
    chatWireFormat: form.chat?.wire_format ?? 'content-length',
    promptArgs: [...(form.prompt_args ?? [])],
    postPromptArgs: [...(form.post_prompt_args ?? [])],
    modelListArgs: [...(form.model_list_args ?? [])],
    skillPath: form.skill_path ?? '',
    detectionType: form.detection?.type ?? 'command',
    detectionTarget: form.detection?.target ?? '',
    deploySkills: form.deploy?.skills ?? '{{projectPath}}/.agent/skills',
    deployCommands: form.deploy?.commands ?? '',
    deployMcp: form.deploy?.mcp_config ?? '',
  };
}

/**
 * 表单态 → 提交用的 `AgentConfig`（尾部未填的冗余空行在提交边界裁掉）。
 *
 * # 内置 agent 的 `chat` 必须原样带回（绝不走投影）
 *
 * 表单态里的 argv 是投影（`formatChatLaunch` 会把 `command` 填进 `program`），
 * 用投影值提交会把 `{program: None}` 改写成 `{program: Some(command)}` ——
 * 「沿用 command」变成「显式指定」，出厂升级不再跟随，**而界面上看不出来**。
 *
 * # `chat_enabled` 只在「真有一个可开关的出厂 chat」时有意义
 *
 * 出厂没有 chat 的内置 agent 写偏好是纯噪音（判据被 `chat: null` 压住，但配置
 * 里从此躺着一个改不动也看不见的字段）。自定义 agent 的开关不存在，恒为 `null`。
 */
export function buildAgentConfig(
  t: FormState,
  initial: AgentConfig | null | undefined,
  builtChat: ChatLaunch | null,
): AgentConfig {
  return {
    id: t.id.trim(),
    name: t.name.trim(),
    icon: t.icon || 'cli.svg',
    enabled: t.enabled,
    command: t.command.trim(),
    args: trimArgList(t.args),
    env: initial?.env ?? {},
    chat: initial?.is_builtin ? (initial.chat ?? null) : builtChat,
    chat_enabled: initial?.is_builtin && initial.chat ? fromChatEnabledChoice(t.chatEnabled) : null,
    prompt_args: toNullableArgs(trimArgList(t.promptArgs)),
    post_prompt_args: toNullableArgs(trimArgList(t.postPromptArgs)),
    model_list_args: toNullableArgs(trimArgList(t.modelListArgs)),
    skill_path: t.skillPath.trim() || null,
    detection: t.detectionTarget.trim()
      ? { type: t.detectionType, target: t.detectionTarget.trim() }
      : null,
    deploy: {
      skills: t.deploySkills.trim() || '{{projectPath}}/.agent/skills',
      commands: t.deployCommands.trim() || null,
      mcp_config: t.deployMcp.trim() || null,
    },
  };
}
