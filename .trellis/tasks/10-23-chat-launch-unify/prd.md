# PRD · Chat 启动配置收敛为 ChatLaunch

## 已确认的决定

| # | 决定 | 理由 |
| --- | --- | --- |
| D1 | 未知传输字符串 **报错**，不再静默兜底成 `Acp` | 当前 `"acpp"` 会被悄悄当 ACP spawn，得到“能开但完全不对”的会话；报错至少能在设置页看见 |
| D2 | `prompt_args` 的逗号分隔 **改为空格** | 启动命令本身就是空格分隔，UI 上不再有第二种规则 |
| D3 | `SpawnSpec::kill_tree` **默认 `false`** | 显式优于隐式：迫使调用方思考进程组语义，不用随 facade 默认值的变化而漂 |
| D4 | `AgentConfig::env` **保留**（A2），`ChatLaunch::env` 仅 chat 生效 | 全局 env 现在无消费点但不代表以后不用 |
| D5 | exec 的 `spawn` / `spawn_with` / `spawn_with_env` **合并为一个** facade + `SpawnSpec` 可选参数 bundle | 三个组合器已全部存在，合并零新增底层 API |

## 背景

`AgentConfig` 里「怎么启动 chat 进程」这件事被切成了 **4 处**：

| 位置 | 类型 | 语义 |
| --- | --- | --- |
| `chat: Option<ChatStart>` | 枚举 5 变体 | 传输协议 |
| `ChatStart::Acp { args }` | 变体内嵌 | ACP 子命令参数 |
| `chat_command: Option<String>` | 独立字段 | chat 专用可执行文件覆盖 |
| `chat_args: Option<Vec<String>>` | 独立字段 | chat 附加参数 |

四处的合并规则还各自不同（`chat_cmd_vec()` 里"有 `chat_command` 就不继承 `args`"），且四种传输**各用各的来源**：

- `Acp` → `chat_cmd_vec()` **再追加** `Acp.args`
- `Serve` → **硬编码字符串 `"opencode"`**（`opencode/connection.rs`），配置里的 `command` 被忽略
- `PiRpc` → `chat_cmd_vec()` **再追加** `--mode rpc`
- `Jsonl` → `chat_cmd_vec()`

### 用户可感知的问题

1. **设置页出现一个无意义的传输下拉**。`serve` / `jsonl` / `pi-rpc` / `mock` 不是用户的选择，是那个 agent 恰好这么说话；选错只能得到一个跑不起来的配置，且表单不给任何提示。
2. **内置 agent 里 0 个使用 `Acp`**，而 `Acp` 恰恰是唯一通用协议 —— 选项集和真实使用情况完全相反。
3. **想用一个支持 ACP 的 agent 走 ACP 时必须绕路**：`chat_command` 的设计初衷就是"`pi-acp` 是把 pi 包成 ACP 的独立入口"，但 UI 上既要选传输下拉、又要填 `chat_command`、还可能要在 `Acp.args` 里重复写一遍参数。
4. **参数分隔符不统一**：`prompt_args` 用逗号分隔，其余用空格分隔。

## 目标

**一个字段同时表达「用什么跑」和「怎么启动它」。** 传输成为从启动命令**识别**出来的派生物，不再是用户声明的选项。

```rust
pub struct ChatLaunch {
    /// 可执行文件；None = 沿用 `AgentConfig::command`（TUI 与 chat 同一二进制）
    pub program: Option<String>,
    /// 完整参数（含 `acp` / `serve --port 0` / `--mode rpc` 等子命令）
    pub args: Vec<String>,
    /// 仅注入给 **chat 进程**的环境变量（追加/覆盖，不替换继承）
    pub env: std::collections::BTreeMap<String, String>,
}
```

```rust
pub struct AgentConfig {
    // …
    pub env: HashMap<String, String>,   // 保留：agent 全局环境变量（TUI + chat 都生效）
    pub chat: Option<ChatLaunch>,       // 替换 ChatStart + chat_command + chat_args
}
```

### 环境变量的两层语义（A2 决定）

| 字段 | 作用域 | 现状 |
| --- | --- | --- |
| `AgentConfig::env` | **agent 全局**：TUI 与 chat 都继承 | 当前是死字段（内置定义填空 map、无 spawn 读取、前端无 UI），但保留为将来能力 |
| `ChatLaunch::env` | **仅 chat 进程**：在全局之上追加/覆盖 | 本次新增 |

合并公式（唯一落点，见 §2.3）：

```
生效环境 = 父进程继承 ∪ AgentConfig.env ∪ ChatLaunch.env
```

右侧靠后的覆盖靠前的。三者都**不会**替换整个环境——`SpawnOptions.env` 实现是 `cmd.env(k, v)`，天然追加（`executor/env_defaults.rs` 的 `with_default_env` 更是把调用方 env 放首位、默认值只补缺）。

## 需求

### R1 · 类型收敛

- `ChatStart` 枚举（5 变体）删除，替换为 `ChatLaunch` 结构体。
- `AgentConfig::chat_command` / `AgentConfig::chat_args` 字段删除，其值并入 `ChatLaunch`。
- `AgentConfig::env` **保留不动**（agent 全局环境变量，A2）。本次不删、不改语义、不接 TUI spawn。
- `ChatLaunch` 新增 `env: BTreeMap<String,String>`，**仅 chat 进程生效**。
- `AgentConfig::chat_cmd_vec()` 保留，语义改为「`ChatLaunch` 展开成命令行」，仍是 chat 进程命令的**唯一**来源。
- 新增 `AgentConfig::chat_env() -> BTreeMap<String,String>`：`AgentConfig.env` ∪ `ChatLaunch.env`，是 chat 进程除 `OPENCODE_SERVER_PASSWORD` 之外环境的**唯一**来源。

### R2 · 传输识别

`ChatLaunch::transport() -> ChatTransport` 从 `program` + `args` 的 token 流中识别：

| 识别到 | 传输 |
| --- | --- |
| token `acp` | `Acp` |
| token `serve` | `Serve` |
| token `--mode` 且后随 `rpc`，或 token `rpc` | `PiRpc` |
| token `--jsonl` / `stream-json` | `Jsonl` |
| 以上都没有 | `Acp`（默认） |

识别必须只看**完整 token**，不得做子串匹配（否则 `--approval-mode` 会被误判成 `acp`）。

### R3 · 四种传输统一取命令

`adapter_for` 按 `transport()` 分派，但**所有传输都用同一份 `ChatLaunch` 展开结果**：

- `Serve` 不再硬编码 `"opencode"`；内置定义改为 `ChatLaunch { program: Some("opencode"), args: ["serve"] }`。
  serve 特有的 `--port 0` / `--hostname 127.0.0.1` 由 adapter 在展开后追加（保持现状：不要求用户在配置里写端口）。
- `PiRpc` 的 `--mode rpc` 移入内置定义 args（当前由 adapter 追加）。保留 adapter 的"后写者胜"逻辑作为兜底。

### R4 · 旧配置迁移

`~/.neeko/config.json` 的 `agentOverrides` + `customAgents` 里已有旧形态，必须无损映射：

| 旧形态 | 映射为 |
| --- | --- |
| `"chat": "acp"` | `{ program: null, args: [] }` |
| `"chat": "serve"` | `{ program: Some("opencode"), args: ["serve"] }` |
| `"chat": "jsonl"` | `{ program: null, args: ["--jsonl"] }` |
| `"chat": "pi-rpc"` | `{ program: null, args: ["--mode","rpc"] }` |
| `"chat": "mock"` | `{ program: null, args: [] }` + 保留 Mock 识别（见 R5） |
| `"chat": {"transport":"acp","args":["..."]}` | `{ program: null, args: ["..."] }` |
| 未知字符串（现状静默 → Acp） | **改为报错**，不再吞掉拼写错误 |

`chat_command` / `chat_args` 在该 agent 的 `chat` 为旧形态时合并进 `ChatLaunch`：

```
program = chat_command（去空白后非空）
args    = transport 映射出的 args ⊕ chat_args
```

迁移只发生在**反序列化**阶段，不做一次性重写文件（用户回退版本时旧格式仍可读）。

### R5 · `Mock` 的归位

`Mock` 不是传输，是测试桩。当前既占一个枚举变体、又占一个 UI 下拉项。本任务：

- 从 `ChatTransport` 中移除 `Mock`（UI 层彻底消失）。
- 测试改用 `AgentConfig::mock_chat_agent()` 之类的构造函数在 adapter 层直接产出 `AcpAdapter::mock()`，不经过 `ChatLaunch::transport()`。

### R6 · UI

**内置 agent 和自定义 agent 用同一套控件**（不再是"内置只读 / 自定义可编辑"）：

- 「CHAT」区一个 **argv 列表编辑器**（每个参数一行一个输入框）：
  ```
  CHAT Launch (first = program · empty = no CHAT)
  [ opencode            ] ×
  [ acp                 ] ×
  + Add
  Detected: ACP · JSON-RPC stdio
  ```
- 空列表 = 该 agent 无 CHAT 能力；「In-process」复选框独立表达"无 argv 但有 CHAT 能力"。
- 删除 `CHAT_OPTIONS` 下拉、`CHAT_HINTS` 条件提示、`ACP Args` 条件输入框、`ChatLaunchFields` 的双输入框。
- 内置 agent 的启动命令**可编辑**（用户装什么二进制、要不要走 ACP 包装器只有他 Know），保存为 override。

> **为什么是列表而不是一行文本（原 R6 的方案已被推翻）**
>
> 「`string[]` ↔ 空格分隔一行」这条投影**不幂等**：
>
> | argv | 投影成文本 | 再解析回来 |
> | --- | --- | --- |
> | `['--sys', 'hello world']` | `"--sys hello world"` | `['--sys','hello','world']` |
> | `['a', '', 'b']` | `"a  b"` | `['a','b']` |
>
> 于是「打开设置页 → 保存」会**静默改写用户配置**：用户只改了一个字段，含空格的参数被拆散了。
>
> 换更聪明的分词器只能减小损失，不能消除 —— 因为"一行文本"这个载体本身不承载参数边界。
> 实测两个候选库都不合用：`shell-quote` 会做 shell 展开（`$HOME/x` → `/x`、`&&` → 运算符节点），
> 语义与"argv 直传进程"不符；`string-argv` 语义正确但没有 formatter，且引号内不反转义，
> 同时含两种引号的值无法表达。
>
> 让表单态**直接就是数组**，投影就不存在了。边界由**控件结构**表达，不需要解析、引号规则或转义。

### R7 · 参数形态统一（取代原「分隔符统一」）

所有 argv 类字段（CLI `args`、CHAT 启动命令、`prompt_args` / `post_prompt_args` / `model_list_args`）
统一为**数组承载、每个参数一个输入框**，不存在"分隔符"这个概念。

- 五个字段共用同一控件 `ArgListEditor`（DRY：5 个消费点）。
- 提交边界裁掉**尾部**未填槽位（点「+ Add」后直接保存不产生空参数）；**中间**的空串保留 ——
  它是用户明确要的空参数（`git commit -m ""`）。
- 环境变量仍用多行 `KEY=value` 文本：那条投影是幂等的（除设计上就要 trim 的首尾空白），
  且承载的是"多行"这个天然布局，不是会丢边界的序列。

### R8 · 环境变量两层

- `AgentConfig::env`（全局）保留，不接消费点（YAGNI：当前无 TUI spawn 需求）。
- `ChatLaunch::env`（仅 chat）新增。
- chat 进程生效环境 = 父进程继承 ∪ `AgentConfig.env` ∪ `ChatLaunch.env`，靠后覆盖靠前。
- 内部必需变量（`OPENCODE_SERVER_PASSWORD`）**最后写入，不可被用户覆盖**。
- UI：CHAT 区新增多行 `textarea`，每行一个 `KEY=value`。解析规则：忽略空行与 `#` 注释；**只按第一个 `=` 切分**（值里的 `=` 必须保留）；key 去空白后不可为空。

## 非目标

- 不改 `Detect`/`Deploy`/`Detection`。
- 不改 `prompt_args` / `interactive_prompt_args` / `post_prompt_args` 的**语义**（只统一分隔符）。
- 不改 MCP / skills / notification 相关逻辑。
- **不把 `AgentConfig::env` 接到 TUI spawn**（保留字段、保留将来能力，本次不扩作用域）。

## 验收标准

1. `grep -rn "ChatStart" src-tauri/src/` 无结果（除迁移测试里刻意保留的旧字符串字面量）。
2. `grep -rn "chat_command\|chat_args" src-tauri/src/` 无结果（除迁移代码）。
3. `src/features/agent/components/agentFormChat.ts` 中不再存在 `serve` / `jsonl` / `pi-rpc` / `mock` 选项。
4. 旧 `config.json` 的 6 种形态（R4 表格）逐一有测试断言：加载后 `transport()` 与展开出的命令行符合预期。
5. 迁移测试含「未知字符串 `"acpp"` → 报错」，且变异验证（把报错改回默认值后测试变红）。
6. 内置 8 个 agent（opencode / pi / gemini / codex / qoder / codebuddy / omp / reasonix / grok / mockAgent）的 `transport()` 结果与迁移前**逐一相等**。
7. `pnpm check:quick` 全绿；`cargo test` 全绿；`cargo clippy --all-targets -- -D warnings` 无告警。
8. UI：设置页 CHAT 区只有一个文本输入框 + 一行识别结果 + 一个 env textarea，无下拉。
9. env 合并：全局 `AgentConfig.env` 与 `ChatLaunch.env` 同名键时后者胜；两者都生效时用户环境变量不会被内部注入项覆盖以外的行为干扰。
10. env 解析：`URL=http://x?a=b` 解析后值为 `http://x?a=b`（断言值里的 `=` 保留）；`# comment` 被忽略。
