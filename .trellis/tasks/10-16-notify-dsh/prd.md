# DSH 通知接入（源 A 桥投影，非 hook）

> 子任务，父任务 `10-16-agent-notify-more-clis`（P4）。
> 跨子任务契约见父任务 `design.md`（T6–T10）。**与 hook 线正交，可并行。**
>
> **注意**：本任务**不写 hook**、**不碰 `agent/hooks/`**、**不加 `HookTarget`**。
> DSH 走源 A（进程内事件流）的投影腿。

## Goal

DSH（DeepSeek Harness）的「需要注意」事件能触达系统通知。

**为什么 DSH 不是 hook 问题**（父任务 T6 推论 1）：

| 事实 | 证据 |
| --- | --- |
| DSH 无 out-of-process hook 面 | 它是 cordis 插件体系（`~/.dsh/profiles/<name>/` 的 patch layer），插件跑在**进程内** |
| 已有进程内桥 | `packages/dsh-neeko` 已把 DSH 事件归一为 `approval.request` / `question.request` / `tool.start` / `tool.end`，经 `127.0.0.1:3081` WebSocket 送出 |
| 该桥在 Neeko 内**零引用** | 全仓 grep `dsh-neeko` 仅命中其自身目录 |
| `ChatStart::Jsonl` 无使用者 | `DeepSeekHarnessAdapter` 存在，但 `builtin_configs()` 里**没有任何** `AgentConfig` 用 `ChatStart::Jsonl` |

**结论**：DSH 的接入问题不是「怎么感知」，而是「**感知到的事件往哪里去**」——
即消费侧归属未定案。这是本任务的 Step 0。

## Requirements

### R1 消费侧归属（U7，Step 0 定案）

- R1.1 必须先回答：DSH 事件流由**谁**消费？候选：

  | 候选 | 形态 | 评价 |
  | --- | --- | --- |
  | **A. 新 `AgentAdapter`（`ChatStart::Serve`/`Jsonl` 变体）** | DSH 作为 Neeko 的一等 Agent，会话在 Neeko 内 | 最符合既有架构（`adapter_for` 的 match）；但需实现完整 adapter（create/next/send/cancel） |
  | **B. 独立监听器（消费 `:3081` WebSocket）** | 旁路监听，不进 `AgentChatManager` | 轻量，但引入第二条「会话来源」路径，与源 A 的「adapter 归一」前提冲突 |
  | **C. 不实施** | 登记理由 | 若 A/B 成本都超范围则选此项（R5.3 父任务） |

- R1.2 **倾向 A**：`adapter_for` 已是「按 `config.chat` 数据分派」的形态（`ChatStart` enum
  + match），新增 DSH 的 `AgentConfig` + 适配器 = 加数据 + 加一个 adapter 文件，
  完全符合开闭。B 会让「源 A = 进程内 adapter 归一」这个前提失效，代价更大。
- R1.3 若选 A，须明确 DSH 的 `AgentConfig` 是**新增**还是复用现有 `ChatStart::Jsonl`
  （后者已有 `DeepSeekHarnessAdapter`，可能已足够）。
- R1.4 定案必须有证据（读 `dsh-neeko` 的协议文档 + 尝试一次真实连接），不猜。

### R2 事件 → 通知信号投影

- R2.1 DSH 事件映射（`dsh-neeko` 的协议事件名 → 语义）：

  | dsh-neeko 事件 | 语义 event_key | 备注 |
  | --- | --- | --- |
  | `approval.request` | `approval_requested` | 主路径（ActionRequired） |
  | `question.request` | `input_requested` | ActionRequired |
  | `tool.end`（含 `status: 'failed'`） | —（或 `session_failed`） | 单工具失败 ≠ 会话失败，倾向不映射 |
  | 会话结束 / 错误 | `turn_completed` / `session_failed` | 需确认 dsh-neeko 是否送此类事件 |

- R2.2 **投影落点**：若走候选 A（adapter），则 DSH 事件先归一为 `StreamEvent`，
  再由既有 `agent/chat/notify.rs::project` 自动覆盖 —— **零新增投影代码**（源 A 的既有收益）。
  这是候选 A 相对 B 的决定性优势（父任务 AC3 的「无重复实现」精神）。
- R2.3 若走候选 B，则需在 DSH 自己的域内写投影（`agent/dsh/notify.rs`），
  与 `agent/chat/notify.rs` 同形但不共用 —— **这是 B 的代价，必须在 design 里记账**。
- R2.4 **不得触碰 `agent/hooks/`**（R3.3：不引入第四样契约面）。

### R3 与 hook 线零耦合

- R3.1 不新增 `HookTarget`、不写模板、不加 ingest 路由。
- R3.2 复用 `notification/` 门面（`NotificationCenter::observe`）与
  `agent/chat/notify.rs::SessionNotifyContext`（若走 A）。
- R3.3 若发现 DSH 需要 `agent/hooks/` 的任何改动 → **说明拓扑判断有误**，
  停止并回父任务 design.md（父任务 AC2）。

### R4 归属与回流

- R4.1 DSH 会话的 `instance_id` = Neeko 会话 id（若走 A）——
  与源 A 完全一致，回流（deep link）自动可用。
- R4.2 主题（`topic`）：DSH 会话的原生标题（`dsh-neeko` 的 `session.init` 是否带标题？
  Step 0 确认）；无则走既有降级链（首轮 prompt → 无主题）。
- R4.3 归属不得依赖 `attribution.rs`（那是源 B 的降级链，DSH 有完整上下文，不需要降级）。

## Acceptance Criteria

- [ ] **AC1 消费侧归属定案**：`research/dsh-consumption-decision.md` 记录
  A/B/C 三候选的评估与最终选择（含证据：`dsh-neeko` 协议文档引用 +
  一次真实连接/日志观察），并回填 `design.md`。
- [ ] **AC2 DSH 事件 → 通知信号**：至少 `approval.request` 与 `question.request`
  能投影为 `NotificationSignal`（单测：给定 dsh-neeko 事件载荷 → 期望的信号）。
- [ ] **AC3 与 hook 线零耦合**：`git diff` 中 `src-tauri/src/agent/hooks/**` 为空。
- [ ] **AC4 核心域零改动**：`src-tauri/src/notification/**` 无 diff。
- [ ] **AC5 实测**：DSH 会话触发审批/提问 → Neeko 失焦时收到系统通知。
- [ ] **AC6 既有行为不变**：`pnpm check` 全绿。

## Step 0 Spike（阻塞，必须先做）

- [ ] **U7 消费侧归属**：
      1. 读 `packages/dsh-neeko/docs/dsh-neeko-integration.md` 的协议章节
         （事件清单、握手、`session.init`、健康探针）。
      2. 确认 `:3081` 的启动条件（`dsh --profile neeko` 是否自动起？还是需 daemon 模式？）。
      3. 尝试一次真实连接（起 `dsh --profile neeko` → 观察 `:3081` 是否可达）。
      4. 检查 `dsh-neeko` 是否送「会话结束 / 错误」类事件（决定 R2.1 后两行）。
      5. 检查 `session.init` 是否带会话标题（决定 R4.2）。
      6. 定案 A/B/C。
- [ ] 结论写入 `research/dsh-consumption-decision.md`，回填 `prd.md` R1.1 / R2.1 / R4.2。

## 明确不在本任务范围

- OMP / Claude / CodeBuddy / Qoder（`10-16-notify-claude-compat`）。
- Codex（`10-16-notify-codex`）。
- `dsh-neeko` 包本身的改动（它是独立发布的 npm 包，不纳入本地/CI 门禁，
  见根 `AGENTS.md` 的「门禁豁免」）—— 若发现必须改它，须另立任务并走其 `prepublishOnly` 门禁。
- DSH 的 Web UI / ACP 形态（`~/.dsh/profiles/` 下还有 `web` / `cc-tui` / `pi-tui` 等 profile）。
