# 执行计划：运行根按 Workspace 寻址

> 任务：`.trellis/tasks/10-12-terminal-run-root-workspace-scope`
> 顺序原则：**后端与前端命令面同批切换**（invoke 参数契约原子），再删死代码、加护栏。
> 每批独立可回滚；改动停在未提交状态（是否提交由开发者决定）。

---

## 批 1 · 后端命令身份化 + 传输三环境（与前端命令面同批）

### 1a 纯函数与单测（Red 先行）

1. `terminal/services.rs`（或同级）新增纯函数：
   ```rust
   pub fn resolve_terminal_cwd(base: &str, work_dir: Option<&str>) -> String
   ```
   语义：`work_dir` 为 `None` → `base`；`Some` → 经 target 归一后校验 within `base`（越界 → 错误）。
   若 within-root 校验需 target/异步（`CheckoutPath`），拆成两个：纯字符串归一 + 命令层校验。
2. 单测：`None → base`；`Some(sub) → base/sub`；`Some(越界) → Err`；主仓/工作树两态 base。

### 1b 命令层

3. `terminal/commands.rs`：`create_terminal_session` 首参 `project_id: String` → `workspace: WorkspaceSession`；
   `let (target, repo) = state.resolve_workspace_target(&workspace).await?;`
   `let base = repo.root();` 计算 cwd，传给 router。**删 `project_context` 调用**。
4. `terminal/router.rs`：`create_session` 的 `project_path` 更名 `workspace_root`；三分支：
   - Local：把 `workspace_root` 与 `working_dir` 传给 `manager.create_session`；
   - WSL：`create_wsl_session(distro, cwd, cols, rows, app_handle)`（cwd = 解析结果）；
   - Remote：`remote.create_session(host, port, username, auth, cwd, cols, rows, app_handle)`。
5. `terminal/manager.rs`：`create_session` 的 `cwd = working_dir.unwrap_or(workspace_root)`；
   `create_wsl_session` 增 `working_dir` 形参（缺省 root），`wsl --cd` 用它。
6. `terminal/remote.rs`：`create_session` 形参 `project_path` → `workspace_root`（`cd` 目标）。

### 1c 前端命令面（同批，否则 invoke 契约断裂）

7. `terminalApi.createTerminalSession(workspace, cols, rows, shell, workingDir, command)`。
8. `taskApi.startTaskProcessSession(workspace, cols, rows, workingDir, command)`。
9. `strategies/index.ts`：三分支首参改 `session`；删除 `projectPath = session.worktreePath ?? activeProject.path`
   与 `workingDir = projectPath`；`setupTerminalLinks` 的 `projectPath` 改
   `workspaceRootOf(session.key, activeProject.path ?? '')`；交互终端 `workingDir` 传 `null`。
10. `taskRunner.ts`：`StartTaskProcessOptions` 增 `workspace: WorkspaceSession`；`startTaskProcessSession`
    首参传它；cwd 覆盖缺省传 `null`。
11. `taskStore.runTask`：`const workspace = activeWorkspaceSession(activeProject.id)`；
    `const projectPath = options?.cwd || workspaceRootOf(workspace.key, activeProject.path || '')`；
    `startTaskProcess({ workspace, cwd: options?.cwd, … })`；`TaskRun.projectPath = projectPath`。
12. `TaskRunButton.tsx`：`projectPath` 改 `workspaceRootOf(activeWorkspaceSession(activeProject.id).key, activeProject.path)`。
13. `runner/exec/context.ts`：`runCwdOf` 委托 `workspaceRootOf`（消除第二处派生）。

**验证**：`pnpm lint:fe` + `pnpm type-check`；`pnpm test:rust`；前端单测（批 3 补 taskStore 用例）；
真机开 worktree 终端 + 任务（记录证据）。

---

## 批 2 · 死代码清理

14. 确认零消费者后删除后端 `run_task`（`task/commands.rs`）+ `lib.rs` 注册 + 前端
    `taskApi.runTask`（`rg` 清零，含测试夹具）。
15. `pnpm lint` 全绿。

**验证**：`grep -rn "run_task" src src-tauri/src` 仅剩无关命中或无。

---

## 批 3 · 测试补强

16. 前端 `taskStore` 单测：worktree 激活（mock `workspaceStore` activePath）时 `runTask` 的
    `startTaskProcessSession` 收到 `workspace.worktreePath` 且 cwd = 工作树根；主仓时 = 项目根。
17. Rust：`resolve_terminal_cwd` 纯函数单测（主仓/工作树/越界）。
18. 若 router 层可注入断言：三分支均把 `repo.root()` 作为 cwd/cd 目标（若 PTY 难测，退化为纯函数覆盖）。

**验证**：`pnpm test:fe -- <新增文件>`；`pnpm test:rust`。

---

## 批 4 · 护栏

19. `tools/guards/checks/check_terminal_run_root.py`（G1/G2/G3，判据见 design §7）+
    `tools/guards/tests/test_check_terminal_run_root.py`。
20. `pnpm lint` 确认 local stage 拦截生效（用一条故意违规做 Red 验证后删除）；
    `pnpm guards list` 含新护栏。

---

## 批 5 · 全量验证 + 收尾

- `pnpm check` 全绿；逐条勾 PRD Acceptance Criteria；
- spec 沉淀（`git-domain.md` §15 旁补 terminal 运行根契约，或 `docs/domain-model.md` 补一行）；
- Trellis 会话记录（`add_session.py`）；`task.json` 状态；归档（另起 commit）。

---

## 命令速查

```bash
# 批 1 契约清零
grep -rn "resolve_project(" src-tauri/src/terminal/           # 应为空
grep -rn "unwrap_or(project_path)" src-tauri/src/terminal/    # 应为空
grep -rn "session.worktreePath ?? activeProject.path" src/features/terminal   # 应为空
# 批 2 死代码
grep -rn "run_task" src src-tauri/src | grep -v "runTask("
# 护栏单测
python3 -m unittest discover -s tools/guards/tests -t tools -p "test_check_terminal_run_root.py"
# 全量门禁
pnpm check
```

## 边界复述

- 传输协议（create/resize/close/drain/outputFilter/credit-pull）逐字节不动；
- 三环境同一寻址接口（红线 10）；路径归一走 `CheckoutPath`（红线 8）；地址唯一化（红线 12）；
- 不新增红线；`activeWorkspaceRoot` 不改名；任务发现存储口径若影响大单列（PRD Q2）。
