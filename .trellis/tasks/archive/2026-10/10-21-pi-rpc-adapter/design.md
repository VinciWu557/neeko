# Pi 私有 rpc 协议适配器 — 技术设计

> 前置：`prd.md`（协议事实一手取证，含三个必踩的坑）。
> 本文只写**结构与取舍**，不复述协议细节。

## 1. 落点：与 `DeepSeekHarnessAdapter` 同构

现有 `AgentAdapter` 抽象已经容纳了「私有 JSONL 协议」这一形态：

```
src-tauri/src/agent/chat/adapter/
├── acp.rs        ACP（标准协议，子进程）
├── serve.rs      opencode serve（HTTP + SSE）
├── deepseek.rs   DeepSeek Harness（私有 NDJSON）  ← 先例
└── pi_rpc.rs     本任务
```

**不做新抽象**。`AgentAdapter` / `AgentSession` / `StreamEvent` / `SessionRequest`
四个已有契约足够，`pi_rpc.rs` 只负责协议翻译。

## 2. 模块划分

```
src-tauri/src/agent/chat/adapter/pi_rpc/
├── mod.rs           PiRpcAdapter + PiSession（impl 两个 trait）
├── process.rs       spawn + NDJSON 行读写 + 请求/响应配对
├── translate.rs     事件翻译（pi event → StreamEvent）
├── commands.rs      命令构造（强类型，替代裸 json!）
└── slash.rs         slash 命令文件扫描（~/.pi/agent/prompts + <cwd>/.pi/prompts）
```

**为什么拆目录而不是单文件**：`deepseek.rs` 是 900+ 行的单文件，已经偏大。
Pi 的协议面更宽（18 条命令 + 13 种事件），单文件会失控。

`mod.rs` 按红线 9 保持极薄（只 `mod` 声明 + `pub use` + 两个 trait impl 的最小转发）。

## 3. 进程层：请求/响应配对

`pi-acp` 的做法直接移植：

```rust
struct PiRpcProcess {
    child: Child,
    stdin: ChildStdin,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<PiRpcResponse>>>>,
    prelude: Arc<Mutex<Vec<String>>>,       // 见坑 2
    event_tx: mpsc::Sender<PiRpcEvent>,
}
```

**读循环**（一个 tokio task）：

```
每一行 →
  serde_json 解析失败？
    是 → prelude 收集（strip ANSI），continue        ← 坑 2
    否 → type == "response" 且有 id？
           是 → pending 表里取出 sender，send，**不广播**
           否 → 广播给事件处理器
```

**写**：`{"...cmd...", "id": uuid}` + `\n`，插入 pending 表，带超时（辅助命令用
1s，`prompt` 不用超时——它等到 `agent_settled`）。

**id 生成**：复用已有依赖 —— `Cargo.toml:28` 已有 `uuid = { version = "1.6", features = ["v4"] }`。
不新增依赖。

## 4. 事件翻译：`agent_settled` 是唯一终止信号（坑 1）

这是本任务**最容易做错**的一点。状态机：

```
prompt 发出
  → agent_start
  → message_update*  (text_delta / thinking_delta → TextDelta / ReasoningDelta)
  → tool_execution_* (若二期)
  → auto_compaction_* / auto_retry_*   ← 会插在中间
  → turn_end / agent_end               ← **不是终止信号**，可能多次
  → agent_settled                      ← **唯一终止信号**
```

`PiSession::next()` 返回 `Some(Ok(TurnEnd))` 的判据**只能是 `agent_settled`**。

**测试**：构造一个「`agent_end` → `auto_compaction_start` → `agent_end` → `agent_settled`」
的事件序列，断言 `next()` 只在最后一个之后返回 `TurnEnd`。变异验证：改成 `agent_end`
判据，该用例必须变红。

## 5. 模型与推理档位：如何接上现有 UI

上一任务已建立两条通道，Pi 两者都能填：

| 通道 | Pi 的实现 |
| --- | --- |
| **会话外列表**（`list_models`） | `model_list_args: ["--list-models"]` —— **已落地**，197 个模型 |
| **会话内切换** | `set_model { provider, modelId }` |

`set_model` 需要 `provider` 与 `modelId` **分开传**。

**实测修正（pi 1.3.0）**：`get_available_models` 返回**结构化对象**，`provider` 已是独立字段：

```json
{"models":[{"id":"deepseek-flash","name":"…","provider":"deepseek",
            "contextWindow":…,"reasoning":true,"thinkingLevelMap":{…}}]}
```

198 个模型全部自带 `provider`，所以直接传 `{provider: m.provider, modelId: m.id}`，
**不需要拆 slug、不需要 `model_slug_split`**。

> 初版设计想复用 `serve.rs` 的 `model_slug_split`，那是 opencode HTTP 传输的需求
> （它的模型 id 是 `provider/model` 复合串）。Pi 用不上 —— **不动 `serve.rs`**。

推理档位：`get_available_thinking_levels` → `data.levels: string[]`，
`set_thinking_level { level }`。接到 `thought_level` 配置项
（`SessionConfigOption` 的 `category: "thought_level"`），复用已有的
`ConfigOptionsState` + `ModelConfigSection` 渲染。

**档位是动态的**：实测返回 `["low","high","max"]`，且当前模型的 `thinkingLevelMap`
决定哪些可用（`medium` / `minimal` 为 `null` = 不支持）。所以**每次切模型后要重新拉档位**，
不能缓存一次用到底。

**这里可以复用 `acp_config::ConfigOptionsState`** —— 它只依赖
`SessionConfigOption` 数据结构，与传输无关。

## 6. `ChatStart` 新变体

```rust
pub enum ChatStart {
    Acp { args: Vec<String> },
    Serve, Jsonl, Mock,
    PiRpc,       // 新增
}
```

序列化：`as_str()` 返回 `"pi-rpc"`。反序列化：字符串 `"pi-rpc"` → `PiRpc`。
其余沿用现有双形态（OQ1 决策）。

**向后兼容检查**：现有 `Deserialize` 的 `_ => Self::Acp { args }` 兜底意味着
`"pi-rpc"` 目前会被当成 `Acp`。新增分支必须放在兜底**之前**，否则永远命中不到。

## 7. 跨平台（红线 2 / 10）

Windows 上 npm 全局包通常是 `pi.cmd`。`pi-acp` 用 `cross-spawn` + shell 判定处理。

Neeko 侧：走 `platform::process_spawn::apply_child_flags`（已有机制，LocalExecutor
内置）。spawn 时用 `exec::spawn`，它会按平台选 shell——**不硬编码 `sh -c`**。

判定「是否需要 shell」：若 `command` 以 `.cmd` / `.bat` 结尾，Windows 下需要 shell。
这条逻辑落 `platform/`，不在通用文件里平铺 `#[cfg]`。

## 8. slash 命令（OQ2 决策：用 Pi 自己的）

```
~/.pi/agent/prompts/**/*.md     用户级
<cwd>/.pi/prompts/**/*.md       项目级（同名覆盖用户级）
```

解析：
- 子目录 → 命令名前缀（`frontend/review.md` → `frontend:review`）
- frontmatter（`---` 包围的 `key: value`）取 `name` / `description`
- 正文是 prompt 模板

**不接 `library/prompt` 域**：那是 neeko 的 DB 记录（scope/tags/usage_count），
和 Pi 的 markdown 文件不是一回事。合并会让两边互相牵制。

**放哪**：`pi_rpc/slash.rs`，产出 `Vec<SlashCommand>`。是否要暴露成 Tauri 命令
（给前端补全用）是二期的事，一期只需能列出来。

## 9. 上下文压缩

| 触发 | 协议 |
| --- | --- |
| 手动 | `compact { customInstructions? }` |
| 自动开关 | `set_auto_compaction { enabled }` |
| 事件 | `auto_compaction_start` / `auto_compaction_end` |

用户要求「上下文压缩」可用 → 至少要有**手动触发**与**自动开关**两个入口。

这三个都是新命令，需要在 `SessionRequest` 加变体（或复用一条通用的
`PiRpcCommand` 透传）。**倾向加具体变体**：`SessionRequest` 已有 9 个变体，
再透传会破坏类型安全。

## 10. 会话管理（OQ3 决策：复用 `conversation` 域）

**列表/解析/过滤全部现成**（`conversation/adapters/pi.rs`）。
本任务不碰 `conversation` 域，只需：

1. 会话建立后从 `get_state` 拿 `sessionFile`，存进会话状态；
2. 把它与 `conversation` 域的 `{agent_id}:{native_id}` 记录对上（native_id 从
   sessionFile 的文件名或首行 `type:"session"` 提取）；
3. `switch_session { sessionPath }` 支持切到历史会话。

**可选改进**（不做也行）：`PiAdapter` 注释说「不支持原生 CLI 恢复」，但
`switch_session` 存在 → 可能可以补上 `resume_command`。留作后续。

## 11. 分期与依赖

```
一期（最小可用，~600 行）
  process.rs     spawn + NDJSON + 配对 + prelude
  translate.rs   消息流事件（text/thinking delta）
  agent_settled  终止判据 + 测试
  ChatStart      PiRpc 变体
  模型/档位      set_model / set_thinking_level + 复用 ConfigOptionsState
  ↓
二期（完整，~1000 行）
  工具调用       tool_execution_* → ToolStart/Output/End
  审批 Gate      extension_ui_request → RequestApproval
  slash          slash.rs 文件扫描
  压缩           compact / set_auto_compaction
  会话管理       switch_session / get_state → sessionFile
  token 用量     get_session_stats → usage_update
```

**一期末必须真机验证**：Pi 能对话、模型能切。二期可分批。

## 12. 测试策略

| 层 | 做法 |
| --- | --- |
| 纯函数（协议解析） | 单测：喂 JSON 行字符串，断言产出的事件/命令 |
| 事件序列 | 单测：构造事件序列喂状态机，断言 `next()` 的产出顺序与终止点 |
| 进程层 | **mock 一条 duplex 管道**（同 `mockAgent` 的做法），不起真进程 |
| 真机 | 一期结束手测 + 一个 `#[ignore]` 的集成测试 |

**变异验证清单**：
- `agent_end` 当终止判据 → 「压缩场景提前结束」用例必须红
- 前导行解析失败即丢弃 → 「prelude 被收集」用例必须红
- `--no-themes` 去掉 → 没有测试能抓（性能问题），**诚实标注不验证**
- `pi-rpc` 反序列化分支放在兜底之后 → 「字符串 pi-rpc 解析为 PiRpc」用例必须红

## 13. 风险

| 风险 | 缓解 |
| --- | --- |
| pi 的 rpc 协议未文档化，可能变 | 事实来源是 pi-acp 的**生产实现**，不是猜测；协议变更时它对端先坏，我们跟着修 |
| 事件格式复杂（13 种，含嵌套 `assistantMessageEvent`） | 先只映射一期需要的 3 种，其余**原样记录到日志**便于二期补 |
| Windows 上 `pi.cmd` | 走 `platform/` 既有机制；本地只能测 macOS，Windows 由 CI 兜底 |
| `agent_settled` 之外还有别的终止路径？ | 真机验证时打印完整事件序列核对；发现新路径就补 |

## 14. 不做的事

- 不做进程内 SDK（V8 嵌入）
- 不依赖 `pi-acp`
- 不改 `conversation` 域（复用而非改造）
- 不接 `library/prompt` 域（slash 用 Pi 自己的）
- 不做 `set_follow_up_mode` / `set_steering_mode`（队列/插话模式，与 Neeko 交互模型不匹配，留作后续）
