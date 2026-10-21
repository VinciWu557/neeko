# opencode 1.x / 2.x 双栈 — 执行计划

> 设计依据：`design.md`。协议证据：`research/opencode-2x-protocol.md`。
> 原则：**每阶段独立可编译、可测试、可回滚**。不出现「跨阶段才能编译通过」的中间态。

## 阶段 0：前置检查

- [ ] 读 `src-tauri/AGENTS.md`（后端红线）
- [ ] 确认 Rust 基线全绿：`pnpm test:rust`（记录通过数，用于阶段末对比）
- [ ] 确认静态检查基线：`pnpm lint_rust:all-targets`
- [ ] 确认手边有两个二进制：
      `opencode --version` → `opencode v2.0.32`；`/opt/homebrew/bin/opencode --version` → `1.19.0`
- [ ] 导出 `serve.rs` 现有单测列表（`cargo test --lib agent::chat::adapter::serve -- --list`），
      存为「回归清单」，阶段 1 后逐条比对

**回滚点 0**：无改动。

## 阶段 1：纯搬家（零行为变更）

> 目标：把 1806 行拆成 `serve/` 目录，**一行逻辑都不改**。这是后续所有工作的安全底座。
> 判据：`cargo test --lib agent::chat` 与阶段 0 的回归清单逐条一致、全绿。

### 1.1 建目录骨架

- [ ] `mkdir src-tauri/src/agent/chat/adapter/serve/`
- [ ] `git mv src-tauri/src/agent/chat/adapter/serve.rs src-tauri/src/agent/chat/adapter/serve/pump.rs`
      （先整体移过来，再按段落切分；避免「写到一半不可编译」）
- [ ] 新建 `serve/mod.rs`：仅 `mod` 声明 + `pub use`（红线 9）
      ```rust
      mod connection;
      mod events_v1;
      mod protocol;
      mod pump;
      mod request;
      mod session;

      pub use connection::ServeConnection;
      pub use protocol::{detect_protocol, ServeProtocol};
      pub use session::{OpencodeCatalog, ServeAdapter};
      ```
      注：`session.rs` 依赖 `request.rs` / `pump.rs` 的内部符号 → 相关项用 `pub(crate)`
      仅对同目录可见（`pub(super)`），不扩大 crate 公开面。

### 1.2 按段落切分（每切一刀编译一次）

| 目标文件 | 搬移内容（现行号） |
| --- | --- |
| `protocol.rs` | `model_slug_split` / `model_body` / `prompt_body` / `session_create_body` / `session_create_url`（56–120） |
| `events_v1.rs` | `ServeEvent` / `PartKind` / `translate_event` / `translate_part_delta` / `translate_part_updated` / `translate_tool` / `tool_title` / `command_from_input` / `translate_todo_updated` / `translate_permission_asked` / `translate_question_asked`（123–532） |
| `connection.rs` | `ServeConnection` / `SERVE_CONNECTION` / `serve_connection` / `start_serve` / `read_listening_url` / `extract_listening_url` / `drain_forever`（537–635） |
| `request.rs` | `post_serve` / `ServeScope` / `run_request_loop` / `event_stream_url` / `question_reply_url` / `open_sse`（866–1165） |
| `pump.rs` | `run_event_pump` / `process_buffered_lines`（923–1044） |
| `session.rs` | `ServeAdapter` / `attach_streaming` / `ServeSession` / `impl AgentSession` / `impl AgentAdapter` / `OpencodeCatalog`（639–1806 中的会话与适配器部分） |

- [ ] 每切一个文件：`cargo build -p neeko` + `cargo test --lib agent::chat`
- [ ] 单测随被搬函数一起搬（`#[cfg(test)] mod tests` 可留在各文件末尾，按被测函数归位）
- [ ] 测试辅助函数（`sse_event` 等）抽到 `serve/tests_support.rs`（`#[cfg(test)]` 模块），
      避免测试域内跨文件重复

### 1.3 保持对外路径不变

- [ ] `adapter.rs:20` 仍是 `pub use serve::ServeAdapter;`（目录模块天然满足）
- [ ] `grep -rn "adapter::serve::" src-tauri/src` 应无新增外部引用

**验证**：`pnpm test:rust` + `pnpm lint_rust:all-targets`
**回滚点 1**：单个 commit，`git revert` 即回到今天（仍只支持 1.x）。

## 阶段 2：就绪握手双兼容（AC1/AC2）

> 这一步单独上线就有价值：**至少让 Neeko 能启动 2.0 的 serve 并看到 URL**，
> 后续失败会从「10 秒静默超时」变成「具体 HTTP 错误」。

### 2.1 TDD：先写失败测试

`serve/protocol.rs`（或 `connection.rs`）内：

- [ ] `extract_listening_url_accepts_both_prefixes`
      ```rust
      assert_eq!(extract_listening_url("opencode server listening on http://127.0.0.1:57775"),
                 Some("http://127.0.0.1:57775".into()));   // 1.19
      assert_eq!(extract_listening_url("server listening on http://127.0.0.1:60656"),
                 Some("http://127.0.0.1:60656".into()));   // 2.0
      assert!(extract_listening_url("loading config...").is_none());
      assert!(extract_listening_url("Warning: OPENCODE_SERVER_PASSWORD is not set").is_none());
      ```
- [ ] `extract_server_password_reads_second_line`（`server password abc` → `Some("abc")`；
      `Warning: …` / 空串 → `None`）
- [ ] 确认 Red（旧 `MARKER` 实现让 2.0 行断言失败）

### 2.2 实现

- [ ] `extract_listening_url`：`"listening on "` 定位 + `starts_with("http")`（设计 §3.2）
- [ ] 新增 `extract_server_password`
- [ ] `core/exec.rs` 新增 `spawn_with_env`（设计 §3.1，薄封装到 `spawn_target` + `with_env`）
- [ ] `start_serve`：
  - 生成 `uuid::Uuid::new_v4().simple().to_string()` 作为密码
  - `exec::spawn_with_env(..., &[("OPENCODE_SERVER_PASSWORD", &pwd)])`
  - 读 URL 后**再看最多 2 行**取 password（兜底；注入失败时用）
  - `reqwest::Client::builder().default_headers(basic_auth("opencode", pwd))`
- [ ] `ServeConnection` 增加 `password: Option<String>`

**验证**：`cargo test --lib agent::chat` + 手测
`RUST_LOG=debug pnpm tauri dev` 后发起一次 chat，日志应出现
`[ServeAdapter] serve listening at http://…` 且**不再**每 10s 重试。

**回滚点 2**：此时 V1 行为不变、V2 至少能握手。

## 阶段 3：协议探测（AC3）

- [ ] TDD：`detect_protocol` 表驱动测试
      ```rust
      assert_eq!(detect_protocol(200, "application/json"), ServeProtocol::V2);
      assert_eq!(detect_protocol(200, "text/html"), ServeProtocol::V1);      // 1.19 的 SPA 回落
      assert_eq!(detect_protocol(401, "application/json"), ServeProtocol::V1); // 探测失败按 V1
      assert_eq!(detect_protocol(404, ""), ServeProtocol::V1);
      ```
- [ ] 实现 `detect_protocol`（设计 §2）
- [ ] `start_serve` 在拿到 client 后 `GET /api/info` 探测，写入 `ServeConnection.protocol`
- [ ] 探测失败 → `V1` + `log::warn!`（不降级到 V2）
- [ ] **一次性回退**：V2 判定后若建会话返回 404/405，降级为 V1 并**只重试一次**（设计 §9）

**验证**：`cargo test --lib agent::chat`；两版二进制各跑一次并断言日志中的 protocol。

## 阶段 4：V2 端点 + 建会话（AC4/AC8 前半）

- [ ] `ServeProtocol` 增补端点方法（设计 §4）：`session_create_path` / `prompt_path` /
      `event_path` / `abort_path` / `permission_reply_path` / `question_reply_path` /
      `session_get_path` / `models_path`
- [ ] TDD：每条 URL 构造一个断言（v1 与 v2 各一组，共 16 条）
- [ ] `session_create_body` 按协议分叉：
  - v1：`{"title", "permission":[{permission,pattern,action}]}`
  - v2：`{"title", "location":{"directory"}, "permissions":[{action,resource,effect}]}`
- [ ] `session_create_url` 按协议分叉：v1 带 `?directory=`，v2 不带
- [ ] `create` 解析响应：v1 直接 `.id`；v2 `.data.id`
- [ ] **回读校验**（v2）：`GET /api/session/{id}` 断言 `location.directory ≈ ctx.project_id`
      且 confirm 模式下 `permissions` 非空；不满足 → `WARN` + `Capabilities.approvals=false`

**验证**：`cargo test --lib agent::chat`；手测 2.0 下建会话成功且 `directory` 正确。

## 阶段 5：V2 事件翻译（AC5/AC6/AC7）

- [ ] `events_v2.rs` 骨架：`translate(session_id, raw, state) -> Vec<StreamEvent>`
- [ ] `ProbeState` 增加 `tool_names: HashMap<String, String>`（v2 用）
- [ ] TDD（**样本取自 `research/opencode-2x-protocol.md` §4.1 的逐字 JSON**）：
  - `session.text.delta` → `TextDelta{delta}`
  - `session.reasoning.delta` → `ReasoningDelta{delta}`
  - `session.tool.input.started` → 空 vec（只记名字）
  - `session.tool.called` → `ToolStart{name: 缓存名, title: input.path}`
  - `session.tool.success` → `[ToolOutput, ToolEnd{"done"}]`
  - `session.tool.failed` → `[ToolOutput, ToolEnd{"failed"}]`
  - `session.execution.succeeded` → `TurnEnd{Completed}`
  - `session.execution.failed` → `TurnEnd{Error}`
  - `session.execution.interrupted` → `TurnEnd{Stopped}`
  - `session.error` → `Error{Agent}`
  - `todo.updated` 之类 v1 事件在 v2 下 → 空 vec（不得误命中）
- [ ] `pump.rs` 的 `translate` 按 `protocol` 分派（设计 §5）
- [ ] `session_of(raw)`：v1 读 `properties.sessionID`；v2 读 `data.sessionID`；
      v2 额外用 `location.directory` 做二级过滤（设计 §6）
- [ ] `open_sse`：v1 带 `?directory=`；v2 不带

**验证**：`cargo test --lib agent::chat`；手测 2.0 下流式文本与工具卡片都能渲染。

## 阶段 6：V2 回执（AC8 后半 / AC9 / AC10 / AC11）

- [ ] 权限回执：v1 `{response}`；v2 `{decision}`；端点按协议
      （v2 `POST /api/session/{id}/permission/{rid}/reply`）
- [ ] 权限事件：`events_v2::translate_permission_asked`
      （`action` → `tool`，`resources.join(" ")` → `title`，`metadata.files[0].patch` → `diff`）
- [ ] 提问：`form.created`（`metadata.kind=="question"`）→ `UserInput`；
      回执 v2 `{answer:{"<fieldKey>": text}}`，`turn_id` 用 `form.id`
- [ ] 模型：`SessionRequest::Turn{model_id}` 在 v2 下**先** `POST /api/session/{id}/model`
      再 `POST …/prompt`（v2 的 prompt 无 model 字段）
- [ ] 中止：v1 `/abort`，v2 `/interrupt`
- [ ] `post_serve` 的 HTML 回落判定保留（v2 正确响应是 `204` / `200 application/json`）

**验证**：`cargo test --lib agent::chat`；手测：
- 2.0 confirm 模式点一次审批（允许/拒绝各一次）
- 2.0 让模型调 question 工具并作答
- 2.0 切模型后发 prompt，`session.step.started.data.model` 与所选一致

## 阶段 7：resume 存在性（AC12）

- [ ] TDD：注入式 `probe_session_exists`（不启真进程）——
      v2 `404` → `false`；`200 {"data":…}` → `true`；v1 `200` 裸对象 → `true`
- [ ] `resume` 先探测，不存在 → `AppError::NotFound("native session … not found (opencode >= 2.0 迁移后不可 resume)")`
- [ ] 错误信息要让用户看懂「不是网络问题，是会话没迁过来」

**验证**：`cargo test --lib agent::chat`；用真实库里的 1.x id 手测一次，得到 NotFound 而非挂起。

## 阶段 8：模型列表双栈（AC13）

- [ ] TDD：`models_from_api`（`GET /api/model` 的两种响应形状都要能解：
      1.19 的 `data[].id` + 2.0 的 `data[].modelID`，两者都有 `providerID`/`name`）
- [ ] `OpencodeCatalog::list` 新顺序：`/api/model` → `models --verbose`（仅 v1）→ `models`
- [ ] `model_discovery.rs` 增加 `discover_opencode_models_plain`（不带 `--verbose`）
- [ ] 断言：v2 下**不**调用 `models --verbose`（用注入式 fetcher 断言调用参数）

**验证**：`cargo test --lib agent`；手测 2.0 下设置页/聊天里的模型列表非空。

## 阶段 9：收尾

- [ ] `pnpm check`（唯一一次全量）+ `pnpm check:quick`
- [ ] 两端到端验收（AC15）：1.19.0 与 2.0.32 各跑一次「prompt → 流式 → 审批」
- [ ] 同步 spec：新增 `.trellis/spec/backend/agent-chat-serve-dual-stack.md`
      （协议矩阵、探测判据、禁止模式：「不得用版本号字符串分派」「不得只判状态码」）
- [ ] `.trellis/spec/backend/index.md` 加索引行
- [ ] 记录会话：`python3 ./.trellis/scripts/add_session.py --title "…" --commit "<hash>"`
- [ ] **不主动提交代码**

## 阶段依赖

```
0 ─▶ 1 ─▶ 2 ─▶ 3 ─▶ 4 ─▶ 5 ─▶ 6 ─▶ 7 ─▶ 8 ─▶ 9
                 └────────────┴────┴────┘
                    (4/5/6 强相关，须连续完成)
```

- 阶段 2 独立可上线（修掉「完全不可用」）
- 阶段 3 是 4–8 的前置
- 阶段 7、8 可并行（互不依赖）

## 变异验证清单（每阶段末自问）

| 变异 | 期望失败 |
| --- | --- |
| 把 `extract_listening_url` 的 MARKER 改回 `"opencode server listening on "` | AC1 的 2.0 断言红 |
| 把 `detect_protocol` 改成只看 `status == 200` | AC3 的 `text/html` 断言红 |
| 把 v2 建会话的 `location` 改回 `?directory=` | AC4 手测（directory 落成 serve cwd） |
| 把 v2 的 `permission` 字段名写成 `permission` | AC8 回读校验报 WARN / `approvals=false` |
| 把 `session.execution.succeeded` 当 `Failed` | AC7 断言红 |
| 在 v2 上调用 `models --verbose` | AC13 的「不许调用」断言红 |

## 显式不做（防止范围蔓延）

- 不改 `conversation/adapters/opencode.rs` 的 `session_v2`（另开任务，PRD P5）
- 不改前端任何文件
- 不接管 `opencode service`（managed service）生命周期
- 不为 v2 伪造 `todo.updated`
