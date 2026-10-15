# Diff 面板 Git 冲突展示（index 三态寻址 + 区域决议）

> 前置：无（本任务独立）。参考实现：IDEA 的 Merge Conflicts 工具窗 + VSCode 的
> 「Current / Incoming / Both」冲突 CodeLens。
> 本 PRD 的每条事实都有实测命令可复现（见「取证」段），**不接受「看起来应该」**。

## 背景：冲突文件在当前 Diff 面板里是跨 transport 不一致的

单文件 diff 只有三种合法形态（`git-domain.md` §5）：已跟踪干净 → 空 hunks；已跟踪有改动 →
对应 hunk；未跟踪 → 全 `Added`。**冲突文件不属于其中任何一种**，于是两条实现在这里分叉：

| 路径 | 实测行为 | 命令 |
| --- | --- | --- |
| 本地（git2，`local::get_file_diff`） | delta = `Delta::Conflicted`，**hunks = 0** → 面板显示「No changes to display」 | git2 探针：`diff_tree_to_workdir_with_index` → `status=Conflicted, hunks=0`（三条 diff 基线全部如此） |
| WSL/SSH（shell，`get_file_diff_shell`） | `git diff HEAD -- <path>` 出正常 hunk，把 `<<<<<<< / ======= / >>>>>>>` 当**普通新增行** | `git diff HEAD -- f.txt`（含 marker 行，全为 `+`） |

同一份冲突文件，**本地看到「无变更」，远端看到「一堆莫名其妙的新增行」**。这是本任务要修的第一个缺陷。

### 为什么不能走「解析工作区 marker」这条直觉路

marker 是合并尝试的**渲染产物**，不是冲突本身。实测（`git ls-files -u` / 工作区字节）：

| 冲突类型 | 工作区有 marker？ | stage 分布 | 取证 |
| --- | --- | --- | --- |
| 双方改同文件（UU） | ✅ | 1+2+3 | `printf 'ours\n' > f` / `printf 'theirs\n' > f` |
| 双方各自新增同名（AA） | ✅ | **无 stage 1**（2+3） | 两侧各自 `git add newf.txt` |
| 我方删 / 对方改（DU） | ❌ | 1+3（**无 stage 2**） | `git rm c.txt` vs 改 `c.txt`；工作区保留对方版本 |
| 我方改 / 对方删（UD） | ❌ | 1+2（**无 stage 3**） | 改 `c.txt` vs `git rm c.txt`；工作区保留我方版本 |
| 双方都删（DD） | ❌ | **无任何 unmerged 条目**（不进 status） | 两侧都 `git rm` → merge 直接成功 |
| rename/delete | ❌ | 1+3，**同路径**（重命名后的新路径） | `git mv a b` vs `git rm a` |
| rename/rename | ❌ | 三侧**路径各不相同** | `git mv a b` vs `git mv a c` → `DD a.txt` + `UA b.txt` + `AU c.txt`，stage2 在 `c.txt`、stage3 在 `b.txt` |
| binary（任一侧含 NUL） | ❌ | 三侧齐备但不可文本合并 | `printf '\x00\x01BIN'` 两侧冲突 → 工作区保留我方字节，无 marker |

⇒ **三类冲突（modify/delete、binary、rename/rename）没有可解析的 marker；rename/rename 的
三侧连路径都不同。**任何以「读工作区、找 `<<<<<<<`」为真值来源的实现，在这三类上必然静默失真。

### 顺带取证的两条既有事实

- `git diff -- <path>`（**不带 HEAD**）在冲突时输出 `--cc` 合并格式 `@@@ -1,3 -1,3 +1,7 @@@`，
  而 `parsers/diff.rs:139` 是 `strip_prefix("@@ ")` → **整段 hunk 被静默丢弃**。当前生产路径
  带 `HEAD`（不会触发），但这是「拿 `git diff` 凑冲突」这条取巧路的现成陷阱，须登记。
- 状态栏已经有一个 `conflicts` 槽位（`status-bar/registry.ts:21`），但它渲染的是
  **LSP 扩展路由冲突**（`lspStore.extensionConflicts`，`*.ts: rust wins over ...`），
  与 git 合并冲突无关。本任务**不复用**该槽位（两个同义词会让读者以为是一件事）。

## Goal

让冲突文件在 Diff 面板里**可读、可决议**：以 index 的 unmerged stages（1/2/3）为唯一真值来源，
按冲突类型给出正确的三侧视图与区域决议，并修掉本地/远端的显示分叉。

## 交付分层（已定案）

本任务按**分层交付**，父任务（本目录）拥有全部需求与跨层验收；Layer 2 拆为独立子任务
（`10-14-git-conflict-resolve`，见其 `prd.md`）。理由：两层的可验收面独立 ——
Layer 1 交付后「冲突文件能看到正确内容」已可独立验收，决议语义（删除不是空文件、区域 splice）
是另一组判据。

| 层 | 内容 | 需求 | 状态 |
| --- | --- | --- | --- |
| **Layer 1** | 读路径 + 只读展示（**本任务**） | R1 / R2 / R3 / R4 / R5（读侧） / R6 / R7 / R8 / R11 | 本任务交付 |
| **Layer 2** | 决议闭环（子任务） | R9 / R10 / R5（写后重算） | `10-14-git-conflict-resolve` |

**依赖方向写在子任务里**（父/子不是依赖系统）：Layer 2 **硬依赖 Layer 1 已合入**（需要
`read_conflict_stages` / `ConflictKind` / `MergeRegion` / `DiffRevision.conflict` 全部就位）。
子任务 `prd.md` 的首段必须声明这一前置。

**Layer 1 的单层价值必须自证**：它修掉的是同一份冲突文件「本地显示 No changes、远端显示一堆
新增行」的跨 transport 分叉 —— 这是当前用户可见的缺陷，不依赖 Layer 2。

## Requirements

**R1 · index 三态为唯一真值来源**
新增 `read_conflict_stages(workspace, path)`，返回 base/ours/theirs 三侧现状 + 冲突类型
+ 合并文本 + 冲突区域。**禁止**从工作区字节反解冲突（见上方取证表）。

**R2 · 冲突类型必须是显式分类（不是布尔）**
`ConflictKind` 覆盖上表全部形态，且由 **stage 存在性 + 路径是否分歧** 纯函数判定
（`classify.rs`，无 I/O）。UU 与 AA 必须区分（用户看到「无 base」才知道没有共同祖先）。
DD 不在其中 —— 它不产生 unmerged 条目，因此**也不会出现在冲突视图入口**（下面 R6 的
纯函数复用 `isConflictedEntry`，与 git 语义自动一致：`isConflictedEntry` 只认含 `U`
或 `AA`/`DD` 的 XY，而 DD 不产出条目）。

**R3 · `Option` 三态，缺失 stage 不许归一为空串**
`ConflictSide.content: string | null`：`null` = 该 stage 不存在（DU 的 ours / UD 的 theirs /
AA 的 base）。**禁止** `unwrap_or_default()` / `?? ''`：把「我方删除了这个文件」画成
「我方版本是空文件」是误导，且正好丢掉决议所需的语义。

**R4 · 区域合并只对「双方都有实体内容」的两类做，且输入必须是 index stages**
- **可区域合并：UU（双方改同文件）、AA（双方各自新增同名）** —— 三侧里 base 可缺，
  缺时用**空 base** 提交 merge 引擎（实测 git2 `merge_file_from_index` 接收字面量构造的
  空 base `IndexEntry` 正常产出 diff3 区域；`git merge-file --object-id` 同理）；
- **不可区域合并（整文件二选一）**：
  - `UD` / `DU`（一方删除）：**删除不是「空内容」** —— 对 DU 做区域合并后选「我方」
    只会写出一个空文件，而用户的意图是**删除**。IDEA/VSCode 对 modify/delete 也只给
    「保留哪一侧」的整文件选择，不给区域级合并。这是由「决议的语义」反推出来的边界，
    不是实现能力限制；
  - `binary`：不解码内容，只给状态 + 整文件决议；
  - `rename_rename`：三侧路径不同，区域行区间无意义；
- **merge 的输入永远是 stage blob**，永远不是工作区文件。工作区只用于「在编辑器打开」逃生门；
- **API 层的 `null` 与 merge 层的空占位是两层**：API 必须把缺失 stage 报成 `null`（R3，
  UI 据此说「我方已删除」），绝不把空占位泄漏到 wire。空占位只在 `read` 内部提交给 merge 引擎。

**R5 · 载荷预算分栏共享（红线 4）**
冲突是**三元**载荷：三侧内容叠加极易击穿单次 IPC JSON ≤ 2MB。必须有分栏共享预算 +
**每侧保底**（一栏超大不得饿死其它栏 —— 用户看不到 base 就无法判断）+ 行边界截断 +
`truncated` 上浮到 UI。唯一实现是 `cap_conflict_payload`（照抄 `cap_diff_payload` 的接线纪律）。

**R6 · 入口决策是纯函数，复用既有冲突判定**
`FileChange → 该开哪种视图` 落一个纯函数，且**复用 `isConflictedEntry`**（`gitStatusGroups.ts:30`，
前端唯一冲突判定）。当前 `useOpenDiffTab` 无条件开 `{ type: 'worktree' }` —— 这就是
「冲突文件点开看 diff 得不到有用信息」的入口成因。

**R7 · 寻址复用既有修订维度，不新增 tab 类型**
`DiffRevision` 加 `{ type: 'conflict' }` variant（修订维度天然容纳「index 的 unmerged 状态」）。
`DiffSource = { workspace, revision }` 的寻址语义零改动；**不新增 `TabData.kind`**，
不新增第二套地址类型（红线 12 + `git-domain.md` §15）。

**R8 · 命令层极薄（红线 6）+ 路径校验（红线 8）+ 阻塞隔离（红线 3）**
命令只做「参数校验 + 调度」；路径过 `validate_repo_relative_path`；git2 全程
`spawn_blocking`。这些在 `get_file_diff` 都有现成范式，照抄。

**R9 · 决议写回复用既有写与暂存机制（不新增写命令，但写回机制本身要试错）**
「应用决议」的落点是工作区文件 + `git add`（清除 unmerged 标记）。**写回机制必须按依据分派，
不能一律用 `git checkout --ours/--theirs`**：

- **删除侧（stage 缺失）→ 对该侧调 `git checkout --ours/--theirs` 会直接报错**
  （实测：`error: path 'c.txt' does not have our version`，工作区不变）。
  故删除类（DU / UD）的决议分四条路径（详见 design §2.5）：
  采用「存在侧」= 从 stage blob 写字节 + `git add`（写 0 字节或删文件，使 `git add` 可 stat）；
  采用「删除侧」= `git rm -- <path>`（实测同时清掉 index 与工作区）；
- 可区域合并（UU / AA）→ 服务端重算 merged → splice → 写字节 + `git add`；
- binary / rename → 逐侧取 blob 字节写回 + `git add`（删除侧同上）。

写文件走 `file::services::write_file_content`，暂存走 `operations::stage_files`
（与 `useGitActions.handleStageFile` 同一条路径）；写后调 `wait_status_fresh`
（`git-domain.md` §10：写后快照新鲜度）。

**R10 · 「已解决」是正常收敛，不是错误**
决议后该 path 的 unmerged 条目消失 → 读命令返回 `Err`（契约）→ 前端回退普通 diff 视图。
UI 必须把这条画成**收敛**（「Conflict resolved — 正在回到普通 diff」），不是错误态。
把已解决画成错误，等于给用户一个假警报。

**R11 · 登记既有陷阱，不顺手修**
`parsers/diff.rs` 对 `@@@`（`--cc` 格式）静默丢弃 hunk：**本任务不修**（生产路径不触发），
但必须在 spec 登记为已知边界 —— 否则下一个人用 `git diff` 凑冲突时会踩中且无从察觉。

## Acceptance Criteria

### Layer 1（本任务）

- [x] **冲突文件在两条 transport 上都不再是「No changes」**：本地 git2 路径打开冲突文件
  → 进入冲突视图（三侧 + 区域），而不是空态；这条同时是当前 E1 缺陷的反证；
  （证据：`conflict::tests::read_both` 对 `ExecTarget::Local` 与 `ShellLocalTransport` 两条 transport
  各读一次并 `assert_eq!(local, shell)`；UU 用例断言本地 `regions` 非空 —— 不再是 0 hunks 的空态。
  复核阶段另发现并修掉两条**真分叉**，各 1 条回归钉子：
  `cherry_pick_rename_rename_stays_rename_rename_on_both_transports`（shell 的 `other_commit` 用
  `.ok()?` 在首个缺失 ref 上提前退出 → cherry-pick 的 rename/rename 退化成 modify_delete）与
  `non_utf8_*_size_matches_across_transports`（`run_git` 只给 lossy `String`，含非法 UTF-8 的 blob
  lossy 长度膨胀 → 两 transport 报不同 `size`）—— 两者均经变异验证可红）；
- [x] 五类冲突各自可见且语义正确：UU / AA（无 base，可区域合并）/ DU（缺 ours，整文件二选一）/
  UD（缺 theirs，整文件二选一）/ rename-rename（不可区域合并）；binary 显示为不可文本合并而非乱码；
  （证据：`uu_both_modified_has_three_sides_and_regions_without_markers` / `aa_both_added_has_no_ancestor_and_regions` /
  `du_modify_delete_missing_ours_is_null_and_no_regions` / `ud_modify_delete_missing_theirs_is_null_and_no_regions` /
  `rename_rename_has_three_distinct_paths_and_no_regions` / `binary_conflict_has_no_decoded_content`）；
- [x] 缺失 stage 以 `null` 上浮：DU 的 ours 侧 UI 显示「（我方已删除）」而非空文件；
  `grep -rn "unwrap_or_default()" src-tauri/src/common/git/conflict/` 在 stage 内容上零命中；
  （证据：`cap::missing_stage_is_not_normalized_to_empty_string`；`grep` 实测 0 命中；
  前端 `ConflictView.test.tsx` 断言渲染「（我方已删除）」，且空文件用例**不**出现该文案）；
- [x] `ConflictKind` 分类由纯函数判定且有穷尽单测（六种 stage 存在性组合 + 路径分歧 + binary 优先）；
  （证据：`classify.rs` 24 条用例全绿：`uu_is_both_modified` / `aa_is_both_added` / `du_is_modify_delete` /
  `ud_is_modify_delete` / `rename_delete_is_modify_delete` / `rename_rename_when_paths_differ` /
  `binary_takes_priority_over_everything` / `unreachable_combos_fall_back_to_modify_delete` / `only_uu_and_aa_are_region_mergeable`）；
- [x] **未解决的 conflict 标记不再被当作内容展示**：冲突文件读出的三侧内容里**不含**
  `<<<<<<<` / `>>>>>>>` 行（真值来自 stage blob，不是工作区字节）；
  （证据：`uu_both_modified_has_three_sides_and_regions_without_markers` 逐侧断言 `!content.contains("<<<<<<<")` / `">>>>>>>"`）；
- [x] 红线 4：三侧各 ~900KB 时 `serde_json::to_vec` 实测 ≤ 2MB（随 `cap_conflict_payload` 单测）；
  （证据：`tests::three_sides_near_900kb_serialize_under_ipc_limit` + `cap::three_sides_each_900kb_stay_under_ipc_limit`；
  另 `oversized_side_does_not_starve_the_others`（保底）/ `control_char_escaping_cannot_break_ipc_limit`）；
- [x] `DiffRevision` 只多一个 variant；`TabData.kind` 未新增；`gitApi.ts` 新函数首参
  `workspace: WorkspaceSession`（护栏 `check_workspace_session_addressing` 保持绿）；
  （证据：`git.ts:332` 只多 `{ type: 'conflict' }`；`tab.ts` **完全未改动**（`git diff` 空，`TabKind` 仍 9 个
  variant、无 `conflict`）；`gitApi.ts:316` 首参 `workspace: WorkspaceSession`；护栏全绿）；
- [x] 入口决策是纯函数且复用 `isConflictedEntry`（无第二套 XY 判定）；
  （证据：`utils/conflictEntry.ts::revisionForChange` 唯一 import `isConflictedEntry`；
  `conflictEntry.test.ts` 四条用例覆盖 UU/DU/UD/AA/DD/非冲突）；
- [x] `pnpm check` 全绿；新护栏有同名测试（框架硬要求，`registry.py::_validate`）；
  （证据：`pnpm check` 30/30 护栏通过；`tools/guards/tests/test_check_conflict_read_contract.py` 存在且随
  `python3 -m unittest discover` 的 541 条测试全绿）；
- [x] `parsers/diff.rs` 的 `@@@` 静默丢弃在 spec 登记（R11）。
  （证据：`.trellis/spec/backend/git-domain.md` §5c「已知边界（R11，登记不修）」；`diff.rs` 未改动 —— `git diff` 空）

### Layer 2（子任务 `10-14-git-conflict-resolve`，此处只登记验收口径）

- [ ] 决议闭环（含**删除侧四条路径**）：UU 选「用我方的」→ 写回 → `git add` → 该 path 退出
  unmerged set；DU 选「删除」→ `git rm` → 退出；DU 选「对方改后的版本」→ 写字节 → 退出；
  且 `git-status-snapshot` 事件到达后视图自动收敛到普通 diff；
- [ ] **删除侧不得走 `--ours/--theirs`**：`resolve_conflict` 内不得出现「对 missing stage 调
  `checkout --ours|--theirs`」的形态（实测该调用报 `does not have our/their version`）；
- [ ] 区域决议 splice 以服务端重算的 merged 为准（不信前端行号）。

## 非目标

- 不做编辑器内联三栏合并（`@codemirror/merge` 未安装，实测）；引入需评估依赖与
  `check_codemirror_singleton` 护栏。区域决议以「面板内按钮 → 拼接写回」交付（Layer 2）。
  登记为后续任务。
- **Layer 2 的决议交互不在本任务**（父任务只交付只读展示）：`10-14-git-conflict-resolve` 承接。
- 不做 modify/delete 的「区域级」交互（R4 已论证：删除无内容可区域化，只给整文件二选一）。
- 不做「取消合并 / abort merge」（`git merge --abort`）：那是合并流程入口，不是 diff 展示。
- 不修 `parsers/diff.rs` 对 `@@@` 的静默丢弃（R11：只登记，不改）。
- 不动 `pull` 的 `--ff-only` 语义（`sync.rs:117`：pull 本身不产生冲突；冲突来自
  `merge` / `cherry-pick` / `revert` / `stash apply`、或外部 git 操作）。
- 不新增 `TabData.kind`，不新增地址类型，不合并三个物理 Map（10-12 C1 仍有效）。
- 不复用状态栏 `conflicts` 槽位（它属 LSP 扩展冲突，见上方取证）。
- 不做冲突区域的词级内在 diff 高亮（可后续复用 `computeWordDiff`）。

## 取证命令（复现本 PRD 的每一条）

```bash
# ① 本地 git2 路径对冲突文件返回 0 hunks（E1 根因）
#    见 implement.md「批 1」的 git2 探针单测（临时工程，验证后不留仓）
grep -n "strip_prefix(\"@@ \")" src-tauri/src/common/git/parsers/diff.rs   # → 139：只认 @@，@@@ 丢弃
grep -n "diff_tree_to_workdir_with_index\|diff_index_to_workdir" src-tauri/src/common/git/local/diff.rs
# ② 入口无条件开 worktree diff（R6 根因）
grep -n "revision: { type: 'worktree' }" src/features/git/hooks/useOpenDiffTab.ts
# ③ 既有唯一冲突判定（R6 要复用它）
grep -n "export function isConflictedEntry" src/features/git/utils/gitStatusGroups.ts   # → 30
# ④ 修订维度（R7 落点）
grep -n "export type DiffRevision" src/shared/types/git.ts                             # → 326
# ⑤ 载荷封顶范式（R5 照抄对象）
grep -n "cap_diff_payload" src-tauri/src/common/git/operations/diff.rs                 # → 327
# ⑥ 路径校验 / stage 范式（R8/R9 复用对象）
grep -n "validate_repo_relative_path" src-tauri/src/common/git/path_guard.rs           # → 26
grep -n "ls-files" src-tauri/src/common/git/operations/commit.rs                       # → 17：unmerged 判定先例
# ⑦ 状态栏 conflicts 是 LSP 扩展冲突（非 git 合并冲突）
sed -n '1,8p' src/features/status-bar/items/ConflictsItem.tsx
# ⑧ 基线（本任务不得回归）
npx vitest run src/features/git
```
