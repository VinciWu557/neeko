# 实施计划：Neeko C/S 化 HTTP 服务端（首落点 hooks ingest）

> 依据 `design.md`。每步都是「可编译 + 可回归」的最小切片；S1 是纯增量（不碰业务文件），S2 是唯一的 wire 切换点。
> 全部步骤遵循根 `AGENTS.md` 的 TDD 强制要求：先写失败测试 → 最小实现 → 重构。

## 0. 前置事实核对（动手前必做）

```bash
# 1) 准入语义单测基线（S2 会按 design §7 对照表重写它与其单测；此基线用于区分
#    「迁移引入的失败」与「既有失败」，且 attribution/endpoint 测试必须保持全绿未改）
cargo test --manifest-path src-tauri/Cargo.toml ingest:: -- --nocapture

# 2) 依赖版本已在 lock 中（design §9）：tower/tower-http/subtle 不应引入新版本；
#    axum 是净新增（lock 中无）—— S1 后用 cargo tree -d 确认无双版本
grep -n -A1 '^name = "tower"\|^name = "tower-http"\|^name = "subtle"\|^name = "axum"' src-tauri/Cargo.lock

# 3) 本域护栏基线
pnpm guards run check_notification_core_direction
```

若第 1 条已红 → 先修基线，不要开始 S1（否则无法区分「迁移引入的失败」与「既有失败」）。

## S1 — 网关引擎（纯增量，不碰业务文件）

**目标**：`server/` 层可独立编译与测试，**不 import tauri、不 import 任何业务域**（design §1.2）。
本步是纯新增：不动 `agent/hooks/**` 一行。

- [ ] 1.1 `Cargo.toml` 新增直接依赖（tower/tower-http/subtle 锁定为 lock 既有版本，避免漂移）
```toml
axum = "0.8"
tower = "0.5"                # 仅 Layer/Service trait；不开 limit feature（并发用 tower-http 版，见下）
tower-http = { version = "0.6", features = ["catch-panic", "timeout", "limit"] }  # 不用 trace（design §5）
subtle = "2"
```
  - **`ConcurrencyLimitLayer` 必须用 `tower_http::limit::` 版（超限立即 503）**；`tower::limit::` 同名层是排队语义（堆积到超时），禁混用（design §5 / PRD Technical Notes）
- [ ] 1.2 `src-tauri/src/lib.rs` 加 `pub mod server;`（与 `common` / `platform` 同级的顶层基础设施模块）
- [ ] 1.3 **先写测试**（Red）：`server/gate.rs` 单测
  - 正确 token → `authorize` true
  - 错误 / 缺失 / 非 ASCII 头值 → false
  - 空凭证列表 → 恒 false（门不接受「免鉴权」配置，A4 的结构性证明）
  - 两个 `CredentialExt` 时 OR 语义（用 `HeaderToken` + 测试用第二个 impl）
  - **任意畸形头零 panic**（非 ASCII 值 / 超长 / 重复头名）—— 门在组内 CatchPanic 之外，零 panic 是结构性要求（design §3.2）
- [ ] 1.4 实现 `server/gate.rs`（`CredentialExt` / `HeaderToken` / `AuthGate` / `ct_eq`）
  - `ct_eq` 用 `subtle::ConstantTimeEq`；长度不等直接 false
  - `AuthGate` 经 `axum::middleware::from_fn_with_state` 装配，state 为 `Arc<AuthGate>`
- [ ] 1.5 **先写测试**：`FailurePolicy::fallback_status`（`FailOpen → 204` / `FailClosed → 500`）+ 归一化层改写（500/408/413→`fallback_status`；403/503 不在组内、不被改写）
- [ ] 1.6 实现 `server/group.rs`（`FailurePolicy` + `RouteGroup` 值对象）+ `normalize(policy)` 层（`tower::Layer`/`Service` 包装）
  - 归一化层**必须**在改写前 `log::warn!`（含组名与原状态码）—— design §9 的排障要求
- [ ] 1.7 **先写测试**：`server/engine.rs` 的分层行为（design §7「引擎」行）
  - bind 到 `127.0.0.1`（AC3）：测试 bind `127.0.0.1:0` 后 `handle.port()` 可连
  - panic 路由 → `FailOpen` 组 204 / `FailClosed` 组 500（AC4 + 策略真承重）
  - 超时路由（sleep 超过 `request_timeout`）→ 408 经策略映射（同上两态）
  - body 超限（> `max_body_bytes`）→ 413 经策略映射（同上两态）
  - 并发上限：`max_inflight = 1` 时第二个并发请求 **503**（tower-http 版立即拒绝；组外，不经归一化）
  - **未鉴权请求不占槽位**：`max_inflight = 1` 时 403 请求不影响后续合法请求（gate 在 concurrency 之外，design §3.3 顺序理由 2）
  - `ServerHandle::stop()` → serve task 收敛（AC5）。**必须在独立 OS 线程调用**：`std::thread::spawn(move || handle.stop()).join()` —— `stop()` 内部走 `block_on_shutdown`，`#[tokio::test]` 里直接调会 panic（design §3.3 线程契约）
  - access_log 冒烟：请求经过且状态正确（不断言日志内容，与既有口径一致）
  - 用 `AppRuntime::from_handle(tokio::runtime::Handle::current())` 注入，**不裸调 `tokio::spawn`**（A7）
- [ ] 1.8 实现 `server/{engine,mod}.rs`（含 `mount_all` 的组内装配与全局装配，洋葱序 design §3.3）
  - 组内（由内到外）：`RequestBodyLimitLayer` → `TimeoutLayer` → `CatchPanicLayer` → `normalize(policy)`
  - 全局（由内到外）：`mount_all` → 自写 `concurrency_limit(Arc<Semaphore>)` 中间件（tower-http **无**同名层，实测） → gate middleware → access_log middleware
  - `ServerConfig` 无 `port` 字段：端口从 `listener.local_addr()` 单点读取（design §3.3）
  - `mod.rs` 极薄：`mod` 声明 + `pub use`（`AuthGate` / `HeaderToken` / `CredentialExt` / `RouteGroup` / `FailurePolicy` / `ServerConfig` / `ServerHandle` / `serve`），红线 9

**验证**：
```bash
cargo test --manifest-path src-tauri/Cargo.toml server::
grep -rn "crate::agent::\|crate::git::\|tauri::" src-tauri/src/server/ || echo "clean (design §1.2)"
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
# axum 净新增：确认无双版本依赖（design §9）
cargo tree --manifest-path src-tauri/Cargo.toml -d | grep -i "axum\|http-body\|tower" || echo "no duplicates"
```

## S2 — `ingest/server.rs` 原地重写（wire 切换点）

> **实施后的实际落点**（与下方步骤文本的原始表述不同，以本节为准）：
> `ingest/server.rs` **整体删除**，其内容拆入 `ingest/` 下的多个单职责文件。
> 见文末「最终目录布局（实测）」一朵的完整说明与命名判据。
> design/PRD 里的「原地重写、文件名不变」在实施中被推翻 —— 拆除后 `server.rs` 已无内核可放，
> 只剩一个薄适配器；而内核与适配器分属「上报协议」与「传输框架」两个变化方向。

**目标**：唯一的外部契约切换点。**不留旧副本、不留死代码**：删除全部传输职责，
准入语义收敛为纯函数投影，路由适配器独立成文件。

> **先做删除，再做新增**：先让文件「只剩还该存在的东西」，再往上加。反过来做会留下
> 「新旧两条路径都在」的中间态，编译器不会报错（旧函数仍被旧 tests 调用），review 也看不出来。

- [ ] 2.1 **先写集成测试**（Red）：`src-tauri/tests/unit/http_gateway_test.rs` + `unit.rs` 加一行 `#[path] mod`
  - 路由组经 `route_group_with`（注入 deliver 闭包）构造：`Arc<Mutex<Vec<(String, HookEvent)>>>` 记录 sink —— 集成测试是独立 crate、无 `tauri::test` feature，构造不出 `AppHandle`（design §3.4 / PRD AC2）
  - 五路径按 design §6 的**客户端可观测行为**断言，**状态码 + sink 投递记录双断言**：合法 204 + 投递 1 次 / 错 token 403 + 不投递 / 未知 source 204 + 不投递 /
    超限 body → 204（引擎 413 经组内归一化）+ 不投递 / 非法 JSON 204 + 不投递
  - **不要**断言内核返回的枚举（该枚举已删除）；裸字节与超长头是已记录偏差（§6 第 6/7 行），不在本测试范围
- [ ] 2.2 **删除传输+解析职责**（一次删干净，逐项确认 `git grep` 零命中）
  - `spawn()` / `serve_conn()` / `read_limited()` / `head_complete()` / `find_header_len()`
  - `split_request()` / `find_header()` / `MAX_HEADER_BYTES` / `MAX_BODY_BYTES`
  - `IngestOutcome` 枚举（删 token 自检后已无变体）
  - `InflightGuard` / `static INFLIGHT` / `MAX_INFLIGHT_CONNECTIONS`
  - 随之失效的 import：`std::io::{Read, Write}` / `std::net::{TcpListener, TcpStream}` /
    `std::sync::atomic::{AtomicUsize, Ordering}` / `std::sync::Arc`（若仍被 State 用则保留）
  - `MAX_INFLIGHT_CONNECTIONS` 的值迁到 `server/engine.rs` 作为 `ServerConfig.max_inflight` 默认值；
    `MAX_BODY_BYTES` 的值迁为 `RequestBodyLimitLayer` 的参数来源（落 `server/engine.rs`）
- [ ] 2.3 **重写准入语义**为纯函数投影（design §3.4）
  - `pub fn validate(source: &str, body: &[u8], mut sink: impl FnMut(&str, HookEvent))`，返回 `()`
  - 载荷契约 `HookEvent` 独立成 `event.rs`（公共数据资产，不依附任何消费者）
  - `hook_source(source: &str) -> Option<&'static str>`：白名单 + 未知 source 的 `log::warn!`（注释随代码迁移，不删事故记录）
  - 保留 `TOKEN_HEADER`（wire 契约；`templates/tests.rs` / `targets/tests.rs` 消费）
- [ ] 2.4 **重写准入语义单测**（按 design §7 的对照表）
  - 保留并改签名：合法投递 / 白名单外不投递 / 未知 source 静默 / `route_whitelist_derives_from_hook_targets`
  - 拆分保留：非法 JSON / 缺必填字段 / 空 session_id 不投递
  - 删除：`wrong_token_is_rejected`、`missing_token_is_rejected`、`oversized_body_fails_open`、
    `header_matching_is_case_insensitive_but_source_exact`、`inflight_guard_reserves_and_returns_slots`
  - **每删除一条，在 commit message 里写它转移到哪**（门单测 / 引擎测试 / AC2 集成测试）——
    否则 review 无法区分「转移」与「丢覆盖」
- [ ] 2.5 新增 `route_group(app, runtime)`（生产入口）+ `route_group_with(deliver)`（测试缝）+ `ingest_hook` handler
  - `HookState { deliver: Arc<dyn Fn(&str, HookEvent) + Send + Sync> }`（private；token 不进路由组 —— 校验唯一位置在门，由 2.8 的 boot 接线注入）
  - 生产闭包 = `move |source, env| runtime.spawn_blocking(move || deliver_notification(&app, source, env))` —— **fire-and-forget，红线 3 / H4**：`deliver_notification` 含两把 std `Mutex`（`project_manager` / `notification.policy`），同步跑在共享 runtime worker 上会阻塞前端 IPC（design §3.4 blockquote）。闭包捕获 `source: String`（`&str` 需先 `to_owned`）与 `env`（已 `Send`）
  - handler 签名：`State` + `Path<String>` + `Bytes` → 恒 204；**无 403 分支**（拒绝在门）
  - `policy: FailurePolicy::FailOpen`；`route_group` 内部委托 `route_group_with`（两条入口共享同一 handler / 校验路径，测试缝即生产路径）
- [ ] 2.6 更新 `handlers.rs` 文件头 `//!` 注释：改为「引擎负责传输，本文件负责路由声明 + 状态」；`validation.rs` 文件头说明「入参在类型上无法表达 HTTP，故不可能长出传输职责」
- [ ] 2.7 同步 `ingest/endpoint.rs` 中引用 `...::server::spawn` 的文档注释（指向 `ingest::handlers::route_group`）
- [ ] 2.8 `agent/hooks/boot.rs` 接线改造（**S2 可编译的前提** —— 旧 `server::spawn` 已删）：
  - 顺序保持 design §4.2：bind `127.0.0.1:0` → 读实得端口 → `remove_legacy_endpoint` → `publish` → `prune_stale_endpoints` → `serve`
  - 建门：`AuthGate::new(token, vec![Arc::new(HeaderToken { name: validation::TOKEN_HEADER })])`
  - 建组：`ingest::handlers::route_group(app.clone(), runtime.clone())`；引擎配置：`max_inflight = 16`（旧 `MAX_INFLIGHT_CONNECTIONS`）、`request_timeout`（旧读写超时 2s 同量级）、`max_body_bytes = 64KB`（旧 `MAX_BODY_BYTES`）
  - `serve` 失败仍只记 warn，不阻断启动（F10 旁路语义不变）；句柄暂存局部变量（S3 接入 app_state 槽位）

**验证**：
```bash
# 传输职责彻底消失（应全部为空）
git grep -n "split_request\|find_header\|head_complete\|InflightGuard\|IngestOutcome\|read_limited" -- src-tauri/src/agent/hooks/ingest/server.rs
# 准入语义单测 + 集成测试
cargo test --manifest-path src-tauri/Cargo.toml ingest::
cargo test --manifest-path src-tauri/Cargo.toml http_gateway
# mod.rs 零改动
git diff --stat src-tauri/src/agent/hooks/ingest/mod.rs
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

**手工验证（写入任务笔记）**：`pnpm tauri dev` → 触发任一 CLI hook → 系统通知到达；
`cat ~/.neeko/agent-hooks/endpoints/*.env` 形状不变；hook 触发期间前端 UI 不卡顿（H4：投递已经 `spawn_blocking` 隔离，worker 不被同步锁占用）。

**回滚点**：这是唯一需要 `git revert` 而非「改回一行」的点。

## S3 — 优雅停机接线

- [ ] 3.1 `app_state.rs` 加句柄槽位
  - **定案 `http_server: Arc<Mutex<Option<crate::server::ServerHandle>>>`**（评审清单 7；字段 private，只经 `set_http_server` 写入）：`shutdown_background_and_exit(&self)` 构造 `move` 闭包必须持 `Arc` 克隆才能跨线程 take，裸 `Mutex` 字段版编译不过；锁中毒走 `unwrap_or_else(|p| p.into_inner())`（与 `set_main_window` 同口径）
  - 提供 `set_http_server(handle)`（boot 存入）；take 由清理闭包直接 `lock().take()`（单一消费者，不必再包一层方法）
  - **组合根只存句柄，不含任何 HTTP 逻辑**（app_state 职责边界）
- [ ] 3.2 `shutdown_background_and_exit` 的任务表加一行
```rust
("http", Box::new(move || {
    if let Some(mut handle) = handle_for_shutdown.lock().and_then(|mut g| g.take()) {
        handle.stop();   // 内部经 common::runtime::block_on_shutdown 等待收尾
    }
})),
```
- [ ] 3.3 `boot.rs` 在 serve 成功后 `state.set_http_server(handle)`
- [ ] 3.4 `ServerHandle::stop` 的有界等待（≤200ms）+ 打点（开始 / 完成 / 耗时）

```bash
cargo test --manifest-path src-tauri/Cargo.toml server::engine
# 人工：dev 模式下关窗 → 日志出现 "http cleanup finished in ..." 且端口不再监听
# 跨平台判据（评审清单 9）：用 endpoint.rs 同款 port_is_listening 语义，不依赖 lsof
#   macOS/Linux: lsof -nP -iTCP -sTCP:LISTEN | grep <port>     # 关窗后应无输出
#   Windows:     netstat -ano | findstr :<port>                 # 关窗后应无 LISTENING 行
```

## S4 — 文档与护栏

- [ ] 4.1 `.trellis/spec/backend/agent-hooks-domain.md` 补一节「HTTP 引擎拓扑」
  - 三层归属（引擎 / 鉴权门 / 路由组）、失败策略为何是组属性、单引擎而非「hook 专用 server」
  - **不在** `AGENTS.md` 复述（避免第二份真相）
- [ ] 4.2 新增护栏 `tools/guards/checks/check_server_no_business_dep.py`
  - scope：`src-tauri/src/server/**/*.rs`
  - 规则一：零 `crate::(agent|git|terminal|...)`（业务清单复用 `check_notification_core_direction.py` 的同一元组 —— 抽到共享常量，禁止两份副本）
  - 规则二：零 `tauri::` / `AppHandle`（剥字符串与注释后匹配，仿 `check_service_no_delivery_dep.py`）
  - 注册：文件即注册（`checks/` 目录本身是清单）；跑 `pnpm guards list` 确认出现
- [ ] 4.3 更新 `.trellis/spec/backend/directory-structure.md` 增加 `server/` 一行

**验证**：
```bash
pnpm guards run check_server_no_business_dep
pnpm guards list | grep server_no_business
pnpm check:quick    # 开发循环口径（全量 `pnpm check` 只留收尾那一次）
```

## 提交切分

| commit | 内容 | 可独立编译 |
|---|---|---|
| 1 | S1（引擎/门/策略/契约，纯增量，含单测） | 是 |
| 2 | S2（删传输职责 + 准入语义收敛为纯函数 + 路由适配器独立 + 集成测试 + `boot.rs` 接线） | 是 |
| 3 | S3（优雅停机） | 是 |
| 4 | S4（spec + 护栏） | 是 |

**为什么 S1 与 S2 分两个 commit**：S1 是纯增量（`server/` 新目录 + `lib.rs` 一行），不碰任何业务文件、不影响现有 wire，可独立 review；S2 是唯一的 wire 切换点，出问题只需 revert 这一个 commit。相比之前「S1+S2 必须合并」的形态，现在不拆文件了，中间态不再有「两份 `TOKEN_HEADER`」问题 —— S1 与旧 `server.rs` 天然共存（前者只提供引擎，后者仍是手搓服务）。

## 风险清单（实施期逐项确认）

- [ ] `Router` 泛型：每组 `Router::new().with_state(S).into::<Router<()>>()`，`RouteGroup.router: Router`（`Router<()>`）
- [ ] **`ConcurrencyLimitLayer` 用 `tower_http::limit::` 版**（1.1 的 `limit` feature 在 tower-http 上；`tower` 不开 `limit`）—— 同名层排队/拒绝语义相反，装错即「慢请求堆积到超时」（design §5）
- [ ] **洋葱序不可写反**（design §3.3）：axum `.layer()` 后加者在外。组内由内到外 = BodyLimit → Timeout → CatchPanic → normalize；全局由内到外 = merge → ConcurrencyLimit → gate → access_log。装错的症状：§2.2 三条承重路径（500/408/413→204）在 S1.7 测试里直接红
- [ ] `CatchPanicLayer::custom` 的闭包签名 `Box<dyn Any + Send>` → `Response`
- [ ] `tokio::net::TcpListener::from_std` 前必须 `set_nonblocking(true)`（否则 `axum::serve` 报错）
- [ ] 生产码零 `unwrap/expect`（Cargo lints deny）；`Response::builder().body()` 的 `Err` 分支用 `unwrap_or_default()` 或返回 500
- [ ] 测试夹具路径一律 `tempdir()` 派生（红线 13）
- [ ] 归一化层改写前必须 `log::warn!`（含组名与原状态码）
- [ ] **handler 无同步锁路径**（H4/红线 3）：`deliver_notification` 只允许出现在 `spawn_blocking` 闭包内；review 时 grep handler 函数体确认无直接调用
- [ ] **门零 panic**（design §3.2）：门在组内 CatchPanic 之外，panic 无人兜底；1.3 的畸形头测试必须覆盖
- [ ] `ingest/server.rs` 删传输/解析职责后要清掉失效 import（`std::io::{Read,Write}` / `std::net::{TcpListener,TcpStream}` / `AtomicUsize` / `Ordering`），否则 `-D warnings` 因 unused 而红
- [ ] 准入语义单测删除项必须逐条记录转移目标（门 / 引擎 / AC2），review 时核对，不允许「静默减少覆盖」
- [ ] `ingest/mod.rs` 必须零改动（红线 9 + `pub mod server;` 保持不变）
- [ ] 覆盖率左移（评审清单 12）：S1 完成后跑一次 `pnpm test:coverage`，确认 `server/` 新代码不把 Rust 地板拉红 —— 覆盖率是分钟级判据，只跑一次，不并入开发循环

## 收敛判据（对 AC 的映射）

| AC | 由哪一步/哪条命令证明 |
|---|---|
| AC1 | `git grep` 零命中 `split_request`/`find_header`/`head_complete`/`InflightGuard`/`IngestOutcome` + 准入语义单测全绿 + `attribution`/`endpoint` 测试未改 |
| AC2 | S2.1 集成测试五路径（状态码 + sink 双断言，`route_group_with` 注入） |
| AC3 | S1.7 bind 断言 + `grep -rn "tokio::spawn" src-tauri/src/server src-tauri/src/agent/hooks`（应为空） |
| AC4 | S1.7 五组测试：panic / 超时（408）/ body 超限（413）/ 并发（503）/ 未鉴权不占槽位 |
| AC5 | S1.7 `stop()` 单测（独立 OS 线程调用）+ S3 人工验证记录 |
| AC6 | S1.7 测试用 RouteGroup（`FailClosed`）不改引擎/门/准入层 |
| AC7 | `git grep -n "ct_eq\|ConstantTimeEq" src-tauri/src` 计数 = 1（`server/gate.rs`）；`git grep -n "TOKEN_HEADER"` 只出现在门与 wire 契约常量处（准入层无校验副本） |
| AC8 | `git diff --stat`（引擎只在 `src-tauri/src/server/`；ingest 侧 diff = 删 `server.rs` + 拆 8 文件 + `boot.rs` 接线） |
| AC9 | `pnpm check:quick` + 收尾 `pnpm check` |
| AC10 | `git diff --stat src/ src-tauri/src/agent/hooks/templates src-tauri/capabilities` 为空 |
| AC11 | `pnpm guards run check_notification_core_direction check_platform_cfg_placement` |
| AC12 | design §6 对照表 + PR 描述逐行标注 |
| H4 | 风险清单「handler 无同步锁路径」grep + S2 手工验证（hook 触发期间前端 UI 不卡顿） |

---

## 实施记录（2026-10-17 完成）

### 已完成（S1-S4 全部）

| 步 | 产出 | 验证 |
|---|---|---|
| S1 | `src-tauri/src/server/{mod,gate,group,engine}.rs` + `engine/tests.rs` | `cargo test --lib server` → 26 passed；`cargo clippy --all-targets -D warnings` 零诊断 |
| S2 | `ingest/server.rs` 删除、内容拆入 8 个单职责文件（`handlers`/`validation`/`event`/`notify`/`dispatch`/`attribution`/`endpoint`）+ `boot.rs` 接线 | `cargo test --lib hooks` → 157 passed；`git grep` 传输符号零命中 |
| S2 集成 | `tests/unit/http_gateway_test.rs`（真引擎 + 真 socket + 注入 sink） | 6 passed，五路径状态码 + 投递双断言 |
| S3 | `app_state.rs` 句柄槽位（`Arc<Mutex<Option<ServerHandle>>>`）+ `shutdown` 清理任务 | `stop()` 单测通过（独立 OS 线程） |
| S4 | `check_server_no_business_dep` 护栏 + 单测；`directory-structure.md` / `agent-hooks-domain.md` | `pnpm lint` 28/28；`pnpm check:quick` 全绿 |

### neeko-check 复审修复（2026-10-17 收尾）

按第一性原理 + 红线复核发现 6 项，已全部修复：

| # | 问题 | 修复 |
|---|---|---|
| P1 | `access_log` 用 `log::debug!`，而 design §3.3/§5 判据是 `info!`。logger 默认恰好 Debug 只是巧合，一次级别调整就让「403/503/panic 都有访问日志」这条洋葱序理由静默失效 | 改 `log::info!` 并在注释里写明「级别选择是契约不是偏好」 |
| P1 | 4 处 rustdoc 断链（`endpoint.rs` 指向已删的 `...::ingest::server::spawn`、`notify.rs` 指向 `super::ingest::hook_source`、`dispatch.rs` 两处 public doc 链 private item） | 改为可解析路径 / 非链接代码引用；`cargo doc` 在 `server/` 与 `ingest/` 下断链清零（总警告 75 → 71，剩余均为既有存量） |
| P2 | `implement.md` 末尾两段「最终布局」互相矛盾且均与实际不符（`report.rs` 不存在、缺 3 个文件），S2 顶部还写着已作废的「实施后改名 kernel.rs + routes.rs」 | 全文按实际落地校正：8 文件实测树 + 单一最终态 + 补记 `report.rs` 合并方案为何被否决 |
| P2 | spec 新章节签名过期（`ingest(...)` / 5 文件清单 / 「内核」表述） | 校正为 `validation::validate` + 8 文件清单 + 实际模块名 |
| P2 | index 里残留一个幽灵条目：`report.rs → contract.rs`（R100 重命名），但 `contract.rs` 既不在 HEAD 也不在工作区 —— 下次 `git add` 会把不存在的文件提交进去（编译必失败） | `git rm --cached` 清掉，工作区零触碰 |
| P3 | `engine.rs` 末尾 `const _: fn(OwnedSemaphorePermit) = drop;` 是空断言（该类型已作为 `try_acquire_owned()` 返回类型真实出现） | 删除，并清掉随之失效的 import |
| P3 | `validate(&source, &body, \|source, e\| ...)` 形参遮蔽：原始路径段与白名单归一后的 `&'static str` 同名不同义 | 改 `registered`，并在 `validate` 文档说明两者区别 |

### 实测推翻了 design 的两处推断（已回写文档）

1. **`tower_http::limit::ConcurrencyLimitLayer` 不存在**（0.6.8 的 `limit` 只有 `RequestBodyLimitLayer`）。
   改为自写 `concurrency_limit` 中间件（`try_acquire_owned` 失败即 503）。
   同时确认 `tower::limit::ConcurrencyLimitLayer` 是 `poll_ready` **排队**语义（源码 `service.rs:64-78`）。
2. **`TimeoutLayer::new` 默认 408 且自 0.6.7 deprecated**（`service.rs:26-32`）。改用
   `TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, …)` —— 用 `new()` 会被
   `-D warnings` 拦下（deprecated），且原本按 504 写的断言全错。

### 真机冒烟发现并修复的缺陷（自动化测试测不出）

**`TcpListener::from_std` 在 Tauri `setup`（同步上下文）panic：`there is no reactor running`。**
初次真机启动直接 abort（`panic in a function that cannot unwind`，tao 的 AppDelegate 里）。
修复：`serve()` 内用 `runtime.handle().enter()` 显式进入 runtime 上下文再 `from_std`。
回归测试 `serve_from_sync_context_does_not_panic` 已加，并**验证过它的毒性**
（撤掉修复 → FAILED，恢复 → passed）。

> 这类缺陷的形状值得记住：引擎单测全在 `#[tokio::test]` 里跑，永远带着 runtime 上下文；
> 而生产调用点是 Tauri 的同步 `setup`。**「测试绿」与「能启动」之间隔着上下文假设。**

### 需人工确认项 —— 已全部关闭（2026-10-17）

- ~~**真机端到端通知**~~ → **已确认正常**（用户人工验证）。日志证据（`~/.neeko/neeko.log`）：

  ```
  10:54:23.037 [INFO][neeko_lib::server::engine:347] [http] POST /hook/pi -> 204 (182µs)
  10:54:23.055 [DEBUG][neeko_lib::platform::system_notify::macos:222] [notify] macOS: UN accepted neeko-409b035b-…
  ```

  三件事同时被证实：① 新引擎接住了真实 CLI 的 POST；② 204 响应 182µs —— 不含锁等待
  （H4 的 `spawn_blocking` 隔离生效）；③ 通知真实送达系统（`deliver_notification` 链路完整）。
  此前记录的「本机 `.app` 启动环境异常」未再复现，改动点（`on_setup` 后半段）工作正常。
- ~~design §6 第 11/12 行（endpoint 文件形状 / 端口绑定）~~ → 已确认：新坐标文件 0600、
  `PORT`/`TOKEN` 两行形状不变（除既有 `endpoint.rs` 测试外，真机复核通过）。

至此 AC2 留给人工的部分、以及全部 S1-S4 的验证项均已关闭。

### 最终目录布局（实测，2026-10-17 收尾核对）

```
src-tauri/src/agent/hooks/ingest/
├── mod.rs          57    一次请求的路径图（仅 mod 声明，红线 9）
├── handlers.rs     89    handler + RouteGroup 声明 + 投递隔离（零副作用）
├── validation.rs  142   准入：白名单 → JSON → 会话身份（纯函数，三个闸门一个出口）
├── event.rs       177   HookEvent 事件契约（公共数据资产，不依附任何消费者）
├── notify.rs      193   通知投影：HookEvent → NotificationSignal
├── dispatch.rs     89   投递链（唯一有副作用，跑在阻塞池）
├── attribution.rs 213   归属降级链（纯函数）
└── endpoint.rs    386   坐标文件（形状/权限/原子写 + 旧形态清理 + 死坐标回收）
```

分层依据 = **一次请求经过的顺序**（`handlers` → `validation` → `event`）+ 两个正交关注点：
`event` 之后的**消费者**（`notify` / 未来的 `state.rs`）各写自己的投影文件，`endpoint` 管
「客户端如何找到我们」。改路由看 `handlers`，改准入看 `validation`，改载荷看 `event`，
改通知看 `notify`，改投递看 `dispatch`，改坐标看 `endpoint` —— 六个变化方向各归其位。

引用路径统一为 `ingest::<mod>::<sym>`（不 re-export，域边界可读）。

**为什么与 design/PRD 的「原地重写、文件名不变」不同**：拆除传输职责后 `server.rs` 只剩
一个薄适配器，而它所包裹的内核属「上报协议」变化方向、适配器属「传输框架」变化方向。
合在一个文件里会被两侧同时牵引，故 `server.rs` 整体删除，内容按上述变化方向拆分。

**否决过的中间形态**（记录下来避免复发）：

- `http/ wire/ dispatch/ coord/` 四层子目录 + 4 个只装 1–2 文件的 `mod.rs` —— 包装而非结构。
- `kernel.rs` 独立文件 —— 「kernel」是 OS 术语，不描述行为；它做的事（白名单 / JSON / 身份校验）
  属上报协议，与 `HookEvent` 形状同属一个变化方向。
- `contract.rs` 命名 —— 同样是抽象分类词；它描述的是「一份上报长什么样」，即事件本身。
- **`report.rs` 合并方案**（曾把事件契约 + 准入校验 + 通知投影三件事压进一个 386 行文件）——
  事件是**公共数据资产**、准入是**边界规则**、投影是**通知消费者词汇**，三者变化方向不同；
  合并会让「新增一个消费者」被迫读通知域词汇。故最终拆为 `event` / `validation` / `notify`。

判据：**文件名必须回答「它做什么」**，而不是「它属于哪个抽象层」。
