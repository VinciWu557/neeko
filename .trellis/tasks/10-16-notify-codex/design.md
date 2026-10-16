# Design — Codex 通知接入（`notify` 通道）

> 子任务设计。跨子任务契约（T6–T10、`InstallShape` / `HookEntry` / `MergeOutcome`）
> 见父任务 `design.md`。**前置依赖**：`10-16-notify-claude-compat` 的
> shim（`templates::REPORT_SHIM`）+ `InstallShape` 分派骨架（已实施）。
>
> **⚠️ Step 0 spike 后重写**：原设计的「TOML 合并 + 信任哈希」被实测否决。
> 证据：`research/codex-trust-spike.md`。修订记录见 `prd.md` 文末。

## 1. 为什么 Codex 仍是独立子任务

即便换到 `notify` 通道，Codex 与 Claude 兼容面仍有**三处实质差异**，加一行数据覆盖不了：

| 差异 | Claude 兼容面 | Codex |
| --- | --- | --- |
| 配置格式 | **JSON**（`settings.json`） | **TOML**（`config.toml`） |
| 配置语义 | 按事件名分组的嵌套对象（`hooks.<Event>[]`） | 一个**扁平数组键**（`notify = [...]`） |
| 载荷投递 | **stdin** | **argv[3]** |
| 信任门 | 无 | 无（`notify` 通道）—— 但 `hooks.json` 通道有，故 Codex 的两个通道不可混用 |

前两处要求**新增第三种 `InstallShape` 变体**（TOML 数组键），第三处要求 **shim 支持双来源**。
故仍是独立子任务，但**实施量远小于原设计**（无需信任哈希、无需 TOML 结构化解析）。

## 2. 落点地图

| 文件 | 动作 | 内容 |
| --- | --- | --- |
| `src-tauri/src/agent/hooks/targets.rs` | 扩展 | `InstallShape::NotifyArgv { config_file }` 变体 + `CODEX_TARGET` 一行 + `codex_config_dir()` |
| `src-tauri/src/agent/hooks/toml_merger.rs` | **新增** | **文本级**定点增删 `notify` 数组元素（保内容逐字不变，AC4） |
| `src-tauri/src/agent/hooks/writers.rs` | 扩展 | 按新形态分派（第三分支） |
| `src-tauri/src/agent/hooks/templates/neeko-report.mjs` | **微改** | 支持 argv 载荷（与 stdin 二选一） |
| `src-tauri/src/agent/hooks/mod.rs` | 微改 | `pub mod toml_merger` + `pub use`（红线 9） |
| `src-tauri/src/notification/**` | **零改动** | AC7 |
| `src-tauri/src/agent/hooks/server.rs` | **零改动** | 路由白名单从事实表派生 |

## 3. 数据契约

```rust
// targets.rs
pub enum InstallShape {
    Standalone,
    Structured { settings_file: &'static str, entries: &'static [HookEntry] },
    /// **新增（Codex）**：把 `["<abs shim>", "<source>", "<event_key>"]` 写进
    /// `config_file` 的**数组键**（键名由 [`NotifyArgv::key`] 给）。
    ///
    /// 与 `Structured` 的区别是**语义**而非格式：`Structured` 是「按事件名分组的嵌套对象，
    /// 每个事件一条 matcher 组」；本形态是「一个扁平数组，CLI 自己决定何时调用它」。
    /// 两者的合并算法与 fail-safe 判据都不同，故不能共用一个变体。
    NotifyArgv {
        config_file: &'static str,
        /// 承载数组的 TOML 键（`"notify"`）。
        key: &'static str,
    },
}

// toml_merger.rs（纯函数，零 IO）
pub enum TomlMergeOutcome { Changed, Unchanged, Removed, Noop }

/// 在 TOML **文本**里增删 `notify` 数组中的自家条目。
///
/// **为什么是文本级而非解析-重序列化**：`config.toml` 含用户敏感内容与个人格式
/// （本机有 `experimental_bearer_token`）。`toml::to_string` 会重排键序、丢注释、
/// 改引号风格 —— 逐字不变（AC4）无法保证。文本级定点操作把改动面限制在
/// **一行/一个数组**，其余字节原样搬运。
pub fn apply_notify(
    toml_text: &str,
    key: &str,
    entry: &[String],      // ["<abs shim>", "codex", "turn_completed"]
    action: TomlMergeAction,
) -> (String, TomlMergeOutcome);
```

**`notify` 的文本形态**（实测，Codex 写入/读取的都是标准 TOML 数组）：

```toml
notify = ["/abs/path/neeko-report.mjs", "codex", "turn_completed"]
```

**识别自家条目**：数组中**首元素**以 `SHIM_MARKER`（`neeko-status.mjs` / `neeko-report.mjs`）
结尾，且为绝对路径。判据与 `merger.rs` 的路径段判据同源。

**shim 的 argv 契约增量**（R2.1）：

```
Claude 面:  argv = [<shim>, <source>, <event_key>]          载荷来自 stdin
Codex  面:  argv = [<shim>, <source>, <event_key>, <json>]   载荷来自 argv[3]
```

shim 的解析顺序：**先看有没有第 4 个参数且以 `{` 开头** → 用它；否则读 stdin。
（`source` / `event_key` 的取法两路完全一致 → shim 仍零 per-CLI 知识。）

## 4. `toml_merger.rs` 的算法（文本级）

```
apply_notify(text, "notify", entry, Insert):
  1. 定位 `notify` 键所在行（行首 `notify` + `=`，允许前导空白）
     - 不存在 → 在文件末尾追加一行 `notify = ["<...>"]`（前置换行）
     - 存在但不是数组 → Noop（fail-safe，原样返回）
  2. 解析该行的数组元素（最小 TOML 数组解析：双引号字符串 + 逗号分隔；
     支持尾随逗号；不支持的形态 → Noop）
  3. 按 shim 标记找自家元素
     - 恰一条且 == entry → Unchanged
     - 否则：移除全部自家元素 + push entry（收敛）
  4. 只重写**那一行**，其余字节原样拼接
```

**边界**（每条一个测试）：

- 键不存在 → 追加（文件末尾无换行时先补换行）；
- 键存在但值非数组（字符串 / 表）→ `Noop`；
- 数组跨多行（TOML 允许）→ 本次**不支持**，判 `Noop`（宁可不装也不误改）；
- 数组内含他人条目 → 逐字保留；
- 用户用单引号字面量字符串 → 按字面解析，重写时保留其原引号风格（**或**判 `Noop`，
  实施期取最简且安全的一侧）；
- 空数组 `notify = []` → 视为「无自家条目」，插入后为一条。

**为什么不用 `toml_edit`**：它虽保留格式，但仍是「解析整文档 → 重新渲染」，
对**注释与空白的保留**有已知边界；而本任务的需求窄到「一行数组的增删」，
文本级实现更小、更可预测、且可 100% 单测（红线 13）。YAGNI。

## 5. writers 分派（第三分支）

```
install_at(target, dir)
  match target.shape
    Standalone            → 既有实现
    Structured{...}       → 既有实现
    NotifyArgv{config_file, key} →
      1. 读 {dir}/{config_file}（不存在 → Skipped，不创建；与客人义务一致）
      2. render_report_command 拿 shim 路径与 node（None → Skipped）
      3. toml_merger::apply_notify(text, key, ["<node> <shim>", source, event_key], Insert)
         Noop → Skipped（fail-safe 命中，detail 说明）
      4. Changed → write_atomic_preserving_mode（权限继承）
```

> **shim 数组的首元素**：`notify` 数组的第 0 项是**可执行路径**，第 1+ 项是参数。
> 但 `render_report_command` 产出的是**一整条命令字符串**（含 node + 引号）。
> 两处形态不同 → `notify` 的首元素应是 **node 可执行路径**，第 1 项是 **shim 路径**，
> 第 2/3 项是 `source` / `event_key`（Codex 直接 exec，不经 shell）。
> 这样**不需要引号**（argv 逐项传递），比 shell 字符串更干净。
> 实施期据此定稿；`platform/hook_command` 需补一个「argv 形态」的渲染函数
> （现有 `render_report_command` 产出 shell 字符串，供 Claude 面用）。

**status 语义**：`installed` = `config.toml` 里存在一条自家 `notify` 条目；
`version_current` = 该条目与当前期望 argv 完全一致（shim 内容哈希**不参与** ——
`notify` 指向的是路径而非嵌入内容，故无「文件过期」概念；若 shim 内容变了，
行为自然跟着变，无需重装）。**这是与 `Standalone` 的实质差异，需在测试里钉死。**

## 6. 红线合规

| 红线 | 落点 |
| --- | --- |
| 2 跨平台 shell | `notify` 是 argv 数组（不经 shell）→ 引号/分隔符问题**消失**；node 解析复用 `platform/hook_command::resolve_node` |
| 3 阻塞 IO | `toml_merger` 纯函数；IO 在 writers |
| 5 Event 名常量化 | 零新增 Tauri 事件 |
| 6 薄命令 | `agent_hooks_apply/status` 签名不变 |
| 8 路径安全 | 只碰 `~/.codex/config.toml`（home 派生）；不消费前端路径 |
| 9 mod.rs 极薄 | `agent/hooks/mod.rs` 加 `pub mod toml_merger` + `pub use` |
| 10 平台集中化 | node 解析复用既有 `platform/hook_command`；无新增平台分支 |
| 13 夹具平台无关 | `toml_merger` 全部 tempdir/字符串直测 |
| 15 差异落数据 | Codex 差异 = `InstallShape::NotifyArgv` 数据 + 一行事实表 |

## 7. 风险

| 风险 | 对策 |
| --- | --- |
| **损坏用户 `config.toml`**（含 token，最严重） | 文本级定点操作 + fail-safe（不支持形态一律 `Noop`）+ 权限继承 + AC4 逐字不变测试 |
| `notify` 语义随 Codex 版本变化 | 事实表行注释登记实测版本（0.162.1）；shim 的 `type` 白名单 fail-open |
| 只能覆盖「轮次完成」 | **如实登记**（R4 / AC2 已下调）；不假装覆盖审批 |
| 用户已有自己的 `notify` | 数组内他人条目逐字保留（AC5） |
| 数组跨多行 / 单引号风格 | 判 `Noop`（宁可不装也不误改），detail 说明 |
| 无 node | `Skipped`（与 claude-compat 同判据） |

## 8. 遗留（登记不实施）

- **Codex 审批通知**：唯一路径是 `hooks.json` 的 `PermissionRequest` + 用户 TUI 确认一次
  （信任哈希由 Codex 自己写）。若产品需要，另立任务：Neeko 只写 `hooks.json` 条目、
  **不写** hash，并在设置页给引导文案。
- **`notify` 的其他事件类型**：本次仅实测到 `agent-turn-complete`。
  若 Codex 未来增加类型，在 shim 的 `type` 白名单加一行即可。
