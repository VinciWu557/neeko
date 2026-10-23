//! Agent 配置定义 —— 唯一数据结构（Single Source of Truth）。
//!
//! 一个 Agent 就是一个 [`AgentConfig`]：既是设置页编辑/持久化的数据结构，也是
//! 内置（`builtin::builtin_configs`）与自定义（`customAgents`）统一的载体。
//! 运行时按需经 `AgentProvider::from(&config)` 包装为行为对象（adapter 创建、
//! 部署路径解析、安装检测）。
//!
//! CLI / CHAT / Headless 是三个正交能力：
//! - CLI：`command` 非空（终端 Tab + PTY 跑 agent 自带 TUI）；
//! - CHAT：`chat: Option<ChatLaunch>`（`kind:'agent-chat'` Tab + adapter 驱动）；
//! - Headless：`prompt_args`（程序化单轮，如 AI commit）。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::chat_launch::{ChatLaunch, ChatTransport};

/// 安装检测方式。
///
/// 注意：必须是**结构体载荷**变体（`Command { target }`）而非 newtype 元组
/// 变体（`Command(String)`）——`#[serde(tag)]` 的 internally-tagged 枚举无法
/// 序列化字符串/数字等标量载荷（serde 报 "cannot serialize tagged newtype
/// variant"），会导致 `AgentConfig` 整体序列化失败（`list_agents` 等命令
/// 直接报错）。结构体载荷序列化为 `{"type":"command","target":"..."}`，
/// 与前端 `Detection` 类型一致。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Detection {
    /// 命令是否存在于 PATH（如 `opencode`）。
    Command {
        /// 待检测的命令名。
        target: String,
    },
    /// 目录模板（含 `{{projectPath}}` 等变量）是否存在。
    Directory {
        /// 目录路径模板。
        target: String,
    },
}

/// 部署契约 —— Neeko 实际管理的三类资源目标。
///
/// `Option` 路径即支持位：`Some` = 支持该类型部署。skills 为必填（skill 库核心）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeploySpec {
    /// skills 目录模板（支持 `{{home}}` / `{{projectPath}}` 变量）。
    pub skills: String,
    /// slash commands 目录模板（`None` = 不支持 command 部署）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<String>,
    /// MCP 配置文件模板（`None` = 不支持 MCP 部署）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_config: Option<String>,
}

impl DeploySpec {
    /// 是否支持 MCP 部署。
    #[must_use]
    pub const fn supports_mcp(&self) -> bool {
        self.mcp_config.is_some()
    }

    /// 是否支持 slash command 部署。
    #[must_use]
    pub const fn supports_commands(&self) -> bool {
        self.commands.is_some()
    }
}

/// 一个可选的模型条目（运行时发现，不持久化）。
///
/// # 字段为什么只有三个
///
/// 这与 ACP 的 `SessionConfigSelectOption` 一一对应（`value` / `name` /
/// `description`），因为模型列表的正统来源就是协议本身。
///
/// 早先这里有 `provider_id` / `provider_name` / `context_window` /
/// `supported_reasoning_efforts` / `default_reasoning_effort` / `is_free` —— 全部
/// 由 opencode 的私有 NDJSON（`providerID`、`limit.context`、
/// `variants[].reasoningEffort`、`cost`）解析而来。把它们放在这个通用类型里，等于把
/// **单个 agent 的私有能力伪装成通用契约**，任何走别的传输的 agent 都只能填 `None`。
///
/// 这些信息在 ACP 里有正当归属：`category: "model_config"` 的会话配置项
/// （上下文大小、速度/质量取舍）与 `category: "thought_level"`（推理档位）。
/// 它们**不是模型条目的属性**，而是与模型相关的独立配置项 —— 见
/// `agent/chat/adapter/acp_config.rs`。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelInfo {
    /// 模型标识。**对其语义作不透明处理**：opencode 用 `provider/model` 复合串，
    /// Claude 可能是 `default` 这类别名，不解析、不拆分。
    pub id: String,
    /// 展示名。
    pub name: String,
    /// 可选说明。
    #[serde(default)]
    pub description: Option<String>,
    /// 可选**分组标识** —— 当 `id` 在列表内不唯一时，与它一起构成主键。
    ///
    /// 真实场景：Pi 的 `get_available_models` 里 `deepseek-v4-pro` 会同时出现在
    /// `deepseek` / `opencode` / `ark-coding-plan` 等 provider 下（实测 224 条
    /// 只有 194 个唯一 id）。用裸 `id` 当 React key 会重复、当选中判定会让
    /// 多行同时高亮。
    ///
    /// 语义保持**不透明**：Pi 填 provider 名，别的 agent 可以填任何能把同名项
    /// 区分开的字符串（或 `None` = 无分组需求）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

/// Agent 配置 —— 唯一数据结构（内置 + 自定义同构，设置页编辑/持久化的对象）。
///
/// 能力正交：CLI = `command` 非空；CHAT = `chat: Some(_)`；Headless = `prompt_args`.
///
/// # 反序列化走 `RawAgentConfig`
///
/// 旧配置把 chat 启动信息拆在 `chat` / `chat_command` / `chat_args` 三个字段里，
/// `RawAgentConfig` 保留这三个影子字段，由 [`convert`] 合并进
/// [`ChatLaunch`] 后丢弃。这样迁移逻辑只有一个入口，且旧文件永远可读。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(from = "RawAgentConfig")]
pub struct AgentConfig {
    /// Unique identifier for this agent.
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Optional icon identifier.
    pub icon: Option<String>,
    /// Whether this agent is enabled.
    pub enabled: bool,
    /// 是否为内置 agent。仅由后端设置，前端无法伪造。
    #[serde(default)]
    pub is_builtin: bool,
    /// 该内置 agent 是否被用户覆盖过（仅后端设置，**派生自 `AgentManager` 的
    /// 覆盖表**，不从配置内容推断）。
    ///
    /// 存在的理由：前端曾经为这个判断自己保管 `AppConfig.agentOverrides` 键集合，
    /// 于是「谁是真相」又多了一份。后端本就知道答案，直接算给它。
    ///
    /// 自定义 agent 恒为 `false`（删掉它就是删掉，谈不上"覆盖"）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_overridden: bool,
    /// Executable command path（CLI 能力基础；空 = 无终端 TUI，如 mockAgent）。
    pub command: String,
    /// Arguments to pass to the command.
    pub args: Vec<String>,
    /// Environment variables for the agent process.
    pub env: HashMap<String, String>,
    /// CHAT 能力：启动配置（`None` = 无 CHAT 能力）。
    ///
    /// 可执行文件、参数、环境变量都在 [`ChatLaunch`] 里 —— 一处定义，
    /// 传输由 [`ChatLaunch::transport`] 从参数 token 识别。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<ChatLaunch>,
    /// prompt 前置参数（Headless 能力），如 `["--bare", "-p"]` 表示
    /// `command --bare -p "<prompt>" [post_prompt_args]`。None = 无 Headless 能力。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_args: Option<Vec<String>>,
    /// 交互式（TUI）prompt 前置参数，如 opencode `["--prompt"]` 表示
    /// `command --prompt "<prompt>"`（打开 CLI 并预填 prompt，非 headless）。
    /// `None` = 无交互 prompt 形态，终端场景回落到 `prompt_args`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interactive_prompt_args: Option<Vec<String>>,
    /// prompt 后置参数，追加在 prompt 之后。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_prompt_args: Option<Vec<String>>,
    /// 「列出可用模型」命令参数，如 opencode 的 `["models", "--verbose"]`。
    /// `None` = 没有独立列模型命令。
    ///
    /// **与 CHAT 能力无关**：这是纯 CLI 查询，`chat: None` 的 agent 也能有。
    /// 存在它才能让用户在**发第一条消息之前**看到模型列表 —— ACP 协议的模型列表
    /// 只存在于会话的 `configOptions` 里，没有独立查询方法。
    ///
    /// # 声明了会话内模型能力的 transport 不得声明它
    ///
    /// CLI 目录的 `id` 是 `provider/model` 复合串，而 `ConfigCapability::SessionConfig`
    /// 的写回通道要**裸名** —— 两条来源并存会让「显示的列表」与「能写回的 id」
    /// 形状不一致（实测 `Model not found: provider/provider/model`）。
    /// 详见 `.trellis/spec/backend/agent-chat-transports.md` §10.5b。
    ///
    /// Pi 曾在这里声明 `["--list-models"]`，连专用表格解析器一起已删除：
    /// 它的模型列表来自 rpc 的 `get_available_models`，CLI 里没有。
    ///
    /// 命令的 stdout 格式因 agent 而异，由各自的解析器处理（见
    /// `agent/model_discovery` 与 `agent/chat/adapter` 里的 `list_models`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_list_args: Option<Vec<String>>,
    /// 全局 skills 目录 override（如 `~/.claude/skills`；opencode 特例
    /// `~/.config/opencode/skills`；与 `deploy.skills` 项目级模板并存）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_path: Option<String>,
    /// 安装检测方式（`None` = 不可检测，恒视为已安装，如 mockAgent）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detection: Option<Detection>,
    /// 部署契约（skills / commands / MCP 目标模板）。
    #[serde(default)]
    pub deploy: DeploySpec,
}

impl AgentConfig {
    /// 是否具备 CHAT 能力。
    #[must_use]
    pub const fn is_chat_agent(&self) -> bool {
        self.chat.is_some()
    }

    /// 是否具备 CLI 能力（有命令即可终端 TUI）。
    #[must_use]
    pub const fn is_cli_agent(&self) -> bool {
        !self.command.is_empty()
    }

    /// 是否具备 Headless 能力（AI commit 等程序单轮）。
    #[must_use]
    pub const fn is_headless_agent(&self) -> bool {
        self.prompt_args.is_some()
    }

    /// 拼装 `command + args` 作为子进程启动参数。
    #[must_use]
    pub fn cmd_vec(&self) -> Vec<String> {
        let mut v = Vec::with_capacity(1 + self.args.len());
        v.push(self.command.clone());
        v.extend(self.args.iter().cloned());
        v
    }

    /// 拼装 **chat 会话进程**的启动命令（可执行文件 + 参数）。
    ///
    /// | 配置 | 结果 |
    /// | --- | --- |
    /// | `chat` 为 `None` | `command + args`（无 CHAT 能力时退化为 CLI 命令） |
    /// | `chat.program` 有值 | `program + chat.args`（**不继承** CLI 的 `args`） |
    /// | `chat.program` 为空 | `command + args + chat.args` |
    ///
    /// 空白 `program` 视为未设置 —— 否则 `argv[0]` 是空串，spawn 会在难以定位
    /// 的地方失败。
    #[must_use]
    pub fn chat_cmd_vec(&self) -> Vec<String> {
        let Some(launch) = &self.chat else {
            return self.cmd_vec();
        };

        let mut v = match launch.program_filtered() {
            // 覆盖了可执行文件 → 它是另一个进程，不继承 CLI 的 args。
            Some(program) => vec![program.to_string()],
            None => self.cmd_vec(),
        };
        v.extend(launch.args_filtered().cloned());
        v
    }

    /// 该 agent 的 CHAT 能力是否由**进程内实现**提供（`mockAgent`）。
    ///
    /// 读 [`ChatLaunch::inprocess`] 显式声明，**不从**「命令行是否为空」推断。
    /// 两者不等价：用户可以把 `command` 清空却保留 chat 声明（“暂时禁用 CLI”），
    /// 那不是一个进程内实现，按空推断会把它静默路由到 mock adapter。
    #[must_use]
    pub fn is_inprocess_chat(&self) -> bool {
        self.chat.as_ref().is_some_and(|launch| launch.inprocess)
    }

    /// 该 agent 的 chat 传输（`chat` 为空时为 `None`）。
    #[must_use]
    pub fn chat_transport(&self) -> Option<ChatTransport> {
        self.chat.as_ref().map(ChatLaunch::transport)
    }

    /// chat 进程生效的环境变量 —— **唯一**合并入口。
    ///
    /// 合并顺序（靠后覆盖靠前）：
    /// `self.env`（agent 全局，TUI 与 chat 共享）∪ `chat.env`（仅 chat）。
    ///
    /// 这是**追加**，不是替换：父进程的环境仍完整继承（`SpawnOptions.env`
    /// 的实现是逐项 `cmd.env(k, v)`）。四个 adapter 的 spawn 入口各不相同，
    /// 各拼一份必然漂移，所以合并只在这里发生。
    ///
    /// 内部必需变量（如 `OPENCODE_SERVER_PASSWORD`）由 adapter 在本结果
    /// **之后**插入，因此用户改不动它们。
    #[must_use]
    pub fn chat_env(&self) -> std::collections::BTreeMap<String, String> {
        let mut env: std::collections::BTreeMap<String, String> = self
            .env
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if let Some(launch) = &self.chat {
            env.extend(launch.env.iter().map(|(k, v)| (k.clone(), v.clone())));
        }
        env
    }

    /// Resolve prompt prefix args. Returns None if agent doesn't support prompt mode.
    #[must_use]
    pub fn resolve_prompt_args(&self) -> Option<Vec<String>> {
        self.prompt_args.clone()
    }

    /// Resolve prompt suffix args (appended after prompt).
    #[must_use]
    pub fn resolve_post_prompt_args(&self) -> Vec<String> {
        self.post_prompt_args.clone().unwrap_or_default()
    }
}

/// 旧结构的完整镜像 —— **唯一**迁移入口。
///
/// 只用于反序列化：`chat_command` / `chat_args` 在此接收旧值，由 [`convert`]
/// 合并进 [`ChatLaunch`] 后丢弃。字段顺序与 `AgentConfig` 无关（`serde` 按名取），
/// 这里保留的是 **旧文件里可能出现的全部键**。
#[derive(Deserialize)]
struct RawAgentConfig {
    id: String,
    name: String,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    is_builtin: bool,
    #[serde(default)]
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: HashMap<String, String>,
    /// 旧：`"acp"` / `{"transport":"acp","args":[…]}` —— 由 `ChatLaunch` 迁移。
    #[serde(default)]
    chat: Option<ChatLaunch>,
    /// 旧：chat 专用可执行文件覆盖 → 并入 `ChatLaunch::program`。
    #[serde(default)]
    chat_command: Option<String>,
    /// 旧：chat 附加参数 → 追加进 `ChatLaunch::args`。
    #[serde(default)]
    chat_args: Option<Vec<String>>,
    #[serde(default)]
    prompt_args: Option<Vec<String>>,
    #[serde(default)]
    interactive_prompt_args: Option<Vec<String>>,
    #[serde(default)]
    post_prompt_args: Option<Vec<String>>,
    #[serde(default)]
    model_list_args: Option<Vec<String>>,
    #[serde(default)]
    skill_path: Option<String>,
    #[serde(default)]
    detection: Option<Detection>,
    #[serde(default)]
    deploy: DeploySpec,
}

/// 旧形态 → 新形态。三条迁移规则：
///
/// 1. `chat` 本身由 [`ChatLaunch`] 的 `Deserialize` 迁移（裸字符串 → program/args）。
/// 2. `chat_command` 非空白时**覆盖** `program`（它描述的是另一个二进制）。
/// 3. `chat_args` **追加**在 args 尾部，过滤空串。
///
/// 三者都为空时 `chat` 保持 `None` —— 无 CHAT 能力，不因为存在空的旧字段而
/// 凭空造出一个 `chat`。
fn convert(raw: RawAgentConfig) -> AgentConfig {
    let chat = match raw.chat {
        Some(mut launch) => {
            if let Some(cmd) = raw
                .chat_command
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                launch.program = Some(cmd.to_string());
            }
            if let Some(extra) = raw.chat_args {
                launch
                    .args
                    .extend(extra.into_iter().filter(|a| !a.is_empty()));
            }
            // 即便迁移后无 argv 也要保留 `Some` —— 旧 `mockAgent`（`"mock"` → `inprocess`）
            // 就是这么声明的，丢弃会改变它的能力集合。
            Some(launch)
        }
        // 只有 `chat_command` / `chat_args` 而没有 `chat`：旧配置不可能出现
        //（adapter 只在 `chat.is_some()` 时才被创建），忽略以免造出幽灵能力。
        None => None,
    };

    AgentConfig {
        id: raw.id,
        name: raw.name,
        icon: raw.icon,
        enabled: raw.enabled,
        is_builtin: raw.is_builtin,
        // 反序列化得到的 `AgentConfig` 不知道覆盖状态 —— 它由 `AgentManager`
        // 在 `overrides()` 时填充。写进配置文件的 `is_overridden` 无意义。
        is_overridden: false,
        command: raw.command,
        args: raw.args,
        env: raw.env,
        chat,
        prompt_args: raw.prompt_args,
        interactive_prompt_args: raw.interactive_prompt_args,
        post_prompt_args: raw.post_prompt_args,
        model_list_args: raw.model_list_args,
        skill_path: raw.skill_path,
        detection: raw.detection,
        deploy: raw.deploy,
    }
}

impl From<RawAgentConfig> for AgentConfig {
    fn from(raw: RawAgentConfig) -> Self {
        convert(raw)
    }
}

#[cfg(test)]
mod chat_launch_tests {
    use super::*;
    use crate::common::agent::chat_launch::{ChatLaunch, ChatTransport};

    fn launch(program: Option<&str>, args: &[&str]) -> ChatLaunch {
        ChatLaunch {
            program: program.map(str::to_string),
            args: args.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    fn base() -> AgentConfig {
        AgentConfig {
            id: "pi".into(),
            name: "Pi".into(),
            command: "pi".into(),
            args: vec!["--approve".into()],
            ..Default::default()
        }
    }

    // ── chat_cmd_vec：四种组合必须与旧实现逐条等价 ──────────────────────

    /// 无 `chat` 配置时退化为 CLI 命令（旧行为不变）。
    #[test]
    fn chat_cmd_falls_back_to_the_cli_command() {
        assert_eq!(base().chat_cmd_vec(), vec!["pi", "--approve"]);
    }

    /// `program` 覆盖可执行文件 —— `pi` 走 TUI、`pi-acp` 走 ACP 是真实需求。
    /// 覆盖后**不再继承** CLI 的 args：它们描述的是另一个进程。
    #[test]
    fn program_overrides_the_executable_without_inheriting_cli_args() {
        let cfg = AgentConfig {
            chat: Some(launch(Some("pi-acp"), &[])),
            ..base()
        };
        assert_eq!(cfg.chat_cmd_vec(), vec!["pi-acp"]);
    }

    /// `chat.args` 追加在命令之后（program 为空时继承 CLI 命令）。
    #[test]
    fn args_append_to_the_inherited_cli_command() {
        let cfg = AgentConfig {
            chat: Some(launch(None, &["--provider", "x"])),
            ..base()
        };
        assert_eq!(
            cfg.chat_cmd_vec(),
            vec!["pi", "--approve", "--provider", "x"]
        );
    }

    /// program + args 同时存在：互不污染。
    #[test]
    fn program_and_args_compose() {
        let cfg = AgentConfig {
            chat: Some(launch(Some("pi-acp"), &["--verbose"])),
            ..base()
        };
        assert_eq!(cfg.chat_cmd_vec(), vec!["pi-acp", "--verbose"]);
    }

    /// 空 `program` 视为「没写」，而不是「可执行文件叫空串」。
    /// 否则 argv[0] 是 `""`，spawn 会失败在难以定位的地方。
    #[test]
    fn blank_program_is_ignored() {
        let cfg = AgentConfig {
            chat: Some(launch(Some("   "), &[])),
            ..base()
        };
        assert_eq!(cfg.chat_cmd_vec(), vec!["pi", "--approve"]);
    }

    /// 空 args 不产生痕迹。
    #[test]
    fn empty_args_are_a_no_op() {
        let cfg = AgentConfig {
            chat: Some(launch(None, &[])),
            ..base()
        };
        assert_eq!(cfg.chat_cmd_vec(), vec!["pi", "--approve"]);
    }

    // ── chat_env：合并矩阵 ───────────────────────────────────────────

    fn cfg_with_env(global: &[(&str, &str)], chat: &[(&str, &str)]) -> AgentConfig {
        let mut env = ChatLaunch::default();
        for (k, v) in chat {
            env.env.insert((*k).into(), (*v).into());
        }
        AgentConfig {
            env: global
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
            chat: Some(env),
            ..base()
        }
    }

    /// 合并矩阵：全局 ∪ chat，靠后覆盖靠前。
    #[test]
    fn chat_env_merges_global_then_launch() {
        // 两者都空
        let cfg = AgentConfig {
            chat: Some(ChatLaunch::default()),
            ..base()
        };
        assert!(cfg.chat_env().is_empty());

        // 只有全局
        let got = cfg_with_env(&[("A", "1")], &[]).chat_env();
        assert_eq!(got.get("A").map(String::as_str), Some("1"));

        // 只有 chat
        let got = cfg_with_env(&[], &[("B", "2")]).chat_env();
        assert_eq!(got.get("B").map(String::as_str), Some("2"));

        // 两者都有 → 并存
        let got = cfg_with_env(&[("A", "1")], &[("B", "2")]).chat_env();
        assert_eq!(got.get("A").map(String::as_str), Some("1"));
        assert_eq!(got.get("B").map(String::as_str), Some("2"));

        // 同名 → chat 胜
        let got = cfg_with_env(&[("K", "old")], &[("K", "new")]).chat_env();
        assert_eq!(got.get("K").map(String::as_str), Some("new"));
    }

    /// 没有 `chat` 时全局 env 仍然生效（chat_env 不是「chat 专属」的过滤器）。
    #[test]
    fn chat_env_includes_global_without_chat_capability() {
        let cfg = AgentConfig {
            env: [("A".to_string(), "1".to_string())].into_iter().collect(),
            chat: None,
            ..base()
        };
        assert_eq!(cfg.chat_env().get("A").map(String::as_str), Some("1"));
    }

    // ── 反序列化迁移矩阵（经 `AgentConfig`，即真实 config.json 路径）─────

    fn parse_agent(chat_json: &str) -> AgentConfig {
        let json = format!(r#"{{"id":"x","name":"X","command":"x","chat":{chat_json}}}"#);
        serde_json::from_str(&json).expect("migrate agent")
    }

    /// R4 迁移矩阵：六种旧形态经完整 `AgentConfig` 反序列化后成立。
    #[test]
    fn legacy_chat_forms_migrate_losslessly() {
        // "acp" → 无附加参数，默认 ACP
        let cfg = parse_agent(r#""acp""#);
        let l = cfg.chat.clone().expect("acp keeps capability");
        assert_eq!(l.program, None);
        assert!(l.args.is_empty());
        assert_eq!(l.transport(), ChatTransport::Acp);
        assert_eq!(cfg.chat_cmd_vec(), vec!["x"]);

        // "serve" → opencode serve
        let cfg = parse_agent(r#""serve""#);
        let l = cfg.chat.clone().expect("serve");
        assert_eq!(l.program.as_deref(), Some("opencode"));
        assert_eq!(cfg.chat_cmd_vec(), vec!["opencode", "serve"]);
        assert_eq!(l.transport(), ChatTransport::Serve);

        // "jsonl" → --jsonl
        let cfg = parse_agent(r#""jsonl""#);
        assert_eq!(cfg.chat_cmd_vec(), vec!["x", "--jsonl"]);
        assert_eq!(cfg.chat.as_ref().unwrap().transport(), ChatTransport::Jsonl);

        // "pi-rpc" → --mode rpc
        let cfg = parse_agent(r#""pi-rpc""#);
        assert_eq!(cfg.chat_cmd_vec(), vec!["x", "--mode", "rpc"]);
        assert_eq!(cfg.chat.as_ref().unwrap().transport(), ChatTransport::PiRpc);

        // "mock" → 无附加参数（mock 降级为测试桩，但仍保留 CHAT 能力）
        let cfg = parse_agent(r#""mock""#);
        assert!(cfg.chat.is_some());
        assert_eq!(cfg.chat_cmd_vec(), vec!["x"]);
    }

    /// 旧对象形态 + `chat_command` + `chat_args` 三者合一的完整迁移。
    #[test]
    fn legacy_object_form_with_command_and_args_migrates() {
        let json = r#"{
            "id":"x","name":"X","command":"pi","args":["--approve"],
            "chat":{"transport":"acp","args":["--acp"]},
            "chat_command":"pi-acp","chat_args":["--verbose",""]
        }"#;
        let cfg: AgentConfig = serde_json::from_str(json).expect("legacy triple");

        let l = cfg.chat.as_ref().expect("chat");
        // chat_command 覆盖 program
        assert_eq!(l.program.as_deref(), Some("pi-acp"));
        // 对象形态的 args + chat_args（空串被过滤）
        assert_eq!(l.args, vec!["--acp", "--verbose"]);
        // 覆盖后不继承 CLI 的 args
        assert_eq!(cfg.chat_cmd_vec(), vec!["pi-acp", "--acp", "--verbose"]);
    }

    /// 旧 `chat_args` 在 program 为空时追加在继承的 CLI 命令之后。
    #[test]
    fn legacy_chat_args_append_to_inherited_command() {
        let json = r#"{
            "id":"x","name":"X","command":"pi","args":["--approve"],
            "chat":"acp","chat_args":["--provider","x"]
        }"#;
        let cfg: AgentConfig = serde_json::from_str(json).expect("legacy args");
        assert_eq!(
            cfg.chat_cmd_vec(),
            vec!["pi", "--approve", "--provider", "x"]
        );
    }

    /// 旧配置缺 `env` 字段 → 默认为空 map，而不是反序列化失败。
    #[test]
    fn legacy_config_without_env_parses() {
        let json = r#"{"id":"x","name":"X","command":"x"}"#;
        let cfg: AgentConfig = serde_json::from_str(json).expect("no env");
        assert!(cfg.env.is_empty());
        assert!(cfg.chat.is_none());
    }

    /// **全局 `env` 必须原样透传** —— 它不属于 chat，不能被迁移层清空。
    #[test]
    fn global_env_survives_migration() {
        let json = r#"{"id":"x","name":"X","command":"x","env":{"A":"1"},"chat":"acp"}"#;
        let cfg: AgentConfig = serde_json::from_str(json).expect("global env");
        assert_eq!(cfg.env.get("A").map(String::as_str), Some("1"));
    }

    /// 未声明的旧字符串会让整份配置反序列化失败（D1）—— 这是刻意的：
    /// 拼错的 transport 比起「静默当 ACP 跑起来」更容易被发现。
    #[test]
    fn unknown_transport_string_fails_the_whole_config() {
        let json = r#"{"id":"x","name":"X","command":"x","chat":"acpp"}"#;
        let err = serde_json::from_str::<AgentConfig>(json).unwrap_err();
        assert!(err.to_string().contains("acpp"));
    }
}
