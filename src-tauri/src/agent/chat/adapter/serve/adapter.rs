use async_trait::async_trait;

use crate::agent::chat::adapter::{AgentAdapter, AgentContext, AgentKind, AgentSession};
use crate::agent::chat::capabilities::{ChatCapabilities, ConfigCapability};
use crate::common::agent::types::{AgentConfig, ModelInfo};
use crate::common::error::AppError;

use super::connection::serve_connection;
use super::protocol::{session_create_body, session_create_url};
use super::request::attach_streaming;

/// Serve-backed adapter for opencode (`serve` REST + SSE transport).
///
/// 一个进程级的 `opencode serve` 被所有会话共享（见 `connection.rs` 的
/// `OnceCell`）。模型切换走**每轮请求参数**，不产生 `config_option_update`。
#[derive(Default)]
pub struct ServeAdapter;

impl ServeAdapter {
    /// Create a serve-backed adapter.
    #[must_use]
    pub const fn new() -> Self {
        Self
    }
}

/// `opencode models --verbose` 快速路径。
#[async_trait]
impl AgentAdapter for ServeAdapter {
    fn kind(&self) -> AgentKind {
        AgentKind::Opencode
    }

    /// serve 的模型切换靠 **每轮 HTTP 请求参数**（`Turn { model_id }`），
    /// 不走 `set_config_option`，也不产生 `config_option_update`。
    ///
    /// 这正是 P1 的例子：旧 `supports_model_selection` 对它返回 true，
    /// 前端据此以为「可以切模型」，但点选后走 `set_config_option` 是空实现 ——
    /// 静默无操作。`PerTurn` 把机制差异表达出来。
    fn chat_capabilities(&self) -> ChatCapabilities {
        ChatCapabilities {
            config: ConfigCapability::PerTurn,
            approvals: true,
            commands: false,
            resume: true,
        }
    }

    /// serve 传输有独立的列模型命令（`opencode models --verbose`），
    /// 因此能在**建会话之前**给出列表。
    ///
    /// 这属于「快速路径」：ACP 的模型列表只能从会话的 `configOptions` 取，
    /// 而用户打开 Chat 时还没有会话。有这条命令就能先把选择器填上。
    async fn list_models(&self, config: &AgentConfig) -> Result<Vec<ModelInfo>, AppError> {
        // 用户在设置里可以覆盖二进制路径；未覆盖时用 `command`。
        let binary = if config.command.is_empty() {
            None
        } else {
            Some(config.command.clone())
        };
        crate::agent::model_discovery::discover_opencode_models(binary).await
    }

    async fn create(&self, ctx: &AgentContext) -> Result<Box<dyn AgentSession>, AppError> {
        let conn = serve_connection().await?;

        // ── 1. Create the serve session ───────────────────────────────────
        let resp = conn
            .client
            .post(session_create_url(&conn.base_url, ctx))
            .json(&session_create_body(ctx))
            .send()
            .await
            .map_err(|e| AppError::Io(format!("serve POST /session failed: {e}")))?;
        if !resp.status().is_success() {
            return Err(AppError::Agent(format!(
                "serve POST /session: HTTP {}",
                resp.status()
            )));
        }
        let session_json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Io(format!("serve session response parse: {e}")))?;
        let serve_sid = session_json
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("serve session response missing id".into()))?
            .to_string();
        log::info!(
            "[ServeAdapter] session created: {} (serve id {serve_sid})",
            ctx.session_id
        );

        attach_streaming(conn, ctx, serve_sid, self.chat_capabilities()).await
    }

    async fn resume(
        &self,
        ctx: &AgentContext,
        native_session_id: &str,
    ) -> Result<Box<dyn AgentSession>, AppError> {
        if native_session_id.is_empty() {
            return Err(AppError::InvalidInput(
                "resume requires a non-empty native session id".into(),
            ));
        }
        let conn = serve_connection().await?;
        log::info!(
            "[ServeAdapter] resuming native session {native_session_id} as {}",
            ctx.session_id
        );
        attach_streaming(
            conn,
            ctx,
            native_session_id.to_string(),
            self.chat_capabilities(),
        )
        .await
    }

    fn supports_chat_resume(&self) -> bool {
        true
    }
}
