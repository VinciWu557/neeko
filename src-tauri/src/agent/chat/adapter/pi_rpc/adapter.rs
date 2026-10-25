//! [`PiRpcAdapter`] —— 把 `pi --mode rpc` 传输接到 [`PiSession`] 上。
//!
//! 只做两件事：把 `AgentConfig` 的启动命令交给会话，声明本传输的能力。
//! 协议细节在 `process.rs` / `translate.rs` / `session.rs`，配置投影在 `config.rs`。

use async_trait::async_trait;
use serde_json::json;

use super::config::commands_from_response;
use super::process::PiRpcProcess;
use super::session::PiSession;
use crate::agent::chat::adapter::{
    AgentAdapter, AgentCommand, AgentContext, AgentKind, AgentSession,
};
use crate::agent::chat::capabilities::{ChatCapabilities, ConfigCapability};
use crate::common::agent::types::AgentConfig;
use crate::common::error::AppError;

/// Pi 的私有 rpc 协议适配器（`pi --mode rpc`，单进程）。
pub struct PiRpcAdapter {
    /// 完整的启动命令（`command` + 用户配置的 `args`）。
    cmd: Vec<String>,
    /// 注入给子进程的环境变量（追加，不替换继承）。
    env: std::collections::BTreeMap<String, String>,
}

impl PiRpcAdapter {
    /// 用 `AgentConfig::chat_cmd_vec()` + `chat_env()` 构造。
    #[must_use]
    pub const fn new(cmd: Vec<String>, env: std::collections::BTreeMap<String, String>) -> Self {
        Self { cmd, env }
    }
}

#[async_trait]
impl AgentAdapter for PiRpcAdapter {
    /// Pi 的 rpc 协议：模型 / 档位经 `configOptions`（变更全量回推），
    /// `select` / `confirm` 映射为审批，`get_state.sessionId` 提供恢复句柄，
    /// `get_commands` 提供 slash 命令列表。
    ///
    /// # `commands: true` 的依据
    ///
    /// pi 的 `get_commands` 实测返回 157 条（`prompt` / `skill` / `extension`，
    /// spec `agent-chat-transports.md` §9.4），本 adapter 以独立查询
    /// [`AgentAdapter::list_commands`] 提供它（短暂 spawn rpc 进程 → 查询 →
    /// 关闭，与会话生命周期解耦，同 `list_models` 一类）—— 不是「握手时推
    /// 事件给前端」的方案。前端 `/` 入口由 `SessionStart.capabilities.commands`
    /// 能力位门控；声明与实现的一致性由 `capability_probe.rs` 的契约测试钉住。
    fn chat_capabilities(&self) -> ChatCapabilities {
        ChatCapabilities {
            config: ConfigCapability::SessionConfig,
            approvals: true,
            commands: true,
            resume: true,
        }
    }

    /// 短暂 spawn 一个 rpc 进程查 `get_commands` 后即弃（方案 B，design §3）。
    ///
    /// 命令列表基本是用户级事实（`~/.pi/agent/**` 的 prompt/skill/extension），
    /// 所以 cwd 用当前目录即可；项目级 `.pi/prompts` 需要项目 cwd，属后续
    /// 增量。解析在 [`commands_from_response`]（纯函数，独立单测）。
    async fn list_commands(
        &self,
        _config: &AgentConfig,
        _directory: Option<&str>,
    ) -> Result<Vec<AgentCommand>, AppError> {
        let program = self
            .cmd
            .first()
            .ok_or_else(|| AppError::InvalidInput("pi-rpc: empty command".into()))?;
        let extra: Vec<&str> = self.cmd[1..].iter().map(String::as_str).collect();
        let env_ref: Vec<(&str, &str)> = self
            .env
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let proc = PiRpcProcess::spawn(program, ".", &extra, &env_ref).await?;
        let result = list_commands_with(&proc).await;
        proc.dispose();
        result
    }

    fn kind(&self) -> AgentKind {
        AgentKind::Custom
    }

    async fn create(&self, ctx: &AgentContext) -> Result<Box<dyn AgentSession>, AppError> {
        Ok(Box::new(
            PiSession::start(&self.cmd, ctx, self.chat_capabilities(), &self.env).await?,
        ))
    }
}

/// 查询并解析命令列表（与 spawn 路径拆开：测试可用假连接注入，
/// 不必起真 pi 进程 —— 与 `PiSession::start_with` 同一拆法）。
async fn list_commands_with(proc: &PiRpcProcess) -> Result<Vec<AgentCommand>, AppError> {
    let data = proc.request(json!({"type": "get_commands"}), None).await?;
    Ok(commands_from_response(&data))
}
