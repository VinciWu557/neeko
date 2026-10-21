# 统一 ACP 模型发现与选择 — 执行计划

> 设计依据：`design.md`。协议证据：`research/acp-model-selection.md`。
> 原则：**每阶段独立可编译、可测试、可回滚**。不出现「跨阶段才能编译通过」的中间态。

## 阶段 0：前置检查

- [x] 读 `src-tauri/AGENTS.md`（后端红线）与 `src/AGENTS.md`（前端红线）
- [x] 确认 `cargo test` 基线全绿：`pnpm test:rust`
- [x] 确认前端基线全绿：`pnpm test:fe`
- [x] 记录基线数字（用于阶段末对比）：Rust 1905 / 前端 5457

## 阶段 1：`ChatStart` 可配置化

> 没有这一步，非内置 agent 无法进入 ACP，后续所有工作只对手写死的 opencode 有意义。

### 1.1 序列化演进（`src-tauri/src/common/agent/types.rs`）

- [x] `ChatStart` 的自定义 `Deserialize` 增加对象形态分支：
  - `"acp"`（字符串，旧）→ `Acp { args: vec![] }`
  - `{"transport":"acp","args":[...]}`（对象，新）→ `Acp { args }`
  - 其余未知字符串 → 保持现状（`Acp { args: vec![] }`）
- [x] `Serialize`：`args` 为空 → 写字符串（保持旧格式，diff 最小）；非空 → 写对象
- [x] 测试：4 条往返
  - 旧格式读字符串 → args 空
  - 新格式读对象 → args 保留
  - 空 args 序列化为字符串（不是对象）
  - 非空 args 序列化为对象，再读回等价

**验证**：`cargo test --lib common::agent`

### 1.2 前端类型同步

- [x] `src/shared/types/agent.ts`：`ChatStart` 扩展为联合（字符串 | `{transport,args}`）
- [x] `AgentForm.tsx`：transport 为 acp 时显示「ACP 启动参数」输入（逗号分隔或逐条）
- [x] 测试：表单能读出现有 args、能写回

**验证**：`pnpm type-check` + `pnpm test:fe`

**回滚点 1**：到此为止不触碰任何模型逻辑，风险为零。

## 阶段 2：读取 ACP `configOptions`

### 2.1 新增解析模块

- [x] 新建 `src-tauri/src/agent/chat/adapter/acp_config.rs`（与 `acp.rs` 同级，不拆 `acp.rs`）
  - `SessionConfigOption` 结构（`serde`，字段对齐 schema：`id` / `name` / `description?` / `category?` / `type` / `currentValue` / `options`）
  - `find_by_category(options, category) -> Option<&SessionConfigOption>`
  - `models_from_config(options) -> Option<Vec<ModelInfo>>`
  - `current_model_from_config(options) -> Option<String>`
  - `model_configs_from(options) -> Vec<SessionConfigOption>`  ← category 为 `model_config` 的全部项
  - `thought_level_from(options) -> Option<&SessionConfigOption>`
- [x] 定位逻辑三级（设计 §3.2）：
  1. `category == "model"`
  2. `id == "model"`
  3. `None`（不支持）
- [x] 遍历时**保留全部选项**，不只挑 model：后续 `model_config` / `thought_level` 都要用
- [x] 测试：每组各 1 条 + 分组选项（`SessionConfigSelectGroup`）展平 1 条 + 空/缺失 1 条

### 2.2 在握手处保留 configOptions

- [x] `acp.rs` 的 `session/new` 响应处理：解析 `configOptions`，**失败不中断**（`.unwrap_or_default()`）
- [x] 把结果挂到会话状态（新增字段，最小侵入）
- [x] 日志：解析到的选项数量与类别
- [x] **补 `initialize` 的 `session.configOptions.boolean` 能力声明**（研究 §11）：
      不发它，agent MUST NOT 下发 `type: "boolean"` 的 config option，
      `model_config` 里的开关类参数会整批消失

**验证**：`cargo test --lib agent::chat::adapter`

**注意**：此阶段**不改变** `list_agent_models`，老路径仍走 opencode 私有命令。功能不回归。

## 阶段 3：`ModelInfo` 回归协议形状（必须与阶段 2 同批发布）

> 目标：砍到 `{ id, name, description? }`。这是**破坏性**改动，不能停在中间态。
>
> **为什么砍**：那 6 个字段出自 opencode 私有 NDJSON，是我们把它们当成了通用契约。
> **砍掉不等于丢能力**：`context_window` / 推理档位改由 `model_config` config option 承载（阶段 6）。

### 3.1 后端

- [x] `src-tauri/src/common/agent/types.rs`：`ModelInfo` 删 6 个字段
- [x] `model_discovery.rs`：`models_from_exec_output` 适配（opencode NDJSON 里的富字段丢弃，或保留在解析中间结构里不进 `ModelInfo`）
- [x] `serve.rs`：`model_slug_split` 保留（它用于请求体构造，与 `ModelInfo` 无关）

### 3.2 前端

- [x] `agentApi.ts` 的 `ModelInfo` 同步
- [x] `ModelPicker.tsx` 五处消费点按设计 §2.3 表逐条改：
  - 搜索只匹配 `name` / `id`
  - 删除 provider 列、context_window、is_free
  - 删除当前模型的后缀
- [x] `historyRestore.ts:19`：provider 匹配改为 `id` 全等
- [x] `useAgentChat.ts:160`：`default_reasoning_effort` 判断改为 `models[0]`（无该字段后）

### 3.3 测试

- [x] `ModelPicker` 现有测试更新（删除对已删字段的断言）
- [x] `historyRestore` 匹配测试
- [x] 后端 `models_from_exec_output` 测试更新

**验证**：`pnpm check:quick` + `cargo test --lib`

**回滚点 2**：阶段 1+2+3 完成后，模型列表来自 ACP 但**选择尚未生效**。功能等价于「能看不能选」。

## 阶段 4：写入 `set_config_option`

> AC5 的核心。这一阶段之前，模型选择是「显示了但不起作用」—— 比不显示更糟。

- [x] `acp_config.rs` 增加 `set_config_option_request(session_id, config_id, value) -> Value`（纯函数，便于断言 JSON）
- [x] `acp.rs` 的 `SessionRequest::Turn { prompt, model_id }` 分支：
  - `model_id` 存在且与当前模型不同 → **先**发 `session/set_config_option`，**等响应**，再发 `session/prompt`
  - 响应里的 `configOptions` 整体替换本地状态（不局部 patch）
- [x] 新增 `SessionRequest::SetConfigOption { config_id, value }` 变体（或复用 Turn 的路径）：
      用户在 popover 里改 `model_config` 项时下发，与模型切换走同一条写入通道
- [x] boolean 形态的 value 走 `{ type: "boolean", value: bool }`，select 形态走 `{ value: string }`
      （研究 §4：`type` 缺省时按 value_id 解析）
- [x] `SessionRequest::Input` 分支保持不变（clarification 不涉及模型）
- [x] 修正 `acp.rs:316` 的注释（设计 §3.5）

### 测试（纯函数优先）

- [x] `set_config_option_request` 产出的 JSON 形状（`jsonrpc` / `id` / `method` / `params.sessionId` / `configId` / `value`）
- [x] 「模型相同则不发请求」的分支
- [x] boolean 形态请求体（含 `type` 判别器）与 select 形态请求体各一条
- [x] 「响应全量替换」的状态机单测

**验证**：`cargo test --lib agent::chat::adapter`

## 阶段 5：能力探测 + 移除字符串分派

### 5.1 `AgentAdapter` 扩展

- [x] trait 增加 `supports_model_selection()`（默认 `false`）与 `model_catalog()`（默认 `None`）
- [x] `AcpAdapter`：`supports_model_selection()` → `true`；`model_catalog()` → `None`
- [x] `ServeAdapter`：`supports_model_selection()` → `true`；`model_catalog()` → `Some(OpencodeCatalog)`
- [x] `DeepseekAdapter`：保持默认（不支持）
- [x] `ModelCatalog` trait + `OpencodeCatalog` 实现（包装现有 `discover_opencode_models`）

### 5.2 命令层去特判

- [x] `list_agent_models` 改为 `adapter_for(&agent)?.model_catalog()` 分派
- [x] 返回类型改为 `ModelCatalogResult`（`available` / `session-scoped` / `unsupported`）
- [x] **删除** `if agent_id == "opencode"`

### 5.3 测试

- [x] **静态护栏**：读 `commands.rs` 源码，断言函数体内无 `agent_id ==` （同 `entryWiring.test.ts` 的静态护栏范式）
- [x] 三种 kind 各一条命令层测试
- [x] `opencode` 现有 9 条 `model_discovery` 测试全绿（AC6）

**验证**：`cargo test --lib` + `pnpm check:quick`

## 阶段 6：前端 kind 分流 + 模型 popover

### 6.1 能力分流

- [x] `useAgentModels` 返回 `{ result: ModelCatalogResult, loading }`，不再只给 `models`
- [x] `EditorPanel` 模型下拉措辞分流（设计 §5.1 表）
- [x] `disabled` 判据改为 `kind !== 'available'`（当前用 `models.length === 0`，把「加载中」也误禁）
- [x] `CommentTranslationButton` / `TranslationView` / `useAgentChat` 三个消费点同步
- [x] 测试：四种 kind 各一条措辞断言 + 「控件始终存在」一条（AC7）

### 6.2 模型 popover：模型选择 + `model_config` 控件

规范 MAY/SHOULD：`model_config` **SHOULD** 渲染在模型选择器附近（同一 popover）。

- [x] `ModelPicker` 的 popover 内分两区：
  - 上：模型列表（`ModelInfo[]`）
  - 下：`model_config` 项（按 `type` 渲染：`select` 下拉 / `boolean` 开关）
- [x] `thought_level`（推理档位）与 `model_config` 同区渲染（RFD 明说它是特例）
- [x] 无任何 `model_config` 项 → 该区不渲染（不显示空控件）
- [x] **删除**模型名后的 `· 200k ctx · free` 拼接（`ModelPicker.tsx:109-111`）——
      这些信息改由下方 config 控件表达
- [x] `ModelPicker` 状态改为消费 `configOptions` 全量（agent 可能回推变更）
- [x] 测试：
  - `model_config` 有两项时渲染两个控件
  - boolean 项渲染为开关
  - 无 `model_config` 时不渲染该区
  - 模型列表区与 config 区同时存在

**验证**：`pnpm test:fe`

## 阶段 7：收尾

- [x] `pnpm check`（全量，31 护栏）
- [x] 变异验证（见下）
- [x] 更新 `.trellis/spec/backend/lsp-domain.md` 附近若有 ACP 相关段落 —— 或新增 `agent-acp.md` 记录 configOptions 契约
- [x] PR 描述显式说明「模型列表不再显示 context window / free 标记」（避免被当成回归）

## 变异验证清单

每条护栏用例必须做：回退实现 → 确认变红 → 恢复。

| 变异 | 期望变红的用例 |
| --- | --- |
| `find_by_category` 只按 `id == "model"` 找 | `category` 存在但 `id` 不同的用例 |
| 忽略 `SessionConfigSelectGroup` | 分组展平用例 |
| `session/new` 解析失败即中断 | 「缺失 configOptions 不中断会话」用例 |
| `set_config_option` 改用局部 patch | 全量替换用例 |
| 模型相同仍发请求 | 「相同则不发」用例 |
| `list_agent_models` 恢复 `agent_id ==` | 静态护栏 |
| `ChatStart` 只接受字符串 | 对象形态往返用例 |
| 前端 `disabled` 仍用 `models.length === 0` | kind 分流措辞用例 |

## 依赖关系（必须遵守）

```
阶段 1 ──> 阶段 2 ──> 阶段 3 ──> 阶段 4 ──> 阶段 5 ──> 阶段 6
                     ↑
                必须与阶段 2 同批（否则 ModelPicker 编译失败）
```

阶段 5 依赖阶段 4：没有「写入」前不能删 opencode 的私有路径 —— 否则 opencode 会短暂失去模型能力。

## 实施结果与残留

### 已完成（7 个提交）

| 提交 | 内容 |
| --- | --- |
| `8673517b` | 后端：ACP 模型选择收敛到协议层（含 `ConfigOptionsState`） |
| `5c80b3d8` | 前端：Agent 表单可配置 ACP 启动参数 |
| `9a6bfbcc` | 前端：渲染 ACP 会话配置项（模型 popover + `model_config`） |
| `ecf07aa5` | 测试串行化 + ACP 契约 spec |
| `a8161636` | 模型发现合并为单个 adapter 方法 + `model_list_args` 与 chat 解耦 |
| `0c02f0b8` | 前端表单可声明列模型命令 + MockAgent 改名/图标 |
| `fb032fb4` | mockAgent 端到端验证模型选择 |

验证：`pnpm check` 31/31、`cargo test` 1938、`vitest` 5501。

### AC5 端到端：通过 mockAgent 完成

PRD 要求「对至少一个 ACP agent 端到端验证」。真实 agent 里没有一家原生提供 ACP 入口
（`opencode` / `claude` / `codex` / `pi` / `omp` 都不行；Pi 的 `--mode rpc` 是私有 JSON
协议；claude / codex 需另装 `claude-agent-acp` / `codex-acp`）。

**解法**：把 `mockAgent` 的进程内 ACP server 补成会说话的模型提供方。它本来就跑完整的
`AcpAdapter::create_with_io`（`AcpIo::Mock` → duplex 管道 → 真实握手），只是以前
`session/new` 只回 `sessionId`。现在：

- `session/new` 返回带 `category: "model"` 的 `configOptions`（另有 `model_config` /
  `thought_level` / boolean 各一项）；
- `session/set_config_option` 更新会话状态并回**全量** `configOptions`；
- 模型项的 `id` **故意不叫 `"model"`** —— 规范说 `category` 才是判据。

两条端到端测试（都走生产路径，不是纯函数）：

| 测试 | 覆盖 |
| --- | --- |
| `mock_agent_exposes_models_and_applies_switches_end_to_end` | 列表来自会话 → 切换下发 → agent 回推确认 |
| `create_swithces_model_before_the_first_prompt` | 新会话首轮前就切模型（最易漏的路径） |

变异验证：把 `find_model_option` 退回按 `id == "model"` 查找 → 第一条立刻失败。
这说明测试真正钉住了「按 category 定位」这条协议契约。

事件等待都加了 5s 超时：被测代码有缺陷时表现为**失败**而不是让 `cargo test` 挂死。

### 会话外模型列表：`model_list_args`（原「不再需要」已被推翻）

PRD 的 OQ2 曾标注「各目标 agent 的列模型命令不再需要」，理由是四家都提供
`configOptions`。该结论**只对了一半**：`configOptions` 确实存在，但它只在**会话内**。

用户打开 Chat、还没发消息时是没有会话的。这时唯一能给出列表的就是 agent 自己的
命令 —— opencode 有 `models --verbose`，**Pi 有 `--list-models`**（表格输出，
实测 197 个模型）。

落地方式：

- `AgentConfig.model_list_args: Option<Vec<String>>`，与 `prompt_args` 同形；
- `list_agent_models` **先**试这条命令，**再**看 transport 能力 ——
  因为 `adapter_for` 对 `chat: None` 返回 `Err`，先取 adapter 会让 Pi 这类
  agent 连问都问不到（它当前正是 `chat: None`）；
- 解析按命令分派：opencode 是 NDJSON，Pi 是固定宽度表格，未知命令走「每行一个 id」兜底；
- Pi 的表格解析**按表头读出的列位置切片**，不硬编码、不按空白 split ——
  前者上游加列就错位，后者列值含空格就串位。

### 旧 `models` API 兼容层：不做

见 `design.md` §4。Gemini / Kimi 在内置定义里 `chat: None`，ACP 路径不可达；为走不到的
路径写代码没有验证手段。重新引入的条件已写在该节。

## 不做的事

- 不建临时会话查模型列表（协议无轻量查询，代价是进程启动；改为 `session-scoped`）
- 不接 `providers/*`（unstable，语义是 LLM 路由不是模型）
- 不支持手动输入模型 ID（用户已否决）
- 不迁移到 ACP v2（`id` → `configId` 的改名可后续一次性做）
- ~~不实现 boolean config options~~ **已改为必做**（AC9/AC10）：`model_config` 里的开关类参数依赖它
- 不实现 `mode`（plan/build 等）选择器 —— 本次只做模型相关 category（`model` / `model_config` / `thought_level`）
