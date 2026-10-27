# Design — Agent 系统通知扩展（跨子任务架构）

> 父任务设计。**只放跨子任务的契约与判据**：拓扑分类、客人义务升级、上报通道、复用边界。
> 单个子任务的具体落点与步骤在其自己的 `design.md` / `implement.md`。
>
> 前置设计：`10-12-agent-notify/design.md`（T1–T5、D1–D14、v1–v6 修订史）。本文件是它的续篇，
> 编号从 **T6** 起，**不复述** T1–T5（T1 旁路投影 / T2 单向漏斗不反压 / T3 无状态纯函数裁决 /
> T4 语义闭集+来源开集 / T5 信号源二相性）。
>
> 结论先行：本需求**不需要新的架构**。既有 T4（来源是开集数据）+ T5（二相性）已经覆盖了
> 扩展维度；本任务真正要动的是 **T7a 配置面形态** 这个 `10-12` 明确回避（D7）的维度。

---

## 1. 第一性原理续篇

### T6：接入一个新 CLI 不是一类需求，是三个物理位置的问题

T5 给了「信号源二相性」。本任务把它的推论补完：

> **「某个 CLI 需要注意」这个事实，产生在什么物理位置？** —— 答案只有三种，
> 且**位置决定接入形态**，与 CLI 名字无关。

| 事实产生位置 | 接入形态 | 本任务的 CLI |
| --- | --- | --- |
| Neeko 进程内（Neeko 自己拉起会话） | **源 A**：adapter 归一后自动生效，零成本 | **DSH**（有进程内桥） |
| CLI 进程外 + CLI 提供进程外 hook | **源 B**：写 shim / 模板 | Claude、CodeBuddy、Qoder、Codex、OMP |
| CLI 进程外 + 无 hook，但已有既有通道 | 在该通道的投影里加映射 | （DSH 亦属此类） |

**推论 1**：DSH 不属于「hook 接入」问题。它是 cordis 插件体系（`~/.dsh/profiles/<name>/`
的 patch layer），无 out-of-process hook 面；但 `packages/dsh-neeko` 已把 DSH 事件归一为
`approval.request` / `question.request` / `tool.start` / `tool.end` 并经
`127.0.0.1:3081` WebSocket 送出。**它要走源 A 的投影腿，不是源 B。**
把 DSH 与另 5 个混在一个实现里，是把两个正交问题捆在一起 —— 故拆为独立子任务。

**推论 2**：OMP 是**最便宜的**。本机实测 `~/.omp/agent/extensions/orca-agent-status.ts`
用 `export default function (pi)` + `pi.on("agent_end"/"tool_call"/…)`，其文件内注释明写
「Pi and OMP expose the same extension API」。故 OMP = pi 模板 + 目录变体 + 事件名变体。

### T7：源 B 的接入成本不在「事件名」，在三个正交的物理约束

本机实测证据（二进制 / 配置文件面）：

| CLI | hook 面 | 配置位置 | 形态 | 信任门 |
| --- | --- | --- | --- | --- |
| Claude Code | 有，最全 | `~/.claude/settings.json` → `hooks` | 结构化合并 | 无 |
| CodeBuddy | 有，CC 兼容 | `~/.codebuddy/settings.json` → `hooks` | 结构化合并 | 无 |
| Qoder | 有，CC 兼容 | `~/.qoder/settings.json` → `hooks`；插件面 `.qoder-plugin/qoder-hooks.json` | 结构化合并 | 无 |
| Codex | 有（**不可自动化**）；另有可用的 `notify` 配置 | `~/.codex/hooks.json` / `~/.codex/config.toml` 的 `notify` 键 | `notify` = **一条 argv 的 TOML 数组** | `hooks.json` 有；**`notify` 无** |
| OMP | 有，同 pi | `~/.omp/agent/extensions/*.ts` | **独立文件即插拔** | 无 |

三个约束轴：

**(a) 配置面形态** —— `Standalone`（独立文件即插拔）vs `Structured`（结构化合并进用户配置）。
既有 `writers.rs` 的客人义务契约（首行标记 + 只碰自家文件）**只覆盖前者**。
后者是 `10-12` 的 **D7 明确说「不取」的形态**。本任务必须**升级契约**，而不是降级架构。

**(b) 信任门** —— 只有 Codex 有（`[hooks.state]` 里的 `trusted_hash`）。
**2026-10-16 实测定案：该门不可自动化**（执行级硬门；hash 输入是 Codex 内部 TOML 序列化，
45 个候选全不匹配；`--dangerously-bypass-hook-trust` 与 `-c bypass_hook_trust=true` 均无效）。
故 Codex 改用 **`notify` 配置**（`config.toml` 的一个数组键，**完全绕过信任门**）。
代价：`notify` 只有 `agent-turn-complete` 一个事件 → Codex **只能覆盖「轮次完成」**，
覆盖不了审批/失败。证据：`10-16-notify-codex/research/codex-trust-spike.md`。

**(c) 上报通道** —— `command`（起短进程，stdin 收 JSON）vs `http`（CLI 直接 POST）。
见 T8。

### T8：`http` 型 hook 看起来最优雅，实际不可用

Claude / CodeBuddy 都支持 `{"type":"http","url":"..."}`（本机 `~/.claude/settings.json` 的
`PermissionRequest` 里就有一条 `http://127.0.0.1:23333/permission`）。直觉上「直接 POST 到
Neeko，零脚本」是最优解。

**但它违反 v5 多实例契约（`10-12` R6.8）**：URL 是**静态字符串**，写死在用户配置里；
而 Neeko 的 ingest 端口是 `bind :0` 每次启动随机、且要求多实例共存。
静态 URL 无法表达「N 个活实例」。要修就得引入稳定端口中继 —— 那会把「多实例共存」
重新变成「单实例争抢」，等于推翻 Phase F 的全部收益。

> **物理判据：坐标是动态的（随机端口 × N 实例），配置是静态的（写死在用户文件里）。
> 二者不可调和 ⇒ 必须有一个运行时解析坐标的中间层 ⇒ `command` hook + shim。**

**副产品**：`command` hook 要求 shim 是**稳定路径**（配置里写死它）。
这正是 `writers` 已有能力（写独立文件 + 首行标记 + 内容寻址版本），零新增机制。

### T9：shim 是三段式的，且 100% 可共享 —— 本任务最大复用点

每个 CLI 的 command hook 上报都是同一件事：

```
读 stdin JSON → 归一为 HookEnvelope → 读坐标目录 → 逐个 POST（fail-open）
```

**关键洞察**：语义 event_key 由 **shim 的 argv** 传入，不由 shim 翻译 CLI 原生事件名。于是：

```
command = <node> "<abs shim path>" <source> <event_key>
```

- shim **零 per-CLI 知识**（不认识 `PermissionRequest` 这类原生名）；
- `(CLI 原生事件名 → event_key)` 映射表完全落在 Rust 数据（`HookEntry`）；
- 新增 CLI = `HOOK_TARGETS` 加一行 + `HookEntry` 复用或新增数据。

**实测支撑**：字段名高度收敛。Codex 二进制的 hook input 字段为
`session_id turn_id agent_id agent_type transcript_path hook_event_name model permission_mode
trigger tool_name tool_input tool_use_id` —— 与 Claude Code 规范**同形**；
CodeBuddy 的类型定义亦明写 `Format matches Claude Code hooks specification exactly`。
故**一个字段提取函数覆盖四家**。

### T10：OMP 暴露了既有事实表的一个表达能力缺口

`HookTarget.dir` 已是 `fn()`，OMP 加一行即可。但
`writers.rs::hook_targets_are_unique` 断言 **file_name 全局唯一** ——
OMP 与 pi 都叫 `neeko-status.ts`（不同目录），该断言会红。

它是一个**过度约束**：真正的不变量是「(目录, 文件名) 不冲突」，而 `dir` 是函数无法比较。
**修正**：只断言 `source` 唯一。这是既有测试的收紧方向错误，属本任务范围内的顺手修正。

### 被剥离的伪需求

| 表面需求 | 为什么是伪需求 |
| --- | --- |
| 「给 6 个 CLI 各写一套通知」 | 3 家（Claude/CodeBuddy/Qoder）共享同一 schema，1 家（OMP）复用 pi 模板，1 家（DSH）不是 hook 问题 |
| 「用 http 型 hook，零脚本」 | URL 静态 vs 坐标动态，与 R6.8 多实例共存不可调和（T8） |
| 「给 DSH 做 hook」 | DSH 无 out-of-process hook 面；已有 bridge，属源 A 延伸 |
| 「Codex 加一行数据就行」 | 需 TOML 合并 + 信任哈希 + 信任提示 UX，是独立机制 |
| 「一个 `cliHooks` 总开关装 6 家」 | Claude/CodeBuddy/Qoder 是**改用户真实配置**，客人义务严重性远高于写独立文件；必须逐 CLI opt-in |
| 「重写 writers 让它支持结构化合并」 | 是**升级**不是重写：`Standalone` 保持现状，新增 `Structured` variant（开闭） |
| 「为结构化合并引入 `Box<dyn ConfigMerger>`」 | YAGNI：形态已知且固定（JSON / TOML 两种），`enum + match` 编译期穷尽即可 |

---

## 2. 跨子任务架构

### 2.1 分期（按物理约束，不按 CLI 名字）

| 期 | 内容 | 新机制 | 归属子任务 |
| --- | --- | --- | --- |
| **P1** | OMP | 无（复用 pi 模板） | `10-16-notify-claude-compat` |
| **P2** | Claude + CodeBuddy + Qoder | ① 共享 stdin shim ② JSON 结构化合并器 ③ 逐 CLI opt-in | `10-16-notify-claude-compat` |
| **P3** | Codex | TOML 数组键的文本级定点改（`InstallShape::NotifyArgv`）+ shim 双来源 | `10-16-notify-codex` |
| **P4** | DSH | 无（源 A 桥投影） | `10-16-notify-dsh` |

P1/P2 同子任务（共享 shim 与合并器骨架，拆开会产生一次性的重复工作）。
P3 独立（TOML + 信任门是正交机制）。P4 独立且正交（可并行）。

### 2.2 高内聚：每个模块只有一个改变理由

| 落点 | 单一职责 | 状态 | 归属 |
| --- | --- | --- | --- |
| `agent/hooks/targets.rs` | 受管 CLI 事实表（**新增** `InstallShape` + `HookEntry` 两个数据维度） | 扩展 | claude-compat |
| `agent/hooks/merger.rs` | **纯函数**：JSON 值进 → JSON 值出，插入/移除自家 hook 条目 | **新增** | claude-compat |
| `agent/hooks/templates/neeko-report.mjs` | **唯一** stdin shim：归一 + 坐标发现 + fan-out POST | **新增** | claude-compat |
| `agent/hooks/writers.rs` | 按 `InstallShape` 分派「文件面」或「结构化合并」；标记/幂等/status/reconcile | 扩展 | claude-compat |
| `agent/hooks/notify.rs` | envelope → signal 投影（**新增** `SESSION_FAILED` arm） | 微改 | claude-compat |
| `agent/hooks/server.rs` | loopback ingest（路由白名单从事实表派生 → 加行自动生效） | **零改动** | — |
| `agent/hooks/attribution.rs` | 归属降级链 | **零改动** | — |
| `notification/**` | 裁决 / 节流 / 合并 / 三层开关 / 投递 / 回流 | **零改动** | — |
| `platform/hook_command.rs` | shim 启动命令的平台渲染（路径分隔符 + 引号规则） | **新增** | claude-compat |
| `agent/hooks/toml_merger.rs` | **纯函数**：`notify` 数组键的**文本级**定点增删（表作用域安全） | **新增** | codex |
| DSH 消费侧落点 | 待定案（新 adapter vs 独立监听，见子任务） | **新增** | dsh |

### 2.3 低耦合：模块间通过什么隔离

- **Rust ↔ shim 的唯一契约 = 三样已存在的东西**：endpoint 文件格式
  （`NEEKO_AGENT_HOOK_PORT` / `NEEKO_AGENT_HOOK_TOKEN`）、HTTP 路由
  （`POST /hook/{source}`）、envelope JSON 字段白名单。**没有第四样**，
  shim 不知道任何 Neeko 内部概念（不 import、不依赖 schema 版本）。
- **merger 是纯 JSON/TOML 变换**：`&mut Value` 进 → `MergeOutcome` 出，零 IO。
  读写 / 原子替换 / 权限继承在 `writers` 外层。可 100% tempdir 单测（红线 13）。
- **依赖方向不变**：`agent/hooks` → `notification` 门面；
  护栏 `check_notification_core_direction` 继续钉死反向依赖（AC1）。
- **`InstallShape` 是 enum + match**：`Standalone` / `Structured` 两个 variant，
  新增第三种形态编译期强制处理（AGENTS.md 开闭原则：策略集已知且固定时用 enum
  而非 `Box<dyn Trait>`）。

### 2.4 高可扩展：未来新增时只加什么

| 未来变化 | 扩展方式 | 核心域改动 |
| --- | --- | --- |
| 新 Claude-Code 兼容 fork（如 jcode） | `HOOK_TARGETS` 加一行 + 目录函数，`entries` 复用 `CLAUDE_COMPAT_ENTRIES` | 否 |
| 新 pi/OMP 系 extension CLI | 加一行（复用 pi 模板） | 否 |
| 新语义事件（如 `session_failed`） | `notify.rs::classify` 加一个 arm + 前端清单加一行 | 否 |
| 新配置面形态（TOML） | `InstallShape` 加 variant → 编译期强制实现 | 否 |
| 新业务域接入通知 | 该域写投影 + 门面挂 3 行 | 否 |

### 2.5 复用清单（最大化复用）

1. **`endpoints/*.env` 坐标 + fan-out**（v5 多实例）—— 直接复用，零改动
2. **`server.rs` ingest**（token / 路由白名单 / fail-open 204）—— 直接复用
3. **`attribution.rs` 归属降级链**（env → cwd 反查 → basename）—— 直接复用
4. **`notify.rs` 投影 + `event_keys` 命名空间** —— 直接复用（三层开关自动生效）
5. **`notification/` 裁决/节流/合并/投递/回流/设置** —— **零改动**（AC1 自证）
6. **`writers.rs` 标记/幂等/status/reconcile** —— 复用，扩展 shape 分派
7. **`platform/private_file`** 原子私有写 —— 复用
8. **pi extension 模板** —— OMP 直接复用（只换目录）
9. **`platform/shell_launch`** 的 shell 选择语义 —— shim 命令渲染复用（红线 2）
10. **orca 已验证的 shim 形态**（借鉴不引码）：稳定 shim 路径 + 文件存在性防御 + 排空 stdin
11. **`10-12` 的 `content_token` 内容寻址标记** —— shim 文件版本判定复用，零改动

---

## 3. 跨子任务数据契约

```rust
// agent/hooks/targets.rs（扩展：+2 个数据维度）

/// 接入形态 —— 决定 writers 走哪条腿。策略集固定 → enum + match（编译期穷尽）。
pub enum InstallShape {
    /// 独立文件即插拔：只写一个受管文件，绝不碰用户既有配置（opencode / pi / omp）。
    Standalone,
    /// 独立 shim 文件 + 结构化插入点：shim 仍是独立文件，
    /// 但需把一条 hook 条目插入用户既有配置（claude / codebuddy / qoder / codex）。
    Structured { entries: &'static [HookEntry] },
}

/// 一条结构化插入点：CLI 原生事件名 → 语义 event_key 的**纯数据映射**。
/// shim 通过 argv 收到 event_key，故 shim 零 per-CLI 事件名知识（T9）。
pub struct HookEntry {
    /// CLI 原生事件名（该 CLI settings schema 的键，如 "PermissionRequest"）。
    pub native_event: &'static str,
    /// matcher 值；`None` = 不写该字段（不是写空串）。
    pub matcher: Option<&'static str>,
    /// 归一后的语义 event_key（与源 A 同命名空间）。
    pub event_key: &'static str,
}

pub struct HookTarget {
    pub source: &'static str,
    pub file_name: &'static str,
    pub template: &'static str,
    pub dir: fn() -> Option<PathBuf>,
    /// 新增。
    pub shape: InstallShape,
}

// agent/hooks/merger.rs（新增：纯函数结构化合并）

/// 合并动作（策略集固定 → enum）。
pub enum MergeAction { Insert, Remove }

/// 合并结果（机器可读，与既有 HookApplyStatus 同族，供前端分类）。
pub enum MergeOutcome { Changed, Unchanged, Removed, Noop }

pub fn apply(
    config: &mut serde_json::Value,
    native_event: &str,
    matcher: Option<&str>,
    command: &str,
    action: MergeAction,
) -> MergeOutcome;
```

**shim 契约（Rust 与 JS 是同一契约的两端，改一端必须同步另一端）**：

```
argv:  <source> <event_key>
stdin: CLI 的 hook input JSON（Claude Code 规范；Codex 字段名同形）
env:   NEEKO_AGENT_HOOK_ENDPOINT / NEEKO_AGENT_HOOK_ENDPOINTS_DIR（调试/夹具覆盖）
出站:  POST http://127.0.0.1:{port}/hook/{source}   header: x-neeko-agent-hook-token
退出:  永远 0
```

**前端类型升级**（`src/shared/types/notification.ts`）：

```ts
// 现状：cliHooks: boolean
// 升级为按 source 的开关数据（R2.6）；eventOverrides 不变（event_key 复用）。
cliHookSources: Record<string, boolean>;   // 默认全 false
```

---

## 4. 红线合规对照

| 红线 | 合规方式 | 归属 |
| --- | --- | --- |
| 2 跨平台 shell | hook command 由 **CLI 的** shell 执行；生成命令的平台差异（路径分隔符/引号）落新增 `platform/hook_command.rs`，不在业务文件平铺 `#[cfg]` | claude-compat |
| 3 阻塞 IO | `merger` 纯函数无 IO；`writers` 的配置读写走既有同步路径（命令层调用，非 async 上下文） | claude-compat |
| 5 Event 名常量化 | 零新增 Tauri 事件（HTTP 出站）；shim 与 Rust 的契约常量沿用既有单一源 | 全部 |
| 6 薄命令 | `agent_hooks_apply/status` 签名保持薄；逻辑在 `writers` / `merger` | claude-compat |
| 8 路径安全 | ingest 仍只绑 `127.0.0.1` + 随机 token；`merger` 不消费前端传入路径（配置路径全部 home 派生） | 全部 |
| 9 mod.rs 极薄 | `merger` / `toml_merger` 只在 `agent/hooks/mod.rs` 加 `pub mod` + `pub use` | claude-compat / codex |
| 10 平台集中化 | 新增 `platform/hook_command.rs`（shim 启动命令渲染） | claude-compat |
| 13 夹具平台无关 | `merger` / `toml_merger` 全部 tempdir 直测，无硬编码绝对路径 | claude-compat / codex |
| 15 差异落数据 | CLI 差异 = `HOOK_TARGETS` 行 + `HookEntry` 数据；通用模块零 CLI 分支 | 全部 |

---

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| **改写用户真实配置**（Claude/CodeBuddy/Qoder/Codex）—— 本任务最大风险 | ① 纯函数 merger 的 4 条不变量测试钉死；② fail-safe 拒绝处理无法解析的配置；③ 逐 CLI opt-in 默认关；④ 写前备份一份 `settings.json.neeko-backup`（子任务决定是否保留） |
| 配置文件并发写（用户同时手动编辑 / CLI 自己写） | temp + 原子 rename；读-改-写窗口极小；不做锁（与既有 endpoint 发布同策略） |
| 权限丢失（`~/.claude/settings.json` 可能非 0644） | 写前 stat 原权限，rename 后显式恢复（R2.5，测试钉死） |
| CLI 事件名随版本漂移 | 沿用 `10-12` 策略：writers 文件头登记实测版本；shim 对未知事件 fail-open；ingest 白名单来自事实表 |
| Codex 信任门无法自动化 | 子任务先 spike；无法自动化则降级为设置页 UX 引导（R5.3） |
| `node` 在用户机不存在（Codex 是 Rust 二进制，无 node 依赖） | shim 需 node；无 node 时不装并回执 `Skipped`（子任务实测决定降级策略） |
| OMP 是否支持 `ui_prompt_start`（pi 模板第 3 条腿）未验 | 子任务 spike；缺则该腿静默失效（不影响另两条腿） |
| 既有 `hook_targets_are_unique` 断言 file_name 全局唯一（T10） | 改为只断言 `source` 唯一 |
| 多实例坐标文件无界累积（`10-12` §7 未解决项） | 本任务**不引入新坐标**（复用同一目录）；该风险不因本任务恶化，仍登记在 `10-12` |

---

## 6. 需要实测钉住的未知项（登记，不猜）

| # | 未知项 | 归属 | 若结论不利的降级 |
| --- | --- | --- | --- |
| U1 | OMP 是否支持 `ui_prompt_start`（pi 模板第 3 条腿） | claude-compat | 该腿不映射，另两条腿仍生效 |
| U2 | `node` 是否可作为 shim 运行时前提 | claude-compat | 无 node → `Skipped` + 设置页提示 |
| U3 | Qoder 的 `hooks` 是否在 `~/.qoder/settings.json` 生效（还是仅插件面） | claude-compat | 仅插件面 → 改走 `.qoder-plugin/` 写入 |
| U4 | Claude `Notification` 事件的 matcher 语义（能否按 `permission_prompt` / `idle_prompt` 过滤） | claude-compat | matcher 不生效 → 该事件不映射（避免误报） |
| U5 | Codex 信任哈希的输入格式（能否自动写入） | codex | **已定案：不可自动化** → 改用 `notify` 通道（绕过信任门），代价是只覆盖「轮次完成」 |
| U6 | Codex `Interrupt` 事件是否为「用户主动取消」 | codex | 无法区分 → 不映射（对齐 R1 的「取消不通知」） |
| U7 | DSH 消费侧归属（新 adapter vs 独立监听；`dsh-neeko` 目前零引用） | dsh | 无可用消费点 → 登记不实施 |

---

## 7. 未来扩展点（登记不实施）

- **E9** 除本任务 6 个之外的 CLI：Gemini / Grok / Reasonix —— 若其 hook 面同 Claude 兼容，
  加一行 `HookTarget`；若无 hook 面，登记不实施。
- **E10** WSL / SSH 远端 agent 的 hook 可达性（沿用 `10-12` 的 E5）。
- **E11** Codex `exec --json` headless 事件流作为 hook 之外的兜底腿（`10-12` E6 同族）。
