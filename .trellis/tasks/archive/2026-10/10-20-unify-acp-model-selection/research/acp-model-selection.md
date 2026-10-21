# ACP 模型选择 / 模型发现 —— 协议调研

调研时间：2026-10-20
调研对象：`.trellis/tasks/10-20-unify-acp-model-selection`

## 证据来源（一手）

| 来源 | 版本 / 提交 | 说明 |
| --- | --- | --- |
| `github.com/agentclientprotocol/agent-client-protocol` | `ff7ef5169fd74e7f8921dc24413110a65753168e`（2026-10-20），CHANGELOG 最新发布 `1.12.0`（2026-10-16） | 规范 + schema 的规范上游 |
| `schema/v1/schema.json`、`schema/v1/schema.unstable.json` | 同上 | v1 稳定 + 不稳定 schema |
| `schema/v2/schema.json`、`schema/v2/schema.unstable.json` | 同上 | v2（后续大版本）schema |
| `docs/protocol/v1/session-config-options.mdx` | 同上 | 官方协议文档（已上线 `agentclientprotocol.com/protocol/v1/...`） |
| `docs/protocol/v2/migration.mdx` | 同上 | v1 → v2 迁移说明 |
| `docs/rfds/session-config-options.mdx`、`docs/rfds/model-config-category.mdx`、`docs/rfds/custom-llm-endpoint.mdx` | 同上 | 设计定案文档 |
| `github.com/agentclientprotocol/registry` | `e0c977a8db64fe6fa24f5aad5230eafaa659b231` | 官方 agent 注册表，用于确认实现清单 |
| `github.com/agentclientprotocol/claude-agent-acp`（原 `zed-industries/claude-code-acp`） | v0.94.0 | Claude 实现源码 |
| `github.com/agentclientprotocol/codex-acp` | v2.2.2 | Codex 实现源码 |
| `github.com/anomalyco/opencode` | v1.19.3 | OpenCode 实现源码 |
| `github.com/google-gemini/gemini-cli` | v0.64.0，SDK `@agentclientprotocol/sdk` 0.16.1 | Gemini CLI 实现源码 |
| `github.com/QwenLM/qwen-code` | v0.25.3 | Qwen Code 实现源码 |
| `github.com/MoonshotAI/kimi-cli` | v1.52.0，SDK `agent-client-protocol==0.8.0` | Kimi CLI 实现源码 |
| 标签 `v0.10.8` / `v0.12.0` / `v0.13.5` | 官方仓库 tag | 用于考证演进时间线 |
| `zed-industries/zed` `crates/agent_servers/src/acp.rs`（main） | 拉取当日 main | Zed 客户端侧消费方式 |

> 说明：网络可用，以上全部为实际拉取的一手材料。凡是**没有**直接从源码/schema 读到、而是靠命名或惯例推断的结论，都在文中单独标注 **【推测】**。

---

## 结论摘要（先回答 5 个问题）

1. **ACP 有模型选择 —— 但当前规范里唯一的机制是 Session Config Options，不是 `models` 字段。** `session/new` 响应可选返回 `configOptions` 数组，其中 `"category": "model"` 的一项就是模型选择器。当前上游**四份 schema（v1/v2 × stable/unstable）里 `availableModels` / `currentModelId` 的出现次数都是 0** —— 那套 `models` API 已被删除（详见结论 5）。`session/new` **请求**则完全没有模型字段。

2. **字段形状已确证**：`SessionConfigOption` 是扁平对象 + `type` 判别器（`"select"` / `"boolean"`），select 形态含 `currentValue: string` 与 `options: [{value, name, description?, _meta?}]`（支持分组）。**没有**单一的 `modelId` 字段；模型 ID 是 `currentValue` 的字符串值。改变选择用 `session/set_config_option`，请求 `{sessionId, configId, value}`，**响应返回全量 `configOptions`**；agent 主动变更则推 `session/update` 且 `sessionUpdate: "config_option_update"`。

3. **`session/prompt` 没有 model 参数**，也没有任何 per-turn 模型覆盖能力。`PromptRequest` 的属性只有 `sessionId` / `prompt` / `_meta`。因此 `acp.rs:316` 那句注释**方向正确但原因写错了**：不是"ACP 没有模型选择"，而是"ACP 的模型选择是会话级的 `set_config_option`，不是 per-turn 的 prompt 参数"。

4. **没有「列出可用模型」的独立 RPC 方法。** 四个 schema 变体（v1/v2 × stable/unstable）的 `meta.json` 里，`agentMethods` 中**没有任何**含 `model` 的方法名；也不存在 `models/list`。可发现性**只**来自 `session/new` / `session/load` / `session/resume` 响应里的 `configOptions`，以及后续 `config_option_update` 通知。**必须已有一个会话，才能拿到模型列表。**

5. **关于版本演进，有一个必须讲清的历史坑**：ACP **曾经**在 unstable 面有过一套独立的 `models` API（`NewSessionResponse.models: SessionModelState` + `session/set_model` 方法），在 **v0.12.0** 里明确存在，在 **v0.13.5（2026-06-01）被 PR #1325「Remove unstable session model API」删除**，由 Session Config Options 取代。所以今天还在用 `models` / `session/set_model` 的 agent 都是**钉在旧 SDK 上没迁**的（Gemini CLI、Kimi CLI 实测如此）。

---

## 详细证据

### 1. `session/new`：请求无模型字段，响应有 `configOptions`

**`NewSessionRequest`（v1 stable，`schema/v1/schema.json`）**

```json
{
  "properties": {
    "cwd": { "type": "string" },
    "additionalDirectories": { "type": "array", "items": { "type": "string" } },
    "mcpServers": { "type": "array", "items": { "$ref": "#/$defs/McpServer" } },
    "_meta": { ... }
  },
  "required": ["cwd", "mcpServers"]
}
```

属性集合实测为 `['cwd', 'additionalDirectories', 'mcpServers', '_meta']` —— **没有** `model` / `modelId` / `models` / `configOptions`。即：**不能在建会话时指定模型**。

> 注意这条还有实践价值：Neeko 现在发的是 `{"cwd": ..., "mcpServers": []}`。v2 中 `mcpServers` 改为可选（`docs/protocol/v2/migration.mdx`：「Note that `mcpServers` was required (even if empty) on `session/new` in v1 and is now optional」），v1 下必须保留。

**`NewSessionResponse`（v1 stable）**

```json
{
  "properties": {
    "sessionId": { "$ref": "#/$defs/SessionId" },
    "modes": { "$ref": "#/$defs/SessionModeState" },
    "configOptions": {
      "description": "Initial session configuration options if supported by the Agent.",
      "type": ["array", "null"],
      "items": { "$ref": "#/$defs/SessionConfigOption" }
    },
    "_meta": { ... }
  },
  "required": ["sessionId"]
}
```

属性集合实测：`['sessionId', 'modes', 'configOptions', '_meta']`。

**`NewSessionResponse`（v2 stable）**：`['sessionId', 'configOptions', 'availableCommands', '_meta']`
—— `modes` 被移除，`configOptions` 保留。`docs/protocol/v2/migration.mdx` 第 751 行：
> 「Both responses **MAY** include the session's `configOptions` and initial `availableCommands`. Neither carries `modes` anymore.」

### 2. `SessionConfigOption` 的确切形状

来自 `schema/v1/schema.json` 的 `$defs`（描述文字为原文）：

```jsonc
// SessionConfigOption — "A session configuration option selector and its current state."
{
  "type": "object",
  "required": ["id", "name"],
  "properties": {
    "id":          { "type": "string" },          // SessionConfigId
    "name":        { "type": "string" },
    "description": { "type": ["string", "null"] },
    "category":    { "$ref": "#/$defs/SessionConfigOptionCategory" },  // 可选，UX only
    "_meta":       { "type": ["object", "null"], "additionalProperties": true }
  },
  // 判别器在 type 上，两种形态互斥：
  "oneOf": [
    { "type": "object", "required": ["type"],
      "properties": { "type": { "const": "select" } },
      "allOf": [{ "$ref": "#/$defs/SessionConfigSelect" }] },
    { "type": "object", "required": ["type"],
      "properties": { "type": { "const": "boolean" } },
      "allOf": [{ "$ref": "#/$defs/SessionConfigBoolean" }] }
  ],
  "discriminator": { "propertyName": "type" }
}

// SessionConfigSelect — "A single-value selector (dropdown)"
{ "type": "object", "required": ["currentValue", "options"],
  "properties": {
    "currentValue": { "$ref": "#/$defs/SessionConfigValueId" },   // string
    "options":      { "$ref": "#/$defs/SessionConfigSelectOptions" }
  } }

// SessionConfigSelectOption — "A possible value for a session configuration option."
{ "type": "object", "required": ["value", "name"],
  "properties": {
    "value":       { "$ref": "#/$defs/SessionConfigValueId" },  // string
    "name":        { "type": "string" },
    "description": { "type": ["string", "null"] },
    "_meta":       { "type": ["object", "null"] }
  } }

// SessionConfigSelectOptions — 二选一：扁平数组，或分组数组（同数组内不可混用）
{ "anyOf": [
    { "title": "Ungrouped", "type": "array", "items": { "$ref": "#/$defs/SessionConfigSelectOption" } },
    { "title": "Grouped",   "type": "array", "items": { "$ref": "#/$defs/SessionConfigSelectGroup" }   }
] }

// SessionConfigSelectGroup
{ "type": "object", "required": ["group", "name", "options"],
  "properties": {
    "group":   { "type": "string" },
    "name":    { "type": "string" },
    "options": { "type": "array", "items": { "$ref": "#/$defs/SessionConfigSelectOption" } },
    "_meta":   { ... }
  } }

// SessionConfigBoolean
{ "type": "object", "required": ["currentValue"],
  "properties": { "currentValue": { "type": "boolean" } } }
```

要点：

- **模型 ID 不是一个专用字段，而是 `currentValue` 里的字符串**。也没有 `providerId` 之类的结构——provider 信息只能塞进 value 字符串（OpenCode 就是这么做的，见下文）或 `_meta`。
- `SessionConfigValueId` / `SessionConfigId` / `SessionConfigGroupId` 全部是 `string` 别名，没有格式约束。
- `category` 是**可选**的，且**明确只用于 UX**（见下条引用）。

### 3. `SessionConfigOptionCategory` —— `model` / `model_config` / `thought_level` / `mode`

`schema/v1/schema.json` 原文：

```jsonc
{
  "description": "Semantic category for a session configuration option.\n\nThis is intended to help Clients distinguish broadly common selectors (e.g. model selector vs\nsession mode selector vs thought/reasoning level) for UX purposes (keyboard shortcuts, icons,\nplacement). It MUST NOT be required for correctness. Clients MUST handle missing or unknown\ncategories gracefully.\n\nCategory names beginning with `_` are free for custom use, like other ACP extension methods.\nCategory names that do not begin with `_` are reserved for the ACP spec.",
  "anyOf": [
    { "const": "mode",          "description": "Session mode selector." },
    { "const": "model",         "description": "Model selector." },
    { "const": "model_config",  "description": "Model-related configuration parameter." },
    { "const": "thought_level", "description": "Thought/reasoning level selector." },
    { "title": "other",         "description": "Unknown / uncategorized selector.", "type": "string" }
  ]
}
```

`docs/protocol/v1/session-config-options.mdx` 有同等表格，外加两条规范性要求：

> 「Clients **SHOULD** render `model_config` options near the `model` selector, such as in the same popover or panel. No capability negotiation is required for category values.」
> 「When multiple options share the same category, Clients **SHOULD** use the array ordering to resolve ties, preferring earlier options in the list for prominent placement or keyboard shortcuts.」

**关键设计含义**：category 是提示，不是契约。**不能假设 `id == "model"`**，也不能假设 category 一定存在。这是 Neeko 统一实现时最容易踩的坑——正确做法是先按 `category == "model"` 找，找不到再考虑按 `id` 兜底，且必须容忍两者皆无。

### 4. `session/set_config_option` —— 唯一的会话级模型切换入口

`SetSessionConfigOptionRequest`（v1 stable）：

```jsonc
{
  "type": "object",
  "required": ["sessionId", "configId"],
  "properties": {
    "sessionId": { "$ref": "#/$defs/SessionId" },
    "configId":  { "$ref": "#/$defs/SessionConfigId" },
    "_meta":     { ... }
  },
  // 线上值的两种形态：
  "anyOf": [
    { "title": "boolean", "required": ["type", "value"],
      "properties": { "type": { "const": "boolean" }, "value": { "type": "boolean" } } },
    { "title": "value_id", "required": ["value"],
      "description": "A [`SessionConfigValueId`] string value.\n\nThis is the default when `type` is absent on the wire.",
      "properties": { "value": { "$ref": "#/$defs/SessionConfigValueId" } } }
  ],
  "x-method": "session/set_config_option"
}
```

`SetSessionConfigOptionResponse`：`required: ["configOptions"]`，**返回全量**。

官方文档对此有一条强约束（`docs/protocol/v1/session-config-options.mdx`）：

> 「The response always contains the **complete** configuration state. This allows Agents to reflect dependent changes. For example, if changing the model affects available reasoning options, or if an option's available values change based on another selection.」
> 「The Agent **MUST** respond with the complete list of all configuration options and their current values」

**这是 Neeko 必须建模的状态机**：不要做局部更新，要用响应整体替换本地 `configOptions`。

注意兼容性细节：`type` 字段在 select 形态下**可以缺省**（默认按 `value_id` 解析），但 v2 迁移文档说 v2 要求 `type` 必须是 `"id"` 或 `"boolean"` 判别器 —— 见下文 v2 差异。

### 5. Agent 主动推送变更：`config_option_update`

`ConfigOptionUpdate`（`session/update` 的一种 `sessionUpdate` 变体）：

```jsonc
{
  "required": ["configOptions"],
  "properties": {
    "configOptions": { "type": "array", "items": { "$ref": "#/$defs/SessionConfigOption" } },
    "_meta": { ... }
  }
}
```

线上形态（文档原文示例）：

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "config_option_update",
      "configOptions": [ { "id": "model", "name": "Model", "type": "select", "currentValue": "model-2", "options": [] } ]
    }
  }
}
```

文档给出的典型触发原因（第一条直击本次设计）：

> - Switching modes after completing a planning phase
> - **Falling back to a different model due to rate limits or errors**
> - Adjusting available options based on context discovered during execution

**含义**：即使用户不主动切模型，agent 也可能在回合中途换模型。Neeko 若要在 UI 上显示"当前模型"，**必须**订阅 `config_option_update`，不能只在 `session/new` 时读一次。

### 6. `session/prompt` 没有模型参数（已确证）

`PromptRequest`（v1 stable）属性实测：`['sessionId', 'prompt', '_meta']`。`required: ["sessionId", "prompt"]`。

v2 `PromptRequest` 属性实测：`['sessionId', 'prompt', '_meta']` —— 同样没有。

所以 `src-tauri/src/agent/chat/adapter/acp.rs:316` 的注释：

```
// ACP has no per-turn model selection (upstream limitation); the
// field is ignored here.
```

**结论**：描述的现象成立（确实**没有 per-turn** 模型选择），但把原因归为"ACP 没有模型选择"会误导架构决策。准确表述应是：

> ACP 的模型选择是**会话级**的（`session/set_config_option`），不是 per-turn 的；因此 `SessionRequest::Turn { model, .. }` 里的 `model` 字段无法在单次 `session/prompt` 上生效——要在**发 prompt 之前**先 `set_config_option`。

### 7. 没有独立的「列出模型」方法（已确证）

对四个 meta 文件逐一读取 `agentMethods`，筛出方法名含 `model` 的：

```
schema/v1/meta.json            → []
schema/v1/meta.unstable.json   → []
schema/v2/meta.json            → []
schema/v2/meta.unstable.json   → []
```

并在 `schema/` 与 `docs/` 全目录 grep `models/list|models_list|listModels|list_models` → **零命中**。

对比：v0.12.0 的 `meta.unstable.json` 中 `agentMethods` 确实有 `"session_set_model": "session/set_model"`（见下节）。即该能力被**删除**，不是改名。

**因此**：模型可发现性的唯一入口是「已建立会话」这个上下文：

- `session/new` 响应（首个会话）
- `session/load` / `session/resume` 响应
- `config_option_update` 通知

**给 Neeko 的直接后果**：想拿到某 agent 的模型列表，**必须真的拉起一个 ACP 会话**（spawn 子进程 + handshake + `session/new`），然后丢弃或复用。没有"轻量查询"路径。这对 `list_agent_models(agent_id)` 这个现有命令的语义是根本性冲击 —— 见「对 Neeko 设计的影响」。

### 8. 版本与演进时间线（每条都有 CHANGELOG / tag 证据）

**`protocolVersion` 当前值**：`ProtocolVersion` 是 `integer / uint16`，描述为：
> 「This version is only bumped for breaking changes. Non-breaking changes should be introduced via capabilities.」

官方文档 `docs/protocol/v1/initialization.mdx` 中的示例一律是 `"protocolVersion": 1`；V2 另有 `docs/protocol/v2/`，meta 里 `"version": 2`。

Neeko 现状：`src-tauri/src/agent/chat/adapter/acp.rs:32` → `const ACP_PROTOCOL_VERSION: i64 = 1;` —— **已在正确答案上，无需改动**。这一点很重要：**模型选择不需要升协议版本**，因为它是 v1 稳定面里的可选字段。

| 日期 | 版本 | 事件（CHANGELOG 原文） |
| --- | --- | --- |
| 2025-09-22 | `0.4.1` | **Protocol** — 「**Unstable** initial support for model selection.」 |
| 2025-09-22 | `0.4.2` | Rust — 「**Unstable** fix missing method for model selection in Rust library.」 |
| 2025-10-02 | `0.4.5` | TypeScript — 「**Unstable** initial support for model selection.」 |
| 2025-12-16 | `0.10.4` | 「*(unstable)* Draft implementation of session config options (#339)」 |
| 2026-01-09 | `0.10.6` | 「*(unstable)* Add a category to session config options (#366)」 |
| 2026-01-15 | `0.10.7` | 「*(rfd)* Session Config Options to Preview stage (#378)」 |
| **2026-02-04** | **`0.10.8`** | **「Stabilize Session Config Options (#411)」** ← `category: "model"` 首次进入**稳定**面 |
| 2026-06-01 | `0.13.5` | 「*(unstable)* **Remove unstable session model API** (#1325)」、 「*(unstable-v2)* Remove dedicated session modes and models apis from v2 (#1324)」 |
| 2026-06-18 | `0.14.0` | 「*(rust)* Expose v1 schema types only under v1 module (#1457)」 |
| 2026-06-24 | `1.0.0` | 发布（`0.14.0` → `1.0.0`），附带「*(unstable)* Add boolean config option capabilities (#1490)」 |
| **2026-06-24** | **`1.1.0`** | **「*(schema)* Stabilize model_config option category (#1502)」** |
| 2026-07-06 | `1.3.0` | 「*(schema)* Stabilize boolean session config options (#1604)」 |
| 2026-10-16 | `1.12.0` | 最新发布 |

**`model_config` 类别有独立 RFD**，`docs/rfds/model-config-category.mdx` 的 Revision history：

```
- 2026-06-24: Moved to Completed and stabilized `model_config` in the protocol artifacts
- 2026-06-22: Move to preview
- 2026-04-08: Initial proposal
```

RFD 摘要（原文）：
> 「Add a new `model_config` category to session configuration options, so that agents can expose model-related parameters (context size, speed/quality trade-offs, etc) and clients can group them alongside the main model selector in the UI.」
> 「Once `model_config` exists, `thought_level` is semantically a special case of a model configuration parameter. We keep `thought_level` as-is for backward compatibility ... but new model-related options should use `model_config`.」

**验证 `0.10.8` 是首个稳定面**（实际 checkout tag 后读 `schema/schema.json`）：

```
SessionConfigOptionCategory present: True
  anyOf: const "mode" / "model" / "thought_level" / {title:"other"}
NewSessionResponse props: ['_meta', 'configOptions', 'modes', 'sessionId']
SetSessionConfigOptionRequest present: True
```

注意：`0.10.8` 稳定面只有 3 个具名 category（**无 `model_config`**），`model_config` 是 `1.1.0` 才稳定的。这给出**两级能力探测**的必要性：老 agent 只会给 `mode`/`model`/`thought_level`。

### 9. 被删除的旧 `models` API（v0.12.0 实证）

checkout tag `v0.12.0` 后读 `schema/schema.unstable.json`，含 `models` 相关定义的完整清单：

```
"availableModels"  "currentModelId"  "model"  "modelId"  "ModelId"  "ModelInfo"
"models"  "SessionModelState"  "SetSessionModelRequest"  "SetSessionModelResponse"
```

`NewSessionResponse`（v0.12.0 unstable）同时含 `models` **和** `configOptions`：

```jsonc
"properties": {
  "configOptions": { "items": { "$ref": "#/$defs/SessionConfigOption" }, "type": ["array","null"],
                     "description": "Initial session configuration options if supported by the Agent." },
  "models": { "anyOf": [{ "$ref": "#/$defs/SessionModelState" }, { "type": "null" }],
              "description": "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nInitial model state if supported by the Agent" },
  "modes": { ... },
  "sessionId": { ... }
}
```

`SessionModelState`（已删除）：

```jsonc
{
  "type": "object",
  "required": ["currentModelId", "availableModels"],
  "properties": {
    "availableModels": { "type": "array", "items": { "$ref": "#/$defs/ModelInfo" } },
    "currentModelId":  { "$ref": "#/$defs/ModelId" }
  }
}
// ModelInfo: required ["modelId","name"]; 可选 description
// SetSessionModelRequest: required ["sessionId","modelId"], x-method: "session/set_model"
// SetSessionModelResponse: 无字段
```

`v0.12.0` 的 `meta.unstable.json` 里 `agentMethods` 含 `"session_set_model": "session/set_model"`。

**这套 API 在 `0.13.5`（2026-06-01，PR #1325）被删除**，`models` 字段与 `session/set_model` 方法从所有 schema 消失。**现在的 v1/v2 stable + unstable 里 `availableModels`/`currentModelId` 计数为 0**（实测）：

```
v1/schema.json:0   v2/schema.json:0   v1/schema.unstable.json:0   v2/schema.unstable.json:0
```

**这是本次调研最重要的历史事实**：Gemini CLI 和 Kimi CLI 今天（2026-10）仍在用这套已废弃 API，因为它们的 SDK 版本停留在删除之前。

### 10. `providers/*`（unstable）不是模型选择

`schema/v1/schema.unstable.json` 里有 `providers/list` / `providers/set` / `providers/disable`。逐条读定义后确认其语义是 **LLM 路由配置，不是模型选择**：

- `ProviderInfo`: `{ providerId, supported: LlmProtocol[], required: boolean, current?: ProviderCurrentConfig }`
- `ProviderCurrentConfig`: `{ apiType: LlmProtocol, baseUrl: string }`
- `SetProviderRequest`: `{ providerId, apiType, baseUrl, headers? }`

`docs/rfds/custom-llm-endpoint.mdx` 的 Elevator pitch 原文：

> 「Add the ability for clients to discover and configure agent LLM providers (identified by `id`) via dedicated provider methods: `providers/list` / `providers/set` / `providers/disable`. This allows clients to route LLM requests through their own infrastructure (proxies, gateways, or self-hosted models) without agents needing to know about this configuration in advance.」

**结论**：`providers/*` 用于「走哪个 API endpoint / 网关」，**不含模型 ID 列表**。Neeko 若想做模型选择，**不应**碰这套 unstable API。

### 11. 客户端能力协商（可选，但相关）

`ClientCapabilities.session.configOptions.boolean`：

```jsonc
// SessionConfigOptionsCapabilities
{ "properties": {
    "boolean": {
      "description": "Whether the client supports boolean session configuration options.\n\nOptional. Omitted or `null` both mean the client does not advertise support.\nSupplying `{}` means agents may include `type: \"boolean\"` entries in `configOptions`...",
      "anyOf": [{ "$ref": "#/$defs/BooleanConfigOptionCapabilities" }, { "type": "null" }]
    } } }
```

文档的规范性要求：

> 「Agents **MAY** include boolean config options only after the Client advertises support during initialization」
> 「Agents **MUST NOT** include `type: "boolean"` options in `configOptions` payloads unless the Client advertised support.」

**对 Neeko 的影响**：Neeko 现在 `initialize` 只发 `clientCapabilities.promptCapabilities`，**没发 `session.configOptions.boolean`**。后果不是拿不到模型（模型是 `select` 形态，无需协商），而是**拿不到 boolean 类配置**（如 Claude 的 `brave_mode`、`fast_mode` 之类）。若想完整支持配置面板，应补上。**select 形态的模型选择器完全不需要任何 capability 协商** —— 这点很重要，说明 Neeko 现在就能读到模型列表而不改握手。

### 12. v1 vs v2 差异（若未来迁移）

`docs/protocol/v2/migration.mdx` 关键条目：

| 项 | v1 | v2 |
| --- | --- | --- |
| 选项标识字段 | `id` | **`configId`** |
| `type` 判别器 | select 可缺省（默认 value_id） | 必须 `"id"` 或 `"boolean"` |
| `session/set_mode` | 存在 | **Removed**。Use `session/set_config_option` |
| 响应里的 `modes` | 存在 | **不再有** |
| `current_mode_update` 通知 | 存在 | **Removed**。Modes are config options. Use `config_option_update` |
| `session.configOptions.boolean` capability | 需要 | Marker removed（v2 无条件支持 boolean） |
| `session/new` 的 `mcpServers` | required | optional |
| `availableCommands` | — | 新增，可与 `configOptions` 同时返回 |

原文（第 761、777-779 行）：
> 「The dedicated modes API is removed: the `modes` field on session responses, `session/set_mode`, the `current_mode_update` notification, and all `SessionMode*` types. Mode-like state (and model selection, thinking level, and similar knobs) is expressed through session config options, which already existed in v1」
> 「The option's identifier field is renamed from `id` to `configId`, matching the parameter name used by `session/set_config_option`.」
> 「The stable `category` values are `mode`, `model`, `model_config`, and `thought_level`. Clients can use them for UX affordances (placement, shortcuts) and must tolerate unknown categories.」

**含义**：v1 → v2 对模型选择**语义不变**（仍是 config options），只是字段名 `id` → `configId`。Neeko 若把模型选择抽象成"读 `configOptions` 里 category=model 的项"，迁移成本仅是一个字段名映射。

---

## 各 agent 实现的支持矩阵（实测，非搜索摘要）

| Agent | 注册表版本 | 模型机制 | 证据 |
| --- | --- | --- | --- |
| **Claude** (`claude-acp`, 原 `zed-industries/claude-code-acp`) | v0.94.0 | ✅ **`configOptions`，`id: "model"`, `category: "model"`** | `src/session-model.ts:192` `buildModelConfigOption()` 返回 `{ id: MODEL_CONFIG_ID, name: "Model", description: "AI model to use", category: "model", type: "select", currentValue, options }`；另有 `_meta` 私有扩展 `AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY` |
| **Codex** (`codex-acp`) | v2.2.2 | ✅ **`configOptions`，`id: "model"`, `category: Model`；另有 `reasoning_effort` (`ThoughtLevel`)** | `src/thread.rs:2998` `SessionConfigOption::select("model", "Model", current_model, model_select_options).category(SessionConfigOptionCategory::Model).description("Choose which model Codex should use")`；`src/thread.rs:3064` `handle_set_config_option` 分派 `"mode"` / `"model"` / `"reasoning_effort"` |
| **OpenCode** | v1.19.3 | ✅ **`configOptions`，`id: "model"`, `category: "model"`；`effort` (`thought_level`)；`mode`** | `packages/cli/src/acp/config-option.ts:26-37` 直接构造 `{ id: "model", name: "Model", category: "model", type: "select", currentValue: advertisedModel(model), options: [...] }`；`name` 形如 `` `${item.providerID}/${item.name}` `` |
| **Gemini CLI** | v0.64.0（SDK 0.16.1） | ⚠️ **旧 `models` API（已废弃）**：`NewSessionResponse.models: { availableModels, currentModelId }` + `unstable_setSessionModel` | `packages/cli/src/acp/acpSessionManager.ts:168` `models: { availableModels, currentModelId }`；`acpRpcDispatcher.ts:226` `async unstable_setSessionModel(params: acp.SetSessionModelRequest)`。**无 `configOptions`** |
| **Kimi CLI** | v1.52.0（SDK 0.8.0） | ⚠️ **旧 `models` API（已废弃）**：`models=acp.schema.SessionModelState(...)` + `set_session_model` | `src/kimi_cli/acp/server.py:208-211` 与 `:292-294`；`:327` `async def set_session_model(...)`。全仓 grep `configOptions` / `SessionConfigOption` → **零命中** |
| **Qwen Code** | v0.25.3 | ✅ **`configOptions`，`configId: "model"` + `reasoning_effort`** | `packages/acp-bridge/src/session-startup-config.ts:141` `setSessionConfigOption(sessionId, { configId: 'model', value: config.serviceId })`，并**校验**响应里 `option.id === 'model'` 的 `currentValue` 确认生效 |
| **Zed（作为客户端）** | main | ✅ 消费 `configOptions` + `config_option_update` | `crates/agent_servers/src/acp.rs:333` `struct ConfigOptions { config_options: Rc<RefCell<Vec<acp_v2::SessionConfigOption>>> }`；`:647` `if let InboundSessionUpdate::ConfigOptions(update) = &notification.update` 后整体替换 |

补充观察（对设计有直接价值）：

- **OpenCode 的 value 是复合字符串**：`advertisedModel(model)` 的实测函数体是 ``return `${model.providerID}/${model.id}` ``（`config-option.ts:134-136`），即 `currentValue` 形如 `anthropic/claude-sonnet-4`。同一个协议字段，不同 agent 的字符串语义完全不同 —— Neeko **不能**假定 `currentValue` 是可拆解的 `provider/model` 格式（Claude 的 `currentValue` 可能是 `default` 这类语义别名）。
- **Qwen Code 的防御式写法值得抄**：改完之后，它从响应里回读 `option.id === 'model'` 的 `currentValue` 并**断言等于期望值**，不等则抛 `SessionStartupConfigError('startup_config_rejected')`。这验证了"响应是全量、且必须视为权威"的协议要求。
- **Claude 有 `id: "default"` 特殊值**：`buildModelConfigOption` 里 `models.find(m => m.value === "default")`，且 `Default` 选项在 allowlist 为空时仍保留。说明 `currentValue` 可能是**语义别名**而非真实模型 ID。
- **各家 `id` 字符串碰巧都是 `"model"`**，但这是惯例而非规范。Codex 的 `reasoning_effort`、Qwen 的 `reasoning_effort`、OpenCode 的 `effort` 说明**同类能力命名并不统一** —— 进一步印证必须靠 `category` 而非 `id`。

---

## 对 Neeko 设计的影响

### A. 能走 ACP 原生（已证实可行）

1. **模型发现（列表）** —— 走 `session/new` 响应的 `configOptions` 里 `category == "model"` 项的 `options`。**Claude / Codex / OpenCode / Qwen 四家实测均提供**。这是 `discover_opencode_models` 的正统替代路径。
2. **模型切换** —— 走 `session/set_config_option { sessionId, configId, value }`，之后用响应里的全量 `configOptions` 替换本地状态。
3. **当前模型显示** —— 读 `configOptions[category=="model"].currentValue`，并订阅 `config_option_update` 以捕获 agent 侧 fallback。
4. **推理档位 / 思考级别** —— 走 `category == "thought_level"` 的项（Codex `reasoning_effort`、OpenCode `effort`、Qwen `reasoning_effort` 实测均有）。
5. **模式（plan/build 等）** —— 走 `category == "mode"` 的项；v1 下 `modes` 字段也在，但官方明确说「Clients **SHOULD** use them instead of the `modes` field」。
6. **无需改协议版本、无需能力协商** —— `select` 形态的模型选择器在读的方向上零前提。当前 `ACP_PROTOCOL_VERSION = 1` 不用动。

### B. 必须走私有/兜底路径（已证实 ACP 无原生能力）

1. **「不建会话就查模型列表」** —— **协议无此能力**（第 7 节：无 `models/list`）。现状 `list_agent_models(agent_id)` 若要保持"轻量、无副作用"，要么改成"建临时会话后立即关闭"（有进程启动成本 + 可能的副作用），要么保留 agent 私有命令（如 `opencode models --verbose`）作为**快速路径**。这是**架构层面的取舍**，不是实现细节。
2. **per-turn 模型切换** —— 协议明确不支持。若产品确实要"这一轮用 A 模型、下一轮用 B"，实现方式是**发 prompt 前先 `set_config_option`**，语义等于串行会话级切换，**并发回合不可能用不同模型**。现有 `SessionRequest::Turn { model, .. }` 的字段若被保留，语义必须重定义为"本轮开始前切到这个模型"。
3. **`providerId` / context window / 价格等结构化元数据** —— `SessionConfigOption` 里**没有**这些字段。只能塞 `_meta`（各家私有，如 Claude 的 `AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY`）或从 `value`/`name` 字符串里猜。Neeko 现有 `ModelInfo`（`provider_id`、`provider_name`、`supported_reasoning_efforts`、`default_reasoning_effort`、context window）**大部分字段 ACP 给不了**。
4. **provider 级路由配置** —— 只有 unstable `providers/*`，且语义是 endpoint 不是模型。不建议接入。

#### B 的量化补充：现有 `ModelInfo` 字段 vs ACP 可得信息

`src-tauri/src/common/agent/types.rs:120-144` 的 `ModelInfo` 逐字段对照 `SessionConfigOption`：

| `ModelInfo` 字段 | ACP `SessionConfigOption` 能否提供 | 说明 |
| --- | --- | --- |
| `id: String` | ✅ `SessionConfigSelectOption.value` | 直接映射；但语义随 agent 而异（OpenCode 是 `provider/id`，Claude 可能是 `default` 别名） |
| `name: String` | ✅ `SessionConfigSelectOption.name` | 直接映射 |
| `provider_id: Option<String>` | ❌ | 协议无此字段。OpenCode 把 provider 编码进 `value`；Claude 无 provider 概念。**只能靠解析或留空** |
| `provider_name: Option<String>` | ❌ | 同上 |
| `supported_reasoning_efforts: Vec<String>` | ⚠️ 间接 | 不在 model 项里，而在**另一个** `category == "thought_level"` 的 config option 的 `options` 中。且那是**当前模型**的档位，不是每个模型各自的。需要"切换模型后重读"才能对齐 |
| `default_reasoning_effort: Option<String>` | ⚠️ 间接 | 同 `thought_level` 的 `currentValue`（只能视为当前值，不是每模型的默认值） |
| `context_window: Option<u32>` | ❌ | 协议无此字段。`model_config` category 的存在暗示 agent 可用一个 select 暴露 context size，但那仍只是一个选项值，不是结构化数字 |
| `is_free: bool` | ❌ | 协议无此字段 |

**结论**：8 个字段里只有 2 个能无损从 ACP 获得。若统一走 ACP，`ModelInfo` 必须重新设计（拆分"来自 ACP 的通用模型条目"与"来自 agent 私有的富元数据"），或把后者全部降级为 `Option::None`。**这是本次架构决策必须显式拍板的点，不应留待实现期各自发挥。**

### C. 现状代码的直接问题（供实现阶段参考，本文件不改代码）

- `src-tauri/src/agent/chat/adapter/acp.rs:471` 发 `initialize` 时只带 `promptCapabilities`，**未声明 `session.configOptions.boolean`**。模型选择不受影响，但 boolean 类配置会缺失。
- `acp.rs` 的 `session/new` 响应只用 `session_id_resp.get("sessionId")`，**完全丢弃了 `configOptions`**。这是当前拿不到模型列表的**直接技术原因**。
- `acp.rs:316` 注释的因果关系表述不准确（见第 6 节）。
- `src-tauri/src/agent/commands.rs:60` 的 `if agent_id == "opencode"` 是硬编码分派；按下方「各 agent 实现的支持矩阵」，**OpenCode 自己就实现了 `configOptions`**（`config-option.ts:26-37`），因此 ACP 路径本可覆盖它。
- `src-tauri/src/agent/chat/adapter/serve.rs` 走 `opencode serve` REST API（头部注释：「Unlike ACP, both session creation and every prompt accept an explicit model — enabling per-session model switching (upstream ACP does not)」）。**注意**：这句话在 `session/new` 层面是对的，但忽略了 `set_config_option` 这一会话级机制。`serve` 路径是否能收敛到 ACP，取决于是否需要 per-turn 切换（见 B.2）。
- 现有 `ModelInfo`（`src-tauri/src/common/agent/types.rs:120-144`，8 个字段）与 ACP `SessionConfigOption` **不匹配**：逐字段比对见 B 节末表，8 个里只有 `id`/`name` 能无损映射。这是本次设计要正面回答的问题。

### D. 兼容性分层建议（基于第 8 节的版本证据）

探测顺序应当是**能力探测**而非 agent 分支：

1. 读 `session/new` 响应的 `configOptions`，找 `category == "model"` 的项 → 走 ACP 原生（Claude / Codex / OpenCode / Qwen）。
2. 若 `configOptions` 缺失但响应里有 `models.availableModels` → 走旧 unstable API（Gemini / Kimi）。**读**：从 `session/new` 响应的 `models.availableModels` 取 `{modelId, name, description}`、`models.currentModelId` 取当前值。**写**：必须调用 `session/set_model { sessionId, modelId }`——该方法虽在规范侧已删除，但这两个 agent 的实现侧仍提供（Gemini `acpRpcDispatcher.ts:226` `unstable_setSessionModel`；Kimi `server.py:327` `set_session_model`）。属于"对接已废弃但仍在线运行的 API"的现实妥协，必须隔离在一个可删除的适配层里。
3. 两者皆无 → agent 不支持模型选择；不要报错，静默降级为"用 agent 默认模型"。
4. 保留 agent 私有命令（`opencode models --verbose`）**仅在**需要"不建会话的快速列表"时作为可选优化，不作为主路径。

---

## 已证实 vs 推测

### 已证实（一手源码/schema 直接读到）

- `NewSessionRequest` v1 无任何模型字段；`NewSessionResponse` v1 有 `configOptions`（可选）与 `modes`（可选）。
- `SessionConfigOption` 的确切 JSON 形状、`type` 判别器、select/boolean 两态、分组选项、必填字段 `["id","name"]`。
- `SessionConfigOptionCategory` 的四个具名值 + `_` 前缀自定义规则；`model_config` 于 `1.1.0`（2026-06-24）稳定（`0.10.8` 稳定面**无**该值）。
- `session/set_config_option` 请求/响应形状，响应**返回全量** `configOptions`。
- `config_option_update` 通知的线上形态与触发原因（含 model fallback）。
- `session/prompt` / `PromptRequest` 无 model 参数（v1 与 v2 均如此）。
- 四个 schema 变体的 `agentMethods` 中**无**任何 model 相关方法；无 `models/list`。
- `Session Config Options` 于 `0.10.8`（2026-02-04，PR #411）稳定；`category: "model"` 随之进入稳定面。
- 旧 unstable `models` API（`SessionModelState` / `ModelInfo` / `session/set_model`）在 `v0.12.0` 存在，在 `0.13.5`（2026-06-01，PR #1325）被删除。
- `providers/*`（unstable）语义是 LLM 路由配置（`apiType`/`baseUrl`/`headers`），非模型列表。
- v2 中 `id` → `configId` 重命名、`modes`/`session/set_mode`/`current_mode_update` 移除。
- `ClientCapabilities.session.configOptions.boolean` 只影响 boolean 选项；select 选项无需协商。
- Claude / Codex / OpenCode / Qwen Code 用 `configOptions`；Gemini CLI / Kimi CLI 用已废弃的 `models` —— 全部由各仓源码行号佐证。
- Zed 客户端整体替换 `configOptions` 的消费方式。
- **OpenCode 的模型 value 格式**：`packages/cli/src/acp/config-option.ts:134-136` 函数体为
  `function advertisedModel(model) { return `${model.providerID}/${model.id}` }` —— 即 `currentValue` 是 `providerID/modelID` 拼接串，**不是**原始 model id。
- **Gemini CLI 完全不发 `configOptions`**：全仓（所有 `.ts`，排除 node_modules）grep `configOptions|set_config_option|setSessionConfigOption` → **零命中**。确认它只走已废弃的 `models` 路径。
- **Kimi CLI 完全不发 `configOptions`**：全仓（所有语言）grep `configOptions|config_option|SessionConfigOption` → 仅命中 2 个 CLI 参数名的无关 e2e 测试；`src/kimi_cli/acp/` 内零命中。确认它只走已废弃的 `models` 路径。

### 推测 / 需实现期验证

- **【推测】** 「业界通行 workaround」。我**没有**找到一份权威文档总结 workaround。以下均为一手观察到的事实归纳，**不是**某份规范的推荐：① 用 `configOptions`（多数现代 agent）；② 钉旧 SDK 继续用 `models`/`session/set_model`（Gemini、Kimi）；③ 客户端直接执行 agent 私有 CLI 子命令（如 Neeko 的 `opencode models --verbose`）；④ 绕过 ACP 用 agent 自己的 HTTP API（如 `opencode serve` + `POST /session/{id}/prompt_async` 带 `model` 字段）。
- **【推测】** ACP 未来是否会给 `session/prompt` 加 per-turn 模型覆盖。CHANGELOG 中未见相关 RFD；按协议"只在破坏性变更时 bump 版本"的原则与 v2 已明确"模型是 config option"的定调，短期（v2 周期内）**不会**加。若产品强依赖 per-turn 切换，应保留 `serve` 路径。
- **【推测】** 各 agent 对 `config_option_update` 的 model fallback 实现完整度。协议允许但各家实现程度未知；Neeko 应容错（收到就更新，收不到也不崩）。
