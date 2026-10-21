# Pi 私有 rpc 协议适配器 — 执行计划

> 设计依据：`design.md`。协议事实：`prd.md`（一手取证自 `pi-acp`）。
> 原则：**每阶段独立可编译、可测试、可回滚**。

## 阶段 0：前置检查

- [ ] 读 `src-tauri/AGENTS.md`（后端红线）与 `src/AGENTS.md`（前端红线）
- [ ] 基线：`cargo test --lib` 全绿（当前 1945）
- [ ] 基线：`pnpm check:quick` 全绿
- [ ] 确认 `pi --mode rpc` 在本机可启动（`pi --version`）

## 阶段 1：`ChatStart::PiRpc` 变体

> 没有它，后面所有代码都接不上分派。

- [ ] `common/agent/types.rs`：`ChatStart` 加 `PiRpc` 变体
- [ ] `as_str()` → `"pi-rpc"`
- [ ] `Deserialize`：`"pi-rpc"` → `PiRpc`，**放在 `_ => Self::Acp` 兜底之前**
- [ ] `Serialize`：无 args → 裸字符串（与其它变体一致）
- [ ] `adapter_for`：`Some(ChatStart::PiRpc) => PiRpcAdapter::new(config.cmd_vec())`
- [ ] 测试：
  - 字符串 `"pi-rpc"` 解析为 `PiRpc`（**变异验证**：分支放兜底之后 → 该用例必须红）
  - 往返：`PiRpc` → `"pi-rpc"` → `PiRpc`
  - `adapter_for` 返回 `PiRpcAdapter`

**验证**：`cargo test --lib common::agent` + `cargo test --lib agent::chat::adapter`

**回滚点 1**：新变体不被任何内置 agent 使用，风险为零。

## 阶段 2：进程层（`pi_rpc/process.rs`）

> 协议的地基。这一层错了后面全错。

- [ ] `PiRpcProcess::spawn(command, cwd)`：
  - `pi --mode rpc --no-themes`（**坑 3**）
  - 走 `core::exec::spawn`（红线 1），不直连 `std::process`
  - spawn 失败（ENOENT）给出可操作提示：`pi` 未安装 / 不在 PATH
- [ ] 读循环（tokio task）：
  - 按行读 stdout
  - `serde_json` 失败 → **收集到 prelude**（strip ANSI），continue（**坑 2**）
  - `type == "response"` 且有 `id` → 从 pending 表取 sender，send
  - 其余 → 广播为事件
- [ ] `request(cmd, timeout)`：写 `{...cmd, "id": uuid}` + `\n`，插入 pending 表
  - 辅助命令 1s 超时；`prompt` 不超时（等 `agent_settled`）
  - 超时后从 pending 表移除，避免响应回来时二次 settle
- [ ] `dispose()`：SIGTERM
- [ ] 测试（duplex 管道，不起真进程）：
  - 响应按 id 配对，**不广播**
  - 无 id 的消息作为事件广播
  - 非 JSON 行进入 prelude，不崩
  - 超时后迟到响应不 double-settle

**验证**：`cargo test --lib agent::chat::adapter::pi_rpc`

## 阶段 3：事件翻译 + `agent_settled` 判据（`pi_rpc/translate.rs`）

> **坑 1 是这里**。用 `agent_end` 判定会让压缩场景提前结束。

- [ ] `message_update` → `assistantMessageEvent.type`：
  - `text_delta` → `StreamEvent::TextDelta`
  - `thinking_delta` → `StreamEvent::ReasoningDelta`
  - `toolcall_*` → 一期**只记日志**（二期处理）
- [ ] `agent_start` → 可选（标记 in-flight）
- [ ] `turn_end` / `agent_end` → **不产生 TurnEnd**，只记日志
- [ ] `agent_settled` → `StreamEvent::TurnEnd { reason: Completed }`
- [ ] 未知事件 → `log::debug!` 原样记录（便于二期补）

### 测试（这一层是纯函数，重点覆盖）

- [ ] `text_delta` / `thinking_delta` 各一条
- [ ] **压缩场景序列**：`agent_end` → `auto_compaction_start` → `agent_end` →
      `agent_settled`，断言只在最后产出 `TurnEnd`
      （**变异验证**：改成 `agent_end` 判据 → 必须红）
- [ ] 未知事件不 panic、不产生事件

**验证**：`cargo test --lib agent::chat::adapter::pi_rpc`

**回滚点 2**：到此处 Pi 还不能对话（没有 `create`），但进程层与翻译层可独立测试。

## 阶段 4：`PiSession` + 对话闭环

- [ ] `impl AgentAdapter for PiRpcAdapter`：
  - `kind()` → `AgentKind::Custom`（或复用某个）
  - `create()` → spawn 进程、`get_state` 握手、构造 `PiSession`
  - `supports_model_selection()` → `true`
  - `list_models()` → 默认实现即可（`model_list_args` 已覆盖会话外列表）
- [ ] `impl AgentSession for PiSession`：
  - `next()` → 从事件流取，经 translate 转换
  - `send(Turn { prompt, .. })` → `prompt` 命令
  - `send(Cancel)` → `abort` 命令
  - `send(SetConfigOption)` → `set_model` / `set_thinking_level` 分派
  - `cancel()` → abort + dispose
- [ ] `SessionStart` 事件携带 `configOptions`（模型 + 档位），复用 `acp_config::ConfigOptionsState`
- [ ] **真机验证**：手动跑一轮对话

**验证**：`cargo test --lib` + 真机

**回滚点 3**：到此 Pi 能对话。**这是二期所有工作的基础**。

## 阶段 5：模型与推理档位接线

- [ ] **不用 `model_slug_split`** —— 实测 `provider` 是独立字段，直接 `{provider, modelId}`
- [ ] 档位在**切模型后重新拉取**（动态，与该模型的 `thinkingLevelMap` 相关）
- [ ] `set_model` 命令构造：`provider/model` 拆成 `{provider, modelId}`
- [ ] `get_available_models` → `Vec<ModelInfo>`（确认输出形状，可能需要解析）
- [ ] `get_available_thinking_levels` → `thought_level` 配置项
- [ ] 前端：Pi 在 Chat 里模型可选可切（**应无需改动**——上一任务的通道已通）
- [ ] 真机验证：切模型 → 发消息 → 确认生效

**验证**：真机 + `cargo test --lib`

## 阶段 6：二期 —— 工具调用 + 审批 Gate

- [ ] `tool_execution_start` → `ToolStart`
- [ ] `tool_execution_update` → `ToolOutput`
- [ ] `tool_execution_end` → `ToolEnd`
- [ ] `extension_ui_request` → `RequestApproval`（需确认载荷形状：
      `request_permission` 还是别的 method）
- [ ] `extension_ui_response` 回写
- [x] 真机验证：工具调用（`read` / `bash` 均跑通，`ToolStart`→`ToolOutput`→`ToolEnd done`）
- [x] 审批映射：4 条单测（confirm 允许/拒绝、select 允许/拒绝、未知 id 忽略）
- [!] **审批真机未验证**：pi 的工具审批由**扩展**发起（`extension_ui_request`），
      本机未装发起审批的扩展，`read` / `bash` 都直接执行。映射正确性只能靠单测；
      真机需要装一个会请求确认的扩展后复验。

**验证**：真机（工具调用）+ 单测（审批）

## 阶段 7：二期 —— slash 命令（**结论：不写代码**）

原计划是扫 `~/.pi/agent/prompts/**/*.md` + `<cwd>/.pi/prompts/**/*.md` 并自己解析
frontmatter。实测推翻了它：

- **`get_commands` 已是权威来源**：本机返回 **157 条**，字段
  `{name, description, source, sourceInfo}`，`source ∈ prompt(3) / skill(98) / extension(56)`。
  扫目录只能看到 prompt 文件，会漏掉 skill 与 extension 两类共 154 条。
- **执行不需要新命令**：`prompt` 里带 `/trellis-start` 会被 pi 自己展开（实测触发）。
  所以 slash 走现有 `Turn` 即可。

因此 `slash.rs` **不实现**。要做列表时，加一个 `SessionRequest` / 命令去转发
`get_commands` 的 `data.commands` 即可（约 20 行，无需解析逻辑）。

**阻塞点（不是技术问题）**：Neeko 前端没有任何 slash 列表消费点
（`grep list_slash_commands / SlashCommand` 零命中），`AgentAdapter` 也没有对应能力位。
现在实现等于建一条无人调用的链路 —— YAGNI。

**重新引入的条件**：前端确定 slash 补全的交互位置（输入框？命令面板？）后，
按当时的形状加转发 + 列表 UI。

## 阶段 8：二期 —— 上下文压缩 + 会话管理（**只实现 resume_id，其余无消费点**）

### 已做：`resume_id`（真实消费点）

- [x] 握手时从 `get_state.sessionId` 取，`resume_id()` 返回它
- [x] `Capabilities.resume = true`
- [x] 真机：`RESUME_ID=Some("01a15ced-…")` → 拼成 `pi --session <id>`
- [x] 消费方已存在：`conversation/adapters/pi.rs::resume_command`

**边界条件（实测）**：`sessionId` 握手时就有，但**会话文件只有发过消息后才落盘**。
所以空会话的 id 用 `--session` 启动会得到 `No session found matching '…'`。
这不影响本实现 —— `resume_id` 是**保存用的句柄**（存进 `ResumeCursor`），
等会话真有内容后自然可用。但 `agent_chat_resume` 若对空会话立即恢复会失败，
那一侧的防护属于 `conversation` 域，不在本任务范围。

### 未做：压缩 / 切换 / 导出 / 统计（均无消费点）

| 能力 | 协议支撑 | 为什么不做 |
| --- | --- | --- |
| `compact` / `set_auto_compaction` | ✅ 命令存在 | 前端 `grep compact` 零命中，没有触发入口 |
| `auto_compaction_*` 事件 | ✅ 已在上报（translate 里记 debug） | 同上 |
| `switch_session` | ✅ 命令存在 | 无前端入口；且与 `resume_id` 是两条路 |
| `export_html` / `set_session_name` | ✅ 命令存在 | 无消费点 |
| `get_session_stats` | ✅ 返回 `contextUsage{tokens,contextWindow,percent}` | `StreamEvent::Usage` 只有 input/output tokens，装不下 `contextWindow`/`percent`；要接用量条需先扩 `Usage` 结构 —— 属独立改动 |

`conversation/adapters/pi.rs` 的会话列表/解析/过滤本来就现成，本次零改动（已核对对齐）。

## 阶段 9：收尾

- [ ] `pnpm check`（全量 31 护栏）
- [ ] 变异验证（见下）
- [ ] 更新 spec：新增或扩充 `.trellis/spec/backend/agent-acp-model-selection.md`
      为通用的 `agent-chat-transports.md`（ACP / serve / jsonl / pi-rpc 对比）
- [ ] 真机 `ps` 确认**单进程**（AC11）

## 变异验证清单

| 变异 | 期望变红的用例 |
| --- | --- |
| 终止判据改 `agent_end` | 压缩场景序列用例 |
| 前导行解析失败即丢弃 | prelude 收集用例 |
| `"pi-rpc"` 分支放兜底之后 | 字符串解析用例 |
| 响应也广播给事件 handler | 「响应不广播」用例 |
| 超时后不移出 pending | 迟到响应 double-settle 用例 |
| 把 `provider` 从 `id` 里拆（错的假设） | 模型切换请求体用例（`provider` 必须来自字段） |

**诚实标注不验证**：去掉 `--no-themes` 只影响性能，没有测试能抓。

## 依赖关系

```
阶段 1 ──> 阶段 2 ──> 阶段 3 ──> 阶段 4 ──> 阶段 5
                                    ↓
                          真机验证（AC1）通过后才继续
                                    ↓
                          阶段 6/7/8（二期，可并行）
```

阶段 4 是真机验证点：**没跑通对话就不要往下做**。

## 不做的事

- 不做进程内 SDK（V8 嵌入）
- 不依赖 `pi-acp`
- 不改 `conversation` 域（复用）
- 不接 `library/prompt`（slash 用 Pi 自己的）
- 不做 `set_follow_up_mode` / `set_steering_mode`
