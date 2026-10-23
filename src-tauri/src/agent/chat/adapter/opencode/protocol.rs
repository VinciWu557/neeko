use crate::agent::chat::adapter::AgentContext;

pub(super) fn model_slug_split(id: &str) -> (String, String) {
    match id.split_once('/') {
        Some((provider, model)) => (provider.to_string(), model.to_string()),
        None => (String::new(), id.to_string()),
    }
}

/// Build the `{ providerID, modelID }` object accepted by opencode serve.
/// Returns `None` when there is no usable model (absent, or a bare id without
/// a provider prefix) — the server then uses its default model.
pub(super) fn model_body(model_id: Option<&str>) -> Option<serde_json::Value> {
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
pub(super) fn prompt_body(prompt: &str, model_id: Option<&str>) -> serde_json::Value {
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
pub(super) fn session_create_body(ctx: &AgentContext) -> serde_json::Value {
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
pub(super) fn session_create_url(base_url: &str, ctx: &AgentContext) -> String {
    format!(
        "{}/session?directory={}",
        base_url,
        urlencoding::encode(&ctx.project_id)
    )
}
