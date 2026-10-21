/**
 * CHAT 能力：传输协议 + 启动方式（与后端 `ChatStart` 对应）。
 *
 * 两种形态与后端序列化一致：
 * - 裸字符串（`'acp' | 'serve' | 'jsonl' | 'mock'`）—— 旧格式，ACP 无启动参数；
 * - 对象 `{ transport: 'acp', args: string[] }` —— ACP 需要附加子命令时
 *   （如 `opencode acp`、`claude --acp`）。`args` 挂在 `command` 之后。
 *
 * 只有 `acp` 接受对象形态：其余传输的启动方式由 `command` 决定，不需要额外参数。
 */
export type ChatStart =
  | 'acp'
  | 'serve'
  | 'jsonl'
  | 'mock'
  /** Pi 的私有 rpc 协议（`pi --mode rpc`，单进程，不依赖 pi-acp 中间层）。 */
  | 'pi-rpc'
  | { transport: 'acp'; args: string[] };

/** `ChatStart` 的传输标识（对象形态取其 `transport`），供 UI 判断与展示。 */
export function chatTransportOf(chat: ChatStart | null | undefined): string | null {
  if (!chat) return null;
  return typeof chat === 'string' ? chat : chat.transport;
}

/** `ChatStart` 的 ACP 启动参数（非 ACP 或旧字符串格式 → 空数组）。 */
export function chatAcpArgsOf(chat: ChatStart | null | undefined): string[] {
  return typeof chat === 'object' && chat !== null && chat.transport === 'acp' ? chat.args : [];
}

/** 安装检测方式（后端 `Detection`，serde tag=type）。 */
export type Detection = { type: 'command'; target: string } | { type: 'directory'; target: string };

/** 部署契约：skills 必填，commands/mcp 可选（Some = 支持该类型部署）。 */
export interface DeploySpec {
  /** skills 目录模板（支持 {{home}} / {{projectPath}}）。 */
  skills: string;
  /** slash commands 目录模板（缺省 = 不支持 command 部署）。 */
  commands?: string | null;
  /** MCP 配置文件模板（缺省 = 不支持 MCP 部署）。 */
  mcp_config?: string | null;
}

export interface AgentConfig {
  id: string;
  name: string;
  icon?: string | null;
  enabled: boolean;
  is_builtin?: boolean;
  /** Executable command path（CLI 能力基础；空 = 无终端 TUI，如 mockAgent）。 */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** CHAT 能力（None = 无 CHAT 能力）。 */
  chat?: ChatStart | null;
  /**
   * CHAT 会话进程的**可执行文件**覆盖（None = 沿用 `command`）。
   *
   * 同一个 agent 的 TUI 与 chat 可能不是同一个二进制：`pi` 跑自己的 rpc，
   * `pi-acp` 是把它包成 ACP 的独立入口。
   *
   * **一旦设置，`args` 不再被 chat 继承** —— 那些参数描述的是终端 TUI 进程。
   */
  chat_command?: string | null;
  /**
   * CHAT 会话进程的附加参数，追加在可执行文件之后。
   *
   * 与 `args` 分开：后者是终端 TUI 的启动参数，两者要的往往不是同一组。
   */
  chat_args?: string[] | null;
  /** prompt 前置参数（Headless 能力；None = 无）。 */
  prompt_args?: string[] | null;
  /** 交互式（TUI）prompt 前置参数（如 opencode `--prompt`：打开 CLI 并预填 prompt）；None = 无交互形态，回落 headless prompt_args。 */
  interactive_prompt_args?: string[] | null;
  post_prompt_args?: string[] | null;
  /**
   * 「列出可用模型」命令参数（如 pi 的 `["--list-models"]`）。
   *
   * **与 chat 能力无关**：纯 CLI 查询，`chat: null` 的 agent 也能有。
   * 存在它，用户在发第一条消息之前就能看到模型列表 —— ACP 的模型列表只存在于
   * 会话的 `configOptions` 里，没有独立查询方法。
   */
  model_list_args?: string[] | null;
  /** 全局 skills 目录 override（如 ~/.claude/skills）。 */
  skill_path?: string | null;
  /** 安装检测（None = 恒视为已安装）。 */
  detection?: Detection | null;
  /** 部署契约（skills / commands / MCP 目标模板）。 */
  deploy?: DeploySpec;
}

/** 派生能力标记（前端计算）。 */
export function agentCapabilities(agent: AgentConfig) {
  return {
    cli: (agent.command ?? '').length > 0,
    chat: Boolean(agent.chat),
    headless: Boolean(agent.prompt_args),
  };
}
