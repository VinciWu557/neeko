# 领域命名收敛：App → Project → Workspace（能力容器）

> 状态：**已完成（2026-10-08 归档前核验）**。5 条 AC 全达成，Tier 0/1/2/3 全栈落地。
> 术语决策见 `design.md`，执行批次与四轮落地记录见 `implement.md`。
>
> **范围演进说明**：本 PRD 初版只把 Tier 2 大改名与 Tier 3 列为 Out；实施中两者均已落地
> （记录见 `implement.md` 文末三段）。下文 Out / 已知缺口段保留**原始规划口径**并加
> 「后续已落地」标注，便于对照「计划 vs 实际」的差距来源。

## Goal

把「一个 Project 下、承载 IDE/Agent/editor/debug/LSP/terminal 的独立工作上下文」这一节点统一命名为 **`Workspace`**，并确立分层术语：

```
App → Project → Workspace（能力容器）→ ide / agent / editor / debug / lsp / terminal
                     └ checkout（属性：path / kind(Main|Worktree) / branch / HEAD）
                     └ root（属性：scope 基准 = ${workspaceFolder}）
```

让「谁拥有这些功能状态」「scope 由谁派生」在命名上**唯一且无歧义**。

## Problem Statement（命名现状的可观察问题）

| 症状 | 现状 |
| --- | --- |
| 同一概念多个名字 | 「单元根」有 `unitRoot` / `unitWorkDir` / `work_dir()` / `resolveRunCwd` / `resolveUnitRoot` / `projectRootOf` / `unitRootForProject` 等 6+ 拼法 |
| 节点概念无名字 | 「承载 IDE/Agent/editor/debug/LSP/terminal 的容器」在代码里没有统一名；`Repo`/`worktree` 都只描述它的**属性** |
| 顶层与中间层重名风险 | `workspace` 已被 LSP 协议（`WorkspaceEdit`/`workspaceFolders`）与 `${workspaceFolder}` 使用，需明确归属 |
| 组件名与领域名混淆 | `ProjectWorkspace.tsx` 组件与将要确立的领域对象 `Workspace` 同名 |

## 问题本质（第一性原理）

一次「工作」的真值依赖是 `(Workspace, 功能)`，其中 `Workspace` = `Project` 的一个工作上下文，`checkout`/`root` 是它的**属性**。现有代码把「属性」（仓库/worktree）当成了「容器」的名字，于是同一容器被按不同属性命名（repo/worktree/unit），产生同义碎片。

**术语不变量**：一个概念一个名字；属性不进容器名。

## Scope

### In

- **Tier 0**：术语表 + 分层图写入 spec/docs（唯一正文，不在多处复述）。
- **Tier 1**：UI 组件 `ProjectWorkspace.tsx` → `ProjectView.tsx`（释出 `Workspace` 给领域对象）。
- **Tier 2（本批次）**：收敛 runner 侧「单元根」同义命名族（`unitRootForProject` 等）→ `Workspace*` 命名，单点派生。
- **明确记录决策**：wire 契约 `RepoKey` / `repo_key` 与后端 `RepoRef` **默认不改名**（见 Out）。
  **← 该决策后续被推翻**：Tier 3 落地时改为全栈统一为 `WorkspaceKey` / `workspace_key` /
  `WorkspaceRef`（理由与保留边界见 `docs/domain-model.md`「等价关系」段）。

### Out（原始规划口径；标注「后续已落地」者见 `implement.md` 文末记录）

- ~~**Tier 2（大改名）**：`worktreeStore` → `workspaceStore` 及其 75 个 import 点、`WorktreeUnitState` 等符号改名。~~
  **后续已落地**（2026-10-08，实际跨 78 文件）：见 `implement.md`「Tier 2 大改名落地记录」。
- ~~**Tier 3**：后端 `RepoRef` / `WorktreeRef` / `UnitPath` / `ExecUnit` 改名；wire `repo_key` → `workspace_key`。~~
  **后续已落地**（2026-10-08）：见 `implement.md`「Tier 3 全栈对齐落地记录」。
  原「默认不改」的理由（`RepoKey` 是 `workspace.checkout` 的身份、零迁移风险）**部分保留**：
  `WorkspaceKey` 仍只标 checkout 身份、不充当容器名；但名字本身随容器统一为 Workspace 词根。
- 不改 LSP 协议名（`WorkspaceEdit` / `workspace/workspaceFolders`）与 `${workspaceFolder}`（外部约定）。
  **← 本项至今仍然成立**（协议命名空间与领域对象不冲突，无需为规避而改协议名）。

## Requirements

### R1 术语表（Tier 0）

- R1.1 术语表有且仅有**一个正文落点**（`docs/domain-model.md`），其余 spec 只链接、不复述。
- R1.2 术语表必须包含：`App` / `Project` / `Workspace` / `workspace.checkout` / `workspace.root` 的定义、基数与归属。
- R1.3 `workspace.root ≡ ${workspaceFolder} ≡ LSP workspace root` 的等价关系必须写明；`RepoKey`/`RepoRef` 注明为 `workspace.checkout` 的身份。
  （Tier 3 后符号名为 `WorkspaceKey` / `WorkspaceRef`，语义不变。）

### R2 组件命名（Tier 1）

- R2.1 `ProjectWorkspace.tsx` 重命名为 `ProjectView.tsx`，默认导出与全部 import 点同步。
- R2.2 行为零变更（仅改名 + 引用）。

### R3 「单元根」同义收敛（Tier 2 本批次）

- R3.1 「当前 Workspace 的根」在前端只保留**一个**命令式入口（`activeWorkspaceRoot(projectId)`）与**一个**渲染兜底（`runCwdOf(ctx)`）；删除 `unitRootForProject` 旧名。
- R3.2 `navigate.ts` 的 `resolveUnitRoot` → `workspaceRootFor(...)`；`projectRootOf` → `projectRegisteredRoot(...)`（明确它返回的是**项目登记根**，不是 workspace 根）。
- R3.3 不新增第二套路径归一；全部经 `selectActiveWorktreePath` / `store` 既有单点。

## Acceptance Criteria

1. `pnpm type-check` 与 `pnpm check` 全绿。
2. `ProjectWorkspace` 在 `src/` 内**零命中**（组件已改名，`AppCenter.tsx` 等引用同步）。
3. `unitRootForProject` 在 `src/` 内**零命中**（已收敛为 `activeWorkspaceRoot`）。
4. 术语表仅一处；`git-domain.md` / `state-management.md` / `dap-domain.md` 各增一行**指针**（不复述定义）。
5. 行为零变更：现有 `runner` / `editor` 测试不回归。

## 已知缺口（原始登记；两项均已被本任务自身消化，无遗留）

- ~~`worktreeStore`/`WorktreeUnitState`/`selectActiveWorktreePath` 等 Tier 2 大改名（75 import 点）。~~
  **已落地**（`implement.md`「Tier 2 大改名落地记录」），最终符号为 `workspaceStore` / `WorkspaceState` /
  `selectActiveCheckoutPath` 等。
- ~~后端 `RepoRef`→`CheckoutRef`、`WorktreeRef`→`CheckoutKind`、`ExecUnit` 命名统一；wire `repo_key` 是否改名。~~
  **已落地**（`implement.md`「Tier 3 全栈对齐落地记录」），实际落点为 `WorkspaceRef` / `Checkout` /
  `CheckoutPath` / `ExecWorkspace` + wire `workspace_key`（比原计划设想更彻底）。

**遗留的刻意保留项**（非遗漏，均属 git 原生或缓存键，见 `implement.md`「第四遍复核」）：
`repo_key_prefix`（cache 键前缀）、`isActiveWorktree`（linked-vs-main 类型谓词）、
`create/remove/rename_worktree`、`isWorktreeDirty`、`WorktreeList`、持久化字段 `worktree_state`。
