//! 网关引擎（设计 §3.3）。
//!
//! # 职责（与业务无关，零业务分支）
//!
//! bind（调用方给监听器）→ 分层（归一化 / 超时 / body limit / panic 兜底 / 并发上限 /
//! 访问日志）→ 挂载路由组 → 常驻 serve → 优雅停机。
//!
//! # 洋葱序是契约，不是风格
//!
//! axum 的 `.layer()` 语义是**后加者在外**（`docs/routing/layer.md`：middleware executes
//! bottom to top）。必须被失败策略改写的三层由 [`mount_all`] 装在**组内**、归一化层**内侧** ——
//! tower 中间件只能改写**来自内层**的响应；若装到全局外层，它们自产的 5xx/413 不经过组内
//! 归一化，[`FailurePolicy`] 的三条承重路径全部落空。
//!
//! 全局层（由内到外）：`merge(各组)` → 并发上限 → 鉴权门 → 访问日志。
//!
//! - 门在并发上限**之外**：未鉴权请求在门处即被拒，**不占并发槽位**（否则同机任意进程用
//!   16 个慢速无 token 请求即可饿死合法调用）。403 同时在组归一化之外 → 不被 FailOpen 改写。
//! - 访问日志最外：403 / 503 / 超时 / panic 全都有访问日志。
//!
//! # 为什么不用 `tower_http::TraceLayer`
//!
//! 它发 `tracing` 事件，而全仓日志是 `log` crate（`common/logger.rs`）、无 tracing-subscriber
//! —— 在生产是静默 no-op。自写 `log::info!` 中间件与全仓日志栈同源（design §5）。

use std::convert::Infallible;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::Router;
use tokio::sync::{oneshot, Semaphore};
use tokio::task::JoinHandle;
use tower::Layer;
use tower::Service;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;

use crate::common::runtime::AppRuntime;

use super::gate::AuthGate;
use super::group::{FailurePolicy, RouteGroup};

/// 引擎启动入参：全部是「具体事实」，引擎内部零全局状态。
pub struct ServerConfig {
    /// 调用方 bind 好的监听器（只有它知道该绑到哪 —— 红线 8）。
    ///
    /// 调用方 bind 后自行读 `local_addr()` 取实得端口（供坐标发布）；[`serve`] 从
    /// **同一 listener** 再读一次存入 handle —— 同源事实，不设 `port` 入参字段，
    /// 杜绝「传入 port ≠ 实绑 port」的双事实源。
    pub listener: std::net::TcpListener,
    /// 并发在途上限（旧 `MAX_INFLIGHT_CONNECTIONS` 语义；进程级、所有组共享）。
    pub max_inflight: usize,
    /// 逐请求超时（`TimeoutLayer` 产出 408，经组内策略归一化）。
    pub request_timeout: Duration,
    /// 单请求 body 上限（旧 `MAX_BODY_BYTES`；413 经组内策略归一化）。
    pub max_body_bytes: usize,
}

/// 常驻服务句柄：**仅出栈、不入引擎**（引擎自己不持有它）。
pub struct ServerHandle {
    /// 发送即触发 graceful shutdown。
    shutdown: Option<oneshot::Sender<()>>,
    /// serve task 的 join（停机时等待在途请求收尾，用于停机打点）。
    join: Option<JoinHandle<()>>,
    /// 实际监听端口（serve 时读自 `listener.local_addr()`，单一事实源）。
    port: u16,
}

impl ServerHandle {
    /// 实际监听端口（测试与日志断言用）。
    #[must_use]
    pub const fn port(&self) -> u16 {
        self.port
    }

    /// 触发优雅停机并等待收尾（有界等待，超时只记日志，绝不阻塞退出）。
    ///
    /// # 线程契约
    ///
    /// 内部经 [`crate::common::runtime::block_on_shutdown`] 等待 serve task 收敛，
    /// 只可在**非 runtime 线程**调用（关闭协议的清理线程即此形态；`runtime.rs:119` 契约）。
    /// 测试在 `#[tokio::test]` 内直接调会 panic —— 必须经
    /// `std::thread::spawn(move || handle.stop()).join()`。
    pub fn stop(&mut self) {
        let started = Instant::now();
        log::info!("[http] graceful shutdown start (port {})", self.port);

        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(join) = self.join.take() {
            let elapsed = crate::common::runtime::block_on_shutdown(async move {
                let bounded = tokio::time::timeout(WATCHDOG_WAIT, join).await;
                match bounded {
                    Ok(Ok(())) => Ok(()),
                    Ok(Err(err)) => Err(format!("serve task failed: {err}")),
                    Err(_) => Err(format!("serve task not finished within {WATCHDOG_WAIT:?}")),
                }
            });
            if let Err(err) = elapsed {
                log::warn!("[http] {err} (in-flight connections hard-cut at exit)");
            }
        }

        log::info!(
            "[http] graceful shutdown finished in {:?}",
            started.elapsed()
        );
    }
}

/// 停机等待上限：超过即记 warn 并放行退出（清理卡住比不清理更糟）。
const WATCHDOG_WAIT: Duration = Duration::from_millis(200);

/// 框架级异常的产出码与集合判据。
///
/// 这三个常量被**两处**消费：`mount_all` 装配层时作为层产出码，归一化层作为判据。
/// 抽成常量是必需的 —— 若两处各写一遍，改超时码会**静默打破归一化**（层产 504 而
/// 判据仍只认 408 → fail-open 组开始漏出 5xx，且没有任何测试会红）。
mod framework_status {
    use axum::http::StatusCode;

    /// `CatchPanicLayer` 产出 → 被策略归一化。
    pub const PANIC: StatusCode = StatusCode::INTERNAL_SERVER_ERROR;
    /// `TimeoutLayer` 产出（`with_status_code` 显式给定）→ 被策略归一化。
    pub const TIMEOUT: StatusCode = StatusCode::REQUEST_TIMEOUT;
    /// `RequestBodyLimitLayer` 产出 → 被策略归一化。
    pub const BODY_TOO_LARGE: StatusCode = StatusCode::PAYLOAD_TOO_LARGE;

    /// 是否框架级异常。
    ///
    /// 只匹配这三者：路由层自产的 404 / 405 等**原样透出**（理由见 [`super::FailurePolicyService`]
    /// 类型文档 —— 那是「请求没打对」，不是「我们失败了」）。
    #[must_use]
    pub fn is_exception(status: StatusCode) -> bool {
        matches!(status, PANIC | TIMEOUT | BODY_TOO_LARGE)
    }
}

/// 组装并启动引擎。返回 handle 供关闭协议挂载。
///
/// # Errors
///
/// 监听器转 tokio 失败（`set_nonblocking` / `from_std`）时返回 `io::Error`；调用方按
/// 「旁路能力」处理（记 warn、不阻断启动）。
pub fn serve(
    runtime: &AppRuntime,
    config: ServerConfig,
    gate: Arc<AuthGate>,
    groups: Vec<RouteGroup>,
) -> std::io::Result<ServerHandle> {
    let port = config.listener.local_addr()?.port();
    config.listener.set_nonblocking(true)?;

    // `TcpListener::from_std` 会向 reactor 注册 fd：**没有 runtime 上下文时直接 panic**
    // （实测：「there is no reactor running」）。而本函数的真实调用点是 Tauri 的 setup ——
    // 同步上下文。用 `Handle::enter()` 显式进入 runtime 上下文；在已有上下文的调用方
    // （如测试的 `#[tokio::test]`）里它是幂等的。
    //
    // 这是**真机冒烟才能暴露**的一类缺陷：引擎单测全在 runtime 内跑，永远看不见它。
    let listener = {
        let _entered = runtime.handle().enter();
        tokio::net::TcpListener::from_std(config.listener)?
    };
    // listener 已被消费：后续只需要数值配置，单独持有（避免部分移动后再用 config）。
    let limits = Arc::new(Limits {
        request_timeout: config.request_timeout,
        max_body_bytes: config.max_body_bytes,
    });

    let semaphore = Arc::new(Semaphore::new(config.max_inflight));
    let app = mount(limits, gate, groups, Arc::clone(&semaphore));

    let (tx, rx) = oneshot::channel::<()>();
    let join = runtime.spawn(async move {
        let served = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
        if let Err(err) = served {
            log::warn!("[http] serve loop ended: {err}");
        }
    });

    log::info!("[http] engine listening on 127.0.0.1:{port}");

    Ok(ServerHandle {
        shutdown: Some(tx),
        join: Some(join),
        port,
    })
}

/// 组装完整应用（全局层 + 各组装配）。
///
/// 拆成独立函数是为了让测试能绕过 `serve` 直接驱动（`oneshot` 很难在测试里重复使用）。
fn mount(
    limits: Arc<Limits>,
    gate: Arc<AuthGate>,
    groups: Vec<RouteGroup>,
    semaphore: Arc<Semaphore>,
) -> Router {
    Router::new()
        .merge(mount_all(groups, limits))
        // 全局层（由内到外）：并发上限 → 鉴权门 → 访问日志。
        .layer(middleware::from_fn_with_state(semaphore, concurrency_limit))
        .layer(middleware::from_fn_with_state(gate, auth_gate))
        .layer(middleware::from_fn(access_log))
}

/// 组内层需要的数值配置（`ServerConfig` 的 listener 已被消费，不再整体传递）。
struct Limits {
    request_timeout: Duration,
    max_body_bytes: usize,
}

/// 装配全部路由组：每组各自套「内三层 + 归一化层」。
fn mount_all(groups: Vec<RouteGroup>, limits: Arc<Limits>) -> Router {
    groups.into_iter().fold(Router::new(), |router, group| {
        let name = group.name;
        let policy = group.policy;
        let layered = group
            .router
            // 组内（由内到外）：body limit → timeout → catch-panic → 策略归一化。
            .layer(RequestBodyLimitLayer::new(limits.max_body_bytes))
            .layer(TimeoutLayer::with_status_code(
                framework_status::TIMEOUT,
                limits.request_timeout,
            ))
            .layer(CatchPanicLayer::custom(
                move |_panic: Box<dyn std::any::Any + Send>| {
                    log::warn!("[http] handler panicked in group {name}");
                    (framework_status::PANIC, "").into_response()
                },
            ))
            .layer(FailurePolicyLayer::new(name, policy));
        router.merge(layered)
    })
}

/// 失败策略归一化层（§2.2 的唯一消费点）。
///
/// 只改写**框架级异常**（catch-panic 的 500 / timeout 的 408 / body-limit 的 413）。
///
/// # 为什么不改所有 4xx/5xx
///
/// 第一版的判据是 `is_client_error() || is_server_error()`，那会把**路由层自己产出的**
/// 404（路径不存在）/ 405（方法不对）也吞掉。但那些不是「故障」，是「请求没打对」——
/// 把它们伪装成 204 会让「客户端打错地址」与「我们内部 panic」在 wire 上不可区分，
/// B1 的意图（不让 CLI 侧把我们的故障当成它的故障）被偷换成「不让它看到任何错误」。
///
/// 而且它与另一条论据自相矛盾：门特意装在归一化层**之外**以保证「错 token 必须见 403」，
/// 同样属于「请求没打对」的 404/405 却没有得到同样待遇。
///
/// 由 [`crate::server::group::FailurePolicy`] 消费点统一走本函数 —— 三层各自的产出码是
/// 引擎装配时给定的常量（见 [`mount_all`]），故这里显式枚举而非范围匹配。
#[derive(Clone, Copy)]
struct FailurePolicyLayer {
    name: &'static str,
    policy: FailurePolicy,
}

impl FailurePolicyLayer {
    const fn new(name: &'static str, policy: FailurePolicy) -> Self {
        Self { name, policy }
    }
}

impl<S> Layer<S> for FailurePolicyLayer {
    type Service = FailurePolicyService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        FailurePolicyService {
            inner,
            name: self.name,
            policy: self.policy,
        }
    }
}

#[derive(Clone)]
struct FailurePolicyService<S> {
    inner: S,
    name: &'static str,
    policy: FailurePolicy,
}

impl<S> Service<Request<Body>> for FailurePolicyService<S>
where
    S: Service<Request<Body>, Response = Response, Error = Infallible> + Send + 'static,
    S::Future: Send + 'static,
{
    type Response = Response;
    type Error = Infallible;
    type Future = std::pin::Pin<Box<dyn Future<Output = Result<Response, Infallible>> + Send>>;

    fn poll_ready(
        &mut self,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, request: Request<Body>) -> Self::Future {
        let name = self.name;
        let policy = self.policy;
        let future = self.inner.call(request);
        Box::pin(async move {
            let response = future.await?;
            let status = response.status();
            // 只归一化框架级异常：路由层自产的 404/405 等原样透出（见类型文档的理由）。
            if !framework_status::is_exception(status) {
                return Ok(response);
            }
            let mapped = policy.fallback_status();
            // 改写前必须留痕：否则 B1 的代价是「看不见的故障」（design §9）。
            log::warn!("[http] group {name}: {status} -> {mapped} (failure policy)");
            Ok(mapped.into_response())
        })
    }
}

/// 并发上限中间件：`try_acquire` 失败即 503（不排队）。
///
/// `tower::limit::ConcurrencyLimitLayer` 是 `poll_ready` 排队语义（请求会堆积到超时），
/// 与旧实现「超限立即断开」相反；tower-http 不提供并发限制层 —— 故自写。
async fn concurrency_limit(
    State(semaphore): State<Arc<Semaphore>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    match Arc::clone(&semaphore).try_acquire_owned() {
        Ok(permit) => {
            let response = next.run(request).await;
            drop(permit);
            response
        }
        Err(_) => {
            log::warn!("[http] concurrency cap reached, rejecting with 503");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "too many in-flight requests",
            )
                .into_response()
        }
    }
}

/// 统一鉴权门中间件：门的裁决是唯一校验点，拒绝统一产 403。
async fn auth_gate(
    State(gate): State<Arc<AuthGate>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if !gate.authorize(request.headers()) {
        log::warn!(
            "[http] auth gate rejected request to {}",
            request.uri().path()
        );
        return StatusCode::FORBIDDEN.into_response();
    }
    next.run(request).await
}

/// 访问日志：每请求一行（method / path / status / 耗时）。
///
/// 与全仓 `log` 栈同源；不用 `tower_http::TraceLayer`（无 tracing subscriber，生产静默）。
///
/// 级别刻意用 `info!` 而非 `debug!`：本层存在的**唯一理由**是「403 / 503 / 超时 / panic
/// 全都有访问日志」（洋葱序顺序理由 1）。用 `debug!` 会让这条理由依赖 logger 级别恰好
/// 打开 debug —— 那是巧合不是契约；一次级别调整就会让故障排查静默失去全部线索。
/// 请求频率低（hook 上报，量级 = 每分钟数次），info 级不会淹没关系链日志。
async fn access_log(request: Request<Body>, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let started = Instant::now();
    let response = next.run(request).await;
    log::info!(
        "[http] {} {} -> {} ({}µs)",
        method,
        path,
        response.status().as_u16(),
        started.elapsed().as_micros()
    );
    response
}

#[cfg(test)]
mod tests;
