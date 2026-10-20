# ACP 会话配置项与模型选择

> 本文记录 **Agent Client Protocol（ACP）里「模型」这件事的正统做法**，以及 Neeko 的
> 对应实现。协议证据与各 agent 实测见
> `.trellis/tasks/10-20-unify-acp-model-selection/research/acp-model-selection.md`。

## 1. Scope / Trigger

- **Trigger**：改 `src-tauri/src/agent/chat/adapter/acp_config.rs`、`acp.rs` 的握手/通知，
  `agent/commands.rs::list_agent_models`，或前端模型选择器（`ModelPicker` /
  `ModelConfigSection` / `useAgentModels`）。
- **前提认知**：ACP **没有** `models` 字段，也**没有**独立「列模型」方法。全部信息在
  会话级 `configOptions` 里。

## 2. 协议形状

`session/new` 响应的 `configOptions` 是一个数组，每项：

```jsonc
{
  "id": "model",              // 写请求的 configId；命名无约束
  "name": "Model",
  "category": "model",        // 语义分类，可选，**不得据以判正确性**
  "type": "select",           // "select" | "boolean"；select 下可缺省
  "currentValue": "a",        // select 是 string，boolean 是 bool
  "options": [ /* 扁平或分组 */ ]
}
```

| category | 语义 | Neeko 落点 |
| --- | --- | --- |
| `model` | 模型选择器 | `ModelInfo{id,name,description?}` |
| `model_config` | 模型相关参数（上下文大小、速质取舍） | `ModelConfigSection` 的独立控件 |
| `thought_level` | 推理档位（`model_config` 的历史特例） | 同上（同区渲染） |
| `mode` | 会话模式 | **本仓不实现** |

写：`session/set_config_option { sessionId, configId, value }`，响应**返回全量**。
读变更：`session/update` 且 `sessionUpdate == "config_option_update"`，**同为全量**。

## 3. 五条硬约束

### 3.1 定位靠 `category`，`id` 只作兜底

规范原文：`category` 「MUST NOT be required for correctness」，客户端须能容忍缺失与未知值。

实测各家 `id` 碰巧都是 `"model"`，但同类能力命名并不统一（Codex `reasoning_effort`、
OpenCode `effort`）。因此 `find_model_option` 的顺序是：

1. `category == "model"`
2. `id == "model"`（兜底）
3. `None` → 视为不支持，**静默降级不报错**

三条路径各有测试，缺一条就等于允许回潮。

### 3.2 解析失败必须降级，不能中断会话

`parse_config_options` **不返回 Result**：Gemini / Kimi 实测根本不发该字段，缺失是
正常情况。返回 `Result` 会诱使调用方用 `?`，于是一次可选能力的缺失把整个会话建不起来。

### 3.3 全量替换，不做局部 patch

`session/set_config_option` 的响应与 `config_option_update` 通知都携带**完整**配置。
换模型可能连带改变 `thought_level` 的可选项 —— 局部合并会留下与真实状态不符的陈旧项。

前端对应实现：`useSessionConfigOptions.replace()` 直接 `setOptions(next)`。

### 3.4 模型切换必须发生在 prompt **之前**

`session/prompt` 没有 model 参数（v1/v2 均如此）。所以「本轮换模型」= 先
`set_config_option`，再 `session/prompt`。

`request_to_jsonrpc` 因此返回 `Vec<Value>` 而非单帧 —— 返回单帧的实现只能二选一：
静默丢模型（旧行为），或把 prompt 发在切换之前（模型不生效）。顺序有测试锁死
（`turn_with_model_sets_config_before_prompt`）。

### 3.5 boolean 形态需要能力协商

规范强制：agent **MUST NOT** 下发 `type: "boolean"`，除非客户端在 `initialize` 里声明过。
声明位置：`clientCapabilities.session.configOptions.boolean = {}`。

不声明不会影响模型选择（它是 select 形态），但 `model_config` 里的开关类参数会整批消失，
表现为「本来就不该有」。

## 4. `ModelInfo` 只有三个字段

```rust
pub struct ModelInfo { id, name, description? }
```

与 ACP `SessionConfigSelectOption` 一一对应。

**`id` 语义不透明**：OpenCode 用 `provider/model` 复合串，Claude 可能是 `default` 这类别名。
不解析、不拆分、不假设格式。

历史教训：这里曾有 `provider_id` / `provider_name` / `context_window` /
`supported_reasoning_efforts` / `default_reasoning_effort` / `is_free` —— 全部由 opencode
私有 NDJSON 解析而来。把它们放在通用类型里等于**把单个 agent 的私有能力伪装成通用契约**，
其他 agent 只能填 `None`。它们现在的正当归属是 `model_config` / `thought_level` 配置项。

## 5. `list_agent_models` 的三种结果

```rust
pub enum ModelCatalogResult { Available { models }, SessionScoped, Unsupported }
```

| 结果 | 含义 | UI 措辞 |
| --- | --- | --- |
| `Available` | 有独立目录（opencode `models --verbose` 快速路径） | 正常列出 |
| `SessionScoped` | 支持模型选择，但列表只能在会话内取（ACP） | `Available inside a session` |
| `Unsupported` | 不支持模型选择 | `This agent has no model selection` |

第四种（IPC 失败）由 `useAgentModels` 合成 `error` 状态 —— 失败必须可见，静默降级会让
「后端报错」看起来像「这个 agent 本来就没有模型」。

**禁止按 agent id 分派**。能力挂在 `ChatStart` 上：`adapter_for` 已按类型分派，
`AgentAdapter::supports_model_selection` / `model_catalog` 默认关闭、各适配器 opt-in。
护栏：`tests/unit/agent_model_dispatch_test.rs` 读源码断言函数体内无 `agent_id ==`。

## 6. 常见错误

| 错误 | 后果 |
| --- | --- |
| 按 `id == "model"` 定位 | 换一家 agent 就失效（规范无此约束） |
| `parse_config_options` 返回 Result 并用 `?` | 老 agent 缺字段 → 会话建不起来 |
| 局部更新 configOptions | 换模型后档位选项陈旧 |
| 把 model_id 塞进 prompt 参数 | ACP 无此字段，静默忽略 |
| 不声明 boolean 能力 | 开关类 `model_config` 整批消失 |
| 把 `provider` / `context_window` 放回 `ModelInfo` | 私有能力伪装成通用契约 |
| `list_agent_models` 里写 `if agent_id == ...` | 新增 agent 必须回头改，违背 OCP |

## 7. 测试清单

| 位置 | 覆盖 |
| --- | --- |
| `acp_config.rs` mod tests | category/id 三级定位、分组展平、缺失与畸形降级、`type` 缺省、请求体两种形态 |
| `acp.rs` tests | 先切模型后 prompt、无模型只发 prompt、`SetConfigOption` 单帧 |
| `tests/unit/agent_model_dispatch_test.rs` | 静态护栏：无 agent_id 分派、能力取自适配器 |
| `useAgentModels.test.ts` | 四种状态、`reload`、竞态丢弃 |
| `ModelConfigSection.test.tsx` | select/boolean 渲染、空不渲染、按 category 筛选 |
| `EditorPanel` / `modelPlaceholder.test.ts` | 四种措辞互不相同 |
