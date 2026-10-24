# Design · Chat 传输注册表

> 本版已按 TBR 评审意见修订。修订点以 **[R#]** 标注，对应评审报告条目。
> 核心修订：撤回「static 表 = 编译期穷举」的错误论断 [R1/R2]；`wire_format` 改为反序列化期迁移 [R3]；
> `chat_enabled` 表单态保留三态 [R4]；补 `useChatAgents` 同步 [R5]；`env` 明文暴露面标注 [R13]。

## 1. 第一性原理

「一种 chat 协议」包含**四个必须同步的方面**：

1. 它叫什么（标识符，用于日志与前端展示）
2. 怎么从启动命令识别它
3. 怎么构造处理它的 adapter
4. 它支持哪些能力（`ChatCapabilities`）

现在这四件事分散在 5 个位置，用 4 种不同表示（`match` 分支、`if contains` 链、`&'static str` 字面量、TS 键）。**同一件事讲了四遍，且只有 `adapter_for` 那一处有编译器兜底。**

**判断**：协议集合是已知且封闭的（4 种）。表化能消掉 4 处重复，但**必须承认它的代价** —— 见 §2.2 的诚实结论。

## 1.5 分层裁决（实施前确定，不得偏离）

原设计把含 `build` 的 `PROTOCOLS` 放进 `common/agent/chat_launch.rs`。**这会造成分层环**，已否决：

| | |
| --- | --- |
| 现状 | `common/` 对 `agent/chat` 的**生产依赖为零**（唯一引用是 `chat_launch.rs:544` 测试里的 `builtin_configs`） |
| 若注册表放 `common/` | `common/agent/chat_launch` → `agent/chat/adapter` ← `common/agent/types` **成环**；且把 `tokio`/`async_trait`/会话栈拖进数据模型层 |
| 既有先例 `common/error.rs:100` 引用 `crate::agent::AgentManager` | 那是错误类型聚合，与「数据模型反向依赖 adapter 层」性质不同，不可援引 |

**裁决**：按「这条知识属于谁」切开，`ChatTransport` 是两侧共有的键。

| 关注点 | 归属 | 形态 | 为什么 |
| --- | --- | --- | --- |
| **怎么识别**（token 规则 + `id`） | `common/agent/chat_launch.rs` | `TRANSPORT_RULES: &[TransportRule]`（**纯数据**，无闭包、无 `Box<dyn>`） | 它是 argv 的释义规则，属 `ChatLaunch` 自身，不需任何 adapter 知识 |
| **怎么构造**（`build`） | `agent/chat/registry.rs`（新增） | `PROTOCOL_BUILDS: &[BuildDef]` | 属 adapter 实现，必须留在 domain |

新增一种协议的实际代价：**3 行**（token 规则一行 + 构造一行 + 前端一行）。
比理想的 2 行多一处，换来 `common` 不反向依赖 transport 实现 —— 这个取舍在 §5 已登记。

替代方案「把 `ChatTransport` / `transport()` 一并下沉到 `agent/chat/`」可压到 2 处，
但要把 `chat_transport()` 从 `AgentConfig` 摘走、动 `builtin/tests.rs` 与所有引用，
churn 远大于收益，**不采纳**。

### 1.6 实施期发现：`wire_format` 迁移的判别式陷阱

设计初稿把 `infer_legacy_wire_format` 同时接在 `from_current_object` 上。**这是错的**，
被既有不变量测试当场抓住：

`{"program":"opencode","args":["serve"]}` 是**我们自己的 `Serialize` 输出**（`program`
显式、`wire_format` 缺省），对它做迁移会让「读回自己写的东西」凭空多出一个字段 ——
保存一次就永久漂移。

这与当初 `ChatStart` → `ChatLaunch` 迁移踩的是同一个坑：**判别式必须用旧格式独有的键**。
现在的规则：

| 输入形态 | 跑迁移？ | 理由 |
| --- | --- | --- |
| 裸串 `"serve"`（旧格式 A） | ✅ | 旧格式独有 |
| `{"transport":…}`（旧格式 B） | ✅ | **只有旧格式写 `transport` 键** |
| `{"program":…}`（当前形态） | ❌ | 这是我们自己的输出 |

护栏：`wire_format_migration_does_not_touch_current_form` +
`every_launch_round_trips_through_its_own_output`（后者是既有的往返不变量）。

### 1.7 实施期发现：迁移必须尊重显式值

`from_legacy_object` 最初直接调 `infer(program, launch.wire_format)`，而
`launch.wire_format` 来自 `"serve"` 的映射（恒为 `None`）—— 于是旧对象自己带的
`"wire_format": "content-length"` 被 program 推断覆盖。

**变异验证抓到的**（把 `explicit.is_some()` 短路删掉时该用例仍绿，说明测试写错了；
用它测当前形态等于测了个空）。修法：`chat_field(obj, "wire_format")?.or(launch.wire_format)`。

## 2. 核心契约

### 2.1 `LaunchSpec` —— adapter 层的唯一输入

```rust
// src-tauri/src/agent/chat/launch_spec.rs
/// 启动一个 chat 进程所需的**全部**信息。
///
/// 从 `AgentConfig` 派生一次，是 adapter 层唯一输入 ——
/// adapter 模块不再 import `AgentConfig`，也不再 import `ChatLaunch`。
#[derive(Debug, Clone)]
pub struct LaunchSpec {
    /// 完整 argv：`[program?, ...args]`。由 `AgentConfig::chat_cmd_vec()` 展开，
    /// **尚未**追加协议专属参数（`ServeAdapter` 的 `--hostname/--port` 由它自己加）。
    pub cmd: Vec<String>,
    pub env: BTreeMap<String, String>,
    /// 进程内实现（不 spawn 子进程）。
    pub inprocess: bool,
    /// ACP 帧格式。`None` = `ContentLength`。
    /// 从 `ChatLaunch::wire_format` 原样搬来（该字段是配置项，见 §2.5）。
    pub wire_format: Option<WireFormat>,
}
```

**[R7 已采纳]** `cmd` 与 `inprocess` 的互斥用枚举表达，让「进程内却有 argv」不可构造：

```rust
pub enum LaunchMode {
    /// spawn 子进程。`cmd[0]` 是 argv[0]。
    Process { cmd: Vec<String> },
    /// 进程内实现，无 argv。
    InProcess,
}

pub struct LaunchSpec {
    pub mode: LaunchMode,
    pub env: BTreeMap<String, String>,
    pub wire_format: Option<WireFormat>,
}

impl LaunchSpec {
    /// 展开后的 argv（`InProcess` 时为空）。
    pub fn cmd(&self) -> &[String] {
        match &self.mode {
            LaunchMode::Process { cmd } => cmd,
            LaunchMode::InProcess => &[],
        }
    }
}
```

`AgentConfig::chat_launch_spec()` 是唯一构造入口：

```rust
impl AgentConfig {
    pub fn chat_launch_spec(&self, launch: &ChatLaunch) -> LaunchSpec {
        LaunchSpec {
            mode: if launch.inprocess {
                LaunchMode::InProcess
            } else {
                LaunchMode::Process { cmd: self.chat_cmd_vec() }
            },
            env: self.chat_env(),
            wire_format: launch.wire_format,
        }
    }
}
```

**为什么 `wire_format` 进 spec 而不是留给 `build` 的第二个参数** [Q5]：`ChatLaunch` 的全部信息一旦
拆进 `LaunchSpec`，`build` 就只需要一个参数，且表项不必同时理解两个类型：

```rust
pub build: fn(LaunchSpec) -> Box<dyn AgentAdapter>,
```

`ServeAdapter` 拿到 `spec.cmd()` 后自己追加 `--hostname/--port`（既有行为不变，`connection.rs:103-108`）。

### 2.2 注册表

```rust
// src-tauri/src/agent/chat/registry.rs
pub struct ProtocolDef {
    pub transport: ChatTransport,
    /// 稳定标识符。日志、错误信息、前端展示键的**唯一**来源。
    pub id: &'static str,
    /// 从 `ChatLaunch` 识别该协议。必须**完整 token** 比较。
    pub recognize: fn(&ChatLaunch) -> bool,
    /// 构造 adapter。
    pub build: fn(LaunchSpec) -> Box<dyn AgentAdapter>,
}

/// 协议表 —— 表项顺序即**优先级**（`acp` 在 `serve` 之前）。
pub static PROTOCOLS: &[ProtocolDef] = &[ … 4 项 … ];

impl ChatTransport {
    /// 全部变体。新增变体必须同步这里 —— 见 §2.2.1 的诚实结论。
    pub const ALL: &'static [Self] = &[Self::Acp, Self::Serve, Self::Jsonl, Self::PiRpc];
}

/// 按 transport 查表。**查不到即程序 bug**，失败必须是响亮的。
pub fn protocol_of(transport: ChatTransport) -> &'static ProtocolDef {
    PROTOCOLS
        .iter()
        .find(|d| d.transport == transport)
        .unwrap_or_else(|| panic!(
            "PROTOCOLS 缺少 {transport:?} 的表项；\
             新增 ChatTransport 变体时必须同时加一条 ProtocolDef \
             （src-tauri/src/agent/chat/registry.rs）"
        ))
}
```

#### 2.2.1 诚实结论：表化**不能**恢复编译期穷举 [R1/R2]

评审指出的错误论断已撤回。事实是：

| 形态 | 加枚举变体但不加表项 | 加表项但写错 id |
| --- | --- | --- |
| 原 `match`（`adapter_for`） | **编译报错** | 不存在该问题 |
| 本方案的 `static` 表 | 编译通过，`protocol_of` 运行期 panic | 编译通过，两端护栏报错 |

所以表化**确实**用「编译期报错」换了「运行期 assert」。这是本设计的**已知代价**，必须用两道防线抵消：

**防线 1 · 穷举测试**（把编译期约束搬成测试期约束）：

```rust
#[test]
fn every_transport_variant_has_a_registry_entry() {
    for &t in ChatTransport::ALL {
        let def = protocol_of(t);          // panic 即失败
        assert_eq!(def.transport, t);
    }
    // 反向：表里不能有 ALL 之外的条目（防手写重复）
    assert_eq!(PROTOCOLS.len(), ChatTransport::ALL.len());
}
```

**防线 2 · `ALL` 与枚举同源**：把 `ChatTransport` 的变体列表只在 `ALL` 里写一遍，其余位置遍历它。
新增变体时若无 `ALL`，「枚举 → 字符串」的反序列化测试（`parse("…")` 往返）会红。

**为什么不改成 `ChatTransport(&'static str)` newtype**（评审建议的方案 A）：
`ChatTransport` 仍是既有 serde 契约的一部分（旧配置 `"chat": "serve"` 的迁移依赖它），
newtype 会让反序列化多一层手写 `FromStr`，且失去 `Debug` 的穷举提示。收益不抵成本，**不采纳**。

### 2.3 `transport()` 从表派生

```rust
impl ChatLaunch {
    /// argv token 流（program 在前）。零分配：迭代器而非 `Vec<&str>`。 [R8]
    pub fn tokens(&self) -> impl Iterator<Item = &str> {
        self.program.iter().map(String::as_str)
            .chain(self.args.iter().map(String::as_str))
    }

    pub fn transport(&self) -> ChatTransport {
        // 表的顺序即优先级，必须可断言（见 step 1 测试）。
        PROTOCOLS.iter()
            .find(|d| (d.recognize)(self))
            .map_or(ChatTransport::Acp, |d| d.transport)   // 默认：唯一通用协议
    }
}
```

`recognize` 写成非捕获闭包即可强制为 `fn` 指针：

```rust
recognize: |l| l.tokens().any(|t| t == "acp"),
recognize: |l| l.tokens().any(|t| t == "--jsonl" || t == "stream-json"),
recognize: |l| {
    let v: Vec<&str> = l.tokens().collect();   // 仅 PiRpc 需要看相邻对
    v.contains(&"rpc") || v.windows(2).any(|w| w == ["--mode", "rpc"])
},
```

### 2.4 `adapter_for` 收敛

```rust
pub fn adapter_for(config: &AgentConfig) -> Result<Box<dyn AgentAdapter>, AppError> {
    let Some(launch) = config.chat.as_ref() else {
        return Err(AppError::Unsupported(format!(
            "agent '{}' has no CHAT capability (terminal/headless only)", config.id
        )));
    };
    if config.chat_enabled == Some(false) {
        return Err(AppError::Unsupported(format!(
            "agent '{}' chat is disabled by the user", config.id
        )));
    }
    let spec = config.chat_launch_spec(launch);
    Ok((protocol_of(launch.transport()).build)(spec))
}
```

零 `ChatTransport::` 分支，只有 2 条前置早退。

**[R14 已核实]** `adapter_for` 的调用**在 `Mutex<AgentManager>` 锁外**：
`resolve_agent_config`（`chat/commands.rs:69-77`）在锁内 `clone()` 后立即 drop 锁，
`adapter_for(&agent)` 接收的是已独立的 `AgentConfig`。因此本任务在 `adapter_for` 内
新增的 `chat_launch_spec()`（含一次 `BTreeMap` 构造）**不发生在锁内**，无需额外改动。
`plugin.rs::chat_adapter` 持 `&'a AgentConfig`（调用方已 clone），同样在锁外。

### 2.5 `wire_format` 成为配置项 + **反序列化期迁移** [R3]

```rust
// chat_launch.rs —— 类型从 acp.rs 挪来（它成了配置的一部分）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WireFormat { ContentLength, Ndjson }

pub struct ChatLaunch {
    // …
    /// ACP 帧格式。`None` = `ContentLength`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wire_format: Option<WireFormat>,
}
```

**删掉运行时推断**（`acp.rs:411-420` 的 `cmd[0].contains("opencode")`）。
但**不能**让老用户的 `opencode acp` 静默失效 —— 迁移在反序列化期做一次。

**落点**（已核实）：`ChatLaunch` 用的是**手写 `Deserialize`**（`chat_launch.rs:161`），
不是 `#[serde(from)]`。三条迁移路径共用同一个收尾函数：

```rust
// chat_launch.rs —— 三条迁移路径 (legacy_str / legacy_object / current_object)
// 的最后一步都过它。
//
// ## 迁移期推断 ≠ 运行时推断
//
// 这里的 `contains("opencode")` 是**刻意的**，与被删除的 `AcpAdapter::new` 推断
// 有本质区别：它只在「读没有 wire_format 键的旧配置」时跑一次，结果**落进
// ChatLaunch 并被持久化**，此后行为可被用户看见与覆盖。
// 运行时推断是每次 spawn 都跑、用户不可见、改名即静默换协议。
fn infer_legacy_wire_format(program: Option<&str>, wf: Option<WireFormat>) -> Option<WireFormat> {
    if wf.is_some() { return wf; }          // 显式值优先
    let exe = program.unwrap_or_default();
    (exe.contains("opencode") || exe.contains("kilo")).then_some(WireFormat::Ndjson)
}
```

`from_current_object` 也要过它 —— 旧配置里 `chat` 是当前对象形态（`{"program":…,"args":…}`）
但没有 `wire_format` 键，这正是受影响最广的一类。

| | 运行时推断（删除） | 迁移期推断（新增） |
| --- | --- | --- |
| 执行次数 | **每次 spawn** | 每次**读旧配置**一次 |
| 用户可见 | 否 | 是（值落在 `config.json`，可在表单改） |
| 改名/包装器 | **静默换协议** | 已持久化的值不受影响 |
| 调试点 | 无 | 配置文件里直接看到 |

内置 `opencode` 走 serve，不受影响；受影响的只有自定义 `opencode acp` —— 而这类配置**必须**保持可用。

### 2.6 前端：一张表，两个派生

```ts
// src/shared/types/agent.ts
export interface TransportDef {
  id: ChatTransport;
  tokens: string[];
  tokenPairs?: [string, string][];
  label: string;
}

/** **顺序即优先级**，必须与后端 `PROTOCOLS` 逐项一致（护栏断言）。 */
export const TRANSPORTS: readonly TransportDef[] = [
  { id: 'acp',    tokens: ['acp'],                    label: 'ACP · JSON-RPC stdio' },
  { id: 'serve',  tokens: ['serve'],                  label: 'opencode serve · HTTP + SSE' },
  { id: 'jsonl',  tokens: ['--jsonl', 'stream-json'], label: 'JSON-Lines stdio' },
  { id: 'pi-rpc', tokens: ['rpc'], tokenPairs: [['--mode', 'rpc']], label: 'Pi rpc · private NDJSON' },
];
```

`transportOf` 与 `TRANSPORT_LABELS` 从表派生（`TRANSPORT_LABELS` 改用 `Object.fromEntries`，
**删除** `agentFormChat.ts` 里的本地副本，改为 re-export）。

#### 2.6.1 跨栈护栏改为机器可读源 [R9]

评审指出「正则抓 Rust 源码」比现有护栏更脆。改为**生成 + 类型安全消费**：

```rust
// registry.rs 的 #[test]：把表写成 JSON 供前端消费
#[test]
fn export_protocol_table_for_the_frontend() {
    let json = serde_json::to_string_pretty(PROTOCOLS.iter()
        .map(|d| json!({ "id": d.id, "transport": format!("{:?}", d.transport) }))
        .collect::<Vec<_>>()).unwrap();
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/generated/protocols.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, format!("{json}\n")).unwrap();
}
```

前端：

```ts
import generated from '@/generated/protocols.json';
it('frontend transports mirror the backend registry', () => {
  expect(TRANSPORTS.map((d) => d.id)).toEqual(generated.map((d) => d.id));
});
```

**为什么这比读源码更好**：无正则、无格式耦合；`generated/protocols.json` 进 git，
CI 可 diff 出「后端改了但前端没跟」；错误信息直接指出**哪一侧**漂移 [Q4]。

**注意**：该 `#[test]` 会写文件。CI 需断言 `git diff --exit-code src/generated/`
（否则会出现「本地绿、CI 红」）。这条写进 `implement.md` Step 4。

### 2.7 表顺序 = 优先级 = 契约 [Q4]

护栏区分「漂移」与「有意修改」：

- 生成物 `protocols.json` 是**后端**快照。前端顺序与之不符 → 报错信息写
  「前端 TRANSPORTS 顺序与后端 PROTOCOLS 不一致；**若要改优先级，请改后端表顺序并重新生成**」。
- 后端表顺序改动会重新生成 JSON，此时前端若未跟进 → 同一条护栏红。
- 另有一条**独立**行为断言锁住语义：`launch(Some("opencode"), ["serve","acp"]).transport() == Acp`。
  即使两端顺序被同步改错，这条行为测试也会红 —— 它不依赖表顺序，是最终权威。

## 3. 内置 agent 的协议锁定

### 3.1 字段与判据

```rust
pub struct AgentConfig {
    pub chat: Option<ChatLaunch>,       // 出厂事实，内置不可覆盖
    pub chat_enabled: Option<bool>,     // 用户偏好，None = 跟随定义
}

pub fn is_chat_agent(&self) -> bool {
    self.chat.is_some() && self.chat_enabled != Some(false)
}
```

**[Q3] `enabled` × `chat_enabled` 四种组合的语义**（必须全部定义，否则 UI 出现「按钮灰着但不知去哪开」）：

| `enabled` | `chat_enabled` | 含义 | Agent 列表 | Chat 入口 |
| --- | --- | --- | --- | --- |
| true | `None` | 默认启用 | 显示 | 出厂有 chat 则可对话 |
| true | `Some(false)` | 只用终端，不聊天 | 显示 | **灰态**，tooltip「CHAT 已关闭」 |
| false | 任意 | 整体禁用 | **不显示** | 不可达 |
| false | — | — | — | — |

`list_chat_agents` 的过滤表达式：
```rust
.filter(|a| a.enabled && a.is_chat_agent())
```

### 3.2 `restore_overrides` 保护 `chat`

```rust
pub fn restore_overrides(&mut self, overrides: &HashMap<String, AgentConfig>) {
    for (id, cfg) in overrides {
        if let Some(slot) = self.agents.iter_mut().find(|a| a.id == *id && a.is_builtin) {
            let factory_chat = slot.chat.clone();      // 出厂事实
            let mut applied = cfg.clone();
            applied.is_builtin = true;
            applied.chat = factory_chat;               // 不可被旧快照回滚
            applied.chat_enabled = cfg.chat_enabled;   // 用户偏好保留
            *slot = applied;
            self.overridden.insert(id.clone());
        }
    }
}
```

**[Q2] 所有权与幂等性契约**：

- 出厂定义**唯一所有者**是 `agent/builtin/providers.rs`（`AgentManager::new()` 时构造）。
- `restore_overrides` 在 `app_state.rs:458` 启动期**调用一次**；对同一 `overrides` 输入天然幂等
  （每次都从当前 `slot.chat` 取 `factory_chat`，而 `slot.chat` 已被保护为出厂值）。
- **禁止**在运行期刷新内置定义（若将来需要，`factory_chat` 必须改从 `providers.rs` 重新求值，
  而不是从内存槽读）—— 这条写进 spec，防止将来加插件加载时静默破坏语义。

### 3.3 前端配置项：三条渲染路径

```
① 内置 + 出厂有 chat
┌─ Capabilities ─────────────────────────────────────┐
│ CHAT Protocol   opencode serve · HTTP + SSE        │ ← 只读，来自 TRANSPORTS 表
│ [✓] Enable chat           Reset to default         │ ← 三态，见 §3.4
│ Model list: available out of session (serve)       │ ← 能力位驱动
└────────────────────────────────────────────────────┘

② 内置 + 出厂无 chat
┌─ Capabilities ─────────────────────────────────────┐
│ This agent has no built-in chat protocol.          │
│ To talk to it over ACP, create a custom agent      │
│ with the ACP command instead.                      │
└────────────────────────────────────────────────────┘

③ 自定义
┌─ Capabilities ─────────────────────────────────────┐
│ CHAT Launch (first = program · empty = no CHAT)     │
│ [ opencode ] ×   [ acp ] ×   + Add                 │
│ ☐ In-process (no subprocess · e.g. mockAgent)      │
│ Detected: ACP · JSON-RPC stdio                     │
│ CHAT Env (one KEY=value per line)                  │
│ [textarea]                                         │
└────────────────────────────────────────────────────┘
```

判据来源：`initial?.is_builtin` + `initial.chat`（两个既有字段，不新增 `isChatXxx` 布尔）。

### 3.4 表单态：`chat_enabled` **保留三态** [R4]

评审指出：`chatEnabled: boolean` 会把 `None` 压成 `true`，用户切换一次后写入 `Some(true)`，
将来出厂默认变化**永远追不上**（反向的「旧快照回滚出厂升级」）。

```ts
/** 三态显式建模。禁止用 boolean 压缩 —— `None`（跟随默认）不可丢失。 */
export type ChatEnabledChoice = 'default' | 'on' | 'off';

export interface FormState {
  // …既有
  chatArgv: string[];          // 仅自定义可编辑；内置只读展示时仍填充
  chatEnvText: string;
  chatInprocess: boolean;
  chatEnabled: ChatEnabledChoice;
}

// toFormState
chatEnabled: form.chat_enabled === false ? 'off'
           : form.chat_enabled === true  ? 'on'
           : 'default',
```

UI：复选框三态不直观，改为复选框 + 「Reset to default」链接（仅 `chatEnabled === 'on' | 'off'`
时显示）：

```
[✓] Enable chat          Reset to default
```

点 Reset → `chatEnabled = 'default'`。语义与 VS Code 的「settings.json 值 vs 默认值」一致。

### 3.5 提交（最高风险）

```ts
const isBuiltin = Boolean(initial?.is_builtin);

return {
  // …
  // 内置：chat 是出厂事实，原样带回；只写 chat_enabled。
  chat: isBuiltin ? (initial.chat ?? null) : builtChat,
  chat_enabled: isBuiltin
    ? (t.chatEnabled === 'default' ? null : t.chatEnabled === 'on')
    : null,
};
```

**为什么不能走 `builtChat`**：`formatChatLaunch` 会把 `AgentConfig::command` 填进 `program`。
内置 `pi` 出厂 `chat = { program: None, args: ["--mode","rpc"] }`（「沿用 command」），
经表单往返后 `program` 变成 `Some("pi")`（「显式 pi」）—— **语义变了，出厂升级不再跟随**。
这是「投影必须幂等」规则（`type-safety.md`）的违反。

**[R6] 内置无 chat 的 agent 若被写入 chat，必须报错而非静默丢弃**：

```ts
if (isBuiltin && initial.chat == null && builtChat != null) {
  throw new AgentFormError(
    'This built-in agent has no chat protocol. Create a custom agent to use it over ACP.',
  );
}
```

**为什么**：内置 gemini 的 CHAT 区不渲染编辑器，用户无法主动制造这个状态；但它可能由
**旧覆盖层**带入（`restore_overrides` 会把它还原成 `None`）。若表单静默吞掉，用户会以为
「我配了 chat」而实际没有 —— 与 spec §10.5d 的事故同型。抛错让它在设置页可见。

### 3.6 前后端判据一致性

| 层 | 判据 | 约束 |
| --- | --- | --- |
| 后端 | `AgentConfig::is_chat_agent()` | `chat.is_some() && chat_enabled != Some(false)` |
| 后端 `list_chat_agents` | `a.enabled && a.is_chat_agent()` | 与 §3.1 表一致 |
| 前端 | `isChatEnabled(agent)` | 逐字镜像 |
| 前端 `agentCapabilities` | `chat: isChatEnabled(agent)` | 徽标与列表同源 |

护栏：`grep -rn "Boolean(.*\.chat)" src/` 无结果。

`CapabilityBadges` 的 Props 收窄必须补 `chat_enabled`：
```ts
agent: Pick<AgentConfig, 'command' | 'chat' | 'chat_enabled' | 'prompt_args'>;
```
漏了它 → `isChatEnabled` 读不到字段 → 关掉的 chat 仍显示为启用。

**[R5] `useChatAgents` 必须接入 `agentStore`**（本方案原漏项）：

```ts
// 现状：空依赖 useEffect + 独立 useState → 保存后列表不刷新，
// 用户能看到已关闭的 agent，选中后 adapter_for 才报错。
const all = useAgentStore((s) => s.agents);          // null = 未加载
const chatAgents = useMemo(() => (all ?? []).filter(isChatEnabled), [all]);
```

若确需后端权威列表，则订阅 `agentStore.version` 作为重拉触发；**不得保留空依赖 `useEffect`**。

## 4. 运行时契约

### 4.1 adapter 在 open 时快照配置 [R13]

正式确立为**设计契约**：

- `adapter_for(&AgentConfig)` 接收的是 clone 出的数据对象（`resolve_agent_config` 已在锁内 clone）；
- adapter 实例**持有**该快照，运行期不再读 `AgentConfig`；
- 用户改配置（含 `chat_enabled`）**不影响已建立会话**，只影响新会话。

因此「`chat_enabled` 在会话运行中被关」的行为是：当前会话继续，下次 open 失败。
这条要写进 spec，防止将来加「热重载」时在无锁状态下改 `AgentConfig`。

### 4.2 敏感值：`!VAR` 引用语法 [R13]

`ChatLaunch::env` 是本任务新引入的**第一个真正承载凭证**的字段（`ANTHROPIC_API_KEY` 等）。
`~/.neeko/config.json` 明文、`Cargo.toml` 无任何加密依赖（已核实）。

本任务采纳最小方案（不引 keyring，YAGNI）：

```
CHAT Env 里写 KEY=!ANTHROPIC_API_KEY
```

- `!` 前缀 = 「从父进程继承同名变量」，**不落盘**为值（配置里只存引用）；
- spawn 时 `chat_env()` 解析 `!` 引用，找不到则报错（不静默传空串）；
- `ChatLaunch.env` 序列化时 `!` 引用原样保存 —— 配置文件里看不到明文密钥。

完整方案（系统 Keychain）单开任务，PRD「已知限制」记录。

## 5. 风险

| 风险 | 缓解 |
| --- | --- |
| 注册表顺序改动 → 优先级静默变化 | §2.7：生成物护栏 + 独立行为断言 |
| 加枚举变体忘加表项 | §2.2.1 防线 1/2（穷举测试 + `ALL`） |
| **`wire_format` 迁移遗漏 → 老用户 `opencode acp` 静默失效** | §2.5 反序列化期迁移 + 变异验证 |
| **`chat_enabled` 三态被压成两态** | §3.4 `ChatEnabledChoice` + Reset 链接 |
| **`useChatAgents` 不刷新** | §3.6 从 `agentStore` 派生 |
| 表单清空/改写出厂 `chat` | §3.5 + 往返测试（含 `program: None` 保持）|
| 内置无 chat 被写入 chat → 静默丢弃 | §3.5 抛错 |
| **`env` 明文存凭证** | §4.2 `!VAR` 引用；完整方案另开任务 |
| `generated/protocols.json` 本地生成、CI 不同步 | CI 断言 `git diff --exit-code src/generated/` |
| 6 个 `adapter_for` 调用点 | 签名不变，调用点零改动；锁外调用已核实 |

## 6. 分步计划

| Step | 内容 | 用户可见 |
| --- | --- | --- |
| 1 | 注册表基础设施 + 穷举防线（旧路径不动） | 否 |
| 2 | `adapter_for` 切到注册表 | 否 |
| 3 | `wire_format` 成配置项 + **反序列化迁移** | 否（修 bug + 保兼容） |
| 4 | 前端单表化 + 生成物护栏 | 否 |
| 5 | 后端协议锁定（`chat_enabled` / `restore_overrides` / `list_chat_agents`） | 否 |
| 6 | 前端判据收口（`isChatEnabled` / 徽标灰态 / **`useChatAgents`**） | 部分 |
| 7 | 表单分叉（三态渲染 / 三态 `chat_enabled` / 出厂协议保护 / 抛错） | **是** |
| 8 | `!VAR` 引用 + 收尾 + spec | 部分 |

## 7. As-built 修订（2026-10-24 neeko-check 修复）

> 评审定位 1 个 Block（`wire_format` 迁移空洞）+ 3 Warning + 3 Nit，全部修复。本节是
> 修复后的**最终裁决**，与上文冲突处以本节为准。

### 7.1 [R9/§2.6.1] 跨栈护栏维持「读源码」，**否决生成方案**

§2.6.1 原方案（Rust 测试导出 `src/generated/protocols.json` + CI `git diff --exit-code`）
未实施，最终交付 `transports.test.ts` 正则读后端源码。否决生成方案的理由：

1. **`cargo test` 写文件违反本项目测试独立性硬约束**（测试不得依赖顺序与外部状态）；
2. 需要额外的 CI diff 门与 `src/generated/` 目录契约 —— 两套机制防一种漂移，KISS 不允许；
3. 读源码方案的格式耦合是**响亮失败**而非静默漏检：表语法一变正则脱锚 → 抓到空序列 →
   `backend.length >= 4` 立即红。判据本身已做变异验证。

§2.6.1 的「生成物进 git」与风险表里对应行作废。

### 7.2 [R3/验收#6] `wire_format` 迁移的最终形态：三层，各自处理自己能看到的歧义

PRD 验收 #6（旧配置 `{"program":"opencode","args":["acp"]}` 加载后得到 NDJSON）**已满足**，
但不靠反序列化层 —— §1.6 的裁决（`from_current_object` 不做推断，保往返不变量）不变。
「旧版本写的当前形态」与「新版本写的缺省值」**按内容不可区分**，区分靠时机：

| 层 | 位置 | 处理什么 |
| --- | --- | --- |
| 反序列化期 | `from_legacy_str` / `from_legacy_object` | 旧格式独有键（裸串 / `transport`） |
| **装载期（新增）** | `AgentConfig::migrate_legacy_chat_wire_format`，由 `agent/boot.rs` 在装 `customAgents` 时调用并写回配置 JSON（复用 `outcome.migrated` → 调用方落盘链路） | 当前形态快照 + **command 回落**（旧运行时推断看 `chat_cmd_vec()[0]`，program 缺省时是 command —— 只有持有完整 `AgentConfig` 的装载层能看到） |
| 运行期 | 无（已删除，不恢复） | — |

推断实现只有一份（`infer_legacy_wire_format`，`pub(crate)`）。显式值（含
`ContentLength`）永远短路。迁移在**下次保存落盘**，不启动期写盘。

### 7.3 前端新增：Wire Format 选择器（推断的正式替代品）

`ChatLaunchEditor` 对识别为 ACP 的自定义 agent 暴露 `Wire Format` 选择
（Content-Length / NDJSON）。显式 `'content-length'` 也落盘 —— 这是 opencode 命名的
二进制说 ContentLength 协议时**唯一的表达方式**（否则每次装载都会被迁移重新推断成
NDJSON）。非 ACP 传输 / 进程内不渲染该控件；提交时由 `buildChatLaunch` 门控携带。

### 7.4 [R6] `list_chat_agents` 命令删除

`useChatAgents` 改从 `agentStore` 派生后，该命令成为死代码，且它与前端 `isChatEnabled`
构成「谁算 chat agent」的第二判据源。已删：后端命令 + `neeko_invoke_handler!` 注册 +
前端 `agentApi.listChatAgents` wrapper。chat 列表唯一派生式：
`agentStore.agents.filter(isChatEnabled)`。

### 7.5 其余修复

- `AgentForm` 稳定回调收口 `chatSetters`（`BuiltinChatSection` / `ChatLaunchEditor`
  的 memo 不再被内联箭头打穿），护栏 `ArgListEditor.test` 扩展覆盖两个 memo 子组件；
- `BuiltinChatSection` 的 Reset 按钮移出 `<label>`（label 内容模型不允许嵌套
  labelable 元素，且会污染 checkbox 可访问名）；
- 内置无出厂 chat 的 agent 提交 `chat_enabled: null`（不写改不动也看不见的偏好噪音）；
- `TRANSPORT_LABELS` 双副本去重（`agentFormChat.ts` 改 re-export `shared/types/agent.ts`），
  `chatTransportLabel` 删除（派生自 `transportOf` + 共享表，`AgentForm` 单一 `transport` memo）。
