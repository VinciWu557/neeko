# Design — DSH 通知接入（源 A 桥投影）

> 子任务设计。跨子任务契约见父任务 `design.md`（T6–T10）。
> **本设计是条件式的**：Step 0（U7）定案前，§2 有两种分支。
> U7 结论落定后，删掉未选中分支并收紧本文件。

## 1. 为什么 DSH 走源 A 而不是源 B

父任务 T6 推论 1 的展开：

```
源 B（hook）的前提：  事实产生在 Neeko 感知不到的地方 → 需要 CLI 主动上报
DSH 的事实产生地：    dsh-neeko 桥**已经在**归一它（approval.request / question.request）
                      → Neeko 只需消费，不需要「感知」
```

强行把 DSH 塞进源 B（写 hook）会：
- 需要 DSH 有 out-of-process hook 面 —— **它没有**（cordis 是进程内插件）；
- 绕过已有的 `dsh-neeko` 桥，产生第二条重复通道；
- 违反父任务 AC3（无重复实现）。

## 2. 落点地图（按 U7 结论二选一）

### 分支 A（倾向）：DSH 作为一等 Agent（新 adapter）

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `src-tauri/src/agent/builtin/providers.rs` | 扩展 | DSH 的 `AgentConfig`（若现有 `ChatStart::Jsonl` + `DeepSeekHarnessAdapter` 已够则复用，否则新增 `ChatStart` variant） |
| `src-tauri/src/agent/chat/adapter/` | 扩展或复用 | 新 adapter 或复用 `deepseek.rs`（后者已实现 Jsonl stdio 协议） |
| `src-tauri/src/agent/chat/adapter.rs` | 微改 | `adapter_for` 的 match 分支（若新增 variant，编译期强制） |
| `src-tauri/src/agent/chat/notify.rs` | **零改动** | DSH 事件归一为 `StreamEvent` 后自动被既有投影覆盖 |
| `src-tauri/src/notification/**` | **零改动** | AC4 |

**核心优势**：DSH 事件 → `StreamEvent` → 既有 `notify::project` → `NotificationCenter`。
**零新增通知代码**。这正是源 A 架构的收益（`10-12` design.md §2.3 的「新 agent 什么都不做」）。

### 分支 B：独立监听器（`:3081` WebSocket）

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `src-tauri/src/agent/dsh/mod.rs` | **新增** | 域入口（mod + pub use，红线 9） |
| `src-tauri/src/agent/dsh/boot.rs` | **新增** | 域启动入口（与 `agent/hooks/boot.rs` 同形） |
| `src-tauri/src/agent/dsh/listener.rs` | **新增** | WebSocket 客户端（连 `127.0.0.1:3081`） |
| `src-tauri/src/agent/dsh/notify.rs` | **新增** | 事件 → `NotificationSignal` 投影（与 `agent/chat/notify.rs` 同形但不共用） |
| `src-tauri/src/notification/**` | **零改动** | AC4 |

**代价**（必须在 design 记账）：第二条会话来源路径；投影代码重复（不能复用 `notify::project`）；
`instance_id` 需自造（不能复用 Neeko 会话 id）→ 回流（deep link）需额外映射。

**倾向 A 的理由**：B 的成本项全部来自「绕过 adapter 归一」，
而 A 的成本只是「写一个 adapter」（且 `deepseek.rs` 可能已覆盖大半）。

## 3. 数据契约（按结论填充）

```rust
// 分支 A：DSH 事件 → StreamEvent（既有类型，零新增）
// dsh-neeko 协议事件 → StreamEvent 的映射（adapter 内）：
//   approval.request  → StreamEvent::RequestApproval { title, prompt, tool, .. }
//   question.request  → StreamEvent::UserInput { prompt, .. }
//   text.delta        → StreamEvent::TextDelta（不通知）
//   tool.start/end    → StreamEvent::ToolUse*（不通知）
//   （会话结束/错误 → StreamEvent::TurnEnd / SessionDone，待 U7 确认 dsh-neeko 是否送）

// 分支 B：需自定义投影（代价项）
// pub fn project(event: &DshEvent, ctx: &DshNotifyContext) -> Option<NotificationSignal>;
```

## 4. 归属与主题

| 项 | 分支 A | 分支 B |
| --- | --- | --- |
| `instance_id` | Neeko 会话 id（与源 A 一致） | 需自造（`dsh:{session_id}`），回流需映射 |
| `group_label` | `project_name`（来自 `AgentContext`） | 需从 `session.init` 取 |
| `origin_label` | `agent_id`（"dsh"） | 同 |
| `topic` | 首轮 prompt（`SessionNotifyContext::new` 既有逻辑）或 `session.init` 的原生标题 | 需自取 |

**不使用 `attribution.rs`**：那是源 B 的降级链（env → cwd 反查 → basename），
DSH 有完整上下文（`AgentContext` 全知），走降级链是语义降级。

## 5. 红线合规

| 红线 | 落点 |
| --- | --- |
| 1 统一命令执行接口 | 若 adapter 起子进程 → 走 `core::exec`（`deepseek.rs` 已是范例） |
| 3 阻塞 IO | WebSocket/子进程 IO 走 async（分支 B 的 listener 需 `AppRuntime`） |
| 5 Event 名常量化 | 零新增 Tauri 事件（DSH 事件不经 Tauri 事件通道） |
| 9 mod.rs 极薄 | 分支 B 的 `agent/dsh/mod.rs` 仅 mod + pub use |
| 15 差异落数据 | DSH 差异 = adapter 文件或 `dsh/` 域，通用模块零 DSH 分支 |

## 6. 风险

| 风险 | 对策 |
| --- | --- |
| **`:3081` 的实际可用性未验**（`dsh-neeko` 在 Neeko 内零引用，可能是未完成品） | U7 spike 必须真实连接一次；不可用 → 分支 C（登记不实施） |
| 走 B 会产生重复投影代码 | 优先 A；选 B 必须在 design 记录代价 |
| `dsh-neeko` 是独立 npm 包（门禁豁免） | 若需改它 → 另立任务 + 走其 `prepublishOnly` 门禁（不在本任务范围） |
| DSH 版本漂移（`0.2.0-rc.2`，rc 阶段） | 事件名随版本变化风险高；adapter/投影需 fail-open（未知事件忽略） |
| 与 `10-12` 的 DSH 无关联 | `10-12` 完全未涉及 DSH；本任务不能引用它的任何验收 |
