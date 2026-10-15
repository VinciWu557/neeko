//! loopback HTTP ingest server（design §2.5，R6.2/R6.3）。
//!
//! 物理约束三条，缺一不可：
//! 1. **只绑 127.0.0.1**、随机端口（bind :0）——不开对外网络面（红线 8 精神）；
//! 2. **每次启动随机 token**（内存 + 0600 endpoint 文件），不符 → 403 —— 拒绝同机他进程伪造；
//! 3. **fail-open**：一切异常路径（畸形请求 / 未知 source / 未知事件 / 超限）返回 204，
//!    绝不 5xx —— 5xx 会让 hook 模板认为"接收端故障"，违背「不阻塞用户 agent」（T5）。
//!
//! 分层：[`ingest`] 是纯内核（bytes → 语义结果），全部行为可单测；accept/read/write
//! 是薄壳（阻塞 IO 在 `spawn_blocking`，红线 3），壳内只做搬运。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::common::runtime::AppRuntime;

use super::attribution::{attribute, ProjectRef};
use super::endpoint::{self, EndpointPublication};
use super::notify::{project, HookEnvelope};
use super::targets::HOOK_TARGETS;
use crate::AppStateWrapper;

/// token 校验请求头（上报模板与本文件是同一契约的两端）。
pub const TOKEN_HEADER: &str = "x-neeko-agent-hook-token";
/// 请求头段大小上限（防无界头）。
const MAX_HEADER_BYTES: usize = 8 * 1024;
/// 请求体大小上限（通知载荷是标量集合，64KB 远够；红线 4 精神）。
const MAX_BODY_BYTES: usize = 64 * 1024;
/// 并发在途连接上限：本机 loopback 上的空连接也必须能被打满（每连接一个 OS 线程，
/// 无上限 = 同机任意进程可耗尽线程资源 —— 单机 OS 资源底线）。
const MAX_INFLIGHT_CONNECTIONS: usize = 16;

/// 在途连接计数（RAII：拒绝时立即归还，正常/异常退出在 drop 时归还）。
static INFLIGHT: AtomicUsize = AtomicUsize::new(0);

/// 借用计数器以便单测用局部实例（不依赖进程全局态）。
struct InflightGuard<'a>(&'a AtomicUsize);

impl<'a> InflightGuard<'a> {
    /// 占一个名额；已满返回 `None`（调用方直接断开，不建线程）。
    fn acquire(counter: &'a AtomicUsize, limit: usize) -> Option<Self> {
        if counter.fetch_add(1, Ordering::Relaxed) < limit {
            Some(Self(counter))
        } else {
            counter.fetch_sub(1, Ordering::Relaxed);
            None
        }
    }
}

impl Drop for InflightGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

/// 内核裁决结果。
#[derive(Debug, PartialEq, Eq)]
pub enum IngestOutcome {
    /// 成功受理（含"语义未知但无害"的静默吞掉）——对 agent 侧统一 204。
    Accepted,
    /// token 不符 —— 403（可能是旧实例残留进程，记 warn 不升级为错误）。
    Rejected,
}

/// 纯内核：完整请求字节 → 裁决。`sink` 收到已鉴权、已解析、source 合法的上报。
///
/// 解析失败（非法 HTTP / 非法 JSON / 缺字段 / 空 session id / body 超限）一律 Accepted
/// 静默 —— fail-open 的判据是「agent 永远拿到无信息量的成功」。
pub fn ingest(
    raw: &[u8],
    expected_token: &str,
    mut sink: impl FnMut(&str, HookEnvelope),
) -> IngestOutcome {
    let Some((head, body)) = split_request(raw) else {
        return IngestOutcome::Accepted; // 畸形 HTTP：静默
    };
    let token = find_header(head, TOKEN_HEADER);
    if token != Some(expected_token) {
        return IngestOutcome::Rejected;
    }
    let Some(source) = hook_source(head) else {
        return IngestOutcome::Accepted; // 非 /hook/<known> 路径：静默
    };
    if body.len() > MAX_BODY_BYTES {
        return IngestOutcome::Accepted;
    }
    let Ok(envelope) = serde_json::from_slice::<HookEnvelope>(body) else {
        return IngestOutcome::Accepted; // 非法 JSON：静默
    };
    if envelope.is_usable() {
        sink(source, envelope);
    }
    IngestOutcome::Accepted
}

/// 请求行 + 头段/体段切分。返回 (head_bytes, body_bytes)。
fn split_request(raw: &[u8]) -> Option<(&[u8], &[u8])> {
    let separator = raw
        .windows(4)
        .find_map(|w| (w == b"\r\n\r\n").then_some(w.as_ptr() as usize - raw.as_ptr() as usize))?;
    let head = &raw[..separator];
    let body = &raw[separator + 4..];
    if head.len() > MAX_HEADER_BYTES {
        return None;
    }
    Some((head, body))
}

/// 大小写不敏感地取头值。
fn find_header<'a>(head: &'a [u8], name: &str) -> Option<&'a str> {
    let head_str = std::str::from_utf8(head).ok()?;
    let lower_name = name.to_lowercase();
    for line in head_str.lines().skip(1) {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim().to_lowercase() == lower_name {
            return Some(value.trim());
        }
    }
    None
}

/// 请求行 `POST /hook/<source> HTTP/1.1` → source（须是已接入的受管 CLI）。
///
/// 白名单直接来自 [`HOOK_TARGETS`] —— 路由与文件面共用同一张表，接新 CLI 只加一行数据。
fn hook_source(head: &[u8]) -> Option<&'static str> {
    let request_line = std::str::from_utf8(head).ok()?.lines().next()?;
    let mut parts = request_line.split_whitespace();
    if parts.next()? != "POST" {
        return None;
    }
    let path = parts.next()?;
    let source = path.strip_prefix("/hook/")?;
    HOOK_TARGETS
        .iter()
        .find(|target| target.source == source)
        .map(|target| target.source)
}

/// 启动摄入服务：绑定 → 发布 endpoint → accept 循环（经 `AppRuntime` 的阻塞池，
/// fire-and-forget）。
///
/// 生命周期 = 进程（accept_timeout 随进程退出自然终止，与 watcher 守护线程同级语义）；
/// 返回实际端口供日志。失败由调用方 best-effort 记日志 —— 通知摄入是旁路，不阻断启动。
///
/// 调度经 [`AppRuntime`]（Scheme C 契约：业务码不 bare 调 `tokio`/`tauri` 运行时）——
/// accept 是常驻任务，用 `spawn_blocking`（`run_blocking` 是 join 语义，不适用）。
pub fn spawn(
    app: AppHandle,
    neeko_dir: std::path::PathBuf,
    runtime: Arc<AppRuntime>,
) -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    // 一次性迁移（v5 多实例）：旧单文件坐标退役，避免上报端同时读到新旧两种形态。
    // 失败只警告不阻断（通知是旁路；上报端的目录扫描本就忽略旧文件）。
    if let Err(err) = endpoint::remove_legacy_endpoint(&neeko_dir) {
        log::warn!("[agent-hooks] remove legacy endpoint.env failed: {err}");
    }
    // instance_id = 进程启动时随机 uuid，仅内存持有、仅用作文件名：每实例一个坐标文件，
    // 多实例共存互不覆写（R6.8 / AC18）。
    let instance_id = uuid::Uuid::new_v4().to_string();
    let publication = EndpointPublication::new(
        &neeko_dir,
        instance_id,
        port,
        uuid::Uuid::new_v4().to_string(),
    );
    publication.publish()?;
    let token = publication.token.clone();
    log::info!(
        "[agent-hooks] ingest listening on 127.0.0.1:{port} (instance {}, endpoint: {})",
        publication.instance_id,
        publication.path.display()
    );

    runtime.spawn_blocking(move || {
        // nonblocking poll（无 stop 信号的守护循环，进程退出自然终止；与 watcher 同语义）。
        if let Err(err) = listener.set_nonblocking(true) {
            log::warn!("[agent-hooks] ingest disabled (set_nonblocking failed): {err}");
            return;
        }
        loop {
            match listener.accept() {
                Ok((stream, _addr)) => {
                    let Some(guard) = InflightGuard::acquire(&INFLIGHT, MAX_INFLIGHT_CONNECTIONS)
                    else {
                        log::warn!("[agent-hooks] inflight cap reached, dropping connection");
                        continue;
                    };
                    let app = app.clone();
                    let token = token.clone();
                    // 命名线程（并发指南：便于调试定位）；创建失败只丢这一条连接，
                    // 不得 panic 终结 accept 循环（注：guard 随闭包析构自动归还槽位）。
                    let spawned = std::thread::Builder::new()
                        .name("agent-hook-conn".into())
                        .spawn(move || {
                            let _inflight = guard;
                            if let Err(err) = serve_conn(stream, &token, &app) {
                                log::debug!("[agent-hooks] conn closed: {err}");
                            }
                        });
                    if let Err(err) = spawned {
                        log::warn!("[agent-hooks] conn thread spawn failed: {err}");
                    }
                }
                Err(err)
                    if matches!(
                        err.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(err) => {
                    log::warn!("[agent-hooks] accept loop ended: {err}");
                    break;
                }
            }
        }
    });

    Ok(port)
}

/// 单连接：受限读取 → 内核裁决 → 最小响应。
fn serve_conn(mut stream: TcpStream, token: &str, app: &AppHandle) -> std::io::Result<()> {
    stream.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(2)))?;

    let raw = read_limited(&mut stream);
    let outcome = ingest(&raw, token, |source, envelope| {
        deliver_signal(app, source, envelope);
    });
    let status = match outcome {
        IngestOutcome::Rejected => "HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n",
        IngestOutcome::Accepted => "HTTP/1.1 204 No Content\r\n\r\n",
    };
    stream.write_all(status.as_bytes())
}

/// 读取上限 `MAX_HEADER_BYTES + MAX_BODY_BYTES + 8`：超限直接截断（内核会按非法处理）。
fn read_limited(stream: &mut TcpStream) -> Vec<u8> {
    let mut buf = Vec::with_capacity(4 * 1024);
    let mut chunk = [0u8; 4096];
    let cap = MAX_HEADER_BYTES + MAX_BODY_BYTES + 8;
    loop {
        let read = match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..read]);
        // 收到完整请求头后按 content-length 判断体是否读完（缺头按已到即读处理）。
        if buf.len() >= cap || head_complete(&buf) {
            break;
        }
    }
    buf.truncate(cap);
    buf
}

fn head_complete(buf: &[u8]) -> bool {
    // 简化判据：头段完整且声明的 content-length 已满足。
    let Some((head, body)) = split_request(buf) else {
        return false;
    };
    let declared = find_header_len(head).unwrap_or(0).min(MAX_BODY_BYTES);
    body.len() >= declared
}

fn find_header_len(head: &[u8]) -> Option<usize> {
    find_header(head, "content-length")?.parse().ok()
}

/// 归属 + 投影 + 门面投喂（外圈唯一触碰业务状态处）。
fn deliver_signal(app: &AppHandle, source: &str, envelope: HookEnvelope) {
    let state = app.state::<AppStateWrapper>();
    let projects: Vec<ProjectRef> = match state.project_manager.lock() {
        Ok(manager) => manager
            .list_projects()
            .into_iter()
            .map(|p| ProjectRef {
                project_id: p.id.clone(),
                project_name: p.name.clone(),
                roots: vec![p.path.clone()],
            })
            .collect(),
        Err(poisoned) => {
            log::warn!("[agent-hooks] project manager lock poisoned: {poisoned}");
            return;
        }
    };
    let attribution = attribute(
        &envelope.agent_session_id,
        envelope.cwd.as_deref(),
        &envelope.hints,
        &projects,
    );
    let Some(signal) = project(source, &envelope, &attribution) else {
        return; // 未知语义事件：fail-open
    };
    // 外部终端会话对本应用恒不可见（instance_visible=false）；env 精确命中自有会话时
    // 复用源 A 可见性判定（instance id 相同 → 槽位命中即抑制）。
    let instance_visible = state.agent_chat_manager.visible_session().as_deref()
        == Some(signal.source.instance_id.as_str());
    state.notification.observe(app, signal, instance_visible);
}

// ── TDD：内核全行为（外圈 socket 只搬运，不单测）───────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "tok-test";

    fn request(source: &str, token: Option<&str>, body: &str) -> Vec<u8> {
        let token_line = token
            .map(|t| format!("{TOKEN_HEADER}: {t}\r\n"))
            .unwrap_or_default();
        format!(
            "POST /hook/{source} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\ncontent-length: {}\r\n{token_line}\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    fn valid_body() -> String {
        r#"{"agent_session_id":"a1","event":"turn_completed","cwd":"/x/proj"}"#.to_string()
    }

    /// happy path：合法 token + source + envelope → sink 收到。
    #[test]
    fn accepted_delivers_envelope_to_sink() {
        let mut got = None;
        let outcome = ingest(
            &request("opencode", Some(TOKEN), &valid_body()),
            TOKEN,
            |source, envelope| got = Some((source.to_string(), envelope)),
        );
        assert_eq!(outcome, IngestOutcome::Accepted);
        let (source, envelope) = got.expect("sink called");
        assert_eq!(source, "opencode");
        assert_eq!(envelope.agent_session_id, "a1");
        assert_eq!(envelope.event, "turn_completed");
    }

    /// token 不符 → Rejected（403），sink 不被触碰。
    #[test]
    fn wrong_token_is_rejected() {
        let mut called = false;
        let outcome = ingest(
            &request("pi", Some("stale"), &valid_body()),
            TOKEN,
            |_, _| called = true,
        );
        assert_eq!(outcome, IngestOutcome::Rejected);
        assert!(!called);
    }

    /// 缺 token → Rejected。
    #[test]
    fn missing_token_is_rejected() {
        assert_eq!(
            ingest(&request("pi", None, &valid_body()), TOKEN, |_, _| {}),
            IngestOutcome::Rejected
        );
    }

    /// fail-open：非法 JSON / 空 session id / 未知 source / 畸形请求 → 一律 Accepted 静默。
    #[test]
    fn malformed_inputs_fail_open() {
        for raw in [
            b"garbage".to_vec(),
            request("pi", Some(TOKEN), "not json"),
            request(
                "pi",
                Some(TOKEN),
                r#"{"agent_session_id":"","event":"turn_completed"}"#,
            ),
            request("cursor", Some(TOKEN), &valid_body()), // 未接入的 CLI
            request("pi", Some(TOKEN), r#"{"event":"turn_completed"}"#), // 缺必填字段
        ] {
            let mut called = false;
            assert_eq!(
                ingest(&raw, TOKEN, |_, _| called = true),
                IngestOutcome::Accepted,
                "must fail open for {raw:?}"
            );
            assert!(!called, "sink must stay silent for {raw:?}");
        }
    }

    /// 头名大小写不敏感（HTTP 语义），source 精确匹配（路由段小写白名单）。
    #[test]
    fn header_matching_is_case_insensitive_but_source_exact() {
        let raw = b"POST /hook/Pi HTTP/1.1\r\nX-Neeko-Agent-Hook-Token: tok-test\r\ncontent-length: 0\r\n\r\n";
        // 大写 source 不在白名单 → fail-open，且不进 sink。
        assert_eq!(
            ingest(raw, "tok-test", |_, _| panic!("must not deliver")),
            IngestOutcome::Accepted
        );
    }

    /// 超限 body → Accepted 静默（不解析、不投递）。
    #[test]
    fn oversized_body_fails_open() {
        let big = format!(
            r#"{{"agent_session_id":"a1","event":"turn_completed","detail":"{}"}}"#,
            "x".repeat(MAX_BODY_BYTES + 1)
        );
        let raw = request("pi", Some(TOKEN), &big);
        assert_eq!(
            ingest(&raw, TOKEN, |_, _| panic!("must not deliver")),
            IngestOutcome::Accepted
        );
    }

    /// 路由白名单来自事实表：表里的 source 全通，表外的一律 fail-open（不再有第二份清单）。
    #[test]
    fn route_whitelist_derives_from_hook_targets() {
        for target in HOOK_TARGETS {
            let raw = request(target.source, Some(TOKEN), &valid_body());
            let mut got = None;
            ingest(&raw, TOKEN, |source, _| got = Some(source.to_string()));
            assert_eq!(got.as_deref(), Some(target.source));
        }
        let raw = request("cursor", Some(TOKEN), &valid_body());
        assert_eq!(
            ingest(&raw, TOKEN, |_, _| panic!(
                "unknown source must not deliver"
            )),
            IngestOutcome::Accepted
        );
    }

    /// 在途名额：占满后拒绝且**不泄漏计数**（拒绝路径必须归还 fetch_add），释放后可再占。
    #[test]
    fn inflight_guard_reserves_and_returns_slots() {
        let counter = AtomicUsize::new(0);
        let limit = 3;
        let held: Vec<_> = (0..limit)
            .map(|_| InflightGuard::acquire(&counter, limit).expect("slot"))
            .collect();
        assert_eq!(counter.load(Ordering::Relaxed), limit);
        assert!(InflightGuard::acquire(&counter, limit).is_none());
        assert_eq!(
            counter.load(Ordering::Relaxed),
            limit,
            "rejected acquire must not leak the counter"
        );
        drop(held);
        assert_eq!(counter.load(Ordering::Relaxed), 0);
        assert!(InflightGuard::acquire(&counter, limit).is_some());
    }
}
