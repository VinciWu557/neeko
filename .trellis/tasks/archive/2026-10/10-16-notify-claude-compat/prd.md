# OMP + Claude/CodeBuddy/Qoder 通知接入

> 子任务，父任务 `10-16-agent-notify-more-clis`（P1 + P2）。
> 本文件只放**本子任务**的需求与验收；跨子任务契约见父任务 `design.md`（T6–T10）。

## Goal

让 OMP、Claude Code、CodeBuddy、Qoder 四个 CLI 在 Neeko 失焦时，把
「等待审批 / 等待输入 / 轮次完成 / 会话异常」触达用户的操作系统通知中心。

按拓扑拆为两段，同属本任务：

- **P1 OMP**：复用既有 pi extension 模板，加一行事实表数据（T6 推论 2）。
- **P2 Claude / CodeBuddy / Qoder**：三者共享 Claude Code hook 规范（T7），
  需要一个**唯一的 stdin shim** + 一个**JSON 结构化合并器**，
  并升级 `writers` 的客人义务契约（新增 `InstallShape::Structured`）。

## 前置事实（已核实）

- `~/.claude/settings.json` 已有 `hooks` 对象，含 14 个事件在册
  （`SessionStart/End`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse(Failure)`、
  `PermissionRequest`、`PermissionDenied`、`Notification`、`Stop(Failure)`、
  `SubagentStart/Stop`、`Elicitation`、`TeammateIdle`），且**已被 orca / clawd / superset
  三方占用**（同事件下多条他人条目）—— 他人条目保留是本任务最硬的不变量。
- CodeBuddy 的 `HookEvent` enum 有 28 项，handler 四型 `command/http/prompt/agent`，
  类型定义明写 `Format matches Claude Code hooks specification exactly`。
- `qodercli-1.1.68` 二进制内含 22 个引号事件名 + `hooks` settings 键 + `HookConfig{matcher,hooks[]}` schema。
- OMP 的扩展面 `~/.omp/agent/extensions/` 已有 orca 的 `orca-agent-status.ts`，
  用 `export default function (pi)` + `pi.on(...)`，注释明写与 pi 同 API。
- 既有 `agent/hooks/notify.rs::classify` **无 `session_failed`** arm。
- 既有 `writers.rs::hook_targets_are_unique` 断言 file_name 全局唯一（过度约束，T10）。

## Requirements

### R1 数据面（事实表扩展）

- R1.1 `HookTarget` 增 `shape: InstallShape`（`Standalone` / `Structured { entries }`）。
- R1.2 `HookEntry { native_event, matcher: Option<&str>, event_key }` 作为
  `(CLI 原生事件名 → 语义 event_key)` 的**唯一数据源**；shim 零事件名知识。
- R1.3 Claude / CodeBuddy / Qoder 三源**共享同一份** `entries` 常量
  （不复制三份；测试钉死）。
- R1.4 OMP 使用 pi 模板的**派生素材**（同源、差异仅事件订阅集）。
  **spike 修正（U1）**：OMP **不支持** `ui_prompt_start`（二进制 0 命中 `withUIPrompt` /
  `emitUIPromptEvent` / `UIPromptStartEvent`；pi 的 `types.d.ts:1081` 有该 variant）。
  故 OMP 需要**变体模板**（保留 `agent_end` + `tool_call`，删 `ui_prompt_start` 段），
  不是「同一 `include_str!` 常量」。变体仍是独立文件，不是运行时分支（保持零 CLI 分支）。
- R1.5 修正 `hook_targets_are_unique`：file_name 全局唯一 → `source` 唯一（T10）。
  **spike 确认必要**：OMP 变体模板若沿用 pi 的文件名 `neeko-status.ts`（不同目录）会触发原断言。

### R2 结构化合并（本任务核心机制）

- R2.1 新增 `agent/hooks/merger.rs`：**纯函数** `apply(&mut Value, native_event, matcher,
  command, action) -> MergeOutcome`，零 IO。
- R2.2 **他人条目逐字保留**：同事件下他人条目不受任何影响（含 `http` 型条目）。
- R2.3 **fail-safe**：配置非对象 / `hooks` 非对象 / 事件值非数组 → 返回 `Noop` 且
  **原样保留**，调用方据此跳过写盘。
- R2.4 **幂等 + 收敛**：同 command 重复插入 → `Unchanged`（不写盘）；
  多条自家条目 → 收敛到恰好一条（不累积）。
- R2.5 **移除后不留空壳**：`hooks.<event>` 变空数组 → 删除该键。
- R2.6 **自家条目识别**：按 command 内的 shim 路径标记（`SHIM_MARKER`），
  **不往 CLI 的 schema 里塞私有字段**（会被 CLI 拒载）。
- R2.7 条目 schema：`{ matcher?, hooks: [{ type:"command", command, timeout, async }] }`；
  `matcher: None` 时**不写该字段**（不是写空串）。

### R3 writers 契约升级

- R3.1 `install_at` / `uninstall_at` / `status_at` 按 `target.shape` 分派：
  `Standalone` → 既有行为（零改动）；`Structured` → 写 shim + 读-改-写用户配置。
- R3.2 **权限继承**：改写用户配置时 stat 原权限，rename 后显式恢复（R2.5 父任务）。
- R3.3 **原子替换**：temp + rename（复用 `platform/private_file` 或同形态）。
- R3.4 **配置路径解析失败**（目录不存在等）→ `Skipped`，不创建 CLI 的配置目录
  （与 `Standalone` 的 `dir_to_file` 只读语义一致）。
- R3.5 `status` 对 `Structured` 须同时检查 shim 文件与配置条目，
  `version_current` 取二者与当前模板的一致（内容寻址标记沿用既有 `content_token`）。
- R3.6 `reconcile_action` 逻辑不变（继续按 status 判定），但目标数须覆盖新增行。

### R4 上报通道（shim）

- R4.1 新增 `agent/hooks/templates/neeko-report.mjs`：**唯一** stdin shim，
  `argv = <source> <event_key>`。
- R4.2 硬约束：永远 exit 0、800ms 超时、一切异常吞掉、坐标每次上报重扫目录
  （与既有 pi/opencode 模板同口径）。
- R4.3 字段提取用一个函数覆盖四家（Claude 规范字段名；Codex 同形，属 P3）。
- R4.4 新增 `platform/hook_command.rs`：shim 启动命令的平台渲染（路径分隔符 / 引号规则），
  业务文件零 `#[cfg]`（红线 2 / 10）。
- R4.5 shim 文件由 `writers` 写入**固定路径**（`{neeko_dir}/agent-hooks/report.mjs`），
  该路径是配置里写死的稳定坐标（T8 的副产品）。

### R5 语义事件覆盖

- R5.1 任务级目标：四类语义全部覆盖（`approval_requested` / `input_requested` /
  `turn_completed` / `session_failed`，父任务 R4）。
- R5.2 `notify.rs::classify` 补 `SESSION_FAILED` arm（Failed 类，文案「会话异常」）。
- R5.3 事件映射（**Step 0 spike 定稿，2026-10-16**）：

  | 原生事件 | matcher | event_key |
  | --- | --- | --- |
  | `PermissionRequest` | `*` | `approval_requested` |
  | `Stop` | 无 | `turn_completed` |
  | `StopFailure` | 无 | `session_failed` |

  **spike 修正两项**（证据见 `research/cli-hook-spike.md`）：

  - **U4：`Notification` 不映射**。Claude Code 规范明确 `Notification` / `UserPromptSubmit` /
    `Stop` / `SubagentStop` **不使用 matcher**（CodeBuddy 同源类型定义原文：
    「Optional for events that don't require matching: UserPromptSubmit, Notification, Stop,
    SubagentStop: matcher is not used」）。本机 `~/.claude/settings.json` 的 `Notification`
    实测 matcher 为 `""`。若按原草案写 `matcher: "permission_prompt"` → matcher 不生效 →
    **所有** Notification（含 idle 提示）都映射为 `input_requested` = 误报。故删除该行。
  - **`input_requested` 在 Claude 系无对应事件**（宁缺勿误报）。等待用户行动已由
    `PermissionRequest`（ActionRequired 类）覆盖，用户不会漏通知。
    「四类全覆盖」是**任务级目标**，不是每个 CLI 都能覆盖四类 —— 数据事实，非设计缺陷。
  - `SessionEnd` 不映射（与 `Stop` 重复，避免双发）；`SubagentStop` 不映射（子 agent 结束
    不是「用户需要注意」）。

### R6 设置与 opt-in

- R6.1 前端 `cliHooks: boolean` → `cliHookSources: Record<string, boolean>`（默认全 `false`）。
- R6.2 设置页每个 CLI 一行：开关 + 安装状态（`installed` / `versionCurrent` / `path`）。
- R6.3 保存后走既有串行链（设置保存 → `agent_hooks_apply`），不新增并发窗口。
- R6.4 开关关闭 → 移除自家条目 + 删除 shim（若已无其他 CLI 使用）；
  他人条目原样（R2.5 父任务）。

## Acceptance Criteria

> 状态核验：2026-10-17（归档前回填）。分级口径 —— `[x]` = 有单测钉子；
> `[x]⚠` = 自动化已验、实机人工项未做。**归档 ≠ 验收**，带 ⚠ 的均为已登记遗留
> （真实 CLI 登录态 + 多 CLI 实机，自动化不可达）。落点文件以 `agent/hooks/**` 为准。

- [x] **AC1 OMP 使用 pi 模板的派生物素材** —— `targets/tests.rs`：
  `omp_variant_omits_ui_prompt_and_keeps_other_legs`（变体不含 `ui_prompt_start` 且其余腿齐全）
  + `omp_template_keeps_shared_contract_anchors` + `omp_dir_sits_under_home_and_differs_from_pi`。
- [x] **AC2 shim 单份三源共用** —— `claude_compat_sources_share_one_entries_table` 与
  `claude_compat_sources_share_one_shim_template`（`std::ptr::eq` 同一常量指针，
  比「文本相等」更强 —— 文本相等仍可能是两份拷贝）。
- [x] **AC3 结构化合并四条不变量** —— `install/config/json::tests`：他人条目逐字保留
  `insert_preserves_foreign_entries_verbatim`；fail-safe `malformed_config_is_never_destroyed`
  （实机形态 `structured_install_leaves_everything_untouched_on_malformed_config`）；
  幂等 + 收敛 `insert_is_idempotent` / `insert_converges_duplicate_own_entries`；
  空数组删键 `remove_only_ours_and_prunes_empty_event` / `remove_prunes_event_key_when_only_ours`。
- [x] **AC4 权限继承** —— `structured_install_preserves_settings_permissions`（`#[cfg(unix)]`）。
- [x] **AC5 逐 CLI opt-in** —— `install/config/settings::tests`：`master_off_disables_everything` /
  `master_on_defaults_all_and_per_cli_override_excludes_only_one` /
  `override_true_does_not_bypass_master` / `absent_key_follows_master` /
  `config_key_is_mirrored_in_frontend`（双端同键镜像）；前端 `CliHooksSection` 的
  `readSourceOverrides` 归一化非法值。契约已入
  `spec/backend/agent-hooks-domain.md`「两个开关的分工」。
- [x] **AC6 实测落地** —— **五个 CLI 全部真机验证通过（2026-10-27 用户确认）**：
  OMP / Claude Code / CodeBuddy / Codex / Qoder 在真实登录态下均触发并落地系统通知。
  自动化侧旁证：`codex-trust-spike.md` 附录记录的 e2e 链路
  （真 Codex → shim → ingest POST 收到 `turn_completed`）。
  > 2026-10-27 补登：此前标 `[x]⚠` 是因为只有 Codex 侧有 e2e 记录，其余四家待登录态。
  > 现用户确认五家真机均正常，**本项无遗留**。
- [x] **AC7 既有行为不变** —— Pi / Opencode 既有分支零改动（`Standalone` 分支 diff 为空）；
  `pnpm check` 30/30 全绿（621 Rust 测试含 `agent::hooks` 161 条）。
- [x]⚠ **AC8 核心域零改动** —— `notification/**` 仅 `types.rs` 一条**文档注释**改动
  （把失效的 `writers.rs` / 任务目录指针改指 spec），**无逻辑 diff**。标 ⚠ 是因为
  「零 diff」本意是「零逻辑改动」，实际有注释重写。

## Step 0 Spike（已完成，2026-10-16）

结论全文：`research/cli-hook-spike.md`。摘要：

- [x] **U1 OMP 事件面** → **不支持** `ui_prompt_start`。OMP 需 pi 模板**变体**
  （保留 `agent_end` + `tool_call`，删 `ui_prompt_start` 段）。
- [x] **U2 node 前提** → 本机有 node v24.17.0；Claude/CodeBuddy/Qoder 本身是 Node 系
  （前提必然成立）；Codex 是 Rust 二进制（前提不成立 → 归 `10-16-notify-codex` 处理）。
  `render_report_command` 返回 `Option<String>`。
- [x] **U3 Qoder 配置面** → `~/.qoder/settings.json` 的 `hooks` **生效**；
  Qoder 自带 `hooks migrate --from-claude` 且把 Claude hooks **结构 1:1 迁移**
  （`g.set(["hooks", eventName, ...])`）—— AC2 三源共享 entries 的最强证据。
- [x] **U4 Claude `Notification` matcher** → **不生效**（规范明确该事件不用 matcher）。
  已从映射表删除该行（映射会误报 idle 提示）。

## 明确不在本任务范围

- Codex（`10-16-notify-codex`）：TOML 合并 + 信任门。
- DSH（`10-16-notify-dsh`）：源 A 桥投影。
- 改写用户配置的**备份/恢复 UI**（若实施期决定加备份，属本任务实现细节，
  不单独设验收项）。
- 除这四个之外的 CLI（Gemini / Grok / Reasonix）。
