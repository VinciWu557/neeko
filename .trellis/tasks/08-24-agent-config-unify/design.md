# 设计：会话配置能力契约统一

> 前置：`prd.md`（问题清单与 AC）。本文写**结构与落地顺序**。
> 审计依据：对 `src-tauri/src/agent/chat/**`（10,547 行）与
> `src/features/agent-chat/**`（6,181 行）的一手取证。

## 1. 第一性原理：三条物理约束

剥掉表象，Agent Chat 只做一件事：

```
用户意图 ──► [子进程/HTTP] ──► 字节流 ──► 归一化事件 ──► 前端状态机
                ▲                                          │
                └────────── 指令（用户操作） ◄──────────────┘
```

**约束 ①：对端不可靠、双向、有状态。**
每个 agent 是独立进程或远程服务，会崩、会乱序、会重复。所以事件流必须幂等 ——
这就是 `SequencedEvent { seq, event }` 存在的唯一理由。**这条已解决，不动。**

**约束 ②：能力属于「(agent, 传输) 组合」，不是 agent 的属性。**

| | acp | serve | deepseek | pi_rpc |
| --- | --- | --- | --- | --- |
| 会话内配置项 | ✅ | ❌ | ❌ | ✅ |
| 产生 `ConfigOptionUpdate` | ✅ 13 处 | **0** | **0** | ✅ 7 处 |
| 审批 | ✅ | ✅ | 声明 true / **实现 0** | ✅ |
| 恢复 | ❌ | ✅ | ❌ | ✅ |

**约束 ③：唯一权威是对端。**
本地只能「乐观展示 + 被对端全量覆盖」。所以 `ConfigOptionsState.replace` 是整体替换，
不是 merge。**这条已解决，不动。**

### 由此推出的核心不变量

```
每个 (agent, 传输) 的能力，必须在会话建立时一次性、可验证地声明出来，
且该声明必须与「运行时真的会发生什么」严格一致。
```

**当前架构违反它。** 这是所有已暴露缺陷的共同根源。

## 2. 当前架构的八个问题

### P1（根因）能力声明有三份，互不校验

| # | 声明处 | 谁读 |
| --- | --- | --- |
| 1 | `AgentAdapter::supports_*`（2 个：`supports_model_selection` / `supports_chat_resume`） | 后端 `list_agent_models` |
| 2 | `Capabilities { approvals, command_echo, diff, resume }`（`SessionStart` 事件） | 前端渲染 |
| 3 | **隐式**：`configOptions` 是否非空 | 前端 `{mode && ...}` |

三者无一致性约束。证据：四个 adapter 全部硬编码 `approvals: true`，包括
`deepseek.rs`（495 行里没有任何审批实现）。而 `Capabilities` 的 4 个字段
**没有一个**能由 `AgentAdapter` 的 2 个能力位回答。

后果：`supports_model_selection` 在 serve 上为 `true`，但 serve 不产生任何
`ConfigOptionUpdate` —— 前端据此认为「可以切模型」，实际点选静默无操作。

### P2 `SessionRequest` 的未实现分支靠「静默吞掉」

8 个变体，各 adapter 覆盖：

| 变体 | acp | serve | deepseek | pi_rpc |
| --- | --- | --- | --- | --- |
| `Turn` / `Cancel` | ✅ | ✅ | ✅ | ✅ |
| `Approve` | ✅ | ✅ | ✅ | ✅ |
| `Input` | ✅ | ✅ | ✅ | **静默忽略** |
| `SetConfigOption` | ✅ | **空实现 `{}`** | ✅ no-op 帧 | ✅ |
| `ContextSet` / `Pause` / `Resume` | ✅ | **静默忽略** | ✅ | **静默忽略** |

`_ => Ok(())` 把「不支持」与「已处理」编码成同一结果，调用方无法区分。

### P3 双模型来源，`id` 语义不同却走同一条写路径

```
会话外（--list-models / serve） →  id = "provider/model"  复合串
会话内（get_available_models）  →  value = "deepseek-flash" 裸 id
```

`useModelsForPicker` 是「会话内优先，回落会话外」，而写入路径只有一条
（`useModelSelection.ts:64`：`setConfigOption(configId, model.id)`）。
列表来自会话外时，`model.id` 是复合串 → `set_model` 失败（实测
`Model not found: ark-coding-plan/ark-coding-plan/...`）。

### P4 模型选择有两条互斥写通道，无统一抽象

| 传输 | 机制 |
| --- | --- |
| acp / pi_rpc | `SetConfigOption` → `config_option_update` 全量回推 |
| serve | `Turn { model_id }` → HTTP 请求参数 |

语义相同（"本轮用哪个模型"），共存于同一份前端代码，靠运行时判空避免冲突。

### P5 前端「惰性推断」代替「显式状态」

```tsx
{mode && <AgentModeSelector/>}
{thoughtLevel && <ThinkingLevelSelector/>}
```

三种处境压成一个：

| 真实处境 | 应该 |
| --- | --- |
| 不支持 | 隐藏 |
| 支持但会话未建立 | 加载态 |
| 支持且有值 | 正常渲染 |

`useSessionConfigOptions` 只有 `options: []`（二态）。而 `useAgentModels` 已有
正确的四态（`available` / `session-scoped` / `unsupported` / `error`）——
**同一类问题两个 hook 两套答案**。

### P6 `useAgentChat` 是事实上的 god hook

| 指标 | 数值 |
| --- | --- |
| 行数 | 819（ratchet 基线 824，已顶格） |
| hooks 调用 | 36 |
| 返回值 | 31 |
| 事件分支 | 19 |

同时承担：事件归约、模型选择、配置项、附件、审批、会话生命周期、恢复、
缓存同步、通知可见性。每次新增能力都必须改它 —— 「抽子 hook 续命」已是症状。

### P7 协议无关的配置契约仍住在 `acp_config.rs`

`pi_rpc/session.rs` 仍在 `use crate::agent::chat::adapter::acp_config::SessionConfigValue`
—— Pi 不认识 ACP。位置即依赖声明，会持续误导。

### P8 事件归一化缺少跨 adapter 契约测试

18 个 `StreamEvent` 变体、4 个 adapter 各自翻译。有单测，但没有
「声明 vs 行为」的一致性校验 —— `approvals: true` 而无实现正是这个空缺的产物。

## 3. 目标结构

### 3.1 能力快照（单一事实源）

```rust
// src-tauri/src/agent/chat/capabilities.rs
pub struct ChatCapabilities {
    pub config: ConfigCapability,
    pub approvals: bool,
    pub commands: bool,      // 有 slash 命令列表
    pub resume: bool,
}

pub enum ConfigCapability {
    SessionConfig,  // 走 SetConfigOption + ConfigOptionUpdate（acp / pi_rpc）
    PerTurn,        // 走每轮请求参数（serve）
    None,
}
```

**为什么是枚举而非 bool 组合**：`SessionConfig` 与 `PerTurn` 互斥，
bool 会允许 `{config: true, per_turn: true}` 这种无意义状态。

**为什么是值对象而非 trait 上的散装方法**：散装 `supports_*` 的三个实际危害
（都在 Pi 任务里发生过）：
1. 新增能力时旧 adapter 不报错（trait 有默认实现）→ 静默降级
2. 前端拿不到完整图景 → 只能靠「数据非空」推断
3. 无法一次性校验「声明 == 行为」

值对象收益：新增字段时**所有 adapter 的构造点编译失败**，强制表态。

### 3.2 模型引用（展示与可写分离）

```rust
pub struct ModelRef {
    pub display: String,
    pub group: Option<String>,   // provider；列表内标识唯一时为 None
    pub target: ModelTarget,
}

pub enum ModelTarget {
    ConfigValue { value: String },
    TurnParam { provider: Option<String>, model: String },
    ReadOnly,                    // 会话外快照：可展示、不可写
}
```

`ReadOnly` 是 P3 的类型级解法：会话外列表**本就不能用于写入**，
用类型表达而非注释 + 运行时判空。

### 3.3 配置快照（三态，与能力解耦）

```rust
pub enum ConfigSnapshot {
    Unsupported,               // ConfigCapability::None
    Pending,                   // 能力有，会话未就绪
    Ready(Vec<SessionConfigOption>),
}
```

`Unsupported.replace(...)` 返回 `Err` —— 收到数据说明能力声明与实现不一致，
是缺陷而非正常输入（让它响而不是静默接受）。

### 3.4 模块职责边界

| 模块 | 唯一职责 | 明确不做 |
| --- | --- | --- |
| `AgentAdapter` | 答「这个传输**能**做什么」 | 不碰 UI、不碰会话状态 |
| `ConfigSnapshot` | 答「这个会话**现在**是什么」 | 不推断能力、不猜默认值 |
| `ModelRef` | 答「这个模型**怎么被引用**」 | 不承载会话状态 |
| `CapabilityProbe` | 答「声明与行为**是否一致**」 | 只在测试期运行 |
| `useAgentChat` | 答「事件**改变**了什么」 | 不做能力判断、不发请求 |

## 4. MockAgent 优先：让契约在小成本上跑通

**这是本设计的核心策略**（用户提出，采纳）。

MockAgent 是**进程内**的 ACP 实现（`run_mock_loop` 驱动任意 `AsyncRead/Write`），
无需外部 agent 就能端到端跑通。它当前已覆盖：

- ACP 帧格式（`Content-Length` LSP 风格）
- `configOptions` 三个 category：`model` / `model_config` / `thought_level`
- 模型项 `id` **故意不叫** `"model"`（钉住「按 category 定位」）
- `set_config_option` 返回**全量**
- 审批 Gate + 工具调用 + 回合结束 + cancel

**缺**：`category: "mode"`。

### 做法

```
1. 先让 MockAgent 成为 ChatCapabilities 的**参考实现**
   → 它声明 ConfigCapability::SessionConfig + approvals + commands
2. 补齐 mode 配置项（让「模式」这条链也有 mock 覆盖）
3. CapabilityProbe 先在 MockAgent 上跑通
   → 契约本身正确了，再逐个别名真实 adapter
```

**为什么这个顺序**：真实 adapter 需要外部进程（pi/opencode/claude），
反馈周期以分钟计；MockAgent 是进程内，反馈以毫秒计。契约在 MockAgent 上
改到对，再拿去校验真实 adapter —— 失败的必是 adapter 而不是契约。

**MockAgent 必须刻意「比现实更严格」**（现有注释已体现这个原则，延续它）：

- 模型项 `id` 不叫 `"model"`（真实 agent 碰巧都叫，会掩盖按 id 定位的错误）
- 响应必须全量（局部更新会留下陈旧项）
- **新增**：`set_config_option` 对未知 `configId` 返回错误而非静默成功
  （钉住「静默忽略」这个反模式）

## 5. 落地顺序

| 阶段 | 内容 | 独立验证点 |
| --- | --- | --- |
| **1** | `ChatCapabilities` + `ConfigCapability`；4 个 adapter + MockAgent 实现 | 新增字段时**编译失败** = 强制表态 |
| **2** | `ConfigSnapshot` 三态（后端 + 前端 `useSessionConfigOptions` 改三态） | 「不支持」与「未就绪」UI 可区分 |
| **3** | `CapabilityProbe`；**先跑 MockAgent**，再跑 4 个真实 adapter | 立刻抓出 `approvals: true` 但 deepseek 无实现 |
| **4** | `ModelRef` 替换 `ModelInfo`（前后端）；会话外列表变 `ReadOnly` | 点选不可写的项在类型层就不可能 |
| **5** | MockAgent 补 `category: "mode"` | 模式这条链有 mock 覆盖 |
| **6** | `useAgentChat` 按 P6 拆分 | 从 819 行降到单职责钩子 |

**依赖**：1 → 2 → 3 必须顺序（3 依赖 1、2）。4、5 可与 3 并行。6 最后。

## 6. 测试策略

| 层 | 做法 |
| --- | --- |
| 能力位 | **每个 adapter 跑 `assert_capabilities_hold`**（阶段 3 的产物） |
| MockAgent | 阶段 1-5 每步先在它上面跑通再推真实 adapter |
| 三态 | `ConfigSnapshot` 单测：`Unsupported` 拒绝数据 / `Pending→Ready` / 全量替换 |
| ModelRef | `is_selectable()`：`ReadOnly` 为 false；`key()` 组合键唯一（同 id 多 provider） |
| 前端 | 能力位 false → 控件不渲染；`pending` → 加载态；`ready` → 正常 |
| 静态护栏 | 前端不得再出现 `{mode && ...}` 这类「凭数据非空推断能力」 |

### 变异验证清单

| 变异 | 期望变红 |
| --- | --- |
| `ConfigCapability::None` 时 `SessionStart` 仍带 config_options | 探针的 `declared no session config but carried` 用例 |
| `SessionConfig` 声明但握手不带配置项 | 探针对应用例 |
| `Unsupported.replace()` 改为静默接受 | `unsupported_refuses_data` |
| `ModelRef::is_selectable()` 对 `ReadOnly` 返回 true | 点选不可写项的用例 |
| 前端控件改回「凭数据非空推断」 | 静态护栏 |

## 7. 不做的事

- 不改 `SequencedEvent`（约束 ① 已解决）
- 不改 `ConfigOptionsState` 的全量替换语义（约束 ③ 已解决）
- 不重构 `AgentAdapter` 的整体形状（只在 `chat_capabilities()` 上收口）
- 不改 serve 的模型切换机制（它本就靠 HTTP 参数；本次只让前端**知道**）
- 不改 08-24 的 `design/execution-plan.md`（历史记录，部分已被重构取代）

## 8. 风险

| 风险 | 缓解 |
| --- | --- |
| 阶段 1 会让 4 个 adapter 编译失败（预期内） | 这正是目的：强制表态。逐个填，不放过任何一个「先给默认值」 |
| 阶段 4 改 `ModelInfo` 影响面大（前后端 + 测试） | 先加 `ModelRef` 与 `ModelInfo` 并存，切换消费者，最后删旧类型 |
| `CapabilityProbe` 需要真机进程，CI 无 pi | MockAgent 版进 CI；真实 adapter 版标 `#[ignore]`，本地/夜间跑 |
