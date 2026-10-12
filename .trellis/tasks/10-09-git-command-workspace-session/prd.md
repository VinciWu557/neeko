# git 命令按 WorkspaceSession 对象寻址（对象化收敛）

> **状态**：规划中（未动代码）。术语以 [`docs/domain-model.md`](../../../docs/domain-model.md) 为准；
> `WorkspaceSession` 的语义界定见前置任务 `10-09-file-io-workspace-scope` 的 `design.md §3`。

## Goal

让「这次 git 操作发生在哪个 Workspace」这个信息，**从前端到后端只有一种表示、一个构造点、
一个解析点**：前端地址只能是 `WorkspaceSession` 值对象（不可手搓、不可拆成两个独立字段），
后端命令只收该对象、只经 `AppStateWrapper::resolve_workspace_target` 一个入口解析。

> 形态等价（`projectId` + `worktreePath` ↔ `WorkspaceSession`），属 DRY / 一致性收敛，**不改 git 语义**。

## Background（第一性原理：为什么这不是"机械改名"）

一次 git 操作的真值依赖是 `(Workspace, 操作)`。地址必须能表达「哪个 Workspace」，且不能比这更少。
当前架构有三处与该真值不符的结构，它们共同构成"改签名的真实收益"：

**F1 · 前端地址可被手搓（最主要）**
`gitApi.ts` 的 68 个函数首参是 `projectId`、次参是 `worktreePath?: string | null`。后者是
**可选且默认错**的参数（漏传 → 静默按主仓执行）—— 与前置任务已根治的 file 域 `rootPath`
事故**同构**：file 域当年正是"按 projectId 寻址、按 checkout 作用"导致 worktree 场景静默失效。
`ProjectCommands`（`commandFactory.ts`）虽已收 `WorkspaceSession`，但它只是激活项目的窄面投影
（`use-active-project/index.ts:32`），**挡不住 `gitApi.ts` 这条主路径**。

**F2 · 后端双字段可独立出错**
Tauri 命令收 `(project_id, worktree_path)` 两个独立参数 → wire 上它们是两个可分别缺失/错配的
字段。file 域改收单个 `workspace` 对象后，「漏传地址分量」在协议层不可能；git 域仍停留在
"两个字段靠调用方自觉对齐"。

**F3 · 解析入口未收口**
git 域 64 个命令各自调 `state.resolve_workspace(&project_id, worktree_path.as_deref())`；
`resolve_workspace_target(&WorkspaceSession)`（`app_state.rs:183`，已存在且委托同一实现）
**只有 file 域在用**。同一解析逻辑有两个外观，将来改校验/归一/错误文案要改两处。

### 事实基线（2026-10-12 实测，`rg` 可复现）

| 事实 | 证据 |
| --- | --- |
| 后端 git 命令 64 个，**0 个**收 `WorkspaceSession` | `rg "#\[tauri::command\]" -A2 src-tauri/src/git/commands/*.rs` → 64；`rg "workspace: WorkspaceSession" src-tauri/src/git/` → 0 |
| file 域 8 个命令 **100% 已收口** | `rg "workspace: WorkspaceSession" src-tauri/src/file/commands.rs` → 8 |
| 前端两条调用路径**能力不对等** | `gitApi.ts` 68 个导出 vs `ProjectCommands` 31 个方法；`gitApi` **独有 37 个**能力（PR / worktree / gh 认证 / `stageAll` / `checkoutDetached` …） |
| `gitApi.ts` 被 **32 个文件**引用；`ProjectCommands` 只有 1 个构造点 | `rg -l` |
| `gitApi.ts` 的散签**确有非激活项目的真实需求** | `GitCommitPanel.tsx:183` 传 `project.id` → `CommitDialog.tsx:26` 收 `projectId` prop（面板可操作非当前激活项目） |
| wire 契约 `workspace_key` 已定且不变 | `10-08-workspace-naming` 决策；`workspace_ref.rs:40-49` serde = `{projectId, worktreePath}` |
| `WorkspaceSession` 是 **class + 私有构造**，`JSON.stringify` 产出 `{projectId, worktreePath}` | `src/shared/utils/workspaceRef.ts:67-105`（getter 挂原型不入 wire，载荷与改造前逐字节一致） |

## Requirements

### R1 前端命令面收对象（F1）

- R1.1 `gitApi.ts` 全部函数首参从 `projectId: ProjectId` 改为 `workspace: WorkspaceSession`；
  内部解构 `const { projectId, worktreePath } = workspace` 后 **wire 载荷形态逐字不变**
  （仍是 `{ projectId, worktreePath }`，与 file 域一致）。
- R1.2 **保留两条前端路径**（`gitApi` 完整命令面 + `ProjectCommands` 激活项目投影）——
  它们能力不对等（37 个独有能力），合并是退化不是收敛。`ProjectCommands` 内部改为**委托
  `gitApi`**，不再各自 `invoke`（消灭第三套 invoke 形态）。
- R1.3 调用点地址只能来自身份源：`activeWorkspaceSession(projectId)`（store）、
  `WorkspaceSession.of(...)` / `fromKey(...)` / `fromKeyOrId(...)`（值对象静态工厂）。
  **禁止**在生产代码手搓 `{ projectId, worktreePath }` 字面量（class 私有构造已挡住大多数，
  此处补纪律 + 护栏兜底）。

### R2 后端命令收对象（F2）

- R2.1 `src-tauri/src/git/commands/**`（64 个）与 `src-tauri/src/agent/commands_commit.rs`
  的 `generate_commit_message`：`(project_id, worktree_path)` → `(workspace: WorkspaceSession)`。
- R2.2 解析统一走 `state.resolve_workspace_target(&workspace)`；`resolve_workspace(&str, Option<&str>)`
  保留为内部实现（`resolve_workspace_target` 委托它），**不删**（DAP / watcher 等域在用）。
- R2.3 **只涉及 Workspace 寻址的命令**改签名。`worktree.rs` 里的 `create_worktree` /
  `remove_worktree` / `rename_worktree` 等**操作对象是 worktree 自身**（参数是 worktree 名 /
  路径，不是"在哪个 workspace 执行"）—— 逐个判定，不机械全改。

### R3 护栏（防回退）

- R3.1 扩展 `check_file_io_scope` 或新增 `check_workspace_session_addressing`：`src/` 内
  git 命令调用点不得出现裸 `worktreePath` 作为独立实参传给 git 命令；生产代码不得出现
  `{ projectId, worktreePath }` 字面量冒充地址（class 私有构造之外的双保险）。
- R3.2 后端判据：`src-tauri/src/git/commands/**` 与 `agent/commands_commit.rs` 内不得再出现
  `resolve_workspace(` 调用（唯一入口是 `resolve_workspace_target`）。

### R4 契约与文档

- R4.1 `docs/domain-model.md`「寻址根 vs 展示根」段补 git 域一行（当前只写了文件 IO）。
- R4.2 `.trellis/spec/backend/git-domain.md` 登记：git 命令寻址契约 + `resolve_workspace_target`
  唯一入口 + R2.3 的"操作对象是 worktree 自身"例外判据。

## Acceptance Criteria

- [x] **AC1 前端无散签**：`gitApi.ts` 中 `worktreePath` 仅剩 C 类豁免形参（`createWorktree` /
      `removeWorktree` / `isWorktreeDirty`，其 `worktreePath` 是被操作的目标；`renameWorktree`
      的 `oldPath`/`newPath` 同理）；其余全部首参为
      `workspace: WorkspaceSession`（`pnpm type-check` 保证）。
- [x] **AC2 后端无散签**：`rg "worktree_path: Option<String>" src-tauri/src/git/commands/ src-tauri/src/agent/commands_commit.rs`
      → **0 命中**；worktree 操作命令的 `worktree_path: String` 是**被操作目标**（非 `Option` 散参）。
- [x] **AC3 唯一解析入口**：`rg "resolve_workspace\(" src-tauri/src/git/commands/ src-tauri/src/agent/commands_commit.rs`
      → **0 命中**（worktree 操作命令内部也经 `resolve_workspace_target` —— 见 `git-domain.md` §15.1）。
- [x] **AC4 wire 形态与 file 域同形**（**修正**：原写"字段名集合不变"不准确）：地址载荷从平铺
      `{projectId, worktreePath}` 改为 **嵌套** `{ workspace: { projectId, worktreePath }, … }` ——
      与 file 域逐字同形，是后端收 `workspace: WorkspaceSession` 的必然结果（Tauri 按名反序列化）。
      `workspace` 内部的**分量名不变**；测试只改**期望载荷形状**，断言语义（命令名 / 数据）未变。
- [x] **AC5 行为零变更**：`guards run --stage local` **25/25 全绿**（含 `test_rust` / `test_fe` /
      `test_host`）；`cargo test --lib` **1555 passed / 0 failed**（与迁移前同数）。
- [x] **AC6 护栏命中归零且自身有测试**：`check_workspace_session_addressing` 在 `--stage local` 与
      `--stage ci` 均 **0 违规**；16 条负例/正例测试（含 `as WorkspaceSession` 伪造、散参形参、
      worktree 例外、合法 wire 载荷不误报、A1 无条件直调、A2 收对象却按 project 解析）。
- [x] **AC7 单一 invoke 面**：`commandFactory.ts` 的 `invoke(` → **0 命中**（纯委托 `gitApi`）。

## Out of Scope

- **不改 git 语义 / 行为**：`resolve_workspace` 的校验与归一逻辑逐字不动。
- **不动 wire 契约名**：`workspace_key` 持久化字段与事件载荷保持不变；`WorkspaceSession` 的 serde
  仍是 `{projectId, worktreePath}`（分量名不变）。命令参数从「两个平铺字段」变为「一个
  `workspace` 对象」（嵌套，与 file 域同形）—— 前后端同二进制、同批发布，无需兼容期。
- **不动 DAP / watcher / terminal 域**的寻址（它们已各自收口或不在本次范围）。
- **不合并 `gitApi` 与 `ProjectCommands`**（见 R1.2：能力不对等，合并是退化）。
- 前端 UI 结构、文案零改动。

## 已消解的开放问题（2026-10-12 规划期决策）

| 问题 | 决策 | 理由 |
| --- | --- | --- |
| `gitApi.ts` 68 个函数是"收对象"还是"保持散签 + 只加护栏"？ | **收对象** | 散签的 `worktreePath?: string \| null` 是"可选且默认错"的参数形态（F1），护栏只能拦不能消除；file 域已用 `WorkspaceSession` 根治同构问题，git 域分叉会让同一风险两种处置 |
| `ProjectCommands` 是否并入 `gitApi`？ | **不并入，改为委托** | 两者能力不对等（37 个独有能力只在 `gitApi`）；`ProjectCommands` 的价值是"激活项目零参投影"，保留该价值但去掉它自建的第三套 `invoke` |
| 后端 `worktree.rs` 的 worktree 操作命令是否也改签名？ | **逐个判定，多数不改** | `create_worktree(name)` 等操作对象是 worktree 自身，参数语义不是"在哪个 workspace 执行"；机械全改会把地址对象塞给不需要它的命令（YAGNI） |
