# PRD · Chat 传输分派去硬编码：从枚举 switch 收敛为单一注册表

## 目标（本任务的原始动机）

`adapter_for` 这类分派写得太死：**每加一种协议要改 5 个地方，且没有任何编译期强制**。

```rust
Ok(match launch.transport() {
    ChatTransport::Acp => Box::new(AcpAdapter::new(cmd, env)),
    ChatTransport::Serve => Box::new(ServeAdapter::new(cmd, env)),
    ChatTransport::Jsonl => Box::new(DeepSeekHarnessAdapter::new(cmd, env)),
    ChatTransport::PiRpc => Box::new(pi_rpc::PiRpcAdapter::new(cmd, env)),
})
```

四个分支体形状完全相同，只是类型名不同 —— 这是「用运行时 match 替代了本该数据化的映射」。

## 现状：5 处硬编码，彼此不知道对方存在

| # | 位置 | 形态 | 漏改的后果 |
| --- | --- | --- | --- |
| 1 | `adapter.rs` `adapter_for` 的 `match` | 4 分支 → 构造 adapter | Rust 编译报错（唯一会报的） |
| 2 | `chat_launch.rs` `transport()` 的 token 扫描 | 4 组 token → 枚举 | 识别不出，静默走默认 ACP |
| 3 | `chat_launch.rs` `ChatTransport::as_str()` | 4 分支 → &'static str | 日志/错误里的标识缺失 |
| 4 | `agent.ts` `transportOf()` | 4 组 token → 字面量 | UI 识别结果与实际不符 |
| 5 | `agentFormChat.ts` `TRANSPORT_LABELS` | 4 键 → 文案 | UI 显示 undefined |

`#1` 有编译器兜底，**`#2`–`#5` 全是静默失败**。它们目前靠一条「前端读 Rust 源码做字符串比对」的护栏勉强维系（`chatLaunch.test.ts` 的 `agrees with the backend recogniser on every token`）—— 那是**测试在替类型系统干活**。

## 另外三个具体的「写死」

### A · 进程内实现被挤出枚举

```rust
// adapter.rs —— 需要一条 if 提前拦
if config.is_inprocess_chat() {
    return Ok(Box::new(AcpAdapter::mock()));
}
```

实际有 5 种情形，枚举只有 4 个变体。第 5 种（acp + 进程内）无处安放，只能做成 `match` 之外的特例。加上本轮的 `chat_enabled` 判断后，会成为 3 层前置早退 + 4 分支。

### B · 按可执行文件名猜帧格式

```rust
// acp.rs:411 AcpAdapter::new
let wire_format = if cmd.first().is_some_and(|c| c.contains("opencode") || c.contains("kilo")) {
    Some(WireFormat::Ndjson)
} else { None };
```

**用文件名子串推断线上协议**。用户把 opencode 装成 `oc`、或包一层 `my-opencode`，就换错帧格式 —— 且没有任何报错，只是服务端解析失败。这违反 `agent-chat-transports.md` §1 的同一条原则（「适配器内部不得出现 id/名称分支」）。

正确入口 `with_wire_format()` 在生产代码里**零调用**。

### C · 提取协议知识散落成常量与字符串

「`acp` / `serve` / `--mode rpc` 这些 token 表示什么协议」这条知识，现在用 4 份不同的表示存在于 Rust 与 TS：

- Rust：`transport()` 里的 `if tokens.contains("acp")` 链
- Rust：`as_str()` 里的 `match` → `"acp"`
- TS：`transportOf()` 里重复一遍 `tokens.includes('acp')`
- TS：`TRANSPORT_LABELS` 的键

同一件事讲了四次。

## 需求

### R1 · 单一注册表：一个协议一条记录

把「协议是什么、怎么识别、怎么构造 adapter、叫什么名字」收进**一个结构**：

```rust
// src-tauri/src/agent/chat/registry.rs
pub struct ProtocolDef {
    pub transport: ChatTransport,
    /// 稳定标识符（日志 / 错误信息 / 前端展示键）。**唯一**来源。
    pub id: &'static str,
    /// 从 argv token 流识别该协议的判据（完整 token 比较）。
    pub recognize: fn(&[&str]) -> bool,
    /// 构造 adapter。收 `LaunchSpec` 而不是 `AgentConfig`。
    pub build: fn(LaunchSpec, &ChatLaunch) -> Box<dyn AgentAdapter>,
}

pub static PROTOCOLS: &[ProtocolDef] = &[
    ProtocolDef { transport: ChatTransport::Acp,   id: "acp",    recognize: …, build: … },
    ProtocolDef { transport: ChatTransport::Serve, id: "serve",  recognize: …, build: … },
    ProtocolDef { transport: ChatTransport::Jsonl, id: "jsonl",  recognize: …, build: … },
    ProtocolDef { transport: ChatTransport::PiRpc, id: "pi-rpc", recognize: …, build: … },
];
```

新增一种协议 = **加一条记录**。`transport()` / `as_str()` / `adapter_for` 全部改为遍历该表，不再各自 `match`。

#### R1.1 表化的**已知代价**（评审 [R1/R2] 修订）

原方案声称「`static` 数组 = 集合编译期可见」，**这是错的**。`static` 只让表内容编译期可见，
而「枚举变体 ↔ 表项」的映射由 `protocol_of()` 在运行期 `find` 完成：

| 形态 | 加枚举变体但不加表项 |
| --- | --- |
| 原 `adapter_for` 的 `match` | **编译报错** |
| 本方案的 `static` 表 | 编译通过，运行期 panic |

所以表化**确实**用「编译期报错」换了「运行期 assert」。必须用两道防线抵消：

1. **穷举测试**：`for t in ChatTransport::ALL { protocol_of(t); }` + `PROTOCOLS.len() == ALL.len()`；
2. **`ChatTransport::ALL` 单一变体列表**：新增变体不在 `ALL` 里，serde 往返测试即红。

不采纳「`ChatTransport(&'static str)` newtype」方案：`ChatTransport` 是既有 serde 契约的一部分
（旧配置 `"chat": "serve"` 迁移依赖它），newtype 会引入手写 `FromStr` 并失去 `Debug` 穷举提示。

### R2 · 进程内实现进入表内，不再是特例

`ChatTransport` 加 `Mock` 变体？**不**——进程内不是传输，是「怎么跑」。改为：

```rust
/// 启动规格 —— 从 `AgentConfig` 派生，adapter 层唯一输入。
pub struct LaunchSpec {
    pub cmd: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// 进程内实现（不 spawn）。由 `ChatLaunch::inprocess` 显式声明。
    pub inprocess: bool,
}
```

`adapter_for` 里那条 if 消失：`build` 收到 `LaunchSpec` 后自己决定（`AcpAdapter` 的 build 看 `spec.inprocess` → `mock()`）。**判断收进协议自己的构造器**，不再由分派层特判。

### R3 · `wire_format` 成为配置字段，删掉**运行时**文件名推断

```rust
pub struct ChatLaunch {
    // …program / args / env / inprocess
    /// ACP 帧格式；`None` = 协议默认（Content-Length）。
    pub wire_format: Option<WireFormat>,
}
```

`WireFormat` 从 `acp.rs` 挪到 `chat_launch.rs`（它成了配置项，不再是 adapter 私有类型）。
内置 `opencode` 显式声明 `wire_format`（走 serve，不受影响）。

#### R3.1 迁移必须在反序列化期完成（评审 [R3]）

删掉运行时推断会让**现有自定义 `opencode acp` 用户静默失效**：
旧配置无 `wire_format` 字段 → 默认 `ContentLength` → 向期待 NDJSON 的 server 发
`Content-Length: 123\r\n\r\n{...}` → **握手无响应、无报错、永远转圈**。

因此 `#[serde(from = "RawChatLaunch")]` 里必须做一次性推断：

```rust
fn infer_legacy_wire_format(program: Option<&str>, wf: Option<WireFormat>) -> Option<WireFormat> {
    if wf.is_some() { return wf; }
    let exe = program.unwrap_or_default();
    (exe.contains("opencode") || exe.contains("kilo")).then_some(WireFormat::Ndjson)
}
```

| | 运行时推断（删除） | 迁移期推断（新增） |
| --- | --- | --- |
| 执行次数 | 每次 spawn | 每次读**旧配置**一次 |
| 用户可见 | 否 | 是（值落在 `config.json`） |
| 改名/包装器 | 静默换协议 | 已持久化的值不受影响 |

迁移只发生在反序列化，**不做一次性文件重写**（与既有 R4 决定一致）。

### R4 · 前端从「重复规则」改为「消费后端标识」

前端不再自己扫 token。`transportOf()` 保留（同步场景需要），但把它变成**单一映射表**：

```ts
// shared/types/agent.ts
export const TRANSPORTS = [
  { id: 'acp',    tokens: ['acp'],                    label: 'ACP · JSON-RPC stdio' },
  { id: 'serve',  tokens: ['serve'],                  label: 'opencode serve · HTTP + SSE' },
  { id: 'jsonl',  tokens: ['--jsonl', 'stream-json'], label: 'JSON-Lines stdio' },
  { id: 'pi-rpc', tokens: ['--mode rpc', 'rpc'],      label: 'Pi rpc · private NDJSON' },
] as const;
```

`transportOf` 与 `TRANSPORT_LABELS` 都从这张表派生。**跨栈一致性护栏**改为断言「后端 `PROTOCOLS` 的 `id` 集合 == 前端 `TRANSPORTS` 的 `id` 集合」——比现在逐 token 比对更稳，因为 token 规则归后端所有。

### R5 · 内置 agent 的 chat 协议锁定

`chat: Option<ChatLaunch>` 是**出厂事实**（内置不可覆盖），`chat_enabled: Option<bool>` 是**用户偏好**。

```rust
pub fn is_chat_agent(&self) -> bool {
    self.chat.is_some() && self.chat_enabled != Some(false)
}
```

`restore_overrides` 保护 `chat`，防止旧覆盖层把出厂协议回滚（spec §10.5d 的事故形态）。

### R6 · 前端配置项：按 agent 身份分三态

**这是本任务的用户可见成果**，不只是「后端字段加个开关」。

#### R6.1 三条渲染路径

| Agent | CHAT 区内容 | 可编辑项 |
| --- | --- | --- |
| 内置 + 出厂有 chat（opencode / pi / grok） | 只读协议说明 + `Enable chat` 开关 | `chat_enabled` |
| 内置 + 出厂无 chat（gemini / codex / qoder / codebuddy / omp / reasonix） | 一行说明 + 引导 | 无 |
| 自定义 | argv 编辑器 + in-process 复选框 + env textarea | 全部 |

#### R6.2 表单态字段

```ts
// FormState
chatArgv: string[];             // 仅自定义可编辑；内置只读时仍填充（展示协议需要）
chatEnvText: string;            // 同上
chatInprocess: boolean;         // 同上
chatEnabled: ChatEnabledChoice; // 'default' | 'on' | 'off' —— **三态，禁止压成 boolean**
```

#### R6.2.1 `chat_enabled` 必须保留三态（评审 [R4]）

```ts
export type ChatEnabledChoice = 'default' | 'on' | 'off';

// toFormState
chatEnabled: form.chat_enabled === false ? 'off'
           : form.chat_enabled === true  ? 'on'
           : 'default',
```

若表单态写成 `boolean`，`None` 会被投影成 `true`，用户切换一次后写入 `Some(true)` ——
**将来出厂默认变化永远追不上**（反向的「旧快照回滚出厂升级」，与本任务要防的
spec §10.5d 事故同型，只是方向相反）。

UI：复选框 + 「Reset to default」链接（仅 `'on' | 'off'` 时显示），语义同 VS Code
「settings.json 值 vs 默认值」。

#### R6.3 提交（`buildConfig`）

```ts
// 内置 agent：chat 是出厂事实，必须原样带回；只写 chat_enabled
chat: initial?.is_builtin ? (initial.chat ?? null) : buildChatLaunch(...),
chat_enabled: initial?.is_builtin ? t.chatEnabled : null,
```

**漏掉 `initial.chat` 这行 = 用户点一次开关就清空出厂协议，且界面上看不出来**（开关本身还在，只是背后协议没了）。这是本任务最高风险点，必须有变异验证。

#### R6.4 交互流程

| 动作 | 结果 |
| --- | --- |
| 打开内置 opencode 表单 | 显示 `Protocol: opencode serve · HTTP + SSE`（只读）+ 已勾选的 `Enable chat` |
| 取消勾选并保存 | `chat_enabled: false`；出厂 `chat` 不变；agent bar / chat 列表里该 agent 不再提供 chat |
| 重新勾选并保存 | `chat_enabled: null`（回到跟随定义）或 `true`；chat 恢复 |
| 打开内置 gemini 表单 | `This agent has no built-in chat protocol. To use it over ACP, add a custom agent with the ACP command.` |
| 打开自定义 agent 表单 | 默认空 argv + 占位提示 `acp`；用户自己填 program 与参数 |
| 自定义 agent 填 `opencode` + `acp` | 识别为 ACP；模型列表只在会话内可用（能力位驱动提示） |
| 关闭 chat 时**已有会话在跑** | **不中断**当前会话；只影响新会话创建（adapter 在 open 时快照配置） |
| 内置无 chat 的 agent 被旧覆盖层塞入 `chat` | 表单保存时**抛错**提示改用自定义 agent，不静默丢弃 [R6] |

#### R6.5 只读展示的协议文案来源

内置 agent 的协议标签**必须**来自 `TRANSPORTS` 表（R4），不得硬编码：

```tsx
const transport = transportOf(initial.chat);
const label = transport ? TRANSPORT_LABELS[transport] : null;
```

这样新增协议时 UI 自动正确。

#### R6.6 能力徽标

`CapabilityBadges` 的 CHAT 徽标必须按 `isChatEnabled()` 判断（R7），关掉时显示灰态而非消失 —— 让用户看得出「有但被关了」而不是「本来就没有」。

### R7 · 前端判据收口

```ts
// src/shared/types/agent.ts
export function isChatEnabled(agent: {
  chat?: ChatLaunch | null;
  chat_enabled?: boolean | null;
}): boolean {
  return Boolean(agent.chat) && agent.chat_enabled !== false;
}
```

替换全部「有没有 chat」的判断：

| 位置 | 现状 | 改后 |
| --- | --- | --- |
| `shared/types/agent.ts:117` `agentCapabilities()` | `chat: Boolean(agent.chat)` | `chat: isChatEnabled(agent)` |
| `shared/utils/agents.ts:85` `isTranslatableAgent()` | `Boolean(agent.chat)` | `isChatEnabled(agent)`（形状加 `chat_enabled`） |
| `CapabilityBadges.tsx:56` 的 `Pick<>` | `'command' \| 'chat' \| 'prompt_args'` | 加 `'chat_enabled'`（否则 `isChatEnabled` 读不到该字段） |

**`CapabilityBadges` 的类型收窄是真陷阱**：`Pick<AgentConfig, …>` 少一个字段就编译不过，
但若改成 `Pick<AgentConfig, 'chat'>` 再 cast 就会静默忽略 `chat_enabled`。
必须把 `chat_enabled` 加进 `Pick` 联合，让「关掉 chat」能被徽标读到。

`CapabilityBadges` 的 CHAT 徽标本身不消失，改为**灰态**（`kind === 'chat' && !enabled`
时降透明度 + `title="CHAT is disabled"`）—— 用户要能区分「本来没有」与「被你关了」。

后端侧对应判据收口到 `list_chat_agents`（过滤改 `a.enabled && a.is_chat_agent()`）。

### R8 · `useChatAgents` 接入 `agentStore`（评审 [R5]，本方案原漏项）

`src/features/agent-chat/hooks/useChatAgents.ts` 现状是**空依赖 `useEffect` + 独立 `useState`**：

```ts
useEffect(() => { void listChatAgents().then(setChatAgents); }, []);   // 只在挂载时拉一次
```

三个后果在本任务范围内被放大：

1. 用户关掉内置 opencode 的 chat 并保存 → 后端列表已正确排除 → **chat 页下拉仍是旧列表**
   （组件没重新挂载），选中它才由 `adapter_for` 返回 `Unsupported` 报错 —— 列表里那一项看起来正常；
2. `saveAgent()` 的 `refresh()` 刷的是 `agentStore`，**打不到这个 hook**（它不订阅）；
3. `selectedAgent` 的「列表首项」fallback 会选中**已不可用**的 agent 作为首帧默认值。

改为从 `agentStore` 派生：

```ts
const all = useAgentStore((s) => s.agents);              // null = 未加载
const chatAgents = useMemo(() => (all ?? []).filter(isChatEnabled), [all]);
```

若确需后端权威列表（后端有前端看不到的过滤条件），则订阅 `agentStore` 的 `version` 作重拉触发。
**不得保留空依赖 `useEffect`。**

### R9 · 敏感值不落明文（评审 [R13]）

`ChatLaunch::env` 是本任务新引入的**第一个真正承载凭证**的字段
（用户会往里填 `ANTHROPIC_API_KEY`）。已核实：`~/.neeko/config.json` 是明文 JSON
（`session/manager.rs:137`），`Cargo.toml` **无任何** keyring / aes 依赖。

本任务采纳最小方案（不引依赖）：

```
CHAT Env:  KEY=!ANTHROPIC_API_KEY
```

- `!` 前缀 = 「从父进程继承同名变量」，**配置里只存引用不存值**；
- `chat_env()` 解析 `!` 引用，找不到变量则**报错**（不静默传空串）；
- 与 `docker-compose` 的 env 插值语法一致，用户零学习成本。

完整方案（系统 Keychain / Windows Credential Manager）单开任务，在「已知限制」记录。

## 已知限制

| 限制 | 原因 | 后续 |
| --- | --- | --- |
| `ChatLaunch.env` 的**非 `!` 值**仍以明文存 `config.json` | 本任务不引入加密依赖；改用 `!VAR` 引用可避免落盘 | 单开任务接 `keyring` crate（`neeko/agent-env/{agent_id}/{KEY}`） |
| 表化后「加枚举变体不加表项」不再编译报错 | §R1.1 的已知代价，用穷举测试抵消 | 可考虑 `#[deny]` 级 clippy 自定义 lint |
| `chat_enabled` 关闭不中断运行中会话 | adapter 在 open 时快照配置（design §4.1） | 若需热停，需先定义 adapter 的 cancel 协议 |

## 非目标

- 不引入运行时注册（`HashMap` + 动态注册）—— 表是 `static`，编译期可见。
- 不做 ACP 探测（用户自己负责填对命令）。
- 不引入「一个 agent 多 chat profile」。
- `LaunchSpec` 不做成 trait object（保持值类型）。

## 验收标准

1. `adapter_for` 内**不含**任何 `ChatTransport::` 分支（`grep` 断言），全部走 `PROTOCOLS` 遍历。
2. 新增一种协议 = **后端 `PROTOCOLS` 一行 + 前端 `TRANSPORTS` 一行**；两处缺一由生成物护栏报错。
3. `chat_launch.rs` 的 `transport()` 与 `as_str()` 从 `PROTOCOLS` 派生，不再各自 `match`。
4. **穷举防线**：`for t in ChatTransport::ALL { protocol_of(t) }` 通过；`PROTOCOLS.len() == ALL.len()`。
5. `AcpAdapter::new` 内**不含**命令名子串判断；`wire_format` 来自 `ChatLaunch`。
6. **旧配置 `{"program":"opencode","args":["acp"]}`（无 `wire_format`）加载后 `wire_format == Some(Ndjson)`**
   —— 反序列化期迁移有效（变异：删掉迁移后该测试必红）。
7. 进程内实现不再由 `adapter_for` 特判 —— `adapter_for` 只有 2 条前置早退（无 chat / 被关闭）。
8. **内置 agent 保存后 `chat` 与出厂定义逐字相等**，含 `program: None` **不得**变成 `Some(cmd)`。
9. `chat_enabled = Some(false)` → `adapter_for` 返回 `Unsupported`，`is_chat_agent()` 为 false，
   `list_chat_agents` 不含该 agent。
10. 旧 `config.json` 的覆盖层 `chat` 值被忽略（回落出厂）；`chat_enabled` 保留。
11. **UI 三条渲染路径**：内置有 chat → 只读协议 + 开关（无 argv 编辑器）；
    内置无 chat → 说明文案；自定义 → 完整编辑器。
12. **只读协议标签来自 `TRANSPORTS` 表**，`AgentForm` 内无硬编码协议名。
13. **前端判据收口**：`grep -rn "Boolean(.*\.chat)" src/` 无结果；
    `CapabilityBadges` 关掉的 chat 显示灰态而非消失。
14. **`useChatAgents` 无空依赖 `useEffect`**：关闭某 agent 的 chat 后列表立即少一项
    （测试：`agentStore` 更新 → hook 返回的列表同步变化）。
15. **`chatEnabled` 三态往返**：打开内置 agent 表单直接保存 → `chat_enabled` 保持原值
    （`None` 不得变 `Some(true)`）。
16. **`enabled` × `chat_enabled` 四组合语义**（design §3.1 表）各有断言，
    `enabled: false` 的 agent 不进 `list_chat_agents`。
17. `KEY=!VAR` 引用语法：配置里存 `!VAR` 字面量；spawn 时展开为父进程值；变量缺失时报错。
18. `pnpm check:quick` + `cargo test` 全绿；`pnpm check` 含 `git diff --exit-code src/generated/`；
    每条新护栏做变异验证。
