use crate::common::error::AppError;

/// Build the `GET /event` URL scoped to a project directory.
///
/// opencode 1.18.x filters the broadcast by the request's `directory` query
/// parameter: a bare `/event` stream only carries server-level events
pub(super) fn event_stream_url(base_url: &str, directory: &str) -> String {
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
pub(super) fn question_reply_url(base_url: &str, directory: &str, request_id: &str) -> String {
    format!(
        "{base_url}/question/{request_id}/reply?directory={}",
        urlencoding::encode(directory)
    )
}

/// Open the SSE `/event` stream. Reconnects are handled by the pump loop.
pub(super) async fn open_sse(
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
