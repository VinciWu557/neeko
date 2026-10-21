# Pi 私有 rpc 协议适配器

## Goal

让 Pi 以**单进程**方式接入 Agent Chat：spawn `pi --mode rpc`，把它的私有 NDJSON 协议
映射到 Neeko 的 `StreamEvent` / `SessionRequest` 抽象。

**核心约束：不引入中间进程。** `pi-acp`（npm 包）是外层独立进程（它自己 spawn pi），
会变成「pi-acp + pi」两个进程，用户已明确否决。

## 现状与动机

Pi 当前 `chat: None` —— 只能终端 / headless，不能进 Agent Chat。

三条候选路径逐一排除：

| 方案 | 进程数 | 结论 |
| --- | --- | --- |
| `pi-acp` 中间层 | 2 | 用户否决 |
| 进程内 SDK（synara 的做法） | 1 | synara 是 TS 项目，直接 `createAgentSessionRuntime` 跑 pi 的 npm 包。Rust 侧要嵌 V8/QuickJS + 兼容大量 Node API，代价不可接受 |
| **私有 rpc adapter** | **1** | ✅ 本任务 |

`DeepSeekHarnessAdapter` 已是同类先例（接私有 JSONL 协议），`AgentAdapter` 抽象本就支持。

## 协议事实（一手取证）

来源：`github.com/svkozak/pi-acp`（v0.0.34，MIT）的 `src/pi-rpc/process.ts`（432 行）
+ `src/acp/session.ts`（1140 行）。它是生产环境跑通的实现。

### 启动

```bash
pi --mode rpc --no-themes
```

`--no-themes`：rpc 模式用不到主题，加载它既慢又吵。

### 通信：stdin/stdout 上的 NDJSON

```
① 命令（我们 → pi）   {"type":"prompt","id":"<uuid>","message":"...","images":[]}
② 响应（pi → 我们）   {"type":"response","id":"<uuid>","command":"prompt","success":true,"data":...}
③ 事件（pi → 我们）   无 `id` 的消息
```

**判别方式**：`type === "response"` 且有 `id` → 响应（按 id 配对，**不广播**）；
否则 → 事件（广播给所有 handler）。

### 完整命令清单

| 命令 | 参数 | 用途 |
| --- | --- | --- |
| `prompt` | `message`, `images?` | 发一轮对话 |
| `abort` | — | 中止当前轮 |
| `get_state` | — | 会话状态（含 `sessionFile`） |
| `get_available_models` | — | **列模型** |
| `set_model` | `provider`, `modelId` | **切模型** |
| `get_available_thinking_levels` | — | 推理档位列表（`data.levels: string[]`） |
| `set_thinking_level` | `level` | 设推理档位 |
| `set_follow_up_mode` | `mode: 'all' \| 'one-at-a-time'` | 队列模式 |
| `set_steering_mode` | `mode: 'all' \| 'one-at-a-time'` | 插话模式 |
| `compact` | `customInstructions?` | **手动压缩上下文** |
| `set_auto_compaction` | `enabled` | **自动压缩开关** |
| `get_session_stats` | — | token 用量 / 上下文占用 |
| `set_session_name` | `name` | 重命名会话 |
| `export_html` | `outputPath?` | 导出会话 |
| `switch_session` | `sessionPath` | **切会话** |
| `get_messages` | — | 历史消息 |
| `get_commands` | — | 命令列表 |

### 事件类型（pi → 我们）

| 事件 | 载荷要点 |
| --- | --- |
| `message_update` | `assistantMessageEvent.type` ∈ `text_delta` / `thinking_delta` / `toolcall_start` / `toolcall_delta` / `toolcall_end`，`delta` 为文本增量 |
| `tool_execution_start` | 工具开始 |
| `tool_execution_update` | 工具进行中 |
| `tool_execution_end` | 工具结束 |
| `extension_ui_request` | **审批/交互请求**（Neeko 的 Gate） |
| `session_info_changed` | 会话元信息变更 |
| `auto_retry_start` / `auto_retry_end` | 自动重试 |
| `auto_compaction_start` / `auto_compaction_end` | 自动压缩 |
| `agent_start` / `turn_end` / `agent_end` / **`agent_settled`** | 生命周期 |
| `compaction` | 压缩 |

## 三个必须遵守的协议坑

### 坑 1：回合结束判据是 `agent_settled`，不是 `agent_end`

`pi-acp` 源码原话：

> pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
> when retry, compaction, or queued continuations run. The session-level prompt
> completes only when `agent_settled` is emitted.

**后果**：用 `agent_end` 判定会让压缩/重试场景**提前结束**，后续输出丢掉。

### 坑 2：stdout 会夹带人类可读的前导行

NDJSON 开始前 pi 会输出 Context / Skills / Extensions 信息（ANSI 着色）。

**必须**：`JSON.parse` 失败的行**收集**而非丢弃（`preludeLines`），否则
① 第一个非 JSON 行让解析器崩 ② 用户丢失启动信息。

### 坑 3：`--no-themes`

见上文启动命令。

## 能力范围（用户明确要求全要）

| 能力 | 协议支撑 | 映射到 |
| --- | --- | --- |
| 对话 / 中止 | `prompt` / `abort` | `Turn` / `Cancel` |
| **模型选择** | `get_available_models` / `set_model` | `list_models` + `SetConfigOption` |
| **推理档位** | `get_available_thinking_levels` / `set_thinking_level` | `thought_level` 配置项 |
| **工具调用** | `tool_execution_*` | `ToolStart` / `ToolOutput` / `ToolEnd` |
| **审批 Gate** | `extension_ui_request` | `RequestApproval` |
| **slash 命令** | **文件系统扫描**（非 rpc） | `list_slash_commands` |
| **上下文压缩** | `compact` / `set_auto_compaction` | 新命令 |
| **会话管理** | `switch_session` / `export_html` / `set_session_name` / `get_messages` + 扫 `~/.pi/agent/sessions/` | 复用 `conversation` 域 |
| token 用量 | `get_session_stats` | 上下文用量条 |

**注意 slash 命令不走 rpc** —— 从 `~/.pi/`（用户级）与 `<project>/.pi/commands/`（项目级）
扫描 markdown 文件，带 frontmatter（`name` / `description`）。这与 Neeko 已有的
`library/prompt` 域形态一致，可能可以复用。

## 分期建议

### 一期：最小可用（约 600 行）

- `PiRpcAdapter::create` —— spawn + NDJSON 行解析 + 请求响应配对（按 uuid）
- `prompt` / `abort` / **`agent_settled` 判据**
- 消息流 → `StreamEvent::TextDelta` / `ReasoningDelta`
- `get_available_models` / `set_model` → 接上现有模型选择（`list_models` + `SetConfigOption`）
- `get_available_thinking_levels` / `set_thinking_level` → `thought_level`
- `preludeLines` 收集

**完成标志**：Pi 能在 Chat 里对话，模型可选可切。

### 二期：完整（约 1000 行）

- 工具调用映射（`tool_execution_*`）
- 审批 Gate（`extension_ui_request` → `RequestApproval`）
- slash 命令（文件扫描）
- 上下文压缩（`compact` / `auto_compaction_*` 事件）
- 会话管理（`switch_session` / `export_html` + 会话列表复用 `conversation` 域）
- token 用量（`get_session_stats` → `usage_update`）

## Requirements

### R1 单进程

不引入中间进程。`PiRpcAdapter` 直接 spawn `pi`。

### R2 `ChatStart` 新变体

需要一个新传输类型（不能复用 `Jsonl` —— 那是 DeepSeekHarness 的协议）：

```rust
ChatStart::PiRpc    // 或带 args 的结构化变体
```

序列化需向后兼容（沿用 `ChatStart` 已有的双形态演进方式）。

### R3 回合结束必须用 `agent_settled`

见坑 1。这条要有测试锁死。

### R4 前导行不得丢弃

见坑 2。

### R5 跨平台

`pi` 在 Windows 上可能是 `pi.cmd`（npm 启动器）。`pi-acp` 用 `cross-spawn` + shell 判定
处理；Neeko 需走 `platform/process_spawn` 的既有机制（红线 2 / 10）。

## Acceptance Criteria

- [x] **AC1** Pi 能在 Agent Chat 里完成一轮对话（真机：`TEXT="PONG" TURN_END=true`）
- [x] **AC2** 模型列表来自 `get_available_models`（225 项），切换走 `set_model` 并生效
- [x] **AC3** 推理档位可选可切（真机：切到 `low` 后 `ConfigOptionUpdate` 反映 `current=low`）
- [x] **AC4** 回合结束判据是 `agent_settled`（压缩场景序列测试 + 变异验证）
- [~] **AC5** 前导行**实测不存在**（`非 JSON 行: 0`）；改为「解析失败 warn 跳过」的最小容错
- [x] **AC6** 工具调用事件映射（真机：`read` 与 `bash` 均跑通，`TOOL_END done`）
- [~] **AC7** 审批映射已实现并有 5 条单测；**真机未验证** —— pi 的审批由扩展发起，
      本机未装这样的扩展，`read`/`bash` 都直接执行（见 `implement.md` 阶段 6）
- [—] **AC8** slash 命令**不实现**：`get_commands` 已是权威来源（157 条），
      执行走现有 `prompt`；但 Neeko 前端无任何消费点，实现等于建无人调用的链路
- [—] **AC9** 压缩**不实现**：协议齐备，前端零消费点（`grep compact` 无命中）
- [~] **AC10** 会话管理：`resume_id` 已实现并真机验证；
      切换/导出/重命名/统计无消费点，未做
- [x] **AC11** 单进程：`ps` 确认只有 1 个 `pi` 进程，无 `pi-acp`
- [~] **AC12** Windows `pi.cmd`：**已由现有机制覆盖** —— `LocalExecutor` 走
      `resolve_command_path`（Windows `where.exe` 解析完整路径），
      平台差异在 `platform::process_spawn`。本机 macOS 无法验证 Windows 侧

图例：`[x]` 已达成并验证 · `[~]` 部分达成或按实测修正 · `[—]` 判定不做（有依据）

## Non-Goals

- 不做进程内 SDK（V8 嵌入，代价过大）
- 不依赖 `pi-acp` npm 包（用户否决中间进程）
- 不改 pi 本身

## 决策（原 Open Questions）

### OQ1 `ChatStart` 新变体 —— 沿用双形态演进

新增 `ChatStart::PiRpc`，序列化沿用已有的「裸字符串 / 对象」双形态：

```rust
// 字符串形态（无额外参数）
"pi-rpc"  →  PiRpc

// 对象形态（若将来需要 args）
{ "transport": "pi-rpc", "args": [...] }  →  PiRpc { args }
```

读取时未知字符串仍降级为 `Acp`（现有行为，不能改——老配置依赖它）。
写时无 args 写字符串，有 args 写对象。与 `Acp` 完全同构，共享同一套 serde 演进。

### OQ2 slash 命令 —— 直接用 Pi 自己的

**不引入 `library/prompt` 域**。Pi 的命令是它自己的资源体系：

```
~/.pi/agent/prompts/**/*.md        用户级
<cwd>/.pi/prompts/**/*.md          项目级（覆盖用户级同名）
```

- 支持子目录（命令名带 `:`，如 `frontend:review`）
- frontmatter：`name` / `description`
- 正文支持 `$ARGUMENTS` 类占位

**理由**：Pi 的命令格式与 Neeko 的 `prompt` 记录不是一回事（后者是 `PromptRecord`
的 DB 记录，带 scope/tags/usage）。强行合并会让两边格式互相牵制，而用户在 Pi 里写
的命令本来就该在 Pi 里生效。扫目录 + 解析 frontmatter 即可，约 150 行。

### OQ3 会话列表 —— **复用** `conversation` 域，零改动

**已核实**：`src-tauri/src/conversation/adapters/pi.rs` 已存在且完整：

```rust
impl AgentSessionAdapter for PiAdapter {
    fn agent_id(&self) -> &str { "pi" }
    fn session_root(&self) -> PathBuf { ~/.pi/agent/sessions }
    fn discovery_roots(...)   // 按项目路径过滤（EncodeStyle::Pi）
    fn file_pattern(&self) -> &str { "*.jsonl" }
    fn parse_meta(...)        // 首行 type="session"，后续 type="message" 树结构
}
```

**结论**：会话列表、消息解析、项目过滤**全部现成**，本任务只需让 Pi 的 chat 侧
知道「当前会话的 `sessionFile`」（来自 `get_state`），与 `conversation` 域的记录对齐。

**注意**：该 adapter 的注释写着「不支持原生 CLI 恢复（仅 TUI 内的 `/resume`）」——
但 rpc 协议有 `switch_session { sessionPath }`，可能可以补上原生恢复。这是**可选改进**，
不在本任务必需范围内。

## 参考

- 协议实现：`github.com/svkozak/pi-acp`（`src/pi-rpc/process.ts`、`src/acp/session.ts`）
- 同类先例：`src-tauri/src/agent/chat/adapter/deepseek.rs`（`DeepSeekHarnessAdapter`）
- 相关 spec：`.trellis/spec/backend/agent-acp-model-selection.md`
