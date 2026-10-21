//! Agent Chat — Tauri commands.
//!
//! Command layer stays maximally thin (AGENTS.md red line 6): deserialize +
//! validate → dispatch to the bridge / session registry. All live logic lives
//! in the bridge / adapter matrix.

use tauri::Emitter;
use tauri::State;

use crate::agent::chat::adapter::{adapter_for, AgentContext, AgentKind, AgentSession};
use crate::agent::chat::bridge::AgentChatBridge;
use crate::agent::chat::events::{
    ContextManifest, SequencedEvent, SessionRequest, AGENT_CHAT_EVENT,
};

use crate::agent::chat::manager::SessionHandle;
use crate::agent::chat::notify;
use crate::agent::chat::session_store::{ResumeCursor, SessionStatus};
use crate::common::agent::types::AgentConfig;
use crate::core::project::ProjectEnvironment;
use crate::AppError;
use crate::AppStateWrapper;

/// Request body for starting a streamed agent session.
///
/// 前端以驼峰命名传参（`agentId` / `projectId`），serde 自动映射到后端 snake_case。
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamRequest {
    /// Agent identifier (e.g. `deepseek-harness`, `opencode`).
    pub agent_id: String,
    /// Project identifier to bind the session to.
    pub project_id: String,
    /// The user's prompt for this turn.
    pub prompt: String,
    /// File paths to attach as context.
    #[serde(default)]
    pub files: Vec<String>,
    /// Skill IDs to enable for this session.
    #[serde(default)]
    pub skills: Vec<String>,
    /// Approval mode override: `auto` | `confirm`. Falls back to project default.
    #[serde(default)]
    pub mode: Option<String>,
    /// If set, continue this existing session instead of creating a new one.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Model ID selected by the user (per-session / per-turn). `None` falls back
    /// to the agent's configured default.
    #[serde(default)]
    pub model_id: Option<String>,
    /// 会话主题（R7.4）：恢复既有会话时由前端传入 agent 原生标题
    /// （conversation 扫描得到的 `userTitle` / `title`）；新会话留空，由首轮 prompt 兜底。
    #[serde(default)]
    pub topic: Option<String>,
}

/// Map a project environment to the protocol's `env` string.
fn env_label(env: &ProjectEnvironment) -> String {
    match env {
        ProjectEnvironment::Local => "local".into(),
        #[cfg(target_os = "windows")]
        ProjectEnvironment::Wsl { .. } => "wsl".into(),
        ProjectEnvironment::Remote { .. } => "ssh".into(),
    }
}

/// Resolve the agent config（数据对象）from the agent manager（clone 快照）。
pub(crate) fn resolve_agent_config(
    state: &AppStateWrapper,
    agent_id: &str,
) -> Result<AgentConfig, AppError> {
    let am = state.agent_manager.lock().map_err(AppError::from)?;
    am.get_agent(agent_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("agent not found: {agent_id}")))
}

/// Resolve project display name + environment + path.
pub(crate) fn resolve_project_ctx(
    state: &AppStateWrapper,
    project_id: &str,
) -> Result<(String, String, String), AppError> {
    let pm = state.project_manager.lock().map_err(AppError::from)?;
    Ok(match pm.get_project(project_id) {
        Some(p) => (
            p.name.clone(),
            env_label(&p.environment),
            p.path.display().to_string(),
        ),
        None => (
            project_id.to_string(),
            "local".into(),
            project_id.to_string(),
        ),
    })
}

/// Generate a session id: `ac_{project_prefix}_{nanos:hex}`.
fn new_session_id(project_id: &str) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("ac_{}_{:x}", &project_id[..8.min(project_id.len())], nanos)
}

/// Build the shared `AgentContext` for a stream request.
fn build_context(req: &StreamRequest, project_path: &str, session_id: &str) -> AgentContext {
    AgentContext {
        agent_id: req.agent_id.clone(),
        session_id: session_id.to_string(),
        project_id: project_path.to_string(),
        project_name: String::new(), // 由调用方覆盖
        env: String::new(),
        skills: req.skills.clone(),
        files: req.files.clone(),
        mode: req.mode.clone().unwrap_or_else(|| "auto".into()),
        prompt: req.prompt.clone(),
        model_id: req.model_id.clone(),
    }
}

/// 解析 agent + 项目上下文，生成会话 id 与 `AgentContext`。
///
/// # 为什么抽出来
///
/// `agent_stream`（新建）、`agent_chat_resume`、`agent_chat_open` 三个入口的前置
/// 序列完全相同：`resolve_agent_config` → `resolve_project_ctx` → `new_session_id`
/// → `build_context` → 补 `project_name` / `env`。已到 DRY 门槛（第 3 次），
/// 而且任何一处新增校验（如「该 agent 能不能静默开会话」）都必须同步三次 ——
/// 那是不必要的耦合。
///
/// `silent` = 清空 `prompt`（不自动发首轮）。它与「哪个入口」无关，是会话的**启动
/// 形态**，所以放在这里而不是让三个调用方各自覆盖。
fn resolve_session_context(
    state: &State<'_, AppStateWrapper>,
    req: &StreamRequest,
    silent: bool,
) -> Result<(AgentConfig, String, AgentContext), AppError> {
    let agent = resolve_agent_config(state, &req.agent_id)?;
    let (project_name, env, project_path) = resolve_project_ctx(state, &req.project_id)?;
    let session_id = new_session_id(&req.project_id);

    let mut context = build_context(req, &project_path, &session_id);
    context.project_name = project_name;
    context.env = env;
    if silent {
        context.prompt = String::new();
    }

    Ok((agent, session_id, context))
}

/// Start a streamed session. Events arrive on the `agent-chat://event` channel.
///
/// If `req.session_id` is set, the prompt is sent as a new turn to that existing
/// session instead of creating a fresh one — this powers multi-turn dialogue.
#[tauri::command]
pub async fn agent_stream(
    req: StreamRequest,
    state: State<'_, AppStateWrapper>,
    app_handle: tauri::AppHandle,
) -> Result<String, AppError> {
    log::info!(
        "[agent_stream] Starting: agent_id={}, project_id={}, session_id={:?}",
        req.agent_id,
        req.project_id,
        req.session_id
    );
    // Continue an existing session: route the new prompt to it directly — but
    // only when the session belongs to the requested agent + project. Otherwise
    // (agent switched, or session already gone) start a fresh session instead,
    // so the new agent/model is actually used (not routed into the old one).
    if let Some(sid) = &req.session_id {
        if state
            .agent_chat_manager
            .owns(sid, &req.agent_id, &req.project_id)
        {
            log::info!("[agent_stream] Continuing existing session: {}", sid);
            state
                .agent_chat_manager
                .send(
                    sid,
                    SessionRequest::Turn {
                        prompt: req.prompt,
                        model_id: req.model_id,
                    },
                )
                .await?;
            return Ok(sid.clone());
        }
        log::warn!(
            "[agent_stream] session {} not reusable for agent {} (missing or agent/project mismatch); starting fresh",
            sid,
            req.agent_id
        );
    }

    // Resolve agent config（数据对象：command + chat_transport 等）。
    let (agent, session_id, context) = resolve_session_context(&state, &req, false)?;
    log::info!(
        "[agent_stream] Agent: command={}, chat={:?}",
        agent.command,
        agent.chat
    );

    // Create adapter + session via the factory (IO shape chosen inside the
    // adapter: Spawn / Connect / SSE / ACP — not bound to stdout/JSON-Lines).
    let adapter = adapter_for(&agent)?;
    let session = adapter.create(&context).await?;
    let cursor = build_resume_cursor(&req, &session_id);
    spawn_session_pipeline(
        &state,
        &app_handle,
        &req,
        session_id.clone(),
        session,
        AGENT_CHAT_EVENT,
        Some(cursor),
    );

    Ok(session_id)
}

/// Resume an existing native agent session (from the agent's own persisted
/// storage, discovered via the conversation scan) as a live Agent Chat.
///
/// The chat starts silent (no auto-prompt); history rendering is done by the
/// frontend from `get_conversation_messages`, and subsequent user turns flow
/// through the regular `agent_stream` continuation path.
#[tauri::command]
pub async fn agent_chat_resume(
    req: StreamRequest,
    native_session_id: String,
    state: State<'_, AppStateWrapper>,
    app_handle: tauri::AppHandle,
) -> Result<String, AppError> {
    if native_session_id.is_empty() {
        return Err(AppError::InvalidInput(
            "native_session_id is required for resume".into(),
        ));
    }
    log::info!(
        "[agent_chat_resume] Resuming native session {} for agent {}, project {}",
        native_session_id,
        req.agent_id,
        req.project_id
    );

    // Resolve agent config（数据对象）与静默上下文（不发首轮 prompt）。
    let (agent, session_id, context) = resolve_session_context(&state, &req, true)?;
    log::info!(
        "[agent_chat_resume] Agent: command={}, chat={:?}",
        agent.command,
        agent.chat
    );

    let adapter = adapter_for(&agent)?;
    if !adapter.supports_chat_resume() {
        return Err(AppError::Agent(format!(
            "agent {} does not support resuming into Agent Chat",
            req.agent_id
        )));
    }
    let session = adapter.resume(&context, &native_session_id).await?;
    let cursor = build_resume_cursor(&req, &session_id);
    spawn_session_pipeline(
        &state,
        &app_handle,
        &req,
        session_id.clone(),
        session,
        AGENT_CHAT_EVENT,
        Some(cursor),
    );

    Ok(session_id)
}

/// 打开一个**静默会话**：建会话、拿 `configOptions`，但不发任何 prompt。
///
/// # 为什么需要它
///
/// 模型 / 推理档位 / 模式都只存在于会话的 `configOptions` 里（ACP 没有独立的
/// 「列档位」方法；Pi 虽然能会话外查，但模式与当前值仍要会话）。若等到用户
/// 发第一条消息才建会话，这几项选择器会在「选 agent → 发消息」之间缺席，
/// 用户看到的是一个残缺的工具条，然后发完消息它们才冒出来 —— 体验割裂。
///
/// 本命令让「选中 agent」这一步就把会话建好，于是选择器立刻可用，且后续
/// `agent_stream` 会走续聊分支复用同一个会话（`manager.owns` 命中）。
///
/// # 与 `agent_chat_resume` 的区别
///
/// 后者接一个**已存在**的 native 会话（读它的历史）；这里开一个**全新**会话。
/// 两者都静默（`context.prompt` 为空），共用同一条 pipeline。
#[tauri::command]
pub async fn agent_chat_open(
    req: StreamRequest,
    state: State<'_, AppStateWrapper>,
    app_handle: tauri::AppHandle,
) -> Result<String, AppError> {
    log::info!(
        "[agent_chat_open] Opening silent session for agent {} project {}",
        req.agent_id,
        req.project_id
    );

    let (agent, session_id, context) = resolve_session_context(&state, &req, true)?;

    let adapter = adapter_for(&agent)?;
    let session = adapter.create(&context).await?;
    let cursor = build_resume_cursor(&req, &session_id);
    spawn_session_pipeline(
        &state,
        &app_handle,
        &req,
        session_id.clone(),
        session,
        AGENT_CHAT_EVENT,
        Some(cursor),
    );

    Ok(session_id)
}

/// Shared tail of `agent_stream` / `agent_chat_resume` / `translation_stream`:
/// persist the resume cursor (if any), register the live session, and start
/// the bridge pump. `event_name` selects the frontend event channel
/// (`AGENT_CHAT_EVENT` for chat, `TRANSLATION_EVENT` for ephemeral translation).
pub(crate) fn spawn_session_pipeline(
    state: &State<'_, AppStateWrapper>,
    app_handle: &tauri::AppHandle,
    req: &StreamRequest,
    session_id: String,
    session: Box<dyn AgentSession>,
    event_name: &'static str,
    cursor: Option<ResumeCursor>,
) {
    if let Some(request_tx) = session.request_channel() {
        state.agent_chat_manager.register(
            session_id.clone(),
            SessionHandle {
                agent_id: req.agent_id.clone(),
                project_id: req.project_id.clone(),
                request_tx,
            },
            cursor,
        );
    }

    // Start bridge pump (emits to frontend via app_handle); unregister on exit.
    // 方案 B1（合帧）：bridge 按 16ms 窗口聚合成批 emit —— 一次 emit = 一次
    // evaluateJavaScript（macOS 上 Tauri 事件送达），batch 内事件一次送达，
    // eval 频率从「每增量一次」降到「每帧一次」。
    //
    // 通知旁路 sink（design T2，源 A）：仅 chat 通道订阅 —— 翻译事件不产生系统通知。
    // 投影是 agent 域知识（notify.rs），裁决/投递属应用级核心域（crate::notification）；
    // 锁内同步纯函数（微秒级）+ 异步投递，不反压主链路。
    let notify_ctx = (event_name == AGENT_CHAT_EVENT).then(|| {
        notify::SessionNotifyContext::new(
            session_id.clone(),
            req.agent_id.clone(),
            resolve_project_ctx(state, &req.project_id)
                .map(|(name, _, _)| name)
                .unwrap_or_else(|_| req.project_id.clone()),
            req.topic.clone(),
            &req.prompt,
        )
    });
    let center = state.notification.clone();
    let handle = app_handle.clone();
    let manager = state.agent_chat_manager.clone();
    let sid = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let notify_handle = handle.clone();
        let visible_manager = manager.clone();
        let emit = move |seq_evs: Vec<SequencedEvent>| {
            let _ = handle.emit(event_name, &seq_evs);
            let Some(ctx) = &notify_ctx else { return };
            let visible = visible_manager.visible_session();
            for seq in &seq_evs {
                if let Some(signal) = notify::project(&seq.event, ctx) {
                    let instance_visible =
                        visible.as_deref() == Some(signal.source.instance_id.as_str());
                    center.observe(&notify_handle, signal, instance_visible);
                }
                if notify::is_session_terminal(&seq.event) {
                    center.release_instance("agent", &ctx.session_id);
                }
            }
        };
        let _ = AgentChatBridge::run(sid.clone(), session, emit).await;
        manager.unregister(&sid);
    });
}

/// Report the chat session currently visible to the user (R2.1 focus-suppression
/// fact source; `None` = user is not looking at a chat session).
#[tauri::command]
pub fn agent_chat_set_visible(
    session_id: Option<String>,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    state.agent_chat_manager.set_visible_session(session_id);
    Ok(())
}

/// Build the resume cursor for chat session persistence (P2).
fn build_resume_cursor(req: &StreamRequest, session_id: &str) -> ResumeCursor {
    ResumeCursor {
        session_id: session_id.to_string(),
        agent_kind: AgentKind::from_agent_id(&req.agent_id),
        agent_id: req.agent_id.clone(),
        cwd: req.project_id.clone(),
        model: String::new(),
        runtime_mode: req.mode.clone().unwrap_or_else(|| "auto".into()),
        turn_count: 0,
        status: SessionStatus::Running,
        last_activity: chrono::Utc::now().to_rfc3339(),
    }
}

/// Approve / deny a pending tool call (Gate return, A2).
#[tauri::command]
pub async fn agent_approve(
    session_id: String,
    call_id: String,
    allow: bool,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    state
        .agent_chat_manager
        .send(&session_id, SessionRequest::Approve { call_id, allow })
        .await
}

/// Send clarification input to the agent mid-turn (A2).
#[tauri::command]
pub async fn agent_input(
    session_id: String,
    turn_id: String,
    prompt: String,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    state
        .agent_chat_manager
        .send(&session_id, SessionRequest::Input { turn_id, prompt })
        .await
}

/// Set one session config option (`session/set_config_option`).
///
/// 供模型 popover 里的 `model_config` / `thought_level` 控件使用。响应里的
/// 全量配置通过 `config_option_update` 事件回到前端 —— 本命令不返回状态，
/// 因为「改完之后是什么」由 agent 决定，不由客户端猜。
#[tauri::command]
pub async fn agent_set_config_option(
    session_id: String,
    config_id: String,
    value: serde_json::Value,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let value =
        serde_json::from_value::<crate::agent::chat::adapter::acp_config::SessionConfigValue>(
            value,
        )
        .map_err(|e| AppError::InvalidInput(format!("invalid config option value: {e}")))?;

    state
        .agent_chat_manager
        .send(
            &session_id,
            SessionRequest::SetConfigOption { config_id, value },
        )
        .await
}

/// Rebind context on project switch (A4).
#[tauri::command]
pub async fn agent_context_set(
    session_id: String,
    manifest: ContextManifest,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    state
        .agent_chat_manager
        .send(&session_id, SessionRequest::ContextSet { manifest })
        .await
}

/// Cancel an in-flight stream.
#[tauri::command]
pub async fn agent_stream_cancel(
    session_id: String,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    state
        .agent_chat_manager
        .send(&session_id, SessionRequest::Cancel)
        .await?;
    state.agent_chat_manager.unregister(&session_id);
    Ok(())
}

/// Return a context snapshot for a project (A4).
#[tauri::command]
pub async fn agent_chat_context(
    project_id: String,
    state: State<'_, AppStateWrapper>,
) -> Result<ContextManifest, AppError> {
    let pm = state.project_manager.lock().map_err(AppError::from)?;
    let (project_name, env) = match pm.get_project(&project_id) {
        Some(p) => (p.name.clone(), env_label(&p.environment)),
        None => (project_id.clone(), "local".into()),
    };
    Ok(ContextManifest {
        project_id,
        project_name,
        env,
        skills: Vec::new(),
        files: Vec::new(),
        mode: "auto".into(),
    })
}

/// Whether the agent's adapter supports resuming native sessions as a live
/// Agent Chat. Drives the Histor panel entry visibility per conversation row.
// Tauri command（IPC 边界），返回值经 serde 序列化而非直接消费 —— 不适用 must_use。
#[allow(clippy::must_use_candidate)]
#[tauri::command]
pub fn agent_chat_supports_resume(agent_id: String, state: State<'_, AppStateWrapper>) -> bool {
    resolve_agent_config(&state, &agent_id)
        .ok()
        .and_then(|c| adapter_for(&c).ok())
        .map(|a| a.supports_chat_resume())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// M1: `StreamRequest` deserializes a camelCase `modelId` string into
    /// `Option<String>` (the model-picking chain start).
    #[test]
    fn stream_request_deserializes_model_field() {
        let json = r#"{
            "agentId": "opencode",
            "projectId": "proj-1",
            "prompt": "hello",
            "modelId": "anthropic/claude-sonnet-4-5"
        }"#;
        let req: StreamRequest = serde_json::from_str(json).expect("deserialize");
        assert_eq!(req.model_id.as_deref(), Some("anthropic/claude-sonnet-4-5"));
    }

    /// `model` is optional — requests without it default to `None`.
    #[test]
    fn stream_request_model_absent_defaults_none() {
        let json = r#"{"agentId":"opencode","projectId":"p","prompt":"hi"}"#;
        let req: StreamRequest = serde_json::from_str(json).expect("deserialize");
        assert!(req.model_id.is_none());
    }
}
