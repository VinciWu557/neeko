# opencode 1.x / 2.x 双栈 — 技术设计

> 前置阅读：`research/opencode-2x-protocol.md`（两版逐字样本、端点对照、探测判据）。
> 本文只写**决策与结构**，不复述证据。

## 0. 结论先行

三个决策定成败：

1. **鉴权不猜、主动注入**：spawn 时给 `OPENCODE_SERVER_PASSWORD`，两版都吃；
   不从 stdout 抓随机密码行（那是 2.0 的私有呈现，1.x 根本没有）。
2. **协议是数据类型，不是 if 分支**：`ServeProtocol { V1, V2 }` + `Enum + match`；
   事件翻译拆成 `events_v1` / `events_v2` 两个模块，各自吐同一套 `StreamEvent`。
3. **就绪解析接受前缀可选**：`"listening on "` 定位，前缀不参与匹配。

## 1. 模块拆分（先解决 1806 行的现实）

`serve.rs` 现在 1806 行；把 V2 分支塞进去会变成 3000+ 行、单文件两套事件表。
按职责拆成目录（红线 9：`mod.rs` 只允许 `mod` + `pub use`）：

```
src-tauri/src/agent/chat/adapter/
├── adapter.rs              (不变)
├── acp.rs / acp_config.rs  (不变)
├── deepseek.rs             (不变)
└── serve/
    ├── mod.rs              仅 mod 声明 + pub use（thin）
    ├── protocol.rs         ServeProtocol 枚举 + 探测（GET /api/info Content-Type）
    ├── connection.rs       spawn / 就绪解析 / 密码注入 / 共享 OnceCell / ServeConnection
    ├── request.rs          建会话 / prompt / switch model / approve / form reply / abort
    ├── events_v1.rs        1.x SSE 翻译（message.part.* / session.idle / question.asked / todo.updated）
    ├── events_v2.rs        2.x SSE 翻译（session.text.* / session.tool.* / session.execution.* / form.created / permission.asked）
    ├── pump.rs             SSE 连接、重连、按 sessionID 过滤、分派到对应协议翻译
    └── session.rs          ServeSession + AgentSession 实现 + ServeAdapter::create/resume
```

**搬迁纪律**：阶段 1 只做「零行为变更的搬家」（`git mv` 后逐段移动 + 保持现有单测全绿），
阶段 2 才加 V2。避免「重构 + 新功能」一次性上，出问题无法二分。

## 2. `ServeProtocol`：唯一的协议分派点

```rust
// serve/protocol.rs
/// 一次 serve 进程所讲的应用层协议。
///
/// 判定依据是**能力**（`GET /api/info` 是否返回 JSON），不是版本号字符串 ——
/// 1.19 与 2.0 的 `--version` 输出格式都不同（`1.19.0` vs `opencode v2.0.32`），
/// 而 1.18–1.20 的小版本还没穷举。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServeProtocol {
    /// ≤ 1.19：`/session`、`/event?directory=`、`prompt_async`。
    V1,
    /// ≥ 2.0：`/api/*` + Basic 认证。
    V2,
}

impl ServeProtocol {
    /// 端点前缀：`""` 或 `"/api"`。
    const fn prefix(self) -> &'static str {
        match self {
            Self::V1 => "",
            Self::V2 => "/api",
        }
    }
}

/// 从探测响应判定协议。纯函数，便于注入式单测（不启真进程）。
///
/// 判据是 Content-Type 而不是状态码：**1.19 对 `/api/info` 返回 `200 text/html`**
/// （未匹配路由回落 SPA），只看状态码会把 1.x 误判成 2.x。
#[must_use]
pub fn detect_protocol(status: u16, content_type: &str) -> ServeProtocol {
    let json = content_type.contains("application/json");
    if status == 200 && json {
        ServeProtocol::V2
    } else {
        ServeProtocol::V1
    }
}
```

> 探测失败（连接错误、超时）时**不**降级成 V2：1.x 是既有用户盘面，误判会打断已工作的人。
> 失败 → `V1`，并把失败原因写日志。

## 3. 连接层：密码注入 + 就绪解析

```rust
// serve/connection.rs
pub struct ServeConnection {
    pub base_url: String,
    /// v2 必需；v1 下为 None（注入 env 后两版都要求，故实际上恒 Some）。
    pub password: Option<String>,
    /// 带上 Basic 头与超时的共享 client。
    pub client: reqwest::Client,
    pub protocol: ServeProtocol,
}

async fn start_serve() -> Result<Arc<ServeConnection>, AppError> {
    // 密码由 Neeko 生成并注入：不依赖 2.0 的随机 stdout 行，也不要求 1.x 有该行。
    let password = uuid::Uuid::new_v4().simple().to_string();
    let env = [("OPENCODE_SERVER_PASSWORD", password.as_str())];
    let mut child = exec::spawn_with_env(
        &ExecTarget::Local,
        "opencode",
        &["serve", "--hostname", "127.0.0.1", "--port", "0"],
        &env,           // ← 新增 facade（见 §3.1）
    )
    .await
    .map_err(|e| AppError::Io(format!("failed to spawn `opencode serve`: {e}")))?;
    // …读 URL（前缀可选）→ 兜底读 `server password ` → 探测 protocol
}
```

### 3.1 需要新增的 exec facade（红线 1 要求不得直接 `tokio::process`）

`core/exec.rs` 目前没有「spawn + env」的公开入口（`collect_script` 有 env，`spawn` 没有）。
新增一个薄函数，内部转发到已有的 `spawn_target` + `SpawnOptions::with_env`：

```rust
/// 带环境变量的长驻进程 spawn（stdio pipes）。
///
/// 与 [`spawn`] 的唯一差别是注入 env；`kill_tree` 同样恒开。
pub async fn spawn_with_env(
    target: &ExecTarget,
    cmd: &str,
    args: &[&str],
    env: &[(&str, &str)],
) -> Result<ExecChild, ExecError> {
    spawn_target(
        target,
        SpawnOptions::new(cmd, args).with_kill_tree().with_env(env),
    )
    .await
}
```

> `spawn_target` 已对 Local 走 `with_default_env(合并)`，env 不会被默认值覆盖（合并语义保持现状）。

### 3.2 就绪行解析（AC1）

```rust
/// 1.x: `opencode server listening on http://…`
/// 2.x: `server listening on http://…`（无前缀）
///
/// 前缀不参与匹配：未来任何前缀变化都不该再打断就绪检测，
/// 而「以 http 开头的 URL」是这条输出的语义本体。
fn extract_listening_url(line: &str) -> Option<String> {
    const MARKER: &str = "listening on ";
    let rest = line.get(line.find(MARKER)? + MARKER.len()..)?.trim();
    rest.starts_with("http").then(|| rest.to_string())
}

/// 2.x 第二行 `server password <pwd>`；仅在未注入 env 的兜底路径使用。
fn extract_server_password(line: &str) -> Option<String> {
    line.strip_prefix("server password ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}
```

## 4. 端点表（数据，不是分支）

```rust
// serve/protocol.rs —— 一张表定义全部差异，调用点只查表。
impl ServeProtocol {
    pub fn session_create_path(self) -> &'static str { "/session" }          // v2 自动前缀 /api
    pub fn prompt_path(self, sid: &str) -> String { match self { … } }       // prompt_async vs prompt
    pub fn event_path(self) -> &'static str { "/event" }
    pub fn abort_path(self, sid: &str) -> String { … }                       // abort vs interrupt
    pub fn permission_reply_path(self, sid: &str, pid: &str) -> String { … }
    pub fn question_reply_path(self, sid: &str, rid: &str) -> String { … }   // question vs form
    pub fn session_get_path(self, sid: &str) -> String { … }                 // resume 存在性探测
    pub fn models_path(self) -> &'static str { "/model" }
}
```

三个已实测的**形状差异**必须写进载荷构造函数（不能只换 URL）：

| 载荷 | v1 | v2 |
| --- | --- | --- |
| 建会话 | `?directory=<dir>` + `{"title","permission":[{"permission","pattern","action"}]}` | `{"title","location":{"directory"},"permissions":[{"action","resource","effect"}]}` |
| 提问 | `{"parts":[{"type":"text","text"}],"model":{"providerID","modelID"}}` | `{"text"}`（**不带 model**，会被静默忽略） |
| 切模型 | 无（per-prompt） | `POST /api/session/{id}/model` `{"model":{"providerID","id"}}`（`id`，不是 `modelID`） |
| 权限回执 | `{"response":"once"\|"reject"}` | `{"decision":"once"\|"always"\|"reject"}` |
| 表单回执 | `{"answers":[["text"]]}` + `?directory=` | `{"answer":{"<fieldKey>":<value>}}` |

### 4.1 confirm 模式的静默降级必须堵死（AC8）

2.0 收到 v1 的 `permission` 字段 → **200 且丢弃**。所以：

- 按协议选字段（上表）；
- 创建会话后**回读校验**：v2 用 `GET /api/session/{id}` 断言 `permissions` 存在且非空，
  缺失则记 `WARN` 并把它降级为「审批不可用」的能力位（`Capabilities.approvals=false`），
  而不是让用户以为有人把关。

## 5. 事件翻译：两套模块，一个出口

```rust
// serve/pump.rs
fn translate(
    protocol: ServeProtocol,
    session_id: &str,
    raw: &ServeEvent,
    state: &mut ProbeState,   // part_kinds / tool_started 的去重状态
) -> Vec<StreamEvent> {
    match protocol {
        ServeProtocol::V1 => events_v1::translate(session_id, raw, state),
        ServeProtocol::V2 => events_v2::translate(session_id, raw, state),
    }
}
```

`ProbeState` 承载跨事件状态：v1 的 `part_kinds`（partID → Text/Reasoning/Tool）与 `tool_started`
去重；v2 的 `tool_names`（tool 事件只带 `id`，名字在 `session.tool.input.started.name`，
必须缓存下来给 `ToolStart.name` 用）。

### 5.1 v2 事件映射表

| v2 事件 | 载荷要点 | → StreamEvent |
| --- | --- | --- |
| `session.text.delta` | `data.delta` | `TextDelta` |
| `session.reasoning.delta` | `data.delta` | `ReasoningDelta` |
| `session.tool.input.started` | `data.id` + `data.name` | 记 `tool_names[id]=name`（**不发事件**） |
| `session.tool.called` | `data.id` + `data.input` | `ToolStart { call_id: id, name: cached, title: tool_title(input) }` |
| `session.tool.progress` | `data` | `ToolOutput` |
| `session.tool.success` | `data.content[].text` / `metadata` | `ToolOutput` + `ToolEnd{"done"}` |
| `session.tool.failed` | 同上 | `ToolOutput` + `ToolEnd{"failed"}` |
| `session.execution.succeeded` | — | `TurnEnd{Completed}` |
| `session.execution.failed` | — | `TurnEnd{Error}` |
| `session.execution.interrupted` | — | `TurnEnd{Stopped}` |
| `session.step.ended` | `data.tokens` | `Meta{usage}`（可选，补充而非替代） |
| `session.error` | — | `Error{Agent}` |
| `permission.asked` | `data.action/resources/metadata.files[].patch` | `RequestApproval{tool: action, title: resources.join(" "), diff: patch, cmd: None}` |
| `form.created`（`metadata.kind=="question"`） | `data.form.{id,fields[]}` | `UserInput{turn_id: form.id, prompt: fields[0].title/description, options: fields[0].options[].label}` |

**两条硬约束**：

- `form.created` 只处理 `metadata.kind == "question"`；其余 kind 一律忽略（不假装能答）。
- v2 **没有** `todo.updated` ⇒ 永不产生 `TodoUpdated`。前端 `TodoListCard` 在 v2 下自然空着，
  这是诚实降级，不得用 tool 事件伪造 todo 快照。

### 5.2 v1 事件面保持原样

`events_v1` 是把今天 `translate_event` / `translate_part_delta` / `translate_part_updated` /
`translate_tool` / `translate_permission_asked` / `translate_question_asked` / `translate_todo_updated`
**逐字搬过去**，现有 20+ 条单测随文件一起搬（测试是搬迁正确性的判据）。

## 6. 会话生命周期

```
create:
  connection()                    ← OnceCell，首用初始化（spawn + 就绪 + 探测）
  POST {prefix}/session           ← 载荷按 protocol
  [v2] GET /api/session/{id}      ← 校验 location.directory 与 permissions
  attach_streaming()              ← SSE 泵 + 请求循环

resume:
  connection()
  GET {prefix}/session/{id}       ← 存在性探测（v2 用 /api/session/{id}）
      404 → AppError::NotFound（R6）
  attach_streaming()
```

**SSE 差异**：v1 `GET /event?directory=<dir>`；v2 `GET /api/event`（不接受 query）。
v2 的目录过滤改为「事件自带 `location.directory` + `data.sessionID` 双条件」；
现有「按 `properties.sessionID` 过滤」在 v2 要读 `data.sessionID`（v1 是 `properties.sessionID`），
这条差异放进各自模块的 `session_of(raw)` 小函数，泵循环不感知。

## 7. 模型列表（R8）

```
list_agent_models("opencode")
  connection()                                  ← 复用同一次探测
  GET {prefix}/model                            ← 两版都有，结构化
    ├─ 200 JSON → 映射 ModelInfo{id: "provider/model", name, description}
    └─ 失败（连接/非 JSON）→ 回落 CLI
        ├─ v1: opencode models --verbose        ← 有 limit.context，保留现状
        └─ v2: opencode models                  ← 只有 slug；不许传 --verbose
```

映射只保留 `ModelInfo{id,name,description}`（`limit.context` 已经由 ACP `model_config` 承载，
见 `.trellis/spec/backend/agent-acp-model-selection.md`）。

## 8. 影响面与回滚

| 文件 | 变更性质 |
| --- | --- |
| `adapter/serve.rs` → `adapter/serve/*` | 拆分 + 新增 V2（主体） |
| `adapter.rs` | 仅 `pub use serve::ServeAdapter`（路径不变） |
| `core/exec.rs` | 新增 `spawn_with_env`（薄封装，1 个函数） |
| `agent/model_discovery.rs` | 增加「不带 `--verbose`」的回落路径 |
| 其余 | 不动 |

回滚策略：
- 阶段 1（纯搬家）出问题 → 直接 `git revert` 该 commit，功能回到今天（仍只支持 1.x）。
- 阶段 2+ 出问题 → `ServeProtocol` 探测强制 `V1` 一行即可退回旧协议（`V2` 分支不影响 V1 路径）。

## 9. 风险

| 风险 | 触发条件 | 缓解 |
| --- | --- | --- |
| 1.x 上注入 env 反而要求认证 | 1.18 及更早不认 `OPENCODE_SERVER_PASSWORD` 却因 env 存在而启用鉴权 | 注入后**恒带 Basic 头**：认 env 则通过，不认则头被忽略（无副作用） |
| 探测误判 | `/api/info` 在某个 1.x 小版本也返回 JSON | 判定为 V2 后仍能在「V2 建会话 404」时回退 V1 一次（一次性降级 + 日志） |
| 事件骤减（v2 少事件族） | 前端期待 todo/part 事件 | 前端协议零改动；缺失即空态，PRD R5 已登记 |
| `serve.rs` 拆分引入 import 漂移 | 搬家不彻底 | 阶段 1 保持 `cargo test --lib agent::chat` 全绿为硬门 |

## 10. 与 `10-20-unify-acp-model-selection` 的关系

两者都碰「模型」，但层次不同、互不冲突：

- ACP 任务：模型能力挂在**协议层**（ACP `configOptions`），改 `acp.rs` / `acp_config.rs`；
- 本任务：serve 的**传输层**双栈，`OpencodeCatalog` 仍实现 `ModelCatalog` trait，接口不变。

本任务**不得**引入 `if agent_id == "opencode"`，也不得改动 `list_agent_models` 的分派结构。
