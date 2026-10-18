//! 引擎测试：真实 socket 驱动，不依赖 Tauri（design §7）。
//!
//! 每个用例都走「真 listener + 真 HTTP 请求」—— 只测到响应层，不触碰业务。

use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::Router;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::common::runtime::AppRuntime;

use super::super::gate::{AuthGate, HeaderToken};
use super::super::group::{FailurePolicy, RouteGroup};
use super::{serve, ServerConfig};

const TOKEN: &str = "tok-engine-test";

/// panic handler：显式返回类型，避免 never-type fallback（Rust 2024 硬错误）。
async fn boom_handler() -> (StatusCode, &'static str) {
    panic!("boom")
}

fn gate() -> Arc<AuthGate> {
    Arc::new(AuthGate::new(
        TOKEN.to_string(),
        vec![Arc::new(HeaderToken { name: "x-token" })],
    ))
}

fn config(port_listener: std::net::TcpListener) -> ServerConfig {
    ServerConfig {
        listener: port_listener,
        max_inflight: 8,
        request_timeout: Duration::from_millis(300),
        max_body_bytes: 1024,
    }
}

fn group(name: &'static str, policy: FailurePolicy, router: Router) -> RouteGroup {
    RouteGroup {
        name,
        policy,
        router,
    }
}

/// 发一个裸 HTTP/1.1 请求（POST），返回状态码与响应体。
async fn request(port: u16, path: &str, token: Option<&str>) -> (u16, String) {
    request_with(port, "POST", path, token).await
}

/// 同上，可指定方法。
async fn request_with(port: u16, method: &str, path: &str, token: Option<&str>) -> (u16, String) {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect to engine");
    let token_line = token
        .map(|t| format!("x-token: {t}\r\n"))
        .unwrap_or_default();
    let raw = format!(
        "{method} {path} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 0\r\nconnection: close\r\n{token_line}\r\n"
    );
    stream.write_all(raw.as_bytes()).await.expect("write");
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.expect("read");
    let text = String::from_utf8_lossy(&buf).to_string();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .expect("status code in response");
    (status, text)
}

async fn spawn_pair(
    policy: FailurePolicy,
    router: Router,
) -> (super::ServerHandle, Arc<crate::common::runtime::AppRuntime>) {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let runtime = Arc::new(AppRuntime::from_handle(tokio::runtime::Handle::current()));
    let handle = serve(
        &runtime,
        config(listener),
        gate(),
        vec![group("test", policy, router)],
    )
    .expect("serve");
    (handle, runtime)
}

/// AC3：只绑 loopback，且 handle 报告的端口真实可连。
#[tokio::test]
async fn binds_loopback_and_reports_real_port() {
    let (handle, _runtime) = spawn_pair(FailurePolicy::FailOpen, Router::new()).await;
    assert!(handle.port() > 0);

    let connected = tokio::net::TcpStream::connect(("127.0.0.1", handle.port())).await;
    assert!(connected.is_ok(), "engine must listen on 127.0.0.1");

    stop_in_thread(handle).await;
}

/// 鉴权门：缺 token / 错 token → 403，且**不被** FailOpen 归一化。
#[tokio::test]
async fn missing_or_wrong_token_is_forbidden() {
    let router = Router::new().route("/hook/x", post(|| async { StatusCode::NO_CONTENT }));
    let (handle, _runtime) = spawn_pair(FailurePolicy::FailOpen, router).await;

    let (status, _) = request(handle.port(), "/hook/x", None).await;
    assert_eq!(status, 403, "missing token must be 403, not normalized");

    let (status, _) = request(handle.port(), "/hook/x", Some("stale")).await;
    assert_eq!(status, 403);

    stop_in_thread(handle).await;
}

/// FailOpen：handler panic → 500 → 组内归一化 → 204（策略真承重）。
#[tokio::test]
async fn panic_in_fail_open_group_is_normalized_to_no_content() {
    let router = Router::new().route("/boom", get(boom_handler));
    let (handle, _runtime) = spawn_pair(FailurePolicy::FailOpen, router).await;

    let (status, _) = request_with(handle.port(), "GET", "/boom", Some(TOKEN)).await;
    assert_eq!(status, 204, "fail-open group must hide handler panics");

    stop_in_thread(handle).await;
}

/// 反证断言真的打到了会 panic 的 handler：若回归到「POST 打 GET 路由 → 405 被吞掉」，
/// 上面两条会重新变绿但 panic 路径已无覆盖。故这里显式钉住 405 可见（见
/// `routing_errors_are_not_normalized_by_failure_policy`）。
#[tokio::test]
async fn panic_path_really_reaches_the_handler() {
    let router = Router::new().route("/boom", get(boom_handler));
    let (handle, _runtime) = spawn_pair(FailurePolicy::FailOpen, router).await;

    // 正确方法（GET）→ 走到 handler → panic → 500 → 归一化 204
    let (status, _) = request_with(handle.port(), "GET", "/boom", Some(TOKEN)).await;
    assert_eq!(status, 204);

    // 错误方法（POST）→ 路由层 405，可见
    let (status, _) = request(handle.port(), "/boom", Some(TOKEN)).await;
    assert_eq!(status, 405);

    stop_in_thread(handle).await;
}

/// FailClosed：handler panic → 500 被归一化为 500（不伪装成功）。
#[tokio::test]
async fn panic_in_fail_closed_group_is_server_error() {
    let router = Router::new().route("/boom", get(boom_handler));
    let (handle, _runtime) = spawn_pair(FailurePolicy::FailClosed, router).await;

    let (status, _) = request_with(handle.port(), "GET", "/boom", Some(TOKEN)).await;
    assert_eq!(status, 500);

    stop_in_thread(handle).await;
}

/// 超时：`TimeoutLayer` 产出 408，经组内策略归一化（FailOpen → 204）。
#[tokio::test]
async fn timeout_is_normalized_for_fail_open_group() {
    let router = Router::new().route(
        "/slow",
        get(|| async {
            tokio::time::sleep(Duration::from_millis(2_000)).await;
            StatusCode::OK
        }),
    );
    let (handle, _runtime) = spawn_pair(FailurePolicy::FailOpen, router).await;

    let (status, _) = request_with(handle.port(), "GET", "/slow", Some(TOKEN)).await;
    assert_eq!(status, 204, "timeout must be normalized to 204");

    stop_in_thread(handle).await;
}

/// body 超限：`RequestBodyLimitLayer` 产出 413，经组内策略归一化（FailOpen → 204）。
#[tokio::test]
async fn oversized_body_is_normalized_for_fail_open_group() {
    let router = Router::new().route(
        "/hook/x",
        post(|body: axum::body::Bytes| async move {
            let _ = body;
            StatusCode::NO_CONTENT
        }),
    );
    let handle_pair = spawn_pair(FailurePolicy::FailOpen, router).await;
    let port = handle_pair.0.port();

    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect");
    let body = "x".repeat(4 * 1024);
    let raw = format!(
        "POST /hook/x HTTP/1.1\r\nhost: 127.0.0.1\r\nx-token: {TOKEN}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(raw.as_bytes()).await.expect("write");
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf).await;
    let text = String::from_utf8_lossy(&buf).to_string();
    let status: u16 = text
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("status");
    assert_eq!(status, 204, "413 must be normalized to 204");

    stop_in_thread(handle_pair.0).await;
}

/// 并发上限：`max_inflight = 1` 时第二个并发请求拿不到许可 → 503（不排队）。
///
/// 必须用**多线程 runtime**：第一个请求要长期占住 handler，单线程 runtime 下
/// 它会把执行器饿住，第二个请求连发都发不出去（本用例的第一版就是这么挂的）。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn second_concurrent_request_is_rejected_with_503() {
    // 用信号量做确定性握手：handler 先 add_permits(1) 表示「已进入」，
    // 再等 release 的许可才返回 —— 避免 Notify::notify_waiters 对未注册等待者丢信号。
    let entered = Arc::new(tokio::sync::Semaphore::new(0));
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let entered_in_handler = Arc::clone(&entered);
    let release_in_handler = Arc::clone(&release);

    let router = Router::new().route(
        "/hold",
        get(move || {
            let entered = Arc::clone(&entered_in_handler);
            let release = Arc::clone(&release_in_handler);
            async move {
                entered.add_permits(1);
                let permit = release.acquire().await.expect("release semaphore open");
                permit.forget();
                StatusCode::NO_CONTENT
            }
        }),
    );

    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let mut cfg = config(listener);
    cfg.max_inflight = 1;
    cfg.request_timeout = Duration::from_secs(10); // 本用例只测并发上限，不放超时干扰
    let runtime = Arc::new(AppRuntime::from_handle(tokio::runtime::Handle::current()));
    let handle = serve(
        &runtime,
        cfg,
        gate(),
        vec![group("test", FailurePolicy::FailOpen, router)],
    )
    .expect("serve");
    let port = handle.port();

    // 第一个请求占住唯一许可。
    tokio::spawn(async move {
        let _ = request_with(port, "GET", "/hold", Some(TOKEN)).await;
    });
    let entered_permit = entered.acquire().await.expect("handler entered");
    entered_permit.forget();

    // 第二个请求：并发槽位已满 → 503。
    let (status, _) = request_with(port, "GET", "/hold", Some(TOKEN)).await;
    assert_eq!(
        status, 503,
        "second in-flight request must be shed immediately"
    );

    release.add_permits(1);
    stop_in_thread(handle).await;
}

/// 未鉴权请求不占并发槽位（门在并发限制之外）：403 后合法请求仍可进入。
#[tokio::test]
async fn unauthenticated_requests_do_not_consume_slots() {
    let router = Router::new().route("/ok", get(|| async { StatusCode::NO_CONTENT }));
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let mut cfg = config(listener);
    cfg.max_inflight = 1;
    let runtime = Arc::new(AppRuntime::from_handle(tokio::runtime::Handle::current()));
    let handle = serve(
        &runtime,
        cfg,
        gate(),
        vec![group("test", FailurePolicy::FailOpen, router)],
    )
    .expect("serve");
    let port = handle.port();

    for _ in 0..4 {
        let (status, _) = request_with(port, "GET", "/ok", None).await;
        assert_eq!(status, 403);
    }
    let (status, _) = request_with(port, "GET", "/ok", Some(TOKEN)).await;
    assert_eq!(
        status, 204,
        "unauthenticated rejects must not consume slots"
    );

    stop_in_thread(handle).await;
}

/// 未被策略改写：路由层自产的 404（未知路径）与 405（方法不符）**原样透出**。
///
/// 归一化只覆盖框架级异常（panic / 超时 / body 超限）。「请求没打对」不是「我们失败了」——
/// 若把 404/405 也伪装成 204，客户端打错地址就与内部 panic 在 wire 上不可区分，
/// 且与「门在归一化之外，错 token 必须见 403」自相矛盾。
#[tokio::test]
async fn routing_errors_are_not_normalized_by_failure_policy() {
    let router = Router::new().route("/hook/x", post(|| async { StatusCode::NO_CONTENT }));
    let (handle, _runtime) = spawn_pair(FailurePolicy::FailOpen, router).await;

    let (status, _) = request_with(handle.port(), "GET", "/hook/x", Some(TOKEN)).await;
    assert_eq!(
        status, 405,
        "method mismatch must stay visible (not masked to 204)"
    );

    let (status, _) = request(handle.port(), "/no-such-route", Some(TOKEN)).await;
    assert_eq!(
        status, 404,
        "unknown path must stay visible (not masked to 204)"
    );

    stop_in_thread(handle).await;
}

/// 归一化判据与层产出码**同源**（`framework_status` 常量是唯一事实源）。
///
/// 反证「改超时码会静默打破归一化」：若装配用字面量而判据用另一套，fail-open 组会漏出 5xx
/// 且无测试变红。本用例把三者的「装配路径可观测结果」与判据绑在一起。
#[tokio::test]
async fn framework_exception_codes_are_recognized_by_the_policy() {
    use super::framework_status;
    use axum::http::StatusCode;

    // 归一化认这三个
    assert!(framework_status::is_exception(framework_status::PANIC));
    assert!(framework_status::is_exception(framework_status::TIMEOUT));
    assert!(framework_status::is_exception(
        framework_status::BODY_TOO_LARGE
    ));
    // 且不认路由层自产码 / 语义成功码
    for pass_through in [
        StatusCode::NOT_FOUND,
        StatusCode::METHOD_NOT_ALLOWED,
        StatusCode::FORBIDDEN,
        StatusCode::SERVICE_UNAVAILABLE,
        StatusCode::NO_CONTENT,
    ] {
        assert!(
            !framework_status::is_exception(pass_through),
            "{pass_through} must pass through unnormalized"
        );
    }
}

/// AC5：`stop()` 收敛 serve task，端口不再接受连接。
///
/// **必须在独立 OS 线程调用** —— `stop()` 走 `block_on_shutdown`，runtime 线程内会 panic。
#[tokio::test]
async fn stop_converges_and_releases_port() {
    let (mut handle, _runtime) = spawn_pair(FailurePolicy::FailOpen, Router::new()).await;
    let port = handle.port();

    tokio::task::spawn_blocking(move || handle.stop())
        .await
        .expect("stop thread");

    let refused = tokio::net::TcpStream::connect(("127.0.0.1", port)).await;
    assert!(refused.is_err(), "port must be closed after stop");
}

async fn stop_in_thread(mut handle: super::ServerHandle) {
    tokio::task::spawn_blocking(move || handle.stop())
        .await
        .expect("stop thread");
}

/// AC3 + 真机冒烟回归：**在没有 runtime 上下文的线程**里 `serve` 必须不 panic。
///
/// 实测事故：`TcpListener::from_std` 需要 reactor 上下文，而真实调用点是 Tauri setup
/// （同步）。初版实现因此在启动期 panic（`there is no reactor running`）—— 引擎单测全在
/// `#[tokio::test]` 内跑，看不见这个缺陷；只有真机冒烟才暴露。本用例钉住它。
#[test]
fn serve_from_sync_context_does_not_panic() {
    // 独立 runtime（模拟 Tauri 的全局运行时），但**本线程不进入它的上下文**。
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("build runtime");
    let app_runtime = Arc::new(AppRuntime::from_handle(runtime.handle().clone()));

    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let handle = serve(
        &app_runtime,
        config(listener),
        gate(),
        vec![group("test", FailurePolicy::FailOpen, Router::new())],
    )
    .expect("serve must succeed from a sync context");

    let port = handle.port();
    assert!(port > 0);
    runtime.block_on(async move {
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok());
    });

    // 停机也走独立线程（`stop()` 的线程契约）。
    std::thread::spawn(move || {
        let mut handle = handle;
        handle.stop();
    })
    .join()
    .expect("stop thread");
}
