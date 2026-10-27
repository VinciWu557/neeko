//! HTTP 网关 wire 等价性集成测试（AC2）。
//!
//! # 为什么是「注入 sink」而不是真 `AppHandle`
//!
//! 集成测试是独立 crate，`tauri` 未开 `test` feature（全仓无 `tauri::test` 先例），
//! 构造不出 `AppHandle`。故路由组经 [`route_group_with`] 注入记录型 sink ——
//! **引擎 / 鉴权门 / 失败策略 / handler / 内核全部与生产同源**，只有 `deliver_signal`
//! 本体被替换（它由既有 dispatch 单测 + 真机验证覆盖）。
//!
//! # 断言口径
//!
//! design §6 的「客户端可观测行为」：**状态码 + 是否投递**双断言。
//! 裸字节（非 HTTP）与超长头是已记录偏差（§6 第 6/7 行），不在本文件范围。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use neeko_lib::agent::hooks::ingest::event::HookEvent;
use neeko_lib::agent::hooks::ingest::handlers;
use neeko_lib::agent::hooks::ingest::validation::TOKEN_HEADER;
use neeko_lib::common::runtime::AppRuntime;
use neeko_lib::server::{serve, AuthGate, HeaderToken, ServerConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN: &str = "tok-integration";
const MAX_BODY_BYTES: usize = 64 * 1024;

/// 记录型 sink：断言「投递了几次、投递了什么」。
type Delivered = Arc<Mutex<Vec<(String, HookEvent)>>>;

fn start_engine(max_body_bytes: usize) -> (ServerHarness, Delivered) {
    let delivered: Delivered = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&delivered);
    let group = handlers::route_group_with(move |source, envelope| {
        sink.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push((source.to_owned(), envelope));
    });

    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback");
    let port = listener.local_addr().expect("local addr").port();
    let runtime = Arc::new(AppRuntime::from_handle(tokio::runtime::Handle::current()));
    let gate = Arc::new(AuthGate::new(
        TOKEN.to_string(),
        vec![Arc::new(HeaderToken { name: TOKEN_HEADER })],
    ));
    let handle = serve(
        &runtime,
        ServerConfig {
            listener,
            max_inflight: 16,
            request_timeout: Duration::from_secs(2),
            max_body_bytes,
        },
        gate,
        vec![group],
    )
    .expect("serve");

    (ServerHarness { handle, port }, delivered)
}

struct ServerHarness {
    handle: neeko_lib::server::ServerHandle,
    port: u16,
}

impl ServerHarness {
    async fn post(&self, path: &str, token: Option<&str>, body: &str) -> u16 {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", self.port))
            .await
            .expect("connect");
        let token_line = token
            .map(|t| format!("{TOKEN_HEADER}: {t}\r\n"))
            .unwrap_or_default();
        let raw = format!(
            "POST {path} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\n\
             content-length: {}\r\nconnection: close\r\n{token_line}\r\n{body}",
            body.len()
        );
        stream.write_all(raw.as_bytes()).await.expect("write");
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.expect("read");
        parse_status(&buf)
    }

    async fn stop(self) {
        let mut handle = self.handle;
        tokio::task::spawn_blocking(move || handle.stop())
            .await
            .expect("stop thread");
    }
}

fn parse_status(raw: &[u8]) -> u16 {
    let text = String::from_utf8_lossy(raw);
    text.split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("status code in response")
}

fn valid_body() -> String {
    r#"{"agent_session_id":"a1","event":"turn_completed","cwd":"/tmp/proj"}"#.to_string()
}

fn delivered_count(delivered: &Delivered) -> usize {
    delivered
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .len()
}

/// §6 第 1 行：合法 token + 已知 source + 合法 JSON → 204，投递恰好一次。
#[tokio::test]
async fn valid_request_is_accepted_and_delivered_once() {
    let (server, delivered) = start_engine(MAX_BODY_BYTES);

    let status = server.post("/hook/pi", Some(TOKEN), &valid_body()).await;
    assert_eq!(status, 204);
    assert_eq!(delivered_count(&delivered), 1);
    let recorded = delivered
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .first()
        .map(|(source, envelope)| (source.clone(), envelope.agent_session_id.clone()))
        .expect("one delivery");
    assert_eq!(recorded, ("pi".to_string(), "a1".to_string()));

    server.stop().await;
}

/// §6 第 2 行：token 不符 / 缺 token → 403，不投递（拒绝点已从内核移到鉴权门）。
#[tokio::test]
async fn wrong_or_missing_token_is_forbidden_and_not_delivered() {
    let (server, delivered) = start_engine(MAX_BODY_BYTES);

    assert_eq!(
        server.post("/hook/pi", Some("stale"), &valid_body()).await,
        403
    );
    assert_eq!(server.post("/hook/pi", None, &valid_body()).await, 403);
    assert_eq!(delivered_count(&delivered), 0);

    server.stop().await;
}

/// §6 第 3 行：未知 source → 204 + warn，不投递。
#[tokio::test]
async fn unknown_source_is_accepted_but_not_delivered() {
    let (server, delivered) = start_engine(MAX_BODY_BYTES);

    let status = server
        .post("/hook/not-a-registered-cli", Some(TOKEN), &valid_body())
        .await;
    assert_eq!(status, 204, "unknown source must stay fail-open");
    assert_eq!(delivered_count(&delivered), 0);

    server.stop().await;
}

/// §6 第 4 行：body 超限 → 引擎 413 → 组内策略归一 → 204，不投递。
#[tokio::test]
async fn oversized_body_is_normalized_to_no_content_and_not_delivered() {
    // 引擎上限压到 128B，杜绝测试里搬 64KB。
    let (server, delivered) = start_engine(128);
    let big = format!(
        r#"{{"agent_session_id":"a1","event":"turn_completed","detail":"{}"}}"#,
        "x".repeat(4096)
    );

    let status = server.post("/hook/pi", Some(TOKEN), &big).await;
    assert_eq!(
        status, 204,
        "413 must be normalized by the fail-open policy"
    );
    assert_eq!(delivered_count(&delivered), 0);

    server.stop().await;
}

/// §6 第 5 行：非法 JSON / 空 session_id → 204，不投递（内核语义兜底）。
#[tokio::test]
async fn malformed_payload_is_accepted_but_not_delivered() {
    let (server, delivered) = start_engine(MAX_BODY_BYTES);

    for body in [
        "not json".to_string(),
        r#"{"agent_session_id":"","event":"turn_completed"}"#.to_string(),
        r#"{"event":"turn_completed"}"#.to_string(),
    ] {
        let status = server.post("/hook/pi", Some(TOKEN), &body).await;
        assert_eq!(status, 204, "malformed payload must fail open: {body}");
    }
    assert_eq!(delivered_count(&delivered), 0);

    server.stop().await;
}

/// endpoints/*.env 文件形状不变（§6 第 11 行）由 `endpoint.rs` 既有测试钉住；
/// 本文件只证明 wire 层等价。
#[test]
fn wire_contract_uses_the_hook_targets_table() {
    // 白名单派生自事实表：`pi` 在表里，任意未注册名不在（路由与文件面共用同一张表）。
    assert!(neeko_lib::agent::hooks::targets::HOOK_TARGETS
        .iter()
        .any(|target| target.source == "pi"));
}

/// **DSH 是自供源**：`/hook/dsh` 必须被接收（否则 `dsh-neeko` 的通知全被静默丢弃）。
///
/// 反证钉子：删掉 `HOOK_TARGETS` 里的 `dsh` 行 → 本用例必红。
/// 这正是 Step 0 P6b 实测到的形态 —— 服务端回 **204** 但事件**不投递**，
/// 只看状态码会得到假绿灯。故本用例断言的是「**投递了**」，不是「状态码 204」。
///
/// 与既有 `post_notifies_only_registered_sources` 的分工：那条验「未知源被丢弃」，
/// 这条验「已知的自供源能被接收」。两条合起来才说明白名单是**双向**正确的。
#[tokio::test]
async fn dsh_source_is_accepted_by_ingest() {
    let (h, delivered) = start_engine(MAX_BODY_BYTES);
    let body = r#"{"agent_session_id":"session-dsh-1","event":"turn_completed","cwd":"/work/proj","detail":null,"title":"Headless reply","hints":{"neeko_session_id":null,"project_id":null}}"#;

    let status = h.post("/hook/dsh", Some(TOKEN), body).await;
    assert_eq!(status, 204);

    let got = delivered.lock().expect("lock").clone();
    assert_eq!(got.len(), 1, "必须投递（204 但丢弃 = 假绿灯）: {got:?}");
    let (source, event) = &got[0];
    assert_eq!(source, "dsh");
    assert_eq!(event.event, "turn_completed");
    assert_eq!(event.agent_session_id, "session-dsh-1");
    assert_eq!(event.title.as_deref(), Some("Headless reply"));
    h.stop().await;
}
