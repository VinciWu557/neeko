# 技术设计：git 命令按 WorkspaceSession 对象寻址

> 配套 `prd.md`（需求/验收）。术语以 [`docs/domain-model.md`](../../../docs/domain-model.md) 为准。
> **本文只记录设计与判据，不复述术语定义。**

---

## 0. 第一性原理：地址的三种失真

一次 git 操作的真值依赖是 `(Workspace, 操作)`。**地址信息的保真度**决定系统正确性，
当前架构在三处让它失真：

| 失真 | 形态 | 后果 | 已根治的同类 |
| --- | --- | --- | --- |
| **可手搓** | 前端 `worktreePath?: string \| null` 是可选散参 | 漏传 → 静默按主仓执行 | file 域 `rootPath`（前置任务） |
| **可拆分** | 后端 `(project_id, worktree_path)` 两个 wire 字段 | 两字段可独立缺失/错配 | file 域已改单 `workspace` 对象 |
| **可绕过** | `resolve_workspace(&str, Option<&str>)` 被 64 处直接调 | 解析逻辑两个外观，改一处漏一处 | — |

**推论**：修一处不解决另外两处 —— 只改后端签名，前端仍可手搓；只加护栏，散参结构仍在。
故本设计三层同时收口（表示 / 构造 / 解析），缺一层即同类风险换个地方重犯。

**为什么不是"机械改名"**：若只追求"看起来统一"，保留散签 + 加护栏也能让 grep 归零。
但 `worktreePath?: string | null` 的**可选性本身**就是缺陷载体 —— file 域的经验是
「可选且默认错误的参数，漏传即静默失效」。用类型消除可能性优于用护栏提高犯错成本。

---

## 1. 目标结构

### 1.1 三层契约

| 层 | 机制 | 落点 | 状态 |
| --- | --- | --- | --- |
| **表示** | `WorkspaceSession`（class + 私有构造，`JSON.stringify` → `{projectId, worktreePath}`） | `src/shared/utils/workspaceRef.ts:67` | 已有，不动 |
| **构造** | 身份源单点：`activeWorkspaceSession(projectId)` / `WorkspaceSession.of` / `fromKey` / `fromKeyOrId` | `workspaceStore.ts:158` + 值对象静态工厂 | 已有，补纪律 |
| **解析** | `AppStateWrapper::resolve_workspace_target(&WorkspaceSession)` 唯一入口 | `app_state.rs:183` | 已有，扩展到 git 域 |

**关键性质**：`WorkspaceSession` 的 getter（`key`）挂原型，**不入 wire** ——
`JSON.stringify(session)` 只产出 `{ projectId, worktreePath }`，`workspace` 对象内部的分量名与
file 域逐字同形。命令参数形态从平铺 `{ projectId, worktreePath, … }` 变为嵌套
`{ workspace: { projectId, worktreePath }, … }`（与 file 域同形，是后端收
`workspace: WorkspaceSession` 的必然结果，Tauri 按名反序列化）—— 前后端同批发布，无需兼容期。
`workspace_key` 持久化字段与事件载荷完全不动。

### 1.2 前端两条路径的分工（修正 PRD 初版误解）

PRD 初版把「两套寻址外观」视为病，实测证明是**两种能力契约**：

```
                     ┌─ ProjectCommands（31 方法）── 激活项目窄面投影，零参调用
useActiveProject() ──┤     内部委托 gitApi（不再自建 invoke）
                     │
任意 Workspace 寻址 ─┴─ gitApi.ts（68 函数）────── git 功能完整命令面
                           首参 workspace: WorkspaceSession
```

- **不合并**：`gitApi` 独有 37 个能力（PR / worktree / gh 认证 / `stageAll` / `checkoutDetached`…），
  `ProjectCommands` 是它的激活项目特化。合并要么丢掉 37 个能力，要么把窄面撑胖。
- **但去掉第三套 invoke**：`commandFactory.ts` 当前自建 31 个 `invoke` 调用 —— 这是真正的重复
  （同一命令两个 invoke 点）。改为委托 `gitApi` 后，**全前端只有一个 invoke 面**。
- **保留散签的真实需求**：`CommitDialog` / `PullRequestsPanel` 按外部 `projectId` 操作
  （`GitCommitPanel.tsx:183` 传 `project.id`）—— 收对象后它们改用
  `WorkspaceSession.of(projectId, worktreePath)` 构造，能力不变、形态统一。

---

## 2. 契约细节

### 2.1 前端 `gitApi.ts`（68 函数）

**改前**：

```ts
export function stageFiles(
  projectId: ProjectId,
  filePaths: string[],
  worktreePath?: string | null,
): Promise<void> {
  return invoke<void>('stage_files', { projectId, filePaths, worktreePath });
}
```

**改后**（与 file 域逐字同构，嵌套载荷）：

```ts
export function stageFiles(
  workspace: WorkspaceSession,
  filePaths: string[],
): Promise<void> {
  return invoke<void>('stage_files', { workspace, filePaths });
}
```

**判据**：地址载荷从平铺 `{ projectId, worktreePath }` 改为嵌套
`{ workspace: { projectId, worktreePath }, … }` —— 与 file 域逐字同形，是后端收
`workspace: WorkspaceSession` 的必然结果（Tauri 按名反序列化）。`workspace` 内部的
**分量名不变**；`invoke` 的第一个参数（命令名）不动。

**分类处置**（68 个函数分三类，不机械全改）：

| 类 | 判据 | 处置 | 例 |
| --- | --- | --- | --- |
| **A 收对象** | 现已有 `worktreePath` 参数 | 首参换 `workspace`，删 `worktreePath` 形参 | `stageFiles` / `getFileDiff` / `fetch` / `commitFiles` / `getStashList` … |
| **B 补对象** | 现只有 `projectId`（主仓语义） | 首参换 `workspace`（调用方传主仓 session） | `checkoutBranch` / `createBranch` / `getCommitLog` / `createTag` / `cherryPick` … |
| **C 不收** | 参数语义不是"在哪个 workspace 执行" | **不改签名** | `cancelGitSync(runId)`（按 run id）、`isGhInstalled()` / `isGhAuthenticated()`（宿主探测）、`getRemoteHomeDir`（环境查询）、`canonical_worktree_path` / `is_git_repo`（只需 project 环境） |

> C 类是 **YAGNI 判据**：给不需要地址的命令塞地址对象，只会让调用方凭空构造
> `WorkspaceSession.of(id, null)`。逐个判定并记入 `git-domain.md`，供 review 指认。

### 2.2 前端 `ProjectCommands`（委托化）

**改后**（`commandFactory.ts`）：

```ts
export function createProjectCommands(workspace: WorkspaceSession): ProjectCommands {
  return {
    refreshGitInfo: () => getGitInfo(workspace),
    stageFiles: (filePaths) => stageFiles(workspace, filePaths),
    commitFiles: (filePaths, message, consoleRunId) =>
      commitFiles(workspace, filePaths, message, consoleRunId),
    // … 31 个方法全部委托 gitApi；本文件不再出现 invoke
  };
}
```

**收益**：`rg "invoke" commandFactory.ts` 归零（AC7）—— 同一命令只有一个 invoke 点，
将来改 wire 只改 `gitApi.ts` 一处。

### 2.3 后端命令（64 个）

**改前**：

```rust
#[tauri::command]
pub async fn stage_files(
    project_id: String,
    file_paths: Vec<String>,
    worktree_path: Option<String>,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (t, repo) = state.resolve_workspace(&project_id, worktree_path.as_deref()).await?;
    …
}
```

**改后**（与 file 域逐字同构）：

```rust
#[tauri::command]
pub async fn stage_files(
    workspace: WorkspaceSession,
    file_paths: Vec<String>,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    …
}
```

**要点**：
- `WorkspaceSession` 定义在 `common/git/workspace_ref.rs:40`，`#[derive(Deserialize)]` +
  `#[serde(rename_all = "camelCase")]` + `worktree_path` 带 `#[serde(default)]` ——
  与前端 `JSON.stringify` 产出**逐字节对齐**，无需新增 serde 配置。
- `resolve_workspace(&str, Option<&str>)` **保留**（DAP / watcher / `resolve_workspace_root` 在用），
  `resolve_workspace_target` 委托它 —— 单一实现、两个外观中只留一个给 git 域。
- 参数顺序：`workspace` 放**首位**（与 file 域一致），其余参数相对位置不变，
  使 diff 最小化（Tauri 命令按名绑定，顺序不影响 wire）。

**逐个判定例外**（R2.3，记入 `git-domain.md`）：`worktree.rs` 中操作对象是 worktree 自身的命令
（`create_worktree` / `remove_worktree` / `rename_worktree` / `canonical_worktree_path` 等）
**不收** `workspace` —— 它们的参数是 worktree 名/路径，语义不是"在哪个 workspace 执行"。
落地时逐个确认并列表，不留"应该改没改"的模糊带。

### 2.4 跨域一处：`agent/commands_commit.rs`

`generate_commit_message` 也走 `resolve_workspace(&project_id, worktree_path)` → 同样收对象。
它是 agent 域唯一需要 git 寻址的命令，改动隔离、不牵连 agent 其它命令。

---

## 3. 数据流（改造后）

```text
UI（GitCommitPanel: project.id）
  │
  ├─ 激活项目路径：useActiveProject() → commands.stageFiles(...)
  │     └─ ProjectCommands ──委托──▶ gitApi.stageFiles(session, …)
  │
  └─ 非激活项目路径：WorkspaceSession.of(projectId, worktreePath)
        └─ gitApi.stageFiles(session, …)
              │ invoke('stage_files', { workspace: { projectId, worktreePath }, filePaths })
              ▼
        Rust: stage_files(workspace: WorkspaceSession, file_paths)
              │ state.resolve_workspace_target(&workspace)
              ▼
        resolve_workspace(project_id, worktree_path)  ← 唯一实现（不变）
              ▼
        WorkspaceRef::resolve(...) → (ExecTarget, WorkspaceRef) → repo.root()
```

**不变量**：`workspace` 对象是唯一穿越 IPC 的地址形态；`resolve_workspace` 是唯一解析实现。

---

## 4. 兼容性与迁移

| 项 | 影响 | 处置 |
| --- | --- | --- |
| wire 字段名 | **嵌套化**（`{ workspace: { projectId, worktreePath }, … }` 与 file 域同形；分量名不变） | 前后端同批发布，无需 golden / 兼容期 |
| `workspace_key` 持久化 / 事件载荷 | 不动 | — |
| 后端命令参数个数 | 每个命令 −1 个参数 | Tauri 按名绑定，无顺序依赖 |
| 前端调用点 | 32 个文件改传参形态 | 分类批处理（见 `implement.md` P2） |
| 测试 | 断言语义不变，只改传参 | AC4 判据 |

**回滚**：按 `implement.md` 阶段边界 revert；后端与前端可分别回滚（中间态下旧前端传双字段
给新后端会因缺 `workspace` 报错 —— 故两阶段须同批发布，或先改后端加 `#[serde(default)]`
过渡。**决策：同批提交，不走过渡态**（本地应用无热更新，前后端同二进制）。

---

## 5. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 68 + 64 处改动面大，单 PR 难审 | `implement.md` 分 5 阶段，每阶段独立可验证；A/B/C 分类使每批同构 |
| 漏改某个调用点（前端 32 文件） | **类型检查即判据**：`gitApi` 收对象后，漏改的调用点传 `string` 给 `WorkspaceSession` 参数直接编译错 —— 用编译器找漏，不靠 grep |
| C 类判错（把不需地址的命令也改了） | 落地时逐个判定 + 列表记入 `git-domain.md`；review 对照列表指认 |
| `WorktreeSnapshotItem` / worktree 操作命令被误改 | R2.3 例外判据写入 spec；护栏只拦"散签传入"，不强迫改签名 |
| 手搓字面量绕过 class 私有构造 | 类型已挡；护栏补 `{ projectId, worktreePath }` 字面量形态（AC6） |

---

## 6. 未采纳方案

| 方案 | 否决理由 |
| --- | --- |
| 保留 `gitApi` 散签，只给 `ProjectCommands` 收对象 | 只堵了一条路径；`gitApi` 是主路径（32 消费者）且散签的可选性缺陷原样保留 |
| 把 `gitApi` 与 `ProjectCommands` 合并为一套 | 37 个能力不对等；合并要么丢能力要么把窄面撑胖，且 diff 面覆盖全部 git 消费点 |
| 只改后端签名，前端不动 | 前端仍可手搓地址（F1 未解）；且后端改收单对象后旧前端立刻不兼容 |
| 给 `worktree_path` 加 `#[serde(default)]` 过渡期 | 本地应用无热更新，前后端同二进制；过渡态只增加一个无人走过的代码路径 |
| 新增 `resolve_workspace_session` 包装 | `resolve_workspace_target` 已存在且语义正确；再包一层是同一知识的第二表示 |

---

## 7. 与前置任务的关系（依赖已闭合）

`10-09-file-io-workspace-scope`（已归档）提供了本任务复用的全部零件：

| 零件 | 落点 | 本任务用法 |
| --- | --- | --- |
| `WorkspaceSession` 值对象（class + 私有构造） | `common/git/workspace_ref.rs:40` / `workspaceRef.ts:67` | 直接复用，不新建 |
| `resolve_workspace_target` | `app_state.rs:183` | 扩展为 git 域唯一入口 |
| file 域 8 命令收口正例 | `file/commands.rs:51,101,126,138…` | 逐字同构的迁移模板 |
| `check_file_io_scope` 护栏 | `tools/guards/checks/check_file_io_scope.py` | 扩展或新建（R3.1） |

**本任务不引入任何新类型** —— 这是设计自检判据：若实现期出现"新的地址类型"，
说明又造了第二表示，应回到复用 `WorkspaceSession`。
