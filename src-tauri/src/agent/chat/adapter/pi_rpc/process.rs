//! Pi rpc 进程层：spawn、NDJSON 行读写、请求/响应配对。
//!
//! # 三条通道
//!
//! ```text
//! ① 命令（我们 → pi）   {"type":"prompt","id":"<uuid>","message":"…"}
//! ② 响应（pi → 我们）   {"type":"response","id":"<uuid>","success":bool,"data":…}
//! ③ 事件（pi → 我们）   无 id 的其它 JSON
//! ```
//!
//! 判别只看两条：`type == "response"` **且** 有 `id` → 响应；否则 → 事件。
//! 响应按 id 配对后**不进事件流** —— 混进去会让前端把 `get_state` 的回包
//! 当成一条对话事件渲染出来。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::common::error::AppError;
use crate::common::executor::factory::ExecTarget;
use crate::core::exec;

/// 辅助命令（`get_state` 之类）的默认超时。
///
/// `prompt` 不用这个 —— 它等到 `agent_settled`，可能几分钟。
const AUX_TIMEOUT: Duration = Duration::from_secs(5);

/// 一条已建立的 pi rpc 连接。
pub struct PiRpcProcess {
    /// 写通道：命令序列化后逐行写入。
    stdin: Arc<Mutex<crate::common::executor::BoxAsyncWrite>>,
    /// 响应等待者：id → 一次性发送端。
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    /// 事件出口（**一次取走**）。
    ///
    /// 不留在本结构里长期持有：`PiRpcProcess` 是 `Arc` 共享给请求 pump 的（它需要
    /// `&self` 发命令），但事件流的是**单消费者**语义（只有 `AgentSession::next` 读）。
    /// 把单消费者资源放在多所有者容器里，就必然要用锁跨 `await` 或依赖「调用方
    /// 恰好不并发」的隐式约定 —— 两者都是把正确性寄望于外部。
    ///
    /// 所以连接只做「交出一次」：[`Self::take_events`]，之后由 `PiSession` 独占。
    events: std::sync::Mutex<Option<mpsc::Receiver<Value>>>,
    /// 强制终止（`KillFn` 本身可重复调用；这里仍加一个布尔避免重复投递）。
    killed: std::sync::atomic::AtomicBool,
    kill_fn: crate::common::executor::KillFn,
}

impl PiRpcProcess {
    /// Spawn `pi --mode rpc --no-themes` 并开始读循环。
    ///
    /// `extra` 是用户在 agent 配置里写的 `args`（如 `--provider foo`），原样透传 ——
    /// 忽略等于用户的配置静默不生效，与 `AcpAdapter` / `DeepSeekHarnessAdapter` 一致。
    ///
    /// # 顺序：适配器参数放**最后**
    ///
    /// pi 解析重复选项是**后写者胜**（实测：`--mode json --mode rpc` → rpc；
    /// `--mode rpc --mode json` → json）。用户在启动参数里写 `--mode json`
    /// 就会把整条通道从 rpc 切成 json，协议层直接失效且没有任何报错。
    /// 所以我们自己的 `--mode rpc` 必须压在用户参数**之后**。
    ///
    /// 其余参数不受影响（pi 的 `[options]` 之间不敏感），用户照常能传
    /// `--provider` 之类。
    ///
    /// `--no-themes`：rpc 模式拿不到主题，加载它只是拖慢启动。
    pub async fn spawn(
        command: &str,
        cwd: &str,
        extra: &[&str],
        env: &[(&str, &str)],
    ) -> Result<Self, AppError> {
        let args = launch_args(extra);
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

        let child = exec::spawn(
            &ExecTarget::Local,
            command,
            &arg_refs,
            exec::SpawnSpec::new()
                .with_cwd(Some(cwd))
                .with_env(env)
                .kill_tree(),
        )
        .await
        .map_err(|e| {
            // ENOENT 时给可操作的提示，而不是让后面某次写 stdin 报 EPIPE。
            AppError::Io(format!(
                "failed to start `{command} --mode rpc`: {e}. \
                 Is pi installed and on PATH? (npm i -g @earendil-works/pi-coding-agent)"
            ))
        })?;

        let mut child = child;
        let (stdin, stdout, _stderr) = child.take_stdio();
        let stdin = stdin.ok_or_else(|| AppError::Io("pi rpc: no stdin".into()))?;
        let stdout = stdout.ok_or_else(|| AppError::Io("pi rpc: no stdout".into()))?;

        // `into_wait_and_kill` 给出**可重复调用**的 kill 句柄。wait 必须有归属，
        // 否则进程退出后无人 reap（僵尸）。这里后台驱动它即可 —— 退出码对
        // NDJSON 协议没有用处，stdout 关闭已经是「进程没了」的信号。
        let (wait, kill_fn) = child.into_wait_and_kill();
        tokio::spawn(async move {
            let _ = wait.await;
        });

        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (event_tx, events) = mpsc::channel(256);

        spawn_reader(stdout, Arc::clone(&pending), event_tx);

        Ok(Self {
            stdin: Arc::new(Mutex::new(stdin)),
            pending,
            events: std::sync::Mutex::new(Some(events)),
            killed: std::sync::atomic::AtomicBool::new(false),
            kill_fn,
        })
    }

    /// 测试夹具：用现成的流构造连接，不起真进程。
    ///
    /// `stdout` 是被读取的一侧（模拟 pi 的输出），返回的 `PiRpcProcess`
    /// 事件来源就是它。`stdin` 侧用 `sink()` 丢弃写入 —— 测试不关心发出的命令。
    #[cfg(test)]
    pub fn from_split(stdout: tokio::io::DuplexStream, stdin: tokio::io::DuplexStream) -> Self {
        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (event_tx, events) = mpsc::channel(64);
        spawn_reader(Box::pin(stdout), Arc::clone(&pending), event_tx);
        Self {
            stdin: Arc::new(Mutex::new(
                Box::pin(stdin) as crate::common::executor::BoxAsyncWrite
            )),
            pending,
            events: std::sync::Mutex::new(Some(events)),
            killed: std::sync::atomic::AtomicBool::new(false),
            kill_fn: Arc::new(|| Box::pin(async { Ok(()) }) as crate::common::executor::KillFuture),
        }
    }

    /// 取走事件流的所有权（**只能成功一次**）。
    ///
    /// 调用方（`PiSession`）之后用 `&mut` 独占消费，因此 `next()` 不需要任何锁。
    /// 第二次调用返回 `None` —— 那意味着有人在重复取同一个流，属编程错误。
    pub fn take_events(&self) -> Option<mpsc::Receiver<Value>> {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }

    /// 发一条命令并等它的响应。
    ///
    /// 超时后会把 id 从 pending 表移除 —— 否则迟到的响应会二次 settle
    ///（`oneshot::Sender` 已 drop，`send` 静默失败，但表项会一直堆积）。
    pub async fn request(
        &self,
        mut cmd: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, AppError> {
        let id = uuid::Uuid::new_v4().to_string();
        if let Some(obj) = cmd.as_object_mut() {
            obj.insert("id".into(), json!(id));
        }
        let line = format!("{cmd}\n");

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        {
            use tokio::io::AsyncWriteExt;
            let mut stdin = self.stdin.lock().await;
            stdin
                .write_all(line.as_bytes())
                .await
                .map_err(|e| AppError::Io(format!("pi rpc write: {e}")))?;
            stdin
                .flush()
                .await
                .map_err(|e| AppError::Io(format!("pi rpc flush: {e}")))?;
        }

        let wait = async move {
            rx.await
                .map_err(|_| AppError::Agent("pi rpc: response channel closed".into()))
        };

        let timeout = timeout.unwrap_or(AUX_TIMEOUT);
        match tokio::time::timeout(timeout, wait).await {
            Ok(Ok(resp)) => Self::unwrap_response(resp),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(AppError::Agent(format!(
                    "pi rpc command timed out after {timeout:?}"
                )))
            }
        }
    }

    /// 发一条命令但**不等响应**（`prompt` 用：完成由 `agent_settled` 决定）。
    ///
    /// `id` 只在**缺省时**补 —— `extension_ui_response` 必须回携带 pi 自己发的
    /// 请求 id（`extension_ui_request.id`），那个值由协议规定，不是我们的 uuid。
    /// 无条件覆盖会让 pi 收到一个它不认识 id 的响应，审批永远无法完成
    ///（工具卡在等回答上，表现为「点了允许没反应」）。
    pub async fn send(&self, mut cmd: Value) -> Result<(), AppError> {
        if let Some(obj) = cmd.as_object_mut() {
            obj.entry("id")
                .or_insert_with(|| json!(uuid::Uuid::new_v4().to_string()));
        }
        use tokio::io::AsyncWriteExt;
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(format!("{cmd}\n").as_bytes())
            .await
            .map_err(|e| AppError::Io(format!("pi rpc write: {e}")))?;
        stdin
            .flush()
            .await
            .map_err(|e| AppError::Io(format!("pi rpc flush: {e}")))
    }

    /// pi 把失败放在 `success: false` + `error` 里，不是 JSON-RPC error。
    fn unwrap_response(resp: Value) -> Result<Value, AppError> {
        let ok = resp
            .get("success")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if ok {
            return Ok(resp.get("data").cloned().unwrap_or(Value::Null));
        }
        let err = resp
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        Err(AppError::Agent(format!("pi rpc command failed: {err}")))
    }

    /// 终止进程（幂等，不阻塞）。
    pub fn dispose(&self) {
        if self.killed.swap(true, std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        // kill 返回 future，必须 poll 才生效；丢到后台驱动，dispose 立刻返回。
        let fut = (self.kill_fn)();
        tokio::spawn(async move {
            let _ = fut.await;
        });
    }
}

/// 拼装 `pi` 的启动参数：用户参数在前，适配器契约在后。
///
/// 抽成纯函数是为了能直测顺序 —— `spawn` 要起真进程，在它内部拼装的话
/// 测试只能复制一遍逻辑，实现被改坏时测试仍绿（本项目踩过这个坑）。
#[must_use]
fn launch_args(user_args: &[&str]) -> Vec<String> {
    let mut args: Vec<String> = user_args.iter().map(|s| (*s).to_string()).collect();
    // 后写者胜：这两项必须在用户参数之后，见 `spawn` 的文档。
    args.extend([
        "--mode".to_string(),
        "rpc".to_string(),
        "--no-themes".to_string(),
    ]);
    args
}

/// 读循环：按行解析，响应进 pending，其余进事件通道。
fn spawn_reader(
    stdout: crate::common::executor::BoxAsyncRead,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    event_tx: mpsc::Sender<Value>,
) {
    tokio::spawn(async move {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stdout).lines();

        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                // 实测 pi 1.3.0 不产生非 JSON 行；容错到 warn 即可，不做单独收集
                //（为一条从不触发的路径写收集+展示链路是没有验证手段的死重量）。
                log::warn!(
                    "[pi-rpc] non-JSON stdout line: {}",
                    trimmed.chars().take(200).collect::<String>()
                );
                continue;
            };

            // 响应：有 id 且 type=="response" → 按 id 配对，**不进事件流**。
            if value.get("type").and_then(Value::as_str) == Some("response") {
                if let Some(id) = value.get("id").and_then(Value::as_str) {
                    if let Some(tx) = pending.lock().await.remove(id) {
                        let _ = tx.send(value);
                    }
                }
                continue;
            }

            if event_tx.send(value).await.is_err() {
                break; // 消费端已 drop
            }
        }
        log::debug!("[pi-rpc] stdout closed");
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// 读循环测试夹具：`(客户端写端, 事件接收端, pending 表)`。
    type Harness = (
        tokio::io::DuplexStream,
        mpsc::Receiver<Value>,
        Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    );

    /// **顺序护栏**：适配器参数必须排在用户参数之后。
    ///
    /// pi 对重复选项是后写者胜。用户在启动参数里写了 `--mode json` 时，
    /// 若 `--mode rpc` 排在它前面就会被覆盖 —— 通道切成 json，整个 rpc 协议
    /// 失效且没有任何报错（表现为「Pi 连上了但永远没有回复」）。
    ///
    /// 变异验证：把 `spawn` 里的顺序换回来 → 本用例红。
    #[test]
    fn adapter_flags_come_after_user_args() {
        let extra = ["--provider", "x", "--mode", "json"];
        let args = launch_args(&extra);

        let mode_positions: Vec<usize> = args
            .iter()
            .enumerate()
            .filter(|(_, a)| **a == "--mode")
            .map(|(i, _)| i)
            .collect();
        assert_eq!(mode_positions.len(), 2, "user + adapter each provide one");
        // 最后一个 --mode 必须是 rpc
        let last = *mode_positions.last().unwrap();
        assert_eq!(
            args[last + 1],
            "rpc",
            "adapter --mode must be the last one so it wins"
        );
    }

    /// 用户参数原样出现在前面，不被丢弃也不被改写。
    #[test]
    fn user_args_are_preserved_verbatim() {
        let args = launch_args(&["--provider", "foo", "--session", "abc"]);
        assert_eq!(
            &args[..4],
            &["--provider", "foo", "--session", "abc"],
            "user args must survive"
        );
    }

    /// 空用户参数 → 只有适配器契约。
    #[test]
    fn empty_user_args_yield_only_adapter_flags() {
        assert_eq!(launch_args(&[]), vec!["--mode", "rpc", "--no-themes"]);
    }

    /// 用 duplex 管道驱动读循环，不起真进程。
    fn make_harness() -> Harness {
        let (client, server) = tokio::io::duplex(64 * 1024);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel(64);
        spawn_reader(Box::pin(server), Arc::clone(&pending), tx);
        (client, rx, pending)
    }

    #[tokio::test]
    async fn response_is_routed_to_pending_and_not_broadcast() {
        let (mut pi_side, mut events, pending) = make_harness();
        let (resp_tx, resp_rx) = oneshot::channel();
        pending.lock().await.insert("abc".into(), resp_tx);

        {
            use tokio::io::AsyncWriteExt;
            pi_side
                .write_all(
                    br#"{"type":"response","id":"abc","success":true,"data":{"ok":1}}
"#,
                )
                .await
                .unwrap();
        }

        let got = resp_rx.await.expect("response must be routed by id");
        assert_eq!(got["data"]["ok"], 1);
        assert!(
            events.try_recv().is_err(),
            "响应不得广播到事件流（否则前端会把回包渲染成对话事件）"
        );
    }

    #[tokio::test]
    async fn messages_without_id_are_broadcast_as_events() {
        let (mut pi_side, mut events, _pending) = make_harness();
        {
            use tokio::io::AsyncWriteExt;
            pi_side
                .write_all(
                    br#"{"type":"agent_start"}
"#,
                )
                .await
                .unwrap();
        }
        let ev = events.recv().await.expect("event");
        assert_eq!(ev["type"], "agent_start");
    }

    /// 非 JSON 行不能让读循环崩 —— 后续合法行还要能读到。
    #[tokio::test]
    async fn non_json_line_is_skipped_and_does_not_kill_the_loop() {
        let (mut pi_side, mut events, _pending) = make_harness();
        {
            use tokio::io::AsyncWriteExt;
            pi_side
                .write_all(b"Context: something human readable\n")
                .await
                .unwrap();
            pi_side
                .write_all(
                    br#"{"type":"agent_start"}
"#,
                )
                .await
                .unwrap();
        }
        let ev = events.recv().await.expect("still alive");
        assert_eq!(ev["type"], "agent_start");
    }

    /// 迟到的响应不得二次 settle：表项已被超时移除，读循环只能丢弃。
    #[tokio::test]
    async fn late_response_after_removal_is_dropped() {
        let (mut pi_side, _events, pending) = make_harness();
        // 模拟「超时后已移除」
        let (tx, _rx) = oneshot::channel::<Value>();
        drop(_rx); // 接收端已走
        pending.lock().await.insert("late".into(), tx);

        {
            use tokio::io::AsyncWriteExt;
            pi_side
                .write_all(
                    br#"{"type":"response","id":"late","success":true}
"#,
                )
                .await
                .unwrap();
        }
        // 读到后应当移除表项且不 panic
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            pending.lock().await.is_empty(),
            "迟到响应处理后应从 pending 移除"
        );
    }

    /// 保证测试夹具本身没被误用（StdMutex 只在此处占位）。
    #[allow(dead_code)]
    fn _assert_types() {
        let _ = StdMutex::new(());
    }
}
