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
}
