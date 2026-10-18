# Neeko C/S 化 HTTP 服务端落地（首个落脚点：agent-hooks ingest）

> ## ⚠️ 实施期符号漂移（读本文前先看）
>
> 本文是**需求期文档**，其中 4 个符号名与最终落地不符（需求与架构裁决全部有效）：
> `ingest(...)` 实为 `ingest::validation::validate(...)`、`HookEnvelope` 实为 `event::HookEvent`、
> `deliver_signal` 实为 `dispatch::deliver_notification`（公开入口 `dispatch::via_blocking_pool`）、
> 「`ingest/server.rs` 原地重写」实为**删除该文件**并拆入 8 个单职责文件。
> 原因与完整对应关系见 `design.md` 顶部「实施期符号漂移」表与 `implement.md`「最终目录布局（实测）」。

## Goal

把 Neeko 从进程内 Tauri IPC 的单一交互形态，扩展为**统一的 C/S 架构**：进程内常驻一个 HTTP 服务端，未来任何客户端形态（本机 CLI、Web 浏览器、其他设备/端）都经同一套「鉴权门 → 路由组 → 内核」流水线接入，而不各自造服务、各自造鉴权。

本任务的交付 = 这套架构的**第一个落脚点**：把当前手搓 HTTP/1.1 的 `agent-hooks` ingest 迁到该服务端。**agent-hooks 是本架构的一次应用，不是架构的定义域** —— 架构判断不得因「当前只有 hook 一个消费者」而收窄为 hook 专用设计；反过来，hook 侧的既有契约（fail-open、loopback、token）也不得污染架构层的通用形态。

用户价值：① 消除「一条 wire 硬编码所有未来」的债；② 后续接 Web/其他端 = 加一个路由组，鉴权门与引擎零改动；③ 白拿 axum/tower 生态能力（body limit / 超时 / panic 兜底 / 优雅停机 / WS / SSE）。

## Confirmed Facts（代码实证，非约定）

| # | 事实 | 锚点 |
|---|---|---|
| F1 | 现状唯一的 HTTP 服务端是手搓 `TcpListener` + 每连接一个 OS 线程 + 自写 `split_request`/`find_header`/`Content-Length` 解析 | `src-tauri/src/agent/hooks/ingest/server.rs:13,173,260` |
| F2 | 改造前：内核是纯函数 `ingest(raw, expected_token, sink) -> IngestOutcome`，违规全 fail-open 204，token 不符 403（**改造后该签名与枚举均删除**，见 H1） | `ingest/server.rs:80-105` |
| F3 | 外圈 `deliver_signal`：锁 `project_manager` → `attribute()` 归属 → `project()` 投影 → `notification.observe()` | `ingest/server.rs:290-337` |
| F4 | 磁盘契约：每实例 `endpoints/<uuid>.env`（`PORT`+`TOKEN`，目录 0700 / 文件 0600），启动时 `prune_stale_endpoints` 回收死坐标 | `ingest/endpoint.rs` |
| F5 | 上报端 shim `neeko-report.mjs` 每次上报扫目录逐个 POST，800ms 超时、一切异常吞掉、**永远 exit 0** | `agent/hooks/templates/neeko-report.mjs:166` |
| F6 | 常驻任务经 `AppRuntime::spawn_blocking`（Scheme C：业务码不裸调 `tokio`/`tauri` runtime） | `ingest/server.rs:197` + `common/runtime.rs` |
| F7 | 进程内已有 WS **客户端**先例（`dsh-neeko` 经 `127.0.0.1:3081` WebSocket 送事件），Neeko 从未做过 WS 服务端 | `.trellis/tasks/10-16-notify-dsh/prd.md:18` |
| F8 | 依赖缺口：Cargo.toml 无 axum / tower / hyper-util；`tokio` 已 `features=["full"]`；`async-trait` 已在依赖树 | `src-tauri/Cargo.toml` |
| F9 | 关闭协议在 `src-tauri/src/app/close.rs`（`Destroyed` → `shutdown_background_and_exit`），清理任务表在 `app_state.rs`，当前**无** HTTP 优雅停机任务 | `app/close.rs:34` + `app_state.rs::shutdown_background_and_exit` |
| F10 | 通知摄入是旁路：失败只降级外部 CLI 通知，绝不阻断 Neeko 启动 | `agent/hooks/boot.rs:39` |
| F11 | `notification` 核心域禁 import 业务域（护栏 `check_notification_core_direction`，依赖方向「业务 → 门面」） | `tools/guards/checks/check_notification_core_direction.py` |
| F12 | 集成测试 harness 在 `src-tauri/tests/unit.rs`（子模块聚合 + crate 根同类 clippy 豁免） | `src-tauri/tests/unit.rs` |
| F13 | 单元测试夹具唯一实现 `common::testing::isolated_state`（tempdir 派生，红线 13） | `src-tauri/src/common/testing.rs` |

### 第一性原理（架构为何长这样）

三条不可协商硬边界：

- **B1 不可阻塞调用方**：上报端是用户终端里的 CLI 子进程（同步阻塞、800ms 预算、异常必吞、永远 exit 0）。谁的服务端抖动，谁就是在拖累用户正在跑的 agent。
- **B2 进程数 N≥2**：多实例并存，发现靠磁盘坐标文件（F4）。
- **B3 没有"因为你是本地所以信你"这回事**：同机 ≠ 同用户身份。任何客户端都必须先证明自己持有本实例签发的能力，无论它从哪条路连进来。

**关键拆解：客户端相关的物理变量是四个正交维度**（连接寿命 / 同步性 / 身份强度 / 暴露面），且**这四个维度各自归属于不同层**，不属于同一个概念：

| 维度 | 归属层 | 是否随客户端类型变化 |
|---|---|---|
| 连接寿命 / 同步性 | 路由组内的具体 handler | 是（per-route） |
| 失败策略 | **路由组**（由该组调用方的物理约束决定） | 是（per-group） |
| 身份强度 | **统一鉴权门**（策略唯一：持有能力） | **否**（policy 唯一，仅凭证形状随传输变） |
| 暴露面 / 引擎设施 | **引擎** | 否（进程级唯一） |

我最初的方案把「路由前缀 + 鉴权 + 失败策略」三者捆成一个 "lane" 概念，于是被迫推出 web/local 两条 lane —— 那是个**假分类**：鉴权根本不随客户端类型变化（B3），把它按 lane 切开只会得到"两条各自记得要鉴权的通道"，而新增第三条时漏鉴权的风险随之而来。**合并后鉴权门是进程内唯一一处，漏鉴权在结构上不可能。**

**架构裁决**：

1. **不变的内核** —— 纯函数、无 IO、无 HTTP 框架（`ingest` / `attribution` / `report` / `endpoint`）。
2. **可替换的传输** —— HTTP 是本任务选的实现；内核不 import axum，明天换传输不动内核。
3. **统一鉴权门** —— 进程内唯一，所有路由组共用；策略只有一条「持有本实例签发的能力」。凭证的**形状**（哪个 header、什么 scheme）是传输适配细节，不进策略。
4. **路由组（route group）** —— 扩容单位：一个目录 = 一组前缀 + 该组自己的失败策略。新增客户端形态 = 加一个路由组，鉴权门与引擎零改动。
5. **失败策略是路由组的显式声明** —— 由该组调用方的物理约束决定（hooks 组 = fail-open，保 B1），不进引擎也不进内核。

**客户端是什么与架构无关** —— 这是本 PRD 与「迁移 agent-hooks」视角的根本差别：hook 的 loopback 约束是 `hooks` 路由组的失败策略参数，不是服务端的参数。

## Requirements

### 架构侧（与 hook 无关，通用）

- **A1 单引擎 + 路由组**：进程内一个 HTTP 引擎；客户端能力按「路由组」组织（一个目录 = 一组路由前缀 + 该组自己的失败策略）。**不存在 lane 概念**，不存在"按客户端类型分通道"。
- **A2 引擎职责收敛**：引擎只管与业务无关的事 —— bind、分层（超时 / body limit / 并发 / panic 兜底 / 访问日志）、鉴权门装配、路由组分发、优雅停机。引擎不得出现任何业务分支（不认识 hook、不认识通知、不认识 agent）。**层位置是契约不是细节**：必须被失败策略改写的层（catch-panic / timeout / body-limit）装在组内、归一化层**内侧**；门与并发上限装在组外（洋葱序与理由见 design §3.3）。访问日志用自写 `log` 中间件，不用 `tower_http::TraceLayer`（全仓无 tracing-subscriber，它在生产是静默 no-op）。
- **A3 路由组可增量**：新增客户端形态只加一个目录（路由 + 失败策略声明）与一行注册；鉴权门与引擎零改动。OCP 由「新增文件清单」与测试共同证明，不靠 prose 承诺。
- **A4 统一鉴权门**：进程内唯一 auth gate，所有路由组共用；策略唯一（持有本实例签发的能力，恒定时间比较）。凭证提取（header 名 / scheme）是传输适配器，通过 trait 扩展，不得把"按客户端类型分支"写进策略。**门不接受任何"本组免鉴权"选项** —— 未来若确需公开端点，必须是显式、可 grep 的例外并写明理由。
- **A5 失败策略按路由组声明**：由该组调用方的物理约束决定并显式声明（`hooks` = fail-open 保 B1）；策略差异不进入引擎、不进入内核。
- **A6 优雅停机**：`ServerHandle` 出入引擎，挂到 app 关闭协议清理任务表（补 F9 缺口）；停机过程打点（开始 / 完成 / 耗时）。**`stop()` 的线程契约**：内部经 `common::runtime::block_on_shutdown` 等待收尾，只可在**非 runtime 线程**调用（关闭协议的清理线程即此形态）；测试在 `#[tokio::test]` 内直接调会 panic，必须经独立 OS 线程调用（design §3.3 / §7）。A6 **不承诺**「在途连接数打点」—— 无对应计数机制，不写无实现的承诺（评审清单 6）。
- **A7 红线合规**：只绑 `127.0.0.1`（红线 8）；常驻 serve 经 `AppRuntime`（Scheme C）；**handler 内不得同步执行含阻塞锁的投递**（红线 3，见 H4）；`mod.rs` 极薄（红线 9）；无 `#[cfg]` 平铺（红线 10）；生产码无 `unwrap/expect`（Cargo lints deny）；测试夹具 tempdir 派生（红线 13）。
- **A8 位置裁决**：引擎（bind / 分层 / 鉴权门 / 优雅停机）属基础设施层 —— 落 `src-tauri/src/server/`（design §1.1），**不得**放进 `agent/hooks/ingest/`（hook 域不持有进程级通用设施）。**`ingest/server.rs` 文件名不变、内容原地重写**：删除全部传输职责与手搓解析器，内核收敛为语义投影，`deliver_signal` 保留；不保留旧副本、不新建 `kernel.rs`/`group.rs`/`dispatch.rs`。

### 落脚点侧（本任务的唯一生产者）

- **H1 内核按新传输重写，不保留旧写法**：axum 接管 HTTP 后，旧内核里的传输职责（`split_request` / `find_header` / `find_header_len` / `head_complete` / `MAX_HEADER_BYTES` / `IngestOutcome` / `InflightGuard`）**全部删除**，不留死代码、不做兼容层。内核收缩为「已路由 + 已鉴权的语义投影」：source 白名单 → JSON 解析 → `is_usable` → `sink`。
  - **保留原样**：`attribution`、`report`、`endpoint`（磁盘契约 + prune）、`event_keys` / `HOOK_TARGETS` 数据、`deliver_signal`、`TOKEN_HEADER` 常量（wire 契约，模板锚点测试消费）。
  - **既有内核单测同步重写**：断言从「raw HTTP 字节」改为「(source, body) 语义入参」；`wrong_token_is_rejected` / `missing_token_is_rejected` / `oversized_body_fails_open` / 请求行长断言**删除**（这些职责已由鉴权门 / 引擎层 / axum 承接），其等价保证转由引擎与集成测试覆盖（AC2/AC4）。「内核零改动」不再是目标 —— **只保留一份 HTTP 实现**才是。
- **H2 wire 契约逐字节不变**：`POST /hook/{source}`、请求头 `x-neeko-agent-hook-token`、合法→204 / token 不符→403 / 畸形与未知 source→204 fail-open；`endpoints/*.env` 文件形状不变 → shim、endpoint 文件、前端**零改动**。
- **H3 状态注入**：路由组自有的状态（失败策略、投递闭包）经 axum `State` 注入，不散落为函数参数或全局查找；**token 不进路由组** —— 它是门的凭证，由 boot.rs 建门时注入 `HeaderToken`（校验唯一位置在门，A4/AC7）。业务状态（`AppStateWrapper`）仍经既有 `deliver` 边界以 `AppHandle` + `app.state::<>()` 访问 —— `AppStateWrapper` 非 `Clone`，强行 Arc 化属超出本任务的重构。
- **H4 阻塞投递隔离（红线 3）**：`deliver_signal` 同步持两把 std `Mutex`（`project_manager` —— 全仓 14+ 处 UI 命令竞争同锁；`notification.policy`）。旧实现每连接一个专用 OS 线程，阻塞锁无害；迁 axum 后 handler 跑在 **Tauri 共享 tokio runtime 的 worker** 上 —— 同步持锁会占住 worker，多 Agent 并发（16 在途 hook + 用户同时刷项目列表）可打满 worker，令前端 Tauri Command（IPC）与 LSP/终端异步任务一起停摆。故投递必须经 `AppRuntime::spawn_blocking` fire-and-forget 隔离（design §3.4）；204 不依赖投递结果，fail-open 语义不变，且响应不再含锁等待（B1 的 800ms 预算压力归零）。

## Acceptance Criteria

- [ ] **AC1 内核收敛**：旧传输职责符号已从 `ingest/server.rs` 彻底消失（`git grep` 零命中 `split_request` / `find_header` / `head_complete` / `InflightGuard` / `IngestOutcome`）；内核仅剩语义投影路径且有单测覆盖（白名单外不投递 / 非法 JSON 不投递 / 空 session_id 不投递 / 合法则投递一次）；`attribution` / `report` / `endpoint` 测试全绿未改（H1）。
- [ ] **AC2 wire 等价**：新增集成测试用真引擎 + 真 socket POST，断言 204 / 403 / 未知 source 静默 / 超限 / 非法 JSON 五种路径的**状态码 + sink 投递记录**（fixture 字节沿用旧 `tests` 构造）（H2）。路由组经 `route_group_with`（注入 deliver 闭包，design §3.4）构造 —— 集成测试是独立 crate、无 `tauri::test` feature，构造不出 `AppHandle`；`deliver_signal` 本体由既有 dispatch 单测 + 人工验证覆盖（与 `notification/center.rs:108` 口径一致）。裸字节（非 HTTP）与超长头两行是 design §6 第 6/7 行的**已记录偏差**，不在本 AC 断言范围。
- [ ] **AC3 物理约束**：断言只绑 `127.0.0.1`；常驻任务经 `AppRuntime`，业务文件无裸 `tokio::spawn`（A7）。
- [ ] **AC4 隔离**：panic 兜底（500）、超时（**408**）、body 超限（413）三条经**策略映射**（FailOpen→204 / FailClosed→`fallback_status`）各有测试钉住；并发上限（**503** 立即拒绝，组外不经归一化）与**未鉴权请求不占并发槽位**（gate 在 concurrency 之外）各有测试钉住（A6/A7 + design §2.2/§3.3）。
- [ ] **AC5 优雅停机**：`ServerHandle::stop()` 有单测（**经独立 OS 线程调用** —— `#[tokio::test]` 内 `block_on_shutdown` 会 panic，见 A6 线程契约）；清理任务表接线 + close 协议调用点有测试或人工验证记录（A6）。
- [ ] **AC6 路由组可增量**：seam 被测试证明 —— 注册一个**测试用**路由组，它复用同一鉴权门、声明自己的失败策略，且不改引擎/鉴权门/内核任何一行；`neeko check` 能答出「新增一个路由组需要改哪些文件 = 仅新增」（A3/A4/A5）。
- [ ] **AC7 鉴权唯一性**：`git grep` 证明进程内只有**一处** token 能力校验（`ct_eq` 调用点 = 1，仅在 `server/gate.rs`）；不存在第二份鉴权逻辑，也不存在内核自检副本；鉴权门对所有路由组强制生效（含测试路由组）（A4）。
- [ ] **AC8 位置裁决**：`git diff --stat` 证明引擎只在 `src-tauri/src/server/` 新增；`agent/hooks/ingest/` 下**无新文件**，`ingest/mod.rs` 零改动；`server.rs` 的 diff 限于四类改动：删传输/解析符号（AC1 清单）+ 内核签名收敛为语义投影（H1）+ 单测重写（design §7 对照表，逐条记录覆盖转移目标）+ 新增 `route_group`/`route_group_with`/`ingest_hook`（A8）。
- [ ] **AC9 回归**：`pnpm check:quick` 全绿；收尾 `pnpm check` 全量通过（含 Windows CI 口径的夹具无关性）。
- [ ] **AC10 零触点**：`git diff --stat` 中 `agent/hooks/templates/**`、`src/**`、`capabilities/**` 无改动（H2）。
- [ ] **AC11 护栏不回归**：`check_notification_core_direction` 继续通过（F11）；`check_platform_cfg_placement` 通过（A7）。
- [ ] **AC12 偏差显式**：wire 等价性对照表（design.md §6）逐行标注"一致/偏差"，每条偏差有"唯一客户端为何不触发"的论证。

## Out of Scope

- Web 前端的实际功能（页面 / 鉴权产品形态 / 账号系统）—— 无对应需求前不设计对应 API（见 Open Questions Q3）。
- `notification` 核心域的任何改动（F11 防腐必须保持）。
- 跨设备身份鉴权的产品设计（B3 在本任务内体现为「鉴权门只认能力、不认来源」；能力的签发/配对产品形态不在本任务）。
- ServeAdapter（`agent/chat/adapter/serve.rs`）等既有 HTTP 客户端路径 —— 不动。
- 多实例端口协调 / 进程发现协议的增强（沿用 F4 坐标机制）。
- 客户端 SDK / 生成代码 / API 文档站。

## Technical Notes

- 新增依赖（版本号实现期以 crates.io 为准并锁定）：`axum`、`tower-http`（`catch-panic` / `timeout` / `limit`）、`subtle`（恒定时间比较）；`tower`（**仅 `Layer`/`Service` trait，不开 `limit` feature** —— 并发上限用 tower-http 版，见下）。`tokio` 已 `full`；`async-trait` 已在依赖树（F8）。**版本现状**：`tower` 0.5.3 / `tower-http` 0.6.8 / `subtle` 2.6.1 已在 `Cargo.lock`（传递依赖），转直接依赖不新增版本；**`axum` 是净新增**（lock 中无，将带入 `axum-core`/`matchit`/`http-body*`）—— S1 验证加 `cargo tree -d` 确认无双版本。
- **两个 `ConcurrencyLimitLayer` 同名反义，必须选 tower-http 版**：自写 `concurrency_limit(Arc<Semaphore>)` 中间件（tower-http **无**同名层，实测） = 超限**立即 503**（贴近旧实现「超限直接断开」）；`tower::limit::ConcurrencyLimitLayer` = **排队等 permit**（慢请求堆积到被超时收割，旧保护语义丢失）。同理 body 上限用 `tower_http::limit::RequestBodyLimitLayer`（413）。
- **层位置是契约**（评审 F-1）：必须被失败策略改写的三层（catch-panic / timeout / body-limit）装在**组内、归一化层内侧**（tower 中间件只能改写来自内层的响应）；门与并发上限装在**组外**，门在并发之外（未鉴权请求不占槽位，消解 DoS 面）。完整洋葱序与逐条理由见 design §3.3。访问日志用自写 `axum::middleware::from_fn` + `log`，**不用 `tower_http::TraceLayer`**（它发 `tracing` 事件，全仓无 tracing-subscriber → 生产静默 no-op）。
- `bind` 留在引擎调用方（保持红线 8 的「谁决定绑哪」不动摇）：调用方 `std::net::TcpListener::bind(("127.0.0.1", 0))` 取实得端口 → `set_nonblocking(true)` → `TcpListener::from_std(...)` 转 tokio 监听器（与既有 `spawn` 的 nonblocking 语义等价）。
- 鉴权门的 token 比较走恒定时间实现，避免时序侧信道。
- 迁移**不存在**「内核搬冢」步（不拆文件、不保留旧副本）；回滚点 = `server/` 引擎为纯增量，wire 切换集中在 `ingest/server.rs` 一个文件的 commit。
- 失败策略定案为编译期类型（`FailurePolicy` enum，`Copy`）—— 它必须真正承重（拒绝路径的兜底状态码由它决定），否则就是会漂移的装饰。理由见 design.md。

## 注：本文中的"路由组 / Route Group"是本次定案的术语

一处曾用的"lane"（泳道）分类已在规划期撤销：它把**路由前缀 + 鉴权 + 失败策略**捆成一个概念，而鉴权策略与客户端类型无关（B3），按 lane 切开只会得到多条"各自记得要鉴权"的通道、漏鉴权风险随通道数线性增长。现方案改为：**统一鉴权门（进程唯一）+ 路由组（扩容单位，自带失败策略）**。后文一律用"路由组"，不再出现 lane。

## Open Questions

- ~~是否建 task~~ → 已建：`.trellis/tasks/10-17-cs-http-gateway`
- ~~任务命名~~ → 已从「引入 axum HTTP 网关承载 agent-hooks ingest」改为现名：架构为主体，hook 为落脚点
- ~~是否分 web/local lane~~ → **否，已撤销**。原方案把「路由前缀 + 鉴权 + 失败策略」捆成 lane 是假分类：鉴权不随客户端类型变化（B3），按 lane 切开会得到"各自记得要鉴权"的多通道、漏鉴权风险随通道数增长。改为：统一鉴权门（A4）+ 路由组（A1）+ 失败策略按组声明（A5）。
- ~~Q3 是否产出第二个生产路由组~~ → **否**。无客户端需求的 API 端点不是可扩展性证明，只是无用代码。extensibility 由 seam（统一鉴权门 + 路由组注册机制）+ **测试用路由组**（AC6）共同钉住。
- ~~Q4 失败策略声明形态~~ → **编译期类型**（`FailurePolicy` enum，`Copy`）。它必须真正承重（拒绝路径的兜底状态码由它决定），否则就是会漂移的装饰。
- ~~Q5 鉴权门凭证提取~~ → **trait 方式，但当前只有一个 impl**。`Credential` trait + `HeaderToken`（header 名 + 期望值）单实现落地；禁止为假想客户端预留第二个 impl。门的裁决是"任一凭证匹配即通过"（OR 语义）；新增凭证形状 = push 一个 impl，门与引擎零改动。
- ~~Q6 鉴权门与内核自检的"已知冗余"~~ → **问题已消失**。原方案保留内核 token 自检（H1 要求），于是需要论证「两处比较不算重复鉴权」。按用户决定删除内核传输职责后，token 校验**只剩鉴权门一处**，AC7 变成结构性成立，无需论证。
