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

> 状态核验：2026-10-27（归档前逐条取证，**不抄子任务自述**）。
> 分级口径 —— `[x]` = 判据成立且可复现；`[x]⚠` = 字面判据未成立但意图达成，
> 偏差已登记；`[~]` = 部分达成，缺口在下方明列。**归档 ≠ 全绿。**

- [x]⚠ **AC1（父）核心域零改动自证** —— **字面判据不成立，须按真实情况理解。**
  - 意图（「hook 接入不得改动通知核心域逻辑」）**成立**：三个子任务自身实施提交里
    `notification/**` 的逻辑改动为 **0**。唯一一条是 `a86aa437` 改 `types.rs` 的一行
    **文档注释**（失效指针改指 spec），子任务 AC8 已按 ⚠ 登记。
  - 字面（「diff 为空」）**不成立**：区间 `2719c4e6..HEAD` 下 `notification/**` 实际有
    **6 文件 / +363 −41**。来源是 2026-10-26 的三个提交 `fe32a33b`（文案英文化）、
    `dc816d21`（macOS 点击回流）、`c021a954`（agent 通知只走系统通知，删 in-app 通道）。
    **这三个提交不属于本父任务的任何子任务** —— `git show --name-only` 实测各自
    触碰 `.trellis/tasks/` 的次数为 **0**，是并行的独立工作。
  - 护栏 `check_notification_core_direction`：**全绿**（scan 7 个 `.rs` / 违规 0）。
    分层方向未被破坏 —— 这才是 AC1 真正要防的东西。
- [x]⚠ **AC2（父）拓扑分类正确性** —— 两正确、一**翻转**。
  - claude-compat ✅ `research/cli-hook-spike.md`：独立 shim + 结构化合并，成立。
  - codex ✅ `research/codex-trust-spike.md`：TOML 文本级改写 + 信任门，成立。
  - dsh ❌→✅ **原判断错误**：本 prd 原文写「dsh = 源 A 投影」，实际交付是**源 B 上报**
    （`shapes: &[]` 自供源，上报端在 `packages/dsh-neeko`）。修正有完整证据链：
    子任务 `prd.md`「修订史」+ `research/dsh-consumption-decision.md`。
    归纳成一句：**「DSH 没有 hook 配置面」≠「DSH 不能上报」** —— cordis 插件是任意
    Node 代码，`fetch()` 天然可用。父任务当初把这两件事混为一谈。
- [x] **AC3（父）无重复实现** —— 成立，且比要求更强：
  `claude_compat_sources_share_one_entries_table` + `claude_compat_sources_share_one_shim_template`
  用 `std::ptr::eq` 断言**同一常量指针**（比「文本相等」强 —— 文本相等仍可能是两份拷贝）。
  共享方实际是 **4 个** `HookTarget`（claude / codebuddy / qoder / codex），不是 3 个。
- [x] **AC4（父）跨子任务回归** —— 成立：`cargo test --manifest-path src-tauri/Cargo.toml --lib`
  **2247 passed / 5 ignored**（含 `notification` 42 条 + `agent::hooks` 163 条）。
  Pi / Opencode 既有分支零改动（`Standalone` 分支 diff 为空）。
- [~] **AC5（父）最终集成评审** —— 5 小项中 3 项成立、2 项有缺口：
  - [x] ① 开状态下他人条目逐字保留 —— `insert_preserves_foreign_entries_verbatim`
  - [x] ② 关状态下自家移除、他人原样 —— `remove_only_ours_and_prunes_empty_event`
  - [x] ③ 设置页安装状态与版本新鲜度 —— `versionCurrent` 双端镜像（`types/notification.ts`
        + `CliHooksSection.tsx` 的 `(outdated)` 渲染）
  - [ ] ④ **交付物清单与 `design.md` §2.2 落点表一致 —— 不成立（落点漂移）**。
        `a86aa437` 把 hooks 域按「失败策略」重构后，§2.2 列的 6 个路径全部失效：
        `targets.rs`→`targets/`、`merger.rs`→`install/config/json.rs`、
        `notify.rs`→`ingest/report.rs`、`server.rs`→`ingest/server.rs`、
        `toml_merger.rs`→`install/config/toml.rs`、`platform/hook_command.rs` **未新建**
        （shim 命令渲染并入 `install/shim/`）。**计划文档未随重构更新，属登记缺口。**
        映射关系以本节为准；`design.md` §2.2 保持原样（历史留痕），不追改。
  - [ ] ⑤ **`10-12-agent-notify` 既有验收未被破坏 —— 部分不成立**。
        系统通知链路仍工作（2247 测试全绿），**但** `c021a954` 删掉了 10-12 交付的
        **in-app 通知通道**（status-bar 列表 / toast / `inApp` 设置键）。该变更属
        2026-10-26 的独立工作，不在本父任务范围；登记在此是因为它改变了 10-12 的
        已交付行为面。铃铛本身保留（仍承载应用自身操作反馈）。
- [x] **AC6（父，补登）父任务 `children` 数组卫生** —— `10-16-notify-review-remediation`
  自首个提交 `2719c4e6` 起就在 `children` 里，但**从未被创建过**（`git log --all`
  查找其目录创建记录为空）。`10-16-notify-dsh/design.md` §7 还引用它「需同步审查清单」。
  归档时已从 `children` 移除，理由记在此处 —— 悬空引用会让 `task.py` 反复解析
  不存在的目录。

### 子任务 AC 索引（详版在各子任务 prd.md）

- `10-16-notify-claude-compat`：AC1 OMP 复用 pi 模板；AC2 shim 单份三源共用；
  AC3 结构化合并 4 条不变量（他人保留 / fail-safe / 幂等收敛 / 权限继承）；
  AC4 逐 CLI opt-in；AC5 三平台实测通知落地。
- `10-16-notify-codex`：AC1 通道正确性（走 `notify` 而非 `hooks.json`，不写信任哈希）；
  AC2 Codex 「任务完成」通知实际触发（**能力边界内**：`notify` 无审批事件，故仅此一类）；
  AC3 无 node 时降级不破坏；AC4 用户 TOML 逐字不变（`notify` 之外）。
- `10-16-notify-dsh`：AC1 消费侧归属定案（**结论：源 B，非原设想的源 A**）；
  AC2 DSH 事件 → 通知信号投影；AC3 与 hook 线零耦合（不引入第四样契约面）。

## 归档结论（2026-10-27）

三个子任务 + 父任务归档。**带两处未完结遗留，均已在上方 AC 登记**：

1. **`design.md` §2.2 落点表与实现不一致**（AC5④）—— 重构后路径全变，文档未追改。
2. **`10-12-agent-notify` 的 in-app 通知通道已被独立工作删除**（AC5⑤）——
   不是本任务的决策，但改变了本任务的前置事实。

另有**一处实机验证缺口**（承自子任务，非本任务可解）：OMP / Claude / CodeBuddy / Qoder
四家的**真实 CLI 登录态**下通知未逐个验证（`claude-compat` AC6 标 ⚠）；
Codex 与 DSH 已实测（`codex-trust-spike.md` 附录 / DSH AC5 真机确认）。

## 明确不在本任务范围

- WSL / SSH 远端 agent 的 hook 回调可达性（`10-12` 的 E5 / Phase B2，未实施）。
- 通知通道扩展（声音 / Webhook / 免打扰时段）—— `10-12` 的 E2/E3/E8。
- 除这 6 个之外的 CLI（如 Gemini / Grok / Reasonix）—— 拓扑同 claude-compat 时后续可加行。
- Codex 的 `Interrupt` 事件语义（是否为「用户主动取消」需实测；若无法区分则映射到
  `session_failed` 或干脆不映射，由子任务决定并记录）。
