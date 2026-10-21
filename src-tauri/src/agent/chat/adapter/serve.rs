//! Serve adapter — opencode serve + HTTP + SSE.
//!
//! opencode's native `serve` command exposes a REST API (session create /
//! `prompt_async`) plus an SSE `/event` stream. Unlike ACP, both session
//! creation and every prompt accept an explicit model — enabling per-session
//! model switching (upstream ACP does not). This adapter:
//!
//! 1. lazily starts one process-level `opencode serve` (shared by all sessions),
//! 2. creates a session via `POST /session`,
//! 3. sends the first prompt via `POST /session/{id}/prompt_async`,
//! 4. pumps the SSE `/event` stream, translating it into the unified
//!    [`StreamEvent`] protocol,
//! 5. replies to approval requests via `POST /session/{id}/permissions/{pid}`.
//!
//! `AcpAdapter` is intentionally kept untouched: `mockAgent` and any agent
//! still declaring `chat_transport: "acp"` use it unchanged.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::{mpsc, OnceCell};
use tokio::time::timeout;

use crate::agent::chat::adapter::{AgentAdapter, AgentContext, AgentKind, AgentSession};
use crate::agent::chat::events::{
    Capabilities, ContextManifest, DoneReason, ErrorKind, SessionRequest, StreamEvent, TodoItem,
    TurnEndReason,
};
use crate::common::agent::types::{AgentConfig, ModelInfo};
use crate::common::error::AppError;
use crate::common::executor::factory::ExecTarget;
use crate::common::executor::BoxAsyncRead;
use crate::core::exec;

/// How long to wait for `opencode serve` to print its listening URL.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
/// Maximum SSE reconnect attempts before the session is considered done.
const MAX_SSE_RETRIES: u32 = 5;
/// Delay between SSE reconnect attempts.
const SSE_RETRY_DELAY: Duration = Duration::from_millis(500);

// ── Model helpers (pure, testable) ──────────────────────────────────────────

/// Split a model slug `provider/model` into `(provider_id, model_id)`.
///
/// opencode serve expects `{ providerID, modelID }`; a slug without `/`
/// yields an empty provider (callers then omit the `model` field so the
/// server falls back to its configured default).
#[must_use]
pub fn model_slug_split(id: &str) -> (String, String) {
    match id.split_once('/') {
        Some((provider, model)) => (provider.to_string(), model.to_string()),
        None => (String::new(), id.to_string()),
    }
}

/// Build the `{ providerID, modelID }` object accepted by opencode serve.
/// Returns `None` when there is no usable model (absent, or a bare id without
/// a provider prefix) — the server then uses its default model.
fn model_body(model_id: Option<&str>) -> Option<serde_json::Value> {
    let id = model_id?;
    let (provider_id, model_id) = model_slug_split(id);
    if provider_id.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "providerID": provider_id,
        "modelID": model_id,
    }))
}

/// Build the `prompt_async` request body. `model_id` is optional — when absent
/// the server falls back to its configured default.
fn prompt_body(prompt: &str, model_id: Option<&str>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "parts": [{ "type": "text", "text": prompt }]
    });
    if let Some(m) = model_body(model_id) {
        body["model"] = m;
    }
    body
}

/// Build the `POST /session` body. Model is intentionally omitted (serve
/// rejects it on create; model selection happens per prompt). Confirm mode
/// presets an ask-everything permission rule so the approval Gate fires.
fn session_create_body(ctx: &AgentContext) -> serde_json::Value {
    let mut body = serde_json::json!({
        "title": format!("Neeko {}", ctx.project_name),
    });
    if ctx.mode == "confirm" {
        body["permission"] = serde_json::json!([
            { "permission": "*", "pattern": "*", "action": "ask" }
        ]);
    }
    body
}

/// Build the `POST /session` URL with the per-session working directory.
///
/// opencode serve 是多目录感知服务：会话工作目录由 `directory` query 参数显式
/// 指定；缺省时继承 serve 进程 cwd —— 而 serve 是全局单例（cwd 固定在 neeko
/// 进程启动目录，tauri dev 下为 src-tauri），不传会导致模型工作目录与项目
/// 注册路径不一致。
fn session_create_url(base_url: &str, ctx: &AgentContext) -> String {
    format!(
        "{}/session?directory={}",
        base_url,
        urlencoding::encode(&ctx.project_id)
    )
}

// ── SSE event translation (pure, testable) ──────────────────────────────────

/// One SSE `data:` payload from `GET /event`.
#[derive(Debug, serde::Deserialize)]
struct ServeEvent {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(default)]
    properties: serde_json::Value,
}

/// The kind of a streamed part, learned from `message.part.updated`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PartKind {
    Text,
    Reasoning,
    Tool,
}

/// Translate one opencode serve SSE event into a [`StreamEvent`].
///
/// Pure (no IO): the caller owns the pump loop and the `part_kinds` /
/// `tool_started` state maps. `part_kinds` learns the type of a streamed
/// part; `tool_started` records callIDs that already emitted `ToolStart`
/// (opencode serve may emit `pending` *and* `running` for the same callID —
/// see `translate_tool`). Part type is learned from `message.part.updated`;
/// `message.part.delta` then uses it to distinguish text vs reasoning deltas
/// (both carry `field: "text"`). Unknown event types / foreign fields → `None`.
fn translate_event(
    session_id: &str,
    event: &ServeEvent,
    part_kinds: &mut HashMap<String, PartKind>,
    tool_started: &mut HashSet<String>,
) -> Vec<StreamEvent> {
    let properties = &event.properties;
    match event.event_type.as_str() {
        "message.part.delta" => translate_part_delta(session_id, properties, part_kinds),
        "message.part.updated" => {
            translate_part_updated(session_id, properties, part_kinds, tool_started)
        }
        "permission.asked" => translate_permission_asked(session_id, properties),
        // opencode 的「等待用户行动」是**两个独立事件族**：permission（权限门）与
        // question（ask 类工具阻塞，`que_` id）。serve 侧同样会发 question.asked ——
        // 实测：serve 会话里模型调 question 工具后 `/question` 挂起待答。
        // 缺这一条 = 自有会话的提问既不显示内联面板、也不会产生任何通知。
        "question.asked" => translate_question_asked(session_id, properties),
        "todo.updated" => translate_todo_updated(session_id, properties),
        "session.idle" => vec![StreamEvent::TurnEnd {
            session_id: session_id.into(),
            turn_id: String::new(),
            reason: TurnEndReason::Completed,
        }],
        "session.error" => {
            let message = properties
                .get("error")
                .and_then(|e| e.get("data"))
                .and_then(|d| d.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("opencode serve error");
            vec![StreamEvent::Error {
                session_id: session_id.into(),
                kind: ErrorKind::Agent,
                code: "E_AGENT".into(),
                message: message.into(),
            }]
        }
        // `session.updated` carries metadata only; session lifecycle events
        // (SessionStart/ContextInit) are emitted by the adapter itself.
        _ => Vec::new(),
    }
}

/// `message.part.delta` — the incremental streaming carrier. `field: "text"`
/// covers both text and reasoning parts; the part kind resolves which.
fn translate_part_delta(
    session_id: &str,
    properties: &serde_json::Value,
    part_kinds: &HashMap<String, PartKind>,
) -> Vec<StreamEvent> {
    if properties.get("field").and_then(|v| v.as_str()) != Some("text") {
        return Vec::new();
    }
    let part_id = match properties.get("partID").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return Vec::new(),
    };
    let delta = match properties.get("delta").and_then(|v| v.as_str()) {
        Some(d) => d,
        None => return Vec::new(),
    };
    match part_kinds.get(part_id) {
        Some(PartKind::Reasoning) => vec![StreamEvent::ReasoningDelta {
            session_id: session_id.into(),
            delta: delta.into(),
        }],
        // Unknown parts default to text (safe for the rare delta-before-update race).
        _ => vec![StreamEvent::TextDelta {
            session_id: session_id.into(),
            delta: delta.into(),
        }],
    }
}

/// `message.part.updated` — part lifecycle / snapshots. Text and reasoning
/// parts only register their kind (deltas arrive separately); tool parts map
/// to `ToolStart` / `ToolEnd` from their state machine. `tool_started` is
/// threaded into `translate_tool` so it can suppress duplicate `ToolStart`
/// events for the same callID.
fn translate_part_updated(
    session_id: &str,
    properties: &serde_json::Value,
    part_kinds: &mut HashMap<String, PartKind>,
    tool_started: &mut HashSet<String>,
) -> Vec<StreamEvent> {
    let part = match properties.get("part") {
        Some(p) => p,
        None => return Vec::new(),
    };
    let kind = match part.get("type").and_then(|v| v.as_str()) {
        Some("text") => PartKind::Text,
        Some("reasoning") => PartKind::Reasoning,
        Some("tool") => PartKind::Tool,
        _ => return Vec::new(),
    };
    if let Some(part_id) = part.get("id").and_then(|v| v.as_str()) {
        part_kinds.insert(part_id.to_string(), kind);
    }
    match kind {
        PartKind::Tool => translate_tool(session_id, part, tool_started),
        _ => Vec::new(),
    }
}

/// Tool part lifecycle: `pending`/`running` → `ToolStart`, `completed` →
/// `ToolOutput(output)` + `ToolEnd(done)`, `error` → `ToolOutput(error)` +
/// `ToolEnd(failed)`. `tool_started` records callIDs that already emitted a
/// `ToolStart`; opencode serve may emit both `pending` and `running` for the
/// same callID, so the second one must be suppressed to avoid duplicate rows.
fn translate_tool(
    session_id: &str,
    part: &serde_json::Value,
    tool_started: &mut HashSet<String>,
) -> Vec<StreamEvent> {
    let call_id = match part.get("callID").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return Vec::new(),
    };
    let name = part
        .get("tool")
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let title = tool_title(part);
    match part
        .get("state")
        .and_then(|s| s.get("status"))
        .and_then(|v| v.as_str())
    {
        Some("pending") | Some("running") => {
            // 同一 callID 在 opencode serve 下可能同时收到 pending 与 running
            // 两次 `message.part.updated`；仅在首次发出 ToolStart，避免前端重复渲染。
            if tool_started.contains(&call_id) {
                return Vec::new();
            }
            tool_started.insert(call_id.clone());
            vec![StreamEvent::ToolStart {
                session_id: session_id.into(),
                call_id,
                name,
                title,
            }]
        }
        Some("completed") => {
            // 完成态快照携带完整 output → 先发输出（前端累积到 ToolCard.output），
            // 再发结束（前端将状态置为 done）。
            let output = part
                .get("state")
                .and_then(|s| s.get("output"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let mut events = Vec::with_capacity(2);
            if !output.is_empty() {
                events.push(StreamEvent::ToolOutput {
                    session_id: session_id.into(),
                    call_id: call_id.clone(),
                    output,
                });
            }
            events.push(StreamEvent::ToolEnd {
                session_id: session_id.into(),
                call_id,
                status: "done".into(),
            });
            events
        }
        Some("error") => {
            let error = part
                .get("state")
                .and_then(|s| s.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let mut events = Vec::with_capacity(2);
            if !error.is_empty() {
                events.push(StreamEvent::ToolOutput {
                    session_id: session_id.into(),
                    call_id: call_id.clone(),
                    output: error,
                });
            }
            events.push(StreamEvent::ToolEnd {
                session_id: session_id.into(),
                call_id,
                status: "failed".into(),
            });
            events
        }
        _ => Vec::new(),
    }
}

/// Human-readable tool title derived from the tool input (bash command / file
/// path / pattern / task description / todo count). Falls back to the tool name.
fn tool_title(part: &serde_json::Value) -> String {
    let tool = part
        .get("tool")
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let input = part.get("state").and_then(|s| s.get("input"));
    // task (subagent spawn) → "Type Task" + description（对齐 opencode TUI 的 `{type} Task`）。
    if tool == "task" {
        let sub_type = input
            .and_then(|i| i.get("subagent_type"))
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .unwrap_or("general");
        let desc = input
            .and_then(|i| i.get("description"))
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty());
        return match desc {
            Some(d) => format!("{sub_type} Task: {d}"),
            None => format!("{sub_type} Task"),
        };
    }
    // todowrite → "N todos"（对齐 opencode 完成态 title）。
    if tool == "todowrite" {
        if let Some(count) = input
            .and_then(|i| i.get("todos"))
            .and_then(|v| v.as_array())
            .map(|arr| arr.len())
        {
            return format!("{count} todos");
        }
        return "todo".to_string();
    }
    // bash / run_command → 完整命令（`command` 支持 string 或数组；另兼容
    // `script` / `cmd` 字段），确保命令卡片能展示「执行了什么」而非工具名。
    if tool == "bash" || tool == "run_command" {
        if let Some(cmd) = command_from_input(input) {
            return cmd;
        }
    }
    // read_file / read → filePath / path / file（read 操作折叠标题 `read <路径>`）。
    for key in ["command", "filePath", "path", "file", "pattern"] {
        if let Some(v) = input
            .and_then(|i| i.get(key))
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
        {
            return v.to_string();
        }
    }
    tool
}

/// 从 bash 工具的 input 提取命令字符串：`command`（string 或数组）、
/// `script`、`cmd`。均缺省时返回 `None`（调用方回退到工具名）。
fn command_from_input(input: Option<&serde_json::Value>) -> Option<String> {
    let i = input?;
    if let Some(v) = i.get("command") {
        match v {
            serde_json::Value::String(s) if !s.is_empty() => return Some(s.clone()),
            serde_json::Value::Array(arr) => {
                let parts: Vec<&str> = arr.iter().filter_map(|x| x.as_str()).collect();
                if !parts.is_empty() {
                    return Some(parts.join(" "));
                }
            }
            _ => {}
        }
    }
    for key in ["script", "cmd"] {
        if let Some(s) = i
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            return Some(s.to_string());
        }
    }
    None
}

/// `todo.updated` — agent's live plan. Global event filtered by `sessionID`
/// in the pump; the `todos` array drives a Codex-style task list on the page.
fn translate_todo_updated(session_id: &str, properties: &serde_json::Value) -> Vec<StreamEvent> {
    let todos = match properties.get("todos").and_then(|v| v.as_array()) {
        Some(arr) => arr
            .iter()
            .filter_map(|t| serde_json::from_value::<TodoItem>(t.clone()).ok())
            .collect(),
        None => return Vec::new(),
    };
    vec![StreamEvent::TodoUpdated {
        session_id: session_id.into(),
        todos,
    }]
}

/// `permission.asked` — the approval Gate. `properties.id` is the permission
/// request id used to reply via `/permissions/{id}`.
fn translate_permission_asked(
    session_id: &str,
    properties: &serde_json::Value,
) -> Vec<StreamEvent> {
    let call_id = match properties.get("id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return Vec::new(),
    };
    let tool = properties
        .get("permission")
        .and_then(|v| v.as_str())
        .unwrap_or("tool");
    let patterns: Vec<String> = properties
        .get("patterns")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| p.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let prompt = if patterns.is_empty() {
        "Allow this action?".to_string()
    } else {
        patterns.join(" ")
    };
    let command = properties
        .get("metadata")
        .and_then(|m| m.get("command"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let title = command.clone().unwrap_or_else(|| prompt.clone());
    vec![StreamEvent::RequestApproval {
        session_id: session_id.into(),
        call_id,
        tool: tool.into(),
        title,
        prompt,
        diff: None,
        cmd: command,
    }]
}

/// `question.asked` — ask 类工具的阻塞等待。与 `permission.asked` 是**两个独立事件族**：
/// 权限门回答 allow/deny，提问要的是**答案文本**，故投影为 [`StreamEvent::UserInput`]
/// （前端内联面板 → `agent_input` → 本适配器的 [`SessionRequest::Input`] →
/// [`question_reply_url`]），而不是审批 Gate。
///
/// 实测（2026-10-13 发现缺口；2026-10-14 修正路由 —— 曾误写 `/api/session/...`，
/// 该形态实测 404）：serve 会话里模型调 question 工具后 `/question` 挂起待答；
/// 缺这一条 = 自有会话的提问既不显示面板、也不产生「等待用户行动」通知。
fn translate_question_asked(session_id: &str, properties: &serde_json::Value) -> Vec<StreamEvent> {
    // 提问 id（`que_…`）即回执路由键 —— 复用 `turn_id` 槽位承载（Input 只带 prompt/turn_id）。
    let call_id = match properties.get("id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return Vec::new(),
    };
    // 首问：header（短标签）优先，回落 question 正文 —— 与 hook 模板同一取值口径。
    let first = properties
        .get("questions")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first());
    let pick = |key: &str| {
        first
            .and_then(|q| q.get(key))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
    };
    let prompt = match pick("header").or_else(|| pick("question")) {
        Some(text) => text.to_string(),
        None => "Agent 需要你的输入".to_string(),
    };
    // 候选项：`questions[0].options[].label` —— 前端面板据此渲染可点选项（无则自由文本）。
    let options: Vec<String> = first
        .and_then(|q| q.get("options"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|o| o.get("label").and_then(|v| v.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    vec![StreamEvent::UserInput {
        session_id: session_id.into(),
        turn_id: call_id,
        prompt,
        options,
    }]
}

// ── Process-level serve connection (lazy, shared) ───────────────────────────

/// A shared, process-level connection to `opencode serve`.
struct ServeConnection {
    base_url: String,
    client: reqwest::Client,
}

static SERVE_CONNECTION: OnceCell<Arc<ServeConnection>> = OnceCell::const_new();

/// Lazily start `opencode serve` once per process and return the shared
/// connection. Subsequent sessions reuse the same server (no kill on zero
/// sessions — the server lives as long as the app).
async fn serve_connection() -> Result<&'static Arc<ServeConnection>, AppError> {
    SERVE_CONNECTION.get_or_try_init(start_serve).await
}

/// Spawn `opencode serve` via the unified exec facade (AGENTS.md red line 1),
/// wait for its listening URL, and keep the child alive + drained.
async fn start_serve() -> Result<Arc<ServeConnection>, AppError> {
    log::info!("[ServeAdapter] starting `opencode serve`");
    let mut child = exec::spawn(
        &ExecTarget::Local,
        "opencode",
        &["serve", "--hostname", "127.0.0.1", "--port", "0"],
    )
    .await
    .map_err(|e| AppError::Io(format!("failed to spawn `opencode serve`: {e}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Io("`opencode serve` has no stdout".into()))?;
    let (base_url, stdout) = timeout(STARTUP_TIMEOUT, read_listening_url(stdout))
        .await
        .map_err(|_| AppError::Io("timed out waiting for `opencode serve` to start".into()))?
        .map_err(|e| AppError::Io(format!("failed to read serve startup: {e}")))?;
    log::info!("[ServeAdapter] `opencode serve` listening at {base_url}");

    // Keep the child alive and drain its stdio so the pipes never fill and
    // the process is reaped on app exit.
    let stderr = child.stderr.take();
    tokio::spawn(async move {
        let _ = drain_forever(stdout).await;
        if let Some(err) = stderr {
            let _ = drain_forever(err).await;
        }
        let _ = child.wait.await;
    });

    Ok(Arc::new(ServeConnection {
        base_url,
        client: reqwest::Client::new(),
    }))
}

/// Read `opencode serve` stdout lines until the listening URL appears.
/// Returns the URL plus the (still open) stream for the caller to drain.
async fn read_listening_url(
    stdout: BoxAsyncRead,
) -> Result<(String, BoxAsyncRead), std::io::Error> {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "`opencode serve` exited before printing its URL",
            ));
        }
        let trimmed = line.trim();
        log::debug!("[ServeAdapter] serve stdout: {trimmed}");
        if let Some(url) = extract_listening_url(trimmed) {
            return Ok((url, reader.into_inner()));
        }
    }
}

/// Extract the listening URL from a serve startup line.
fn extract_listening_url(line: &str) -> Option<String> {
    const MARKER: &str = "opencode server listening on ";
    let url = line.get(line.find(MARKER)? + MARKER.len()..)?.trim();
    if url.is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

/// Read a stream to EOF, discarding bytes (keeps the pipe open).
async fn drain_forever(mut stream: BoxAsyncRead) {
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

// ── Adapter + session ───────────────────────────────────────────────────────

/// Serve-backed adapter for opencode (REST + SSE transport).
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

    /// serve 支持按轮次指定模型（每次 prompt 都带 model 字段）。
    fn supports_model_selection(&self) -> bool {
        true
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

        attach_streaming(conn, ctx, serve_sid).await
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
        attach_streaming(conn, ctx, native_session_id.to_string()).await
    }

    fn supports_chat_resume(&self) -> bool {
        true
    }
}

/// Attach the SSE pump + request loop to an existing serve session.
///
/// Shared by [`ServeAdapter::create`] (fresh session) and
/// [`ServeAdapter::resume`] (existing native session) — the streaming
/// infrastructure is identical; only the session-id provenance differs.
/// Sends the initial prompt when `ctx.prompt` is non-empty (per-turn model).
async fn attach_streaming(
    conn: &'static Arc<ServeConnection>,
    ctx: &AgentContext,
    serve_sid: String,
) -> Result<Box<dyn AgentSession>, AppError> {
    // ── First prompt (model selection is per-prompt; resume starts silent) ──
    let model_id = ctx.model_id.clone();
    if !ctx.prompt.is_empty() {
        let url = format!("{}/session/{serve_sid}/prompt_async", conn.base_url);
        let resp = conn
            .client
            .post(&url)
            .json(&prompt_body(&ctx.prompt, model_id.as_deref()))
            .send()
            .await
            .map_err(|e| AppError::Io(format!("serve prompt_async failed: {e}")))?;
        if !resp.status().is_success() {
            log::warn!("[ServeAdapter] prompt_async HTTP {}", resp.status());
        }
    }

    // ── Channels + pump / request tasks ────────────────────────────────
    let (event_tx, event_rx) = mpsc::channel(64);
    let (req_tx, req_rx) = mpsc::channel(64);

    // Event pump: SessionStart + ContextInit, then translate SSE events.
    let pump_client = conn.client.clone();
    let pump_base = conn.base_url.clone();
    let pump_serve_sid = serve_sid.clone();
    let inner_sid = ctx.session_id.clone();
    let ctx_agent_id = ctx.agent_id.clone();
    let ctx_project_id = ctx.project_id.clone();
    let ctx_project_name = ctx.project_name.clone();
    let ctx_env = ctx.env.clone();
    let ctx_skills = ctx.skills.clone();
    let ctx_files = ctx.files.clone();
    let ctx_mode = ctx.mode.clone();
    let model_id = ctx.model_id.clone();
    let pump_event_tx = event_tx.clone();
    let pump_model_id = model_id.clone();
    tokio::spawn(async move {
        let _ = pump_event_tx
            .send(StreamEvent::SessionStart {
                session_id: inner_sid.clone(),
                agent: ctx_agent_id,
                model: pump_model_id,
                config_options: Vec::new(),
                capabilities: Capabilities {
                    approvals: true,
                    command_echo: false,
                    diff: false,
                    resume: true,
                },
            })
            .await;
        let _ = pump_event_tx
            .send(StreamEvent::ContextInit {
                session_id: inner_sid.clone(),
                manifest: ContextManifest {
                    project_id: ctx_project_id.clone(),
                    project_name: ctx_project_name,
                    env: ctx_env,
                    skills: ctx_skills,
                    files: ctx_files,
                    mode: ctx_mode,
                },
            })
            .await;
        run_event_pump(
            &pump_client,
            &pump_base,
            &pump_serve_sid,
            &inner_sid,
            &ctx_project_id,
            &pump_event_tx,
        )
        .await;
    });

    // Request channel: page → agent (approve / turn / input / cancel).
    let req_client = conn.client.clone();
    let req_base = conn.base_url.clone();
    let req_serve_sid = serve_sid.clone();
    let req_inner_sid = ctx.session_id.clone();
    let req_event_tx = event_tx.clone();
    // question 回执按目录分片路由（`directory` 是必填 query 参数，实测缺失即 404）。
    let req_directory = ctx.project_id.clone();
    tokio::spawn(async move {
        // scope 在任务内构造：owned 的 base_url / directory 随闭包移入 'static 未来，
        // 借用才合法（与 run_event_pump 的调用点同形）。
        let scope = ServeScope {
            base_url: &req_base,
            directory: &req_directory,
        };
        run_request_loop(
            &req_client,
            scope,
            &req_serve_sid,
            &req_inner_sid,
            &req_event_tx,
            model_id.clone(),
            req_rx,
        )
        .await;
    });

    Ok(Box::new(ServeSession {
        event_rx,
        request_tx: req_tx,
        resume: Some(serve_sid),
    }))
}

/// Build the `GET /event` URL scoped to a project directory.
///
/// opencode 1.18.x filters the broadcast by the request's `directory` query
/// parameter: a bare `/event` stream only carries server-level events
/// (`server.connected` / `server.heartbeat`) and never delivers any
/// session/message events, which starves the pump while the model reply is
/// actually being persisted.
#[must_use]
pub fn event_stream_url(base_url: &str, directory: &str) -> String {
    format!(
        "{base_url}/event?directory={}",
        urlencoding::encode(directory)
    )
}

/// 提问回执 URL。
///
/// **实测（opencode 1.19.0，真 `opencode serve` + 真挂起的 question）**：
/// - `POST /question/{requestID}/reply?directory=…` → `200 true`，问题被消费；
/// - `POST /api/session/{sid}/question/{rid}/reply`（带或不带 directory）→ `404
///   QuestionNotFoundError` —— 路由表里那一族是**内部 SDK 面**，serve 的公开面不带 `/api`
///   前缀且不带 session 段。
///
/// `directory` 是**必填** query 参数（serve 按目录分片路由，缺失即查不到该 question）。
/// 调用方另须检查状态码：serve 对未知路由回落 SPA `index.html`（200 + HTML），而 reqwest
/// 默认对 4xx/5xx 返回 `Ok` —— 只看 `Err` 会把失败当成功，表现为「用户已回答但 agent
/// 永久挂起」且零日志。
#[must_use]
pub fn question_reply_url(base_url: &str, directory: &str, request_id: &str) -> String {
    format!(
        "{base_url}/question/{request_id}/reply?directory={}",
        urlencoding::encode(directory)
    )
}

/// Open the SSE `/event` stream. Reconnects are handled by the pump loop.
async fn open_sse(
    client: &reqwest::Client,
    base_url: &str,
    directory: &str,
) -> Result<reqwest::Response, AppError> {
    let resp = client
        .get(event_stream_url(base_url, directory))
        .send()
        .await
        .map_err(|e| AppError::Io(format!("serve GET /event failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Io(format!(
            "serve GET /event: HTTP {}",
            resp.status()
        )));
    }
    Ok(resp)
}

/// Pump the SSE stream: translate matching events into the event channel.
/// Ends with `SessionDone` when the stream permanently closes.
async fn run_event_pump(
    client: &reqwest::Client,
    base_url: &str,
    serve_sid: &str,
    session_id: &str,
    directory: &str,
    event_tx: &mpsc::Sender<StreamEvent>,
) {
    let mut part_kinds: HashMap<String, PartKind> = HashMap::new();
    let mut tool_started: HashSet<String> = HashSet::new();
    let mut retries = 0u32;
    loop {
        let mut stream = match open_sse(client, base_url, directory).await {
            Ok(resp) => {
                retries = 0;
                resp.bytes_stream()
            }
            Err(e) => {
                log::warn!("[ServeAdapter] SSE connect failed: {e}");
                retries += 1;
                if retries >= MAX_SSE_RETRIES {
                    break;
                }
                tokio::time::sleep(SSE_RETRY_DELAY).await;
                continue;
            }
        };
        let mut buf: Vec<u8> = Vec::new();
        let mut stream_failed = false;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buf.extend_from_slice(&bytes);
                    if !process_buffered_lines(
                        &mut buf,
                        &mut part_kinds,
                        &mut tool_started,
                        session_id,
                        serve_sid,
                        event_tx,
                    )
                    .await
                    {
                        // Event channel closed (session cancelled) → stop.
                        return;
                    }
                }
                Err(e) => {
                    log::warn!("[ServeAdapter] SSE stream error: {e}");
                    stream_failed = true;
                    break;
                }
            }
        }
        if stream_failed {
            retries += 1;
            if retries >= MAX_SSE_RETRIES {
                break;
            }
            tokio::time::sleep(SSE_RETRY_DELAY).await;
            continue;
        }
        // Clean EOF from the server → session is over.
        break;
    }
    let _ = event_tx
        .send(StreamEvent::SessionDone {
            session_id: session_id.into(),
            reason: DoneReason::Completed,
        })
        .await;
}

/// Process complete `\n`-delimited SSE lines, forwarding events that belong
/// to `serve_sid`. Returns `false` when the event channel is closed.
async fn process_buffered_lines(
    buf: &mut Vec<u8>,
    part_kinds: &mut HashMap<String, PartKind>,
    tool_started: &mut HashSet<String>,
    session_id: &str,
    serve_sid: &str,
    event_tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    loop {
        let Some(pos) = buf.iter().position(|&b| b == b'\n') else {
            return true;
        };
        let line: Vec<u8> = buf.drain(..=pos).collect();
        let line = String::from_utf8_lossy(&line);
        let line = line.trim_end_matches(['\r', '\n']);
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<ServeEvent>(data) else {
            continue;
        };
        // `GET /event` is global — only forward events for this session.
        let Some(ev_session) = event.properties.get("sessionID").and_then(|v| v.as_str()) else {
            continue;
        };
        if ev_session != serve_sid {
            continue;
        }
        for sev in translate_event(session_id, &event, part_kinds, tool_started) {
            if event_tx.send(sev).await.is_err() {
                return false;
            }
        }
    }
}

/// POST 一个 serve 回执并**校验响应**（approve / question reply / prompt 共用）。
///
/// 为什么不能只判 `Err`（实测 opencode 1.19.0）：
/// - reqwest 默认对 4xx/5xx 返回 `Ok` → `404 QuestionNotFoundError` 会被当成投递成功；
/// - serve 对**未匹配路由**回落 SPA `index.html`（`200 + text/html`）→ 连状态码都是绿的。
///
/// 两者叠加的故障形态：用户点了「回答」，Neeko 记一条成功日志都没有，agent 永久挂起。
/// 故这里额外把 html 回落判为失败（正确回执是 `200 application/json` 或 `204`）。
async fn post_serve(
    client: &reqwest::Client,
    url: &str,
    body: Option<&serde_json::Value>,
    what: &str,
) {
    let request = match body {
        Some(body) => client.post(url).json(body),
        None => client.post(url),
    };
    match request.send().await {
        Ok(resp) => {
            let status = resp.status();
            let html_fallback = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.contains("text/html"));
            if !status.is_success() || html_fallback {
                log::warn!(
                    "[ServeAdapter] {what} 未生效: HTTP {status} html_fallback={html_fallback} {url}"
                );
            }
        }
        Err(e) => log::warn!("[ServeAdapter] {what} 请求失败: {e} {url}"),
    }
}

/// serve 请求作用域：实例地址 + 项目目录。
///
/// 二者共同决定一条会话的路由（serve 按 `directory` 分片，实测缺 directory 的 question
/// 回执返回 404），故合成一个参数：既表达「这是一个概念」，也让 `run_request_loop`
/// 待在 clippy `too_many_arguments`（≤7）内。
#[derive(Clone, Copy)]
struct ServeScope<'a> {
    base_url: &'a str,
    directory: &'a str,
}

/// Page → agent request loop: approve / turn / input / cancel.
async fn run_request_loop(
    client: &reqwest::Client,
    scope: ServeScope<'_>,
    serve_sid: &str,
    session_id: &str,
    event_tx: &mpsc::Sender<StreamEvent>,
    model_id: Option<String>,
    mut req_rx: mpsc::Receiver<SessionRequest>,
) {
    let ServeScope {
        base_url,
        directory,
    } = scope;
    while let Some(req) = req_rx.recv().await {
        match req {
            // serve 的模型走 per-turn（每次 prompt 带 model），不消费 config option。
            SessionRequest::SetConfigOption { .. } => {}
            SessionRequest::Approve { call_id, allow } => {
                let url = format!("{base_url}/session/{serve_sid}/permissions/{call_id}");
                let body = serde_json::json!({
                    "response": if allow { "once" } else { "reject" }
                });
                post_serve(
                    client,
                    &url,
                    Some(&body),
                    &format!("permission reply {call_id}"),
                )
                .await;
            }
            SessionRequest::Turn {
                prompt,
                model_id: turn_model_id,
            } => {
                // Per-turn model switching: the model picked for this turn wins;
                // otherwise keep the session's initial model (or serve default).
                let url = format!("{base_url}/session/{serve_sid}/prompt_async");
                let body = prompt_body(&prompt, turn_model_id.as_deref().or(model_id.as_deref()));
                post_serve(client, &url, Some(&body), "prompt_async").await;
            }
            SessionRequest::Input { turn_id, prompt } => {
                // 提问回执（`que_…` id，见 translate_question_asked）走 question 专用端点。
                // 权限门（allow/deny）与提问（答案文本）是两套协议、两个路由，不可混用。
                if turn_id.starts_with("que_") {
                    let url = question_reply_url(base_url, directory, &turn_id);
                    let body = serde_json::json!({ "answers": [[prompt]] });
                    post_serve(
                        client,
                        &url,
                        Some(&body),
                        &format!("question reply {turn_id}"),
                    )
                    .await;
                } else {
                    let url = format!("{base_url}/session/{serve_sid}/prompt_async");
                    let body = prompt_body(&prompt, model_id.as_deref());
                    post_serve(client, &url, Some(&body), "prompt_async (input)").await;
                }
            }
            SessionRequest::Cancel => {
                // abort 无请求体；同样必须校验响应 —— 静默失败时前端已显示「已停止」
                // 但 serve 侧模型仍在跑并继续计费。
                let url = format!("{base_url}/session/{serve_sid}/abort");
                post_serve(client, &url, None, "abort").await;
                let _ = event_tx
                    .send(StreamEvent::SessionDone {
                        session_id: session_id.into(),
                        reason: DoneReason::Cancelled,
                    })
                    .await;
                break;
            }
            SessionRequest::ContextSet { .. } | SessionRequest::Pause | SessionRequest::Resume => {
                // serve has no mid-session context rebind / pause; ignored (page keeps state).
            }
        }
    }
}

/// A live opencode serve session.
struct ServeSession {
    event_rx: mpsc::Receiver<StreamEvent>,
    request_tx: mpsc::Sender<SessionRequest>,
    resume: Option<String>,
}

#[async_trait]
impl AgentSession for ServeSession {
    async fn next(&mut self) -> Option<Result<StreamEvent, AppError>> {
        self.event_rx.recv().await.map(Ok)
    }

    async fn send(&mut self, req: SessionRequest) -> Result<(), AppError> {
        self.request_tx
            .send(req)
            .await
            .map_err(|e| AppError::Io(format!("serve request channel closed: {e}")))
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

// ── TDD: event translation + model helpers ──────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sse_event(json: &str) -> ServeEvent {
        serde_json::from_str(json).expect("valid sse event")
    }

    /// 从事件列表中取唯一事件（测试断言用）；为空或多余一个则 panic。
    fn single(events: Vec<StreamEvent>) -> StreamEvent {
        let mut it = events.into_iter();
        let first = it.next().expect("expected exactly one event, got none");
        assert!(it.next().is_none(), "expected exactly one event, got more");
        first
    }

    fn serve_ctx(project_id: &str) -> AgentContext {
        AgentContext {
            agent_id: "opencode".into(),
            session_id: "ac_test".into(),
            project_id: project_id.into(),
            project_name: "demo".into(),
            env: "local".into(),
            skills: vec![],
            files: vec![],
            mode: "auto".into(),
            prompt: String::new(),
            model_id: None,
        }
    }

    #[test]
    fn session_create_url_carries_project_directory() {
        let url = session_create_url("http://127.0.0.1:4096", &serve_ctx("/tmp/demo proj"));
        assert_eq!(
            url, "http://127.0.0.1:4096/session?directory=%2Ftmp%2Fdemo%20proj",
            "POST /session 必须显式传 directory（会话工作目录），否则继承 serve 进程 cwd"
        );
    }

    #[test]
    fn session_create_url_encodes_absolute_path() {
        let url = session_create_url(
            "http://127.0.0.1:4096",
            &serve_ctx("/Users/demo/RustroverProjects/neeko"),
        );
        assert!(url.ends_with("?directory=%2FUsers%2Fdemo%2FRustroverProjects%2Fneeko"));
    }

    /// opencode 1.18.x 起按目录过滤事件广播：裸 `/event` 只推 server 级事件
    ///（connected/heartbeat），会话与消息事件必须带 `directory` 查询参数才会
    /// 下发。回归实证（2026-08-22）：不带参数时模型回复已落盘但 SSE 零推送，
    /// 前端表现为发送后一直 thinking 无任何响应数据。
    #[test]
    fn event_stream_url_encodes_directory_filter() {
        assert_eq!(
            event_stream_url("http://127.0.0.1:55652", "/Users/demo/my proj"),
            "http://127.0.0.1:55652/event?directory=%2FUsers%2Fdemo%2Fmy%20proj"
        );
    }

    /// 提问回执路由（实测钉死，2026-10-14）：serve 的公开面是
    /// `POST /question/{requestID}/reply?directory=…`（`200 application/json` + `true`）。
    ///
    /// 曾经写错的形态 `POST /api/session/{sid}/question/{rid}/reply` 实测返回
    /// `404 QuestionNotFoundError` —— 那一族是内部 SDK 面。写错时用户点「回答」后
    /// agent 永久挂起，故连 URL 形状一起钉住。
    #[test]
    fn question_reply_url_uses_public_route_with_directory() {
        assert_eq!(
            question_reply_url("http://127.0.0.1:55652", "/Users/demo/my proj", "que_abc"),
            "http://127.0.0.1:55652/question/que_abc/reply?directory=%2FUsers%2Fdemo%2Fmy%20proj"
        );
    }

    /// 回执路由**不得**带 `/api` 前缀，也**不得**漏 `directory`（两者实测都是 404）。
    #[test]
    fn question_reply_url_shape_guards() {
        let url = question_reply_url("http://h:1", "/tmp/p", "que_1");
        assert!(!url.contains("/api/"), "serve 公开面无 /api 前缀：{url}");
        assert!(url.contains("directory="), "directory 必填：{url}");
        assert!(url.starts_with("http://h:1/question/que_1/reply?"), "{url}");
    }

    #[test]
    fn text_delta_translates_from_part_delta() {
        let event = sse_event(
            r#"{"type":"message.part.delta","properties":{"sessionID":"ses_1","messageID":"msg_1","partID":"prt_text","field":"text","delta":"hello"}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        kinds.insert("prt_text".to_string(), PartKind::Text);
        let ev = single(translate_event("ac_1", &event, &mut kinds, &mut started));
        assert_eq!(
            ev,
            StreamEvent::TextDelta {
                session_id: "ac_1".into(),
                delta: "hello".into()
            }
        );
    }

    #[test]
    fn reasoning_delta_translates_when_part_is_reasoning() {
        let event = sse_event(
            r#"{"type":"message.part.delta","properties":{"sessionID":"ses_1","messageID":"msg_1","partID":"prt_reason","field":"text","delta":"想想"}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        kinds.insert("prt_reason".to_string(), PartKind::Reasoning);
        let ev = single(translate_event("ac_1", &event, &mut kinds, &mut started));
        assert_eq!(
            ev,
            StreamEvent::ReasoningDelta {
                session_id: "ac_1".into(),
                delta: "想想".into()
            }
        );
    }

    #[test]
    fn part_updated_registers_kind_for_later_deltas() {
        let updated = sse_event(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_reason","type":"reasoning","text":""}}}"#,
        );
        let delta = sse_event(
            r#"{"type":"message.part.delta","properties":{"sessionID":"ses_1","partID":"prt_reason","field":"text","delta":"ok"}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        assert!(translate_event("ac_1", &updated, &mut kinds, &mut started).is_empty());
        let ev = single(translate_event("ac_1", &delta, &mut kinds, &mut started));
        assert_eq!(
            ev,
            StreamEvent::ReasoningDelta {
                session_id: "ac_1".into(),
                delta: "ok".into()
            }
        );
    }

    #[test]
    fn tool_running_translates_to_tool_start() {
        let event = sse_event(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_0","state":{"status":"running","input":{"command":"echo hi"},"metadata":{"output":""}}}}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        let ev = single(translate_event("ac_1", &event, &mut kinds, &mut started));
        assert_eq!(
            ev,
            StreamEvent::ToolStart {
                session_id: "ac_1".into(),
                call_id: "bash_0".into(),
                name: "bash".into(),
                title: "echo hi".into(),
            }
        );
    }

    #[test]
    fn tool_completed_translates_to_tool_output_then_end() {
        let event = sse_event(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_1","state":{"status":"completed","input":{"command":"echo hi"},"output":"hi\n","title":"echo hi","metadata":{}}}}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        let evs = translate_event("ac_1", &event, &mut kinds, &mut started);
        assert_eq!(
            evs,
            vec![
                StreamEvent::ToolOutput {
                    session_id: "ac_1".into(),
                    call_id: "bash_1".into(),
                    output: "hi\n".into(),
                },
                StreamEvent::ToolEnd {
                    session_id: "ac_1".into(),
                    call_id: "bash_1".into(),
                    status: "done".into(),
                },
            ]
        );
    }

    #[test]
    fn tool_completed_without_output_only_ends() {
        let event = sse_event(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_3","state":{"status":"completed","input":{},"output":"","title":"echo","metadata":{}}}}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        let evs = translate_event("ac_1", &event, &mut kinds, &mut started);
        assert_eq!(
            evs,
            vec![StreamEvent::ToolEnd {
                session_id: "ac_1".into(),
                call_id: "bash_3".into(),
                status: "done".into(),
            }]
        );
    }

    #[test]
    fn tool_error_translates_to_tool_end_failed() {
        let event = sse_event(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_2","state":{"status":"error","input":{},"error":"boom"}}}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        let evs = translate_event("ac_1", &event, &mut kinds, &mut started);
        assert_eq!(
            evs,
            vec![
                StreamEvent::ToolOutput {
                    session_id: "ac_1".into(),
                    call_id: "bash_2".into(),
                    output: "boom".into(),
                },
                StreamEvent::ToolEnd {
                    session_id: "ac_1".into(),
                    call_id: "bash_2".into(),
                    status: "failed".into(),
                },
            ]
        );
    }

    /// `question.asked`（ask 类工具阻塞）→ `UserInput`。
    ///
    /// 载荷是 **2026-10-14 从真 `opencode serve` 的 `GET /event` SSE 流抓下来的逐字样本**
    /// （`question.asked` 1 条，见 `/tmp/sse3.txt`），不是照二进制猜的形状 —— 实测差异：
    /// `options[]` 元素带 `description`，且**没有** `multiple` 字段。
    /// 缺这条路由时自有会话的提问既不显示内联面板、也不产生「等待用户行动」通知。
    #[test]
    fn question_asked_translates_to_user_input() {
        let event = sse_event(
            r#"{"id":"evt_138828573001lOkACjg0X0LELX","type":"question.asked","properties":{"id":"que_138828572001SACyo0ucRUWNvM","sessionID":"ses_ec77e6947ffegOTypRWn4THThq","questions":[{"question":"Which file should I edit?","header":"File to edit","options":[{"label":"Option A","description":"First file option"},{"label":"Option B","description":"Second file option"},{"label":"Option C","description":"Third file option"}]}],"tool":{"messageID":"msg_138827c2e001ytw2Xf8cJY8lNo","callID":"call_01a1388282d77360a7315548c045d7e5"}}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        let ev = single(translate_event("ac_1", &event, &mut kinds, &mut started));
        match ev {
            StreamEvent::UserInput {
                session_id,
                turn_id,
                prompt,
                options,
            } => {
                assert_eq!(session_id, "ac_1");
                // 提问 id 承载在 turn_id：回执路由键（`que_` 前缀判定 question 端点）。
                assert_eq!(turn_id, "que_138828572001SACyo0ucRUWNvM");
                // header 优先（短标签），与 hook 模板同一口径。
                assert_eq!(prompt, "File to edit");
                // 候选项必须透传且**只取 label**：前端 UserInputPanel 据此渲染可点选项，
                // 丢了就只能让用户手打 agent 已经给了的答案；description 是面板不消费的噪声。
                assert_eq!(
                    options,
                    vec![
                        "Option A".to_string(),
                        "Option B".to_string(),
                        "Option C".to_string()
                    ]
                );
            }
            other => panic!("expected UserInput, got {other:?}"),
        }
        // 无 options（纯开放问题）→ 空 vec，前端落自由文本输入而非空选项列表。
        let plain = sse_event(
            r#"{"type":"question.asked","properties":{"id":"que_9","sessionID":"ses_1","questions":[{"header":"分支名","question":"用哪个分支？"}]}}"#,
        );
        match single(translate_event("ac_1", &plain, &mut kinds, &mut started)) {
            StreamEvent::UserInput { options, .. } => assert!(options.is_empty()),
            other => panic!("expected UserInput, got {other:?}"),
        }
    }

    /// header 缺失时回落 question 正文；两者都缺 → 类别兜底（不产出空 prompt）。
    #[test]
    fn question_asked_falls_back_to_question_text_then_default() {
        let with_text = sse_event(
            r#"{"type":"question.asked","properties":{"id":"que_2","sessionID":"ses_1","questions":[{"question":"分支名是什么？"}]}}"#,
        );
        let defaulted = sse_event(
            r#"{"type":"question.asked","properties":{"id":"que_3","sessionID":"ses_1","questions":[{"header":"  "}]}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        let prompts: Vec<String> = [with_text, defaulted]
            .iter()
            .map(
                |e| match single(translate_event("ac_1", e, &mut kinds, &mut started)) {
                    StreamEvent::UserInput { prompt, .. } => prompt,
                    other => panic!("expected UserInput, got {other:?}"),
                },
            )
            .collect();
        assert_eq!(prompts[0], "分支名是什么？");
        assert_eq!(prompts[1], "Agent 需要你的输入");
    }

    /// 缺 id → 无可回执的路由键，静默丢弃（不产生无法回答的面板）。
    #[test]
    fn question_asked_without_id_is_ignored() {
        let event = sse_event(
            r#"{"type":"question.asked","properties":{"sessionID":"ses_1","questions":[{"header":"x"}]}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        assert!(translate_event("ac_1", &event, &mut kinds, &mut started).is_empty());
    }

    #[test]
    fn session_idle_translates_to_turn_end() {
        let event = sse_event(r#"{"type":"session.idle","properties":{"sessionID":"ses_1"}}"#);
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        let ev = single(translate_event("ac_1", &event, &mut kinds, &mut started));
        assert_eq!(
            ev,
            StreamEvent::TurnEnd {
                session_id: "ac_1".into(),
                turn_id: String::new(),
                reason: TurnEndReason::Completed,
            }
        );
    }

    #[test]
    fn session_error_translates_to_error() {
        let event = sse_event(
            r#"{"type":"session.error","properties":{"sessionID":"ses_1","error":{"name":"UnknownError","data":{"message":"Model not found"}}}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        let ev = single(translate_event("ac_1", &event, &mut kinds, &mut started));
        match ev {
            StreamEvent::Error { kind, message, .. } => {
                assert_eq!(kind, ErrorKind::Agent);
                assert_eq!(message, "Model not found");
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn todo_updated_translates_to_todo_list() {
        let event = sse_event(
            r#"{"type":"todo.updated","properties":{"sessionID":"ses_1","todos":[{"content":"读第一章","status":"pending","priority":"high"},{"content":"写笔记","status":"in_progress","priority":"medium"}]}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        let evs = translate_event("ac_1", &event, &mut kinds, &mut started);
        assert_eq!(
            evs,
            vec![StreamEvent::TodoUpdated {
                session_id: "ac_1".into(),
                todos: vec![
                    TodoItem {
                        content: "读第一章".into(),
                        status: "pending".into(),
                        priority: "high".into(),
                    },
                    TodoItem {
                        content: "写笔记".into(),
                        status: "in_progress".into(),
                        priority: "medium".into(),
                    },
                ],
            }]
        );
    }

    #[test]
    fn todo_updated_without_todos_ignored() {
        let event = sse_event(r#"{"type":"todo.updated","properties":{"sessionID":"ses_1"}}"#);
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        assert!(translate_event("ac_1", &event, &mut kinds, &mut started).is_empty());
    }

    #[test]
    fn task_tool_title_includes_subagent_and_description() {
        let part = serde_json::json!({
            "type": "tool",
            "tool": "task",
            "callID": "task_0",
            "state": {
                "status": "running",
                "input": { "subagent_type": "general", "description": "扫描代码库并总结模块边界" }
            }
        });
        assert_eq!(tool_title(&part), "general Task: 扫描代码库并总结模块边界");
    }

    #[test]
    fn todowrite_tool_title_counts_todos() {
        let part = serde_json::json!({
            "type": "tool",
            "tool": "todowrite",
            "callID": "todo_0",
            "state": {
                "status": "running",
                "input": {
                    "todos": [
                        { "content": "a", "status": "pending", "priority": "high" },
                        { "content": "b", "status": "pending", "priority": "low" },
                        { "content": "c", "status": "completed", "priority": "medium" }
                    ]
                }
            }
        });
        assert_eq!(tool_title(&part), "3 todos");
    }

    #[test]
    fn unknown_event_ignored() {
        let event = sse_event(r#"{"type":"server.heartbeat","properties":{}}"#);
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        assert!(translate_event("ac_1", &event, &mut kinds, &mut started).is_empty());
    }

    #[test]
    fn non_text_part_delta_ignored() {
        let event = sse_event(
            r#"{"type":"message.part.delta","properties":{"sessionID":"ses_1","partID":"prt_t","field":"tool_input","delta":"x"}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        assert!(translate_event("ac_1", &event, &mut kinds, &mut started).is_empty());
    }

    #[test]
    fn model_slug_split_handles_slash_and_bare() {
        assert_eq!(
            model_slug_split("anthropic/claude-sonnet-4-5"),
            ("anthropic".to_string(), "claude-sonnet-4-5".to_string())
        );
        assert_eq!(
            model_slug_split("kimi-k2.7-code"),
            (String::new(), "kimi-k2.7-code".to_string())
        );
    }

    #[test]
    fn model_body_omitted_when_absent_or_bare_id() {
        assert!(model_body(None).is_none());
        assert!(model_body(Some("kimi-k2.7-code")).is_none());
    }

    #[test]
    fn model_body_builds_provider_model_object() {
        let body = model_body(Some("anthropic/claude-sonnet-4-5")).expect("body");
        assert_eq!(body["providerID"], "anthropic");
        assert_eq!(body["modelID"], "claude-sonnet-4-5");
    }

    #[test]
    fn extract_listening_url_parses_startup_line() {
        assert_eq!(
            extract_listening_url("opencode server listening on http://127.0.0.1:57775"),
            Some("http://127.0.0.1:57775".to_string())
        );
        assert!(extract_listening_url("loading config...").is_none());
    }

    /// 同一 callID 的 `pending` → `running` 只应发出一次 `ToolStart`。
    /// opencode serve 会就同一工具多次推送 `message.part.updated`，若不加
    /// 去重，前端会把同一任务渲染成两行（用户反馈的 bug）。
    #[test]
    fn bash_title_supports_command_array_and_script_fields() {
        // command 为数组 → join 成完整命令
        let arr = sse_event(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_0","state":{"status":"running","input":{"command":["wc","-l","src/a.rs"]},"metadata":{}}}}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        let evs = translate_event("ac_1", &arr, &mut kinds, &mut started);
        assert!(matches!(
            &evs[0],
            StreamEvent::ToolStart { title, .. } if title == "wc -l src/a.rs"
        ));

        // script 字段兜底
        let script = sse_event(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_1","state":{"status":"running","input":{"script":"cargo check"},"metadata":{}}}}}"#,
        );
        let evs = translate_event("ac_1", &script, &mut kinds, &mut started);
        assert!(matches!(
            &evs[0],
            StreamEvent::ToolStart { title, .. } if title == "cargo check"
        ));
    }

    #[test]
    fn bash_title_falls_back_to_tool_name_when_no_command() {
        let ev = sse_event(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_0","state":{"status":"running","input":{},"metadata":{}}}}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        let evs = translate_event("ac_1", &ev, &mut kinds, &mut started);
        assert!(matches!(
            &evs[0],
            StreamEvent::ToolStart { title, .. } if title == "bash"
        ));
    }

    #[test]
    fn read_title_extracts_path_from_filepath_or_file() {
        let file_path = sse_event(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"read","callID":"read_0","state":{"status":"running","input":{"filePath":"src/a.rs"},"metadata":{}}}}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        let evs = translate_event("ac_1", &file_path, &mut kinds, &mut started);
        assert!(matches!(
            &evs[0],
            StreamEvent::ToolStart { title, .. } if title == "src/a.rs"
        ));

        let file = sse_event(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"read","callID":"read_1","state":{"status":"running","input":{"file":"src/b.rs"},"metadata":{}}}}}"#,
        );
        let evs = translate_event("ac_1", &file, &mut kinds, &mut started);
        assert!(matches!(
            &evs[0],
            StreamEvent::ToolStart { title, .. } if title == "src/b.rs"
        ));
    }

    #[test]
    fn same_tool_callid_pending_then_running_only_starts_once() {
        let pending = sse_event(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_0","state":{"status":"pending","input":{"command":"echo hi"},"metadata":{}}}}}"#,
        );
        let running = sse_event(
            r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_0","state":{"status":"running","input":{"command":"echo hi"},"metadata":{}}}}}"#,
        );
        let mut kinds = HashMap::new();
        let mut started = HashSet::new();
        let evs1 = translate_event("ac_1", &pending, &mut kinds, &mut started);
        assert_eq!(
            evs1,
            vec![StreamEvent::ToolStart {
                session_id: "ac_1".into(),
                call_id: "bash_0".into(),
                name: "bash".into(),
                title: "echo hi".into()
            }]
        );
        let evs2 = translate_event("ac_1", &running, &mut kinds, &mut started);
        assert!(
            evs2.is_empty(),
            "running 阶段不应重复发 ToolStart: {evs2:?}"
        );
    }
}

// ── Integration tests (real `opencode serve`, skipped by default) ───────────

#[cfg(test)]
mod integration_tests {
    use super::*;

    /// Real opencode serve round-trip: create session → prompt → text deltas.
    /// Marked `#[ignore]` (slow; requires `opencode` installed + a working
    /// default model). Run with `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn serve_round_trip_streams_text_delta() {
        if !crate::core::exec::command_exists(&ExecTarget::Local, "opencode").await {
            eprintln!("Skipping: opencode not found");
            return;
        }
        let ctx = AgentContext {
            agent_id: "opencode".into(),
            session_id: "serve-integration".into(),
            project_id: std::env::temp_dir().display().to_string(),
            project_name: "serve-integration".into(),
            env: "local".into(),
            skills: vec![],
            files: vec![],
            mode: "auto".into(),
            prompt: "Reply with exactly: hello".into(),
            model_id: None,
        };
        let adapter = ServeAdapter::new();
        let mut session = adapter.create(&ctx).await.expect("create session");
        let mut saw_text = false;
        for _ in 0..300 {
            match session.next().await {
                Some(Ok(StreamEvent::TextDelta { delta, .. })) if !delta.is_empty() => {
                    saw_text = true;
                    break;
                }
                Some(Ok(StreamEvent::SessionDone { .. })) | None => break,
                Some(Ok(_)) => {}
                Some(Err(e)) => panic!("stream error: {e}"),
            }
        }
        assert!(saw_text, "expected at least one text delta");
        let _ = session.cancel().await;
    }
}
