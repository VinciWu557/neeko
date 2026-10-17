# Codex 通知接入（`notify` 通道）

> 子任务，父任务 `10-16-agent-notify-more-clis`（P3）。
> 跨子任务契约见父任务 `design.md`（T6–T10）。
> **依赖**：复用 `10-16-notify-claude-compat` 产出的 shim 契约与 `InstallShape` 分派骨架。
>
> **⚠️ 本文件已在 Step 0 spike 后重写**（2026-10-16）：实测推翻了原规划的通道与能力面。
> spike 全文与证据：`research/codex-trust-spike.md`。修订摘要见文末「规划修订记录」。

## Goal

Codex 在 Neeko 失焦时，把「**轮次完成**」触达用户的操作系统通知中心。

**通道**：Codex 内置的 `notify` 配置（`~/.codex/config.toml` 的一个数组键），
**不是** `hooks.json` 的结构化合并。

**为什么换通道**（实测，见 spike）：

| | `hooks.json`（原规划） | `notify`（采用） |
| --- | --- | --- |
| 信任门 | **有，两层**（项目信任 + 逐 hook `trusted_hash`） | **无** |
| 自动化 | `trusted_hash` 输入不可反推（45 个候选全不匹配） | 一个 config 键，零信任写入 |
| 依赖 | Codex 内部 TOML 序列化格式（**未公开、会变**） | 公开配置键 |
| 事件面 | 12 个事件（含 `PermissionRequest`） | **仅 `agent-turn-complete`** |

**取舍**：换来「零信任写入 + 不依赖内部格式」，代价是**只能覆盖「轮次完成」**
（`notify` 无审批/失败事件）。这是诚实的能力边界，不是缺陷 —— 详见「能力边界」。

## 前置事实（已核实，spike 实测）

- `notify` 配置键：TOML **数组**（`notify = ["<abs shim>", "<source>", "<event_key>"]`）。
  字符串形态被拒：`invalid type: string ..., expected a sequence in notify`。
- **载荷投递形态与 Claude 兼容面不同**：JSON 在 **argv[3]**（`$3`），**不是 stdin**。
  实测 `COUNT=3; 1=codex; 2=turn_completed; 3={"type":"agent-turn-complete",...}`。
- 载荷字段：`type` / `thread-id` / `turn-id` / `cwd` / `client` / `input-messages` /
  `last-assistant-message`。**二进制佐证**：`hooks/src/legacy_notify.rs`。
- 唯一事件类型：`agent-turn-complete`。
- 触发时机：每轮 agent 结束（`codex exec` 非交互模式同样触发）。
- 信任门实证：项目级 `.codex/hooks.json` 的 `Stop` hook **未执行**（探针文件未创建），
  而 `notify` 在**零信任配置**下正常触发。
- `--dangerously-bypass-hook-trust` 与 `-c bypass_hook_trust=true` 实测**均不解除信任门**
  （疑为 session-flags 作用域，非可持久化用户配置）。
- 本机 `~/.codex/config.toml` 含用户敏感内容（`experimental_bearer_token` 等）——
  **AC4 的内容保护是硬约束**。

## Requirements

### R1 配置面（`config.toml` 的 `notify` 键）

- R1.1 新增接入形态 `InstallShape::NotifyArgv { config_file: &'static str }`（或等价数据表达）：
  「shim 路径 + 参数写进某个 TOML 文件的**数组键**」。
  形态是**数据**，`writers` 按形态分派，通用模块零 CLI 分支（红线 15）。
- R1.2 合并语义（`toml_merger` 或复用 `merger` 的判定思想）：
  - **只增删自家条目**（按 shim 路径识别，与 `SHIM_MARKER` 同判据）；
  - **幂等**：已存在完全一致的条目 → `Unchanged`（不写盘）；
  - **收敛**：多条自家条目 → 收敛到一条；
  - **他人条目逐字保留**（用户可能已有自己的 `notify`）；
  - **fail-safe**：`notify` 键存在但类型不是数组 → `Noop` + 原样保留 + 跳过写盘。
- R1.3 **AC4 硬约束**：改写 `config.toml` 时，`notify` 之外的**所有内容逐字不变**
  （含 `[model_providers]` / `[projects.*]` / 用户 token / 格式）。
  **实现取向**：优先「文本级定点插入/删除」而非「解析-重序列化」（后者会重排格式、
  丢注释、改变用户的引号风格）。若用 `toml_edit`（保留格式的编辑器）亦须验证逐字不变。
- R1.4 权限继承：`config.toml` 可能是 0600（本机即如此）—— 复用
  `platform::private_file::write_atomic_preserving_mode`。

### R2 上报通道（shim）

- R2.1 **复用 `10-16-notify-claude-compat` 的 shim**（`templates/neeko-report.mjs`），
  但**必须支持 argv 载荷**：Claude 面从 stdin 读 JSON，Codex 面从 argv 读。
  - 判据：**两种来源都试**（argv 里以 `{` 开头的参数 → 当 JSON 解析；否则读 stdin）。
  - 这是 shim 的**唯一**增量；不得为 Codex 复制第二份 shim（违反 DRY）。
- R2.2 `notify` 的数组形态固定为 `["<abs shim>", "<source>", "<event_key>"]`
  （与 Claude 面的 argv 契约同形：`source` + `event_key`），故 shim 零 per-CLI 知识。
- R2.3 载荷字段映射（Codex → `HookEnvelope`）：

  | Envelope 字段 | 来源 |
  | --- | --- |
  | `agent_session_id` | `thread-id` |
  | `event` | argv 传入（`turn_completed`） |
  | `cwd` | `cwd` |
  | `detail` | `last-assistant-message` 首个非空行（截断交核心域） |
  | `title` | `input-messages[0]` 首个非空行（会话主题，R7 降级链） |
  | `hints` | env（`NEEKO_SESSION_ID` / `NEEKO_PROJECT_ID`） |

- R2.4 **`type` 字段白名单**：只处理 `agent-turn-complete`；其余类型静默丢弃
  （fail-open：Codex 未来加类型不得让我们误报）。
- R2.5 硬约束与既有 shim 同：永远 exit 0、800ms 超时、一切异常吞掉、坐标每次重扫目录。

### R3 事实表接入

- R3.1 `HOOK_TARGETS` 加一行 `codex`：`source = "codex"`、`dir = codex_config_dir()`
  （`~/.codex`，`CODEX_HOME` 优先）、`shape = NotifyArgv { config_file: "config.toml" }`。
- R3.2 `server.rs` 的路由白名单从事实表派生 → **零改动**自动支持 `POST /hook/codex`。
- R3.3 事件投影：`turn_completed` 已在 `notify.rs::classify` 中
  （`10-16-notify-claude-compat` 已补 `SESSION_FAILED`），**本任务零改动**。

### R4 能力边界（诚实登记）

- R4.1 **本任务只覆盖 `turn_completed`**。`notify` 无审批/失败事件（实测）。
- R4.2 「Codex 等待审批」通知**不在本任务范围**，登记为遗留：
  唯一路径是 `hooks.json` 的 `PermissionRequest` + 用户 TUI 确认一次
  （信任哈希由 Codex 自己写）。可作为后续任务，Neeko 只写条目、**不写** hash。
- R4.3 不得为了「凑齐四类语义」而假装覆盖 —— 宁缺勿误报（与 claude-compat 的 U4 同判据）。

## Acceptance Criteria

> 状态核验：2026-10-17（归档前回填）。`[x]` = 单测钉子；`[x]⚠` = 自动化已验、实机人工项未做。
> 另注：本任务的 **A 方案（审批通知）在 spike 之后追加实施**，把 Codex 从单面扩成双面 ——
> 该轮结论见 `implement.md`「Phase 2（A 方案）」，不在下方 AC 的原始措辞里。

- [x] **AC1 通道正确性** —— `targets/tests.rs`：`codex_has_both_notify_and_hooks_json_faces`
  （钉死 `notify` 面存在）+ `shim_bearing_shapes_use_the_canonical_shim_file_name`。
  「不写任何 `[hooks.state]` 哈希」由 `trust.rs` 的**只读**探针保证
  （`trust_status_requires_our_own_entry_keys` 反证钉子：只判路径前缀必红）。
- [x]⚠ **AC2 实测触发** —— e2e 已打通（真 Codex → shim → ingest 收到 `turn_completed`，
  见 `research/codex-trust-spike.md` 附录）。标 ⚠：该项是**实机人工项**，验收时需重跑一次。
- [x] **AC3 无 node 时降级** —— `install/tests::every_leg_skips_when_node_is_absent`
  （`without_node()` 夹具，**遍历每条腿**，含 `NotifyArgv`）断言 `Skipped` + detail 且不写盘。
- [x] **AC4 用户 TOML 内容保护** —— `install/config/toml::tests`：
  `insert_appends_key_when_absent_preserving_everything_else`（逐字节比较）+
  `insert_lands_at_top_level_even_when_file_ends_with_a_table` /
  `inserted_key_sits_before_the_first_table_header`（**表作用域**回归 —— 解析器回读）；
  权限 `notify_install_preserves_config_permissions`；fail-safe `non_array_value_is_untouched` /
  `unsupported_shapes_are_untouched` / `refuses_edits_that_would_produce_invalid_toml`。
- [x] **AC5 他人 `notify` 条目保留** —— `insert_skips_when_user_has_own_notify` +
  `notify_install_skips_when_user_has_own_notify` + `notify_uninstall_leaves_user_own_notify`。
- [x] **AC6 复用而非复制** —— `targets/data.rs` 的 codex 行 `template: templates::REPORT_SHIM`
  与 claude/codebuddy/qoder **同一常量**；判据由 `claude_compat_sources_share_one_shim_template`
  钉死共享关系。
  ⚠ **覆盖缺口**：该测试枚举的是 `["claude","codebuddy","qoder"]`，**未含 codex** ——
  codex 复用同一常量靠数据表字面量保证，无专属反证钉子。补一条含 codex 的迭代即可封口。
- [x]⚠ **AC7 核心域零改动** —— 同 claude-compat：`notification/**` 仅注释改动，无逻辑 diff。

## Step 0 Spike（已完成，2026-10-16）

结论全文：`research/codex-trust-spike.md`。摘要：

- [x] **U5 `trusted_hash` 能否自动化** → **不能**。① 信任门是执行级硬门（未信任的 hook 不跑，
      探针实证）；② `bypass_hook_trust` 三种注入方式均无效；③ hash 输入尝试 45 个候选全不匹配，
      二进制仅暗示「normalized hook identity 的 TOML 序列化」——**内部实现、非稳定契约**。
      → **放弃 `hooks.json` 通道**。
- [x] **通道选型** → **`notify` 配置**：实测**完全绕过信任门**，零信任写入，
      一个 config 键，载荷正是所需字段。
- [x] **U6 `Interrupt` 语义** → **无需定案**（`notify` 无该事件；`hooks.json` 通道已放弃）。
- [x] **载荷投递形态** → JSON 在 **argv[3]**（不是 stdin）—— shim 需支持两种来源。
- [x] **能力边界** → `notify` 唯一事件是 `agent-turn-complete`；审批事件**不可得**（AC2 据此下调）。

## 明确不在本任务范围

- OMP / Claude / CodeBuddy / Qoder（`10-16-notify-claude-compat`，已实施）。
- DSH（`10-16-notify-dsh`）。
- **Codex 的审批/失败通知**（`hooks.json` + 信任门；见 R4.2，登记为后续任务）。
- Codex `exec --json` headless 事件流兜底腿（父任务 E11）。
- 项目级 `.codex/hooks.json`（trellis 占用）—— 本任务只碰用户级 `config.toml`。

## 规划修订记录（2026-10-16，Step 0 spike 后）

| # | 原规划 | 修订 |
| --- | --- | --- |
| 1 | 通道 = `hooks.json` 结构化合并 | 通道 = `config.toml` 的 `notify` 数组键（绕过信任门） |
| 2 | 需 `toml_merger` 写 `[hooks.state]` 信任哈希（U5 决定能否自动化） | **不写任何信任哈希**（U5 = 不可自动化，且依赖内部格式） |
| 3 | R2「信任门两条路径（自动化 / UX 引导）」 | **整节作废** —— 走 `notify` 即无信任门 |
| 4 | AC2 要求「等待审批 + 轮次完成」两类 | 下调为**仅「轮次完成」**（`notify` 无审批事件） |
| 5 | shim 从 stdin 读 JSON（Claude 契约） | shim **同时支持 argv[3] 与 stdin**（两种来源都试） |
| 6 | U6 需定案 `Interrupt` 语义 | 无需定案（该通道无此事件） |
