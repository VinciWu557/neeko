//! ACP adapter — generic Agent Client Protocol over JSON-RPC stdio.
//!
//! ACP (Agent Client Protocol, https://agentclientprotocol.com) is the
//! standard interop transport for programmatic agent clients. IO shape:
//! `Spawn` a CLI that speaks ACP over stdio (e.g. DeepSeek Harness
//! `dsh-acp`, Zed agents), negotiate with `initialize` / `session/new`, then
//! stream `session/update` notifications and resolve `session/request_permission`
//! requests (Gate). The adapter is transport-agnostic: no vendor line protocol,
//! no stdout JSON-Lines assumption.
//!
//! Wire format: ACP spec allows both Content-Length framed (LSP-style) and
//! NDJSON (newline-delimited JSON). This adapter auto-detects the format
//! based on the agent: OpenCode uses NDJSON, others use Content-Length.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::agent::chat::adapter::acp_config;
use crate::agent::chat::adapter::{AgentAdapter, AgentContext, AgentKind, AgentSession};
use crate::agent::chat::events::{
    Capabilities, ContextManifest, DoneReason, SessionRequest, StreamEvent, TurnEndReason,
};
use crate::agent::chat::mock;
use crate::common::error::AppError;
use crate::common::executor::factory::ExecTarget;
use crate::core::exec;

/// ACP protocol version this client speaks.
const ACP_PROTOCOL_VERSION: i64 = 1;

// ── JSON-RPC framing (LSP-style Content-Length header) ──────────────────────

/// Wire format for JSON-RPC messages.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireFormat {
    /// LSP-style Content-Length framed (e.g. DeepSeek Harness, Zed agents).
    ContentLength,
    /// NDJSON / newline-delimited JSON (e.g. OpenCode).
    Ndjson,
}

/// Encode one JSON-RPC message into a framed frame.
fn encode_frame(body: &str, format: WireFormat) -> Vec<u8> {
    match format {
        WireFormat::Ndjson => format!("{body}\n").into_bytes(),
        WireFormat::ContentLength => {
            format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes()
        }
    }
}

/// Try to decode one frame from `buf` using Content-Length format.
/// Returns `(body, consumed)` or `None` when more bytes are needed.
fn try_decode_frame_content_length(buf: &[u8]) -> Option<(String, usize)> {
    // Find the header/body separator (empty line).
    let sep = find_header_end(buf)?;
    let header = &buf[..sep];
    let header = String::from_utf8_lossy(header);
    let len = parse_content_length(&header)?;
    let body_start = sep + 4; // skip the full "\r\n\r\n" separator
    if buf.len() < body_start + len {
        return None; // body not fully buffered yet
    }
    let body = String::from_utf8_lossy(&buf[body_start..body_start + len]).into_owned();
    Some((body, body_start + len))
}

/// Try to decode one frame from `buf` using NDJSON format.
/// Returns `(body, consumed)` or `None` when more bytes are needed.
fn try_decode_frame_ndjson(buf: &[u8]) -> Option<(String, usize)> {
    // Find the next newline.
    let newline_pos = buf.iter().position(|&b| b == b'\n')?;
    let body = String::from_utf8_lossy(&buf[..newline_pos]).into_owned();
    // Skip the newline character (and optional \r before it).
    let consumed = newline_pos + 1;
    if body.is_empty() {
        // Skip empty lines and try to decode the next one.
        try_decode_frame_ndjson(&buf[consumed..])
    } else {
        Some((body, consumed))
    }
}

/// Try to decode one frame from `buf` using the given format.
fn try_decode_frame(buf: &[u8], format: WireFormat) -> Option<(String, usize)> {
    match format {
        WireFormat::ContentLength => try_decode_frame_content_length(buf),
        WireFormat::Ndjson => try_decode_frame_ndjson(buf),
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_content_length(header: &str) -> Option<usize> {
    for line in header.lines() {
        if let Some(value) = line.strip_prefix("Content-Length:") {
            return value.trim().parse().ok();
        }
    }
    None
}

// ── Protocol translation (pure, testable) ───────────────────────────────────

/// Translate a `session/update` notification into a [`StreamEvent`].
fn translate_notification(session_id: &str, params: &serde_json::Value) -> Option<StreamEvent> {
    let update = params.get("update")?;
    let kind = update.get("sessionUpdate")?.as_str()?;
    match kind {
        "agent_thought_chunk" => {
            let content = update.get("content")?;
            match content.get("type").and_then(|t| t.as_str()) {
                Some("text") => Some(StreamEvent::ReasoningDelta {
                    session_id: session_id.into(),
                    delta: content
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .into(),
                }),
                _ => None,
            }
        }
        "agent_message_chunk" => {
            let content = update.get("content")?;
            match content.get("type").and_then(|t| t.as_str()) {
                Some("text") => Some(StreamEvent::TextDelta {
                    session_id: session_id.into(),
                    delta: content
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .into(),
                }),
                _ => None, // image / other blocks: no text surface
            }
        }
        // agent 主动变更配置（典型场景：rate limit 时换模型）。协议要求视为全量。
        "config_option_update" => {
            let config_options = update
                .get("configOptions")
                .map(|v| {
                    serde_json::from_value::<Vec<acp_config::SessionConfigOption>>(v.clone())
                        .unwrap_or_default()
                })
                .unwrap_or_default();
            Some(StreamEvent::ConfigOptionUpdate {
                session_id: session_id.into(),
                config_options,
            })
        }
        "turn_end" => Some(StreamEvent::TurnEnd {
            session_id: session_id.into(),
            turn_id: update
                .get("turnId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
            reason: match update
                .get("reason")
                .and_then(|r| r.get("kind"))
                .and_then(|k| k.as_str())
            {
                Some("error") => TurnEndReason::Error,
                Some("cancelled") | Some("cancel") => TurnEndReason::Stopped,
                _ => TurnEndReason::Completed,
            },
        }),
        "agent_idle" => Some(StreamEvent::TurnEnd {
            session_id: session_id.into(),
            turn_id: String::new(),
            reason: TurnEndReason::Completed,
        }),
        "tool_call" => Some(StreamEvent::ToolStart {
            session_id: session_id.into(),
            call_id: update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
            name: update
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
            title: update
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
        }),
        "tool_output" => Some(StreamEvent::ToolOutput {
            session_id: session_id.into(),
            call_id: update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
            output: update
                .get("output")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
        }),
        "tool_end" => Some(StreamEvent::ToolEnd {
            session_id: session_id.into(),
            call_id: update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
            status: update
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("done")
                .into(),
        }),
        "command_run" => Some(StreamEvent::CommandRun {
            session_id: session_id.into(),
            call_id: update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
            cwd: update
                .get("cwd")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
            cmd: update
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .into(),
        }),
        _ => None,
    }
}

/// Translate a `session/request_permission` request (server → client) into a
/// [`StreamEvent::RequestApproval`]. Also records `call_id → rpc id` so the
/// approval reply can target the right request.
fn translate_permission_request(
    session_id: &str,
    id: i64,
    params: &serde_json::Value,
    pending: &Mutex<HashMap<String, i64>>,
) -> Option<StreamEvent> {
    let tool_call = params.get("toolCall")?;
    let call_id = tool_call.get("toolCallId")?.as_str()?.to_string();
    if let Ok(mut map) = pending.lock() {
        map.insert(call_id.clone(), id);
    }
    let title = params
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let prompt = params
        .get("explanation")
        .and_then(|v| v.as_str())
        .unwrap_or("Allow this action?")
        .to_string();
    Some(StreamEvent::RequestApproval {
        session_id: session_id.into(),
        call_id,
        tool: tool_call
            .get("toolName")
            .and_then(|v| v.as_str())
            .unwrap_or("tool")
            .into(),
        title,
        prompt,
        diff: params
            .get("diff")
            .and_then(|v| v.as_str())
            .map(String::from),
        cmd: params.get("cmd").and_then(|v| v.as_str()).map(String::from),
    })
}

/// Serialize a [`SessionRequest`] into the JSON-RPC frames to write to stdin.
///
/// 返回**序列**而不是单帧：ACP 的模型选择是会话级的（`session/set_config_option`），
/// 不是 `session/prompt` 的参数。所以「本轮换模型」必须先发一次 set_config_option，
/// 等它落定后再发 prompt —— 一个请求对应两个帧。返回单帧的实现只能二选一：
/// 要么静默丢掉模型（旧行为），要么把 prompt 发在切换之前（模型不生效）。
fn request_to_jsonrpc(
    session_id: &str,
    req: &SessionRequest,
    pending: &Mutex<HashMap<String, i64>>,
    wire_format: WireFormat,
    configs: &acp_config::ConfigOptionsState,
) -> Vec<serde_json::Value> {
    match req {
        SessionRequest::Cancel => {
            // OpenCode uses session/close instead of session/cancel.
            let method = if wire_format == WireFormat::Ndjson {
                "session/close"
            } else {
                "session/cancel"
            };
            vec![serde_json::json!({
                "jsonrpc": "2.0",
                "id": next_rpc_id(),
                "method": method,
                "params": { "sessionId": session_id }
            })]
        }
        SessionRequest::Approve { call_id, allow } => {
            let Some(id) = pending.lock().ok().and_then(|p| p.get(call_id).copied()) else {
                return Vec::new();
            };
            vec![serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "outcome": if *allow { "allow-once" } else { "reject-once" }
                }
            })]
        }
        SessionRequest::Input { turn_id, prompt } => vec![serde_json::json!({
            "jsonrpc": "2.0",
            "id": next_rpc_id(),
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "prompt": [
                    { "type": "text", "text": format!("[{turn_id}] {prompt}") }
                ]
            }
        })],
        // ACP 的模型选择是**会话级**（`session/set_config_option`），不是 per-turn 参数。
        // 因此本轮若带 model_id，必须先切配置再发 prompt —— 顺序反了模型就不生效。
        SessionRequest::Turn { prompt, model_id } => {
            let mut frames = Vec::with_capacity(2);
            // 换模型的入口共享同一套判定（见 `switch_model_frames`）。
            // 注意 `SetConfigOption` **不走这里** —— 它的 `configId` 直接来自前端渲染时
            // 那份 `configOptions` 的真实 `option.id`，本就不需要「按 category 定位」。
            if let Some(model_id) = model_id {
                if let Some(frame) = configs
                    .switch_model_frames(next_rpc_id(), session_id, model_id)
                    .into_frame()
                {
                    frames.push(frame);
                }
            }
            frames.push(serde_json::json!({
                "jsonrpc": "2.0",
                "id": next_rpc_id(),
                "method": "session/prompt",
                "params": {
                    "sessionId": session_id,
                    "prompt": [ { "type": "text", "text": prompt } ]
                }
            }));
            frames
        }
        // 用户在 popover 里改 `model_config` / `thought_level` 项：与模型切换同一条写入通道。
        SessionRequest::SetConfigOption { config_id, value } => {
            vec![acp_config::set_config_option_request(
                next_rpc_id(),
                session_id,
                config_id,
                value,
            )]
        }
        // ACP has no mid-session context rebind; ignored (page keeps state).
        SessionRequest::ContextSet { .. } | SessionRequest::Pause | SessionRequest::Resume => {
            Vec::new()
        }
    }
}

fn next_rpc_id() -> i64 {
    use std::sync::atomic::{AtomicI64, Ordering};
    static NEXT_ID: AtomicI64 = AtomicI64::new(10);
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

// ── Adapter ─────────────────────────────────────────────────────────────────

/// IO shape of the ACP endpoint.
pub enum AcpIo {
    /// Spawn a CLI that speaks ACP over stdio.
    Spawn(Vec<String>),
    /// Run the in-process mockAgent over a duplex pipe (dev/test).
    Mock,
}

/// ACP adapter. Bridges the unified [`StreamEvent`] protocol to an ACP
/// endpoint: a spawned child process, or the in-process mockAgent.
pub struct AcpAdapter {
    io: AcpIo,
    /// Wire format override. `None` = auto-detect based on command name.
    wire_format: Option<WireFormat>,
}

impl AcpAdapter {
    /// Create an ACP adapter that spawns the given command.
    #[must_use]
    pub fn new(cmd: Vec<String>) -> Self {
        // Auto-detect wire format based on command name.
        let wire_format = if cmd
            .first()
            .is_some_and(|c| c.contains("opencode") || c.contains("kilo"))
        {
            Some(WireFormat::Ndjson)
        } else {
            None
        };
        Self {
            io: AcpIo::Spawn(cmd),
            wire_format,
        }
    }

    /// Create an ACP adapter backed by the in-process mockAgent.
    #[must_use]
    pub const fn mock() -> Self {
        Self {
            io: AcpIo::Mock,
            wire_format: None,
        }
    }

    /// Create an ACP adapter with an explicit wire format.
    #[must_use]
    pub const fn with_wire_format(cmd: Vec<String>, format: WireFormat) -> Self {
        Self {
            io: AcpIo::Spawn(cmd),
            wire_format: Some(format),
        }
    }
}

#[async_trait]
impl AgentAdapter for AcpAdapter {
    /// ACP 支持模型选择，但**只在会话内**：模型列表来自 `session/new` 响应的
    /// `configOptions`，协议没有独立的「列模型」方法（见
    /// `.trellis/spec/backend/agent-acp-model-selection.md` §7）。
    ///
    /// 所以 `list_models` 用默认实现（返回 Unsupported），命令层据此回
    /// `SessionScoped` —— 那是诚实的回答，不是错误。
    fn supports_model_selection(&self) -> bool {
        true
    }

    fn kind(&self) -> AgentKind {
        AgentKind::Custom
    }

    async fn create(&self, ctx: &AgentContext) -> Result<Box<dyn AgentSession>, AppError> {
        let wire_format = self.wire_format.unwrap_or(WireFormat::ContentLength);
        log::info!(
            "[AcpAdapter::create] agent_id={}, wire_format={:?}",
            ctx.session_id,
            wire_format
        );
        match &self.io {
            AcpIo::Spawn(cmd) => {
                let target = ExecTarget::Local;
                let program = &cmd[0];
                let args: Vec<&str> = cmd[1..].iter().map(|s| s.as_str()).collect();
                log::info!("[AcpAdapter::create] Spawning: {} {:?}", program, args);
                let child = exec::spawn(&target, program, &args).await.map_err(|e| {
                    log::error!("[AcpAdapter::create] Failed to spawn: {e}");
                    AppError::Io(format!("failed to spawn acp agent: {e}"))
                })?;
                let stdout = child
                    .stdout
                    .map(BufReader::new)
                    .ok_or_else(|| AppError::Io("acp child has no stdout".into()))?;
                let stdin = child
                    .stdin
                    .ok_or_else(|| AppError::Io("acp child has no stdin".into()))?;
                log::info!("[AcpAdapter::create] Child spawned successfully, setting up session");
                Self::create_with_io(ctx, stdout, stdin, wire_format).await
            }
            AcpIo::Mock => {
                // In-process: a duplex pipe; one end drives run_mock_loop, the
                // other end is the ACP stdio pair seen by the session.
                let (client, mock) = tokio::io::duplex(65536);
                let (mock_reader, mock_writer) = tokio::io::split(mock);
                tokio::spawn(mock::run_mock_loop(mock_reader, mock_writer));
                let (client_reader, client_writer) = tokio::io::split(client);
                Self::create_with_io(
                    ctx,
                    BufReader::new(client_reader),
                    client_writer,
                    wire_format,
                )
                .await
            }
        }
    }
}

impl AcpAdapter {
    /// Shared session setup over an arbitrary ACP stdio pair: handshake
    /// (initialize → session/new), initial prompt, event pump, request channel.
    async fn create_with_io<R, W>(
        ctx: &AgentContext,
        stdout: BufReader<R>,
        stdin: W,
        wire_format: WireFormat,
    ) -> Result<Box<dyn AgentSession>, AppError>
    where
        R: tokio::io::AsyncRead + Unpin + Send + 'static,
        W: tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let session_id = ctx.session_id.clone();

        // ── Handshake: initialize → session/new ───────────────────────────
        let (req_tx, mut req_rx) = mpsc::channel::<SessionRequest>(64);
        let pending = Arc::new(Mutex::new(HashMap::<String, i64>::new()));

        let mut writer = stdin;
        let init = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": ACP_PROTOCOL_VERSION,
                "clientCapabilities": {
                    "promptCapabilities": { "image": false, "audio": false, "embeddedContext": false },
                    // 声明支持 boolean 形态的会话配置项。
                    //
                    // 规范强制：agent **MUST NOT** 下发 `type: "boolean"` 的
                    // configOptions，除非客户端在这里声明过；`{}` 即「支持」。
                    // 不声明的话，`model_config` 里的开关类参数（如 fast_mode）
                    // 会整批消失，表现为「控件本来就不该有」。
                    "session": { "configOptions": { "boolean": {} } }
                }
            }
        });
        log::info!("[AcpAdapter::create_with_io] Sending initialize");
        writer
            .write_all(&encode_frame(&init.to_string(), wire_format))
            .await
            .map_err(|e| AppError::Io(format!("acp initialize write: {e}")))?;

        let mut reader = stdout;
        // Drain until we see the response to id=1 (initialize).
        let init_response = wait_for_response(&mut reader, 1, wire_format)
            .await
            .map_err(|e| AppError::Io(format!("acp initialize handshake failed: {e}")))?;
        log::info!(
            "[AcpAdapter::create_with_io] Initialize response: {:?}",
            init_response
        );

        let new_session = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "session/new",
            "params": { "cwd": ctx.project_id, "mcpServers": [] }
        });
        log::info!("[AcpAdapter::create_with_io] Sending session/new");
        writer
            .write_all(&encode_frame(&new_session.to_string(), wire_format))
            .await
            .map_err(|e| AppError::Io(format!("acp session/new write: {e}")))?;
        let session_id_resp = wait_for_response(&mut reader, 2, wire_format)
            .await
            .map_err(|e| AppError::Io(format!("acp session/new handshake failed: {e}")))?;
        log::info!(
            "[AcpAdapter::create_with_io] session/new response: {:?}",
            session_id_resp
        );

        // Prefer the server-issued session id; fall back to ours.
        // OpenCode returns sessionId at the top level of the response.
        let acp_sid = session_id_resp
            .get("sessionId")
            .and_then(|v| v.as_str())
            .unwrap_or(&session_id)
            .to_string();

        // 会话配置项（模型列表的唯一来源）。解析失败要降级为空，**不能**中断会话：
        // Gemini / Kimi 实测根本不发这个字段，缺失是正常情况。
        let config_options = acp_config::parse_config_options(&session_id_resp);
        log::info!(
            "[AcpAdapter::create_with_io] configOptions: {} entries (categories: {:?})",
            config_options.len(),
            config_options
                .iter()
                .map(|o| o.category.as_deref().unwrap_or("<none>"))
                .collect::<Vec<_>>()
        );
        // 会话级配置状态：事件泵（读 / 被 agent 主动改）与请求通道（写）共享。
        let configs = Arc::new(acp_config::ConfigOptionsState::new(config_options.clone()));
        let configs_for_event = Arc::clone(&configs);
        let configs_for_req = Arc::clone(&configs);

        // ── Switch model before the first prompt, if one was chosen ───────
        // 新会话是最容易被忽略的一条路径：`build_context` 把 model_id 放进了 ctx，
        // 但握手后直接发 prompt 的话，用户在打开 Chat 时选的模型**不生效** —— 要等
        // 到第二轮（走 Turn）才会切过去。这是 AC5 的一半，不能漏。
        if let Some(model_id) = ctx.model_id.as_deref() {
            match configs.switch_model_frames(next_rpc_id(), &acp_sid, model_id) {
                acp_config::ModelSwitch::Frame(frame) => {
                    log::info!(
                        "[AcpAdapter::create_with_io] switching model to {model_id} before first prompt"
                    );
                    writer
                        .write_all(&encode_frame(&frame.to_string(), wire_format))
                        .await
                        .map_err(|e| AppError::Io(format!("acp set_config_option write: {e}")))?;
                }
                acp_config::ModelSwitch::AlreadySet => {
                    log::info!(
                        "[AcpAdapter::create_with_io] model {model_id} already active, skipping"
                    );
                }
                acp_config::ModelSwitch::Unsupported => {
                    log::info!(
                        "[AcpAdapter::create_with_io] agent has no model selector; ignoring model_id"
                    );
                }
            }
        }

        // ── Send the initial prompt, then start the pump ──────────────────
        if !ctx.prompt.is_empty() {
            let prompt = serde_json::json!({
                "jsonrpc": "2.0",
                "id": next_rpc_id(),
                "method": "session/prompt",
                "params": {
                    "sessionId": acp_sid,
                    "prompt": [ { "type": "text", "text": ctx.prompt } ]
                }
            });
            writer
                .write_all(&encode_frame(&prompt.to_string(), wire_format))
                .await
                .map_err(|e| AppError::Io(format!("acp prompt write: {e}")))?;
        }

        // ── Event pump ────────────────────────────────────────────────────
        let (event_tx, event_rx) = mpsc::channel(64);
        let sid = session_id.clone();
        let pending_pump = Arc::clone(&pending);
        // ctx 是借用引用，闭包需持有 owned 快照（避免 E0521 借用逃逸）。
        let ctx_project_id = ctx.project_id.clone();
        let ctx_project_name = ctx.project_name.clone();
        let ctx_env = ctx.env.clone();
        let ctx_skills = ctx.skills.clone();
        let ctx_files = ctx.files.clone();
        let ctx_mode = ctx.mode.clone();
        let ctx_agent_id = ctx.agent_id.clone();
        tokio::spawn(async move {
            // SessionStart + ContextInit emitted immediately by the adapter
            // (lifecycle contract, independent of the agent's own output).
            let _ = event_tx
                .send(StreamEvent::SessionStart {
                    session_id: sid.clone(),
                    agent: ctx_agent_id,
                    model: None,
                    config_options: configs_for_event.snapshot(),
                    capabilities: Capabilities {
                        approvals: true,
                        command_echo: false,
                        diff: false,
                        resume: false,
                    },
                })
                .await;
            let _ = event_tx
                .send(StreamEvent::ContextInit {
                    session_id: sid.clone(),
                    manifest: ContextManifest {
                        project_id: ctx_project_id,
                        project_name: ctx_project_name,
                        env: ctx_env,
                        skills: ctx_skills,
                        files: ctx_files,
                        mode: ctx_mode,
                    },
                })
                .await;

            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match reader.read(&mut chunk).await {
                    Ok(0) | Err(_) => break, // EOF / transport error
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        while let Some((body, consumed)) = try_decode_frame(&buf, wire_format) {
                            buf.drain(..consumed);
                            log::debug!("[AcpAdapter event pump] received frame: {body}");
                            for ev in handle_inbound(&body, &sid, &pending_pump, &configs_for_event)
                            {
                                log::debug!(
                                    "[AcpAdapter event pump] translated to event: {:?}",
                                    ev
                                );
                                // agent 主动变更配置 → 同步到共享状态，否则后续的写请求
                                // 会拿过期的 configId / 当前值做判断。
                                if let StreamEvent::ConfigOptionUpdate { config_options, .. } = &ev
                                {
                                    configs_for_event.replace(config_options.clone());
                                }
                                if event_tx.send(ev).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                }
            }
            // Stream closed → session done.
            let _ = event_tx
                .send(StreamEvent::SessionDone {
                    session_id: sid,
                    reason: DoneReason::Completed,
                })
                .await;
        });

        // ── Request channel: page → agent ─────────────────────────────────
        let pending_req = Arc::clone(&pending);
        let acp_sid_req = acp_sid.clone();
        let wire_format_req = wire_format;
        tokio::spawn(async move {
            while let Some(req) = req_rx.recv().await {
                let frames = request_to_jsonrpc(
                    &acp_sid_req,
                    &req,
                    &pending_req,
                    wire_format_req,
                    &configs_for_req,
                );
                let mut failed = false;
                for msg in frames {
                    if writer
                        .write_all(&encode_frame(&msg.to_string(), wire_format))
                        .await
                        .is_err()
                    {
                        failed = true;
                        break;
                    }
                }
                if failed {
                    break;
                }
            }
        });

        Ok(Box::new(AcpSession {
            event_rx,
            request_tx: req_tx,
            resume: None,
        }))
    }
}

/// Read frames until the response matching `id` arrives; returns its `result`.
async fn wait_for_response(
    reader: &mut BufReader<impl tokio::io::AsyncRead + Unpin>,
    id: i64,
    wire_format: WireFormat,
) -> Result<serde_json::Value, AppError> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = reader
            .read(&mut chunk)
            .await
            .map_err(|e| AppError::Io(format!("acp read: {e}")))?;
        if n == 0 {
            return Err(AppError::Io("acp stream closed during handshake".into()));
        }
        buf.extend_from_slice(&chunk[..n]);
        while let Some((body, consumed)) = try_decode_frame(&buf, wire_format) {
            buf.drain(..consumed);
            let v: serde_json::Value = serde_json::from_str(&body)
                .map_err(|e| AppError::Io(format!("acp bad json: {e}")))?;
            if v.get("id").and_then(|i| i.as_i64()) == Some(id) {
                if let Some(err) = v.get("error") {
                    return Err(AppError::Io(format!("acp rpc error: {err}")));
                }
                return v
                    .get("result")
                    .cloned()
                    .ok_or_else(|| AppError::Io("acp response missing result".into()));
            }
        }
    }
}

/// Dispatch one inbound JSON-RPC message (notification, server request, or client response).
fn handle_inbound(
    body: &str,
    session_id: &str,
    pending: &Mutex<HashMap<String, i64>>,
    configs: &acp_config::ConfigOptionsState,
) -> Vec<StreamEvent> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return Vec::new();
    };

    // Server → client requests / notifications carry a `method`. They may also
    // carry an `id` (JSON-RPC server request, e.g. `session/request_permission`)
    // — the method must be dispatched before the response branch below, which
    // would otherwise drop id-bearing requests.
    if let Some(method) = v.get("method").and_then(|m| m.as_str()) {
        let Some(params) = v.get("params") else {
            return Vec::new();
        };
        return match method {
            "session/update" => translate_notification(session_id, params)
                .into_iter()
                .collect(),
            "session/request_permission" => {
                let id = v.get("id").and_then(|i| i.as_i64()).unwrap_or(0);
                translate_permission_request(session_id, id, params, pending)
                    .into_iter()
                    .collect()
            }
            _ => Vec::new(),
        };
    }

    // Responses to our client requests (messages with `id` and `result`).
    if let Some(id) = v.get("id").and_then(|i| i.as_i64()) {
        if let Some(result) = v.get("result") {
            // 响应里可能同时带 `configOptions` 与 `stopReason`（协议未禁止）。
            // **先处理状态同步、再判回合结束**，但两者不能互相 early-return ——
            // 若在 configOptions 分支直接 return，回合永远不会结束，UI 会一直停在
            // 「思考中」。所以这里先把配置状态落定，再走回合判定。
            //
            // `session/set_config_option` 的响应携带**全量**配置（协议强制），
            // 必须整体替换：换模型可能连带改变 thought_level 的可选项，局部合并会
            // 留下与真实状态不符的陈旧项。
            let config_update = result
                .get("configOptions")
                .and_then(|raw| {
                    serde_json::from_value::<Vec<acp_config::SessionConfigOption>>(raw.clone()).ok()
                })
                .map(|options| {
                    configs.replace(options.clone());
                    StreamEvent::ConfigOptionUpdate {
                        session_id: session_id.into(),
                        config_options: options,
                    }
                });

            // 两个事件可以同时存在（协议未禁止），**都发**。
            // 返回 `Option` 的实现必须二选一，无论选哪个都会丢事件：丢 TurnEnd →
            // 回合永不结束（UI 卡在「思考中」）；丢 ConfigOptionUpdate → 前端与
            // agent 的真实配置分叉。改成返回序列后这个取舍消失。
            let mut events = Vec::with_capacity(2);
            if result.get("stopReason").is_some() {
                log::info!("[AcpAdapter handle_inbound] turn ended with id={}", id);
                events.push(StreamEvent::TurnEnd {
                    session_id: session_id.into(),
                    turn_id: String::new(),
                    reason: TurnEndReason::Completed,
                });
            }
            if let Some(update) = config_update {
                events.push(update);
            }
            return events;
        }
        // Other responses are ignored (e.g. session/new acknowledgments).
        return Vec::new();
    }

    Vec::new()
}

/// A live ACP session.
struct AcpSession {
    event_rx: mpsc::Receiver<StreamEvent>,
    request_tx: mpsc::Sender<SessionRequest>,
    resume: Option<String>,
}

#[async_trait]
impl AgentSession for AcpSession {
    async fn next(&mut self) -> Option<Result<StreamEvent, AppError>> {
        self.event_rx.recv().await.map(Ok)
    }

    async fn send(&mut self, req: SessionRequest) -> Result<(), AppError> {
        self.request_tx
            .send(req)
            .await
            .map_err(|e| AppError::Io(format!("acp request channel closed: {e}")))
    }

    async fn cancel(&mut self) {
        let _ = self.send(SessionRequest::Cancel).await;
        self.event_rx.close();
    }

    fn resume_id(&self) -> Option<String> {
        self.resume.clone()
    }

    fn request_channel(&self) -> Option<mpsc::Sender<SessionRequest>> {
        Some(self.request_tx.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 端到端：mockAgent 走真实 ACP 路径（AC5）────────────────────────────

    fn e2e_ctx(model_id: Option<&str>) -> AgentContext {
        AgentContext {
            agent_id: "mockAgent".into(),
            session_id: "ac_e2e".into(),
            project_id: "/tmp/demo".into(),
            project_name: "demo".into(),
            env: "local".into(),
            skills: vec![],
            files: vec![],
            mode: "auto".into(),
            prompt: String::new(),
            model_id: model_id.map(str::to_string),
        }
    }

    /// 等待某个事件，最多 `timeout`。
    ///
    /// 被测代码有缺陷时（例如切换请求根本没发出），等 `ConfigOptionUpdate` 会永远
    /// 挂着 —— 那会让 `cargo test` 挂死而不是失败，比不测还糟。这里统一加超时，
    /// 让缺陷表现为 panic。
    async fn next_event_within(
        session: &mut Box<dyn crate::agent::chat::adapter::AgentSession>,
        budget: std::time::Duration,
    ) -> Option<Result<StreamEvent, crate::common::error::AppError>> {
        // 超时 → `None`，与「流结束」同形；调用方把 `None` 当失败即可。
        tokio::time::timeout(budget, session.next())
            .await
            .ok()
            .flatten()
    }

    /// 从事件流里取出**第一个** `SessionStart` 的 configOptions。
    async fn collect_session_config(
        session: &mut Box<dyn crate::agent::chat::adapter::AgentSession>,
    ) -> Vec<acp_config::SessionConfigOption> {
        // SessionStart / ContextInit 是握手后立即由适配器发出的（生命周期契约），
        // 所以前几个事件里必定出现，不需要等 agent 自己输出。
        for _ in 0..4 {
            match next_event_within(session, std::time::Duration::from_secs(5)).await {
                Some(Ok(StreamEvent::SessionStart { config_options, .. })) => {
                    return config_options;
                }
                Some(Ok(_)) => continue,
                other => panic!("unexpected event before SessionStart: {other:?}"),
            }
        }
        panic!("SessionStart with configOptions not observed");
    }

    /// **AC5 端到端**：mockAgent 的模型列表来自会话 `configOptions`，且用户选择
    /// 会真的作为 `session/set_config_option` 下发并改变会话状态。
    ///
    /// 这条走的是生产的 `AcpAdapter::create_with_io`，不是纯函数：
    /// 进程内 duplex 管道 → 真实握手（initialize / session/new）→ 真实请求通道。
    ///
    /// mock 的模型项 `id` **故意不叫 `"model"`**，因此这条同时钉住「按 `category`
    /// 定位而不是按 `id`」—— 退回按 `id` 查找会立刻失败。
    #[tokio::test]
    async fn mock_agent_exposes_models_and_applies_switches_end_to_end() {
        // 1. 无初始模型：拿到的列表来自 session/new 的 configOptions
        let adapter = AcpAdapter::mock();
        let mut session = adapter
            .create(&e2e_ctx(None))
            .await
            .expect("create session");
        let configs = collect_session_config(&mut session).await;

        let models = acp_config::models_from_config(&configs);
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["mock-fast", "mock-thorough"],
            "model list must come from the session configOptions"
        );
        assert_eq!(
            acp_config::current_model_from_config(&configs).as_deref(),
            Some("mock-fast"),
            "initial model comes from the agent"
        );

        // 2. 应用切换：Turn 带 model_id → 适配器应先发 set_config_option
        session
            .send(SessionRequest::Turn {
                prompt: "hello".into(),
                model_id: Some("mock-thorough".into()),
            })
            .await
            .expect("send turn");

        // 3. 权威状态由 agent 回推（set_config_option 响应 → ConfigOptionUpdate）
        let mut switched_to = None;
        for _ in 0..12 {
            match next_event_within(&mut session, std::time::Duration::from_secs(5)).await {
                Some(Ok(StreamEvent::ConfigOptionUpdate { config_options, .. })) => {
                    switched_to = acp_config::current_model_from_config(&config_options);
                    break;
                }
                Some(Ok(_)) => continue,
                other => panic!("unexpected event while awaiting config update: {other:?}"),
            }
        }
        assert_eq!(
            switched_to.as_deref(),
            Some("mock-thorough"),
            "agent must confirm the switch back to the client"
        );

        session.cancel().await;
    }

    /// 新会话首轮就带 `model_id` 时，必须在**首轮 prompt 之前**切模型。
    ///
    /// 这是最容易被漏掉的一条路径：`build_context` 把 model_id 放进了 ctx，但握手后
    /// 直接发 prompt 的话，用户在打开 Chat 时选的模型不生效 —— 要等第二轮才切。
    #[tokio::test]
    async fn create_swithces_model_before_the_first_prompt() {
        let adapter = AcpAdapter::mock();
        let mut session = adapter
            .create(&e2e_ctx(Some("mock-thorough")))
            .await
            .expect("create session");

        // SessionStart 携带的 configOptions 是**握手时**解析出来的快照（还是初始值），
        // 但 agent 侧已经收到切换请求，随后的 ConfigOptionUpdate 会反映新值。
        let _ = collect_session_config(&mut session).await;

        let mut observed = None;
        for _ in 0..12 {
            match next_event_within(&mut session, std::time::Duration::from_secs(5)).await {
                Some(Ok(StreamEvent::ConfigOptionUpdate { config_options, .. })) => {
                    observed = acp_config::current_model_from_config(&config_options);
                    break;
                }
                Some(Ok(_)) => continue,
                other => panic!("unexpected event: {other:?}"),
            }
        }
        assert_eq!(
            observed.as_deref(),
            Some("mock-thorough"),
            "model chosen when opening a chat must take effect before the first prompt"
        );

        session.cancel().await;
    }

    #[test]
    fn frame_roundtrip_content_length() {
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
        let frame = encode_frame(body, WireFormat::ContentLength);
        let (decoded, consumed) =
            try_decode_frame(&frame, WireFormat::ContentLength).expect("decode");
        assert_eq!(decoded, body);
        assert_eq!(consumed, frame.len());
    }

    #[test]
    fn frame_requires_more_bytes_content_length() {
        let body = r#"{"jsonrpc":"2.0","id":1}"#;
        let frame = encode_frame(body, WireFormat::ContentLength);
        assert!(try_decode_frame(&frame[..frame.len() - 5], WireFormat::ContentLength).is_none());
    }

    #[test]
    fn frame_roundtrip_ndjson() {
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;
        let frame = encode_frame(body, WireFormat::Ndjson);
        let (decoded, consumed) = try_decode_frame(&frame, WireFormat::Ndjson).expect("decode");
        assert_eq!(decoded, body);
        assert_eq!(consumed, frame.len());
    }

    #[test]
    fn ndjson_skips_empty_lines() {
        let body = "\n\n{\"jsonrpc\":\"2.0\",\"id\":1}\n";
        let (decoded, _) = try_decode_frame(body.as_bytes(), WireFormat::Ndjson).expect("decode");
        assert_eq!(decoded, r#"{"jsonrpc":"2.0","id":1}"#);
    }

    #[test]
    fn text_chunk_notification() {
        let params = serde_json::json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": "hello" }
            }
        });
        let ev = translate_notification("s1", &params).expect("event");
        assert_eq!(
            ev,
            StreamEvent::TextDelta {
                session_id: "s1".into(),
                delta: "hello".into()
            }
        );
    }

    #[test]
    fn non_text_chunk_ignored() {
        let params = serde_json::json!({
            "sessionId": "s1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "image", "image": "base64..." }
            }
        });
        assert!(translate_notification("s1", &params).is_none());
    }

    #[test]
    fn permission_request_records_call_id() {
        let pending = Mutex::new(HashMap::new());
        let params = serde_json::json!({
            "sessionId": "s1",
            "toolCall": { "toolCallId": "c2", "toolName": "edit_file" },
            "title": "edit adapter.rs",
            "explanation": "ok?"
        });
        let ev = translate_permission_request("s1", 7, &params, &pending).expect("event");
        match ev {
            StreamEvent::RequestApproval { call_id, tool, .. } => {
                assert_eq!(call_id, "c2");
                assert_eq!(tool, "edit_file");
                assert_eq!(pending.lock().expect("lock").get("c2"), Some(&7));
            }
            other => panic!("expected RequestApproval, got {other:?}"),
        }
    }

    /// 响应同时带 `configOptions` 与 `stopReason` 时**两个事件都要发出**。
    ///
    /// 返回 `Option` 的实现只能二选一：丢 `TurnEnd` → 回合永不结束（UI 卡在
    /// 「思考中」）；丢 `ConfigOptionUpdate` → 前端配置与 agent 分叉。
    #[test]
    fn inbound_response_with_both_config_and_stop_reason_emits_both_events() {
        let pending = Mutex::new(HashMap::new());
        let configs = acp_config::ConfigOptionsState::default();
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 99,
            "result": {
                "stopReason": "end_turn",
                "configOptions": [{
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "claude-sonnet",
                    "options": []
                }]
            }
        })
        .to_string();

        let events = handle_inbound(&body, "s1", &pending, &configs);

        assert_eq!(
            events.len(),
            2,
            "expected both TurnEnd and ConfigOptionUpdate"
        );
        assert!(matches!(events[0], StreamEvent::TurnEnd { .. }));
        assert!(matches!(events[1], StreamEvent::ConfigOptionUpdate { .. }));
        // 状态同步是副作用，与事件是否发出无关：已经切到 claude-sonnet 了，
        // 再要求切到同一个值应当被识别为 AlreadySet。
        assert_eq!(
            configs.switch_model_frames(1, "s1", "claude-sonnet"),
            acp_config::ModelSwitch::AlreadySet
        );
    }

    /// 只有 configOptions（set_config_option 的响应）→ 只发一个事件。
    #[test]
    fn inbound_config_option_response_emits_only_the_update() {
        let pending = Mutex::new(HashMap::new());
        let configs = acp_config::ConfigOptionsState::default();
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 100,
            "result": {
                "configOptions": [{
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "gpt-5",
                    "options": []
                }]
            }
        })
        .to_string();

        let events = handle_inbound(&body, "s1", &pending, &configs);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], StreamEvent::ConfigOptionUpdate { .. }));
    }

    #[test]
    fn approve_replies_to_recorded_id() {
        let pending = Mutex::new(HashMap::from([("c2".to_string(), 7i64)]));
        let frames = request_to_jsonrpc(
            "s1",
            &SessionRequest::Approve {
                call_id: "c2".into(),
                allow: true,
            },
            &pending,
            WireFormat::ContentLength,
            &acp_config::ConfigOptionsState::default(),
        );
        let msg = frames.into_iter().next().expect("message");
        assert_eq!(msg.get("id").and_then(|v| v.as_i64()), Some(7));
        assert_eq!(
            msg.get("result")
                .and_then(|r| r.get("outcome"))
                .and_then(|v| v.as_str()),
            Some("allow-once")
        );
    }

    #[test]
    fn cancel_is_a_request_content_length() {
        let pending = Mutex::new(HashMap::new());
        let frames = request_to_jsonrpc(
            "s1",
            &SessionRequest::Cancel,
            &pending,
            WireFormat::ContentLength,
            &acp_config::ConfigOptionsState::default(),
        );
        let msg = frames.into_iter().next().expect("message");
        assert_eq!(
            msg.get("method").and_then(|v| v.as_str()),
            Some("session/cancel")
        );
        assert!(msg.get("id").is_some());
    }

    /// 构造一份带模型项的会话配置状态。
    ///
    /// `id` 故意**不叫** `"model"` —— 规范说 `category` 才是语义判据，`id` 只是
    /// 一个标识。写请求必须从这个状态里取真实 `configId`，不能用字面量。
    fn configs_with_model(id: &str, current: &str) -> acp_config::ConfigOptionsState {
        acp_config::ConfigOptionsState::new(vec![acp_config::SessionConfigOption {
            id: id.into(),
            name: "Model".into(),
            description: None,
            category: Some(acp_config::CATEGORY_MODEL.into()),
            kind: Some("select".into()),
            current_value: Some(acp_config::SessionConfigValue::Text(current.into())),
            options: Some(acp_config::SessionConfigSelectOptions::Ungrouped(vec![
                acp_config::SessionConfigSelectOption {
                    value: current.into(),
                    name: current.into(),
                    description: None,
                },
                acp_config::SessionConfigSelectOption {
                    value: "claude-sonnet".into(),
                    name: "Claude Sonnet".into(),
                    description: None,
                },
            ])),
            _meta: None,
        }])
    }

    /// AC5 的核心断言：带 model 的 Turn 必须**先**发 set_config_option，**再**发 prompt。
    ///
    /// ACP 的模型选择是会话级的，不是 prompt 参数。顺序反了模型就不生效 ——
    /// 这正是「显示了但不起作用」的成因。
    ///
    /// 同时锁住另一件事：`configId` 来自会话状态里的模型项，而不是字面量 `"model"`。
    /// 一个 `category: "model"` 但 `id` 为其他值的 agent 正是靠这条才不会「列得出、
    /// 切不动」。
    #[test]
    fn turn_with_model_sets_config_before_prompt() {
        let pending = Mutex::new(HashMap::new());
        let configs = configs_with_model("primary-model-selector", "gpt-5");
        let frames = request_to_jsonrpc(
            "s1",
            &SessionRequest::Turn {
                prompt: "hello".into(),
                model_id: Some("claude-sonnet".into()),
            },
            &pending,
            WireFormat::ContentLength,
            &configs,
        );

        assert_eq!(frames.len(), 2, "expected set_config_option + prompt");
        assert_eq!(frames[0]["method"], "session/set_config_option");
        // 真实 configId，不是字面量 "model"
        assert_eq!(frames[0]["params"]["configId"], "primary-model-selector");
        assert_eq!(frames[0]["params"]["value"], "claude-sonnet");
        assert_eq!(frames[1]["method"], "session/prompt");
        assert_eq!(frames[1]["params"]["prompt"][0]["text"], "hello");
    }

    /// 没指定模型时不发无意义的配置切换（少一次往返）。
    #[test]
    fn turn_without_model_sends_only_prompt() {
        let pending = Mutex::new(HashMap::new());
        let frames = request_to_jsonrpc(
            "s1",
            &SessionRequest::Turn {
                prompt: "hi".into(),
                model_id: None,
            },
            &pending,
            WireFormat::ContentLength,
            &configs_with_model("model", "a"),
        );
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["method"], "session/prompt");
    }

    /// 目标模型已经是当前模型 → 不重发配置帧。
    ///
    /// 冗余的 set 并非无害：agent 可能把它当成一次真实变更去重建内部状态。
    #[test]
    fn turn_with_same_model_sends_only_prompt() {
        let pending = Mutex::new(HashMap::new());
        let configs = configs_with_model("model", "claude-sonnet");
        let frames = request_to_jsonrpc(
            "s1",
            &SessionRequest::Turn {
                prompt: "hi".into(),
                model_id: Some("claude-sonnet".into()),
            },
            &pending,
            WireFormat::ContentLength,
            &configs,
        );
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["method"], "session/prompt");
    }

    /// agent 不支持模型选择（没有模型项）→ 静默降级为只发 prompt，不报错。
    #[test]
    fn turn_with_model_but_no_model_option_sends_only_prompt() {
        let pending = Mutex::new(HashMap::new());
        let frames = request_to_jsonrpc(
            "s1",
            &SessionRequest::Turn {
                prompt: "hi".into(),
                model_id: Some("x".into()),
            },
            &pending,
            WireFormat::ContentLength,
            &acp_config::ConfigOptionsState::default(),
        );
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["method"], "session/prompt");
    }

    /// model_config 控件走独立变体，但发出的是同一个协议方法。
    #[test]
    fn set_config_option_sends_single_frame() {
        let pending = Mutex::new(HashMap::new());
        let frames = request_to_jsonrpc(
            "s1",
            &SessionRequest::SetConfigOption {
                config_id: "fast_mode".into(),
                value: acp_config::SessionConfigValue::Flag(true),
            },
            &pending,
            WireFormat::ContentLength,
            &acp_config::ConfigOptionsState::default(),
        );
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["method"], "session/set_config_option");
        assert_eq!(frames[0]["params"]["type"], "boolean");
        assert_eq!(frames[0]["params"]["value"], true);
    }

    #[test]
    fn cancel_is_a_request_ndjson() {
        let pending = Mutex::new(HashMap::new());
        let frames = request_to_jsonrpc(
            "s1",
            &SessionRequest::Cancel,
            &pending,
            WireFormat::Ndjson,
            &acp_config::ConfigOptionsState::default(),
        );
        let msg = frames.into_iter().next().expect("message");
        assert_eq!(
            msg.get("method").and_then(|v| v.as_str()),
            Some("session/close")
        );
        assert!(msg.get("id").is_some());
    }
}
