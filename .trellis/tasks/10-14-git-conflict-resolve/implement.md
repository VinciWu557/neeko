# 执行计划：冲突决议闭环（Layer 2）

> 任务：`.trellis/tasks/10-14-git-conflict-resolve`（PRD `prd.md`）
> 父任务：`10-14-git-conflict-diff-view`（Layer 1 = 读路径 + 只读展示）
>
> **硬前置（人工确认，不靠目录树）**：父任务批 0 / 1 / 2 已合入。开工前先跑：
> ```bash
> ls src-tauri/src/common/git/conflict/          # types.rs / classify.rs / regions.rs / cap.rs / local.rs / shell.rs 就位
> grep -n "pub async fn read_conflict_stages" src-tauri/src/common/git/operations/conflict.rs
> grep -n "type: 'conflict'" src/shared/types/git.ts
> ls src/features/git/components/conflict/       # ConflictView.tsx 就位
> ```
> 缺任一项 → 停，先合父任务；**不要在本任务里补实现读路径**（那会让真值口径出现第二份）。
>
> **实现依据**：父任务 `design.md` §2.5 的映射表与实测表（已取证，不重做实验）。
> 本文件的批号与父任务对齐（批 0/1/2 属父任务，本任务只有批 3 + 批 6 的收尾）。

---

## 批 3 · 决议闭环（本任务主体，内容与父任务 design §2.5 一致）

**落点**：`src-tauri/src/common/git/operations/conflict.rs`（追加）
+ `src-tauri/src/git/commands/conflict.rs`（追加）
+ `src/features/git/hooks/useConflictResolve.ts`（新增）
+ `src/features/git/components/conflict/ConflictView.tsx`（接按钮）
+ `gitApi.ts` / `project.ts` / `commandFactory.ts`（各加一条委托）

**动作**
1. 后端 `operations/conflict.rs::apply_conflict_resolution(transport, work_dir, path, resolution)`：
   - **重读 index stages**（不信前端行号，防 splice 错位 —— 父任务 T2）；
   - 统一两条写回原语（父任务 design §2.5）：
     - `write_side_bytes(path, side)`：side 存在 → 写其 blob 字节；**side 缺失 → 写 0 字节**
       （空文件，为让 `git add` 可 stat）→ `git add -- path`；
     - `delete_path(path)` → `git rm -- path`（同时清 index 与工作区）；
   - 按 kind 分派（父任务 design §2.5 映射表）：可区域合并 + `Regions` → 重算 merged → 按
     `merged_start/end` splice（未决议区域保留 marker）；其余 + `WholeFile` → 选存在侧走
     `write_side_bytes` / 选删除侧走 `delete_path`；
   - **禁止对 missing stage 调 `git checkout --ours|--theirs`**（实测报错）；
   - 写工作区 `file::services::write_file_content`；
   - `git add`（`operations::stage_files`，与 `useGitActions.handleStageFile` 同路径）。
2. 命令 `resolve_conflict(workspace, file_path, resolution, state)`：
   写后 `wait_status_fresh`（git-domain §10）。
3. 前端 `hooks/useConflictResolve.ts`：提交 + 乐观置位 + 失败回滚 + `reload()`。
4. `ConflictView` 接上决议按钮（区域 `Accept Ours/Theirs/Both` + 整文件
   `Take Ours`/`Take Theirs`）。
5. **在 `apply_conflict_resolution` 的 kind 分派 match 处加注释指向父任务 T4**（rebase 下
   `--ours/--theirs` 语义相反：本任务按 merge 语义实现、且决议路径已不用 `--ours/--theirs`，
   但文案与「哪侧是 ours」的语义仍需在 rebase 下重判）。

**验证**：
- 单测（**删除侧四条分支必须逐条覆盖**）：
  - UU 区域决议 → 写回内容 = 预期拼接，`ls-files -u` 为空；
  - DU 选存在侧（对方）→ 工作区 = stage 3 内容 + `porcelain` = `A  c.txt`；
  - DU 选删除侧（我方）→ `git rm`：`ls-files -u` 与 `porcelain` 均空，文件不存在；
  - UD 选我方 / 选删除侧 同理；
  - **反证**：断言不出现 `checkout --ours|--theirs` 对 missing stage 的调用（可静态断言或
    行为断言：不返回 `does not have our/their version` 类错误）；
- 工作区字节断言一律走 `assert_content_eq`（红线 11），夹具用 `TestRepo` / `init_repo`
  （`core.autocrlf=false` + `.gitattributes * -text` 双保险）；
- 集成：`git-status-snapshot` 事件到达 → 视图收敛到普通 diff（`notConflicted` 分支）；
- 回归：`git add` 后 `git diff HEAD` 语义正常（不再是冲突态）。

```bash
cargo test --manifest-path src-tauri/Cargo.toml conflict
npx vitest run src/features/git
# 反证：决议路径不得出现删除侧的 checkout 调用
grep -n "checkout.*--ours\|checkout.*--theirs" src-tauri/src/common/git/operations/conflict.rs   # 期望 0
```

---

## 批 6 · 文档沉淀 + 全量验证（本任务收尾）

- `.trellis/spec/backend/git-domain.md`：在父任务已落地的「冲突读路径」小节后**追加决议小节**
  （两条写回原语 + 删除侧报错实测 + 映射表 + `wait_status_fresh` 收口）。
- `docs/domain-model.md`：若父任务已在 git 冲突小节里提到决议，此处校对；
  否则补「决议 = 从 index stages 重算 + 写回 + `git add`」。
- `pnpm check` 全绿；`npx vitest run src/features/git` 不回归。
- 逐条勾 PRD AC。
- 端到端手测（需 `pnpm tauri dev`，无 GUI 则显式记为未执行）：
  造 UU / DU / UD / binary 冲突 → 各自打开 → 决议「用对方」/「删除」→
  写回正确 → 文件退出冲突态 → 视图收敛；本地与 WSL/SSH 行为一致。
- `add_session.py` 记录；`task.json` 状态更新；归档另起 commit。

---

## 命令速查

```bash
# 批 3（Rust）
cargo test --manifest-path src-tauri/Cargo.toml conflict
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
# 删除侧反证（L2-R2）
grep -rn "checkout" src-tauri/src/common/git/operations/conflict.rs    # 不应有 --ours/--theirs 用于缺侧
grep -n "wait_status_fresh" src-tauri/src/git/commands/conflict.rs     # 写后收口必须存在
grep -n "validate_repo_relative_path" src-tauri/src/git/commands/conflict.rs
# 批 3（前端）
npx vitest run src/features/git
pnpm type-check
# 全量
pnpm check
```

## 边界复述

- **硬前置**：父任务批 0/1/2 已合入；缺符号时停，不自行补读路径；
- **不做**编辑器内联三栏合并（`@codemirror/merge` 未装）；
- **不做** rebase 场景（`--ours/--theirs` 语义相反）；
- **不做** `merge --abort`（属合并流程入口，非 diff 展示）；
- **不新增** `TabData.kind` / 地址类型 / 写文件命令；
- API 层 `null` 与写回层的 0 字节空占位是两层，不许互相泄漏；
- 改动停在未提交状态。
