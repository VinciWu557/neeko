# 执行计划：Diff 面板 Git 冲突展示

> 任务：`.trellis/tasks/10-14-git-conflict-diff-view`（PRD `prd.md` · 设计 `design.md`）
> 顺序原则：**先立纯语义（可独立验）→ 再接通读路径 → 前端只读展示 → 护栏 → 文档与全量**。
> 每批独立可回滚；改动停在未提交状态（是否提交由开发者决定）。
>
> **本计划只覆盖 Layer 1（读路径 + 只读展示）**。Layer 2（决议闭环）在子任务
> `10-14-git-conflict-resolve`，其 `implement.md` 复用本文件的 design §2.5 映射表。
> 两层的可验收面独立：Layer 1 交付后「冲突文件能看到正确内容」已可独立验收
> （且已修掉本地/远端显示分叉这一现存缺陷），不依赖 Layer 2。
>
> **批号无重排**：批 3（决议闭环）整体移交子任务，本文件保留批 0/1/2/4/5 编号 —— 这样
> 两份 implement.md 的批号可直接对上，不会出现「同一个批号在两处指不同事」。
>
> **前置事实（实现者必须先知道，否则会做错）**：
> - 冲突真值 = **index unmerged stages**，不是工作区 marker（四类冲突无 marker，design §0）；
> - **区域决议只对 `BothModified` / `BothAdded` 成立**（design §0.1：删除不是内容）；
> - 缺 base（AA）用**字面量构造的空 `IndexEntry`** 提交 git2 merge，实测可用（design §0.2）；
> - `git2` 的 `merge_file_from_index` 只接受三个 `&IndexEntry`（不是 blob oid）；
> - `git merge-file` 的 **exit code = 冲突数**，非零不是错误。

---

## 批 0 · 纯语义层（无 I/O，先 Red）

**落点**：`src-tauri/src/common/git/conflict/{mod.rs, types.rs, classify.rs, regions.rs, cap.rs}`

**动作**
1. `mod.rs`：只 `pub mod` + `pub use`（红线 9：无 fn / impl）。
2. `types.rs`：`ConflictKind`（5 variant，**无 BothDeleted** —— DD 不产生 unmerged 条目）、
   `ConflictSide`（`content: Option<String>`）、`MergeRegion`、`ConflictStages`。
3. `classify.rs`：`classify(has_base, has_ours, has_theirs, any_binary, paths_differ)`。
   单测必须覆盖：
   - UU `(true,true,true,false,false)` → `BothModified`；
   - AA `(false,true,true,false,false)` → `BothAdded`；
   - DU `(true,false,true,…)` / UD `(true,true,false,…)` → `ModifyDelete`；
   - rename/rename `(true,true,true,false,true)` → `RenameRename`；
   - binary 优先：任意组合 + `any_binary=true` → `Binary`；
   - `is_region_mergeable()` 仅 `BothModified` / `BothAdded` 为真（**防 T9**：
     若把 `ModifyDelete` 也算进去，选「我方删除」会写出空文件）。
4. `regions.rs`：`build_regions(merged_line_count, Vec<RawRegion>, base/our/their_lines)`
   + 区间夹取（越界不 panic）。单测：正常区块、区间越界、空区域列表。
5. `cap.rs`：`cap_conflict_payload`（分栏保底 + 行边界截断 + `truncated` 上浮）。
   单测（**红线 4 硬断言**）：
   - 三侧各 ~900KB → `serde_json::to_vec` 实测 **≤ 2MB**；
   - 一侧 10MB / 另两侧小 → 另两侧 `truncated == false`（**保底不得饿死**）；
   - 小载荷不动（`truncated == false`）。

**验证**：`cargo test --manifest-path src-tauri/Cargo.toml conflict`；`cargo clippy -D warnings`。

---

## 批 1 · 读路径（两 transport 同契约）—— **本任务的技术核心**

**落点**：`conflict/{probe.rs, local.rs, shell.rs}` + `operations/conflict.rs`
+ `git/commands/conflict.rs` + `lib.rs` 注册（+ `capabilities/default.json` 若需）

**动作**
1. `probe.rs`：`ConflictSideProbe`（字节 → binary 判定 + 大小）。
   **binary 判据与 `common/file/reader.rs::is_binary_file` 同**：前 8KB 含 `0x00`。
   （该函数是 private → 本模块自持一份同判据实现，在 docstring 写明与之同源。）
2. `local.rs`（git2，**在 `spawn_blocking` 内**，红线 3）：
   - `index.has_conflicts()` 为假 → `bail!`（契约 ①）；
   - `index.conflict_get(path)` → 三个 `Option<IndexEntry>`；逐侧 `repo.find_blob(oid)`；
   - 三侧 path 取自 `IndexEntry.path`（rename/rename 会不同）；
   - `is_region_mergeable()` 时：
     - 有 base → `merge_file_from_index(&base, &ours, &theirs, opts.style_diff3(true))`；
     - 无 base（AA）→ **字面量构造空 base `IndexEntry`**
       （`mode=0o100644, flags=0, flags_extended=0, id=repo.blob(b"")`, `path` 用 ours 的），
       再调用同一 API（实测 design §0.2）。
3. `shell.rs`（WSL / SSH）：
   - `ls-files -u -z -- <path>` → `(<mode>, <oid>, <stage>, <path>)`（`-z` 免 C 转义）；
   - `git cat-file blob <oid>` 逐 stage 取字节；
   - 可区域合并时 `git merge-file -p --object-id --diff3 -L HEAD -L BASE -L THEIRS
     <ours> <base|empty-oid> <theirs>`；**空 base 用 `git hash-object -t blob /dev/null`**；
   - exit code 非零 = 冲突数，视为成功；仅在 spawn 失败等真错误时上抛。
4. `operations/conflict.rs::read_conflict_stages` 派发（**照抄 `operations::get_file_diff`**）：

   ```
   transport.open_repo_async(work_dir)
     Some(_) → spawn_blocking(read_local)
     None    → read_shell
   → cap_conflict_payload(stages)        // 唯一封顶出口（红线 4）
   ```
5. 命令层 `get_conflict_stages(workspace, file_path, state)`（红线 6）：
   `resolve_workspace_target` → `validate_repo_relative_path`（红线 8）→ 调 operations。
6. `lib.rs` 的 `generate_handler!` 注册（git 段，与 `get_file_diff` 相邻）。

**验证**（**每类一条夹具测试，先 Red 再 Green**；夹具路径一律 `tempdir()` 推导，红线 13）：

| 用例 | 期望 | 反证的是什么 |
| --- | --- | --- |
| UU | kind=BothModified，三侧有内容，regions 非空，**且三侧内容不含 `<<<<<<<`** | 当前本地 git2 路径 0 hunks |
| AA | kind=BothAdded，`ancestor.content == None`，regions 非空 | 「无 base 无法合并」的猜 |
| DU | kind=ModifyDelete，`ours.content == None`，**regions 为空** | 「缺失 stage 归一为空串」 |
| UD | kind=ModifyDelete，`theirs.content == None`，**regions 为空** | 同上 |
| rename/rename | kind=RenameRename，三侧 `path` **各不相同**，regions 为空 | 「三侧同路径」的假设 |
| binary | kind=Binary，三侧 `content == None` | 乱码进 IPC |
| 已解决（stage 0） | **`Err`**（不是空冲突） | 「空即已解决」的歧义 |
| 上限 | 三侧各 900KB → 序列化 ≤ 2MB | 红线 4 |

```bash
cargo test --manifest-path src-tauri/Cargo.toml conflict
grep -rn "unwrap_or_default()\|unwrap_or(\"\")" src-tauri/src/common/git/conflict/   # 期望 0
```

---

## 批 2 · 前端只读展示（**修掉跨 transport 分叉**）

**动作**
1. TS 类型：`shared/types/git.ts` 的 `DiffRevision` 加 `{ type: 'conflict' }`（R7）；
   新增 `ConflictKind` / `ConflictSide` / `MergeRegion` / `ConflictStages` / `ConflictResolution`。
2. `gitApi.ts`：`getConflictStages(workspace, filePath)`（首参 `workspace: WorkspaceSession`，
   红线 + `check_workspace_session_addressing` B 判据）。
3. `ProjectCommands`（`shared/types/project.ts`）+ `commandFactory.ts` 纯委托
   （与 `getFileDiff` 同形，见 `commandFactory.ts:54`）。
4. `hooks/useConflictStages.ts`：与 `useDiffData` 同构（三刷新信号）；
   **`Err` → `notConflicted`（正常收敛），不是 `error`**（R10）。
5. `components/conflict/`：`ConflictView` / `ConflictToolbar` / `ConflictRegionBlock` /
   `ConflictOpaqueCard`（binary / rename / delete 的不透明卡）+ `index.ts` 门面。
   只读版：三侧区块 + 区域列表 + 「在编辑器打开」；**决议按钮先不接线**。
6. `PaneContent.tsx`：既有 `switch` 的 `case 'diff'` 内按
   `diffSource.revision.type === 'conflict'` 二选一渲染 `ConflictView` / `DiffView`
   （`DiffView` **零改动**）。
7. **入口决策**：新增 `utils/conflictEntry.ts::revisionForChange(file)`（复用
   `isConflictedEntry`）；`GitCommitPanel.handleFileSelect` 改为
   「查 `changedFiles` → `revisionForChange` → 开对应视图」。
   **零新增 prop 管道**：`changedFiles` 与 `onFileSelect` 都已在 `GitCommitPanel` 手边。
8. `useOpenDiffTab` / `useSingletonDiff` 加参数或伴生函数以支持 `conflict` 修订（**不改变
   现有 worktree 行为**）。

**验证**：`npx vitest run src/features/git`；`pnpm type-check`；
AC「本地路径不再 No changes」的反证（打开冲突文件 → 进冲突视图）。
`grep -rn "revision: { type: 'worktree' }" src/features/git/hooks/useOpenDiffTab.ts` 应为
「按 file 判定」而非无条件。

---

## 批 3 · 决议闭环 —— **已移交子任务，本任务不做**

Layer 2 的全部内容（`apply_conflict_resolution` 两条写回原语、`resolve_conflict` 命令、
`useConflictResolve`、区域/整文件决议按钮、删除侧四条分支单测）见
**`10-14-git-conflict-resolve/implement.md` 批 3**。

**硬依赖**：子任务开工前，本任务的批 0/1/2 必须已合入 —— 它需要 `read_conflict_stages`、
`ConflictKind`、`MergeRegion`、`DiffRevision.conflict` 全部就位。

---

## 批 4 · 护栏

**动作**
1. **先落文档**（`registry.py::_validate` L81 强制校验 `GUARD.docs` 存在）：
   `docs/domain-model.md` 增 git 冲突小节（真值来源 = index stages、kind 与 mergeable 的关系、
   `null` ≠ 空串）。
2. 新护栏 `tools/guards/checks/check_conflict_read_contract.py`
   + **强制**同名测试 `tools/guards/tests/test_check_conflict_read_contract.py`
   （`registry.py::_validate`：缺同名测试 = RegistryError）。
   判据 A1–A6 见 design §3（A1：`<<<<<<<` 字面量只在 `regions.rs`；A2：缺失 stage 不许
   `unwrap_or_default`；A3：唯一封顶出口；A4：前端不解析 marker；A5：`conflict/**` 字符串字面量内
   无 `/dev/null` —— POSIX 设备名在 Windows CI 上不存在，而夹具测试在 macOS/Linux 上永远绿，
   只有静态判据拦得住；A6：传输实现不得自建 `ConflictStages` 字面量，必须经
   `probe::assemble_stages` —— 删掉重复只是清今天，护栏才能拦住明天）。
   台账形态照抄 `check_workspace_identity`（**目标恒零，不配计数台账**），
   docstring 写明「扫描集为空判 ERROR」与目标恒零的理由。
3. `pnpm guards list` 确认新护栏被装载。

**验证**（**Red 证据必留**）：故意在 `local.rs` 加一行 `"<<<<<<<"` 字面量 → 确认被拦 → 删除；
`pnpm lint` 全绿。

---

## 批 5 · 文档沉淀 + 全量验证

- `docs/domain-model.md`：git 冲突小节（批 4 已落，此处校对）。
- `.trellis/spec/backend/git-domain.md`：新增冲突读路径小节
  （三态契约同族、index stages 真值、两 transport 同契约、载荷封顶）+ **登记
  `@@@`（`--cc`）被 `parsers/diff.rs:139` 静默丢弃为已知边界**（R11）。
- `pnpm check` 全绿；`npx vitest run src/features/git`（基线 63 个测试文件）不回归。
- 逐条勾 PRD AC。
- 端到端手测（需 `pnpm tauri dev`，无 GUI 则显式记为未执行）：
  造 UU / AA / DU / UD / binary 五种冲突 → 各自打开 → 三侧与区域正确、
  **不再出现 No changes / 乱码**；本地与 WSL/SSH 行为一致。
  （决议写回的手测归子任务 `10-14-git-conflict-resolve`。）
- `add_session.py` 记录；`task.json` 状态更新；归档另起 commit。

---

## 命令速查

```bash
# 批 0/1（Rust）
cargo test --manifest-path src-tauri/Cargo.toml conflict
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
# 批 2（前端，只读展示）
npx vitest run src/features/git
pnpm type-check
# 批 1 红线 8/6 反证
grep -rn "unwrap_or_default()" src-tauri/src/common/git/conflict/          # 期望 0
grep -n "validate_repo_relative_path" src-tauri/src/git/commands/conflict.rs
grep -n "spawn_blocking" src-tauri/src/common/git/conflict/local.rs
# 批 2 入口反证（不得再无条件开 worktree）
grep -n "revision: { type: 'worktree' }" src/features/git/hooks/useOpenDiffTab.ts
# 批 4 护栏
python3 -m unittest discover -s tools/guards/tests -t tools -p "test_check_conflict_read_contract.py"
pnpm guards list
# 全量
pnpm check
```

## 边界复述

- **不修** `parsers/diff.rs` 的 `@@@` 静默丢弃（R11：只登记）；
- **不做**编辑器内联三栏合并（`@codemirror/merge` 未装）；
- **不做** modify/delete 的区域级交互（语义上不存在，design §0.1）；
- **不做** rebase 场景（T4：`--ours/--theirs` 语义相反）；
- **不做 Layer 2 的决议闭环**（`apply_conflict_resolution` / `resolve_conflict` /
  `useConflictResolve` / 决议按钮）：已移交 `10-14-git-conflict-resolve`（其硬前置 = 本任务的批 0/1/2）；
- **不新增** `TabData.kind` / 地址类型 / 写文件命令；
- 不使用**工作区文件**作为 merge 输入（真值只从 index stages 来）；
- API 层 `null` 与空串不许互相偷换；
- 改动停在未提交状态。
