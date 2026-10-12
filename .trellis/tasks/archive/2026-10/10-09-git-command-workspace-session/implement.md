# 执行计划：git 命令按 WorkspaceSession 对象寻址

> 前置：`prd.md`（验收）、`design.md`（契约与判据）。
> **硬闸门：本文档经用户确认后才允许 `task.py start` 并改码。**
>
> **核心方法**：用**类型驱动的编译错误**找全部调用点，不靠 grep 人工枚举。
> 每阶段一个独立提交，任一步红即 `git reset --hard <上一步>`。

---

## 阶段总览

| 阶段 | 内容 | 独立验证判据 |
| --- | --- | --- |
| P0 | 护栏先行（先拦后改，量化基线） | `check_workspace_session_addressing` 报出**当前违规数**（应 > 0） |
| P1 | 后端命令收对象（64 个 + agent 1 个） | `cargo check --tests` 绿（旧前端测试可能红，见下） |
| P2 | 前端 `gitApi.ts` 收对象（68 函数，A/B/C 分类） | `pnpm type-check` 用编译错误定位全部调用点 |
| P3 | `ProjectCommands` 委托化 + 调用点迁移 | `rg "invoke" commandFactory.ts` 归零 |
| P4 | 文档 + 护栏归零 + 全量验证 | 护栏 0 违规；`pnpm check` 全绿 |

> **P1/P2 的顺序依赖**：后端先改 → 前端后改。中间态下旧前端传 `{projectId, worktreePath}` 给
> 新后端（期望 `{workspace: {...}}`）会 serde 失败。**同批开发、同批提交**（本地应用无热更新），
> 中间态只在开发者工作树中存在，不进入任何可发布形态。

---

## P0 — 护栏先行（先拦后改）

**目标**：迁移前给出「还有多少处散签」的量化基线，并让护栏在迁移中逐批变绿。

- [ ] 新建 `tools/guards/checks/check_workspace_session_addressing.py`（或扩展
      `check_file_io_scope`，落点依 P0.1 判定），判据三条：
  - **前端 F1**：`src/**` 内对 git 命令的调用不得传裸 `worktreePath` 独立实参
    （判据 = `gitApi.ts` 的 `worktreePath` 形参退役后，消费侧不得再造该形态）；
  - **前端 F2**：生产代码不得出现 `{ projectId, worktreePath }` 字面量（class 私有构造之外的双保险，
    豁免 `workspaceRef.ts` 自身与测试夹具）；
  - **后端 F3**：`src-tauri/src/git/commands/**` 与 `agent/commands_commit.rs` 内不得出现
    `resolve_workspace(` 调用。
- [ ] 护栏负例测试（`tools/guards/tests/test_...py`）：散签实参 / 手搓字面量 /
  后端直调 `resolve_workspace` / 正例（`resolve_workspace_target` / `activeWorkspaceSession`）/ 豁免
  （值对象自身 + `#[cfg(test)]`）至少 6 例。
- [ ] 跑 `python3 tools/guards/run.py run --only <新护栏> --stage local`，**记录当前违规数**
  （预期：前端 32 文件命中、后端 26+ 处命中）—— 这是迁移的基线，写进提交信息。

**判据**：护栏接入 `--stage local` / `--stage ci`；自身负例测试全过；违规数 > 0（证明拦的是真现状）。

---

## P1 — 后端命令收对象

- [ ] `git/commands/{query,history,sync,index,commit}.rs`：`(project_id, worktree_path: Option<String>)`
      → `(workspace: WorkspaceSession)`；`resolve_workspace(&p, w.as_deref())` → `resolve_workspace_target(&workspace)`。
- [ ] `git/commands/{branch,pr,worktree}.rs`：**逐个判定**（design.md §2.1 C 类 + §2.3 例外）——
      操作对象是 worktree 自身的（`create_worktree` / `remove_worktree` / `rename_worktree` /
      `canonical_worktree_path`）**不改**；逐个记入 `git-domain.md` 例外表。
- [ ] `agent/commands_commit.rs::generate_commit_message`：同样收对象。
- [ ] `git/commands/mod.rs` / `lib.rs`：无需改（`generate_handler!` 按函数名注册，签名变了自动适配）。
- [ ] 更新受影响的后端测试夹具（`cargo check --tests` 报出的即全部）。

```bash
cargo check --manifest-path src-tauri/Cargo.toml --tests 2>&1 | grep -E "^error" | head -20
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets 2>&1 | tail -5
```

**判据**：`cargo check --tests` 绿；`rg "worktree_path: Option<String>" src-tauri/src/git/commands/ src-tauri/src/agent/` 零命中
（例外项除外且可指认）；`rg "resolve_workspace(" src-tauri/src/git/commands/ src-tauri/src/agent/` 零命中。

---

## P2 — 前端 `gitApi.ts` 收对象

**用编译器找全部调用点**：改完 `gitApi.ts` 签名后，`pnpm type-check` 会逐个报出所有传 `string`
给 `WorkspaceSession` 参数的位置 —— 这就是完整调用点清单，**不可能漏**。

- [ ] `gitApi.ts`：68 函数按 A/B/C 三类改（design.md §2.1 表）。A 类删 `worktreePath` 形参；
      B 类首参换对象；C 类不动（`activateWorkspace` / `cancelGitSync` / `isGhInstalled` /
      `isGhAuthenticated` / `getRemoteHomeDir`）。
- [ ] `fileLineChange.ts`（同目录，2 处 `worktreePath`）：同步改。
- [ ] 跑 `pnpm type-check`，按报错逐个修调用点：
  - 激活项目消费 → `activeWorkspaceSession(projectId)`
  - 外部 projectId（`CommitDialog` / `PullRequestsPanel` / `GitCommitPanel`）→
    `WorkspaceSession.of(projectId, worktreePath)`
  - 从 key 反解（事件载荷只给 `workspace_key`）→ `WorkspaceSession.fromKeyOrId(key)`
- [ ] 测试 fixtures 同步（`useGitActions.test.ts` / `gitStatus` / `commandFactory.test.ts`）：
      **只改传参形态，不改断言语义**（AC4）。

```bash
pnpm type-check 2>&1 | grep -E "error TS" | head -30   # 调用点清单
```

**判据**：`pnpm type-check` 绿；`rg "worktreePath" src/features/git/api/gitApi.ts` 只命中内部解构行；
全部测试 `expect` 断言语义未变（diff 审查确认）。

---

## P3 — `ProjectCommands` 委托化

- [ ] `commandFactory.ts`：31 个方法改为委托 `gitApi`，**删除本文件全部 `invoke`**（AC7）。
- [ ] `use-active-project/index.ts`：不变（已传 `activeWorkspaceSession(activeProject.id)`）。
- [ ] `commandFactory.test.ts`：断言改为验证委托（mock `gitApi` 而非 mock `invoke`）。
- [ ] 核查是否有消费方依赖 `ProjectCommands` 的 `invoke` 行为（应无，它是纯包装）。

```bash
rg "invoke" src/features/project/hooks/use-active-project/commandFactory.ts   # 期望零命中
pnpm test:fe src/features/project src/features/git
```

**判据**：`invoke` 零命中；`pnpm test:fe` 相关目录全绿。

---

## P4 — 文档 + 收口验证

- [ ] `docs/domain-model.md`：「寻址根 vs 展示根」段补 git 域一行（当前只写文件 IO）。
- [ ] `.trellis/spec/backend/git-domain.md`：新增「git 命令寻址契约」段 ——
      `WorkspaceSession` 唯一地址 / `resolve_workspace_target` 唯一入口 / C 类与 worktree 例外表 /
      「操作对象是 worktree 自身」的判据。
- [ ] 跑新护栏确认违规数归零；`tools/guards/ledger/` 无需改（新护栏无 ratchet 台账）。

```bash
python3 tools/guards/run.py run --stage local     # 新护栏 0 违规 + 全部既有护栏不回归
python3 tools/guards/run.py run --stage ci
pnpm check                                        # lint + test 全量
cargo test --manifest-path src-tauri/Cargo.toml --lib git::
```

**判据**：AC1–AC7 逐条可验（见 `prd.md`）。

---

## 验收映射

| AC | 判据 | 阶段 |
| --- | --- | --- |
| AC1 | `gitApi.ts` 无散签（`rg` + 类型） | P2 |
| AC2 | 后端无散签（`rg` + 例外表） | P1 |
| AC3 | 唯一解析入口（`rg` 零命中） | P1 |
| AC4 | wire 逐字不变 + 测试断言语义不变 | P2 / P3 |
| AC5 | `pnpm check` 全绿 + `cargo test git::` 同数 | P4 |
| AC6 | 护栏 0 违规 + 自身负例测试 | P0 / P4 |
| AC7 | `commandFactory.ts` 无 `invoke` | P3 |

---

## 风险文件与回滚点

| 阶段 | 风险文件 | 回滚 |
| --- | --- | --- |
| P0 | 新护栏（可能误报既有合法形态） | 单提交 revert，不影响代码 |
| P1 | `git/commands/*.rs`（64 命令签名） | 独立提交；回滚后前端暂不兼容 → 必须同批回滚 P2 |
| P2 | `gitApi.ts`（68 函数）+ 32 个调用点 | 独立提交；与 P1 成对 |
| P3 | `commandFactory.ts` | 独立提交，可单独回滚（改回自建 invoke） |

> **P1+P2 是原子对**（wire 形态同批切换），若需回滚必须一起回滚；P0 / P3 / P4 可独立回滚。

## 开工前自检

- [ ] `task.py current` 指向本任务。
- [ ] 前置任务 `10-09-file-io-workspace-scope` 已归档（✅ 已确认）。
- [ ] `docs/domain-model.md` 已读（术语唯一来源）。
- [ ] 用户已确认本文档与 `prd.md` / `design.md`。

---

## P5 — 核验后修复（收发一致性缺口，2026-10-12）

**问题（Block，自测试不可见）**：P1 只迁移了 `query/history/sync/index/commit.rs`，遗漏了
`branch.rs` 与 `pr.rs` 的**后端**，但 P2 已把它们的**前端**改成发 `{ workspace }`。前端测试
mock 了 `invoke`（只断前端发出的载荷），后端测试不执行命令签名 —— 两边各自绿，wire 实际错位，
运行时会在 `set_active_workspace` / `checkout_branch` / `list_prs` / 全部 PR 命令上 serde 失败。

**根因**：把「后端迁移」与「前端迁移」当成两个可独立完成的批次，未做**跨端逐命令核对**；
而类型检查/单测都只覆盖单侧。

**修复**：
1. `branch.rs`（6 命令）+ `pr.rs`（16 命令）后端改收 `workspace: WorkspaceSession`，经
   `resolve_workspace_target` 解析（`pr.rs` 的 `Path::new(&wd)` → `Path::new(repo.root())`）；
   `branch.rs` 的 `wait_main_status_fresh` → `wait_status_fresh(&state, &repo)`（戳被写入的单元，§10）。
2. `set_active_workspace` 前端改发 `{ workspace }`（`activateWorkspace(workspace)`）。
3. `canonical_worktree_path` / `is_git_repo` 前端回退为 `(projectId, …)` + 平铺载荷
   （后端一直是 `project_id`；这两个命令不需要 Workspace 地址）。
4. **行为零变更**：`ProjectCommands` 的 B 类方法（`getCommitLog` / `branch` / `cherryPick` /
   `revert` / `createTag` / `commitDetail` / `commitFiles`…）现在传**激活单元** session，而非
   改造前“丢弃 worktreePath ⇒ 静默主仓” —— 这是本任务 F1 的预期收敛（主仓项目行为逐字不变；
   worktree 视图下不再静默错位）。外部项目调用（`CommitDialog` / PR 面板 / `GitDialog`）仍传
   `WorkspaceSession.of(projectId, null)`（主仓），与原语义一致。

**新增防复发手段**：核验时写了一次「前端 `invoke` 载荷键 vs 后端形参名」的逐命令比对
（见会话日志）；该缺陷类型（跨端签名漂移）单侧测试无法捕获，建议后续沉淀为护栏候选。

**判据**：`pnpm type-check` 0 error；`guards run --stage local` 25/25；`cargo test --lib`
1555 passed；`pnpm test:fe` 4666 passed。
