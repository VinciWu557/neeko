# 冲突决议闭环（删除侧分派 + 区域 splice + 收敛）

> **本任务是 `10-14-git-conflict-diff-view` 的 Layer 2**（父任务只交付 Layer 1 只读展示）。
> **硬前置：父任务的批 0 / 1 / 2 必须已合入** —— 本任务需要
> `read_conflict_stages` / `ConflictKind` / `MergeRegion` / `DiffRevision.conflict` /
> `useConflictStages` / `ConflictView` 全部就位。父任务未合入时开工会在编译期就缺符号。
> 父/子目录树不是依赖系统，这条前置是**手写在这里的**、必须人工确认。

## 背景

Layer 1 交付后，冲突文件已能在 Diff 面板里**正确显示**三侧内容与区域，但**不能决议** ——
用户在面板里看完仍然要切回终端手改工作区文件。Layer 2 把「逐区域选一侧 → 写回 → 标记已解决」
接上，形成闭环。

技术依据**已实测取证，不重做实验**（全部在父任务 `design.md` §2.5）：

| 事实 | 实测结果 |
| --- | --- |
| `git checkout --ours`（我方是删除侧，DU） | `error: path 'c.txt' does not have our version`，**工作区不变** |
| `git checkout --theirs`（对方是删除侧，UD） | `error: path 'c.txt' does not have their version` |
| `git rm -- <path>`（对冲突路径） | 可用，**同时清 index 与工作区**（`ls-files -u` 与 `porcelain` 均空） |
| stage blob 写字节 + `git add` | 可用（DU 取 stage 3 → `ls-files -u` 空，`porcelain` = `A  c.txt`） |
| 空 base 提交 merge 引擎 | 可用（git2 字面量构造空 `IndexEntry` / `git merge-file --object-id` 空 blob） |

⇒ **不能把 `git checkout --ours/--theirs` 当作通用写回**。这是本任务存在的第一理由。

## Goal

让冲突文件在 Diff 面板里**可决议**：逐区域 `Ours / Theirs / Both` 与整文件二选一，
写回工作区并 `git add` 清除 unmerged 标记，且视图在快照事件到达后自动收敛到普通 diff。

## Requirements

**L2-R1 · 写回按依据分派（两条原语，不是一句 checkout）**
统一为 `write_side_bytes(path, side)` 与 `delete_path(path)` 两条原语（映射表见父任务
design §2.5）。分派依据 = `ConflictKind` + 决议是针对「存在侧」还是「删除侧」。

**L2-R2 · 删除侧不得走 `--ours/--theirs`**
对该侧调 `git checkout --ours|--theirs` 会报 `does not have our/their version` 且工作区不变。
删除类的四条路径：采用「存在侧」= 写字节 + `git add`；采用「删除侧」= `git rm -- <path>`。

**L2-R3 · 缺失 stage 的占位写 0 字节（不改 API 语义）**
`write_side_bytes` 遇到 side 缺失时写 **0 字节空文件**，目的是让随后的 `git add` 能 stat 该路径。
**API 层仍然报 `null`**（父任务 L2-R3 的契约不变）—— 空占位只存在于写回实现内部，不上浮到 wire。

**L2-R4 · 区域 splice 以服务端重算为准**
决议时**重读 index stages → 重算 merged**，按 `MergeRegion.merged_start/merged_end` 替换；
**不信前端行号**（前端只提交 `region.id → take`）。未决议的区域保留 marker，用户可分批决议。

**L2-R5 · 复用既有写与暂存机制，不新增写路径**
写工作区走 `file::services::write_file_content`，`git add` 走 `operations::stage_files`
（与 `useGitActions.handleStageFile` 同一条路径）。任何「为冲突解决新增写文件命令」的想法
都要先说明为什么不复用。

**L2-R6 · 写后快照新鲜度**
命令成功后调 `wait_status_fresh(&state, &repo)`（`git-domain.md` §10）。不调它 = 前端立刻重读
拿到写前数据（「操作成功但列表要手动刷新」的同因）。

**L2-R7 · 「已解决」是正常收敛，不是错误**
决议后该 path 退出 unmerged set → `get_conflict_stages` 按父任务契约返回 `Err` →
`useConflictStages` 映射为 `notConflicted`（不是 `error`）→ 视图回退普通 diff。
把已解决画成错误态等于给用户一个假警报。

**L2-R8 · 命令层极薄（红线 6）+ 路径校验（红线 8）**
`resolve_conflict` 只做参数校验 + 调度；路径过 `validate_repo_relative_path`。

## Acceptance Criteria

> **四类决议的精确落盘结果**（全部实测，照抄勿推）：`porcelain` 列**逐例不同**，
> 唯一跨例恒真的是「该 path 退出 unmerged set」（`ls-files -u` 为空）。

| kind | 决议 | 工作区 | `ls-files -u` | `git status --porcelain` |
| --- | --- | --- | --- | --- |
| DU | 采用**对方**（存在侧） | = stage 3 内容 | 空 | `A  c.txt` |
| DU | 采用**我方**（删除侧） | 文件不存在 | 空 | **空**（两侧均无此文件 → 净无变更） |
| UD | 采用**我方**（存在侧） | = stage 2 内容 | 空 | **空**（与 HEAD 一致 → 无变更） |
| UD | 采用**对方**（删除侧） | 文件不存在 | 空 | `D  c.txt`（从 HEAD 存在 → 删除） |
| UU | 区域拼接 / 整文件 | = 拼接结果 | 空 | 按内容 vs HEAD 而定 |

- [ ] 决议闭环，**上表四行逐条可验**（不得用「同理」跳过 UD 两行 —— 它的 `porcelain`
  与 DU **不同**）；
- [ ] **删除侧不得走 `--ours/--theirs`**：`resolve_conflict` 内不得出现「对 missing stage 调
  `checkout --ours|--theirs`」的形态（实测该调用报 `does not have our/their version`）;
- [ ] 区域决议 splice 以服务端重算的 merged 为准；未决议区域保留 marker（分批决议可用）；
- [ ] `git-status-snapshot` 事件到达后视图自动收敛到普通 diff（走 `notConflicted`，非错误态）；
- [ ] 写回后 `git add` 后 `git diff HEAD` 语义正常（不再是冲突态）；
- [ ] `resolve_conflict` 命令首参 `workspace: WorkspaceSession`（护栏
  `check_workspace_session_addressing` 保持绿）；
- [ ] 工作区字节断言走 `assert_content_eq`（红线 11），夹具用 `TestRepo` / `init_repo`；
- [ ] `pnpm check` 全绿。

## 非目标

- 不做编辑器内联三栏合并（`@codemirror/merge` 未安装；父任务已登记）。
- 不改 Layer 1 的读契约（`ConflictStages` / `ConflictKind` / `DiffRevision` 形状不动）。
- 不做 rebase 场景（`--ours/--theirs` 语义相反，父任务 T4 登记）。
- 不做「取消合并 / abort merge」（`git merge --abort`）：那是合并流程入口，不是 diff 展示。
- 不新增 `TabData.kind` / 地址类型 / 写文件命令。

## 取证命令（复现本 PRD 的每一条，父任务已跑过）

```bash
# ① 删除侧 checkout 报错（L2-R2 的由来）
#    DU：我方 git rm / 对方改 → git checkout --ours -- c.txt → "does not have our version"
# ② git rm 对冲突路径双清
git ls-files -u ; git rm -- c.txt ; git ls-files -u ; git status --porcelain
# ③ stage blob 写回 + add
git cat-file blob $(git rev-parse :3:c.txt) > c.txt && git add -- c.txt && git status --porcelain
# ④ 写后快照新鲜度契约
grep -n "pub async fn wait_status_fresh" src-tauri/src/git/services/status.rs   # → 30
```

## 依赖声明（手写，非树位置隐含）

```
10-14-git-conflict-diff-view  批 0/1/2（Layer 1）  ──硬前置──►  本任务
```

若父任务批 0/1/2 未合入：本任务 `implement.md` 的批 3 会在编译期缺符号，**不要跳过前置自行实现读路径**。
