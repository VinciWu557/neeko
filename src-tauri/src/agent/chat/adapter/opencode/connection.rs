use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::OnceCell;
use tokio::time::timeout;

use crate::common::error::AppError;
use crate::common::executor::factory::ExecTarget;
use crate::common::executor::BoxAsyncRead;
use crate::core::exec;

use super::protocol::{detect_protocol, ServeProtocol};

/// How long to wait for `opencode serve` to print its listening URL.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) struct ServeConnection {
    pub(super) base_url: String,
    /// 这个 serve 进程讲的协议版本（探测得出，见 [`detect_protocol`]）。
    pub(super) protocol: ServeProtocol,
    pub(super) client: reqwest::Client,
    /// V2 的待答表单：`form_id → fields[0].key`。
    ///
    /// # 为什么必须跨 task 共享
    ///
    /// V2 的提问回执要按 `fields[].key` 映射答案，而 key 只在 `form.created`
    /// 事件里出现。那个事件由 **pump task** 读，回执由 **request loop** 写 ——
    /// 两个独立 tokio task，唯一共同的可达点是这里。
    ///
    /// 用 `std::sync::Mutex`（不是 tokio）是刻意的：表操作是纯内存、微秒级，
    /// 持锁范围内**没有** `await`，不会阻塞 executor。用 tokio Mutex 反而要求
    /// `await`，把一次同步操作变成异步的。
    ///
    /// form id 全局唯一（`frm_…`），多会话共享一张表不会串。
    pub(super) pending_forms: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

pub(super) static SERVE_CONNECTION: OnceCell<Arc<ServeConnection>> = OnceCell::const_new();

/// Lazily start `opencode serve` once per process and return the shared
/// connection. Subsequent sessions reuse the same server (no kill on zero
/// sessions — the server lives as long as the app).
pub(super) async fn serve_connection() -> Result<&'static Arc<ServeConnection>, AppError> {
    SERVE_CONNECTION.get_or_try_init(start_serve).await
}

/// Spawn `opencode serve` via the unified exec facade (AGENTS.md red line 1),
/// wait for its listening URL, and keep the child alive + drained.
pub(super) async fn start_serve() -> Result<Arc<ServeConnection>, AppError> {
    log::info!("[ServeAdapter] starting `opencode serve`");
    // 密码由我们生成并注入：2.0 需要它才能通过 Basic 认证，1.x 注入后只是不报警告。
    // 不依赖 2.0 的随机 `server password` 行 —— 那是未注入时才有的行为。
    let password = uuid::Uuid::new_v4().simple().to_string();
    let mut child = exec::spawn_with_env(
        &ExecTarget::Local,
        "opencode",
        &["serve", "--hostname", "127.0.0.1", "--port", "0"],
        &[("OPENCODE_SERVER_PASSWORD", password.as_str())],
    )
    .await
    .map_err(|e| AppError::Io(format!("failed to spawn `opencode serve`: {e}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Io("`opencode serve` has no stdout".into()))?;
    let (base_url, printed_password, stdout) = timeout(STARTUP_TIMEOUT, read_listening_url(stdout))
        .await
        .map_err(|_| AppError::Io("timed out waiting for `opencode serve` to start".into()))?
        .map_err(|e| AppError::Io(format!("failed to read serve startup: {e}")))?;
    // 注入生效时用我们自己的密码；未生效（老版本不认该 env）才退回打印出来的那个。
    let password = printed_password.unwrap_or(password);
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

    // 恒带 Basic 头：认 env 的版本据此通过认证，不认的版本忽略该头（无副作用）。
    let mut headers = reqwest::header::HeaderMap::new();
    let mut basic = reqwest::header::HeaderValue::from_str(&format!(
        "Basic {}",
        base64_encode(&format!("opencode:{password}"))
    ))
    .map_err(|e| AppError::Io(format!("failed to build basic auth header: {e}")))?;
    basic.set_sensitive(true);
    headers.insert(reqwest::header::AUTHORIZATION, basic);
    // **必须显式禁用代理**：serve 永远跑在 `127.0.0.1`，而 reqwest 默认会读
    // 系统代理设置（macOS 网络设置 / 环境变量），把回环地址也送去代理。
    //
    // 实测故障（2026-10-22 用户报告「输入没有响应」）：日志里是
    //
    //   proxy(http://127.0.0.1:7890/) intercepts 'http://127.0.0.1:50912/'
    //   connecting to 127.0.0.1:7890          ← 连到代理，不是 serve
    //
    // 于是 create/probe/SSE 全部失败，前端看到的是「发了消息，什么都没有」，
    // 而日志里没有任何 serve 侧错误（请求根本没到 serve）。
    //
    // 这不是「配置问题」：本地回环走代理在语义上永远是错的。
    let client = reqwest::Client::builder()
        .default_headers(headers)
        .no_proxy()
        .build()
        .map_err(|e| AppError::Io(format!("failed to build serve http client: {e}")))?;

    let protocol = probe_protocol(&client, &base_url).await;

    Ok(Arc::new(ServeConnection {
        base_url,
        protocol,
        client,
        pending_forms: std::sync::Mutex::new(std::collections::HashMap::new()),
    }))
}

/// 探测协议版本：`GET /api/info` 的 Content-Type 是唯一可靠信号。
///
/// 2.0 返回 JSON；1.19 对同一路径回落 SPA（`200 text/html`）。两版的 1.x
/// **也**认部分 `/api/*` 路由，所以「`/api` 能通」不构成 2.x 判据。
///
/// 请求本身失败 → `V1` + `warn`（不降级到 V2：1.x 是既有用户盘面）。
async fn probe_protocol(client: &reqwest::Client, base_url: &str) -> ServeProtocol {
    let url = format!("{base_url}/api/info");
    match client.get(&url).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let ct = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            let protocol = detect_protocol(status, &ct);
            log::info!(
                "[ServeAdapter] protocol probe: /api/info -> {status} {ct:?} => {protocol:?}"
            );
            protocol
        }
        Err(e) => {
            log::warn!("[ServeAdapter] protocol probe failed ({e}); assuming V1");
            ServeProtocol::V1
        }
    }
}

/// Read `opencode serve` stdout lines until the listening URL appears.
/// Returns the URL plus the (still open) stream for the caller to drain.
pub(super) async fn read_listening_url(
    stdout: BoxAsyncRead,
) -> Result<(String, Option<String>, BoxAsyncRead), std::io::Error> {
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
            // 兜底：未注入 env 时 2.0 会在下一行打印随机密码。最多再看 2 行 ——
            // 不无限读，否则「没有密码行」的版本会在这里阻塞到超时。
            let fallback_pw = read_password_line(&mut reader).await;
            if fallback_pw.is_some() {
                log::warn!(
                    "[ServeAdapter] serve printed a password line;                      OPENCODE_SERVER_PASSWORD injection appears ineffective"
                );
            }
            return Ok((url, fallback_pw, reader.into_inner()));
        }
    }
}

/// 读最多 2 行找 `server password <pwd>`；找不到返回 `None`（不阻塞）。
async fn read_password_line(reader: &mut BufReader<BoxAsyncRead>) -> Option<String> {
    for _ in 0..2 {
        let mut next = String::new();
        // 用 read_line 但可能永久阻塞：启动阶段 stdout 通常会立刻有输出，
        // 这里用短超时兜住「2.0 注入成功、单行就结束」的情形。
        let n = timeout(Duration::from_millis(300), reader.read_line(&mut next))
            .await
            .ok()?
            .ok()?;
        if n == 0 {
            return None;
        }
        let trimmed = next.trim();
        log::debug!("[ServeAdapter] serve stdout (pw probe): {trimmed}");
        if let Some(pw) = extract_server_password(trimmed) {
            return Some(pw);
        }
        // 一旦读到别的非空行就停止探测（不是密码行）
        if !trimmed.is_empty() {
            return None;
        }
    }
    None
}

/// Extract the listening URL from a serve startup line.
///
/// 1.x 打印 `opencode server listening on <url>`，2.0 去掉了 `opencode ` 前缀
/// （实测 2.0.32）。**前缀不参与匹配** —— 未来任何前缀变化都不该再打断就绪检测，
/// 而「以 http 开头的 URL」才是这条输出的语义本体。
pub(super) fn extract_listening_url(line: &str) -> Option<String> {
    const MARKER: &str = "listening on ";
    let rest = line.get(line.find(MARKER)? + MARKER.len()..)?.trim();
    rest.starts_with("http").then(|| rest.to_string())
}

/// 2.0 未注入 `OPENCODE_SERVER_PASSWORD` 时会打印 `server password <pwd>`。
///
/// 仅在「注入未生效」的兜底路径使用；正常路径下密码由 [`start_serve`] 持有。
pub(super) fn extract_server_password(line: &str) -> Option<String> {
    line.strip_prefix("server password ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Minimal base64 (standard alphabet, with padding) for the Basic header.
///
/// 只用于拼一个短的 `user:pass`，不引入额外依赖。
pub(super) fn base64_encode(input: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Read a stream to EOF, discarding bytes (keeps the pipe open).
pub(super) async fn drain_forever(mut stream: BoxAsyncRead) {
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

// ── Adapter + session ───────────────────────────────────────────────────────

/// GET + 解析 JSON；非 2xx 或非 JSON 返回 `None`（调用方负责降级）。
///
/// # 为什么住在 connection 而不是 adapter
///
/// 它是**纯 HTTP 工具**，与「哪个协议怎么适配」无关。放在 `adapter` 会让
/// `config_options`（一个纯投影模块）反过来依赖 `adapter`（上层组合者）——
/// 那是循环依赖：`adapter → config_options → adapter`。
///
/// `connection` 是两者的共同下层（它拥有 `reqwest::Client`），所以归属这里。
pub(super) async fn fetch_json(client: &reqwest::Client, url: &str) -> Option<serde_json::Value> {
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json().await.ok()
}
