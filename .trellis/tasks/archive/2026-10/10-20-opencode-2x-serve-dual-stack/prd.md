# opencode 1.x / 2.x 双栈 chat 适配

## Goal

让 `ServeAdapter`（`src-tauri/src/agent/chat/adapter/serve.rs`）在**同一份代码**里同时对接
opencode 1.x 与 2.x 的 `serve`，且用**能力探测**而非版本号字符串决定走哪条协议。

判定标准：本机装 1.19.0 时 chat / 翻译 / 审批全部与今天一致；换成 2.0.32 后**同样可用**，
不出现「装了新版就整条链路静默失效」。

## 现状问题（第一性原理）

第一性原因只有一条：**协议被当成常量硬编码了**。

`serve.rs` 把 opencode 1.x 的四个协议细节写成了不可替换的事实：

| # | 硬编码点 | 代码位置 | 2.0 的实际行为 |
| --- | --- | --- | --- |
| P1 | 就绪行 `opencode server listening on ` | `serve.rs:615` | 2.0 输出 `server listening on `（无前缀）→ 恒不命中 |
| P2 | 无鉴权 | `ServeConnection { base_url, client }` | 2.0 强制 Basic（用户名必须是 `opencode`），且随机密码只出现在 stdout 第二行 |
| P3 | `/session`、`/event`、`prompt_async`、`/permissions/{id}`、`/abort` | `serve.rs:111,874,1122,1104,1148` | 全部迁到 `/api/*` 且形状改变；旧路径回落 SPA（200 + HTML）或被 405 拒绝 |
| P4 | 事件名 `session.idle` / `message.part.*` / `question.asked` / `todo.updated` | `serve.rs:155-170` | 换成 `session.execution.*` / `session.text.*` / `session.tool.*` / `form.*`；`todo.updated` 已不存在 |

P1 是「功能完全不可用」的直接原因（超时 → 重试 → 永不到达建会话）；
P2–P4 是「即使修好 P1 也仍然不可用」的后续阻塞。实测日志见
`research/opencode-2x-protocol.md` §8：`starting opencode serve` 每 10s 重复、`listening at` 从未出现、
`serve POST /session` 出现 0 次。

### P5 同一根因的连带故障（不在本任务主线，但要显式登记）

- **模型列表**：`opencode models --verbose` 在 2.0 被移除（`Unrecognized flag`），
  `model_discovery.rs` 因此永远返回错误 → 模型选择器空。真实日志已复现。
- **confirm 模式降级**：2.0 对 1.x 的 `permission` 字段 200 + 静默丢弃，
  `permissions` 字段回读为 `ABSENT` → 本该弹审批的操作直接执行。
- **历史会话**：2.0 写 `session_v2` / `session_message`，不写 `session` / `message`；
  `conversation/adapters/opencode.rs:385` 的 `has_session_table` 探测会让 2.0 对话在 Histor 里消失。
  且 1.x 老会话在 2.0 下 `GET /api/session/{id}` **404**（迁移单向，不可 resume）。

## Requirements

### R1 双栈并存，禁止二选一

1.x 与 2.x 必须都能用。不许「升到 2.0 就不支持 1.x」，也不许让用户手动切开关。

### R2 分派依据是协议能力，不是版本号

- **禁止**解析 `opencode --version` 字符串做分支（两版输出格式不同：`1.19.0` vs `opencode v2.0.32`，
  且用户可能装任意 1.18–1.20）。
- **禁止**在通用代码里写 `if agent_id == "opencode"`（沿用既有 OCP 约定）。
- 判据：会话建立后 `GET /api/info` 的 Content-Type —— JSON ⇒ v2，HTML ⇒ v1
  （1.19 上该路径是 SPA 回落，实测 `200 text/html`）。

### R3 就绪握手必须同时吃掉两种形态，并且不依赖随机密码行

- URL 解析接受 `* listening on <url>`（含与不含 `opencode ` 前缀）。
- **鉴权改为主动注入**：spawn 时通过 `SpawnOptions::with_env` 设
  `OPENCODE_SERVER_PASSWORD=<本进程随机值>`，两版都接受；密码由 Neeko 持有，
  不再从 stdout 抓随机行（该行在 2.0 是随机、在 1.x 默认不出现）。
- 保留「读 stdout 第二行 `server password ` 作为兜底」的能力（老版本未按预期注入 env 时）。

### R4 端点与事件面必须由协议版本数据驱动

- 端点选择集中在**一个** `ServeProtocol` 枚举（`V1` / `V2`），`Enum + match` 编译期穷尽；
- SSE 事件翻译按协议分派，**不得**在同一 `match` 里堆两版事件名（会变成 20+ 个 arm 的意大利面）；
- 2.x 的 `session.tool.*` 与 1.x 的 `message.part.updated` 都要收敛到既有的
  `StreamEvent::{ToolStart,ToolOutput,ToolEnd}`，**前端协议零改动**。

### R5 语义不能静默降级

| 能力 | 1.x | 2.x | 要求 |
| --- | --- | --- | --- |
| confirm（审批门） | `permission` 数组 | `permissions` 数组 | 用错字段 = 200 静默丢弃 ⇒ 必须按协议选字段，并在创建后校验回读 |
| 模型选择 | per-prompt `model` | 会话级 `POST /api/session/{id}/model` | `model` 字段在 2.x 的 `prompt` 里被静默忽略（实测），必须走 switch 端点 |
| 提问（`question`） | `question.asked` → `/question/{id}/reply` | `form.created`(kind=question) → `/api/session/{id}/form/{fid}/reply` | 两版都要能答 |
| 计划（todo） | `todo.updated` | 无对应事件 | 2.x 下不产生 `TodoUpdated`，不得伪造 |
| 中止 | `/session/{id}/abort` | `/api/session/{id}/interrupt` | 都要能停 |

「显示了但不起作用」比「不显示」更糟 —— 模型切换这类必须端到端验证生效（读回 `step.model`）。

### R6 resume 失败必须显式报错

1.x 老会话在 2.0 下 404。`resume` 前先 `GET /api/session/{id}`（v2）/ `GET /session/{id}`（v1）
探存在性，不存在就返回 `AppError::NotFound`，不允许静默挂起等一条永不到来的 SSE。

### R7 回归面

- 1.x 既有行为（含 `question.asked`、`todo.updated`、pending/running 去重、`prompt_async` 的
  `{parts:[…]}` 形状、`/question/{id}/reply?directory=`）不得回退，现有 `serve.rs` 内的单测全部保持绿。
- 纯函数（URL 构造、载荷构造、事件翻译）覆盖率 100%：每个协议各一套断言。

### R8 模型列表（纳入本任务，因为它与 R3/R4 共用同一次协议探测）

- 2.x 用 `GET /api/model`（结构化，两版都有）；
- 1.x 保留 `opencode models --verbose`（NDJSON，含 `limit.context`）；
- 探测顺序：`/api/model` 可用则用（两版都可用）→ 失败回落 `models --verbose` → 再失败回落 `models`；
- 禁止在 2.x 上调用 `models --verbose`（必失败，且已在真实日志里刷 ERROR）。

## Non-Goals

- 不改前端 `StreamEvent` 协议与任何 `.tsx`（前端只消费统一事件；`todo` 在 2.x 缺失属已知差异）。
- 不修 `conversation/adapters/opencode.rs` 的 `session_v2` 读取（另开任务，见 P5）。
- 不接管 opencode 的 managed service（`opencode service …`），仍用一次性 `serve` 子进程。

## Acceptance Criteria

- [ ] AC1 就绪：1.19.0 与 2.0.32 下 `extract_listening_url` 都能解析出 URL；两版各有单测样本
- [ ] AC2 鉴权：spawn 注入 `OPENCODE_SERVER_PASSWORD` 后，2.0 的 `/api/*` 全部 200（不再 401）
- [ ] AC3 探测：`ServeProtocol` 判定在 1.19 上为 `V1`、2.0 上为 `V2`，判据是 `/api/info` 的 Content-Type；有注入式单测（不启真进程）
- [ ] AC4 建会话：两版都能创建会话，且会话 `directory` 等于 `ctx.project_id`（2.0 必须用 body 的 `location`，不是 query）
- [ ] AC5 流式：两版都能收到 TextDelta；1.x 来自 `message.part.delta`，2.x 来自 `session.text.delta`
- [ ] AC6 工具：两版都产出 `ToolStart` → `ToolOutput` → `ToolEnd`，且同一 `callID` 不重复 `ToolStart`
- [ ] AC7 轮次结束：1.x 由 `session.idle` 触发 `TurnEnd`，2.x 由 `session.execution.succeeded` / `.failed` / `.interrupted` 分别映射到 `Completed` / `Error` / `Stopped`
- [ ] AC8 审批：confirm 模式下 1.x 用 `permission`、2.x 用 `permissions` 建会话；`permission.asked` 两版都能弹 Gate，回执走各自端点并校验响应非 HTML
- [ ] AC9 提问：1.x `question.asked`、2.x `form.created`(kind=question) 都能渲染为 `UserInput` 并回执成功
- [ ] AC10 模型：2.x 切模型走 `POST /api/session/{id}/model`（`{"model":{"providerID","id"}}`），端到端验证 `session.step.started.data.model` 与所选一致；1.x 保持 per-prompt
- [ ] AC11 中止：`SessionRequest::Cancel` 在两版分别命中 `/abort` 与 `/interrupt`
- [ ] AC12 resume：1.x 老会话在 2.x 下返回 `NotFound` 而非挂起；有单测
- [ ] AC13 模型列表：2.0 下 `list_agent_models` 返回非空；1.19 下仍返回含 `context_window` 的条目
- [ ] AC14 1.x 全部既有单测与 `pnpm check:quick` 通过；无新增 `#[allow]`、无 `unwrap()`
- [ ] AC15 端到端手测：本机 2.0.32 与 1.19.0 各跑一次「发一句 prompt → 看到流式回复 → 点一次审批」

## 约束（来自仓库红线）

- 命令执行只走 `core::exec` / `common::executor`（红线 1）；spawn 已用 `exec::spawn`，改 env 需用
  `SpawnOptions::with_env`，不得直接 `std::process::Command`。
- 禁止 `if let` 三层嵌套（红线 7）；`mod.rs` 只放声明（红线 9）。
- 不新增平台专属 `#[cfg]`（红线 10）。
- 新增纯函数必须有测试（TDD 硬约束）；改前先确认 `pnpm test:rust` 基线绿。
- 事件/常量若涉及双端，须走单一常量源（红线 5）—— 本任务只改后端事件消费，不动 Tauri event 名。

## Open Questions

- OQ1 2.x 的 `session.execution.interrupted` 是否只在用户中断时发？（需 AC7 实测确认后落测试样本）
- OQ2 2.x `session.tool.input.ended` 是否总是紧跟 `called`？（只影响 ToolStart 去重策略）
- OQ3 1.18.x 是否也能吃 `OPENCODE_SERVER_PASSWORD`？（只有 1.19 在手，1.18 按「无 env 则无鉴权」兜底）

## Notes

- 一手取证：`research/opencode-2x-protocol.md`（含两版逐字样本与端点对照表）。
- 技术设计：`design.md`；执行计划：`implement.md`。
- 用户已在会话中明确：采用「方案 A（双栈并存）」，不做方案 B（整体切 ACP）。
