use std::sync::Arc;

use tokio::sync::mpsc;

use crate::agent::chat::adapter::{AgentContext, AgentSession};
use crate::agent::chat::capabilities::ChatCapabilities;
use crate::agent::chat::events::{
    Capabilities, ContextManifest, DoneReason, SessionRequest, StreamEvent,
};
use crate::common::error::AppError;

use super::connection::ServeConnection;
use super::eventurl::question_reply_url;
use super::protocol::prompt_body;
use super::pump::run_event_pump;
use super::session::ServeSession;

/// POST 一个 serve 回执并**校验响应**（approve / question reply / prompt 共用）。
///
/// 为什么不能只判 `Err`（实测 opencode 1.19.0）：
/// - reqwest 默认对 4xx/5xx 返回 `Ok` → `404 QuestionNotFoundError` 会被当成投递成功；
/// - serve 对**未匹配路由**回落 SPA `index.html`（`200 + text/html`）→ 连状态码都是绿的。
///
/// 两者叠加的故障形态：用户点了「回答」，Neeko 记一条成功日志都没有，agent 永久挂起。
pub(super) async fn post_serve(
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
pub(super) struct ServeScope<'a> {
    base_url: &'a str,
    directory: &'a str,
}

/// Attach the SSE pump + request loop to an existing serve session.
///
/// Shared by [`ServeAdapter::create`] (fresh session) and
/// [`ServeAdapter::resume`] (existing native session) — the streaming
/// infrastructure is identical; only the session-id provenance differs.
/// Sends the initial prompt when `ctx.prompt` is non-empty (per-turn model).
pub(super) async fn attach_streaming(
    conn: &'static Arc<ServeConnection>,
    ctx: &AgentContext,
    serve_sid: String,
    caps: ChatCapabilities,
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
                capabilities: Capabilities::from_chat_capabilities(caps, false, false),
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

/// Page → agent request loop: approve / turn / input / cancel.
pub(super) async fn run_request_loop(
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
