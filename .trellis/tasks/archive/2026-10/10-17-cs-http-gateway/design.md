# 设计：Neeko C/S 化 HTTP 服务端（首落点 hooks ingest）

> 对应 `prd.md` 的 A1-A8 / H1-H4 / AC1-AC12。本文给出 Q4/Q5 的定案（§3.1/§3.2）、**传输职责归属表**（§4.4，原 Q6「双检冗余」已随内核重写消失），以及 AC12 要求的 wire 等价性对照表（§6）。分层洋葱序与失败策略承重的结构性前提见 §3.3/§2.2（评审 F-1 修正版）；阻塞投递隔离（H4）见 §3.4。
>
> ## ⚠️ 实施期符号漂移（读本文前先看）
>
> 本文是**设计期文档**，其中的符号名有 4 处与最终落地不符（架构裁决全部有效，只是名字变了）。
> 按名字去代码里搜会搜不到 —— 对应关系如下，实际落点以 `implement.md`「最终目录布局（实测）」为准：
>
> | 本文写的 | 实际落地 | 原因 |
> |---|---|---|
> | `ingest(source, body, sink)`（§3.4） | `ingest::validation::validate(source, body, sink)` | 「ingest」是域目录名不是模块名；该函数只做准入 |
> | `HookEnvelope`（§3.4/§4.4） | `ingest::event::HookEvent` | 「envelope」是传输术语；它是领域事件，不该带传输色彩 |
> | `deliver_signal`（§3.4/§4.4） | `dispatch::deliver_notification` + 公开入口 `dispatch::via_blocking_pool` | 「signal」与仓内 `NotificationSignal` 混淆；新名直说「投一条通知」 |
> | `ingest/server.rs` 原地重写（§1.1/§4.1） | `server.rs` **删除**，拆入 `ingest/` 下 8 个单职责文件 | 拆掉传输职责后 `server.rs` 只剩薄适配器；内核与适配器分属两个变化方向（详见 implement.md） |
>
> 「内核」一词在本文中指**准入语义**（白名单 → JSON → 会话身份），对应 `validation.rs`；
> 它不再是独立文件也不再叫 kernel（「kernel」是 OS 术语，不描述行为）。

## 1. 边界裁决

### 1.1 三层与归属

```
┌ L2 业务域（agent/hooks）─────────────────────────────────────────┐
│  ingest/server.rs   【文件名不変，内容原地重写】                    │
│    ① 内核（重写）：ingest(source, body, sink) —— 语义投影          │
│       hook_source()（白名单）+ is_usable + TOKEN_HEADER            │
│    ② deliver_signal()（保留，外圈投递）                            │
│    ③ route_group() → RouteGroup + ingest_hook（新：axum 适配器）   │
│    ✗ 删除：split_request / find_header / IngestOutcome            │
│       / InflightGuard / read_limited / spawn / serve_conn          │
│  ingest/attribution.rs · report.rs · endpoint.rs   （零改动）      │
└──────────────────────────────┬───────────────────────────────────┘
                               │ 只经 RouteGroup 值对象声明
┌ L1 网关引擎（src/server/）───┴───────────────────────────────────┐
│  engine.rs    bind · 分层 · 挂载路由组 · 优雅停机  【零业务分支】    │
│  gate.rs      统一鉴权门：CredentialExt trait + 恒定时间裁决         │
│  group.rs     RouteGroup / FailurePolicy 契约（值对象，无 IO）      │
└──────────────────────────────┬───────────────────────────────────┘
                               │ 挂到关闭协议
┌ L0 基础设施 ──────────────────┴───────────────────────────────────┐
│  common/runtime.rs（AppRuntime，Scheme C）                        │
│  common/shutdown.rs（cleanup 任务表机制）                          │
│  app_state.rs（组合根：HTTP 句柄槽位 + cleanup 任务表一行）          │
│  app/boot.rs（唯一注册点：把 hooks 路由组装进引擎）                  │
└──────────────────────────────────────────────────────────────────┘
```

**A8 的落点**：引擎住 `src-tauri/src/server/`（新顶层模块，与 `common/` `platform/` 同级的基础设施层）。**`ingest/server.rs` 文件名不变、内容原地改** —— 它从「内核 + 手搓传输壳」变成「内核 + axum 路由适配器」：

| 内容 | 处置 | 理由 |
|---|---|---|
| `spawn()` / `serve_conn()` / `read_limited()` / `head_complete()` / `find_header_len()` / `InflightGuard` / `static INFLIGHT` / `MAX_INFLIGHT_CONNECTIONS` | **删除** | 传输壳，已由引擎的 `ConcurrencyLimitLayer` + `axum::body::Bytes` 取代 |
| `split_request()` / `find_header()` / `MAX_HEADER_BYTES` / `MAX_BODY_BYTES` | **删除** | 手搓 HTTP 解析 —— 留着就是**第二份 HTTP 实现**（axum 已解析完毕）；`MAX_BODY_BYTES` 的值迁为引擎 `RequestBodyLimitLayer` 的参数 |
| `IngestOutcome` 枚举 | **删除** | 删掉 token 自检后 5 条出站路径全部是 204，枚举**失去所有变体**（编译器可证） |
| 内核 `ingest(raw, token, sink)` | **重写为 `ingest(source, body, sink)`** | 入参从「原始 HTTP 字节」变为「已路由 + 已鉴权的语义入参」（§3.4） |
| `TOKEN_HEADER` | **保留** | wire 契约常量，被 `templates/tests.rs` / `targets/tests.rs` 锚点测试消费 |
| `hook_source()`（source 白名单） | **保留并简化** | 入参从 `head` 字节改为 `source: &str`；`HOOK_TARGETS` 白名单与未知 source 的 warn 逻辑原样 |
| `deliver_signal()` | **保留（调用形态变）** | hook 域外圈，不属基础设施层；迁 axum 后经 `AppRuntime::spawn_blocking` 隔离调用（红线 3 / H4，§3.4）—— 内部同步锁不得跑在共享 runtime worker 上 |
| 既有 `#[cfg(test)] mod tests` | **重写** | 断言从 raw 字节改为语义入参；token/行长/超限四类用例删除（职责已转移，见 §7） |
| `route_group()` + `route_group_with()` | **新增** | 生产入口 + 测试缝（注入 deliver 闭包，AC2），把内核包成 `RouteGroup`（约 60 行） |

**不新建 `ingest/group.rs` / `ingest/kernel.rs` / `ingest/dispatch.rs`**：
- 不拆 `kernel.rs` —— 文件名按用户要求不变；且拆出去后 `server.rs` 会变成「无内核的空适配器」，反而更难找。
- 不拆 `group.rs` —— 路由适配器就住 `server.rs`，它和内核是同一件事的两半（「ingest 怎么接进来」）。
- 不拆 `dispatch.rs` —— `deliver_signal` 已 41 行，独立成文件收益不够，且它会与 `server.rs` 互相引用。

**核心立场（本条推翻了原 H1「内核零改动」）**：新增一份传输后，旧传输的每一行都必须在「被复用」与「被删除」之间二选一。留着手搓解析器 = 进程内存在**两份 HTTP 实现**，且那份是永不被调用的死代码 —— 它比多写代码更危险，因为它会诱导后来者以为「这条路径还在生效」。**故旧写法一律删除，能优化就优化，不做兼容层。**

文件规模估算：内核（重写后约 60 行）+ deliver 41 + 重写 tests 约 90 + 新适配器（两个构造器 + handler + 投递隔离闭包）约 60 ≈ **250 行**（现 512 行）。

### 1.2 依赖方向（可由护栏静态证明）

| 边 | 方向 | 证明手段 |
|---|---|---|
| `server/` → `agent/` | **禁止** | `server/**` 中零 `crate::agent::` 命中（§8 护栏） |
| `agent/hooks/ingest/server.rs` → `server/` | 允许 | 业务依赖基础设施（RouteGroup / FailurePolicy 契约） |
| `server/` → `tauri` | **禁止** | 引擎与门都不碰 Tauri；业务句柄由 `route_group()` 自己持有 |
| `notification/` → 任意业务域 | **禁止**（既有） | `check_notification_core_direction` 不回归 |

`server/` 不 import `tauri` 是刻意的：它让引擎可以在纯 `tokio` 测试里被驱动（§7 测试策略），这也是 `check_service_no_delivery_dep` 的同一思路（服务层只依赖端口）。

## 2. 数据流

### 2.1 hooks 请求（生产路径）

```
shim POST 127.0.0.1:{port}/hook/{source}
   │  header: x-neeko-agent-hook-token
   ▼
engine 全局层（外→内）: access_log → gate（403）→ concurrency（503）
   │  通过后进入组；未鉴权请求不占并发槽位（§3.3 顺序理由 2）
   ▼
hooks 组内层（外→内）: normalize(FailOpen) → catch-panic（500）→ timeout（408）→ body-limit（413）
   │  三层产出的 4xx/5xx 出站必经 normalize → 204（§2.2 承重的结构性前提）
   ▼
hooks group handler: axum 已解析出 path 参数 `source` 与 body `Bytes`
   │
   ▼
ingest(source, &body, |s, env| (state.deliver)(s, env))
   │         ↑ 内核只做语义投影（白名单 → JSON → is_usable → sink）
   ▼
                              → 204（fail-open：所有语义不合法的输入都静默；不含锁等待）
   │
   ▼（fire-and-forget，已在阻塞池）
runtime.spawn_blocking → deliver_signal → attribute() → project() → NotificationCenter::observe()
```

### 2.2 失败策略实际承重的三个路径

这是 `FailurePolicy` 不是装饰的证明（PRD Q4）：

| 框架级异常 | 层实际产出（实测语义） | hooks 组（FailOpen） | 依据 |
|---|---|---|---|
| handler panic | 500（`tower_http::catch_panic::CatchPanicLayer`） | **204** | B1：装作没发生过，绝不让 CLI 侧看到故障 |
| 请求超时 | **408**（`TimeoutLayer::with_status_code(REQUEST_TIMEOUT, …)`；`new()` 自 0.6.7 deprecated，`-D warnings` 会红） | **204** | 同上 |
| body 超限 | 413（`tower_http::limit::RequestBodyLimitLayer`） | **204** | 旧实现截断后由内核判 Accepted —— 见 §6 第 4 行 |
| 并发超限 | **503**（自写 `concurrency_limit(Arc<Semaphore>)` 中间件（tower-http **无**同名层，实测） 立即拒绝。**注意 `tower::limit::ConcurrencyLimitLayer` 同名层是排队语义，禁用**，见 §5） | 503（组外，不经归一化） | shim 对一切响应 `catch{}` 忽略 status → 客户端等价（§6 第 8 行） |

实现形态：`FailurePolicy::fallback_status(self) -> StatusCode`，由归一化层（§3.5）在响应出站时映射一次。**该函数是策略的唯一消费点**：删掉它，前三条路径全部退化为 4xx/5xx；保留它，B1 才成立。这就是「真承重」的判据。

> **2026-10-17 复审修正 —— 归一化范围是契约，不是「所有 4xx/5xx」**：只匹配上表前三行的产出码
> （500 / 408 / 413，经 `engine::framework_status` 常量与层装配共用同一事实源）。
> 路由层自产的 404（未知路径）/ 405（方法不符）**不被归一化**，原样透出。
> 理由有三：①「请求没打对」不是「我们失败了」，都吞成 204 会让客户端打错地址与内部 panic
> 在 wire 上不可区分；② 与「门在归一化之外、错 token 必须见 403」自相矛盾（同属「请求没打对」）；
> ③ 实测假绿事故：判据过宽时，三条 panic/timeout/未鉴权用例因 POST 打 GET 路由恒 405 被吞成
> 204，**从未真正执行到 handler 却一直通过**。详见 spec `agent-hooks-domain.md`「Tests Required」段。

**结构性前提（评审 F-1 修正）**：panic / 超时 / body 超限三层必须由引擎装在**组内**、归一化层**内侧**（洋葱见 §3.3）—— tower 中间件只能改写来自内层的响应，装在全局外层的层自产的 5xx/413 不会经过组内归一化，上表前三行会全部落空。并发上限在**组外**（进程级资源底线，所有组共享），其 503 不被策略改写，作为已记录偏差处理（§6 第 8 行）。

## 3. 契约（签名）

### 3.1 `server/group.rs` —— 路由组契约

```rust
/// 失败策略：由该路由组调用方的物理约束决定，编译期常量（Copy，零运行时分支）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailurePolicy {
    /// 调用方不能被错误信号干扰（hooks：CLI 子进程，800ms 预算，B1）。
    /// 框架级异常（panic / 超时 / body 超限）一律归一化为 204。
    FailOpen,
    /// 调用方必须收到真实错误（未来的交互式客户端，B3）。
    FailClosed,
}

impl FailurePolicy {
    /// 兜底状态码 —— 策略的**唯一**消费点（§2.2）。
    #[must_use]
    pub const fn fallback_status(self) -> StatusCode {
        match self {
            Self::FailOpen => StatusCode::NO_CONTENT,
            Self::FailClosed => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

/// 一个路由组 = 一组路由 + 该组自己的失败策略。
pub struct RouteGroup {
    /// 稳定的组名（日志/测试用，不参与路由）。
    pub name: &'static str,
    /// 该组的失败策略（§2.2）。
    pub policy: FailurePolicy,
    /// 已配好自身 State 的路由表。
    pub router: Router,
}
```

**为什么是值对象而不是 trait**：`RouteGroup` 的全部成员都是数据，没有任何行为需要多态；引擎只做「遍历 + mount + 套层」。改成 `trait RouteGroup` 会引入 `dyn` 与对象安全税，换不来任何扩展性 —— 新增组仍然是「加一个文件 + 一行注册」，两者的扩展成本相同，而 trait 版本多一份间接。**策略是枚举而非 trait**同理：策略集合已知且固定（fail-open / fail-closed 覆盖了全部物理约束形态），`Enum + match` 让新变体强制被处理（开闭原则的编译期形态）。

### 3.2 `server/gate.rs` —— 统一鉴权门（PRD Q5）

```rust
/// 凭证提取器：**只负责「从传输里取出候选凭证」**，不负责比较。
///
/// 新增凭证形状（Bearer scheme / cookie / query）＝新增一个 impl 并 push 进引擎的
/// 凭证列表；鉴权门的策略与代码零改动（A4）。
pub trait CredentialExt: Send + Sync {
    /// 从请求头取出候选凭证；`None` = 本请求没带这种凭证。
    fn extract<'a>(&self, headers: &'a HeaderMap) -> Option<&'a [u8]>;
}

/// 当前唯一 impl：header token（契约与 shim / endpoint 文件同源）。
pub struct HeaderToken {
    /// header 名（hooks = `x-neeko-agent-hook-token`，常量来自内核模块）。
    pub name: &'static str,
}

impl CredentialExt for HeaderToken { /* headers.get(self.name).map(|v| v.as_bytes()) */ }

/// 统一鉴权门：进程内唯一的能力裁决点（AC7）。
pub struct AuthGate {
    /// 本实例签发的能力（token）。
    expected: String,
    /// 全部可接受的凭证形状（OR 语义：任一命中即通过）。
    credentials: Vec<Arc<dyn CredentialExt>>,
}

impl AuthGate {
    /// 裁决：任一凭证提取成功且恒定时间匹配即通过。
    /// **没有"本组免鉴权"参数** —— 门对每个路由组强制生效（A4）。
    #[must_use]
    pub fn authorize(&self, headers: &HeaderMap) -> bool { /* §3.3 */ }
}

/// 恒定时间比较（AC7 的唯一实现；`subtle` 已在依赖树 2.6.1）。
fn ct_eq(a: &[u8], b: &[u8]) -> bool { /* subtle::ConstantTimeEq */ }
```

**「单一比较点」怎么保证**：`AuthGate::authorize` 是唯一调用 `ct_eq` 的地方；`CredentialExt` 的实现体**不返回布尔**（只返回候选字节），所以在结构上无法各自实现比较逻辑 —— 这比「约定不要重复写比较」强得多。

**门的零 panic 是结构性要求**：门以 `middleware::from_fn_with_state` 装在全局（§3.3），位于所有组内 `CatchPanicLayer` 的**外面** —— 门自身 panic 不会被任何兜底层接住，hyper 直接掐断连接（hooks 组漏出非 204）。因此 `authorize` 与全部 `CredentialExt::extract` 对任意畸形头（非 ASCII 值 / 超长 / 重复头名）必须零 panic，并由门的单测钉住（§7）。门逻辑只有「取 header + 恒定时间比较」，无索引 / 无锁 / 无分配失败路径，零 panic 可达成。

### 3.3 `server/engine.rs` —— 引擎

```rust
/// 引擎启动入参：全部是「具体事实」，引擎内部零全局状态。
pub struct ServerConfig {
    /// 调用方 bind 好的监听器（只有它知道该绑到哪 —— 红线 8）。
    /// 调用方 bind 后自行读 `local_addr()` 取实得端口（供坐标发布）；`serve()` 从
    /// **同一 listener** 再读一次存入 handle —— 同源事实，不设 `port` 入参字段，
    /// 杜绝「传入 port ≠ 实绑 port」的双事实源（坐标发布错端口 → shim 连不上且无日志可查）。
    pub listener: std::net::TcpListener,
    /// 并发在途上限（旧 MAX_INFLIGHT_CONNECTIONS 语义；进程级、所有组共享）。
    pub max_inflight: usize,
    /// 逐请求超时（TimeoutLayer 实际产出 408，经组内策略归一化，§2.2）。
    pub request_timeout: Duration,
    /// 单请求 body 上限（旧 MAX_BODY_BYTES=64KB 迁来；413 经组内策略归一化）。
    /// 全局单值：当前唯一消费者是 hooks 组。未来若需组级上限，把字段下沉 `RouteGroup`
    /// （值对象加一个字段、引擎零改动），现在不预留（YAGNI，§5）。
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
    /// 触发优雅停机并等待收尾（有界等待 ≤200ms，超时只记日志，绝不阻塞退出）。
    ///
    /// **线程契约**：内部经 `common::runtime::block_on_shutdown` 等待 serve task 收敛，
    /// 只可在**非 runtime 线程**调用（关闭协议的清理线程即此形态，`runtime.rs:119` 契约）。
    /// 测试在 `#[tokio::test]` 里直接调会 panic —— 必须经
    /// `std::thread::spawn(move || handle.stop()).join()`（§7 / implement S1.7）。
    pub fn stop(&mut self);
    /// 实际监听端口（测试与日志断言用）。
    #[must_use] pub const fn port(&self) -> u16;
}

/// 组装并启动引擎。返回 handle 供关闭协议挂载。
pub fn serve(
    runtime: &AppRuntime,
    config: ServerConfig,
    gate: Arc<AuthGate>,
    groups: Vec<RouteGroup>,
) -> std::io::Result<ServerHandle>;
```

**分层顺序（洋葱皮，外 → 内；评审 F-1 修正版）**：

axum 的 `.layer()` 语义是**后加者在外**。必须被失败策略改写的三层（CatchPanic / Timeout / RequestBodyLimit）由引擎的 `mount_all` 装在**每组之内**、归一化层**内侧** —— tower 中间件只能改写来自内层的响应；若装在全局外层，它们自产的 5xx/413 不经过组内归一化，§2.2 的三条承重路径全部落空。

```rust
// 组内（mount_all 对每个 RouteGroup 执行；由内到外列出）：
let g = group.router
    .layer(RequestBodyLimitLayer::max(config.max_body_bytes))  // 413
    .layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, config.request_timeout)) // 408
    .layer(CatchPanicLayer::custom(panic_response))            // 500
    .layer(normalize(group.policy));                           // ← 策略唯一消费点（组内最外）

// 全局（引擎；由内到外列出，后加 = 更外）：
let app = Router::new()
    .merge(mount_all(groups, &config))
    .layer(concurrency_limit(Arc::clone(&semaphore)))                          // 503（自写；tower-http 无此层）
    .layer(middleware::from_fn_with_state(gate, auth_gate_mw))                 // 403
    .layer(middleware::from_fn(access_log));                                   // 每请求一行 log
```

顺序理由（每条对应一个被否决的错放）：
1. `access_log` 最外 → 403/503/超时/panic 全都有访问日志（旧实现只有 `log::debug` 连接级）。**不用 `tower_http::TraceLayer`**：它发 `tracing` 事件，而全仓日志是 `log` crate（`common/logger.rs`）、无 tracing-subscriber —— TraceLayer 在生产是静默 no-op。自写 ~20 行 `from_fn` 中间件打 `log::info!`（method / path / status / 耗时），与全仓日志栈同源（§5）。
2. `gate` 在 `ConcurrencyLimit` 之**外** → 未鉴权请求在门处即被 403 拒绝、**不占并发槽位**。否则同机任意进程用 16 个慢速无 token 请求即可占满槽位、令合法 hooks 全部 503（评审追问 5 的 DoS 面，由此消解）。403 同时在组归一化之外 → 不被 FailOpen 改写（H2：错 token 必须见 403）。
3. `ConcurrencyLimit` 在组外 → 进程级资源底线（旧 `static INFLIGHT` 语义），所有组共享而非每组各 16。其 503 不经组内归一化，记 §6 第 8 行偏差（shim 忽略 status → 客户端等价）。**必须用 自写 `concurrency_limit(Arc<Semaphore>)` 中间件（tower-http **无**同名层，实测）（立即 503）；`tower::limit::ConcurrencyLimitLayer` 是排队语义（不拒绝、堆积到被超时收割），同名反义，禁混用**（§5）。
4. `normalize(policy)` 组内最外 → CatchPanic / Timeout / BodyLimit 三层产出的 500/408/413 出站**必经**它，§2.2 的三条承重路径由此成立。
5. `CatchPanic` 在 `Timeout` 内侧（组内） → panic 不会被超时层掩盖成 408。

**bind 与 std→tokio 桥接**（PRD Technical Notes）：

```rust
config.listener.set_nonblocking(true)?;
let listener = tokio::net::TcpListener::from_std(config.listener)?;   // 失败 = 调用方拿到 io::Error
let (tx, rx) = oneshot::channel();
let join = runtime.spawn(async move {
    let _ = axum::serve(listener, app)
        .with_graceful_shutdown(async { let _ = rx.await; })
        .await;
});
```

**不裸调 `tokio::spawn`**：serve 任务经 `AppRuntime::spawn`（Scheme C，A7）。`ServerHandle::stop` 在关闭协议的**清理线程**（非 runtime 线程）里被调用，等待收尾走 `common::runtime::block_on_shutdown`（该函数的既有契约即「退出清理线程专用」，`runtime.rs:119`）。**测试同样受此契约约束**：`stop()` 单测不得在 `#[tokio::test]` 内直接调用（`block_on` 会 panic），必须经 `std::thread::spawn(move || handle.stop()).join()`（§7 / implement S1.7）。

### 3.4 hooks 路由适配器 + 重写后的内核（原地在 `ingest/server.rs`）

```rust
// ── 内核（重写：入参从 raw HTTP 字节 → 语义入参）─────────────────────────
/// 已路由、已鉴权的上报 → 裁决。`sink` 收到 source 合法、JSON 合法、会话身份非空的上报。
///
/// 返回 unit：**所有**语义不合法路径都是 fail-open（静默 204），没有第二个出站状态。
pub fn ingest(source: &str, body: &[u8], mut sink: impl FnMut(&str, HookEnvelope)) {
    let Some(source) = hook_source(source) else {
        return; // 白名单外：静默（内核 log::warn 保留）
    };
    let Ok(envelope) = serde_json::from_slice::<HookEnvelope>(body) else {
        return; // 非法 JSON：静默
    };
    if envelope.is_usable() {
        sink(source, envelope);
    }
}

/// `/hook/{source}` → 白名单内的 `&'static str`。未知 source 记 warn（2026-10-16 事故的可观测性修补）。
fn hook_source(source: &str) -> Option<&'static str>;

// ── 路由适配器（新增）────────────────────────────────────────────────
#[derive(Clone)]
struct HookRouteState {
    /// 投递闭包（生产 = `deliver_signal` 经 `spawn_blocking` 隔离；测试 = sink 记录）。
    /// handler **永远**只调这个闭包 —— 隔离策略由构造器注入，handler 零分支。
    /// token 不进路由组：校验唯一位置是门，`HeaderToken` 由 boot.rs 建门时注入（§4.4）。
    deliver: Arc<dyn Fn(&str, HookEnvelope) + Send + Sync>,
}

/// 生产入口：构造 hooks 路由组（该组自己声明 fail-open）。
/// 投递闭包 = `move |source, env| runtime.spawn_blocking(move || deliver_signal(&app, …))`
/// （fire-and-forget，红线 3 / H4，见下方 blockquote）。
#[must_use]
pub fn route_group(app: AppHandle, runtime: Arc<AppRuntime>) -> crate::server::RouteGroup;

/// **测试缝（AC2）**：注入投递闭包，引擎 / 门 / 策略 / handler 与生产入口完全同源。
/// 集成测试（`tests/unit/`，独立 crate）无 `tauri::test` feature、构造不出 `AppHandle` ——
/// 用本入口 + `Arc<Mutex<Vec<…>>>` sink 记录「投递/不投递」，走真引擎真 socket。
/// 必须 `pub`（独立 crate 对 `pub(crate)` 不可见）；`deliver_signal` 本体不由集成测试覆盖
/// （与 `notification/center.rs:108` 既有口径一致：dispatch 单测 + 真机验证）。
#[must_use]
pub fn route_group_with(
    deliver: impl Fn(&str, HookEnvelope) + Send + Sync + 'static,
) -> crate::server::RouteGroup;

/// `POST /hook/{source}` —— wire 契约见 §6。
async fn ingest_hook(
    State(state): State<HookRouteState>,
    Path(source): Path<String>,
    body: Bytes,
) -> Response;
```

handler 只做三件事（零业务判断）：

1. `Path<String>` 取 source、`Bytes` 取 body（都由 axum 完成解析，含 body 上限）；
2. 调 `ingest(&source, &body, |s, env| (state.deliver)(s, env))` —— 生产闭包内部经 `runtime.spawn_blocking` 把 `deliver_signal` 抛进阻塞池（fire-and-forget）；
3. 返回 204。**没有 403 分支** —— token 校验的唯一位置是鉴权门（§4.4）。

> **为什么投递必须经 `spawn_blocking`（红线 3 / H4，评审 F-2 修正）**：`deliver_signal` 同步持两把 std `Mutex`（`project_manager` —— 全仓 14+ 处 UI 命令竞争同锁；`notification.policy`）。旧实现每连接一个**专用 OS 线程**（`server.rs:219-226`），阻塞锁无害；迁到 axum 后 handler 跑在 **Tauri 共享 tokio runtime 的 worker** 上 —— 同步持锁会占住 worker，多 Agent 并发（16 在途 hook + 用户同时刷项目列表）可打满 worker，令**前端 Tauri Command（IPC）与 LSP/终端异步任务一起停摆**。fire-and-forget 后 204 不再含锁等待、响应恒微秒级，B1 的 800ms 预算压力归零；fail-open 语义不变（204 从不依赖投递结果）。隔离策略由 `route_group` 的生产闭包注入，handler 与测试路径完全同源。

> **为什么 handler 里没有 403**：拒绝发生在**鉴权门**（引擎层，进入 handler 前）。handler 若能返回 403，就等于允许「某些路由组绕过门、在业务里自行 403」，那正是 A4 要禁止的形态。门的拒绝路径由引擎统一产出。

> **为什么不再手工做有界读取**：旧 `read_limited` 是为在无 HTTP 框架时自保。换成 axum 后 `RequestBodyLimitLayer` 在同一位置做同一件事，而 `Bytes` 已是完整帧后的内存视图。手写第二份限流器就成了「两个地方各自定义体上限」。

### 3.5 失败策略归一化层

```rust
/// 把框架级异常响应改写为该组策略允许的状态码（§2.2 的唯一消费点）。
///
/// 由引擎的 `mount_all` 装在**组内最外层**（CatchPanic / Timeout / BodyLimit 之外，§3.3）：
/// tower 中间件只能改写来自内层的响应 —— 这个位置是策略生效的结构性前提，不是风格偏好。
/// 门的 403 与全局 ConcurrencyLimit 的 503 在组**外**，不被改写（H2：错 token 必须见 403；
/// 503 见 §6 第 8 行）。
fn normalize(policy: FailurePolicy) -> NormalizeLayer;
```

实现形态：`tower::Layer` + `Service` 包装（`tower` 0.5 只提供这两个 trait，**不开 `limit` feature** —— 并发上限用 tower-http 版，§5），对 `response.status().is_client_error() || is_server_error()` 的响应替换为 `policy.fallback_status()`（丢弃原 body —— 失败路径的 body 本来就无信息量，且旧实现返回的就是空体）。**改写前必须 `log::warn!`（含组名与原状态码）** —— 否则 B1 的代价是「看不见的故障」（§9）。

## 4. 迁移策略

### 4.1 步骤（每步可独立回归）

| 步 | 内容 | 回归判据 |
|---|---|---|
| S1 | 新增 `server/{mod,group,gate,engine}.rs` + `Cargo.toml` 新依赖（**纯增量**，不碰业务文件） | `cargo test server::` 全绿（引擎/门/策略单测，纯 tokio，无 Tauri）+ `cargo tree -d` 无双版本 |
| S2 | `ingest/server.rs` **原地改**：删除传输壳（`spawn`/`serve_conn`/`read_limited`/`head_complete`/`find_header_len`/`InflightGuard`/`INFLIGHT`/`MAX_INFLIGHT_CONNECTIONS`/`split_request`/`find_header`/`IngestOutcome`），内核收敛为语义投影 + 单测重写（§7 对照表），新增 `route_group`/`route_group_with`/`ingest_hook`；`deliver_signal` 逻辑保留但**调用形态改为经 `spawn_blocking` 隔离**（H4）；同 commit 完成 `boot.rs`「bind → 建门 → 建组 → serve」接线与 AC2 集成测试（旧 `spawn` 已删，boot 不改则不可编译） | `cargo test ingest::` + `http_gateway` 全绿；`mod.rs` **零改动**；`git grep` 传输符号零命中（AC1） |
| S3 | `app_state.rs` 加句柄槽位 + cleanup 任务一行；`boot.rs` 存入句柄 | `ServerHandle::stop` 单测 + 人工验证（关窗后端口不再监听） |
| S4 | spec 补「HTTP 引擎拓扑」一节 + 新增 `check_server_no_business_dep` 护栏（§8） | `pnpm check:quick`（开发循环口径；全量 `pnpm check` 只留收尾一次） |

（与 implement.md 的 S1-S4 一一对应；S2 即 wire 切换点。）

**回滚点**：S1 与 S2 之间无外部契约变化（wire 未切换）；S2 是唯一切换点，回滚 = `git revert` 一个 commit。

### 4.2 端口与坐标发布的顺序（不能变）

旧实现的顺序是：bind :0 → 读实得端口 → `remove_legacy_endpoint` → `publish` → `prune_stale_endpoints` → 起 accept 循环。

新实现必须**保持同一顺序**，唯一区别是 serve 循环的启动时机在 publish 之后（否则 shim 可能读到坐标但端口还没开始 accept —— 旧实现同样有这个窗口，但窗口极小；新实现若把 serve 提前到 publish 之前会**缩小**窗口，是可接受的改进，但为降低迁移风险先保持原序，S3 之后可单独评估）。

### 4.3 `AppStateWrapper` 与非 Clone 约束（H3）

`AppStateWrapper` 非 `Clone`、体积大，强行 Arc 化会波及全线 `State<AppStateWrapper>` 命令签。故：
- **路由组状态里只放投递闭包**（`Arc<dyn Fn(&str, HookEnvelope)>`，§3.4）—— 生产闭包捕获 `AppHandle`（Clone，轻）与 `Arc<AppRuntime>`；
- `deliver_signal(&app, ...)` 内部照旧 `app.state::<AppStateWrapper>()` —— 这是既有边界（外圈唯一触碰业务状态处），不动；
- 鉴权门状态里只放 token 字符串 + 凭证形状列表。

结论：引擎与门的 `State` 完全不含业务类型 —— 这也是 §1.2 那条「`server/` 不 import `tauri`」能成立的原因。

### 4.4 传输职责的归属表（原 Q6「双检冗余」已消失）

原方案保留内核 token 自检（因 H1 要求「内核零改动」），于是必须论证「两处比较不算重复鉴权」。**该问题已被撤销**：删掉内核传输职责后，token 校验只剩鉴权门一处。

各行职责严格单向：

| 职责 | 归属 | 证据 |
|---|---|---|
| HTTP 报文解析（请求行 / 头 / Content-Length / 分帧） | **axum** | 内核不再有 `split_request` / `find_header`（AC1 的 `git grep`） |
| body 大小上限 | **引擎配置，组内装配**（`RequestBodyLimitLayer`，413 经策略归一） | 内核不再有 `MAX_BODY_BYTES` 判定 |
| 并发在途上限 | **引擎全局**（自写 `concurrency_limit(Arc<Semaphore>)` 中间件（tower-http **无**同名层，实测），503 立即拒绝） | 不再有 `InflightGuard` / `INFLIGHT` |
| 超时 | **引擎配置，组内装配**（`TimeoutLayer`，408 经策略归一） | 不再有读写超时设置 |
| panic 隔离 | **引擎配置，组内装配**（`CatchPanicLayer`，500 经策略归一） | 不再有「每连接一线程」的天然隔离 |
| **token 能力校验** | **鉴权门**（`server/gate.rs`，唯一） | `ct_eq` 调用点 = 1（AC7） |
| 拒绝的响应形态（403） | **鉴权门**（门产出，handler 无 403 分支） | §3.4 |
| source 白名单 | **内核**（`hook_source` + `HOOK_TARGETS`） | 业务知识：哪些 CLI 已接入 |
| JSON 结构解析 | **内核**（`HookEnvelope`） | 业务知识：上报协议形状 |
| 会话身份可用性 | **内核**（`is_usable`） | 业务知识：什么算一条有效上报 |
| 归属 / 投影 / 投递 | **`deliver_signal`** | hook 域外圈 |
| 阻塞投递隔离 | **handler 生产闭包**（经 `AppRuntime::spawn_blocking`，红线 3 / H4） | `deliver_signal` 含同步锁，不得跑在共享 runtime worker 上（§3.4） |
| 访问日志 | **引擎全局**（自写 `from_fn` 中间件，`log` crate） | 不用 `TraceLayer`：全仓无 tracing-subscriber，它是静默 no-op（§5） |

**判据（为什么这条边界是干净的）**：内核的入参是 `(&str source, &[u8] body)` —— 它**无法**表达「HTTP」，因此不可能重新长出传输职责。反过来，引擎的入参不含任何 hook 概念（`RouteGroup` 只认路由 + 策略），因此不可能长出业务分支。**边界由类型签名强制，不靠约定。**

## 5. 取舍记录（为什么不是别的形态）

| 决策 | 选择 | 被否的方案与原因 |
|---|---|---|
| 引擎状态 | 无状态函数 + 值对象入参 | 单例全局 `SERVER`：不可测、不可多实例、与既有 `boot` 风格冲突 |
| 路由组 | 值对象 + 组合根注册 | `trait RouteGroup` + 自注册：需要 `linkme`/`inventory` 或 `lazy_static`，复杂度换不来收益（§3.1） |
| 失败策略 | 编译期 enum | 运行时配置：策略由**物理约束**决定，不是用户偏好，配置化会让「hooks 组被误配成 fail-closed」成为可能 |
| 鉴权门 | 唯一实例 + 凭证 trait | 每组自带鉴权中间件：漏鉴权风险随组数增长（PRD 第一性原理） |
| 凭证形状 | `CredentialExt`（只提取） | `verify() -> bool`（各 impl 自己比较）：无法保证「单一比较点」，AC7 无法机器验证 |
| body 超限 | 引擎 `RequestBodyLimitLayer` + 策略归一化 | 内核自带判定：两处各自定义上限（violates DRY）；`DefaultBodyLimit` 不加归一化：hooks 组会漏出 413（§6 第 4 行） |
| 优雅停机 | oneshot + `with_graceful_shutdown` | 直接 `abort()` serve task：在途请求被硬切，且无法打点收尾耗时 |
| 停机等待 | `block_on_shutdown`（既有函数） | 在清理线程里 `Handle::block_on`：契约冲突（该函数注释明令禁止在 runtime 线程调用反向情形） |
| 访问日志 | 自写 `axum::middleware::from_fn` + `log::info!` | `tower_http::TraceLayer`：发 `tracing` 事件，全仓无 tracing-subscriber（`common/logger.rs` 是 `log` 栈）—— 生产静默 no-op，「被拒绝请求也有日志」不成立；引 tracing 桥 = 为一行日志新增依赖链 |
| 并发上限层 | 自写 `concurrency_limit(Arc<Semaphore>)` 中间件（tower-http **无**同名层，实测）（立即 503） | `tower::limit::ConcurrencyLimitLayer`（**同名**）：排队语义 —— 慢请求堆积到被超时收割，旧实现「超限立即断开」的保护语义丢失 |
| 策略归一化位置 | 组内最外（CatchPanic / Timeout / BodyLimit 之外） | 全局外层：外层自产 5xx/413 不经内层归一化，§2.2 三条承重路径物理上不可能发生（评审 F-1） |
| 投递形态 | handler fire-and-forget（`spawn_blocking`，由生产闭包注入） | handler 同步调 `deliver_signal`：同步锁跑在共享 runtime worker，违反红线 3，可拖停整个前端 IPC（评审 F-2） |
| 测试缝 | `route_group_with` 注入 deliver 闭包 | 给 tauri 加 `test` feature + `mock_builder`：污染生产依赖面；只断状态码不断投递：AC2 静默缩水（评审 F-3） |
| body 上限粒度 | 全局单值（`ServerConfig.max_body_bytes`，组内装配） | 组级字段：当前唯一消费者是 hooks，预留 = YAGNI；未来下沉 `RouteGroup` 即可，引擎零改动 |

## 6. wire 等价性对照表（AC12）

旧实现 = 手搓 `serve_conn` + 旧内核。新实现 = 引擎 + 鉴权门 + 路由适配器 + 重写内核。
**判据是「客户端可观测行为」**，不是「代码哪一行返回了什么」。

| # | 输入 | 旧实现 | 新实现 | 判定 | 论证 |
|---|---|---|---|---|---|
| 1 | 合法 token + 已知 source + 合法 JSON | 204，投递 1 次 | 204，投递 1 次 | **一致** | — |
| 2 | token 不符 / 缺 token | 403，空体 | 403，空体 | **一致** | 拒绝点从内核移到鉴权门；对外值不变 |
| 3 | 未知 source（`HOOK_TARGETS` 外） | 204 + `log::warn`，不投递 | 204 + `log::warn`，不投递 | **一致** | warn 仍在 `hook_source()` 内 |
| 4 | body > 64KB | 读满 cap 截断 → 内核判 Accepted → 204 | **413 → 策略归一 → 204** | **一致（客户端所见）** | axum 先拒，`FailurePolicy::FailOpen` 把 413 改写成 204 —— 这正是策略真承重的用途（§2.2）。shim 忽略 status，两者等价 |
| 5 | 非法 JSON / 缺必填字段 / 空 session_id | 204，不投递 | 204，不投递 | **一致** | 内核 `is_usable` + `serde` 解析仍在 |
| 6 | 完全不是 HTTP（裸 `garbage`） | 204（`split_request` 失败） | **400**（HTTP 解析器先失败） | **偏差** | ① 唯一客户端 `neeko-report.mjs` 只发 `fetch()` 生成的合法 HTTP；② shim 对一切响应 `catch{}` 忽略 status、恒 exit 0；③ 保留 204 需接管 TCP 层解析 = 放弃 axum（与 A2 冲突） |
| 7 | 请求头 > 8KB | 204 | **431** | **偏差** | 同第 6 行；真实 shim 头固定 2 个（`content-type` + token），合计 < 200B |
| 8 | 并发 > 上限 | 断开连接（无响应） | **503**（`tower_http` 版立即拒绝；在组归一化之外） | **偏差** | shim 对一切响应 `catch{}` 忽略 status、恒 exit 0 → 客户端等价；保留「无响应」需接管 TCP 层 = 放弃 axum |
| 9 | 超时 | 连接关闭，无响应 | **204**（`TimeoutLayer` 实际 408 + 组内归一化） | **偏差（改进）** | 旧实现客户端看到中断；新实现给显式 204，对 B1 更友好 |
| 10 | handler panic | 连接被 drop（无响应） | **204**（`CatchPanicLayer` + 归一化） | **偏差（改进）** | 旧实现静默吞掉整条连接线程；新实现可被观测 |
| 11 | `endpoints/*.env` 文件形状 | `KEY=value` 两行 | 同（`endpoint.rs` 零改动） | **一致** | — |
| 12 | 端口绑定 | `127.0.0.1:0` | 同（调用方 bind） | **一致** | 红线 8 |
| 13 | HTTP 版本 | 1.1 only | 1.1（+ h2c 需显式启用，本节按 1.1 断言） | **偏差（能力扩展）** | 不影响既有客户端 |

**结论**：13 行中 7 行一致（1/2/3/4/5/11/12）；6 行偏差（6/7/8/9/10/13）全部满足「唯一客户端不触发」+ shim 侧行为等价（对一切响应 `catch{}`、忽略 status、恒 `exit 0`），其中 9/10 为改进。
**注意第 4 行的性质变化**：旧实现是「截断后由内核判 Accepted」，新实现是「引擎 413 → 策略归一为 204」。客户端所见相同，但**这恰好是 `FailurePolicy` 真承重的证据** —— 若把 hooks 组改成 `FailClosed`，同一输入会返回 413 而非 204。

## 7. 测试策略

| 层 | 测什么 | 手段 |
|---|---|---|
| 内核（重写） | 白名单外不投递 / 非法 JSON 不投递 / 空 session_id 不投递 / 合法则投递恰好一次 / 返回值恒 unit（无第二出站态） | `#[cfg(test)]`，纯函数，入参 `(&str, &[u8])`，**无网络无 tokio** |
| 门（新） | 凭证提取 / 恒定时间匹配 / 多凭证 OR / 缺失凭证拒绝 / 空凭证列表恒拒 / **任意畸形头（非 ASCII 值、超长、重复头名）零 panic**（门在组内 CatchPanic 之外，零 panic 是结构性要求，§3.2） | 纯函数式构造 `HeaderMap` |
| 策略（新） | `fallback_status` 两变体 + 归一化层对 4xx/5xx 的改写（500/408/413→204；403/503 在组外不被改写） | 层单测（构造 `Response`） |
| 引擎（新） | bind loopback（AC3）/ 优雅停机（AC5，**`stop()` 经独立 OS 线程调用** —— `#[tokio::test]` 内 `block_on_shutdown` 会 panic）/ 并发上限（**503** 立即拒绝，组外不经归一化）/ **未鉴权请求不占槽位**（`max_inflight=1` 时 403 不影响后续合法请求）/ 超时（408→FailOpen **204** / FailClosed **500**）/ panic 兜底（500→同映射）/ body 超限（413→同映射）（AC4）/ access_log 冒烟（请求经过且状态正确；不断言日志内容，与既有口径一致） | `tokio::test` 真 socket；`AppRuntime::from_handle(Handle::current())` 注入 |
| 组可增量（AC6） | 测试用 RouteGroup：复用同一门、自带 `FailClosed`，断言与 hooks 组的行为差异 | 测试内构造，**不改引擎/门/内核一行** |
| wire 等价（AC2） | §6 表的 1-5 行，**状态码 + sink 投递记录双断言**；第 8 行 503 由引擎层测试钉住 | `tests/unit/http_gateway_test.rs`（F12 harness）：真引擎 + 真 socket + `route_group_with` 注入 sink（独立 crate 无 `tauri::test`，构造不出 `AppHandle`，§3.4） |

**内核测试的重写对照（旧 → 新）** —— 删除的不是覆盖，是**换了归属**：

| 旧用例 | 处置 | 等价保证现在在哪 |
|---|---|---|
| `accepted_delivers_envelope_to_sink` | **保留**（改为语义入参） | 内核单测 |
| `wrong_token_is_rejected` / `missing_token_is_rejected` | **删除** | 门单测 + AC2 集成测试 |
| `malformed_inputs_fail_open`（含 `garbage` 字节） | **拆分**：非法 JSON / 缺字段 / 空 session_id 保留；裸字节删除 | 内核单测（语义部分）+ §6 第 6 行（裸字节已知偏差） |
| `header_matching_is_case_insensitive_but_source_exact` | **删除** | 头名大小写由 HTTP 规范（axum）保证；source 精确匹配由 §3.4 的 `hook_source` 单测 |
| `oversized_body_fails_open` | **删除** | 引擎 `RequestBodyLimitLayer` + 策略归一化单测 + AC2 |
| `route_whitelist_derives_from_hook_targets` | **保留**（改为 `source: &str`） | 内核单测 |
| `unknown_source_is_accepted_but_not_delivered` | **保留** | 内核单测 |
| `inflight_guard_reserves_and_returns_slots` | **删除** | 引擎并发上限测试（AC4） |

**引擎与 wire 测试为何不需要 Tauri**：§1.2 的「`server/` 不 import `tauri`」使引擎可用纯 tokio 驱动；wire 集成测试经 `route_group_with`（注入 deliver 闭包）构造路由组，绕开 `AppHandle` —— `deliver_notification` 本体（含 `spawn_blocking` 接线）由 2026-10-17 真机验证（POST /hook/pi → 204 in 182µs → 系统通知送达，见 implement.md「需人工确认项」）与 dispatch 单测共同覆盖。

## 8. 护栏（可机器验证的不变量）

| 护栏 | 判据 | 落点 |
|---|---|---|
| `server/` 无业务 import | `src-tauri/src/server/**/*.rs` 中零 `crate::(agent\|git\|terminal\|...)` | 新增 `check_server_no_business_dep`（仿 `check_notification_core_direction`，业务模块清单复用同一元组来源） |
| `server/` 无 Tauri | 同上文件中零 `tauri::` / `AppHandle` | 同上护栏的第二条规则（剥字符串与注释后匹配） |
| 鉴权唯一 | `ct_eq` / `ConstantTimeEq` 调用点计数 = 1 | 人工 `git grep`（AC7），不做脚本（会比较脆弱） |

**为什么值得加这条护栏**：`server/` 是新的基础设施层，最容易发生的漂移是「某个业务顺手在引擎里加个 if」—— 那正是 A2 要禁止的。与 `check_notification_core_direction` 同构，成本低、判据显然正确。

## 9. 风险与未决

| 风险 | 影响 | 缓解 |
|---|---|---|
| axum 0.8 的 `Router` 泛型 State 与「多组各自 State」冲突 | 编译期卡住 | 每组 `Router::new().with_state(自己的S)` 后 `into::<Router<()>>()`；`RouteGroup.router` 类型为 `Router`（`Router<()>`） |
| `with_graceful_shutdown` 在 Tauri 退出时可能来不及收尾 | 在途 HTTP 请求被硬切；已 detach 的 `spawn_blocking` 投递闭包（fire-and-forget，§3.4）随 `process::exit` 被切 | `stop()` 内有界等待（≤200ms）+ 打点；超时只记 warn，绝不阻塞退出（既有 shutdown 原则）。投递丢失窗口极小且通知本就是 best-effort（F10：失败只降级 CLI 通知）—— 接受，不为此引入投递登记表 |
| 依赖面变化 | 构建时间 / 双版本 | `tower` 0.5.3 / `tower-http` 0.6.8 / `subtle` 2.6.1 **已在 lock**（传递依赖），转直接依赖不新增版本；**`axum` 是净新增**（lock 中无，将带入 `axum-core`/`matchit`/`http-body*` 等新 crate）—— S1 验证加 `cargo tree -d` 确认无双版本 |
| `AppHandle` 在生产投递闭包内克隆（每次投递一次） | 轻微开销 | `AppHandle` 本身 Clone 廉价（内部 Arc）；闭包捕获的是 `AppHandle` + `Arc<AppRuntime>`，路由 State 只持 `Arc<dyn Fn>`（§3.4） |
| 失败策略归一化掩盖真实故障 | 排障困难 | 归一化层**必须**在改写前记 `log::warn!`（含原状态码），否则 B1 的代价是「看不见的故障」 |
| 门 panic 无兜底层可接（门在组内 CatchPanic 之外） | hyper 掐断连接，hooks 组漏出非 204 | 门零 panic 结构性要求 + 单测钉住畸形头路径（§3.2 / §7）；门逻辑无 panic 源（无索引 / 无锁 / 无分配失败路径） |

**未决（不阻塞实施）**：web/其他端的真实路由组形态 —— 待真实客户端需求出现时按 §3.1 契约新增，届时才需要决定凭证形状的第二 impl（Q5 已定 trait 已就位）。
