# 质量指南

> Rust 后端开发的代码质量标准。

---

## 概述

后端的质量门禁是 **`cargo check`**（CI 三平台）与 **`pnpm lint:rust:all-targets`**
（= `cargo fmt --all -- --check` + `cargo clippy --all-targets -- -D warnings`，local / push / CI 三档共用同一条命令）。
提交档另有一条 lib-only 的快检查 `pnpm lint:rust`（`fmt + clippy lib`，暖缓存 ~10s）——它不再进 CI：
全目标口径已覆盖 lib，重复跑只增延迟。测试是 **`pnpm test:rust`**（本地 push 档与 CI 共用）。

质量门禁配置：
- Clippy lint 级别在 `src-tauri/Cargo.toml` 的 `[lints.clippy]` 和 `[lints.rust]` 段定义
- Strict deny lints 在 `src-tauri/src/lib.rs` 的 `#![deny(...)]` 属性中声明
- Rust 代码格式通过 `src-tauri/.rustfmt.toml` 控制（如存在）或使用默认配置

平台特定代码使用条件编译。

### Pre-Development Checklist（后端平台相关）

> 触及 `src-tauri/src/**/*.rs` 前必检，AI 在 `trellis-before-dev` 阶段注入本指南时逐项确认。

- [ ] **平台判断先行**：本次改动是否新增/修改平台专属逻辑（`target_os = "macos"/"windows"/"linux"` / `unix` / `windows`）？若是，是否已确定主题归属（`platform/<theme>/` 或独立模块 `job_object`/`wsl`）？
- [ ] **定义与使用点同 cfg（平台 cfg 独占消费者）**：平台专属 `use` 引入名 / 局部 `let` 绑定名，是否会被某个平台把全部使用点都编译掉？是则把定义收进唯一消费者的作用域 —— `use` 加同条件 `#[cfg(...)]`，或在被门控的测试函数内**局部 `use`**（最紧作用域，天然不会 unused）；`let` 挪进平台块，或给每个平台补一条真实判据（如 reveal 测试的 Linux 分支）。**`#[cfg(test)]` 模块不是免检区**（`factory.rs` 的 `ExecError`、`instance.rs` 的 `info` 都只被非 Windows 的测试消费 → Windows 红）；成对门控（`#[cfg(unix)]` + `#[cfg(windows)]` 各消费一次）不违规。历史三连：`fonts.rs` 2026-09（Linux/Windows 红）、`commands.rs`/`factory.rs`/`instance.rs` 2026-10（Linux 与 Windows 各红一处）。
- [ ] **Platform Adapter 分层**：多平台/单平台专属实现是否已抽入 `src-tauri/src/platform/<theme>/`（`mod.rs` 仅 `mod` + `pub use` 门控，业务代码无 `#[cfg]` 块）？独立模块（`job_object`/`wsl`）是否豁免但仍保持 import 门控？
- [ ] **门控粒度 ≥ 作用域粒度（测试域硬禁令）**：测试域（内联 `#[cfg(test)] mod tests` / 外部 `#[cfg(test)] mod tests;` 的 `tests.rs` / `#[cfg(all(test, …))]` item）里的平台 `#[cfg]` 是否只挂在 **item 声明**上（整测试 / item 级 gated const / helper）？**禁止**挂在语句 / 裸块 / 断言 / match arm / 字段 init 上 —— 那是 `unused_*` 与「断言在非目标平台静默消失」的共同温床。三条正路：① 平台断言 → 按平台命名的**整测试**（平台维度上移测试名）；② 平台常量 / 夹具 → item 级 `#[cfg]` const / helper（每平台一条真实腿，无腿平台给空 stub，如 `common::testing::make_executable`）；③ 差异本身 → `platform/<theme>/` 适配器数据。护栏 `check_platform_cfg_placement`（判据=附着位置，零容忍）。
- [ ] **本地门禁 ≠ 跨平台门禁**：`pnpm lint:rust`（fmt + clippy）只在宿主机（macOS）跑，平台 `unused_imports` / `unused_variables` 问题需靠 `pnpm guards run --only check_platform_imports`（独占消费者）与 `check_platform_cfg_placement`（门控粒度，已接入 `pnpm lint`）或 CI 三平台矩阵兜底；改动后是否已跑 `pnpm lint`（含两条护栏）且通过？

---

## 保证强度对齐（设计期三问）

> 2026-10 CI 事故的类：**实际保证弱于下游假定保证，差额由环境时序填补**（慢机 / 冷 FS /
> 调度把差额暴露成红）。同一类在本仓出现过三次：写入权凭证、就绪等待、门禁短路。
> 设计任何「异步生产者写共享状态 / 有界等待 / 门禁编排」时先答三问；答案要落到**结构**上
> （类型 / 凭证 / 事件），不落到「记得检查 / 把预算调大」上。
> 不变量台账：`tools/guards/ledger/invariants.json`（三条对应条目）。

1. **写入者问 —— 谁有权写？凭证活多久？状态活多久？**（生命周期对齐）
   - 反例：写权 = 「持有某个 `Arc` 克隆」⇒ 凭证寿命 = 进程，状态寿命 = 挂载周期；
     差额 = 释放后晚到推送复活已作废槽位（macOS 槽位竞态，2026-10）。
   - 正解：写权 = **可失效的显式凭证**（票号 `MountTicket`：私有字段唯一签发方 +
     写入路径签名强制携带 + 释放时先吊销票再删快照）。判据：无凭证写入**编译不过**；
     凭证失效后晚到写入被拒且不 emit。落点：`concurrency-guidelines.md` §后台线程资源所有权 6。
2. **等待者问 —— 我等的是事件还是时间？超时进错误还是进状态？**（强度对齐）
   - 反例：`RECALC_WAIT_TIMEOUT`（1500ms）被当成「必然就绪」的保证 ⇒ 冷 FS 上超时被映射进
     `Err`，测试 `expect` panic（windows-latest，2026-10）。
   - 正解：等待是**延迟优化**（事件驱动 + 预算只防死锁），正确性归推送事件；未就绪是
     一等状态（`WorkspaceActivation::Pending`，serde tag = `state`），**超时不得进入错误空间**
     （pull 分支同步现算 ⇒ 恒 `ready`）。
3. **门禁问 —— 这个信号会被别的信号短路吗？红的时候暴露频率如何？**（独立性与暴露频率）
   - 反例：`backend-test needs backend-check` ⇒ 静态检查红一周，测试信号被隐藏一周，
     测试层 flaky 积压到修复当天才第一次现身（2026-10）。
   - 正解：检查类 job 与证据类 job（test / coverage）**独立并行**（`frontend-build` 早已如此：
     自带 tsc、不 needs check）；护栏 `check_gate_topology` 的 **A4** 判据钉住 `*-check`
     不得出现在 `*-test` / `*-coverage` 的 `needs` 里。

---

## 依赖契约与实际运行时同代（类型假绿）

> 2026-10 `dsh-neeko` 事故的类：**类型检查跑在一份运行时不存在的 API 上**。
> `tsc` 全绿、测试全绿、构建成功 —— 而 `dsh --profile neeko` 启动即崩。

### 事故形态

插件声明并开发依赖 `@deepseek-ai/dsh-*@0.1.0-rc.6/rc.8`，宿主 CLI 实际加载 `0.2.0-rc.2`：

```
类型检查看到的：  dsh-user-questions 0.1.0-rc.8   （devDependencies）
运行时真实加载：  dsh-user-questions 0.2.0-rc.2   （宿主自带 peer）
```

`userQuestions.registerProvider()` 在 rc.8 存在、在 rc.2 已被移除，且 `UserQuestionProvider`
类型在 rc.2 的公开导出里也消失了。于是 `tsc` 通过**毫无意义** —— 它校验的是一份不存在的契约。
同一事故还有两个同族缺陷：`session.events`（属性）→ `snapshotEvents()`（方法）、
`assistant/chunk`（事件）→ `assistant/message` + 独立的 `agent/assistant-stream` 通道。

### 判据（可机器检查）

1. **`peerDependencies` 与 `devDependencies` 必须同代。** dev 依赖落后是假绿的**直接原因**：
   它让类型检查对着旧契约通过。只改 peer 不改 dev 等于没修。
2. **`peerDependencies` 必须能覆盖宿主实际版本。** 写宽范围（`^0.1.0`）而实际只支持
   `0.2.x` 是撒谎；范围如实收窄、并在 README 写明支持代际。
3. **上游包的类型若 import 其自身 devDependency，必须显式补为精确版本。**
   例：`dsh-llm@0.2.0-rc.2` 的 `.d.ts` import `@deepseek-ai/dsh-attachment`，而后者只是它的
   devDep。用 npm `latest`（`^0.0.1-rc.1`）会报 `has no exported member`；必须写 `0.2.0-rc.2`。
4. **API 换代先查权威类型定义，不猜。** 权威源是上游包的 `lib/types/*.d.ts`
   （如 `SessionEventMap`、`AssistantStreamFrame`），不是旧代码、不是文档摘要。
5. **依赖升级后必须从干净 `node_modules` 复验一次。** 增量安装会保留旧解析结果，
   让「版本范围写错」看起来是通过的。
   判据：`rm -rf node_modules && pnpm install && tsc` 必须与增量安装同结果。
6. **子包不得自带 `pnpm-workspace.yaml`。** 它会把自己变成**独立 workspace 根**，
   于是根的 `overrides` / 单实例收敛规则**全部失效**。
   实测：`packages/dsh-neeko/pnpm-workspace.yaml`（原本只为 `dsh plugin install` 绕
   release-age 门禁）导致 `@deepseek-ai/schemastery` 解析出 3.18.4 与 3.18.5 两份，
   两份 `.d.ts` 顶层声明同名类型 → `TS6200` 标识符冲突。而根 `overrides` 根本无法介入。
   修法：删子包 workspace 文件，把需要豁免的包提升到**根** `overrides`（本仓已有
   `@codemirror/view` 先例）。判据：`ls packages/*/pnpm-workspace.yaml` 必须为空；
   同一依赖在 `node_modules/.pnpm/` 下只应有一份。

### 测试形态要求

「能跑通」的测试不足以区分两种实现。反证导向：

- 断言**注册在哪个 seam 上**（`user-questions/request` waterfall），而不只是「某个 provider 被登记」。
- 用**变异验证**测试有效性：把 `next()` 改成不调用（会让每个 agent 永久挂起），
  测试必须变红。本仓实测过：早期版本 58 条全绿而该变异不可见 —— 那就是假绿本身。
- 监听器实现**不要用 `as never` 之类的 cast** 绕过真实签名。能结构化满足真实 `Context`
  的接口才让「用错 API」成为编译错误，而不是运行时崩溃。

### 双来源不变量（流式 + 落盘）

0.2.x 把实时流与持久日志拆成两个来源。**落盘日志不得被当作 delta 源**：
若两边都发，每个 token 双发；若只依赖日志，助手文本全丢。
落盘侧只贡献工具生命周期，实时侧只贡献文本/推理增量。

---

## 代码风格

### 注释风格 —— 中文为主

分段标题使用中文：

```rust
// 项目管理命令
// 终端命令 - 使用 Tauri Events 实现双向通信
// Git 命令
// 持久化命令
```

分段分隔符使用 ASCII 框线：

```rust
// ─── WSL Git 命令 (Windows only) ──────────────────────────────────────────────
// ─── SSH Git 命令 ────────────────────────────────────────────────────────────
```

内联注释以中文为主：

```rust
// 为新项目启动文件监听
// 800ms 去抖，保存时往往触发多次写事件
```

错误消息和日志字符串使用英文：

```rust
"Project not found"
"WSL is only supported on Windows"
```

### 模块可见性

- **所有模块为私有**（`mod name;` 不带 `pub`）
- **模型结构体字段为 `pub`**（模型类型现在按域放在 `*/types.rs` / `common/types.rs` / `core/project.rs`，没有 `state.rs`）
- **Manager 结构体字段为私有**
- **Manager 方法为 `pub`**（需要跨模块访问的）
- **辅助函数为私有**

**Phase B 合规状态**：以下 4 个域已将 `pub mod services` 改为 `mod services`，满足"所有模块为私有"规则：

| 域 | `mod.rs` 可见性 | 外部访问方式 |
|----|----------------|-------------|
| `agent/` | `mod services` | `pub use manager::AgentManager` 间接暴露 |
| `connection/` | `mod services` | `pub use commands::*; pub use types::*` 间接暴露 |
| `terminal/` | `mod services` | `pub mod commands; pub mod remote` 间接暴露 |
| `task/` | `mod services` | `pub use services::*` 显式 re-export |

如果 services 函数需要对外可见，使用 `pub use services::*` 显式 re-export（如 `task/mod.rs`），而非直接公开子模块。

### `#[allow(dead_code)]`

用于仅为 RAII drop 语义而存在的字段：

```rust
#[allow(dead_code)]
debouncer: RecommendedDebouncer,  // 保持存活以便 drop 时清理
```

---

## 平台特定代码

### 条件编译模式

```rust
#[cfg(target_os = "windows")]
#[tauri::command]
fn create_wsl_terminal_session(
    distro: String,
    path: String,
    // ...
) -> Result<TerminalSession, String> {
    // Windows 实现
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn create_wsl_terminal_session(
    distro: String,
    path: String,
    // ...
) -> Result<TerminalSession, String> {
    Err("WSL is only supported on Windows".into())
}
```

### 平台特定工具函数

```rust
// 在 Windows 上隐藏控制台窗口
#[cfg(target_os = "windows")]
fn no_window_cmd(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new(program);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(target_os = "windows"))]
fn no_window_cmd(program: &str) -> Command {
    Command::new(program)
}
```

### Unix 特定的 PTY 配置

```rust
#[cfg(unix)]
{
    // 禁用回显以防止 IME 双重显示
    use libc::{tcgetattr, tcsetattr, ECHO, TCSANOW};
    // ...
}
```

### 平台差异集中化（Platform Adapter 分层）—— 强制
> 适用：**所有平台专属代码**，含两类：
> 1. 多平台实现：同一接口需在 2 个及以上平台（macOS/Linux/Windows）分别实现；
> 2. 单平台专属：仅 macOS / 仅 Windows / 仅 Linux 生效的代码（含 macOS-only 菜单）。
> 目标：把「每个平台必须有实现」从约定变为**编译期强制**——缺一个平台 impl，`mod.rs` 的 `pub use` 在本机直接报错，而非换平台构建才暴露。

**反模式**：
- 在单个函数体内用 `#[cfg]` 块堆叠多平台实现（如 `browser/devtools.rs`、`file/commands.rs`、`lsp/session/utils.rs`、`terminal/process_reaper.rs` 的历史写法）。遗漏某平台时当前平台编译不报错，只有换平台构建才暴露。
- 单平台专属代码内联在通用文件且平台专属 import 未门控（`app_menu.rs` 历史写法：`#[cfg(target_os = "macos")]` 函数 + 顶层未门控 `use tauri::menu::PredefinedMenuItem`）。未门控的平台专属 import 在非目标平台触发 `unused_imports`，被 clippy `-D warnings` 升级为编译错误，2026-08 曾致 Linux/Windows CI 全红。

**正确模式**：按「主题优先、平台次之」抽到 `src-tauri/src/platform/<theme>/`：

```rust
// platform/reveal/mod.rs —— 统一接口 + cfg 选择（编译期强制完整性）
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::*;

/// 统一接口（对外只暴露这一个签名）
pub fn build_reveal_command(path: &Path) -> Option<Command>;
```

**单平台专属主题**（仅 macOS / 仅 Windows / 仅 Linux 生效）同样抽入 `platform/<theme>/`，非目标平台在独立 stub 文件提供**同签名默认实现**（返回 `Ok(None)` / no-op），`mod.rs` 保持纯声明，业务代码无条件调用：

```rust
// platform/menu/mod.rs —— 单平台专属主题（macOS-only Edit 菜单）
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
mod default;
#[cfg(not(target_os = "macos"))]
pub use default::*;
```

```rust
// platform/menu/macos.rs —— 平台专属实现
// 平台专属 import（如 `use tauri::menu::PredefinedMenuItem`）只允许出现在此文件，
// 结构上杜绝其他平台的 unused_imports
pub fn build_edit_submenu(
    handle: &tauri::AppHandle,
) -> tauri::Result<Option<tauri::menu::Submenu<tauri::Wry>>> {
    // ...
}
```

```rust
// platform/menu/default.rs —— 非目标平台默认 stub（与 macOS 实现同签名）
// 必须为 `const fn`：clippy `missing_const_for_fn` 在 `-D warnings` 下强制，
// 且本文件在 macOS 本地不编译，仅 CI 平台矩阵能验证（不可见失败域）
pub const fn build_edit_submenu(
    _handle: &tauri::AppHandle,
) -> tauri::Result<Option<tauri::menu::Submenu<tauri::Wry>>> {
    Ok(None)
}
```

- **`const fn` stub 的参数不得带析构**：`String` / `Vec` / `PathBuf` / `Arc` 等在函数作用域末端
  需要跑 `Drop`，而 const fn 不能求值析构 → 非目标平台报 `E0493: destructor of ... cannot be
  evaluated at compile-time`。因为「必须 const」与「本地不编译」两条同时成立，这类签名在 mac
  上 `cargo check`/`clippy` 全绿、CI 矩阵一编译即红（2026-10-13 实测：
  `platform/system_notify/default.rs` 收 `String` 参数）。**门面签名优先借用入参**（`&str` /
  `&Path`），owned 化留在真正需要 `'static` 的那条平台腿内部做。
- 每个主题一个目录，目录内每平台一个实现文件（`macos.rs` / `linux.rs` / `windows.rs` / `unix.rs`）。
- `mod` 声明与 `pub use` **必须同时 cfg 门控**：非活动平台的模块不编译，避免 `dead_code` 警告（clippy `-D warnings` 会拦截）。各平台实现由 CI 三平台矩阵分别编译验证。
- **平台专属 import 只允许出现在专属实现文件内**（如 `macos.rs` 的 `use tauri::menu::PredefinedMenuItem`）；`mod.rs` 门面与业务代码禁止引入任何平台专属 import，否则非目标平台触发 `unused_imports`。
- 业务代码只依赖 `platform::<theme>::` 统一接口，删除原函数体内的 `#[cfg]` 块。
- 单平台专属主题（macOS-only / Windows-only / Linux-only）同样适用本模式：非目标平台在独立 stub 文件（如 `default.rs`）提供同签名默认实现（返回 `Ok(None)` / no-op），`mod.rs` 保持纯声明，业务代码无条件调用。
- 非目标平台默认 stub **必须声明为 `const fn`**（体为纯 `Ok(None)` / no-op 的常量函数），否则 clippy `missing_const_for_fn` 在 `-D warnings` 下拦截 CI；stub 文件在开发机（macOS）本地不编译，属不可见失败域，由 CI 平台矩阵兜底。
- 平台差异是**编译期确定**的，坚持编译期 cfg + 每平台文件，**不**用运行期 `Box<dyn Trait>`（与「有限策略集用 Enum+match」原则一致：平台差异不是运行期策略）。
- 纯移动迁移：不改变平台逻辑实现，仅移动位置、统一接口。
- 行为正确性由 CI 三平台矩阵（`.github/workflows/ci.yml` 的 `backend-check`/`backend-test`）兜底；本约定只保证「每个平台有实现且能编译」。

**边界**（豁免场景必须同时遵守「import 跟随 cfg」纪律：平台专属 import 必须与其使用点同 cfg 门控，禁止未门控的平台专属 import）：
- 平台专属独立模块（如 `job_object`、`wsl`）——整个模块本身就是平台隔离，等效于 `platform/<theme>/`，无需二次抽取；
- 简单 shell 选择策略——实现仅一行分支且无平台专属 import 时，允许 `#[cfg]` 分支；
- **命令执行 facade 的基础设施豁免（仅这两类，且文件内必须注释说明原因）**：
  - `platform/host_path/*` 的 PATH 引导探测——运行在 `exec_env::init_host_user_path` 之前，不能依赖尚未初始化完成的 `core::exec`；
  - `platform/process_spawn/*` 的 OS 进程原语（进程组 / 树杀 `kill_process_tree`）——同步、fire-and-forget，位于 async executor 之下，走 facade 会形成循环依赖。

  除此之外业务代码一律走统一命令接口（见 `command-guidelines.md`）。
- 其余一律抽入 `platform/<theme>/`。**历史豁免撤销**：macOS 菜单（`app_menu.rs`）原豁免理由「与 Tauri Menu API 深度绑定」不成立——Tauri Menu API 全平台可用，仅 `PredefinedMenuItem` 角色语义为 macOS 专属，恰是平台适配器最佳适用场景，已于 2026-08 迁入 `platform/menu/` 作为正例。

### 应用级通知核心域（`notification/`）—— 业务无关核心 + 业务投影

通知是**跨业务的旁路设施**（不是 agent 专属），其域边界由护栏 `check_notification_core_direction`
强制：核心域（`notification/{types,policy,center,dispatch}.rs`）**禁止 import 任何业务域**
（`agent` / `git` / `terminal` / …，含 `app` 组合根）。判据与护栏 selftest 见 `tools/guards/checks/`。

**分层（依赖方向单向，无环）**：

```text
业务域投影 ──→ notification 核心域 ──→ platform::system_notify
（agent/chat/notify.rs、   （types/policy/center/   （macOS UN 后端 +
 agent/hooks/ingest/       dispatch：纯函数裁决）   插件跨平台回退）
 report.rs）
```

**核心域零业务分支（红线 15 哲学：差异落数据，不落代码）** —— 业务身份只作为**数据**进入核心域：
- `SourceRef{domain, instance_id, origin_label, group_label}` —— 来源身份（`domain`/`origin_label`
  只作文案数据，核心域不对它做 `if domain == "agent"` 之类判断）；
- `event_key` —— 事件语义键（业务域自己维护与前端事件清单的同步）；
- `topic` → `subtitle` —— 会话主题（信号内容，非来源标识；截断由核心域统一负责）。

**新业务域接入通知 = 只在自己域内写投影 + 调核心门面，核心域零改动**。可扩展性钉子
`policy.rs::unknown_future_domain_flows_through_core`（一个非 agent 的 "git" 信号走同一裁决管线
得到正确草稿）钉死这条契约；接入方（agent 两个信号源）落地后核心域 diff 仍为零即自证。

**两个设置开关的分工**（勿合并）：`NotificationSettings.cli_hooks`（核心域）= **主开关**
「用户是否同意装 hook」；`agentHookSources`（agent 域 config）= **逐 CLI 覆盖**。
业务身份（CLI 名字）必须归业务域 —— 写进核心域会让核心域出现 CLI 分支。

---

## 禁止模式

### 1. 在 I/O 操作上使用 `.unwrap()`

```rust
// 错误
let content = fs::read_to_string(path).unwrap();

// 正确
let content = fs::read_to_string(path).context("Failed to read")?;
```

例外：

**A. 内部锁 (`Mutex`) 上的 `.unwrap()` 已逐步迁移**

Phase 4 已将大部分 production `.lock().unwrap()` 替换为以下两种模式：

```rust
// 模式一：锁中毒视为不可恢复（推荐用于内部锁，逻辑不可达）
let sessions = self.sessions.lock().expect("infallible: sessions lock");

// 模式二：优雅处理（用于命令边界，返回 AppError）
let sessions = state
    .project_manager
    .lock()
    .map_err(|e| anyhow::anyhow!("Lock poisoned: {}", e))?;
```

**B. 测试代码中的 `.unwrap()` 可接受**

测试中 `.unwrap()` 保持原样，不做替换。

### 2. 阻塞 tokio 运行时

```rust
// 错误 —— 异步上下文中的阻塞调用
async fn my_command() -> Result<(), String> {
    std::thread::sleep(Duration::from_secs(5));  // 阻塞运行时！
}

// 正确 —— 使用 OS 线程执行阻塞工作
std::thread::spawn(move || {
    std::thread::sleep(Duration::from_secs(5));
});
```

### 3. 公开模块

```rust
// 错误
pub mod terminal;

// 正确 —— 所有模块为私有
mod terminal;
```

### 4. Glob 导入（state 除外）

```rust
// 错误
use terminal::*;

// 正确 —— 显式导入
use terminal::TerminalManager;

// 例外 —— state 类型使用 glob 导入
use state::*;
```

### 5. `if let` 嵌套超过 3 层

连续 3 层及以上 `if let` / `if let ... else if` 必须拍平为单个 `match`——嵌套链的分支归属靠缩进记忆，`match` 让穷尽性在编译期可见。

反向同样成立：只有 1-2 个 happy path 的解构优先用 `if let`，**禁止**为凑格式写出带 `_ => {}` 占位的 `match`——空臂会把未来的新 variant 静默吞掉，正好抵消穷尽性检查。

（原 AGENTS.md 审查红线 7，2026-09-25 迁入本文件；规则索引仍保留在 `src-tauri/AGENTS.md`。）

---

## 必需模式

### 1. 线程必须命名

所有派生的线程必须有描述性名称：

```rust
std::thread::Builder::new()
    .name(format!("pty-reader-{}", &id[..8]))
    .spawn(move || { ... })
    .ok();
```

### 2. 子进程优雅关闭

```rust
// Unix：SIGTERM -> 等待 3 秒 -> SIGKILL
// Windows：等待 3 秒 -> TerminateProcess
fn graceful_kill(child: &mut Box<dyn Child + Send + Sync>) { ... }
```

### 3. 会话关闭时清理事件监听

销毁会话时注销 Tauri 事件监听器：

```rust
app_handle.unlisten(input_listener_id);
```

### 4. 新结构体字段添加 `#[serde(default)]`

始终为新字段添加，以确保与已有持久化数据的向后兼容。

### 5. `mod.rs` 仅保留模块声明

模块根文件 `mod.rs`（或 `name.rs`）不包含业务逻辑，只做模块声明：

```rust
// theme/mod.rs —— 正确
pub mod common;
pub mod opencode;
pub mod pi;
pub mod service;

// task/mod.rs —— 正确
pub mod commands;
pub mod services;

pub use services::*;  // 可选：方便 commands.rs 直接调用 services 函数
```

业务逻辑下沉到子模块（`services.rs`、`types.rs`、`manager.rs` 等）。
新代码统一使用 **`services.rs`**（复数），`service.rs`（单数）是遗留命名方式，仅 `theme/` 域保留。

### 6. 有限策略集使用 Enum 而非 Trait Object

当策略集已知且固定（≤ 5 种），使用 Enum + match 代替 `Box<dyn Trait>`：

```rust
// 正确：Enum 策略模式（零额外依赖，无虚函数调用）
pub enum ThemeStrategy {
    OpenCode,
    Pi,
}
impl ThemeStrategy {
    pub fn all() -> Vec<Self> { vec![Self::OpenCode, Self::Pi] }
    pub fn sync_local(&self, path: &str, theme: &str) -> Result<()> {
        match self {
            Self::OpenCode => opencode::write_project_tui_config(path, theme),
            Self::Pi => pi::write_project_pi_settings(path, theme),
        }
    }
}

// 优势：无需 #[async_trait]，编译期 dispatch，新增 variant 所有 match 必须处理
```

### 7. 文件监听器必须忽略构建产物目录

`common/file/watcher.rs` 的 `should_ignore_path` 是项目级约定，新增多端通用产物目录时必须同步扩展。已在 ignore 列表：`.git`、`node_modules`、`target`、`.DS_Store`（原有）；`dist`、`build`、`.next`、`out`、`coverage`（2026-08-07 因 build 风暴新增）。

**为什么**：`pnpm tauri build` / `pnpm run build` 期间这些目录在秒级产生数千个 Create/Modify 事件，notify watcher 全量转发会**放大**（不导致）`git-changed` 监听侧的竞态——陈旧 store 覆盖的概率与事件风暴成正比。ignore 是减载，不是治本；治本在调用方的 generation 守卫（见 `frontend/state-management.md` 场景 2026-08-07）。

**新增约定**：每加一个项目根或 monorepo 包的构建产物目录名，先查 `should_ignore_path`，再加；不要让 watcher 转发构建产物事件。

---

## 构建与 CI

### 本地开发

```bash
cargo check            # 快速类型检查
cargo clippy           # Clippy lint 检查
cargo fmt --check      # 格式检查
cargo build            # Debug 构建
pnpm tauri dev         # 完整开发环境（前端 + 后端）
```

**macOS 开发态走 dev .app 包装**（`src-tauri/.cargo/config.toml` 的 target runner →
`src-tauri/scripts/macos-dev-bundle.sh`）：`cargo run` 的产物先被包进 adhoc 签名的
`target/dev-bundle/NeekoDev.app` 再执行。原因：`UNUserNotificationCenter` 要求进程有 bundle
身份，裸二进制调用它直接 abort（`bundleProxyForCurrentProcess is nil`）；而回退路径
（插件的 `NSUserNotificationCenter` 底座）在 macOS 26+ 已静默失效 —— 不包装 = 开发态拿不到
任何系统通知。验证：`NEEKO_DEV_BUNDLE_TRACE=1 pnpm tauri dev` 可见
`[dev-bundle] exec …/NeekoDev.app/Contents/MacOS/neeko`；脚本 fail-open，包装失败时打 warn
并裸执行（只是无系统通知，应用内通知不受影响）。逐项实测与最小充分条件见脚本头注释。

**前台横幅必须挂 `UNUserNotificationCenterDelegate`**（2026-10-13 实测，usernoted 日志为证）：
`willPresentNotification` 缺席时系统对前台应用的呈现选项退化为**空集** —— 通知被收下、写进
通知中心，但不弹横幅，且**编译/运行都不报错**：

| 场景 | usernoted 记录 |
|------|----------------|
| 无 delegate + 应用不在前台 | `Presenting … as banner (["badge","sound","alert"])` |
| 无 delegate + 应用在前台 | `Presenting … as banner ([])` ← 静默丢失 |
| 有 delegate + 应用在前台 | `Presenting … as banner (["sound","list","banner"])` |

Neeko 是常驻前台的应用，故 `platform/system_notify/macos.rs` 的 `NotificationDelegate` 不可删；
回归守卫在 `macos.rs` 的 `tests` 模块（断言呈现掩码非空且含 `Banner`、委托确实实现该选择器）。
诊断命令：`log show --last 5m --predicate 'process == "usernoted"' --style compact | grep -i neeko`。

**系统通知授权按 bundleIdentifier 归集、按代码签名身份判真伪**（2026-10-16 实测，故障形态 =
「昨天还好今天没通知」）：`UNUserNotificationCenter` 报 `UNErrorDomain Code=1 (not allowed)`
时，整条投递链（坐标发现 → ingest → token → envelope → policy → dispatch → UN）**全部正确**，
断点只在身份不被信任。两个必须记住的机制：

1. **adhoc 签名不写证书，身份随内容派生** —— 同一个 `.app` 被重装 / 覆盖后身份即变，授权随之失效。
   要让「同一个应用」在多次构建、dev/生产两种形态下共享同一份授权，必须有**一个稳定的身份**。
   最小充分条件是 `.app` + `Info.plist(CFBundleIdentifier)` + 有效 codesign + `lsregister` 注册，
   「有效」从不要求 Developer ID —— 一张自签名代码签名证书即可（免费，无需 Apple Developer 账号）。
2. **重装会抹掉签名** —— 覆盖 `/Applications/Neeko.app` 会连带删掉 `_CodeSignature`，故每次重装或
   `tauri build` 产出新 app 后必须重签：
   `NEEKO_CODESIGN_IDENTITY="<钥匙串里的身份名>" scripts/macos-sign.sh <app路径>`。
   走 `pnpm release` 时 `release.mjs` 已自动带上这步。

**重签后必须重启进程**：只重签不够 —— 运行中的进程仍持旧签名（`_CodeSignature` 变了但已加载的身份
没变），继续 `not granted`；重启后立刻恢复。实测 4/4 `UN accepted` 且跨两次重启仍有效，
**不需要** `sudo tccutil reset`（该命令本身也在受限环境跑不通）。

**身份缺失或漂移时不得静默降级**：`scripts/macos-sign.sh` 未设 `NEEKO_CODESIGN_IDENTITY` 时
`exit 1`（不静默 adhoc）、身份名拼错时列出现有身份供比对；`macos-dev-bundle.sh` 只有 adhoc 可用时
打 warn。**签名不写进 `tauri.conf.json`**：`bundle.macOS.signingIdentity` 只接受字面字符串、
不支持环境变量展开，写死会让所有没建这张证书的机器（含 CI runner 与新克隆开发机）在
`tauri build` 直接失败。

**已知可观测性缺口（未实施）**：签名丢失时没有任何机制提醒，故障形态仍是静默的 ——
日志里只有一行 `UNErrorDomain error 1`。建议的启动自检：进程启动时若发现自己是 adhoc
（`codesign -dv` 无 `Authority`），往 `neeko.log` 打一条明确 warn，把静默复发变成可发现的。
诊断取证（四步，全部可复现）：手工 POST 合法上报 → 得 204 + 看日志；`grep -a "UN accepted"
~/.neeko/neeko.log*` 对比历史最后成功时间；`codesign -dv <app>` 看 `Signature` / `TeamIdentifier`；
`lsregister -dump | grep com.neeko.desktop` 看同 bundle id 的身份竞争者（重装多次会累积多份）。

### 质量门禁脚本

```bash
pnpm lint:rust                  # cargo fmt --check + clippy（后端静态检查单点）
pnpm test:rust                  # cargo test（lib + integration）
pnpm test:rust:coverage         # cargo llvm-cov + 行覆盖率地板（CI 的 backend-coverage job）
pnpm lint                       # 全部静态检查：lint:fe + lint:rust + 全部护栏（tools/guards）
pnpm guards list                # 当前护栏清单 + 各自 stage / scope / 关联红线
pnpm guards run --stage local   # 只跑护栏
```

护栏清单的唯一事实源是 `tools/guards/checks/` 目录本身（放一个模块即完成注册，
不需要改 package.json / CI / lefthook），因此**本文件不复制清单** —— 逐条列出必然滞后
（这里曾长期写着「3 个 Python 护栏」而实际有 6 条）。

- `check_platform_imports.py`：扫描 `src-tauri/src/**/*.rs`，判据 = **平台 cfg 独占消费者**：无平台门控的 `use` 引入名 / `let` 绑定名，若存在一个平台（linux/macos/windows）使其全部使用点都被编译掉则报错。含 `#[cfg(test)]` 模块内的定义（测试不再是免检区），成对门控（unix + windows 各消费一次）不误报；判不了的条件（`feature` 等）与函数参数、`for` 绑定一律放行（宁可少报）。本地单平台 `clippy` 无法发现这类 `unused_imports` / `unused_variables`，靠此护栏在 macOS 本机提前暴露，需与 CI 三平台矩阵互补。
- `check_platform_cfg_placement.py`：扫描 `src-tauri/src/**/*.rs`，判据 = **门控粒度 ≥ 作用域粒度**（结构约束）：测试域内平台 `#[cfg]` 只允许附着 item 声明（`fn`/`mod`/`use`/`struct`/`enum`/`impl`/`trait`/`const`/`static`/`type`/`macro_rules`），附着于语句 / 裸块 / 断言 / match arm / 字段 init 即违规 —— 这是 `unused_*` 与平台断言静默消失的共同结构条件。与 `check_platform_imports` 互补：本护栏是**位置判据**（可完备、零误报），后者是**消费者分析**（语义近似、作兜底）。存量迁移期用 `ledger/platform_test_cfg.json` ratchet（按文件 × `{stmt, block}` 只许减小，台账由模块 docstring 的命令生成）；清零后删除台账即进入**零容忍**。生产域（含派生门控：match arm / 字段 init 镜像 cfg-gated 变体/字段）不在其判据内 —— 需类型平台中立化，属 L1 课题。

### `[lints.clippy]` 配置说明

`Cargo.toml` 中的 lint 分三级：

| 级别 | 含义 | 示例 |
|------|------|------|
| `"deny"` | 编译错误，必须修复 | `cast_possible_truncation = "deny"` |
| `"warn"` | 警告，建议修复 | `missing_docs = "warn"` |
| 未设置 | 使用 clippy 默认 | - |

部分 deny 级别的 lint（如 `cast_possible_truncation`、`wildcard_imports`）在现有代码中存在大量违反，当前使用 `#[allow(...)]` 逐处豁免。新代码应避免引入新违规。

#### `unwrap_used` / `expect_used` 治理状态

两者都在 `Cargo.toml` 的 `[lints.clippy]` 段声明为 **`deny`**：生产码在任何构建里都不允许
`.unwrap()` / `.expect()`（由常规门禁的 clippy 构建保证 —— 它不带 `cfg(test)`，因此看不到测试码）。

| 来源 | 级别 | 说明 |
|------|------|------|
| `Cargo.toml [lints.clippy]` | `deny` | **生产码的唯一强制点**（`unwrap_used` + `expect_used`） |
| `src/lib.rs` 的 `#![cfg_attr(test, allow(...))]` | `allow`（仅 test 构建） | 测试断言天然需要 expect/unwrap；显式豁免使 `cargo clippy --all-targets` 可用（见 gate `lint_rust_all_targets`） |
| `tests/unit.rs` 顶部同名属性 | `allow`（同一口径） | 集成测试是**独立 crate**，`#![deny]` 与豁免都要各自声明 |
| 状态 | ✅ | 生产码新代码不得引入 `.unwrap()`；测试码可用，但确属有意行为时才就地 `#[allow]` + 理由 |

必须用 `allow` 而非 `warn`：源码里的 `warn` 挡不住命令行 `-D warnings`（2026-10-11 实测）。

注意：`missing_docs` 是 rustc lint，必须放在 `[lints.rust]` 而非 `[lints.clippy]` 段。

### `#![deny(...)]` 属性

在 `src-tauri/src/lib.rs` 顶部声明的 deny 属性（与 `Cargo.toml [lints.clippy]` 的 deny 互补，两者**都**生效）：

```rust
#![deny(
    clippy::dbg_macro,
    clippy::todo,
    clippy::print_stdout,
    clippy::wildcard_imports,
    unused_must_use
)]
// 测试码豁免：生产码仍由 Cargo.toml 的 deny 保证（见上表）
#![cfg_attr(test, allow(clippy::expect_used, clippy::unwrap_used))]
```

未能纳入 deny 的 lints（当前保留为 `warn`）：
- `missing_docs`：代码库中大量公开项缺少文档，需要一次专门的文档冲刺才能升为 deny。
- `rust_2018_idioms`：`elided_lifetimes_in_paths` 子 lint 在当前代码库中触发约 46 次，需要单独清理。

### 惯用法：宏内的 `#[allow]` 必须放在函数级别

```rust
// 错误 —— #[allow] 在 params! 宏内不生效
tx.execute(query,
    #[allow(clippy::cast_possible_truncation)]
    params![i as i32, id],
)?;

// 正确 —— 放在函数上
#[allow(clippy::cast_possible_truncation)]
pub fn reorder(&self, ids: &[String]) -> Result<()> {
    tx.execute(query, params![i as i32, id])?;
}
```

### CI 流水线（`.github/workflows/ci.yml`）

在 push/PR 到 `main` 时运行：
- `cargo check`（Windows、macOS、Linux 三平台矩阵，平台编译问题专用）
- `pnpm lint:rust:all-targets` + `pnpm test:rust`（三平台矩阵；与本地 local / push 档同一条命令）
- `pnpm test:rust:coverage`（`backend-coverage`，仅 ubuntu、仅当 PR 动了 `src-tauri/**` 或
  `package.json`；job 常驻而重活条件化，避免 required check 被 skip 卡住合并）
- `pnpm guards run --stage ci`（`ubuntu-latest` 上跑全部护栏；本地 `pnpm lint` 跑 `--stage local`，
  两边集合由护栏自己的 `stages` 声明决定，不再各写一份清单）

### 发布构建

```bash
pnpm tauri build       # 生产环境构建，包含打包
```

---

## 测试

使用 Rust 内置测试框架。详见[单元测试指南](../unit-test/index.md)。

- 单元测试放在同一文件中：`#[cfg(test)] mod tests { ... }`
- 使用 `tempfile` crate 进行文件系统/git 测试（真实临时目录，不是 mock）
- 直接测试 Manager，不测试 Tauri 命令包装层
- 集成测试放在 `src-tauri/tests/`
- 使用 `cargo test` 运行

---

## 依赖

关键依赖及其用途：

| Crate | 版本 | 用途 |
|-------|------|------|
| `tauri` | 2 | 应用框架 |
| `serde` + `serde_json` | 1.0 | 序列化 |
| `tokio` | 1（full） | 异步运行时（主要用于 SSH） |
| `anyhow` | 1.0 | 错误处理 |
| `git2` | 0.18 | Git 操作 |
| `portable-pty` | 0.8 | 跨平台 PTY |
| `russh` | 0.50.0-beta.7 | SSH 客户端 |
| `notify` | 6 | 文件系统监听 |
| `uuid` | 1.6 | ID 生成 |
| `chrono` | 0.4 | 时间戳 |
| `dirs` | 5.0 | 主目录解析 |
| `log` | 0.4 | 日志门面 |

---

## 架构原则（后端）

### 模块设计

1. **单一职责**：一个 Manager 只负责一个领域（Project / Agent / Terminal）。超过 500 行的 Manager 考虑拆分。
2. **模块私有**：所有子模块默认 `mod name;`（私有），通过 `pub use` 选择性暴露接口。
3. **接口隔离**：外部只看到需要的方法，内部实现细节完全隐藏。
4. **策略模式**：策略集已知且固定（≤5种），使用 `Enum + match` 代替 `Box<dyn Trait>`。

### 错误处理

1. **统一错误类型**：所有命令返回 `Result<T, AppError>`，禁止 `unwrap()` 和 `expect()`（测试除外）。
2. **错误链**：使用 `anyhow::Context` 添加上下文信息，便于排查。
3. **错误转换**：`.map_err(AppError::from)` 统一转换。

### 依赖方向

1. **单向依赖**（域内）：`commands.rs` → `services.rs` → `manager.rs` → 该域的 `types.rs`，禁止反向依赖。
2. **跨域访问**：通过 `pub use` re-export 暴露的类型，禁止直接引用其他域的内部模块。
3. **共享基础设施**：`common/` 提供错误、日志、运行时工具，所有域依赖 `common/`。

---

## TDD 要求（后端）

### 开发流程

1. **定义接口**：先写 `pub` 方法签名和返回类型。
2. **编写测试**：覆盖正常路径 + 边界情况 + 错误处理。
3. **确认失败**：`cargo test` 确认红色。
4. **实现功能**：写最少代码让测试通过。
5. **重构优化**：消除重复，保持测试绿色。

### 测试规范

- 测试模块：`#[cfg(test)] mod tests { ... }`，与源文件同目录
- 纯函数：直接调用 + 断言
- Manager 逻辑：使用 `tempfile` 创建真实临时目录
- 每个测试只验证一个行为
- 测试命名：`test_<行为>_<条件>_<预期结果>`

### 覆盖率要求

| 类型 | 最低要求 |
|------|---------|
| 纯函数（parse / format / validate） | 100% |
| Manager 核心逻辑 | 核心路径 100% |
| 错误处理 | 所有错误分支 |
| 序列化（serde） | 往返测试 |

上表是**评审判据**（人工/评审看的是「这条路径有没有测」）；另有一条**可测量的回退地板**：
`pnpm test:rust:coverage`（cargo-llvm-cov）以 `--fail-under-lines` 钉住整仓行覆盖率，由 CI 的
`backend-coverage` job 判定。

首测口径（2026-09-30）：lines **61.75%** / regions 64.29% / functions 57.89%，地板取 **60**
（留 1.75pt，与前端全局地板同理）—— 只防回退，不是目标值。整仓数字被 `theme/*`、多数
`*/commands.rs`（薄命令层，需 Tauri 运行时）拉低，所以**不要**用它衡量单个模块的质量。
新增未测试代码把地板打穿时，正解是补测试，而不是下调地板。
