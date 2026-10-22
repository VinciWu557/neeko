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

### 4.6 上游失败只藏在 `turn_end` 里（实测 pi 1.4.0）

上游 API 调用失败（key 无效 / 网络 / 模型不存在）时，pi **不发独立的 error 事件**：
`agent_start → turn_start → message_start/end(空 content) → turn_end → agent_end → agent_settled`，
失败信息只在 `turn_end.message.stopReason == "error"`（实测 `big-pickle` 上游失败：
`content: []`、`usage.totalTokens: 0`、telemetry `success:false`）。

把 `turn_end` 归为「静默生命周期事件」= **用户发消息零输出零提示**（2026-10-22
实测事故）。translate 必须检查 `stopReason`：`"error"` 时产出
`StreamEvent::Error`（code `E_TURN_FAILED`），且**消息体取
`turn_end.message.errorMessage` 原文透传**（实测：`403: {"type":"FreeTierError",…}`，
含上游 HTTP 状态码与错误体）—— 只报 provider/model 等于让用户自己翻
`~/.pi/free.log`。`errorMessage` 缺失（旧版 pi）才回落到 provider/model 定位串。
护栏 `turn_end_with_error_stop_reason_must_surface` /
`turn_end_error_message_is_passed_through_verbatim` /
`turn_end_error_without_detail_falls_back_to_model_identity` /
`turn_end_with_normal_stop_reason_produces_no_error`。

pi 侧日志线索：`~/.pi/free.log` 的 `[telemetry]` 行带 `success:false` 与
provider/model —— 排障时先看它，能直接区分「上游失败」与「Neeko 丢事件」。

### 4.6b `agent_settled` 的 `reason` 决定通知，且失败不可被追认为完成

`agent_settled` 是**唯一**的回合终止信号（`turn_end` / `agent_end` 在重试/压缩
时会发多次），因此它的 `reason` 一路 downstream 到通知：

| 载荷 | 正确 reason | 不区分的后果 |
| --- | --- | --- |
| `{aborted: true}`（用户点停止） | `Stopped` | 发「任务完成」通知 —— `notify.rs` 的 `Stopped => return None` 在 pi 上永不可达 |
| `{aborted: false}` | `Completed` | — |
| 字段缺失（旧版 pi） | `Stopped` | 保守取「被叫停」：宁可少一条完成通知，不谎报成功 |

**跨事件事实必须落在会话层，不能放进 `translate`。** 失败与终止是**两条**事件：
`turn_end{stopReason:error}` → `Error`，随后 `agent_settled{aborted:false}` →
`TurnEnd{Completed}`（pi 不认为「上游报错」算 abort）。两条都只看得见自己：

- `translate` 是纯函数（这是它能被密集单测的前提，不能破）；
- `agent_settled` 的载荷里没有「本轮是否报过错」。

于是 `notify.rs` 的两条互斥声明被同时触发（「会话异常终止」+「任务完成」）。
修法：`PiSession::absorb()` 在**入队那个事件边界**维护 `turn_failed`，遇
`Error` 置位、遇 `TurnEnd` 消费并清零（下一轮从干净状态开始）。

护栏：`agent_settled_aborted_maps_to_stopped_not_completed` /
`agent_settled_without_aborted_field_defaults_to_stopped` /
`failed_turn_is_not_reported_as_completed` /
`failure_state_does_not_leak_into_the_next_turn`。

> 写测试时的坑：用例用 `while let Some(ev) = session.next().await` 会**永久阻塞**
> —— 假 pi 不关事件流。一律有界读取（`for _ in 0..N`）。

### 4.7 没有前导人类可读行（实测）

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

**`tool_execution_start` 的 `title` 必须取 `args.command`（bash 的实际命令）**：
只填工具名时工具执行**中**的卡片是空的 —— 前端 `extractCommand` 的输出回显
兜底要等 `tool_execution_end` 才有材料（2026-10-22 实测：光秃秃的 "$ bash"）。
其余工具（read/edit）的 args 字段名不统一（`path` 等），无可提取命令时回落工具名。
护栏 `tool_start_carries_the_command_as_title` /
`tool_start_without_command_arg_falls_back_to_tool_name`。

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

## 10. 新传输的会话配置检查清单（2026-08-24）

> 这一节是 `08-24-agent-config-unify` 的产物。它把「新接一个 agent 会把同一批坑
> 重踩一遍」这件事变可检查 —— 下面 5 条都是**实际发生过**的缺陷，不是假想。

### 10.1 能力位是唯一判据

`AgentAdapter::chat_capabilities()` 返回 `ChatCapabilities { config, approvals, commands, resume }`。

```rust
match caps.config {
    ConfigCapability::SessionConfig => { /* set_config_option + 全量回推 */ }
    ConfigCapability::PerTurn      => { /* 每轮请求参数，无回推 */ }
    ConfigCapability::None         => { /* 无会话配置 */ }
}
```

**三条强制规则**：

1. **`SessionConfig` 是三条承诺的合取**：① 握手带 `config_options` ② 接受
   `SetConfigOption` 并真的下发 ③ 变更后产生 `ConfigOptionUpdate`（全量）。
   缺一条即违约 —— 声明 `true` 而握手不带配置项，前端的控件区会**永远空白**。
2. **`SessionStart.capabilities` 必须由 `chat_capabilities()` 派生**
   （`Capabilities::from_chat_capabilities`），不得在手写的事件构造里逐字段填。
   历史上四个 adapter 全填 `approvals: true`，包括 `deepseek`（495 行里没有
   任何审批实现）—— 前端因此给它渲染了审批面板，而 agent 永远不发
   `RequestApproval`。
3. **默认值不存在**。`chat_capabilities()` 没有默认实现：新增 adapter 必须表态，
   新增**能力字段**时所有既有 adapter 的构造点编译失败。

### 10.2 五个已知断点与对应护栏

每一条都在 `10-21-pi-rpc-adapter` 里真实发生过，表现都是「看起来实现了、实际没接上」。
**只有静态护栏或真实日志能抓住它们** —— 组件测试全绿也不代表链路通了。

| # | 断点 | 为什么单元测试抓不到 | 护栏 |
| --- | --- | --- | --- |
| 1 | `SessionStart` 不带 `config_options` | 纯函数测了投影，没测「真的推给前端没有」 | `capability_probe::mock_agent_satisfies_its_own_declaration` |
| 2 | `request_channel()` 返回 `None` → 会话从未注册 | 测了 `session.send`，没测 manager 路由 | `exposes_a_request_channel_so_turns_can_be_routed` |
| 3 | `ctx.prompt` 从未被消费 → 首轮消息丢失 | 测了 `send(Turn)`，绕过了 `create` | `create_sends_the_first_prompt_from_the_context` |
| 4 | 静默会话的暂存事件从未被应用 | 两条路径各自实现，只测了其中一条 | `should drain buffered events after the silent session is opened` |
| 5 | 点选模型只改本地 state → 档位不刷新 | 没有「写路径必须下发」的判据 | `should wire the composer to the pushing handler` + `sessionOptionsWiring.test.ts` |

### 10.3 契约探针：声明 vs 行为

`agent/chat/capability_probe.rs::assert_capabilities_hold(adapter, ctx)` 建一个**真会话**，
观察 `SessionStart` 到底带了什么。这是唯一能验证「声明 == 行为」的手段
（照搬根 `AGENTS.md` 红线 14 的判据）。

**MockAgent 优先**（本设计的核心策略）：

- MockAgent 是**进程内**的 ACP 实现，反馈周期毫秒级；真实 adapter 需要外部进程，
  分钟级。
- 契约先在 MockAgent 上改到对，再拿去校验真实 adapter —— 那时失败的一定是
  adapter 而不是契约本身。
- MockAgent 必须**刻意比现实更严格**：模型项 `id` 不叫 `"model"`（钉住按
  `category` 定位）、响应必须全量、`set_config_option` 对未知 id 报错。

### 10.4 前端三态，不是二态

```ts
type SessionConfigPhase = 'unsupported' | 'loading' | 'ready';
```

**「会话未建立」不能渲染成「不支持」**：前者该显示加载态/禁用，后者该隐藏控件。
`useSessionConfigOptions` 的初值是 `loading`，`reset()` 回到 `loading` 而非
`unsupported` —— 否则切换 agent 时控件会先消失再出现。

**模型选择器的判据与配置类控件不同**：

| 控件 | 判据 | 理由 |
| --- | --- | --- |
| 模型选择器 | `capability !== 'none'` | `per_turn`（serve）走每轮请求参数，模型选择仍有意义 |
| 模式 / 档位 / model_config | `supported && phase === 'ready'` | 这些只能走 `set_config_option` |

压成一个布尔会让「serve 能选模型但不能改档位」这个事实无法表达。

### 10.5 禁止的写法

```rust
// ❌ 手填派生字段 —— 两份真相必然漂移
capabilities: Capabilities { approvals: true, command_echo: false, diff: false, resume: true }
```

```tsx
// ❌ 凭数据非空推断能力 —— 无法区分「不支持」与「会话未建立」
{mode && <AgentModeSelector />}
```

```rust
// ❌ 静默吞掉不支持的请求 —— 调用方无法区分「已处理」与「没实现」
_ => Ok(Vec::new())
```

**判据**：控件的可见性必须能追溯到一个能力位；写路径被拒绝时必须有一个测试
说明为什么拒绝（而不是 `if (configId)` 恰好为空）。

### 10.5b 模型列表的权威来源是 agent 协议，不是我们 spawn 的二进制

`model_list_args`（`pi --list-models` 那类）是**我们自己解析表格**得到的列表，
它的 `id` 形状与协议给的**不一致**：

| 来源 | `id` 形状 | 能否直接喂给 `set_config_option` |
| --- | --- | --- |
| `model_list_args`（CLI 表格） | `provider/model`（如 `cline/cohere/north-mini-code:free`） | **否** —— agent 会拒绝 |
| rpc `get_available_models` / ACP `configOptions` | 裸名（`deepseek-flash`） | 是 |

两条来源并存必然漂移。2026-08-24 实测：Pi 同时声明了 `--list-models`，
用户在会话建立前看到的是 `provider/model` 复合串，点选后 `set_model` 报
`Model not found: provider/provider/model`。

**规则**：声明了会话内模型能力的 transport（`ConfigCapability::SessionConfig`）
**不得**再声明 `model_list_args`。模型列表只在会话内取（`SessionScoped`），
会话一建立就由握手填充 —— 静默会话（`agent_chat_open`）让这几乎无延迟。

### 10.5c 互斥判据是 `SessionConfig`，**不是** `shows_controls()`

上面那条「不得并存」的规则**只对 `SessionConfig` 成立**，两个方向不对称：

| 能力 | 会话外目录 id 形状 | CLI 目录能否共存 |
| --- | --- | --- |
| `SessionConfig`（ACP / Pi） | 裸名 | **否** —— 复合串会被 `set_config_option` 拒绝 |
| `PerTurn`（opencode serve） | `provider/model` | **是** —— `model_slug_split` 就按这个形状拆 |

`supports_model_selection()` 是 `shows_controls()`，`PerTurn` 也为真。拿它当互斥
门控会把 serve 的 `models --verbose` 快速路径一并关掉，而 serve 又不是
`SessionConfig` —— 两条路径全被封，**`PerTurn` 传输的模型列表恒空**。

正确门控是 `supports_session_config()`（`uses_session_config()`）。护栏
`session_model_capability_overrides_the_cli_bypass` 断言判据字面值，
`out_of_session_catalog_goes_through_the_adapter` 断言目录经 adapter 取。

### 10.5d 会话外目录的唯一入口是 `AgentAdapter::list_models`

它是**可覆盖**的方法，所以「这个 transport 有没有会话外目录」是局部决策：
solve 覆盖它（`models --verbose`），ACP / Pi 用默认（退到 `model_list_args`）。

2026-10-22 事故：`list_agent_models` 绕过 adapter 直接读 `config.model_list_args`，
后果是双向的：

1. `AgentAdapter::list_models` 与 `ServeAdapter` 的覆盖一起变成**死代码**；
2. opencode 的快速路径（`model_list_args` 为 `None`）永远走不到 —— 模型列表恒空。

**错误分两类，处理不同**：`Err(AppError::Unsupported(_))` = 「我没有会话外目录」
（合法答案，继续走下一步）；其他 `Err` = 命令真的执行失败（**必须上抛**，否则
用户把「装坏了」看成「本来就没有模型」）。

`model_list_args` 仍然保留为**用户可自定义**字段（`AgentForm` 有输入框），
供确实没有协议级模型接口的第三方 CLI 使用。

**裁决必须在消费点做，不能只靠内置定义不填。** 原因：
`~/.neeko/config.json` 的 `agentOverrides` 是用户编辑时的**整份快照**
（`AgentConfig` 多数字段非 `Option`，序列化后丢失 presence，「没设置」与
「设为空」不可区分，所以无法做字段级合并）。内置定义改过之后，旧快照仍会把
`--list-models` 带回来 —— 2026-08-24 实测用户机器上正是如此：Pi 的覆盖里存着
`["--list-models"]`，模型列表又变回 `cline/cohere/north-mini-code:free` 复合串，
点选写不进去。

因此 `list_agent_models` 先算 `session_scoped = adapter.supports_model_selection()`，
**只有 `!session_scoped` 时才尝试 CLI 旁路**。用户的真实自定义（改 command / args /
icon 等）照旧生效，「有没有 CLI 旁路」由能力位说了算。

护栏：`transports_with_session_models_do_not_declare_a_cli_bypass`（内置定义不填）
+ `session_model_capability_overrides_the_cli_bypass`（消费点裁决顺序
`scoped < guarded < cmd`）。两条都做过变异验证。

### 10.6 静态护栏只能防「整段删除」，防不住「条件被短路」

第一版的能力位护栏读源码做字符串匹配（`expect(CHAT).toContain('configWritable')`）。
变异验证把定义改成 `const configWritable = true` 后**8 条断言全绿** —— 名字还在，
门控已经没了。

**结论**：涉及「某条件必须成立才渲染」的护栏，必须**渲染组件并断言 DOM**，
不能只断言源码里出现过某个标识符。参照
`components/__tests__/ComposerCapabilityGate.test.tsx`（3 条，3/3 变异全抓）。

补充一条同类陷阱：判据选错会让变异漏抓。第一版用「agent 名文案」判断模型
选择器是否存在，而旁边的 agent 切换器渲染同一个名字 → 变异漏抓。改用
`queryByTitle('Select model')`（只有 `ModelPicker` 有这个 title）后才有效。
