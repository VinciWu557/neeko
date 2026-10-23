//! [`PiRpcAdapter`] —— 把 `pi --mode rpc` 传输接到 [`PiSession`] 上。
//!
//! 只做两件事：把 `AgentConfig` 的启动命令交给会话，声明本传输的能力。
//! 协议细节在 `process.rs` / `translate.rs` / `session.rs`，配置投影在 `config.rs`。

use async_trait::async_trait;

use super::session::PiSession;
use crate::agent::chat::adapter::{AgentAdapter, AgentContext, AgentKind, AgentSession};
use crate::agent::chat::capabilities::{ChatCapabilities, ConfigCapability};
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
    /// `select` / `confirm` 映射为审批，`get_state.sessionId` 提供恢复句柄。
    ///
    /// # 为什么 `commands` 是 `false`
    ///
    /// pi 的 `get_commands` 确实存在（实测 157 条），但**本仓没有任何实现**：
    /// 没有握手调用、没有 `CommandList` 事件、前端也没有消费点。声明 `true`
    /// 就是红线 14 的「声明了却没人实现 = 静默功能缺失」。等真做了投影
    /// （`get_commands` → 事件 → slash 面板）再改成 `true`，且同一 diff 内。
    fn chat_capabilities(&self) -> ChatCapabilities {
        ChatCapabilities {
            config: ConfigCapability::SessionConfig,
            approvals: true,
            commands: false,
            resume: true,
        }
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
