# 终端/任务运行根按 Workspace 寻址（cwd 由 session 派生 + 三环境统一）

> 关联：`docs/domain-model.md`（App → Project → Workspace）、10-12-terminal-insert-workspace-scope
> （终端寻址身份迁移）、`.trellis/spec/backend/git-domain.md` §15（git 命令 `WorkspaceSession` 寻址契约）。

## 背景：运行根是 Workspace 级，却被当成 Project 级

交互终端、测试 Run/Debug、任务运行（Task Console）三条链路都需要一个「进程运行目录 cwd」。
cwd 的正确身份是 **`workspace.root = session.worktreePath ?? project.path`**（`WorkspaceRef::root()` 同义），
但现状三条链路口径不一，任务运行链路直接用了 Project 级属性：

| 链路 | cwd 来源 | 状态 |
| --- | --- | --- |
| 交互终端（local） | `session.worktreePath ?? activeProject.path`（`strategies/index.ts:74`） | ✅ local 已迁移；**WSL/Remote 白传**（`router.rs:131/161` 丢弃 `working_dir`） |
| 测试 Run/Debug | `runCwdOf(ctx)` = `activeWorkspaceRoot ?? ctx.projectPath`（`runner/exec/context.ts:34`） | ✅ |
| **任务运行 Task Console** | **`activeProject.path`**（`shared/store/taskStore.ts:416`） | ❌ **未迁移（本任务要修）** |

用户可见症状：worktree 下点 Run Task（npm scripts 等），命令实际在**主仓**执行 —— 作用于错误的工作树、
污染主仓 git 工作区、构建/缓存产物落错位置；worktree 的**交互终端在 WSL/Remote 下同样拿不到 worktree cwd**。

### 根因（双端各半个洞）

- **前端**：`taskStore.runTask` 的 cwd 缺省 `options?.cwd || activeProject.path || ''`，从不读
  `workspaceStore.activeCheckoutPath`；`createTaskTerminal` / `TaskRunButton` 任务发现同用 `activeProject.path`。
- **后端**：`create_terminal_session(project_id, …, working_dir)` 身份是 `project_id`，cwd 是前端传的
  **不透明字符串**；`manager.rs:99` `let cwd = working_dir.as_deref().unwrap_or(project_path)` 把缺省
  **静默 fail-open 到主仓**；WSL/Remote 分支**完全忽略 `working_dir`**（worktree 维度在这两类环境无解）。

只改前端一行是止血：命令边界仍是 project 身份 + 可选裸路径，WSL/Remote 仍错，下一个调用方仍可重犯。
这与 10-12 的「终端缓存键手搓」、2026-09-26 的「git status 未分槽」是同一 defect family —— 用 Project 级
值冒充 Workspace 级值。根治须把「运行根」提升为 **Workspace 寻址**：命令边界收 `WorkspaceSession`，
后端唯一解析。

## Goal

终端与任务的**运行根统一由 Workspace 身份派生**：命令边界只接受 `WorkspaceSession`，后端经
`resolve_workspace_target` 解析出 `WorkspaceRef::root()` 作为 cwd 缺省；三环境（Local/WSL/Remote）
同构；无可派生根时显式失败，禁止静默回落主仓。

## Requirements

**R1 · 后端命令身份化（唯一解析入口）**
`create_terminal_session` 首参由 `project_id: String` 改为 `workspace: WorkspaceSession`；内部
`state.resolve_workspace_target(&workspace).await?` → `(target, repo)`，**禁止**调 `resolve_project(`。
`repo.root()` 即本次会话缺省 cwd。前端的 `terminalApi.createTerminalSession` /
`taskApi.startTaskProcessSession` 同步改首参 `workspace: WorkspaceSession`（invoke 载荷 `{ workspace, … }`）。

**R2 · 三环境统一承接运行根**
把解析出的 `workspace_root`（= `repo.root()`）传到三个传输分支，作为各自的 cwd 基线：
- Local：`working_dir.unwrap_or(workspace_root)`（`manager.rs` 缺省不再是 `project_path`）；
- WSL：`wsl --cd` 目标改为 `working_dir.unwrap_or(workspace_root)`（当前恒 `project_path`）；
- Remote：SSH 会话 `cd` 目标改为 `working_dir.unwrap_or(workspace_root)`（当前恒 `project_path`）。

`working_dir` 保留为可选覆盖（语言 runner 的模块子目录 cwd，如 java/go 模块根）。覆盖值语义 = 该
Workspace 内绝对路径；后端须校验其位于 `repo.root()` 之内（越界 → `InvalidInput`，不静默）。

**R3 · 任务运行链路按 session 派生 cwd**
`taskStore.runTask` 内部取 `activeWorkspaceSession(activeProject.id)`，把 session 传给
`startTaskProcess`；cwd 缺省 = 该 session 的运行根（**不再读 `activeProject.path` 作缺省**）。语言 runner
的 `options.cwd` 覆盖保留。`TaskRun.projectPath`（console 头部 / git console session id / 展示）改为
记录 workspace root。`TaskRunButton` 的**发现/展示** path 改为 workspace root；**配置存储/CRUD**
保持在项目根（`<project>/.neeko/tasks.json`，跨 worktree 共享，见「非目标」）。

**R4 · 交互终端链路收口**
`strategies/index.ts` 三环境分支统一传 `session`；**删除前端自算的 `projectPath`
（`session.worktreePath ?? activeProject.path`）** —— 运行根改由后端从 session 解析（前端不再持第二份运行根）。
交互终端不传 `working_dir`（无子目录需求）。

**R5 · 前端运行根唯一派生点**
前端不得再出现「项目级 path 当运行根」的缺省。任务侧统一经
`workspaceRootOf(activeWorkspaceSession(projectId).key, activeProject.path)`（`shared/utils/workspaceRef.ts` 既有唯一 mint）。
`runner/exec/context.ts` 的 `runCwdOf` 改为委托同一 mint（消除第二处派生）。`runner/exec/context.ts`
中名为 `activeWorkspaceRoot` 的函数实际返回 **worktreePath（可空）**，语义易混 —— 本任务**不改其名**
（DAP 调用面广，改名属独立重构），但需在 `runCwdOf` 处不再重复拼装。

**R6 · 死代码清理（随迁移删除，不迁移）**
- 后端 `run_task` 命令（`task/commands.rs:71`，直调 `local().create_session` 绕过 router）与前端
  `taskApi.runTask`（零消费者，`rg` 确认）→ **删除**（含 `lib.rs` 注册）。
- 确认零引用后删除。

**R7 · 护栏**
新增 `tools/guards/checks/check_terminal_run_root.py` + 同名测试
`tools/guards/tests/test_check_terminal_run_root.py`（`checks/` 目录自动注册）：
- **G1（后端身份）**：`src-tauri/src/terminal/**` 内 `fn create_terminal_session` 必须带
  `workspace: WorkspaceSession` 形参；带该形参的函数体内不得调 `resolve_project(`（A2 同构）。
- **G2（后端禁 fail-open）**：`src-tauri/src/terminal/**` 不得出现 `unwrap_or(project_path)`
  （主仓静默回落形态）。
- **G3（前端禁裸 project 运行根）**：`src/features/terminal/**` 与任务运行链路不得把
  `activeProject.path` / `project.path` 作为 `workingDir` / `runTask` cwd 传入（形态级，作用域收窄）。

## Acceptance Criteria

- [x] 后端 `create_terminal_session` 首参 = `workspace: WorkspaceSession`，只经单一解析入口
  （`resolve_workspace_target_with_env`，与 `resolve_workspace_target` 同核）；
  `rg "resolve_project\(" src-tauri/src/terminal/` 命令层零命中；
- [~] Local 终端/任务在 worktree 下 cwd = worktree 根 —— **单测已闭**（`taskStore.runRoot.test.ts`
  断言 cwd == 工作树路径且≠项目根；`resolve_terminal_cwd` 纯函数四态），**真机待验**（见下）；
- [~] WSL / Remote 分支的 cwd/cd 目标改为 workspace root —— 代码层已统（三分支消费同一已解析
  `cwd`）；“router 注入断言”**降级为 env-blind 纯函数覆盖**（WSL/Remote 分支起真实 PTY/SSH，
  不可注入；design §R2 / implement §18 允许该降级），**真机待验**；
- [x] 任务运行缺省 cwd 不再等于 `activeProject.path`（worktree 激活时 `runTask` 的 cwd = 工作树路径）；
- [x] `strategies/index.ts` 三环境不再自算 `projectPath`；`"session.worktreePath ?? activeProject.path"` 归零；
- [x] `runCwdOf` 与任务侧共用单一 mint（新增 `activeWorkspaceRootOf` / `useActiveWorkspaceRoot` 委托 `workspaceRootOf`）；
- [x] `run_task` / `taskApi.runTask` 零残留（含 `lib.rs` 注册表）；
- [x] 新护栏 `check_terminal_run_root` 生效（G1–G4，13 条自测）；`pnpm lint` 全绿；
- [x] `pnpm test:fe` / `pnpm test:rust` 全绿；`pnpm check` 27/27 全绿。

**三轮复审超出原 PRD 的额外收口（已实现 + 已测）**
- [x] 任务拆除不再绕过路由：`stop_task` 原先 `terminal_router.local()` 直连，对 SSH 会话永远关不掉
  且泄漏 `owners` 登记；现走 `close_session`（`take_owner` 路由 + 释放），并由护栏 G4 +
  `close_session_releases_the_owner_registration`（已变异验证）钉住；
- [x] 主题等**项目级产物**不再随语言 runner 的子目录覆盖漂移（`workspace_root` 与 `cwd` 分开传递，
  Remote 侧与 Local/WSL 对称）；
- [x] 发现口径与存储口径分离（Q2）：发现/执行 = workspace root，任务配置存储 = 项目根；
  import/delete 后的刷新不再误用存储根抹掉 worktree 的发现列表。

### 待真机确认（需 `pnpm tauri dev`，本会话无 GUI）

- worktree 下运行任务：`pwd` / 产物落点正确；
- worktree 下交互终端（local）cwd 正确；WSL/Remote 各一次；
- 主仓任务行为不回归。

## 非目标

- **不改** `run_task` 之外的任务发现存储口径：任务配置按项目路径存于 `<project>/.neeko/tasks.json`，
  本任务只把「发现/展示/执行」的 path 归到 workspace root；是否让配置改存 worktree
  （`.neeko` 会进工作树）另议。**发现路径**是否改 workspace root 留待实现期核对，若影响面大则单列任务；
- 不合并终端三个物理 Map；不动 PTY create/resize/close/outputFilter 的协议与 credit-pull；
- 不改 `runner/exec/context.ts` 中 `activeWorkspaceRoot` 的命名（DAP 调用面广，独立重构）；
- 不新增红线（映射红线 8 路径安全 + 10 平台差异集中化 + 12 地址唯一化）。

## 待决策

- **Q1（已定）**：`working_dir` 只在 Local/WSL/Remote 一律经 `CheckoutPath::resolve_async` 归一并校验
  within-root（越界 → `InvalidInput`，显式失败不静默）；三环境同一函数（env-blind）。
- **Q2（已定）**：`TaskRunButton` 的**发现**路径本任务内改 workspace root（worktree 有自己的
  `package.json`，影响面小）；**配置存储/CRUD** 保持项目根（`<project>/.neeko/tasks.json`），
  saved task 跨 worktree 共享 —— 两者在组件内分离为 `workspaceRoot`（发现）与 `projectPath`（存储）。
- **Q3（已定）**：`remote.create_session` 接收 `(workspace_root, cwd)` 两值 —— 主题等**项目级产物**落
  `workspace_root`，`cd` 落 `cwd`，与 Local/WSL 的 `prepare_project_theme(env, workspace_root, …)` 对称。
