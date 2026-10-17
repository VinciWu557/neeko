# Design — OMP + Claude/CodeBuddy/Qoder 通知接入

> 子任务设计。跨子任务契约（T6–T10、`InstallShape` / `HookEntry` / `MergeOutcome` 定义）
> 见父任务 `10-16-agent-notify-more-clis/design.md`，本文件**不复述**，只展开落点与实现细节。

## 1. 落点地图

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `src-tauri/src/agent/hooks/targets.rs` | 扩展 | `InstallShape` + `HookEntry` + `CLAUDE_COMPAT_ENTRIES`；OMP / claude / codebuddy / qoder 四行；`hook_targets_are_unique` 修正 |
| `src-tauri/src/agent/hooks/templates/neeko-omp-status.ts` | **新增** | OMP 变体（pi 模板派生，删 `ui_prompt_start`，U1） |
| `src-tauri/src/agent/hooks/merger.rs` | **新增** | JSON 结构化合并纯函数（R2 全部） |
| `src-tauri/src/agent/hooks/templates/neeko-report.mjs` | **新增** | 唯一 stdin shim（claude/codebuddy/qoder 共用） |
| `src-tauri/src/agent/hooks/templates.rs` | **新增** | 模板的 `include_str!` 门面（「三源共用同一份 shim」的类型可见事实） |
| `src-tauri/src/agent/hooks/settings.rs` | **新增** | 逐 CLI hook 开关（`agentHookSources`；业务身份归 agent 域，见 §10） |
| `src-tauri/src/agent/hooks/writers.rs` | 扩展 | 按 shape 分派；权限继承；status 双面检查 |
| `src-tauri/src/agent/hooks/notify.rs` | 微改 | 补 `SESSION_FAILED` arm |
| `src-tauri/src/agent/hooks/mod.rs` | 微改 | `pub mod merger` + `pub use`（红线 9：仅此两行） |
| `src-tauri/src/platform/hook_command.rs` | **新增** | shim 启动命令平台渲染（红线 2/10） |
| `src-tauri/src/platform/mod.rs` | 微改 | `pub mod hook_command` + 主题索引表一行 |
| `src/shared/types/notification.ts` | 扩展 | `cliHooks` → `cliHookSources` |
| `src/features/notification/**` | 扩展 | 逐 CLI 开关 UI（数据驱动行） |
| `src/features/settings/components/CliHooksSection.tsx` | **新增** | CLI hook 开关面（从 NotificationSettingsSection 拆出，组件规模红线） |
| `src-tauri/src/notification/**` | **零改动** | AC8（已自证：`git diff` 为空） |

## 2. `targets.rs` 扩展

```rust
/// 接入形态 —— 决定 writers 走哪条腿。策略集固定 → enum + match（编译期穷尽）。
pub enum InstallShape {
    /// 独立文件即插拔：只写一个受管文件，绝不碰用户既有配置。
    Standalone,
    /// 独立 shim 文件 + 结构化插入点：shim 仍是独立文件，
    /// 但需把一条 hook 条目插入用户既有配置。
    Structured { entries: &'static [HookEntry] },
}

/// 一条结构化插入点：CLI 原生事件名 → 语义 event_key 的**纯数据映射**。
pub struct HookEntry {
    /// CLI 原生事件名（该 CLI settings schema 的键）。
    pub native_event: &'static str,
    /// matcher 值；`None` = 不写该字段（不是写空串）。
    pub matcher: Option<&'static str>,
    /// 归一后的语义 event_key（与源 A 同命名空间）。
    pub event_key: &'static str,
}

/// Claude Code 规范事件面 → 语义键。**三源共用一份**（AC2）：
/// Qoder 官方 `hooks migrate --from-claude` 把 Claude hooks **结构 1:1 迁移**
/// （`g.set(["hooks", eventName, ...])`，见 `research/cli-hook-spike.md` U3），
/// CodeBuddy 类型定义亦明写同规范 —— 故不复制三份。
///
/// **U4 修正（2026-10-16）**：不含 `Notification`。Claude 规范明确
/// `Notification` / `UserPromptSubmit` / `Stop` / `SubagentStop` **不使用 matcher**，
/// 写 matcher 不生效 → 所有 Notification（含 idle 提示）都会误报为 `input_requested`。
/// 故不映射（宁缺勿误报）。「等待用户行动」由 `PermissionRequest` 覆盖。
pub const CLAUDE_COMPAT_ENTRIES: &[HookEntry] = &[
    HookEntry { native_event: "PermissionRequest", matcher: Some("*"),
                event_key: event_keys::APPROVAL_REQUESTED },
    HookEntry { native_event: "Stop", matcher: None,
                event_key: event_keys::TURN_COMPLETED },
    HookEntry { native_event: "StopFailure", matcher: None,
                event_key: event_keys::SESSION_FAILED },
];
```

> **`input_requested` 在 Claude 系不映射**：Claude 无独立的「等待输入」事件。
> 四类全覆盖是**任务级目标**（OMP 的 `tool_call` / Codex 的 `PermissionRequest`），
> 不是每个 CLI 都能覆盖四类 —— 数据事实。

### OMP 模板（U1 修正）

OMP **不支持** `ui_prompt_start`（二进制 0 命中 `withUIPrompt` / `emitUIPromptEvent` /
`UIPromptStartEvent`；pi 的 `types.d.ts:1081` 有该 variant）。
故 OMP 需要 **pi 模板的变体**（新文件 `templates/neeko-omp-status.ts`）：

- **保留**：`session_start`（记 session id）、`agent_end`（→ `turn_completed`）、
  `tool_call`（ask 类工具 → `approval_requested`）、`topicOf` 主题链；
- **删除**：`ui_prompt_start` 段（OMP 无此事件）；
- **不得**写成运行时 `if (isOmp)` 分支 —— 变体是独立文件（保持模板零 CLI 分支）。

### 目录解析函数（新增四个）

```rust
/// Claude Code 配置根（`~/.claude`，`CLAUDE_CONFIG_DIR` 优先）。
pub fn claude_config_dir() -> Option<PathBuf>;
/// CodeBuddy 配置根（`~/.codebuddy`）。
pub fn codebuddy_config_dir() -> Option<PathBuf>;
/// Qoder 配置根（`~/.qoder`）。U3 决定是 settings.json 还是 .qoder-plugin/。
pub fn qoder_config_dir() -> Option<PathBuf>;
/// OMP 扩展目录（`~/.omp/agent/extensions`）—— 复用 pi 模板（AC1）。
pub fn omp_extensions_dir() -> Option<PathBuf>;
```

### `hook_targets_are_unique` 修正（T10）

```rust
// 现状：assert_ne!(a.file_name, b.file_name)  ← 过度约束（OMP 与 pi 同名不同目录）
// 修正：只断言 source 唯一；file_name 唯一性由 (dir, file_name) 保证，dir 是 fn 无法比较。
```

## 3. `merger.rs`（新增）

见父任务 design.md §3 的完整实现草案（含 5 个单测）。要点：

- `SHIM_MARKER = "agent-hooks/report.mjs"` —— 自家条目识别判据（**不塞私有字段**，R2.6）。
- `apply()` 返回 `MergeOutcome`，`Noop` 兼作 fail-safe 信号（调用方跳过写盘）。
- 幂等判据：自家条目恰一条且 `== build_entry(...)` → `Unchanged`。
- 收敛：逆序删除多余自家条目后 push 一条（索引不漂移）。

**为什么纯函数**：IO（读文件 / 权限 / 原子写）与判定（结构变换）分离后，
4 条不变量全部可 tempdir 直测，不需要真实用户目录（红线 13）。

## 4. `writers.rs` 分派

```
install_at(target, dir)
  match target.shape
    Standalone        → 既有实现（零改动）
    Structured{entries} →
      1. 写 shim 到固定路径 {neeko_dir}/agent-hooks/report.mjs（幂等，内容寻址标记）
      2. 对每条 entry：
           读 {dir}/{settings_file}（不存在 → Skipped，不创建）
           merger::apply(&mut cfg, entry.native_event, entry.matcher, cmd, Insert)
           Noop → 记录 detail（fail-safe 命中）
      3. 有任一 Changed → stat 原权限 → temp+rename → 恢复权限
      4. 回执合并为一条 HookApplyOutcome（status 取最严重者）
```

**status 语义**（R3.5）：`installed` = shim 存在且**至少一条**自家条目在配置里；
`version_current` = shim 标记当前 **且** 所有 entry 的 command 与当前渲染一致。

**并发**：读-改-写窗口极小 + 原子 rename；**不加锁**（与既有 endpoint 发布同策略）。
用户同时手动编辑的竞态窗口存在，但损坏面是「用户自己刚写的改动」而非「我们的条目」——
且 merger 的 fail-safe 保证不会写出畸形 JSON。

## 5. `neeko-report.mjs`（新增）

见父任务 design.md 的完整实现草案。要点：

- `argv = <source> <event_key>` —— **shim 零 per-CLI 事件名知识**（T9）。
- **不缓存坐标**：本进程是短命进程（每次 hook 事件一个新进程），
  缓存没有跨调用收益，反而引入「读到旧坐标」的风险（与 pi/opencode 的常驻扩展不同）。
- 字段提取一个函数覆盖四家（Claude 规范字段名收敛）。
- 顶层 `.catch(() => {}).finally(() => process.exit(0))` —— 永远 0（T5/R4.2）。

## 6. `platform/hook_command.rs`（新增）

```rust
/// 渲染 shim 启动命令（写进 CLI 配置的 `command` 字段）。
///
/// 平台差异（红线 2/10）：Windows 需 `cmd /c` 前缀与不同的引号规则；
/// POSIX 用 `sh -c` 语义或直接 argv。业务文件（writers/merger）不得平铺 `#[cfg]`。
pub fn render_report_command(source: &str, event_key: &str) -> Option<String>;
```

**node 可执行文件定位**（U2 已定案）：`render_report_command` 返回 `Option<String>`；
解析不到 node → `None` → `install_at` 回执 `Skipped("node not found")`。
本任务三个 CLI 都是 Node 系（`codebuddy` = npm 包、`qodercli` = bun 编译产物、`claude` = npm 系），
前提必然成立；Codex（Rust 二进制）的降级路径归 `10-16-notify-codex`。
（不采用 sh + curl 方案：Windows 无 curl 保证，且会引入第二份实现，违反 DRY。）

## 7. 前端改动

```ts
// src/shared/types/notification.ts
// 旧：cliHooks: boolean
// 新：按 source 的开关数据（父任务 R2.6）
cliHookSources: Record<string, boolean>;   // 默认 {} = 全关
```

- `NOTIFIABLE_EVENTS` **不变**（event_key 复用，`session_failed` 需加一行 —— 见 R5.2）。
- 设置页 CLI 行清单**数据驱动**：从 `agent_hooks_status` 的返回动态渲染
  （新增 CLI 无需改组件，AC2 的前端侧对应）。

## 8. 红线合规

| 红线 | 落点 |
| --- | --- |
| 2 跨平台 shell | `platform/hook_command.rs`（新增）；writers/merger 零 `#[cfg]` |
| 3 阻塞 IO | merger 纯函数；writers 的配置读写走命令层同步路径（非 async 上下文） |
| 5 Event 名常量化 | 零新增 Tauri 事件；shim 契约常量沿用既有单一源 |
| 6 薄命令 | `agent_hooks_apply/status` 签名不变 |
| 8 路径安全 | merger 不消费前端传入路径（全部 home 派生）；ingest 不变 |
| 9 mod.rs 极薄 | `agent/hooks/mod.rs` 仅加 `pub mod merger` + `pub use` |
| 10 平台集中化 | `platform/hook_command.rs` + `platform/mod.rs` 索引表一行 |
| 13 夹具平台无关 | merger 全部 tempdir 直测 |
| 15 差异落数据 | CLI 差异 = `HOOK_TARGETS` 行 + `HookEntry` 数据；通用模块零 CLI 分支 |

## 9. 风险

| 风险 | 对策 |
| --- | --- |
| **改写用户真实配置**（本任务最大风险） | merger 4 条不变量测试钉死 + fail-safe + 逐 CLI opt-in 默认关 + 权限继承（AC3/AC4/AC5） |
| 用户同时手动编辑配置 | 原子 rename + 极小窗口；不做锁（与既有策略一致） |
| OMP 模板第 3 条腿（`ui_prompt_start`）不支持 | **U1 已定案**：OMP 无该事件 → 变体模板删该段；「等待审批」腿（`tool_call`）仍生效 |
| Qoder 配置面位置 | **U3 已定案**：`~/.qoder/settings.json` 生效（官方 `hooks migrate --from-claude` 为证） |
| Claude `Notification` matcher | **U4 已定案**：matcher 无效 → 不映射（宁缺勿误报） |
| 无 node | **U2 已定案**：本任务三 CLI 都是 Node 系，前提成立；`render_report_command` 返回 `Option` 以应对异常环境 |
| 无 node | U2 spike；无 node → `Skipped` + 设置页提示 |
| 既有 `hook_targets_are_unique` 会红 | 先改断言（T10），再添加新行 |

---

## 10. 实施期计划修订（2026-10-16，Step 7 发现）

### 发现的矛盾

两条规划产物互斥：

| 产物 | 要求 |
| --- | --- |
| 父任务 `design.md` §3 | `cliHooks: boolean` → `cliHookSources: Record<string, boolean>`，**落在 `NotificationSettings`**（即 `src-tauri/src/notification/types.rs`） |
| 父任务 `prd.md` AC1 / 本任务 AC8 | `src-tauri/src/notification/**` 的 **diff 为空** |

而 `cli_hooks` 字段正位于 `notification/types.rs:155`。

**更深一层**：把 `{"claude": true, "qoder": false}` 这类**业务身份**写进核心域类型，
正是 AC1 要防的泄漏（父任务 design T4：语义是闭集、来源是开集数据，
且**业务身份归业务域所有**）。所以 AC1 的「字面零 diff」虽比它的「精神」更严，
但两者指向同一结论：**per-CLI 开关数据不该住在核心域**。

### 采用的解决（AC1 与 R2.6 同时满足）

- **`cli_hooks`（核心域，零改动）** 语义收窄为**主开关**：「Neeko 可为 CLI 安装状态上报 hook」。
  它已是 `NotificationSettings` 的既有字段，核心域 policy/center/dispatch **都不读它**
  （纯持久化意图，零业务分支）—— 保持原样即满足 AC8。
- **`agentHookSources`（agent 域新配置键，config.json）** 承载**逐 CLI 覆盖**：
  `{"claude": false, "qoder": true}`。键缺失 ⇒ 该 CLI **跟随主开关**（默认启用）。
- **生效判定**：`effective(cli) = master && sources.get(cli).unwrap_or(true)`。
  于是「主开关开 ⇒ 全部安装」（与 `10-12` 行为向后兼容），
  逐 CLI 可单独关掉某个（如不想动 `~/.claude/settings.json`）。
- **R2.6 的「默认关闭」** 由**主开关默认 `false`** 满足（未显式同意 ⇒ 一个都不装）。

### 为什么放 agent 域而非核心域

1. 「哪些 CLI 存在、各自的配置面在哪」是 **agent 域知识**（`targets.rs` 事实表已持有）；
2. 既有先例一致：`agent/boot.rs` 已自有 `customAgents` 配置键（业务身份归业务域）；
3. 依赖方向不变：`agent/hooks` → `notification` 门面，核心域零感知（AC8 / AC1）。

### 对 `design.md` §3 的更正

§3 末尾「前端类型升级」的 `cliHookSources` 应落在 **agent 域的配置键**
（`agentHookSources`），**不是** `NotificationSettings`。
