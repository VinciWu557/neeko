# 技术设计：运行根按 Workspace 寻址

> 任务：`.trellis/tasks/10-12-terminal-run-root-workspace-scope`（PRD 见 `prd.md`）
> 结论先行：**「运行根」（cwd）是 Workspace 的派生量，不是 Project 属性**。命令边界收
> `WorkspaceSession`，后端唯一解析出 `WorkspaceRef::root()` 作为缺省 cwd；三环境同构；
> 无可派生根时显式失败，禁止静默回落主仓。

---

## 0. 第一性原理

一次进程启动（交互终端 / 任务进程）的真值依赖是 **`(Workspace, 启动意图)`**，其中 cwd 是
Workspace 的纯函数：

> **cwd(session) = `session.worktreePath ?? project.path`** ≡ `WorkspaceRef::root()`

现状违反该函数的三处（与 10-12 的终端缓存键、2026-09-26 的 git status 同构）：

1. **前端缺省用 Project 级值**：`taskStore.runTask` 的 `projectPath = options?.cwd || activeProject.path`。
2. **后端身份是 project 级**：`create_terminal_session(project_id, …, working_dir: Option<String>)` ——
   只有 project 身份，cwd 靠前端传不透明字符串，缺省 `unwrap_or(project_path)`。
3. **传输层丢维度**：WSL/Remote 分支根本不接 `working_dir`（`router.rs:131/161`），worktree 无解。

推论（决定手段）：

- **L1 · 命令边界身份化**：命令只收 `WorkspaceSession` 值对象；路径解析收口到
  `resolve_workspace_target`（与 git / file 域同一契约，`git-domain.md` §15）。
- **L2 · 缺省 = 派生根**：缺省 cwd 由 `repo.root()` 给出，绝不 `unwrap_or(project_path)`。
- **L3 · 三环境同构**：Local/WSL/Remote 都消费同一 `workspace_root`；环境是传输维度
  （红线 10：差异落适配器，接口一致）。
- **L4 · 前端零运行根**：前端不再自算终端 cwd；唯一允许的前端运行根派生是
  `workspaceRootOf(...)`（供任务展示 / 语言 runner 子目录），交互终端不传 cwd。
- **C1 · 不合并物理 Map**：与本任务无关；create/resize/close 协议逐字节不动。

---

## 1. 取证（现状全家福）

| 链路 | 现状 | 问题 |
| --- | --- | --- |
| `terminal/commands.rs:12` | `create_terminal_session(project_id, …, working_dir)` → `project_context` | 身份 project 级；解析入口 `project_context` 丢 worktree |
| `terminal/manager.rs:94-99` | `cwd = working_dir.unwrap_or(project_path)` | 缺省静默回落主仓（fail-open） |
| `terminal/router.rs:124-171` | Local 接 `working_dir`；WSL/Remote **不接** | worktree 维度在 WSL/Remote 丢失 |
| `terminal/remote.rs:108` | `cd {project_path}` | Remote cwd 恒主仓 |
| `terminal/manager.rs:155-160` | `wsl --cd {project_path}` | WSL cwd 恒主仓 |
| `task/commands.rs:71 run_task` | 直调 `local().create_session(&cwd, …)`，绕过 router | 死命令（前端零消费者） |
| `strategies/index.ts:74/122/156` | 前端自算 `session.worktreePath ?? activeProject.path` | 前端持第二份运行根；WSL/Remote 白算 |
| `shared/store/taskStore.ts:416` | `projectPath = options?.cwd \|\| activeProject.path` | **本任务症状直接来源** |
| `shared/store/taskStore.ts:238` | `startTaskProcess({ cwd: run.projectPath })` | 承接上面的错值 |
| `features/task/components/TaskRunButton.tsx:88` | `projectPath = activeProject?.path` | 任务发现/CRUD 同病 |
| `runner/exec/context.ts:29-35` | `activeWorkspaceRoot`（实为 worktreePath）`?? ctx.projectPath` | 与 `workspaceRootOf` 是第二处派生 |

**已有权威件（直接复用，不新造）**：
`WorkspaceRef::root()`（`common/git/workspace_ref.rs:178`，「一切 git 调用与文件监听的根」）、
`AppStateWrapper::resolve_workspace_target`（`app_state.rs:183`）、
`CheckoutPath::resolve_async`（`common/git/checkout_path.rs:92`，红线 8 的路径归一）、
前端 `workspaceRootOf`（`shared/utils/workspaceRef.ts:165`，工作树根的展示/执行形态）。

---

## 2. 目标契约（分层）

### 2.1 Rust 命令层

```
create_terminal_session(
    workspace: WorkspaceSession,   // ← 首参：唯一地址（原 project_id: String）
    cols, rows,
    shell: Option<String>,
    working_dir: Option<String>,   // ← 该 Workspace 内的绝对覆盖（语言 runner 子目录）；None = 根
    command: Option<String>,
    state, app_handle,
) -> Result<TerminalSession, AppError>
```

- 解析：`let (target, repo) = state.resolve_workspace_target(&workspace).await?;`
  **禁止** `resolve_project(`（丢 worktree）。
- 缺省：`base = repo.root()`。
- 覆盖校验：`working_dir` 若存在 → `CheckoutPath::resolve_async(&target, dir)`，其与
  `repo.root()` 同为该 target 的归一形态；不落在根之下 → `AppError::InvalidInput`（**显式失败**）。
  落点：命令层或 router 层，用**纯函数** `resolve_terminal_cwd(base, override)`（可单测）。

### 2.2 Rust 传输层

`TerminalRouter::create_session` 的实参 `project_path` **语义更名**为 `workspace_root`，
三个分支统一承接：

| 环境 | 变化 |
| --- | --- |
| Local | `manager.create_session(root, …, working_dir, …)`，`manager` 内 `working_dir.unwrap_or(root)`（不再 `project_path`） |
| WSL | `create_wsl_session(distro, working_dir.unwrap_or(root), …)`（`wsl --cd` 目标改 root） |
| Remote | `remote.create_session(host, …, working_dir.unwrap_or(root), …)`（`cd` 目标改 root） |

> `theme::prepare_project_theme(env, project_path, …)` 的 path：**本任务不判定其项目/单元语义**
> （非运行根，属另议）；保持传 `root`（与终端 cwd 同源，避免又多一个 project 级旁路）。

### 2.3 前端命令面

- `terminalApi.createTerminalSession(workspace: WorkspaceSession, cols, rows, shell, workingDir, command)`。
- `taskApi.startTaskProcessSession(workspace: WorkspaceSession, cols, rows, workingDir, command)`。
- invoke 载荷 `{ workspace, cols, rows, shell, workingDir, command }`（`workspace` 为
  `{ projectId, worktreePath }`，与 gitApi 同形）。

### 2.4 前端调用点

- `strategies/index.ts`：三分支统一传 `session`（`useActiveWorkspaceSession` 已给出）；
  **删除 `projectPath` 计算与 `setupTerminalLinks` 里的该变量**——文件链接的 `workspace: session` 保留，
  `projectPath` 改由 `workspaceRootOf(session.key, activeProject.path)` 派生（同 mint），交互终端
  `workingDir` 传 `null`。
- `taskStore.runTask`：`const workspace = activeWorkspaceSession(activeProject.id)`；
  `startTaskProcess({ command, workspace, cwd: options?.cwd, projectId, … })`；
  `projectPath`（TaskRun 展示 / git console id）改为 `workspaceRootOf(workspace.key, activeProject.path)`。
- `taskRunner.startTaskProcess`：`opts.workspace: WorkspaceSession`；cwd 覆盖可选，缺省传 `null`。
- `TaskRunButton`：**发现** path 改 workspace root；**配置存储/CRUD** 保持项目根（`projectPath = activeProject.path`，跨 worktree 共享）——组件内两个变量分离，不混用。

### 2.5 前端单点

`runner/exec/context.ts` 的 `runCwdOf` 改为委托 `workspaceRootOf`：
```ts
runCwdOf(ctx) = workspaceRootOf(activeWorkspaceSession(ctx.projectId).key, ctx.projectPath ?? '')
```
（`activeWorkspaceRoot` 函数保留原名与返回语义，供 DAP 调用；`runCwdOf` 不再重复拼装。）

---

## 3. 落点与形态（文件清单）

**Rust**
```
terminal/commands.rs        create_terminal_session 首参 → workspace；解析改 resolve_workspace_target
terminal/router.rs          create_session 形参 project_path → workspace_root；WSL/Remote 承接 working_dir
terminal/manager.rs         create_session 缺省改 workspace_root；create_wsl_session 增 working_dir
terminal/remote.rs          create_session 形参改 workspace_root（cd 目标）
terminal/services.rs        （可能）新增纯函数 resolve_terminal_cwd(base, override) + #[test]
task/commands.rs            删除 run_task（零消费者）及 lib.rs 注册
```

**前端**
```
features/terminal/api/terminalApi.ts          createTerminalSession(workspace, …)
features/task/api/taskApi.ts                  startTaskProcessSession(workspace, …)；删死 runTask
features/terminal/strategies/index.ts         三分支传 session；删 projectPath 自算
features/task/taskRunner.ts                   StartTaskProcessOptions.workspace
shared/store/taskStore.ts                     runTask 派生 workspace/root；TaskRun.projectPath = root
features/task/components/TaskRunButton.tsx    发现/CRUD 用 workspace root
features/runner/exec/context.ts               runCwdOf 委托 workspaceRootOf
```

**护栏 / 测试**
```
tools/guards/checks/check_terminal_run_root.py
tools/guards/tests/test_check_terminal_run_root.py
src/shared/store/__tests__/taskStore.runRoot.test.ts        （worktree cwd = 工作树路径）
src-tauri/src/terminal/…（resolve_terminal_cwd 纯函数 #[test]）
```

---

## 4. 迁移纪律（原子性）

1. **键空间式原子切换**：命令签名改 `workspace` 后，前端必须同一批改完（否则 invoke 参数不匹配 →
   后端 `workspace` 反序列化失败）。按批：① 后端命令 + 纯函数 + 单测（旧前端暂不改会出现
   运行期失败，故 ① 与 ② 同批提交）→ ② 前端命令面 + 策略 + taskStore + runner → ③ 删死代码 + 护栏。
2. **只改寻址，不改传输**：create/resize/close/drain/outputFilter/credit-pull 逐字节不动。
3. **可观测**：console 头部 `cwd:` 行与真机 `pwd` 必须一致（回归证据）。
4. **红线**：红线 8（路径 canonicalize + 无 allow-all）、红线 10（三环境接口一致）、
   红线 12（地址唯一化）、红线 3（`resolve_workspace_target` 内部已 `spawn_blocking`，命令层
   用 async 入口）。

---

## 5. 决策表

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 命令身份 | **`WorkspaceSession` 首参** | 与 git/file 域同契约；编译期阻止丢 worktree |
| cwd 缺省 | **`repo.root()`** | Workspace 派生；删除 fail-open `project_path` |
| 三环境 | **统一消费 workspace_root** | 环境是传输维度（红线 10） |
| working_dir 覆盖 | **保留，within-root 校验，越界 InvalidInput** | 语言 runner 子目录仍需要；红线 8 |
| 前端运行根 | **交互终端不传；任务经 `workspaceRootOf`** | 消除第二份运行根；前端不持 cwd |
| `run_task` 命令 | **删除** | 零消费者 + 绕过 router 直调 local |
| `activeWorkspaceRoot` 改名 | **不做** | DAP 调用面广，独立重构 |
| 任务配置存储 | **保持项目根**（`<project>/.neeko/tasks.json`） | PRD 非目标：saved task 跨 worktree 共享；仅发现/执行路径 workspace 化（Q2） |
| `remote.create_session` | **收 `(workspace_root, cwd)`** | 主题落 `workspace_root`、`cd` 落 `cwd`，与 Local/WSL 对称（Q3） |
| router 形态 | **命令层解析出单一 `cwd` + 传 `workspace_root`** | 解析/校验一次；主题用 `workspace_root`，进程用 `cwd` |

---

## 6. 风险与对策

| # | 风险 | 对策 |
| --- | --- | --- |
| R1 | 签名原子切换期前端/后端不匹配 | 批 ①② 同批；每批 `pnpm lint` + 相关单测 |
| R2 | WSL/Remote 无本地复现 | 三环境同一解析函数（env-blind 红利：测一处即测三处）；router 层注入断言覆盖三分支 |
| R3 | working_dir within-root 校验跨平台难 | 用 `CheckoutPath` 既有归一；不可行则收窄为「该环境只允许 None」，但**必须显式失败**而非静默 |
| R4 | 任务发现路径改 worktree 影响配置存储 | 见 PRD Q2：默认改动面控制为「运行根」，发现口径若影响大单列 |
| R5 | 调用方漏改（`startTaskProcessSession` 等） | TS 首参改 session → 编译期清单；`rg` 清零验收 |

---

## 7. 护栏判据（给实现）

文件 `tools/guards/checks/check_terminal_run_root.py`（`checks/` 目录自动注册）+
`tools/guards/tests/test_check_terminal_run_root.py`（框架强制同名测试）。

- **G1（后端身份）**：`src-tauri/src/terminal/**` 内 `fn create_terminal_session` 必须带
  `workspace: WorkspaceSession` 形参；带该形参的函数体内不得调 `resolve_project(`（复用
  `check_workspace_session_addressing` 的 A2 形态）。
- **G2（后端禁 fail-open）**：`src-tauri/src/terminal/**` 不得出现 `unwrap_or(project_path)` /
  `unwrap_or(&project_path)`（主仓静默回落形态）。
- **G3（前端禁裸 project 运行根）**：`src/features/terminal/**` 与 `src/features/task/**`、
  `src/shared/store/taskStore.ts` 内不得把 `activeProject.path` / `project.path` 作为终端
  `workingDir` / runTask cwd 传入（形态级，作用域收窄）。
- 伴随单测：允许（`workspace` 首参）/ 违规（`unwrap_or(project_path)`、`workingDir: project.path`）/
  scope 外放行 / 测试文件豁免。
