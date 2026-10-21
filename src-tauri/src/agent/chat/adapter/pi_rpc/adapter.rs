//! [`PiRpcAdapter`] —— 把 `ChatStart::PiRpc` 接到 [`PiSession`] 上。
//!
//! 只做两件事：把 `AgentConfig` 的启动命令交给会话，声明本传输的能力。
//! 协议细节在 `process.rs` / `translate.rs` / `session.rs`，配置投影在 `config.rs`。

use async_trait::async_trait;

use super::session::PiSession;
use crate::agent::chat::adapter::{AgentAdapter, AgentContext, AgentKind, AgentSession};
use crate::common::error::AppError;

/// Pi 的私有 rpc 协议适配器（`pi --mode rpc`，单进程）。
pub struct PiRpcAdapter {
    /// 完整的启动命令（`command` + 用户配置的 `args`）。
    cmd: Vec<String>,
}

impl PiRpcAdapter {
    /// 用 `AgentConfig::cmd_vec()` 构造。
    #[must_use]
    pub const fn new(cmd: Vec<String>) -> Self {
        Self { cmd }
    }
}

#[async_trait]
impl AgentAdapter for PiRpcAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Custom
    }

    /// Pi 在会话内切模型（`set_model`）并下发档位（`get_available_thinking_levels`）。
    fn supports_model_selection(&self) -> bool {
        true
    }

    async fn create(&self, ctx: &AgentContext) -> Result<Box<dyn AgentSession>, AppError> {
        Ok(Box::new(PiSession::start(&self.cmd, ctx).await?))
    }
}
