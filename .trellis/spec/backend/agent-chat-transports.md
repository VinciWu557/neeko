# Agent Chat 传输层对照

> 本仓 `AgentAdapter` 目前有四条真实可用的传输。本文记录**它们各自的协议事实与陷阱**，
> 以及新增一条传输时必须同时改到的四处落点。
>
> ACP 的模型选择细节见 [`agent-acp-model-selection.md`](./agent-acp-model-selection.md)，
> 本文不重复。

## 1. Scope / Trigger

- **Trigger**：改 `src-tauri/src/agent/chat/adapter/{acp,serve,deepseek}.rs` 或
  `adapter/pi_rpc/`；改 `common/agent/types.rs` 的 `ChatStart`；给某个 agent
  接上 chat 能力。
- **前提认知**：`ChatStart` 是**能力数据**，不是 id 判定的替代品。`adapter_for`
  按 `config.chat` 分派，任何适配器内部都不得出现 `agent_id ==` 分支
  （护栏 `tests/unit/agent_model_dispatch_test.rs`）。

## 2. 四条传输

| `ChatStart` | 适配器 | 传输 | 进程数 |
| --- | --- | --- | --- |
| `Acp { args }` | `AcpAdapter` | JSON-RPC over stdio | 1 |
| `Serve` | `ServeAdapter` | HTTP + SSE（opencode serve） | 1（serve 本身） |
| `Jsonl` | `DeepSeekHarnessAdapter` | 私有 NDJSON over stdio | 1 |
| `PiRpc` | `PiRpcAdapter` | 私有 NDJSON over stdio | 1 |
| `Mock` | `AcpAdapter::mock` | 进程内 | 0 |

**`Jsonl` 与 `PiRpc` 不共用一个变体**：两者都是「私有 NDJSON」，但命令形状与事件
类型完全不同（DeepSeek Harness 是 `{type:...}` 单层；Pi 有 `response` 配对层 +
`assistantMessageEvent` 嵌套）。共用一个变体会让适配器里出现「解码后再按 kind
分支」的二段分派。

## 3. 新增一条传输必须改的四处

漏任何一处都是**静默失败**（不报错，行为错）：

| # | 落点 | 漏掉的后果 |
| --- | --- | --- |
| 1 | `ChatStart::as_str()` | 序列化出错误字符串，读回时降级成 Acp |
| 2 | `ChatStart` 的 `Deserialize`，**必须在 `_ => Self::Acp` 兜底之前** | `"xxx"` 被吞成 Acp，spawn 出错误命令行 |
| 3 | `adapter_for()` 的 `match` | Rust 会编译报错（`non_exhaustive`），这一处**不会漏** |
| 4 | 前端 `ChatTransport` + `CHAT_OPTIONS` + `CHAT_HINTS` | 下拉里选不到；或选了保存后后端不认识 |

护栏：`src/features/agent/components/__tests__/chatTransportOptions.test.ts`
读后端源码断言 ① 每个前端选项都有对应 `as_str()` 臂 ② `"pi-rpc"` 分支位于
`_ => Self::Acp` 兜底之前。**两条都做过变异验证**。

## 4. Pi rpc 的协议事实（一手实测 pi 1.3.0）

### 4.1 三条通道

```
① 命令（我们 → pi）   {"type":"prompt","id":"<uuid>","message":"…"}
② 响应（pi → 我们）   {"type":"response","id":"<uuid>","success":bool,"data":…}
③ 事件（pi → 我们）   无 id 的其它 JSON
```

判别只看两条：`type == "response"` **且** 有 `id` → 响应（按 id 配对后**不进事件流**）；
否则 → 事件。

响应若混进事件流，前端会把 `get_state` 的回包当成一条对话事件渲染。有测试锁死
（`response_is_routed_to_pending_and_not_broadcast`），变异验证过。

### 4.2 回合结束判据是 `agent_settled`，**不是** `agent_end`

pi 一次用户 prompt 可能发出**多个** `turn_end` / `agent_end`（自动重试、上下文压缩、
队列续跑各发一次）。用其中任何一个当回合结束，都会让后续输出被当成「回合外」丢掉。

护栏测试 `only_agent_settled_ends_the_turn` 构造了
`agent_start → text → agent_end → auto_compaction_* → text → agent_end → agent_settled`
的完整序列。变异验证：把判据改成 `agent_end` → 该用例变红。

### 4.3 `get_available_models` 返回结构化对象，`provider` 是独立字段

```json
{"models":[{"id":"deepseek-flash","name":"…","provider":"deepseek",
            "contextWindow":…,"reasoning":true,"thinkingLevelMap":{…}}]}
```

实测 198 个模型，每个自带 `provider`。所以 `set_model` 直接传
`{provider: m.provider, modelId: m.id}`，**不需要拆 `provider/model` 复合串**。

> 这一点与 opencode serve 相反（它的 id 是 `provider/model`，需要
> `serve.rs` 的 `model_slug_split`）。**不要把两者混为一谈。**

### 4.4 档位是**动态**的，与当前模型相关

```json
{"levels": ["low","high","max"]}
```

当前模型的 `thinkingLevelMap` 决定哪些可用（值为 `null` = 不支持）。
所以**每次切模型后要重新拉档位**，不能缓存一次用到底。

### 4.5 `extension_ui_request` 在启动时就会来，且不全是审批

实测启动即有 4 条：`notify`（Trellis 上下文）、`setWidget` ×2、`setStatus`。
这些是 **Pi 扩展的 UI 渲染请求**，不是工具审批。

**必须**按 `method` 分派。一律映射成 `RequestApproval` 会让用户每次开 Chat 都看到
一串莫名其妙的审批弹窗。护栏：`extension_ui_request_is_not_an_approval`。

### 4.6 没有前导人类可读行（实测）

`pi-acp` 的实现里有 `preludeLines` 收集（`JSON.parse` 失败的行存起来），推测是它
spawn 时带参数或旧版本行为。**pi 1.3.0 实测 `非 JSON 行: 0`**。

因此本仓**不做**专门的 prelude 收集链路 —— 只为「解析失败不崩」做最小容错
（`log::warn!` 后跳过，循环继续）。为一条从未触发的路径写收集+展示是没有验证
手段的死重量。真机出现非 JSON 行时再按当时的形状决定。

## 5. 新增传输的检查清单

1. `ChatStart` 变体 + `as_str()` + `Deserialize`（**兜底之前**）+ `adapter_for`
2. 前端 `ChatTransport` / `CHAT_OPTIONS` / `CHAT_HINTS`
3. `pi_rpc/` 式目录拆分（不要单文件 —— `deepseek.rs` 已 900+ 行）
4. `mod.rs` 保持极薄（红线 9）：只 `mod` 声明 + `pub use`
5. 纯函数翻译层（事件 → `StreamEvent`）单独成文件，这样「事件序列」类时序 bug
   才能被密集单测覆盖
6. 进程层用 duplex 管道做测试夹具，**不起真进程**
7. 真机验证（外部二进制存在性不可 mock）

## 6. 常见错误

| 错误 | 后果 |
| --- | --- |
| 新变体分支写在 `_ => Self::Acp` 之后 | 静默降级成 ACP，spawn 出错误命令行 |
| 用 `agent_end` 判回合结束 | 压缩/重试场景提前结束，后续输出丢失 |
| 响应也广播给事件流 | 前端把回包渲染成对话事件 |
| `extension_ui_request` 一律当审批 | 启动时弹出一串无意义审批 |
| 把 `provider` 从模型 id 里拆 | Pi 的 provider 是字段，拆了会得到错误值 |
| 档位列表缓存一次用到底 | 换模型后档位选项与真实能力不符 |
| 为「从不触发的 prelude」写展示链路 | 无验证手段的死重量 |

## 7. 测试清单

| 位置 | 覆盖 |
| --- | --- |
| `common/agent/types.rs` | `pi-rpc` 解析 / 往返 / 不被兜底吞掉 |
| `pi_rpc/translate.rs` | 文本/推理增量、空 delta 丢弃、**压缩场景序列**、扩展请求不是审批、畸形事件不 panic |
| `pi_rpc/process.rs` | 响应按 id 配对不广播、无 id 广播、非 JSON 行不杀循环、迟到响应丢弃 |
| `pi_rpc/mod.rs` | 模型映射（provider 放 description）、缺字段降级 |
| `agent/builtin/tests.rs` | Pi 走 `PiRpc` 传输 + `model_list_args` 仍在 |
| `chatTransportOptions.test.ts` | 前端选项 ↔ 后端字符串三处同步、分支顺序 |

## 8. 会话配置项：跨传输的契约 vs 传输专属语义

`SessionConfigOption` / `ConfigOptionsState` / `find_model_option` 曾住在
`adapter/acp_config.rs`。这误导性很强 —— Pi 适配器 `use acp_config::…` 读起来像
「Pi 依赖 ACP」，而它实际依赖的完全是协议无关的部分。**位置即依赖声明。**

现在按「是否只有 ACP 成立」切开：

| 文件 | 内容 |
| --- | --- |
| `adapter/session_config.rs` | 数据结构（`SessionConfigOption` 及值/选项类型）、`CATEGORY_*` 常量、定位函数、`ConfigOptionsState` 状态机。**协议无关**，ACP 与 Pi 共用 |
| `adapter/acp_config.rs` | `session/new` 响应解析、`session/set_config_option` 请求体、`ModelSwitch` 三态帧。**只有 ACP 成立**；re-export 前者以保持调用方零改动 |

**判据**：一个函数若对 payload 只做「取字段 / 查表 / 判断相等」，它属
`session_config.rs`；一旦它构造或解析 ACP 的 JSON-RPC 帧，才留在 `acp_config.rs`。

### 8.1 两条传输的配置项来源不同

| 传输 | 来源 | 需要投影？ |
| --- | --- | --- |
| ACP | agent 下发 `configOptions` 数组 | 否 —— 直接 `parse_config_options` |
| Pi rpc | 三份独立查询（`get_available_models` / `get_available_thinking_levels` / `get_state`） | **是** —— `pi_rpc/config.rs::project_config_options` |

Pi 是唯一需要**凭空构造** `SessionConfigOption` 的传输，所以投影集中在
`pi_rpc/config.rs` 的纯函数里，不散落到会话层。

### 8.2 `set_model` 的响应不是全量配置

ACP 的 `set_config_option` 响应携带**全量** `configOptions`，所以状态可以整体替换。
Pi 的 `set_model` 只回**被设置的那个模型对象**，`set_thinking_level` 连 `data` 都没有。

因此 Pi 侧切完必须**重新拉三份查询**再推 `ConfigOptionUpdate`（见
`session.rs::refresh_configs`）。照抄 ACP 的「用响应替换状态」会得到一份残缺配置。

### 8.3 档位是动态的，必须跟着模型重拉

`get_available_thinking_levels` 实测返回 `["low","high","max"]`，而当前模型的
`thinkingLevelMap` 决定哪些可用（不支持档位值为 `null`）。**每次切模型后必须重拉**，
缓存一次用到底会让下拉里的档位与真实能力不符。

### 8.4 能力声明必须诚实

`Capabilities.approvals` 在接通 `extension_ui_request` → `RequestApproval` 之前
必须声明 `false`。声明 `true` 而没实现，前端会等一个永不到来的审批弹窗。

## 9. Pi 的工具调用与审批

### 9.1 三件套按 `toolCallId` 关联

```text
tool_execution_start  { toolCallId, toolName, args }
tool_execution_update { toolCallId, partialResult }
tool_execution_end    { toolCallId, result, isError }
```

没有 `toolCallId` 的事件直接丢弃 —— 发出去只会是孤儿，前端无法更新对应那一行。

**`ToolEnd` 的交付顺序是硬约束**：`tool_execution_end` 的 `result` 是最终输出，
必须先 `ToolOutput` 再 `ToolEnd`。反过来会让前端先关掉那一行再收到内容，
表现出来就是「输出丢了」。护栏：`tool_end_delivers_final_output_before_status`。

结果形状不统一（`content[]` / `details.stdout` / `stdout` / 结构化 `diff`），
按**信息量从高到低**取第一个非空的，不要拼接 —— `details.stdout` 往往就是
`stdout` 的副本，拼起来会产生重复内容。

### 9.2 审批：`method` 决定一切，且 pi 没有统一的审批信封

`extension_ui_request` 一个 `type` 承载两种东西：启动时的扩展 UI
（`notify` / `setWidget` / `setStatus`）与真正的用户交互（`select` / `confirm`）。

| 请求 method | 是否审批 | 回写形状 |
| --- | --- | --- |
| `confirm` | ✅ | `{confirmed: bool}`，**拒绝是 `false` 不是 `cancelled`** |
| `select` | ✅ | `{value: "<首项>"}`；拒绝用 `{cancelled: true}` |
| `notify` / `setWidget` / `setStatus` | ❌ | 启动时就来，不是审批 |
| `input` / `editor` | ❌ | 需要文本输入，`RequestApproval` 表达不了 |

`cancelled` 的语义是「用户关掉了弹窗、没做选择」，与「明确拒绝」是两种状态。
把 `confirm` 的拒绝写成 `cancelled` 会让 pi 侧语义偏移（pi-acp 的实现同样回
`confirmed: false`）。

### 9.3 回写 id 必须是 pi 发的那个

`extension_ui_response` 的 `id` 必须回携带 `extension_ui_request.id`。
`PiRpcProcess::send` 曾无条件覆盖 `id` —— 于是每条审批回写都带一个 pi 不认识的
uuid，工具卡在等回答上，表现为「点了允许没反应」。现在只在**缺省时**补 uuid。

### 9.4 slash 命令：`get_commands` 是权威来源，不要扫目录

原计划扫 `~/.pi/agent/prompts/**/*.md` + `<cwd>/.pi/prompts/`。实测 `get_commands`
返回 **157 条**（`source ∈ prompt / skill / extension`），扫目录只能看到 prompt
这一类（3 条），漏掉 skill 与 extension 共 154 条。

执行侧也不需要新命令：`prompt` 里带 `/name` 会被 pi 自己展开（实测触发）。

### 9.5 会话恢复：`sessionId` 有，但文件要发过消息才落盘

`get_state.sessionId` 在握手时就有，可作为 `resume_id()` 返回给
`conversation/adapters/pi.rs::resume_command`（拼成 `pi --session <id>`）。

**边界**：空会话的 id 用 `--session` 启动会得到 `No session found matching '…'` ——
会话文件只在发过消息后写入。`resume_id` 因此是「保存用的句柄」而非立即可用的句柄；
对空会话立即恢复会失败，那是 `conversation` 域该加的防护。

