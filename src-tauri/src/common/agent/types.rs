//! Agent 配置定义 —— 唯一数据结构（Single Source of Truth）。
//!
//! 一个 Agent 就是一个 [`AgentConfig`]：既是设置页编辑/持久化的数据结构，也是
//! 内置（`builtin::builtin_configs`）与自定义（`customAgents`）统一的载体。
//! 运行时按需经 `AgentProvider::from(&config)` 包装为行为对象（adapter 创建、
//! 部署路径解析、安装检测）。
//!
//! CLI / CHAT / Headless 是三个正交能力：
//! - CLI：`command` 非空（终端 Tab + PTY 跑 agent 自带 TUI）；
//! - CHAT：`chat: Option<ChatStart>`（`kind:'agent-chat'` Tab + adapter 驱动）；
//! - Headless：`prompt_args`（程序化单轮，如 AI commit）。

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashMap;

/// CHAT 能力 = 传输协议 + 启动方式（自包含，`AgentProvider::chat_adapter` 直接
/// match，无需按 agent id 特判）。序列化为小写字符串（`"acp"|"serve"|"jsonl"|"mock"`），
/// 兼容旧配置 `chat_transport` 字面量。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ChatStart {
    /// Agent Client Protocol over JSON-RPC stdio（子进程）。
    /// `args` 为二进制后附加的 ACP 子命令参数（opencode 需 `["acp"]`；二进制本身
    /// 即 ACP 则空）。**会随配置持久化** —— 这是让任意 agent 声明 ACP 启动方式的
    /// 唯一通道；内置定义仍可直接提供，用户配置可覆盖。
    Acp {
        /// ACP 子命令参数（opencode: `["acp"]`）。
        args: Vec<String>,
    },
    /// opencode serve：HTTP + SSE，支持按会话/轮次选择模型。
    Serve,
    /// JSON-Lines stdio（自定义协议，保留供未来 agent 声明）。
    Jsonl,
    /// 进程内 mock（mockAgent，无子进程）。
    Mock,
    /// Pi 的**私有** rpc 协议：`pi --mode rpc`（NDJSON over stdio）。
    ///
    /// 与 `Jsonl` 不是一回事 —— `Jsonl` 是 DeepSeek Harness 的私有协议，
    /// 两者的命令形状与事件类型完全不同，共用一个变体会让适配器里出现
    /// 「解码后再按 kind 分支」的二段分派。
    PiRpc,
}

impl ChatStart {
    /// 传输的协议标识（小写字符串）。
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Acp { .. } => "acp",
            Self::Serve => "serve",
            Self::Jsonl => "jsonl",
            Self::Mock => "mock",
            Self::PiRpc => "pi-rpc",
        }
    }
}

impl Serialize for ChatStart {
    /// ACP 且带启动参数时写对象形态 `{"transport":"acp","args":[...]}`，
    /// 其余（含 args 为空的 ACP）写裸字符串。
    ///
    /// 优先写字符串的理由：已有用户的 config.json 就是这种形态，无参数时
    /// 不制造 diff；对象形态只在**确实有信息要带**时出现。
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Acp { args } if !args.is_empty() => {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("transport", self.as_str())?;
                map.serialize_entry("args", args)?;
                map.end()
            }
            _ => serializer.serialize_str(self.as_str()),
        }
    }
}

impl<'de> Deserialize<'de> for ChatStart {
    /// 接受两种形态：
    ///
    /// - **裸字符串**（旧格式）：`"acp" | "serve" | "jsonl" | "mock"`。
    ///   未知字符串沿用旧语义当作 `acp`（不带 args），保证老配置与未来新增
    ///   传输名都不会让整个 `AgentConfig` 反序列化失败。
    /// - **对象**（新格式）：`{"transport":"acp","args":[...]}`。
    ///   目前只有 ACP 需要携带启动参数 —— 其余传输的启动方式由 `command` 决定。
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;

        let value = serde_json::Value::deserialize(deserializer)?;

        if let Some(s) = value.as_str() {
            return Ok(match s {
                "serve" => Self::Serve,
                "jsonl" => Self::Jsonl,
                "mock" => Self::Mock,
                // ⚠️ 新变体必须写在下面这条兜底**之前**。兜底接收一切未列举的
                // 字符串，写在它之后的分支永远命中不到 —— 而且不报错，只会把
                // agent 悄悄当成 ACP 去 spawn。
                "pi-rpc" => Self::PiRpc,
                // "acp" 及未知值 → Acp（args 由内置定义提供）。
                _ => Self::Acp { args: Vec::new() },
            });
        }

        let obj = value
            .as_object()
            .ok_or_else(|| D::Error::custom("ChatStart must be a string or an object"))?;
        let transport = obj
            .get("transport")
            .and_then(|v| v.as_str())
            .ok_or_else(|| D::Error::custom("ChatStart object requires a string 'transport'"))?;

        match transport {
            "acp" => {
                let args = obj
                    .get("args")
                    .map(|v| serde_json::from_value::<Vec<String>>(v.clone()))
                    .transpose()
                    .map_err(D::Error::custom)?
                    .unwrap_or_default();
                Ok(Self::Acp { args })
            }
            other => Err(D::Error::custom(format!(
                "transport '{other}' does not accept a structured form (only 'acp' does)"
            ))),
        }
    }
}

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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// Executable command path（CLI 能力基础；空 = 无终端 TUI，如 mockAgent）。
    pub command: String,
    /// Arguments to pass to the command.
    pub args: Vec<String>,
    /// Environment variables for the agent process.
    pub env: HashMap<String, String>,
    /// CHAT 能力：传输协议 + 启动方式（`None` = 无 CHAT 能力）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<ChatStart>,
    /// CHAT 会话进程的**可执行文件**覆盖（`None` = 沿用 [`Self::command`]）。
    ///
    /// 真实需求：同一个 agent 的 TUI 与 chat 可能不是同一个二进制 ——
    /// `pi` 走自己的 rpc，而 `pi-acp` 是把它包成 ACP 的独立入口。
    ///
    /// **一旦设置，CLI 的 [`Self::args`] 不再被 chat 继承**：那些参数描述的是
    /// 另一个进程（如 TUI 的 `--approve`），套到别的二进制上轻则报错重则改行为。
    /// 需要给 chat 传参请用 [`Self::chat_args`]。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_command: Option<String>,
    /// CHAT 会话进程的附加参数，追加在可执行文件之后。
    ///
    /// 与 [`Self::args`] 分开的理由：后者是**终端 TUI 的启动参数**
    ///（`terminalCache.ts` 用它起 TUI），两者要的是不同参数。
    /// 共用一份会让「TUI 要 `--approve`、chat 要 `--provider x`」无解。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_args: Option<Vec<String>>,
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
    /// 「列出可用模型」命令参数，如 pi 的 `["--list-models"]`、
    /// opencode 的 `["models", "--verbose"]`。`None` = 没有独立列模型命令。
    ///
    /// **与 CHAT 能力无关**：这是纯 CLI 查询，`chat: None` 的 agent 也能有。
    /// 存在它才能让用户在**发第一条消息之前**看到模型列表 —— ACP 协议的模型列表
    /// 只存在于会话的 `configOptions` 里，没有独立查询方法。
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

    /// 拼装 **chat 会话进程**的启动参数。
    ///
    /// 与 [`Self::cmd_vec`] 的区别：这里服务的是 chat 传输，不是终端 TUI。
    ///
    /// | 配置 | 结果 |
    /// | --- | --- |
    /// | 无覆盖 | `command + args`（旧行为，向后兼容） |
    /// | 有 `chat_command` | `chat_command + chat_args`（**不继承** `args`） |
    /// | 只有 `chat_args` | `command + args + chat_args` |
    ///
    /// 空白 `chat_command` 视为未设置 —— 否则 `argv[0]` 是空串，
    /// spawn 会在难以定位的地方失败。
    #[must_use]
    pub fn chat_cmd_vec(&self) -> Vec<String> {
        let override_cmd = self
            .chat_command
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let mut v = match override_cmd {
            // 覆盖了可执行文件 → 它是另一个进程，不继承 CLI 的 args。
            Some(cmd) => vec![cmd.to_string()],
            None => self.cmd_vec(),
        };
        if let Some(extra) = &self.chat_args {
            v.extend(extra.iter().filter(|a| !a.is_empty()).cloned());
        }
        v
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

#[cfg(test)]
mod chat_start_serde_tests {
    use super::ChatStart;

    /// 旧配置写的是裸字符串。**必须继续可读** —— 已有用户的 config.json 里就是这种形态。
    #[test]
    fn reads_legacy_bare_string_acp() {
        let parsed: ChatStart = serde_json::from_str(r#""acp""#).expect("legacy acp");
        assert_eq!(parsed, ChatStart::Acp { args: vec![] });
    }

    #[test]
    fn reads_legacy_bare_string_variants() {
        assert_eq!(
            serde_json::from_str::<ChatStart>(r#""serve""#).unwrap(),
            ChatStart::Serve
        );
        assert_eq!(
            serde_json::from_str::<ChatStart>(r#""jsonl""#).unwrap(),
            ChatStart::Jsonl
        );
        assert_eq!(
            serde_json::from_str::<ChatStart>(r#""mock""#).unwrap(),
            ChatStart::Mock
        );
    }

    /// 新形态：对象承载 ACP 启动参数。这是「给任意 agent 配 ACP 命令」的前提。
    #[test]
    fn reads_object_form_with_args() {
        let parsed: ChatStart =
            serde_json::from_str(r#"{"transport":"acp","args":["--acp"]}"#).expect("object acp");
        assert_eq!(
            parsed,
            ChatStart::Acp {
                args: vec!["--acp".to_string()]
            }
        );
    }

    /// args 为空时写字符串：保持 config.json 的 diff 最小，也不改变既有用户文件形态。
    #[test]
    fn writes_bare_string_when_args_are_empty() {
        let json = serde_json::to_string(&ChatStart::Acp { args: vec![] }).unwrap();
        assert_eq!(json, r#""acp""#);
    }

    /// args 非空才写对象 —— 这是信息的唯一承载处，不能丢。
    #[test]
    fn writes_object_form_when_args_are_present() {
        let json = serde_json::to_string(&ChatStart::Acp {
            args: vec!["--acp".to_string(), "--verbose".to_string()],
        })
        .unwrap();
        assert_eq!(json, r#"{"transport":"acp","args":["--acp","--verbose"]}"#);
    }

    /// 往返不变量：序列化再反序列化必须回到同一值（含 args）。
    #[test]
    fn round_trips_acp_args() {
        let original = ChatStart::Acp {
            args: vec!["--acp".to_string()],
        };
        let json = serde_json::to_string(&original).unwrap();
        let back: ChatStart = serde_json::from_str(&json).unwrap();
        assert_eq!(back, original);
    }

    /// 未知字符串沿用旧语义（当作 acp、无 args），不 panic、不报错。
    #[test]
    fn unknown_string_still_parses_as_acp() {
        let parsed: ChatStart = serde_json::from_str(r#""something-new""#).unwrap();
        assert_eq!(parsed, ChatStart::Acp { args: vec![] });
    }

    /// `"pi-rpc"` 必须解析成自己的变体，**不能被 `_ => Acp` 兜底吞掉**。
    ///
    /// 这是本类型的结构性陷阱：反序列化末尾的 `_ => Self::Acp { args }` 会接收
    /// 一切未列举的字符串。新变体的分支只要写在它之后，就永远命中不到 —— 而且
    /// 不会编译报错，只会悄悄把 Pi 当成 ACP agent 去 spawn。
    #[test]
    fn reads_pi_rpc() {
        let parsed: ChatStart = serde_json::from_str(r#""pi-rpc""#).unwrap();
        assert_eq!(parsed, ChatStart::PiRpc);
    }

    /// 往返：`PiRpc` 无额外参数 → 裸字符串。
    #[test]
    fn writes_pi_rpc_as_bare_string() {
        let json = serde_json::to_string(&ChatStart::PiRpc).unwrap();
        assert_eq!(json, r#""pi-rpc""#);
    }

    #[test]
    fn round_trips_pi_rpc() {
        let json = serde_json::to_string(&ChatStart::PiRpc).unwrap();
        let back: ChatStart = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ChatStart::PiRpc);
    }
}

#[cfg(test)]
mod chat_launch_tests {
    use super::*;

    fn base() -> AgentConfig {
        AgentConfig {
            id: "pi".into(),
            name: "Pi".into(),
            command: "pi".into(),
            args: vec!["--approve".into()],
            ..Default::default()
        }
    }

    /// 没有 chat 专用覆盖时，chat 启动沿用 `command + args`（旧行为不变）。
    #[test]
    fn chat_launch_falls_back_to_the_cli_command() {
        let cfg = base();
        assert_eq!(cfg.chat_cmd_vec(), vec!["pi", "--approve"]);
    }

    /// `chat_command` 覆盖可执行文件 —— `pi` 走 TUI、`pi-acp` 走 ACP 是真实需求。
    #[test]
    fn chat_command_overrides_the_executable() {
        let cfg = AgentConfig {
            chat_command: Some("pi-acp".into()),
            ..base()
        };
        // 覆盖后不再继承 CLI 的 args：它们描述的是另一个进程。
        assert_eq!(cfg.chat_cmd_vec(), vec!["pi-acp"]);
    }

    /// `chat_args` 追加在 chat 启动命令之后。
    #[test]
    fn chat_args_are_appended_to_the_chat_command() {
        let cfg = AgentConfig {
            chat_args: Some(vec!["--provider".into(), "x".into()]),
            ..base()
        };
        assert_eq!(
            cfg.chat_cmd_vec(),
            vec!["pi", "--approve", "--provider", "x"]
        );
    }

    /// 两者同时存在：覆盖可执行文件 + 自己的参数，互不污染。
    #[test]
    fn chat_command_and_args_compose() {
        let cfg = AgentConfig {
            chat_command: Some("pi-acp".into()),
            chat_args: Some(vec!["--verbose".into()]),
            ..base()
        };
        assert_eq!(cfg.chat_cmd_vec(), vec!["pi-acp", "--verbose"]);
    }

    /// 空 `chat_command` 视为「没写」，而不是「可执行文件叫空串」。
    /// 否则构造出的 argv[0] 是 `""`，spawn 会失败在难以定位的地方。
    #[test]
    fn empty_chat_command_is_ignored() {
        let cfg = AgentConfig {
            chat_command: Some("   ".into()),
            ..base()
        };
        assert_eq!(cfg.chat_cmd_vec(), vec!["pi", "--approve"]);
    }

    /// `chat_args` 为空数组时不产生痕迹。
    #[test]
    fn empty_chat_args_are_a_no_op() {
        let cfg = AgentConfig {
            chat_args: Some(vec![]),
            ..base()
        };
        assert_eq!(cfg.chat_cmd_vec(), vec!["pi", "--approve"]);
    }
}
