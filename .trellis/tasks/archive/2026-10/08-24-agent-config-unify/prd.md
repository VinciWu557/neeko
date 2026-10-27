# Agent Chat 会话配置能力契约统一

## Goal

把「会话配置项」（模型 / 推理档位 / 模式 / 模型参数）的**读写能力**从各 adapter 的
隐式假设，收敛为 `AgentAdapter` 上的**显式能力位**；前端据能力位决定渲染什么，
而不是靠「`configOptions` 碰巧非空」推断。

## 动机：同一个缺陷在 Pi 上出现了五次

`10-21-pi-rpc-adapter` 的实测记录（每条都是「看起来实现了、实际没接上」）：

| # | 缺陷 | 为什么没被发现 |
| --- | --- | --- |
| 1 | `SessionStart` 不带 `config_options` | 纯函数测了投影，没测「真的推给前端没有」 |
| 2 | `request_channel()` 返回 `None` → 会话从未注册 | 测了 `session.send`，没测 manager 路由 |
| 3 | `ctx.prompt` 从未被消费 → 首轮消息丢失 | 测了 `send(Turn)`，绕过了 `create` |
| 4 | 静默会话的暂存事件从未被应用 | 两条路径各自实现，只测了其中一条 |
| 5 | 点选模型只改本地 state → 档位不刷新 | 没有「写路径必须下发」的判据 |

**共同特征**：契约靠**约定**而非**类型/能力位**保证。换一个 adapter（或新接一个 agent）
就要把同一批坑重踩一遍 —— 因为它们不在任何可执行的契约里。

第 5 条尤其说明问题：前端 `useModelSelection` 里 `if (configId) setConfigOption(...)`
对 `serve` / `deepseek` **静默不发**（`configOptions` 恒空 → `configId` 为 undefined）。
UI 看起来"能用"，实际是靠空值巧合。

## 现状审计（一手）

### `AgentAdapter` 现有能力位

```rust
fn supports_chat_resume(&self) -> bool          // 默认 false
async fn list_models(&self, config) -> Result<Vec<ModelInfo>, AppError>   // 会话外
fn supports_model_selection(&self) -> bool      // 默认 false
```

### 实测能力矩阵

| 能力 | acp | serve | deepseek | pi_rpc |
| --- | --- | --- | --- | --- |
| `supports_model_selection` | ✅ | ✅ | ❌ | ✅ |
| `list_models`（会话外） | ❌ | ✅ | ❌ | ❌ |
| `supports_chat_resume` | ❌ | ✅ | ❌ | ✅ |
| **会话内可下发 `set_config_option`** | ✅ | **❌** | **❌** | ✅ |
| **产生 `ConfigOptionUpdate`** | ✅ 13 处 | **0** | **0** | ✅ 7 处 |

**`supports_model_selection` 语义太模糊**：ACP 为 true 靠 `configOptions`，serve 为 true
靠 HTTP 请求参数 —— 两者机制完全不同，前端**无法据此判断能不能用 `set_config_option`**。

### 前端现有判据（隐式）

```tsx
{mode && <AgentModeSelector .../>}          // 有就显示
{thoughtLevel && <ThinkingLevelSelector .../>}  // 有就显示
```

对 `serve`：`configOptions` 恒空 → 不显示（碰巧对了）。
但若某天某 adapter 返回一个**空数组**而非缺失，判据退化；且「不支持」与「还没建立会话」
两种状态无法区分（后者该显示加载态，前者该整个隐藏）。

## Requirements

### R1 显式能力位，不用隐式推断

`AgentAdapter` 新增：

```rust
/// 会话内是否支持 `set_config_option`（configOptions 驱动的一切：
/// 模型切换 / 推理档位 / 模式 / 模型参数）。
///
/// 与 `supports_model_selection` 的区别：那个回答"有没有模型选择这回事"
/// （serve 靠 HTTP 参数也算有），这个回答"能不能通过会话配置项改它"。
fn supports_session_config(&self) -> bool { false }
```

`supports_session_config() == true` 的 adapter 必须同时满足：

1. 握手时把配置项放进 `SessionStart.config_options`
2. 接受 `SessionRequest::SetConfigOption` 并真的下发
3. 变更后产生 `ConfigOptionUpdate`（全量）

三条缺一条即违约 —— 与红线 14（LSP 能力声明必须与实现一致）同一个判据思路。

### R2 前端三态，而不是两态

```ts
type SessionConfigState =
  | { kind: 'unsupported' }      // 能力位 false → 隐藏所有控件
  | { kind: 'loading' }          // 能力位 true 但 configOptions 还没到 → 骨架/禁用
  | { kind: 'ready'; options }   // 有配置项
```

**「还没建立会话」不能渲染成「不支持」** —— 前者应是加载态，后者该隐藏。当前实现混为一谈。

### R3 写路径必须显式失败，不许静默

`useModelSelection` 现在：

```ts
const configId = modelConfigIdFrom(sessionConfigOptions);
if (configId) setConfigOption(configId, model.id);   // 对 serve 静默跳过
```

改为：不支持时**要么不发且不显示该控件**（R2 已保证控件不出现），要么在日志里说清。
禁止「UI 显示了控件、点了没反应」这种组合。

### R4 能力位要有护栏测试

每个 adapter 的 `supports_*` 返回值必须与**它的行为**一致：

- 声明 `supports_session_config() == true` → 测试必须验证握手带 `config_options`、
  且 `SetConfigOption` 会真的产生 `ConfigOptionUpdate`
- 声明 `false` → 测试必须验证前端不会收到非空 `config_options`

这是 R1 三条约束的**可执行形式**，也是红线 14 的做法（「改能力声明前先回答哪段代码消费它」）。

### R5 新接入 agent 的检查清单

在 `.trellis/spec/backend/agent-chat-transports.md` 增加一节：
「新增传输时的会话配置检查清单」，列全 5 个已知断点（见上文表格），每条给一个护栏。

## Acceptance Criteria

> 状态核验：2026-10-27（归档前逐条取证，**不抄 implement 文档的自述**）。
> ⚠ **实现形态与本 PRD 描述不同名** —— PRD 写 `supports_session_config() -> bool`，
> 实际落地是**枚举** `chat_capabilities() -> ChatCapabilities { config: ConfigCapability }`
> （`SessionConfig` / `PerTurn` / `None`）。枚举比 bool 更强：
> `PerTurn`（serve 靠 HTTP 请求参数）既不是「支持」也不是「不支持」，
> bool 无法表达第三态。AC 按**语义**判定，不按名字。

- [x] **AC1** 显式能力位存在且 4 个 adapter 全部显式实现 —— `chat_capabilities()` 覆写 4 处：
      `adapter/acp.rs:516` / `adapter/deepseek.rs:46` / `adapter/pi_rpc/adapter.rs:49` /
      `adapter/opencode/adapter.rs:63`。**无默认实现** —— 新增 adapter 必须表态，
      新增能力字段时既有构造点编译失败（design §5 阶段 1 的验证点）。
      > 命名差异：`supports_session_config()` 仍存在（`adapter.rs:252`）但已被
      > `ConfigCapability` 取代，不再说谎。
- [x] **AC2** 「声明 == 行为」有护栏 —— `agent/chat/capability_probe.rs::assert_capabilities_hold`
      建**真会话**观察 `SessionStart` 到底带了什么（照搬根 AGENTS.md 红线 14 判据）。
      4 条探针：`mock_agent_satisfies_its_own_declaration` /
      `deepseek_declares_no_config_and_carries_none` /
      `per_turn_shows_controls_but_does_not_use_session_config` /
      `commands_bit_implies_list_commands_is_not_unsupported`。
- [x] **AC3** 前端据能力位渲染，不再凭 `configOptions` 非空推断 ——
      `shared/utils/modelTarget.ts` 的 `modelAvailabilityOf(config, phase)` 是**唯一**合成入口，
      消费点 `ChatComposer` / `ModelPicker` / `useModelSelection` 全部走它。
- [x] **AC4**「不支持」与「会话未建立」可区分 —— 4 态 union
      `no-config | per-turn | pending | ready`（`modelTarget.ts`）。
      `pending`（能力位 true 但配置项未到）≠ `no-config`（能力位 false）。
      > PRD 原本设想 3 态（`unsupported/loading/ready`），实际收敛成 4 态 ——
      > 因为 `PerTurn` 是第三种真实语义（见 AC1 注）。
- [x] **AC5** 无「显示了控件但点选静默无操作」的路径 —— 「不可写」不是
      `ModelWrite` 的变体，而是**拿不到写回目标**（`modelWriteOf` 返回 `null`），
      于是「渲染说能点、写入拿不到目标」这个矛盾**在类型层无法表达**。
      变异 4/4 全部变红（能力位不再优先于就绪度 / `pending` 报成 writable /
      `pending` 也能写 / `no-config` 也显示选择器）。
- [x] **AC6** spec 新增「新传输的会话配置检查清单」 ——
      `.trellis/spec/backend/agent-chat-transports.md` §10，含
      §10.2 五个已知断点与对应护栏（实际列了 6 条，第 6 条是
      `10-23-agent-chat-registry` 新增的一类「实现散在多处」）+
      §10.3 契约探针 + §10.4 前端三态。

## Non-Goals

- 不重构 `AgentAdapter` 的整体形状（`supports_*` 之外不加新方法族）
- 不改 `serve` 的模型切换机制（它靠 HTTP 参数，本就与 `configOptions` 无关；
  本次只是让前端**知道**它不走配置项）
- 不统一 `StreamEvent` / `SessionRequest` 的既有契约面

## 与 08-24 计划的关系

本目录原有 `design/execution-plan.md`（2026-08-24，「AgentPlugin 双轨消除」），
**已执行完成**。它描述的部分架构后来被重构取代：

| 计划里的 | 现状 |
| --- | --- |
| `ChatTransport` 枚举 | → `ChatStart`（`common/agent/types.rs`） |
| `agent/builtin.rs`（14 provider 单一源） | → `agent/builtin/providers.rs` |
| `agent/chat/provider_registry.rs` | 已删除 |
| `AgentPlugin` 双轨 | `plugin.rs` 仅剩 75 行 |

那份文档保留为**历史记录**，不修改。本次工作基于**当前代码**，只共享同一个目标：
「agent 能力由显式契约承载，而不是散落的约定」。

## 参考

- `src-tauri/src/agent/chat/adapter.rs` —— `AgentAdapter` trait 与三个现有能力位
- `src-tauri/src/agent/chat/adapter/acp_config.rs` —— ACP 的 `ConfigOptionsState`
- `src-tauri/src/agent/chat/adapter/pi_rpc/session.rs` —— Pi 的等价实现（7 处 `ConfigOptionUpdate`）
- `.trellis/spec/backend/agent-acp-model-selection.md` —— ACP 配置项协议事实
- `.trellis/spec/backend/agent-chat-transports.md` —— 四条传输对照
- 根 `AGENTS.md` 红线 14 —— 能力声明必须与实现一致（同一判据思路）
