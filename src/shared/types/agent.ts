/**
 * CHAT 进程的启动配置（与后端 `ChatLaunch` 对应）。
 *
 * 一个 chat 进程需要的全部信息就是 `(argv[0], argv[1..], env)`，所以这里
 * 只有三项。**没有 `transport` 字段** —— 协议是从命令行 token 识别出来的
 * （见 `transportOf`），不是用户可声明的选项。
 */
export interface ChatLaunch {
  /** `argv[0]`；省略 = 沿用 `AgentConfig.command`（TUI 与 chat 同一二进制）。 */
  program?: string | null;
  /** `argv[1..]`；含 `acp` / `serve` / `--mode rpc` 等子命令。 */
  args?: string[];
  /** **仅**注入给 chat 进程的环境变量（与全局 `env` 合并，同名时这里胜）。 */
  env?: Record<string, string>;
  /**
   * 该 chat 由**进程内实现**提供（`mockAgent`），不 spawn 子进程。
   *
   * 必须显式声明，不能由「命令行是否为空」推断 —— 「没有可执行文件」有两种互不
   * 相干的原因（设计如此 / 填漏了），按空推断会把后者静默路由到 mock adapter。
   * 详见后端 `ChatLaunch::inprocess`。
   */
  inprocess?: boolean;
  /**
   * ACP 的 JSON-RPC 帧格式。省略 = `content-length`（协议默认）。
   *
   * 它是**配置**，不是推断结果：`AcpAdapter` 曾按可执行文件名猜 NDJSON，
   * 用户把二进制改名或包一层 wrapper 就会静默换错帧（服务端解析失败、
   * 握手永远无响应、且没有任何报错）。
   */
  wire_format?: WireFormat | null;
}

/** ACP 帧格式（与后端 `WireFormat` 对齐）。 */
export type WireFormat = 'content-length' | 'ndjson';

/** 传输协议 —— 派生物，由启动命令识别。 */
export type ChatTransport = 'acp' | 'serve' | 'jsonl' | 'pi-rpc';

/**
 * 传输识别规则表 —— **顺序即优先级**，必须与后端
 * `common/agent/chat_launch.rs::TRANSPORT_RULES` 逐项一致。
 *
 * 跨栈护栏 `transports.test.ts` 读后端源码断言这份表的 `id` 有序序列相同。
 * 单表化的收益：`transportOf` 与 `TRANSPORT_LABELS` 都从这里派生，新增协议
 * 只改这一处（而不是「识别逻辑 + 文案表」两处各改一遍）。
 */
export interface TransportDef {
  id: ChatTransport;
  /** 完整 token 判据（单 token）。 */
  tokens: string[];
  /** 相邻两 token 的组合判据（如 `--mode rpc`）。 */
  tokenPairs?: [string, string][];
  /** 展示文案（识别结果用，**不是**选项列表）。 */
  label: string;
}

export const TRANSPORTS: readonly TransportDef[] = [
  { id: 'acp', tokens: ['acp'], label: 'ACP · JSON-RPC stdio' },
  { id: 'serve', tokens: ['serve'], label: 'opencode serve · HTTP + SSE' },
  { id: 'jsonl', tokens: ['--jsonl', 'stream-json'], label: 'JSON-Lines stdio' },
  {
    id: 'pi-rpc',
    tokens: ['rpc'],
    tokenPairs: [['--mode', 'rpc']],
    label: 'Pi rpc · private NDJSON',
  },
] as const;

/** 传输标识 → 展示文案。从 `TRANSPORTS` 派生，不单独维护。 */
export const TRANSPORT_LABELS: Record<ChatTransport, string> = Object.fromEntries(
  TRANSPORTS.map((d) => [d.id, d.label]),
) as Record<ChatTransport, string>;

/**
 * 从启动命令的**完整 token** 识别传输 —— 必须与后端
 * `ChatLaunch::transport()` 逐字对齐（跨栈护栏测试会核对）。
 *
 * 只认完整 token：`--preserve` 含 "serve"、`--observe` 也含，子串匹配会判错。
 */
function hasTokenPair(tokens: string[], a: string, b: string): boolean {
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    if (tokens[i] === a && tokens[i + 1] === b) return true;
  }
  return false;
}

export function transportOf(chat: ChatLaunch | null | undefined): ChatTransport | null {
  if (!chat) return null;
  const tokens: string[] = [];
  if (chat.program) tokens.push(chat.program);
  for (const a of chat.args ?? []) tokens.push(a);

  // 表的顺序即优先级（与后端一致）：`opencode serve acp` 以 acp 为准。
  for (const def of TRANSPORTS) {
    if (def.tokens.some((t) => tokens.includes(t))) return def.id;
    if (def.tokenPairs?.some(([a, b]) => hasTokenPair(tokens, a, b))) return def.id;
  }
  // 默认 ACP：唯一通用协议，也是「没写特殊子命令的 CLI」最可能的行为。
  return 'acp';
}

/**
 * 该 agent 的 CHAT 能力是否由**进程内实现**提供。
 *
 * 与后端 `AgentConfig::is_inprocess_chat()` 对齐：读 `chat.inprocess` 显式声明，
 * **不从**「命令是否为空」推断 —— 那会把「用户清空了 command 却保留 chat 声明」
 * 的配置误判成进程内实现。
 */
export function isInprocessChat(agent: { chat?: ChatLaunch | null }): boolean {
  return agent.chat?.inprocess === true;
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
  /**
   * 该内置 agent 是否被用户覆盖过（仅后端设置）。
   *
   * 由 `AgentManager` 的覆盖表派生 —— 前端不再自己保管键集合（那曾是一份
   * 需要与后端同步的副本）。Reset 按钮据此决定是否显示。
   */
  is_overridden?: boolean;
  /** Executable command path（CLI 能力基础；空 = 无终端 TUI，如 mockAgent）。 */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** CHAT 能力（None = 无 CHAT 能力）。**出厂事实**：协议与参数，内置不可覆盖。 */
  chat?: ChatLaunch | null;
  /**
   * 用户是否启用 CHAT 能力。省略 = 跟随出厂定义。
   *
   * 与 `chat` 分成两个字段：`chat` 是出厂事实（内置不可被覆盖层改写），
   * 用户的真实诉求只有「用不用它」—— 那是三态偏好。
   * 压成 `boolean` 会让 `undefined`（跟随默认）在第一次保存后变成 `true`，
   * 此后出厂默认的任何变化都追不上。
   */
  chat_enabled?: boolean | null;
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

/**
 * 该 agent 的 CHAT 能力是否可用 —— **唯一**判据。
 *
 * 与后端 `AgentConfig::is_chat_agent()` 逐字对齐：
 * `chat.is_some() && chat_enabled != Some(false)`。
 *
 * 禁止再写 `Boolean(agent.chat)`：那会把用户主动关闭的 agent 当成可用，
 * 于是列表里那一项看起来完全正常，选中后 `adapter_for` 才报错。
 */
export function isChatEnabled(agent: {
  chat?: ChatLaunch | null;
  chat_enabled?: boolean | null;
}): boolean {
  return Boolean(agent.chat) && agent.chat_enabled !== false;
}

/** 派生能力标记（前端计算）。 */
export function agentCapabilities(agent: AgentConfig) {
  return {
    cli: (agent.command ?? '').length > 0,
    chat: isChatEnabled(agent),
    headless: Boolean(agent.prompt_args),
  };
}

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
   * （实测 224 条 / 194 唯一 id）。**React key 与列表内高亮**都必须用
   * `modelKeyOf` 算出的组合键，否则会重复 key、多行同时高亮。
   *
   * # 但会话回推方向没有 group
   *
   * `configOptions.currentValue` 与历史记录里的 model 都是**单个字符串**，
   * `group` 不参与。所以「会话说它在用哪个」在重名时天生有歧义 —— 那不是本
   * 字段能解决的，由 `resolveModelById` 在消费点消解（歧义时保留当前条目，
   * 不让高亮跳行）。把这里写成「选中判定用组合键」会是一句不可实现的声明。
   *
   * 后端是 `Option<String>` + `skip_serializing_if = "Option::is_none"`，
   * 所以线上形状是**字段缺失**（→ `undefined`），**不会**是 `null`。
   */
  group?: string;
}
