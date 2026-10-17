# Agent 系统通知扩展（Codex/Claude/OMP/DSH/CodeBuddy/Qoder）

> 父任务。持有源需求集、子任务地图、跨子任务验收标准与最终集成评审。
> **本身不实施代码**（无直接实现工作）—— 实施落在三个子任务。
>
> 前置：`10-12-agent-notify`（Pi/Opencode 先行）已实施并合入 main：
> notification 核心域 + agent/hooks 源 B 全链路（targets / endpoint / attribution /
> notify / server / writers）+ 前端设置页。本任务是它的**续作**。

## Goal

把「Agent 需要注意」的系统通知从 Pi/Opencode 扩展到本机其余 6 个 Agent CLI。

用户原始需求原文：**「实现 Codex、Claude、Omp、Dsh、Codebuddy、Qoder Agent 系统通知」**。

剥掉 CLI 名字后（见 design.md T6），这 6 个不是 6 份同类工作，而是 **3 种物理拓扑**：

| 拓扑 | CLI | 子任务 |
| --- | --- | --- |
| 复用既有 extension 模板（同 pi 族） | OMP | `10-16-notify-claude-compat`（P1） |
| CLI 提供进程外 hook，配置面为**结构化合并** | Claude Code、CodeBuddy、Qoder | `10-16-notify-claude-compat`（P2） |
| 同上但带**信任门 + 第二配置文件（TOML）** | Codex | `10-16-notify-codex` |
| **不是 hook 问题**：已有进程内桥，走源 A 投影 | DSH | `10-16-notify-dsh` |

## 子任务地图

| 子任务 | 交付物 | 依赖顺序 |
| --- | --- | --- |
| `10-16-notify-claude-compat` | OMP 一行数据接入 + 共享 stdin shim + JSON 结构化合并器（`InstallShape::Structured` 契约升级） | **首个**（无前置） |
| `10-16-notify-codex` | Codex hook 接入（JSON 合并 + `[hooks.state]` 信任哈希写入或 UX 引导） | 复用 claude-compat 产出的 shim 与合并器骨架；需先 spike 信任哈希格式 |
| `10-16-notify-dsh` | DSH 事件消费与通知投影（源 A 同族，不写 hook） | 与 hook 线**正交**，可并行；需先定消费侧归属 |

## Requirements

### R1 范围与拓扑（父任务层）

- R1.1 6 个 CLI 全部纳入，但**按拓扑分期实施**，不按 CLI 名字逐个实现。
- R1.2 复用既有管线：`notification/` 核心域（裁决/节流/合并/三层开关/投递/回流）与
  `agent/hooks` 的 ingest（token / 路由白名单 / fail-open）、归属降级链、event_key 命名空间
  **零改动**。新 CLI 只允许贡献**数据**（事实表行）与**该 CLI 自己的适配单元**。
- R1.3 不新增 Tauri 自定义事件名（红线 5）；hook 出站是 HTTP，不经事件通道。
- R1.4 不新增存储文件；设置继续落 `~/.neeko/config.json`。

### R2 配置面客人义务升级（跨子任务核心契约）

- R2.1 既有 `writers` 的客人义务只覆盖「独立文件即插拔」形态（opencode / pi）。
  Claude / CodeBuddy / Qoder / Codex 的 hook 面在**用户既有配置**里，必须新增
  `InstallShape::Structured` 形态，但**不得降级既有不变量**。
- R2.2 **他人条目逐字保留**：同事件下 orca / clawd / superset 等他人 hook 条目不受任何影响。
- R2.3 **fail-safe**：用户配置无法解析（非 JSON 对象 / `hooks` 非对象 / 事件值非数组）时
  **拒绝处理并原样保留**，绝不重写、绝不清空。
- R2.4 **幂等 + 收敛**：重复安装不累积条目（收敛到恰好一条自家条目）；
  移除后空数组删键不留空壳。
- R2.5 **权限继承**：改写用户配置文件时保留原文件权限（`~/.claude/settings.json` 等可能非 0644）。
- R2.6 **逐 CLI opt-in**：Claude / CodeBuddy / Qoder / Codex 的接入默认关闭，按 CLI 显式开启
  （现有单一 `cliHooks: boolean` 不足以表达；需升级为按 source 的开关数据）。
- R2.7 **卸载可逆**：关闭开关后用户配置回到开启前的语义状态（自家条目移除，他人条目原样）。

### R3 上报通道（跨子任务核心契约）

- R3.1 统一走 **`command` 型 hook + 一个稳定路径的 stdin shim**，
  **不用 `http` 型 hook**（理由：URL 是静态字符串，无法表达 v5 多实例的随机端口坐标，
  见 design.md T8）。
- R3.2 shim 的语义 event_key 由 **argv 传入**，shim 内**零 per-CLI 事件名知识**；
  `(CLI 原生事件名 → event_key)` 映射全部落在 Rust 数据（`HookEntry`）。
- R3.3 shim 硬约束：**永远 exit 0**、800ms 超时、一切异常吞掉、坐标每次上报重扫目录
  （与既有 pi/opencode 模板同口径，R6.2 fail-open）。
- R3.4 shim 与 Rust 的契约面**只有三样**（endpoint 文件格式 / `POST /hook/{source}` /
  envelope JSON 白名单），不引入第四样。

### R4 语义事件覆盖（每 CLI 至少）

- R4.1 等待审批（`approval_requested`，ActionRequired）
- R4.2 等待输入（`input_requested`，ActionRequired）
- R4.3 轮次完成（`turn_completed`，Completed）
- R4.4 会话异常（`session_failed`，Failed）—— 注：现有 `agent/hooks/notify.rs::classify`
  **未含此键**，需补 arm（属子任务实施内容）。

### R5 子任务独立性

- R5.1 每个子任务必须能独立规划、实施、检查、归档。
- R5.2 子任务间的前后依赖写在各自 `prd.md` / `implement.md`，不依赖父任务状态。
- R5.3 允许子任务因实测结论**缩小或否决**范围（如 Codex 信任门无法自动化 → 降级为 UX 引导；
  DSH 若无可用消费点 → 登记不实施），但必须在子任务内给出证据。

## Acceptance Criteria（跨子任务 / 父任务持有）

- [ ] AC1（父）**核心域零改动自证**：本任务全部实施完成后，
  `src-tauri/src/notification/**` 的 diff 为空；护栏 `check_notification_core_direction` 全绿。
- [ ] AC2（父）**拓扑分类正确性**：三个子任务各自证明了所属拓扑判断
  （claude-compat = 独立 shim + 结构化合并；codex = TOML + 信任门；dsh = 源 A 投影）。
- [ ] AC3（父）**无重复实现**：Claude/CodeBuddy/Qoder 三源共享**同一份** shim 模板与
  **同一张** `HookEntry` 表（测试钉死：新增第四个 Claude 兼容 fork 只需加一行 `HookTarget`）。
- [ ] AC4（父）**跨子任务回归**：全部子任务落地后，Pi/Opencode（既有）通知**行为不变** ——
  `pnpm test:rust` 中 agent-hooks 与 notification 全部测试通过。
- [ ] AC5（父）**最终集成评审**：三个子任务归档后，确认
  ① 用户配置面在开关开/关两种状态下均无他人条目丢失；
  ② 设置页能正确呈现每个 CLI 的安装状态与版本新鲜度；
  ③ 交付物清单与 design.md 的落点表一致（无未登记文件）。

### 子任务 AC 索引（详版在各子任务 prd.md）

- `10-16-notify-claude-compat`：AC1 OMP 复用 pi 模板；AC2 shim 单份三源共用；
  AC3 结构化合并 4 条不变量（他人保留 / fail-safe / 幂等收敛 / 权限继承）；
  AC4 逐 CLI opt-in；AC5 三平台实测通知落地。
- `10-16-notify-codex`：AC1 通道正确性（走 `notify` 而非 `hooks.json`，不写信任哈希）；
  AC2 Codex 「任务完成」通知实际触发（**能力边界内**：`notify` 无审批事件，故仅此一类）；
  AC3 无 node 时降级不破坏；AC4 用户 TOML 逐字不变（`notify` 之外）。
- `10-16-notify-dsh`：AC1 消费侧归属定案；AC2 DSH 事件 → 通知信号投影；
  AC3 与 hook 线零耦合（不引入第四样契约面）。

## 明确不在本任务范围

- WSL / SSH 远端 agent 的 hook 回调可达性（`10-12` 的 E5 / Phase B2，未实施）。
- 通知通道扩展（声音 / Webhook / 免打扰时段）—— `10-12` 的 E2/E3/E8。
- 除这 6 个之外的 CLI（如 Gemini / Grok / Reasonix）—— 拓扑同 claude-compat 时后续可加行。
- Codex 的 `Interrupt` 事件语义（是否为「用户主动取消」需实测；若无法区分则映射到
  `session_failed` 或干脆不映射，由子任务决定并记录）。
