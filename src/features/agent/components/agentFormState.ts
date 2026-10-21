/**
 * Agent 表单的文本态：`AgentConfig` ⇄ 可编辑字符串的双向投影。
 *
 * # 为什么单独成文件
 *
 * `AgentForm.tsx` 受 `check_component_size` 的 ratchet 约束（只许缩小）。
 * 而这些纯函数与组件本身无关：它们不碰 React，只做数据形状转换，可以脱离
 * 组件单独测。和同目录的 `agentFormChat.ts`（CHAT 传输的形态转换）是同一族。
 *
 * # 为什么要文本态
 *
 * 数组字段（`args` / `chat_args`）在 `<input>` 里只能以字符串承载；
 * 表单态直接存 `AgentConfig` 会让每个 onChange 都要 parse 一次。
 */

import type { AgentConfig } from '@/shared/types/agent';
import { chatAcpArgsOf, chatTransportOf } from '@/shared/types/agent';

import { argsTextOf } from './agentFormArgs';
import type { ChatTransport } from './agentFormChat';

/** 新建时的空白配置。 */
export function emptyForm(): AgentConfig {
  return {
    id: '',
    name: '',
    icon: 'cli.svg',
    enabled: true,
    command: '',
    args: [],
    env: {},
    chat: null,
    chat_command: null,
    chat_args: null,
    prompt_args: null,
    post_prompt_args: null,
    model_list_args: null,
    skill_path: null,
    detection: null,
    deploy: { skills: '{{projectPath}}/.agent/skills', commands: null, mcp_config: null },
  };
}

/** 表单的文本态字段（数组字段以可编辑字符串承载）。 */
export interface FormTextState {
  id: string;
  name: string;
  command: string;
  argsText: string;
  icon: string;
  enabled: boolean;
  chat: ChatTransport | '';
  /** ACP 子命令参数（空格分隔）；仅 chat === 'acp' 时有意义。 */
  acpArgsText: string;
  /** chat 会话进程的可执行文件覆盖（空 = 沿用 command）。 */
  chatCommand: string;
  /** chat 会话进程的附加参数（空格分隔）。 */
  chatArgsText: string;
  promptArgsText: string;
  postPromptArgsText: string;
  modelListArgsText: string;
  skillPath: string;
  detectionCmd: string;
  deploySkills: string;
  deployCommands: string;
  deployMcp: string;
}

/** `AgentConfig` → 文本态。 */
export function toTextState(form: AgentConfig): FormTextState {
  return {
    id: form.id,
    name: form.name,
    command: form.command,
    argsText: form.args?.join(' ') ?? '',
    icon: form.icon ?? 'cli.svg',
    enabled: form.enabled,
    chat: (chatTransportOf(form.chat) ?? '') as ChatTransport | '',
    acpArgsText: chatAcpArgsOf(form.chat).join(' '),
    chatCommand: form.chat_command ?? '',
    chatArgsText: form.chat_args?.join(' ') ?? '',
    ...argsTextOf(form),
    skillPath: form.skill_path ?? '',
    detectionCmd: form.detection?.type === 'command' ? form.detection.target : '',
    deploySkills: form.deploy?.skills ?? '{{projectPath}}/.agent/skills',
    deployCommands: form.deploy?.commands ?? '',
    deployMcp: form.deploy?.mcp_config ?? '',
  };
}
