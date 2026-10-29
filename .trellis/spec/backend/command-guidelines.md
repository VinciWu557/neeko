# 命令指南

> 本项目中 Tauri 命令的定义和组织方式。

---

## 概述

所有 `#[tauri::command]` 函数按领域拆分到模块中。完整清单维护在 `lib.rs` 的 `neeko_invoke_handler!` 宏内，由 `app/boot.rs` 以 `.invoke_handler(...)` 挂载。

---

## 命令结构

### 同步命令（标准模式）

```rust
#[tauri::command]
pub fn add_project(
    path: String,
    agent_id: Option<String>,
    ide: Option<String>,
    state: State<AppStateWrapper>,
    app_handle: tauri::AppHandle,
) -> Result<Project, AppError> {
    let mut pm = state.project_manager.lock().unwrap();
    // ... 业务逻辑 ...
    Ok(project)
}
```

### 异步命令（仅用于 SSH/Skill 操作）

```rust
#[tauri::command]
pub async fn create_remote_terminal_session(
    host: String,
    port: u16,
    username: String,
    auth: AuthMethod,
    project_path: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppStateWrapper>,  // 异步命令需要显式生命周期
    app_handle: tauri::AppHandle,
) -> Result<TerminalSession, AppError> {
    // ... 异步 SSH 逻辑 ...
}
```

### 关键规则

0. **MCP 模块已从 skill/ 拆分**：MCP 相关命令（server CRUD、tag group、project bindings、registry、test）现位于独立的 `mcp/commands.rs`，不再与 skill 命令混合。参照此模式，后续新增资源类域（如 `prompt/`、`action/`）也应考虑独立模块。
1. **命令实现按领域放在 `commands/` 子模块**，由 `commands/mod.rs` 聚合导出，并在 `neeko_invoke_handler!` 宏中集中注册
2. **返回类型始终为 `Result<T, AppError>`** —— 不使用裸类型，不使用 `String`
3. **状态访问** 通过 `state: State<AppStateWrapper>` 参数
4. **Mutex 锁** 使用 `.lock().unwrap()` —— 锁中毒视为致命错误
5. **异步** 仅在命令需要异步 I/O 时使用（SSH 操作、Skill spawn_blocking）
6. **显式生命周期** 异步命令中需要 `State<'_, AppStateWrapper>`

---

## 状态访问模式

### AppStateWrapper

```rust
pub struct AppStateWrapper {
    project_manager: Mutex<ProjectManager>,
    terminal_manager: TerminalManager,
    remote_terminal_manager: RemoteTerminalManager,
    agent_manager: Mutex<AgentManager>,
    storage_manager: StorageManager,
    active_project_id: Mutex<Option<String>>,
    watcher_manager: WatcherManager,
    skill_store: Arc<skill::skill_store::SkillStore>,
}
```

### 何时使用 Mutex

- **用 `Mutex` 包裹**：需要外部修改的 Manager（project_manager、agent_manager、active_project_id）
- **直接存储**：自带内部同步机制的 Manager，使用 `Arc<Mutex<HashMap>>`（terminal_manager、remote_terminal_manager、watcher_manager、storage_manager）

### 命令中的访问模式

```rust
#[tauri::command]
fn some_command(state: State<AppStateWrapper>) -> Result<(), AppError> {
    // Mutex 包裹的：先获取锁再使用
    let mut pm = state.project_manager.lock().unwrap();
    pm.do_something();

    // 直接访问的：Manager 自行处理同步
    state.terminal_manager.create_session(...);

    Ok(())
}
```

---

## 命令组织

命令按领域拆分到各模块的 `commands.rs` 中：

| 领域模块 | 命令文件 | 数量 | 主要领域 |
|----------|----------|------|----------|
| `project/` | `commands.rs` | ~15 | 项目 CRUD、视图模式、project color |
| `project/commands_ide.rs` | `commands_ide.rs` | ~3 | IDE 启动（三端） |
| `git/` | `commands.rs` | ~40 | stage/unstage、commit、branch、worktree、PR、file ops |
| `terminal/` | `commands.rs` | ~7 | 本地/WSL/SSH 终端 create/close/resize |
| `connection/` | `commands.rs` | ~5 | WSL 枚举、SSH 测试/目录列表 |
| `agent/` | `commands.rs` + `commands_commit.rs` | ~6 | Agent CRUD、commit message |
| `session/` | `commands.rs` | ~8 | save/load 会话、配置、VCS 设置 |
| `browser/` | `commands.rs` | ~12 | WebView 创建、导航、元素选择器 |
| `task/` | `commands.rs` | ~5 | Task CRUD、run/stop |
| `file/` | `commands.rs` | ~1 | `reveal_in_file_manager` |
| `settings/` | `commands.rs` | ~1 | `get_system_fonts` |
| `theme/` | `commands.rs` | ~1 | `sync_agent_theme` |
| `skill/` | `commands.rs` | ~25 | Skill CRUD、tag 管理、安装、同步 |
| `skill/` | `commands.rs` | ~8 | **Prompt CRUD**（`list_prompts` / `get_prompt` / `save_prompt` / `update_prompt_cmd` / `delete_prompt_cmd` / `use_prompt_cmd` / `resolve_slash_prompt` / `get_all_prompt_tags_cmd`） |

### commands.rs → services.rs 委派模式

对于不依赖 `AppStateWrapper` State 的纯 I/O 逻辑，`commands.rs` 委派给同域的 `services.rs`：

```rust
// connection/commands.rs —— 极薄包装层
#[tauri::command]
pub fn get_wsl_distros() -> Result<Vec<String>, AppError> {
    services::get_wsl_distros()
}
```

```rust
// task/commands.rs —— 更薄的包装（services 通过 re-export 暴露）
#[tauri::command]
pub fn get_task_configs(project_path: Option<String>, ...) -> Result<Vec<TaskConfig>, AppError> {
    let configs = crate::task::get_all_task_configs(project_path.as_deref());
    Ok(configs)
}
```

对于需要访问 `AppStateWrapper` 的 Stateful 命令，命令仍然保留完整逻辑或委派给 Manager：

```rust
// terminal/commands.rs
#[tauri::command]
pub fn create_terminal_session(...) -> Result<TerminalSession, AppError> {
    // Stateful: 需要访问 state.terminal_manager
    state.terminal_manager.create_session(...).map_err(AppError::from)
}

// connection/commands.rs —— SSH 命令通过 Manager
#[tauri::command]
pub async fn test_remote_connection(...) -> Result<(), AppError> {
    state.remote_terminal_manager.test_connection(...).await.map_err(AppError::from)
}
```

**何时委派给 services.rs vs Manager**：

| 条件 | 委派目标 | 例子 |
|------|----------|------|
| 不需要 State、无 Tauri IPC | `services.rs` | `get_wsl_distros`、`get_all_task_configs` |
| 需要 Manager 内部状态 | Manager 方法 | `terminal_manager.create_session` |
| 需要 Tauri IPC (emit/listen) | 命令函数直接处理，或传入 `AppHandle` | `close_terminal_session`（emit close event） |

详见 [`directory-structure.md`](./directory-structure.md) 的 §services.rs 模式。

---

## 命令边界的错误处理

所有内部错误在命令边界转换为 `AppError`：

```rust
#[tauri::command]
fn some_command(state: State<AppStateWrapper>) -> Result<Project, AppError> {
    let result = state.project_manager
        .lock().unwrap()
        .do_something()
        .map_err(AppError::from)?;  // anyhow::Error -> AppError
    Ok(result)
}
```

对于业务逻辑错误，使用显式 `AppError` 变体：

```rust
.ok_or_else(|| AppError::NotFound(format!("Project not found: {}", project_id)))?
```

详见[错误处理](./error-handling.md)。

---

## 前端调用方式

前端通过 Tauri IPC 调用命令：

```tsx
// 前端（TypeScript）
import { invoke } from "@tauri-apps/api/core";

const project = await invoke<Project>("add_project", {
  path: "/some/path",
  agentId: null,
  ide: null,
});
```

注意：Tauri 会自动将 camelCase 的 JS 参数转换为 snake_case 的 Rust 参数。错误返回类型为 `AppError`（序列化为 JSON 对象），前端可以按 `error` 字段处理。

---

## 命令边界的两条硬约束

### 1. Command 层保持极薄

`#[tauri::command]` 只做三件事：参数接收、反序列化校验、调度 manager/service。Git、SSH、PTY 的核心控制逻辑一律下沉（委派写法见上文「commands.rs → services.rs 委派模式」）。

原因：命令层是 IPC 契约面，逻辑平铺在这里会让同一能力无法被非命令入口（worker、setup 恢复流程）复用，且每个新调用点都要重抄一遍错误处理。

### 2. 单次返回的 JSON 不超过 2MB

Diff 视图、PTY 缓冲区、大目录列表这类文本量不确定的载荷，禁止整体序列化为 JSON 返回：

- 走 Tauri 二进制流（`Response::new(Vec<u8>)` + 前端 `invoke<ArrayBuffer>`），或
- 前端按需分页/虚拟滚动，只取可见区间。

原因：JSON 会把 `Vec<u8>` 展开成数字数组，实测膨胀约 6 倍。已有事故：`PTY 4KB read → emit(Vec<u8>) → JSON number[] → listen → term.write()` 全链路无界，WebContent 8.7 分钟膨胀至 5.2GB——完整链路与正确实现见 `concurrency-guidelines.md` 的终端 drain 场景。

（原 AGENTS.md 审查红线 4、6，2026-09-25 迁入本文件；规则索引仍保留在根 `AGENTS.md` 与 `src-tauri/AGENTS.md`。）

---

## 注册新命令

1. 在对应域模块中定义命令函数

2. 在聚合导出处导出函数

3. 将命令路径加入 `neeko_invoke_handler!` 命令清单

```rust
// src-tauri/src/lib.rs —— neeko_invoke_handler! 位于 lib.rs 中
#[macro_export]
macro_rules! neeko_invoke_handler {
    () => {
        tauri::generate_handler![
            // ... existing commands ...
            $crate::project::commands::your_new_command,
        ]
    };
}
```

`app/boot.rs` 保持 `.invoke_handler(crate::neeko_invoke_handler!())` 固定调用。

---

## 配置驱动的功能门控

当后端行为（包括非命令路径如 PTY 创建、SSH 连接）需要受用户配置开关控制时，使用以下模式：

### 读取配置的辅助函数

配置读取函数放在 `src-tauri/src/theme/opencode.rs`（或 theme 域其他合适模块）中，从 `~/.neeko/config.json` 读取布尔字段，缺失/失败默认返回 `false`：

```rust
// src-tauri/src/theme/opencode.rs
/// 从 ~/.neeko/config.json 读取 enablePiThemeSync 字段
/// 默认返回 false（如果读取失败或字段不存在）
pub fn read_enable_pi_theme_sync() -> bool {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return false,
    };
    let config_path = home.join(".neeko").join("config.json");
    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(_) => return false,
    };
    let config: serde_json::Value = match serde_json::from_str(&content) {
        Ok(c) => c,
        Err(_) => return false,
    };
    config
        .get("enablePiThemeSync")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}
```

### 调用点门控

在 PTY 创建、SSH 连接等非命令路径中使用：

```rust
if crate::theme::opencode::read_enable_pi_theme_sync() {
    if let Err(e) = crate::theme::pi::write_project_pi_settings(path, &theme) {
        log::warn!("[PTY] Failed to write Pi settings.json: {}", e);
    }
}
```

### 命令内部使用

命令中可以同样读取配置来门控：

```rust
#[tauri::command]
pub fn sync_agent_theme(theme: String, targets: ProjectThemeTargets) -> Result<(), AppError> {
    if crate::theme::opencode::read_enable_pi_theme_sync() {
        // Pi 主题同步逻辑
    }
    Ok(())
}
```

### 关键规则

1. **默认值必须是安全选择**：`unwrap_or(false)`——字段未设置时默认为关闭
2. **静默失败不影响主流程**：配置读取失败不报错，门控内操作失败仅 warn 日志
3. **不与 `State<AppStateWrapper>` 耦合**：配置读取函数不依赖 Tauri state，使得在非命令路径（PTY/SSH 会话创建、`theme/service.rs`、`app_menu.rs` 等）也可用
4. **前端对应 TypeScript 字段**：在 `src/shared/types/settings.ts` 的 `AppConfig` 中同时声明，由 `save_config`/`load_config` 持久化
---

## 场景：Prompt 资源命令契约 2026-07-29

### 1. Scope / Trigger
- Trigger：新增 Prompt 资源类型（`prompts` 表），需要 CRUD + slash 解析 + usage 追踪
- Scope：`src-tauri/src/library/`（skill 与 prompt 已并入 library 域：`library/skill/`、`library/store.rs`、`library/migrations.rs`）

### 2. Signatures

```rust
#[tauri::command]
pub fn list_prompts(project_path: Option<String>) -> Result<Vec<PromptRecord>, AppError>

#[tauri::command]
pub fn get_prompt(prompt_id: String) -> Result<PromptRecord, AppError>

#[tauri::command]
pub fn save_prompt(prompt: PromptRecord, project_path: Option<String>) -> Result<PromptRecord, AppError>

#[tauri::command]
pub fn update_prompt_cmd(prompt: PromptRecord) -> Result<PromptRecord, AppError>

#[tauri::command]
pub fn delete_prompt_cmd(prompt_id: String) -> Result<(), AppError>

#[tauri::command]
pub fn use_prompt_cmd(prompt_id: String) -> Result<(), AppError>

#[tauri::command]
pub fn resolve_slash_prompt(slash: String, project_id: Option<String>) -> Result<Option<PromptRecord>, AppError>

#[tauri::command]
pub fn get_all_prompt_tags_cmd() -> Result<Vec<String>, AppError>
```

### 3. Contracts
- Request fields:
  - `PromptRecord`：`id`、`name`、`description`、`content`、`slash`（可选）、`tags_json`（JSON 数组）、`scope`（`"global"` | `"project"`）、`project_id`（可选）、`variables_json`（可选）、`favorite`、`usage_count`、`last_used_at`、`created_at`、`updated_at`
  - `project_path`：用于解析项目级 scope
- Response fields：`PromptRecord` 或 `Vec<PromptRecord>`
- Slash 解析契约：
  - `resolve_slash_prompt` 先查 project scope（`project_id` 匹配），未找到再查 global scope
  - 项目级 **覆盖** 全局同名 slash（不是合并）

### 4. Validation & Error Matrix
| Condition | Expected Behavior | Error / Risk |
|---|---|---|
| `save_prompt` 成功 | 返回完整 `PromptRecord`（含生成的 id） | 无 |
| `save_prompt` 缺少 name/content | 校验失败 | `Err(AppError::Validation(...))` |
| `get_prompt` 未找到 | 返回 `Err(AppError::NotFound(...))` | 前端显示空状态 |
| `delete_prompt_cmd` 成功 | 返回 `Ok(())`，级联删除 tags | 无 |
| `resolve_slash_prompt` 未匹配 | 返回 `Ok(None)` | 前端保留原文 |
| DB 操作失败 | `map_err(AppError::from)` | `Err(AppError::Storage(...))` |

### 5. Good/Base/Bad Cases
- Good：创建 Prompt（含 slash），通过 `resolve_slash_prompt` 命中
- Base：创建 Prompt（不含 slash），仅出现在列表
- Bad：同名 slash 在 project 和 global 同时存在 — project 级覆盖全局

### 6. Tests Required
- Unit：`save_prompt` → `get_prompt` 往返一致
- Unit：`resolve_slash_prompt` 项目覆盖全局
- Unit：`delete_prompt_cmd` 后 `get_prompt` 返回 NotFound
- Integration：v3→v4 migration 创建 `prompts` 表

### 7. Wrong vs Correct
#### Wrong
```rust
// 只查 global，忽略 project 覆盖
let prompt = get_prompt_by_slash(&slash, None)?;
```
#### Correct
```rust
// 先查 project，再 fallback global
let prompt = get_prompt_by_slash(&slash, Some(project_id))?
    .or_else(|| get_prompt_by_slash(&slash, None)?);
```

---

## 常见错误

### 1. 忘记将命令加入 `neeko_invoke_handler!` 清单

命令会编译通过，但前端无法调用。

### 2. 使用裸返回类型而非 `Result<T, AppError>`

```rust
// 错误 —— 前端无法处理错误
#[tauri::command]
fn get_info(state: State<AppStateWrapper>) -> Project { ... }

// 正确
#[tauri::command]
fn get_info(state: State<AppStateWrapper>) -> Result<Project, AppError> { ... }
```

### 3. 跨 await 点持有 Mutex 锁

```rust
// 错误 —— 死锁风险
let pm = state.project_manager.lock().unwrap();
some_async_call().await;  // 锁在 await 期间被持有！

// 正确 —— await 前释放锁
let data = {
    let pm = state.project_manager.lock().unwrap();
    pm.get_data().clone()
};
some_async_call().await;
```

### 4. 缺少 Windows 专用命令的平台存根

每个 WSL 命令都需要一个非 Windows 的存根：

```rust
#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn some_wsl_command() -> Result<(), AppError> {
    Err(AppError::Wsl("WSL is only supported on Windows".to_string()))
}
```

### 5. 在 `commands/mod.rs` 中忘记导出子模块

```rust
// commands/mod.rs
pub use project::*;  // 必须显式导出，否则命令注册宏无法引用
```

---

## 对称 Rust + 渐进前端 caller 模式 2026-05-19

### 适用场景

实现 per-project 元数据（如 `selected_agent`、`selected_ide`、`avatar_color`）时，往往需要在 Local / WSL / SSH 三端 schema 上加同一个字段。Rust 侧的**对称 setter 命令**（`set_<field>` / `wsl_set_project_<field>` / `remote_set_project_<field>`）通常一次落齐三端，**但前端 caller 可以渐进落地**——例如本期 MVP 仅暴露 Local 入口，WSL/SSH UI 留待后续。

这种"Rust 三端对齐、前端单端 caller"是允许的，但必须在 PRD 与代码注释中显式标注以避免后续审计误判 dead code。

### 契约

1. **三个对称命令必须全部注册到 `neeko_invoke_handler!`**，即使前端暂未调用——保证后续接前端 caller 时是"加一行 invoke"而不是"改 Rust + 改宏 + 加 invoke"。
2. **PRD 显式标注 caller 状态**：在 PRD 的"实施范围"或"取舍点"小节列出"暂无前端 caller 的 Rust 命令"。
3. **任务汇报中标注**：`trellis-implement` / `trellis-check` 汇报里要把这些命令明确列为"保留作未来扩展"，避免被误判为 dead code 删除。
4. **不通过 `#[allow(dead_code)]` 标记**：这些命令是公开 Tauri 命令，已经被 `tauri::generate_handler!` 引用，不会触发 dead_code 警告。

### 反模式

❌ **只实现 Local setter，wsl/remote 等用到再补**：会导致后续接 wsl UI 时需要回头改 Rust schema + 命令 + 宏注册三处，增加事故面。

❌ **三个 setter 都不注册到 `neeko_invoke_handler!`**：等到接前端 caller 时一并注册——容易遗漏。

### 实例

`avatar_color` 任务（`05-19-project-avatar-color-customization`）：
- Rust：`set_project_color` / `wsl_set_project_color` / `remote_set_project_color` 三端对齐，全部注册到 `neeko_invoke_handler!`
- 前端：MVP 仅 `ProjectPanel.tsx`（Local 子面板）调用 `set_project_color`；`wsl_set_project_color` / `remote_set_project_color` 暂无 caller
- PRD 显式标注："UI override 入口 MVP 仅 Local"
- 后续接 WSL/SSH UI 时只需加 `invoke` 调用，无需回头改 Rust

### 何时 *不* 适用

- 命令明显只属于某一端（如 `wsl_get_distros`），不存在"三端对齐"诉求
- 字段只在一端持久化（如 SSH-only `saved_auth`）

---

## 终端分屏会话契约 2026-04-17

### 变更文件

> 路径已按当前目录更新（该契约写于 2026-04-17，此后后端按领域重组；`commands/`、`storage.rs`、`models/` 均不存在）。

- `src-tauri/src/session/commands.rs`（`save_session` / `load_session` / `save_config` / `load_config` 命令）
- `src-tauri/src/session/manager.rs`（落盘与读取实现）
- `src-tauri/src/session/types.rs`（`*Session` struct）

### 命令签名

`save_session` 当前签名：

```rust
#[tauri::command]
pub fn save_session(
    wsl_entries: Vec<WSLEntrySession>,
    remote_entries: Vec<RemoteEntrySession>,
    sidebar_width: Option<u32>,
    worktree_state: Option<std::collections::HashMap<String, String>>,
    state: State<AppStateWrapper>,
) -> Result<(), AppError>
```

### 字段契约

- 已移除字段：`side_terminal_width`
- 持久化字段保留：`sidebar_width`、`worktree_state`
- `SessionStore` 必须与前端 `src/shared/types/session.ts` 的 `SessionStore` 同步

### 校验与错误矩阵

| 场景 | 输入 | 期望行为 | 错误输出 |
|------|------|----------|----------|
| Good | `wsl_entries`、`remote_entries` 正常数组，`worktree_state` 为 `Some` | 正常保存 sessions.json | 无 |
| Base | `worktree_state=None` | 使用已有 `SessionStore.worktree_state` | 无 |
| Bad | `state.project_manager` 锁失败 | 立即返回错误 | `Err(AppError::LockPoisoned(...))` |
| Bad | 序列化或写文件失败 | 返回 `AppError::Storage(...)` | `Err(AppError::Storage(...))` |

### Good/Base/Bad 用例

- Good：`src-tauri/tests/unit/storage_test.rs::save_and_load_session_with_projects`
- Base：`src-tauri/tests/unit/state_test.rs::session_store_defaults_for_missing_fields`
- Bad：命令层通过 `map_err(AppError::from)` 覆盖，测试关注返回 `Result::Err`

### 必测断言点

- `SessionStore` 默认反序列化不再包含 `side_terminal_width`
- `create_session_from_projects` 签名与调用点已同步为 4 个业务参数
- `save_session` 命令参数与前端调用参数名保持一致

---

## 场景：二进制字节读取的 range 契约 2026-10-29

### 1. Scope / Trigger

- Trigger：图片预览与 PDF 预览需要「文件字节」而非文本；红线 4 要求二进制不走 JSON，
  且 PDF 的 xref 在文件尾部 ⇒ 打开即随机访问，整读大文件既不可能也不必要。
- Scope：`src-tauri/src/common/file/reader.rs`（`FileAddress` / `local_join` / `join_remote_path` /
  `canonical_in_scope`）、`common/file/reader_bytes.rs`（`read_file_bytes` / `read_file_size`）、
  `src-tauri/src/file/commands.rs`（`resolve_file_target` + 三个薄命令）。

### 2. Signatures

```rust
// 寻址：所有文件读取形态共用同一份「环境 + 基准 + 路径」
pub struct FileAddress { pub target: ExecTarget, pub base: String, pub path: String }
impl FileAddress { fn new(target, base, path) -> Self; fn absolute(target, path) -> Self }

pub const DEFAULT_MAX_CHUNK: u64 = 1024 * 1024;   // **至多返回**这么多字节

pub struct FileBytesRequest {
    pub address: FileAddress,
    pub offset: Option<u64>,      // None = 从文件头
    pub len: Option<u64>,         // None = 读到文件尾（仍受 max_chunk 收敛）
    pub max_chunk: u64,           // 单次载荷上界
}
impl FileBytesRequest { fn head(address) -> Self }   // 整读的首段形态

pub async fn read_file_bytes(scope: FileAccessScope, req: FileBytesRequest) -> Result<Vec<u8>, AppError>
pub async fn read_file_size(scope: FileAccessScope, address: FileAddress) -> Result<u64, AppError>

// 命令层（唯一寻址助手 → 三个薄命令）
async fn resolve_file_target(state, workspace, file_path, base: Option<String>)
    -> Result<(FileAddress, FileAccessScope), AppError>

#[tauri::command] pub async fn read_file_bytes(workspace, file_path, base: Option<String>,
    offset: Option<u64>, length: Option<u64>, state) -> Result<tauri::ipc::Response, AppError>
#[tauri::command] pub async fn read_file_size(workspace, file_path, base: Option<String>, state) -> Result<u64, AppError>
```

### 3. Contracts

1. **返回形态**：命令返回 `tauri::ipc::Response::new(Vec<u8>)`（前端 `invoke<ArrayBuffer>`），
   永不 JSON 序列化字节（红线 4）。
2. **range 是主形态，整读是特例**（不传 offset/len）—— 小文件与大文件共用同一入口，
   禁止再造「整读命令 + 分片命令」两条路径。
3. **载荷上界 = 单次「至多返回」`max_chunk` 字节，不是「超限拒绝」**。
   请求超过上界一律**短读**（收敛），调用方按返回长度推进 `offset` 续读。
   把上界实现成报错会把分片循环推给每个调用方、并逼两端复制同一个常量：
   实测后果是「远程图片 > 1MB 直接失败」与「pdf.js range 静默截断后永久挂起」。
   禁止新增「文件太大不支持」这类上限，也禁止消费侧复制 `DEFAULT_MAX_CHUNK`。
4. **越界语义分明**：`offset > size` → 显式报错（唯一保留的错误分支）；
   尾部区间越过文件尾 → 裁到剩余量。
5. **寻址只有一份定义**：`FileAddress` 由 `reader.rs` 定义，文本请求与字节请求都内嵌它；
   命令层的解析（`resolve_file_target`）是**唯一**入口，禁止各命令自拼
   「resolve target + 拼 scope + 取根」。`base` 缺省 = Workspace 根，
   显式传入时是「md 文件目录 / skill 目录」这类更细的基准。
6. **拼接按目标环境语义分流**（`local_join` / `join_remote_path`）：
   Local 用宿主 `Path::join`；WSL/SSH 用 **POSIX 串拼接**（`/` 绝对路径不参与 base，
   base 去尾分隔符）。**远端路径禁止用宿主 `Path` 拼** —— Windows 宿主上
   `/home/u/x` 不是 absolute 且会拼出 `\`，远端 shell 拿到坏路径（远程读写/预览全挂的根因）。
7. **scope 与 canonicalize 复用** `reader.rs` 的 `canonical_in_scope` / `apply_scope`
   （`pub(super)`）—— Local 的文本读取、字节读取、大小探测共用一份实现（红线 8）。
8. **短读处理**：Local 用 `take(want).read_to_end` 而非 `read_exact` —— 文件在读取中途被
   截断时返回实际字节，而不是让整个预览失败。
9. **通道**：Local `std::fs` seek+read 包 `spawn_blocking`（红线 3）；WSL/SSH
   `dd if=… iflag=skip_bytes,count_bytes skip=… count=…`（argv 形态经 `core::exec`，红线 1/2）。
   `iflag` / `stat -c` 依赖 GNU coreutils：WSL 与主流 Linux 满足，**BSD/macOS 远端不支持**
   （以 stderr 原文报错，不静默返回短数据）；移植性改造单独立项。

### 4. Validation & Error Matrix

| 场景 | 期望 | 错误 / 风险 |
|---|---|---|
| 整读小文件 | 返回全部字节 | — |
| `offset`+`len` 区间 | 精确窗口 | — |
| `len` 越过文件尾 | 裁到剩余量 | 报错会让尾页永远失败 |
| `offset > size` | `AppError::File("beyond file size")` | 静默空会被当成空文件 |
| 请求 > `max_chunk` | **短读**（返回 `max_chunk` 字节） | 报错即把分片义务推给调用方 |
| `max_chunk = 0` | 返回空 | 调用方续读循环必须能因「0 字节」终止 |
| 路径越出 root | `AppError::File("outside root")` | 红线 8（`base` 不是逃逸通道） |
| 远端 POSIX 绝对路径 + 非空 base | base 被忽略 | 用宿主 `Path::join` 会拼出坏路径 |
| 远程 `dd` 非零退出 | 携带 stderr 的错误 | 静默截断数据更危险 |

### 5. Good/Base/Bad Cases

- Good：`read_file_bytes(InProject{root}, FileBytesRequest { offset: Some(off), len: Some(rest), ..FileBytesRequest::head(addr) })`
- Base：图片整读的首段 —— `FileBytesRequest::head(FileAddress::new(target, md_dir, "img/a.png"))`
- Bad：新开 `read_file_binary` 命令做整读、`read_file_range` 命令做分片（两次实现同一件事）；
  `max_chunk` 超限时 `Err("chunk limit")`（把常量对齐变成跨栈隐式契约）

### 6. Tests Required

- `common::file::reader_bytes::tests`（夹具路径由 `tempdir()` 推导，红线 13）：整读 / range /
  读到尾 / 尾部越界裁剪 / 越界 offset 报错 / **超上界短读** / **连续短读重组整文件** /
  空文件 / InProject 越界 / **base 逃逸 root** / Trusted 放行 / 文件大小 / `plan_range` 收敛边界（纯函数）。
- `common::file::reader::join_tests`：`join_remote_path` 的 POSIX 语义（不含 `\`、绝对路径忽略 base、
  尾分隔符与前导 `./` 归一）与 `local_join` 的宿主语义 —— 钉住「远端寻址与宿主平台无关」。
- 前端侧：`shared/api/fileBytes` 的续读循环用例（见 `frontend/api-layer.md` 同名场景）。

### 7. Wrong vs Correct

#### Wrong
```rust
// ① 整读 + 上限拒绝：500MB PDF 直接不可用，且 >1MB 的远程图片全部失败
#[tauri::command] async fn read_pdf(path: String) -> Result<Vec<u8>, AppError> {
    let bytes = std::fs::read(path)?;          // 红线 3 + 红线 4 双违反
    Ok(bytes)
}
// ② 远端路径用宿主 Path 拼
let full = Path::new(&base).join(&rel);        // Windows 宿主 ⇒ "/home/u/p\src/a.rs"
```
#### Correct
```rust
let (address, scope) = resolve_file_target(&state, &workspace, file_path, base).await?;
let bytes = reader_bytes::read_file_bytes(
    scope,
    FileBytesRequest { offset, len: length, ..FileBytesRequest::head(address) },
).await?;
Ok(tauri::ipc::Response::new(bytes))            // 二进制流；短读由前端续读补齐
```
