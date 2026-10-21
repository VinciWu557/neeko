# 统一 ACP 模型发现与选择 — 技术设计

> 前置阅读：`research/acp-model-selection.md`（一手协议取证，含 schema 原文与各 agent 源码行号）。
> 本文只写**决策与结构**，不复述证据。

## 0. 研究结论对原方案的修正

原始诉求是「ACP 不支持就用私有命令兜底」。研究推翻了前提：

| 原假设 | 实际情况 |
| --- | --- |
| ACP 没有模型选择 | **有**，机制是 session config options（`category: "model"`），`0.10.8` 起稳定 |
| 可以单独查询模型列表 | **不能**，协议无 `models/list`；必须先建立会话，列表来自 `session/new` 响应的 `configOptions` |
| `ModelInfo` 可以照搬 | **是我们自己多要了字段**：8 个里 6 个出自 opencode 私有 NDJSON，不是 ACP 缺 |
| 私有命令是主路径 | 退化为**可选快速路径**，仅用于「不建会话就预览列表」 |

因此设计的重心从「兜底」转为**统一抽象 + 诚实降级**。

## 1. 核心抽象：`ChatStart` 决定传输，传输暴露模型能力

### 1.1 现状

`adapter_for(config)` 已按 `ChatStart` 类型分派（`Acp` / `Serve` / `Jsonl` / `Mock`），**这是正确的扩展点**，只是没人用它做模型发现。`list_agent_models` 反而走了 `if agent_id == "opencode"`。

### 1.2 设计：能力挂在协议层，不挂在 agent id

```rust
// src-tauri/src/agent/chat/adapter.rs
#[async_trait]
pub trait AgentAdapter: Send + Sync {
    // ... 现有 kind / create / resume ...

    /// 本适配器能否暴露模型选择。默认否，由适配器 opt-in（OCP）。
    fn supports_model_selection(&self) -> bool {
        false
    }

    /// 会话内的模型条目来源。
    ///
    /// 返回 `None` 表示「不需要外部列表」—— 模型由会话自己的 configOptions 提供
    ///（ACP 路径）。返回 `Some(_)` 表示走 agent 私有命令（快速路径）。
    fn model_catalog(&self) -> Option<&dyn ModelCatalog> {
        None
    }
}
```

**ACP 路径不实现 `model_catalog`**：它的模型来自会话 `configOptions`，本来就不该有独立目录。这正是「能力归属于协议」的体现。

### 1.3 删除字符串分派

```rust
// 改造后
pub async fn list_agent_models(...) -> Result<ModelCatalogResult, AppError> {
    let agent = resolve_agent_config(&state, &agent_id)?;
    let adapter = adapter_for(&agent)?;
    match adapter.model_catalog() {
        Some(catalog) => catalog.list(&agent).await,
        None if adapter.supports_model_selection() =>
            Ok(ModelCatalogResult::SessionScoped),   // 明确告知「要在会话里取」
        None => Ok(ModelCatalogResult::Unsupported),
    }
}
```

零 `agent_id ==`。新增 agent 不改此处。

## 2. `ModelInfo` 回归协议形状（决策：选项 A + B）

### 2.1 病因厘清

初版设计把这件事写成「ACP 给不了那 6 个字段」，这是**倒果为因**。事实是：

| `ModelInfo` 字段 | 真实来源 | 性质 |
| --- | --- | --- |
| `id` / `name` | ACP `SessionConfigSelectOption.value` / `.name` | 协议字段 |
| `provider_id` | **我们自己**从 opencode `providerID` 拼进 `id` | 私有 |
| `provider_name` | **我们自己**加的 | 私有 |
| `context_window` | **我们自己**从 opencode `limit.context` 捞的 | 私有 |
| `supported_reasoning_efforts` | **我们自己**从 `variants[].reasoningEffort` 捞的 | 私有 |
| `default_reasoning_effort` | **我们自己**加的 | 私有 |
| `is_free` | **我们自己**从 `cost` 推的 | 私有 |

问题不是协议贫瘠，而是**我们把 opencode 的私有 NDJSON 字段直接模型化成了通用契约**。下游于是写出「ACP agent 永远拿到 `None`」的代码而不自知。

### 2.2 正确归属：`model` vs `model_config`

ACP 用**两个 category** 表达这两类信息：

| category | 语义 | 承载 |
| --- | --- | --- |
| `model` | 模型选择器 | `ModelInfo { id, name, description? }` |
| `model_config` | **模型相关配置参数** | 上下文大小、速度/质量取舍等，各自是独立 config option |

`model_config` 有独立 RFD，原文：

> 「so that agents can expose model-related parameters (**context size, speed/quality trade-offs, etc**) and clients can group them alongside the main model selector in the UI」

`1.1.0`（2026-06-24）稳定。

**结论**：`context_window` / 推理档位不是模型条目的属性，是**与模型相关的配置项**。把它们塞进 `ModelInfo` 是错误建模；把它们直接删掉则是功能退步。正确处理是**移交给 `model_config`**。

### 2.3 新形状

```rust
pub struct ModelInfo {
    pub id: String,          // SessionConfigSelectOption.value
    pub name: String,        // SessionConfigSelectOption.name
    pub description: Option<String>,
}
```

**删除** 6 个私有字段。它们的能力由 §2.5 的 config options 承接，**不是丢弃**。

### 2.4 规范要求：`model_config` 必须渲染在模型选择器附近

`docs/protocol/v1/session-config-options.mdx` 原文：

> 「Clients **SHOULD** render `model_config` options near the `model` selector, such as in the same popover or panel. No capability negotiation is required for category values.」

所以 UI 形状是：**一个模型 popover，内含模型选择 + 若干 model_config 控件**，而不是把 config options 塞进模型名那一行文本。

当前 `ModelPicker.tsx:110-111` 把 `200k ctx · free` 拼在模型名后，正是「把独立选项挤进一行字符串」的反模式，本次一并纠正。

### 2.5 `model_config` 的范围与降级

- 与 `model` 共用同一套 `configOptions` 遍历（`category` 不同），边际成本小；
- 每个 `model_config` 项按其 `type` 渲染：`select` → 下拉，`boolean` → 开关；
- **`boolean` 形态需要能力协商**（见研究 §11）：Neeko 现在没发 `session.configOptions.boolean`。本次补上，否则 agent 不会下发 boolean 项；
- agent 不提供任何 `model_config` → 该区域不渲染（不是显示空控件）；
- `thought_level`（推理档位）单独处理：它语义上是 `model_config` 的特例（RFD 明说保留仅为向后兼容），渲染位置相同。

### 2.6 对 `ModelPicker.tsx` 的影响

| 行 | 现状 | 处理 |
| --- | --- | --- |
| 21 | 搜索匹配 `provider_name` | 只匹配 `name` / `id` |
| 109 | 显示 provider 名 | 删除（provider 已在 `value` 里，不属于展示层） |
| 110 | 显示 `context_window` | **移入 `model_config` 控件** |
| 111 | 显示 `is_free` | 删除（协议无此概念） |
| 194 | 当前模型带 provider 后缀 | 删除后缀 |

`historyRestore.ts:19` 的 `provider_id === provider` 匹配改为按 `id` 全等（OpenCode 的 value 本身即 `provider/model` 形式，无需再拆）。

> **不再有功能退步**：context window 从「拼在模型名后的字符串」变成「popover 内的独立 config 控件」，符合规范 SHOULD，且信息更完整（agent 提供什么就显示什么）。

## 3. ACP 适配器的模型实现

### 3.1 读：从 `session/new` 响应保留 `configOptions`

现状 `acp.rs` 只取 `sessionId`，丢弃其余。改造：

```rust
// create_with_io 内，session/new 响应处理处
let config_options: Vec<SessionConfigOption> =
    serde_json::from_value(session_id_resp.get("configOptions").cloned().unwrap_or(json!([])))
        .unwrap_or_default();
```

**必须容忍缺失 / 解析失败** —— 老 agent 不发该字段（Gemini / Kimi 实测），解析失败不能中断会话建立。

### 3.2 定位模型项：靠 `category`，不靠 `id`

```rust
fn find_option_by_category<'a>(
    options: &'a [SessionConfigOption],
    category: &str,
) -> Option<&'a SessionConfigOption> {
    options.iter().find(|o| o.category.as_deref() == Some(category))
}
```

**规范原文**：`category` 是 UX 提示，「MUST NOT be required for correctness」，「Clients MUST handle missing or unknown categories gracefully」。

实测各家 `id` 碰巧都是 `"model"`，但这是**惯例不是规范**。所以：

1. 先按 `category == "model"` 找；
2. 找不到时按 `id == "model"` 兜底；
3. 两者皆无 → 视为该 agent 不支持模型选择（静默降级，不报错）。

三条路径都要有测试。

### 3.3 写：`session/set_config_option`

```rust
SessionRequest::Turn { prompt, model_id } => {
    // 若与当前模型不同，先发 set_config_option，再发 prompt
    // 响应返回全量 configOptions → 整体替换本地状态
}
```

**关键约束（研究第 4 节）**：响应是**全量**的，必须整体替换而非局部 patch。改变模型可能连带改变 `thought_level` 的可选值，局部更新会留下陈旧选项。

**Q3 决策**：`serve` 保留 per-turn 切换；ACP 的 `model_id` 语义重定义为「本轮开始前切到该模型」。两者对上层呈现一致。

### 3.4 必须订阅 `config_option_update`

协议明确 agent 可能**主动换模型**（rate limit fallback）。不订阅的话，UI 显示的当前模型会与真实状态脱节。

```rust
"session/update" => {
    // 现有 translate_notification
    // 新增：sessionUpdate == "config_option_update" → 整体替换 configOptions
}
```

### 3.5 修正误导性注释

`acp.rs:316` 的
```rust
// ACP has no per-turn model selection (upstream limitation)
```
改为
```rust
// ACP 的模型选择是会话级（session/set_config_option），不是 per-turn 参数。
// 因此本轮若有 model_id，须在发 prompt **之前**先切配置。
```

## 4. 不做旧 `models` API 的兼容层

研究 D 节建议把已删除的 `models` / `session/set_model` 隔离在一个可删模块里，供 Gemini CLI
与 Kimi CLI 使用。**本次决定不做**，理由如下：

1. **不可达**：这两家在内置定义里 `chat: None`（只能走终端 / headless），ACP 路径根本
   不会被执行到。为一条走不到的路径写代码，是没有验证手段的死重量。
2. **能力判定会失真**：`AcpAdapter::supports_model_selection()` 对所有 ACP agent 返回
   `true`。若将来给 Gemini 配上 ACP 入口，会出现「`list_agent_models` 答 `SessionScoped`，
   而会话内永远没有模型项」—— 届时应当**先**做能力探测，而不是先补旧 API。

**重新引入的条件**：某家仍钉在旧 SDK 的 agent 真的需要作为 ACP chat 接入时，再按当时的
协议状态实现，并同时补能力探测。届时参考本节删掉的方案不会被遗忘 —— 研究文档
`research/acp-model-selection.md` 第 9 节保留了完整的旧 schema 快照。

> 原本这里规划了 `acp/legacy_models.rs`。删除是因为「计划中的抽象」本身也有成本：
> 留着未实现的承诺，会让下一个读设计文档的人以为这部分已经想清楚了。

## 5. 前端契约

### 5.1 `list_agent_models` 返回类型变更

```ts
type ModelCatalogResult =
  | { kind: 'available'; models: ModelInfo[] }      // 私有命令路径（opencode 快速列表）
  | { kind: 'session-scoped' }                       // ACP：需要会话，设置页显示引导
  | { kind: 'unsupported' }                          // agent 不支持模型选择
  | { kind: 'error'; message: string };              // 命令执行失败，可重试
```

**这解决了 PRD 的 P2**（空数组三义性）。`useAgentModels` 相应改为携带 `kind`，UI 措辞分流：

| kind | 设置页模型下拉 |
| --- | --- |
| `available` | 正常列出 |
| `session-scoped` | 「模型在会话内可用」（禁用 + 说明） |
| `unsupported` | 「此 Agent 不支持选择模型」（禁用 + 说明） |
| `error` | 「无法获取模型列表」+ 重试 |

用户明确要求：**不做传输协议分档，全部 agent 一致呈现控件**。上表满足 —— 控件始终存在，只是措辞随能力变化。

### 5.2 设置页

模型下拉的 `disabled` 判据从 `models.length === 0` 改为 `kind !== 'available'` —— 当前这个判据把「加载中」也禁用了，且无法区分原因。

## 6. `ChatStart` 可配置化（PRD R1 / OQ3）

### 6.1 问题

```rust
// ChatStart 序列化为裸字符串；Acp { args } 的 args 反序列化时恒为 Vec::new()
_ => Self::Acp { args: Vec::new() },
```

`args` 不持久化 ⟹ 用户无法给任意 agent 配 ACP 启动命令 ⟹ `chat: acp` 事实上不可用（除内置定义）。

### 6.2 方案：向后兼容的序列化演进

保持**旧格式可读**，新增结构化形态：

```rust
// 读：字符串 → 旧语义（acp 无 args）
"acp" => Self::Acp { args: vec![] },
// 读：对象 → 新语义
{ "transport": "acp", "args": ["--acp"] }  → Self::Acp { args: [...] }
```

需要 `#[serde(untagged)]` 或自定义 `Deserialize` 接受两种形态。**写**统一用对象形态（`args` 为空时仍写字符串，保持 diff 最小）。

### 6.3 前端

`src/shared/types/agent.ts` 的 `ChatStart` 从联合字符串扩展为：

```ts
export type ChatStart = 'acp' | 'serve' | 'jsonl' | 'mock' | { transport: 'acp'; args: string[] };
```

`AgentForm.tsx` 增加「ACP 启动参数」输入行（仅当 transport 为 acp 时显示）。

> **注意**：该字段是 `args`（附加在 `command` 之后），不是完整命令行。用户填 `--acp` 而非 `claude --acp`。

## 7. 执行顺序与依赖

```
阶段 1  ChatStart 可配置化           ← 前置：没有它，非内置 agent 进不了 ACP
阶段 2  ACP configOptions 读取        ← 模型列表 + 全部 config option 的来源
阶段 3  ModelInfo 回归 + 消费点适配   ← 会破坏 ModelPicker，须同批改
阶段 4  set_config_option 写入        ← 让选择真正生效（AC5），含 model_config
阶段 5  能力探测 + 命令层去特判       ← 删掉 if agent_id == "opencode"
阶段 6  前端 kind 分流 + 模型 popover  ← 含 model_config 控件渲染
```

**阶段 3 必须与阶段 2 同批**：`ModelInfo` 精简会让 `ModelPicker` 编译失败，不能停在中间态。

## 8. 验收要点（对应 PRD AC）

| AC | 验证方式 |
| --- | --- |
| AC1 无字符串分派 | 静态护栏：`list_agent_models` 函数体内禁止 `agent_id ==` 字面量比较 |
| AC2 新增 agent 免改命令层 | 用一个假 `ChatStart` 变体做测试，证明无需触碰 commands.rs |
| AC3 ACP 命令可配置 | 序列化往返测试 + 旧格式兼容测试 |
| AC4 四种 kind 可区分 | 每种 kind 一条测试；前端措辞各一条 |
| AC5 模型真实生效 | **端到端**：起真实 ACP 会话（或 mock 协议交互），断言 `set_config_option` 发出的 JSON |
| AC6 opencode 不回退 | 现有 `discover_opencode_models` 测试全绿 |
| AC7 呈现一致 | 前端测试：三种 kind 下控件都存在 |

## 9. 风险

| 风险 | 缓解 |
| --- | --- |
| 建临时会话列模型有进程开销与副作用 | 不做；改为 `session-scoped`，由会话内提供 |
| 老 agent（Gemini/Kimi）用已删 API | 隔离在 `legacy_models.rs`，文件头标注可删除 |
| `category` 缺失导致定位失败 | 三级探测（category → id → 不支持）+ 各自测试 |
| OpenCode 的 value 是 `provider/model` 复合串，其他是裸 id | 不解析 value，整体当不透明字符串传递 |
| `model_config` 被误当成选项挤进模型名 | 规范 SHOULD 要求渲染在模型选择器附近；独立控件，不拼字符串 |
| boolean config option 未协商导致拿不到 | 阶段 2 补 `session.configOptions.boolean` 能力声明 |
