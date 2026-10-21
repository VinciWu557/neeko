# 统一 ACP 模型发现与选择

## Goal

把「列出可用模型 → 用户选择 → 下发到会话」这条链路收敛到 **ACP 协议层**，让 opencode / pi / omp / codex / claude-code 等 agent 走同一套机制，而不是为每个 agent 写一条特判。

目标状态：

- **ACP 原生支持模型选择** → 直接用协议字段，零私有逻辑；
- **ACP 未提供模型列表** → 通过该 agent 自己的「列模型」命令获取，命令在设置页可配置；
- **后端不存在任何 `if agent_id == "..."` 的模型分派**。

## 现状问题（第一性原理）

### P1 分派靠字符串，违背开闭原则

`src-tauri/src/agent/commands.rs:56`：

```rust
if agent_id == "opencode" {
    return crate::agent::model_discovery::discover_opencode_models(None).await;
}
Ok(Vec::new())
```

- 新增一个支持模型的 agent 必须回头改这个 `if`；
- 仓库里已有正确范式却没用：`adapter_for` 按 `ChatStart` 类型分派，`AgentAdapter` 用默认方法 + 各适配器 opt-in（OCP）。本命令两样都没用。

### P2 「不能选模型」与「列出失败」不可区分

`Vec<ModelInfo>` 的空数组同时表示三种情况：

| 实际情况 | 前端看到 |
| --- | --- |
| agent 不支持模型选择 | `[]` |
| 支持但命令执行失败 | `[]` |
| 正在加载 | `[]` |

导致 UI 无法给出正确措辞，用户看到的是永久禁用的「No models」。

### P3 ACP 适配器完全没处理模型

`acp.rs` 只有 `initialize` → `session/new` → `session/prompt` 的最小握手，代码注释（acp.rs:316）声明：

```rust
// ACP has no per-turn model selection (upstream limitation); the field is ignored here.
```

该结论**待研究核实**（见 `research/acp-model-selection.md`）：若 ACP 实际已有模型字段，则应直接使用而非绕过。

### P4 ACP 启动参数不可配置

`ChatStart` 序列化为裸字符串（`"acp"`），`Acp { args }` 的 `args` **不持久化**：

```rust
// "acp" 及未知值 → Acp（args 由内置定义提供，用户配置不持久化 args）
_ => Self::Acp { args: Vec::new() },
```

因此「给任意 agent 配一行 ACP 启动命令」目前做不到 —— 只有内置定义里写死的那些能启动。

## Requirements

### R1 ACP 成为一等入口

- 设置页 Agent 配置支持声明 `chat: acp`，并可填写**启动命令 + 参数**（当前 args 不可持久化，需一并解决）。
- 目标 agent：opencode、pi、omp、codex、claude-code（后者按各自 ACP 支持情况接入）。

### R2 模型能力判定归协议层

- 能力判定**不得**按 agent id 特判，必须依据协议/配置数据。
- 判定结果需能区分：`supported` / `unsupported` / `error`，供 UI 正确措辞。

### R2b 模型相关配置项（`model_config`）

- `context_window` / 推理档位这类信息**不是模型条目属性**，而是 ACP `category: "model_config"` 的配置项。
- 必须按规范 SHOULD 渲染在**模型选择器附近**（同一 popover），不得拼进模型名文本。
- 每个配置项按其 `type` 渲染（`select` 下拉 / `boolean` 开关）；无配置项时该区域不渲染。
- 需在 `initialize` 中声明 `session.configOptions.boolean` 能力，否则 agent 不会下发开关类配置。

### R3 模型列表来源二级策略

| 优先级 | 来源 | 条件 |
| --- | --- | --- |
| 1 | ACP 原生模型字段 | 协议提供且 agent 实现了 |
| 2 | agent 私有「列模型」命令 | 设置页配置的命令模板 |

两条路径的产物必须收敛为同一数据结构（`ModelInfo`），下游不感知来源。

### R4 选择结果必须真正生效

**这是本任务最容易做错的一点。** 现状：`model_id` 只被 `ServeAdapter` 消费（拆 `provider/model` 发 HTTP），`AcpAdapter` 完全忽略。

- 若 ACP 有模型字段 → 在正确的方法（`session/new` 或专用 set 方法）里下发；
- 若无 → 必须明确「该 agent 的模型选择通过什么方式生效」，不能只显示下拉而实际无效。

**「显示了但不起作用」比「不显示」更糟** —— 这一条是验收硬项。

### R5 前端不感知传输差异

- 前端的模型选择控件对全部 agent 一致呈现（用户明确要求：其他 agent 也需要显示，不做 `serve`/`acp` 分档）。
- 「此 agent 不支持选模型」与「列表加载失败」在 UI 上**措辞不同**：前者说明原因，后者可重试。

## Non-Goals

- 不做手动输入模型 ID（用户已否决）。
- 不托管模型配置（模型清单由 agent 自身拥有，Neeko 只做发现与传递）。

## Acceptance Criteria

- [x] AC1 `list_agent_models` 不再出现任何 `agent_id == "..."` 字符串分派
- [x] AC2 模型能力由协议/配置数据判定，新增 agent 无需改动命令层
- [x] AC3 设置页可为 agent 配置 ACP 启动命令与参数，重启后保留
- [x] AC4 模型列表可区分 `unsupported` / `error` / 正常，前端措辞相应不同
- [x] AC5 选择的模型在会话中**真实生效**（对至少一个 ACP agent 端到端验证）
- [x] AC6 opencode 现有行为不回退（既有测试全绿）
- [x] AC7 全部 agent 的模型控件呈现一致，不因传输协议隐藏
- [x] AC8 `context_window` / 推理档位等信息由 `model_config` 配置项承载，不丢失且不拼进模型名
- [x] AC9 `model_config` 按 `type` 正确渲染（select / boolean），无配置项时不渲染空控件
- [x] AC10 `initialize` 声明 boolean config option 能力

## Open Questions

- ~~OQ1 ACP 协议是否已有模型字段？~~ **已解决**：有，是 `category: "model"` 的 config option；模型相关参数用 `category: "model_config"`。见 `research/acp-model-selection.md`。
- ~~OQ2 各目标 agent 的列模型命令~~ **结论修正**：`configOptions` 存在但**只在会话内**。
  用户打开 Chat 尚未发消息时没有会话，此时只能靠 agent 自己的命令。
  已落地为 `AgentConfig.model_list_args`（opencode `models --verbose`、pi `--list-models`）；
  **与 chat 能力无关**，`chat: None` 的 agent 也能有。
- ~~OQ3 `ChatStart` 序列化演进~~ **已解决**：裸字符串（旧）与 `{transport,args}`（新）双形态，写时无参数写字符串；见 `common/agent/types.rs` 的 `chat_start_serde_tests`。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
