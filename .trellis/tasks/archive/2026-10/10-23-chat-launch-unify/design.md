# Design · ChatLaunch 收敛

## 0. 已定决策（用户确认）

| # | 决定 | 落点 |
| --- | --- | --- |
| D1 | 未知传输字符串 **报错** | §2.8 `Deserialize` |
| D2 | `prompt_args` 逗号 → 空格 | Step 3 |
| D3 | `SpawnSpec::kill_tree` 默认 `false` | §2.5 |
| D4 | `AgentConfig::env` 保留；`ChatLaunch::env` 仅 chat | §2.4 |
| D5 | exec 三个 spawn facade 合并为 `SpawnSpec` | §2.5 |

## 1. 第一性原理

启动一个 chat 进程，系统真正需要的全部信息是：

```
(argv[0], argv[1..])   —— 可执行文件 + 参数
```

当前模型把这条信息切成了四份（`chat` 枚举 / `ChatStart::Acp.args` / `chat_command` / `chat_args`），再让每条传输各自拼装。**任何"N 个来源合并成一个命令行"的设计都必然产生 N-1 个语义歧义**，本次已经产生了三个：

1. `chat_command` 一旦设置就吞掉 `args` —— 为什么？因为 `args` 描述的是另一个进程。
2. `Acp.args` 与 `chat_args` 都在 `argv` 尾部，谁先谁后无原则可依，只能靠注释说明。
3. `Serve` 干脆不读配置，硬编码 `"opencode"` —— 因为它是第一个落地的传输，那时还没有"统一取命令"的概念。

所以收敛方向是明确的：**让类型直接等于它要描述的东西**。

```rust
pub struct ChatLaunch {
    pub program: Option<String>,   // argv[0]；None = 用 AgentConfig::command
    pub args: Vec<String>,         // argv[1..]
    pub env: BTreeMap<String, String>,  // 仅 chat 进程的环境变量
}
```

启动一个 chat 进程，系统真正需要的完整信息就是 **`(argv[0], argv[1..], env)`** 三元组。一旦类型长这样，"传输"就只能是被**推导**出来的，不再有地方可以存它。

## 2. 核心契约

### 2.1 `ChatLaunch`

```rust
// src-tauri/src/common/agent/types.rs
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatLaunch {
    /// argv[0]。`None` = 沿用 `AgentConfig::command`（TUI 与 chat 同一二进制）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    /// argv[1..]。空 = 无附加参数。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// 仅注入给 chat 进程的环境变量。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: std::collections::BTreeMap<String, String>,
}
```

**`env` 用 `BTreeMap` 而不是 `HashMap`**：它会序列化到 `config.json`。`HashMap` 迭代顺序随机，每次保存都产生无意义的 diff，测试断言也会不稳定。`BTreeMap` 保证键序稳定。

**`env` 放 `ChatLaunch` 而不是 `AgentConfig`（与 A2 不矛盾）**：两层职责不同——`AgentConfig::env` 是 agent 全局，`ChatLaunch::env` 是 chat 专属。放后者是因为只有在 chat 启动时它才有消费点，且用户改它时心里想的就是"这个 chat 会话要这个 key"。

**`program: Option<String>` 而不是 `String`** 的理由：`None` 有两层意思且都对——「跟 TUI 同一个二进制」和「用户没填」。用空字符串表示会与"用户确实填了个空"混淆，而 `Option` 让"沿用"成为类型上的默认。

**`args: Vec<String>` 而不是 `Option<Vec<String>>`**：空 Vec 与 None 在此无行为差异，`skip_serializing_if = "Vec::is_empty"` 已达到"无参数不写字段"的效果，不需要再套一层 Option。

### 2.2 传输识别

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatTransport { Acp, Serve, Jsonl, PiRpc }

impl ChatLaunch {
    /// 从 `program` + `args` 的**完整 token** 流识别传输。
    ///
    /// 只认完整 token，禁止子串匹配 —— `--approval-mode` 含 "acp"，
    /// `--preserve` 含 "serve"，子串匹配会把它们全判错。
    pub fn transport(&self) -> ChatTransport {
        let program = self.program.as_deref().unwrap_or_default();
        let tokens: Vec<&str> = std::iter::once(program)
            .chain(self.args.iter().map(String::as_str))
            .collect();

        if tokens.iter().any(|t| *t == "acp") {
            return ChatTransport::Acp;
        }
        if tokens.iter().any(|t| *t == "serve") {
            return ChatTransport::Serve;
        }
        if tokens.iter().any(|t| *t == "--jsonl" || *t == "stream-json") {
            return ChatTransport::Jsonl;
        }
        // pi: `--mode rpc`（两个相邻 token）或裸 `rpc`
        if tokens.windows(2).any(|w| w == ["--mode", "rpc"]) || tokens.iter().any(|t| *t == "rpc") {
            return ChatTransport::PiRpc;
        }
        ChatTransport::Acp
    }
}
```

**顺序即优先级**：`acp` 先判，因为 `opencode serve` 与 `opencode acp` 是互斥子命令，写了 `acp` 就是 ACP。这条顺序必须用测试锁住（`["serve","acp"]` 判为 Acp）。

**默认 `Acp`** 的理由：ACP 是唯一通用协议，也是"没写特殊子命令的 CLI"最可能的行为（`gemini` 本身就是 ACP）。这与迁移前 `Deserialize` 的兜底一致，不构成行为变更。

### 2.3 命令展开

```rust
impl AgentConfig {
    /// chat 进程的完整命令行 —— **唯一**来源。
    ///
    /// 优先级：
    /// 1. `chat.program` 有值 → 它 + `chat.args`
    /// 2. `chat.program` 为空 → `cmd_vec()`（`command` + `args`）+ `chat.args`
    ///
    /// 注意：与旧实现的差别 —— 旧 `chat_cmd_vec()` 在 `chat_command` 有值时
    /// **丢弃** CLI 的 `args`；现在 `program` 与 `args` 是同一个结构的两半，
    /// 能否继承由用户是否填 `program` 决定，语义更直白。
    pub fn chat_cmd_vec(&self) -> Vec<String> {
        let Some(launch) = &self.chat else {
            return self.cmd_vec();
        };
        let mut v = match launch.program.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(program) => vec![program.to_string()],
            None => self.cmd_vec(),
        };
        v.extend(launch.args.iter().filter(|a| !a.is_empty()).cloned());
        v
    }
}
```

**行为差异清单**（必须逐条测试，见 §5）：

| 场景 | 旧行为 | 新行为 |
| --- | --- | --- |
| `program` 空 + 有 args | `command + args + chat_args` | 同 |
| `program` 有值 + 有 args | `chat_command + chat_args`（丢 CLI args） | 同 |
| `program` 有值 + 无 args | `chat_command` | 同 |
| 旧 `Acp.args` | `chat_cmd_vec()` ⊕ `Acp.args` | 并入 `launch.args`，同 |

四条全等价 —— 这是纯重构，不是行为变更。

### 2.4 环境变量合并

```rust
impl AgentConfig {
    /// chat 进程生效的环境变量 —— **唯一**来源。
    ///
    /// 合并顺序（靠后覆盖靠前）：
    ///   `AgentConfig.env`（agent 全局） ∪ `ChatLaunch.env`（chat 专属）
    ///
    /// 注意：这是**追加**，不是替换 —— 父进程的环境仍完整继承。
    /// `SpawnOptions.env` 的实现是逐项 `cmd.env(k, v)`，
    /// 且 `with_default_env` 把调用方 env 放首位、默认值只补缺。
    pub fn chat_env(&self) -> std::collections::BTreeMap<String, String> {
        let mut env: std::collections::BTreeMap<String, String> =
            self.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        if let Some(launch) = &self.chat {
            env.extend(launch.env.iter().map(|(k, v)| (k.clone(), v.clone())));
        }
        env
    }
}
```

**为什么需要 `chat_env()` 而不是让各 adapter 自己拼**：四个 adapter 的 spawn 入口完全不同（`acp.rs` 用 `spawn()`、`pi_rpc/process.rs` 用 `spawn_with()`、`deepseek.rs` 用 `spawn()`、`opencode/connection.rs` 用 `spawn_with_env()`）。如果让每个 adapter 自己合并，四处规则必须手工同步，必然漂移。**合并只在一个方法里发生，adapter 只负责把结果交给 exec。**

#### 内部必需变量不可被用户覆盖

`ServeAdapter` 的 `OPENCODE_SERVER_PASSWORD` 由内部 uuid 生成，必须在用户 env **之后**写入：

```rust
// opencode/connection.rs
let mut merged = config.chat_env();
merged.insert("OPENCODE_SERVER_PASSWORD".into(), password.clone());   // 最后写 = 用户改不动
```

理由：serve 的认证密码是**内部协议细节**（见 `protocol.rs` 的 Basic auth 构造）。用户填错只会得到一个 401，而 401 的根因从 UI 上看不出来。这与旧行为一致（旧代码同样自己生成密码，只是当时没有用户 env 可冲突）。

**必须用测试锁住**：用户 env 里写 `OPENCODE_SERVER_PASSWORD=wrong` 后，实际 spawn 用的仍是内部生成值。

### 2.5 exec facade 合并（前置依赖）

环境变量要注入四个 adapter，但 `core/exec.rs` 现有三个 spawn facade 只是 `SpawnOptions` 的三种参数组合：

```rust
spawn(target, cmd, args)                  // kill_tree
spawn_with(target, cmd, args, cwd)        // kill_tree + cwd
spawn_with_env(target, cmd, args, env)    // kill_tree + env
```

而 `SpawnOptions` 本身就带 `current_dir` / `env` / `kill_tree`（`executor/types.rs`）。三个 facade 造出一个**语法窟窿**：本任务里 `pi_rpc` 需要 cwd，所有 chat adapter 都需要 env，但没有“两者同时”的入口。

**不新增第四个函数，合并成一个 + 可选参数 bundle：**

```rust
#[derive(Default, Clone, Copy)]
pub struct SpawnSpec<'a> {
    pub cwd: Option<&'a str>,
    pub env: &'a [(&'a str, &'a str)],
    pub kill_tree: bool,
}

pub async fn spawn(
    target: &ExecTarget, cmd: &str, args: &[&str], spec: SpawnSpec<'_>,
) -> Result<ExecChild, ExecError> {
    spawn_target(target,
        SpawnOptions::new(cmd, args)
            .with_current_dir_if(spec.cwd)
            .with_env(spec.env)
            .with_kill_tree_if(spec.kill_tree),
    ).await
}
```

三个组合器**已全部存在**（`with_current_dir_if` :184、`with_env` :193、`with_kill_tree_if` :208）—— 合并零新增底层 API，只是删两个 facade 函数 + 迁移 7 个调用点。

**为何用结构体而非 `spawn(t, c, a, Option<cwd>, &env, bool)`**：调用点会退化成 `spawn(t, c, a, None, &[], true)`，读不出哪个是哪个；且新增可选项时要改所有调用点。`SpawnSpec` 让调用点只写它关心的：`SpawnSpec::new().with_env(&env)`。

### 2.6 `adapter_for` 分派

```rust
pub fn adapter_for(config: &AgentConfig) -> Result<Box<dyn AgentAdapter>, AppError> {
    let Some(launch) = &config.chat else {
        return Err(AppError::Unsupported(format!(
            "agent '{}' has no CHAT capability (terminal/headless only)", config.id
        )));
    };
    match launch.transport() {
        ChatTransport::Acp    => Ok(Box::new(AcpAdapter::new(config.chat_cmd_vec()))),
        ChatTransport::Serve  => Ok(Box::new(ServeAdapter::new())),
        ChatTransport::Jsonl  => Ok(Box::new(DeepSeekHarnessAdapter::new(config.chat_cmd_vec()))),
        ChatTransport::PiRpc  => Ok(Box::new(pi_rpc::PiRpcAdapter::new(config.chat_cmd_vec()))),
    }
}
```

**`Serve` 不再硬编码 `"opencode"`**：`ServeAdapter` 改收 `cmd: Vec<String>`（第一个元素是程序名），`connection.rs` 里 `spawn_with_env("opencode", …)` 改为用它。内置定义补 `program: Some("opencode")`，行为不变。

`--port 0` / `--hostname 127.0.0.1` 仍由 adapter 追加（用户不需要关心端口），追加位置在用户 args **之后**，保持现有"后写者胜"语义。

> **约束：serve 连接是进程级单例**（`SERVE_CONNECTION: OnceCell`，见 `connection.rs`）。
> 因此 `ServeAdapter::new(cmd)` 的 `cmd` **只对首次 spawn 生效**，之后的会话复用同一个
> server。这是既有行为（一个 `opencode serve` 服务所有会话，daemon 不随会话数归零而退出），
> 本次不改。需要写进 `ServeAdapter` 的文档注释，否则下一个人会以为每个会话能配不同程序。
>
> 对应地：`ServeAdapter::new()` 无参 → `new(cmd: Vec<String>)`，`integ.rs` 的测试改为
> `ServeAdapter::new(vec!["opencode".into(), "serve".into()])`。

### 2.7 `Mock` 的归位

`Mock` 不是传输，从 `ChatTransport` 移除。三处测试辅助改为直接构造：

```rust
// 旧：ChatStart::Mock → adapter_for → AcpAdapter::mock()
// 新：测试直接 AcpAdapter::mock()
```

`mockAgent` 内置定义的 `chat` 改为 `None`，`builtin/tests.rs` 的断言改为「mockAgent 无 chat 能力」——它本来就不该通过生产代码路径暴露一个进程内桩。

### 2.8 旧格式迁移

只发生在反序列化，不重写文件（用户回退二进制时旧格式仍可读）。

```rust
impl<'de> Deserialize<'de> for ChatLaunch {
    fn deserialize<D>(d: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(d)?;

        // ① 新形态：{"program": …, "args": […]}
        if value.is_object() && value.get("program").is_some() {
            // 走 derive 的默认路径
        }

        // ② 旧形态 A：裸字符串
        if let Some(s) = value.as_str() {
            return match s {
                "acp"    => Ok(Self::default()),
                "serve"  => Ok(Self { program: Some("opencode".into()), args: vec!["serve".into()] }),
                "jsonl"  => Ok(Self { args: vec!["--jsonl".into()], ..Default::default() }),
                "pi-rpc" => Ok(Self { args: vec!["--mode".into(), "rpc".into()], ..Default::default() }),
                "mock"   => Ok(Self::default()),   // mock 已降级为 Acp + 测试桩
                other    => Err(D::Error::custom(format!(
                    "unknown chat transport '{other}'; expected acp|serve|jsonl|pi-rpc"
                ))),
            };
        }

        // ③ 旧形态 B：{"transport":"acp","args":[…]}
        let obj = value.as_object().ok_or_else(|| D::Error::custom("chat must be a string or object"))?;
        let transport = obj.get("transport").and_then(|v| v.as_str())
            .ok_or_else(|| D::Error::custom("chat object requires 'transport' or 'program'"))?;
        let mut launch = /* 对 transport 复用 ② 的映射 */;
        if let Some(args) = obj.get("args") { launch.args.extend(parse(args)?); }
        // 旧 chat_args 在同一对象里时并入
        Ok(launch)
    }
}
```

**关键改变：未知字符串从"静默兜底成 Acp"改为报错。** 这是本次唯一的有意行为变更，理由是当前兜底会把用户拼错的 `"acpp"` 悄悄当成 ACP 去 spawn，得到"能开但完全不对"的会话——报错至少能在设置页看见。

**`chat_command` / `chat_args` 的兼容**：这两个是 `AgentConfig` 的字段，不在 `chat` 里。迁移需要在 `AgentConfig` 的反序列化后处理（`#[serde(default)]` 保留两个影子字段 → `Deserialize` 收尾时合并 → 再丢弃）。实现上用自定义 `Deserialize` 或 `serde(from = "RawAgentConfig")` 均可。**推荐 `serde(from)`**：一份 `RawAgentConfig` 完整镜像旧结构，转换函数是唯一迁移入口，好测也好删。

**旧配置没有 env 形态**：`ChatLaunch.env` 是新增字段，旧 `config.json` 里不存在。`#[serde(default)]` 天然处理为空 map。反方向（新写旧读）不需要兼容 —— 旧版本会把 `chat` 对象当未知形态报错，这是可接受的（用户回退版本时配置需手改）。

`AgentConfig::env` 是旧字段，`RawAgentConfig` **必须原样透传**它，不得借此清空。

## 3. 内置定义改写

| agent | 旧 | 新 |
| --- | --- | --- |
| opencode | `Some(ChatStart::Serve)` | `Some(ChatLaunch { program: Some("opencode"), args: ["serve"] })` |
| pi | `Some(ChatStart::PiRpc)` | `Some(ChatLaunch { args: ["--mode", "rpc"] })` |
| mockAgent | `Some(ChatStart::Mock)` | `None` |
| 其余 9 个 | `None` | 不变 |

`shell_agent()` 的 `chat: Option<ChatStart>` 参数改为 `Option<ChatLaunch>`；`builtin/providers.rs` 顶部 import 随之调整。

## 4. 前端改造

### 4.1 类型

```ts
// src/shared/types/agent.ts
export interface ChatLaunch {
  /** argv[0]；省略 = 沿用 command */
  program?: string;
  /** argv[1..] */
  args?: string[];
  /** 仅 chat 进程的环境变量 */
  env?: Record<string, string>;
}

/** 传输是识别结果，不是可写字段。 */
export type ChatTransport = 'acp' | 'serve' | 'jsonl' | 'pi-rpc';

/** 与后端 `ChatLaunch::transport()` 逐 token 对齐的镜像实现。 */
export function transportOf(launch: ChatLaunch): ChatTransport { … }
```

前端 `transportOf` 与后端 `transport()` **必须同规则**，用测试锁双向一致（见 §5.4）。

### 4.2 表单

`agentFormChat.ts` 只剩四个纯函数：

```ts
/** 文本态（空格分隔的一整行）→ ChatLaunch；空串 → null。 */
export function buildChatLaunch(commandLine: string, envText: string): ChatLaunch | null {
  const tokens = splitArgs(commandLine);
  const env = parseEnvText(envText);
  if (tokens.length === 0) return null;   // 命令行为空 = 无 CHAT 能力，env 随之丢弃
  return { program: tokens[0], args: tokens.slice(1), ...(Object.keys(env).length ? { env } : {}) };
}

/** ChatLaunch → 文本态。 */
export function formatChatLaunch(launch: ChatLaunch | null | undefined): string { … }

/** 多行 `KEY=value` → 对象。忽略空行与 `#` 注释；只按**第一个** `=` 切分。 */
export function parseEnvText(text: string): Record<string, string> { … }

/** 对象 → 多行文本（键序稳定，供往返测试）。 */
export function formatEnvText(env: Record<string, string> | undefined): string { … }
```

**`parseEnvText` 的边界规则**（必须逐条测试）：

| 输入 | 结果 | 理由 |
| --- | --- | --- |
| `KEY=v` | `{KEY:"v"}` | 基础 |
| `URL=http://x?a=b` | `{URL:"http://x?a=b"}` | 只切第一个 `=` |
| `KEY=` | `{KEY:""}` | 空值合法（用于“声明但置空”） |
| `=v` | 忽略 | key 为空 |
| `  KEY  =  v  ` | `{KEY:"v"}` | key/value 去两边空白 |
| `# comment` | 忽略 | 注释 |
| `KEY=#v` | `{KEY:"#v"}` | `#` 只在行首才是注释 |
| 重复 key | 后者胜 | 与 shell 一致 |

`FormTextState` 的四个字段（`chat` / `acpArgsText` / `chatCommand` / `chatArgsText`）合并为两个：`chatCommandLine: string` + `chatEnvText: string`。

**删除**：`CHAT_OPTIONS`、`CHAT_HINTS`、`ChatLaunchFields.tsx`、`AgentForm.tsx` 里 `t.chat === 'acp' ? … : …` 条件分支。

### 4.3 UI

```
┌─ CHAT ────────────────────────────────────┐
│ Transport  [ opencode acp              ]  │
│            ✓ 识别为 ACP                    │
│            （留空 = 该 agent 无 CHAT 能力）│
│ Env        ┌─────────────────────────┐   │
│            │ ANTHROPIC_API_KEY=sk-…  │   │
│            │ DEBUG=1                 │   │
│            └─────────────────────────┘   │
│            仅 chat 生效 · 每行一个 KEY=value │
└───────────────────────────────────────────┘
```

命令用单个 `<input>`，env 用 `<textarea>`。只有两个控件 + 一行识别结果。内置 agent 与自定义 agent 用**同一控件**（都可编辑，内置存 override）。

**env 区为何用 textarea 而不是键值对行组件**：环境变量最常见的表达形式就是多行文本（`.env` / `docker --env-file` / CI 变量），一行一个也是最省认知的；同时它让 `FormTextState` 只多一个字符串字段，不需要引入数组状态。

## 5. 测试策略

### 5.1 迁移矩阵（Rust，`common/agent` 单测）

`it.each` 覆盖 PRD R4 表格全部 6 种旧形态 + `chat_command`/`chat_args` 合并 + 未知字符串报错。每条断言 **`transport()` 结果** 与 **`chat_cmd_vec()` 展开结果**两者。

### 5.2 传输识别边界

- `["serve","acp"]` → `Acp`（优先级）
- `["--approval-mode","auto"]` → `Acp`（默认，**不能**因为含 acp 子串误判——但这里结果恰好相同，改成 `["--preserve"]` → 应判 `Acp` 而非 `Serve`，才是有效断言）
- `[]` → `Acp`
- `["--mode","json"]` → `Acp`（不是 rpc）
- `["--mode","rpc","--mode","json"]` → `PiRpc`（adapter 后写者胜，识别看第一个）

### 5.3 内置 agent 逐一不回归

```rust
#[test]
fn builtin_agents_keep_their_transports_after_migration() {
    // opencode → Serve, pi → PiRpc, 其余无 chat
}
```

### 5.4 前后端识别一致（跨栈护栏）

前端测试读 Rust 源码，断言 `ChatLaunch::transport()` 里的 token 字面量集合与前端 `transportOf` 一致 —— 沿用现有 `chatTransportOptions.test.ts` 的 `readFileSync` 手法。

### 5.5 变异验证清单

| 变异 | 应红 |
| --- | --- |
| 未知字符串改回兜底 `Acp` | 迁移报错测试 |
| `transport()` 改成子串匹配 | `["--preserve"]` 用例 |
| `acp` 判断移到 `serve` 之后 | 优先级用例 |
| `chat_cmd_vec()` 丢掉 `launch.args` | 展开矩阵 |
| 前端 `transportOf` 少一个 token | §5.4 护栏 |
| `ServeAdapter` 改回硬编码 `"opencode"` | 内置迁移测试 |
| `chat_env()` 改成用户 env 覆盖内部密码 | §5.6 内部变量不可覆盖 |
| `chat_env()` 只返回 `launch.env`（丢全局） | env 合并矩阵 |
| `chat_env()` 用替换而非追加 | 继承断言（`PATH` 仍存在） |
| `parseEnvText` 按所有 `=` 切分 | `URL=http://x?a=b` 用例 |
| `parseEnvText` 把 `KEY=#v` 当注释 | 同行注释边界用例 |
| `spawn` 的 `with_kill_tree_if` 改无条件 | 2b.5 kill_tree 默认值用例 |
| `spawn` 丢掉 `with_current_dir_if` | 2b.4 的 `pwd` 断言 |

### 5.6 环境变量测试

**合并矩阵**（Rust，`common/agent` 单测）：

| `AgentConfig.env` | `ChatLaunch.env` | `chat_env()` 结果 |
| --- | --- | --- |
| 空 | 空 | 空 |
| `{A:1}` | 空 | `{A:1}` |
| 空 | `{B:2}` | `{B:2}` |
| `{A:1}` | `{B:2}` | `{A:1, B:2}` |
| `{K:old}` | `{K:new}` | `{K:new}`（后者胜） |

**内部变量不可覆盖**：`chat_env()` 里写 `OPENCODE_SERVER_PASSWORD=wrong`，断言 `start_serve` 插入后的实际值为内部生成值。这个测试在 `opencode/connection.rs`，需把“合并 + 插入密码”抽成纯函数（如 `merged_env_for(config, password)`）才能直测，不起真进程。

**不替换继承**：断言传给 `SpawnOptions` 的 env 不含 `PATH` 清空类操作 —— 实际靠“不调用 `cmd.env_clear()`”保证，用一个源码护栏断言 `spawn_with_env` 路径无 `env_clear`。

## 6. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 用户的 `agentOverrides` 是旧格式，迁错则 chat 静默失效 | 迁移矩阵测试 + 只读反序列化不重写文件 |
| `chat` 从裸字符串变对象，前端读旧值崩 | 前端 `chatTransportOf` 等旧辅助函数保留一个版本，读旧形态时归一 |
| `ServeAdapter` 不再硬编码程序名，自定义 agent 配错就起不来 | 内置定义显式写 `Some("opencode")`；错误信息带上展开后的命令行 |
| PRD R5 删 `Mock` 影响测试夹具 | 测试直接用 `AcpAdapter::mock()`，不走 `adapter_for` |

**回滚点**：每个 commit 独立可回滚。Step 1（类型 + 迁移）落地后，Step 2（adapter）与 Step 3（UI）可分别回滚而不破坏旧配置可读性。

## 7. 分步计划（详见 implement.md）

1. **Step 1 · 类型与迁移**（纯重构 + 单向兼容）：`ChatLaunch`（含 `env`）+ `ChatTransport` + 自定义 `Deserialize` + `AgentConfig` 移除两字段 + `chat_env()` + 迁移矩阵测试。此步结束时 `cargo test` 全绿，行为零变更。
2. **Step 2 · adapter 分派与 env 注入**：`adapter_for` 按 `transport()`；`ServeAdapter` 收 cmd 与 env；四个 adapter 统一走 `chat_env()`；内置定义改写；删 `Mock` 通道。
3. **Step 3 · 前端**：类型 + 命令输入框 + env textarea + 删下拉/条件分支 + 跨栈护栏测试。
4. **Step 4 · 收尾**：`pnpm check:quick` + `cargo clippy` + spec 文档更新（`agent-chat-transports.md`）。
