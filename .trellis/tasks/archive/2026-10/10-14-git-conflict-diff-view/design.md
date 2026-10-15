# 技术设计：Diff 面板 Git 冲突展示

> 任务：`.trellis/tasks/10-14-git-conflict-diff-view`（PRD 见 `prd.md`）
> 结论先行：**冲突的真值是 index 的 unmerged stages（1/2/3），不是工作区 marker 字节；
> 「区域决议」只对双方都有实体内容的两个类型成立（UU / AA），modify-delete 与 rename
> 天然是整文件选择。**本设计把这两条从第一性原理推出来。
>
> **本文的交付边界 = Layer 1（读路径 + 只读展示）**。§2.5（决议写回）与风险 T2/T3/T10
> 是 **Layer 2** 的实现依据，随本文一并交给子任务 `10-14-git-conflict-resolve` ——
> 它们已实测取证（删除侧 `--ours/--theirs` 报错、`git rm` 双清、空 base merge 可用），
> 不重做实验；子任务只负责把 §2.5 的分派表实现出来。

---

## 0. 第一性原理：二元 diff 装不下三元冲突

现有 diff 的数学模型是**二元关系**：

```
DiffResult = diff(A, B)      DiffLine ∈ { Context, Added, Removed, Collapsed }
```

冲突是**三元关系 + 逐区域决议**：

```
Conflict = (base, ours, theirs)  →  MergeRegions  →  每区域一个 Decision
```

用二元类型表达三元的唯一办法是**丢掉一维**。这就是「解析工作区 marker」的本质缺陷：
marker 里没有 base（除非用户配了 `diff3`），而且——

| 冲突类型 | 工作区有 marker？ | stage 分布 | 实测命令 |
| --- | --- | --- | --- |
| UU 双方改同文件 | ✅ | 1+2+3 | `printf 'ours\nbase2\n' > common.txt` / `'theirs'` |
| AA 双方各自新增同名 | ✅ | **无 stage 1**（2+3） | 两侧各自 `git add newf.txt` |
| DU 我方删 / 对方改 | ❌ | 1+3（**无 stage 2**） | `git rm c.txt` vs 改 `c.txt` |
| UD 我方改 / 对方删 | ❌ | 1+2（**无 stage 3**） | 改 `c.txt` vs `git rm c.txt` |
| DD 双方都删 | ❌ | **无 unmerged 条目**（不进 status） | 两侧都 `git rm` → merge 成功 |
| rename/delete | ❌ | 1+3，**同一路径**（重命名后） | `git mv a b` vs `git rm a` |
| rename/rename | ❌ | 三侧**路径各不相同** | `git mv a b` vs `git mv a c` → `DD a.txt` + `UA b.txt` + `AU c.txt`；stage2 在 `c.txt`、stage3 在 `b.txt` |
| binary 冲突 | ❌ | 三侧齐备但不可文本合并 | `printf '\x00\x01BIN'` 两侧冲突 → 工作区保留我方字节 |

⇒ **五类冲突中四类没有 marker，且 rename/rename 的三侧连路径都不同。**
「读工作区找 `<<<<<<<`」在任何一类上都会静默失真。这就是 R1 的由来。

### 0.1 为什么区域决议只对 UU / AA 成立（由决议语义反推）

这条边界不是实现能力限的，是**语义**限的：

```
modify/delete（DU/UD）的两种决议：
  「用我方」 / 「用对方」
  —— 而其中一方的内容是「这个文件不存在」。
  对 DU 做区域合并，选「我方（删除）」只能写出一个空文件，
  但用户的意图是删除文件 —— 空文件 ≠ 删除。
```

IDEA 与 VSCode 在 modify/delete 上同样只给「保留哪一侧」的整文件选择。所以：

| kind | 可区域合并 | 理由 |
| --- | --- | --- |
| `BothModified` (UU) | ✅ | 三侧有实体内容 |
| `BothAdded` (AA) | ✅ | 无 base → 用**空 base** 提交 merge（实测可用） |
| `ModifyDelete` (DU/UD) | ❌ | 删除不是内容，整文件二选一 |
| `Binary` | ❌ | 不可文本合并 |
| `RenameRename` | ❌ | 三侧路径不同，行区间无意义 |

**API 层 `null` 与 merge 层空占位是两层**：API 必须把缺失 stage 报成 `null`（R3，UI 据此显示
「我方已删除」）；空占位只在 `read` 内部提交给 merge 引擎，绝不泄漏到 wire。

### 0.2 实测：merge 引擎在缺 base 时可用

两个引擎都验证过（2026-10-14）：

```bash
# shell 路径：--object-id 直接吃 blob oid，无需临时文件（exit code = 冲突数）
git merge-file -p --object-id --diff3 -L HEAD -L BASE -L THEIRS <ours> <empty-blob> <theirs>
# ⇒ <<<<<<< HEAD / ||||||| BASE / ======= / >>>>>>> THEIRS，exit=1

# git2 路径：字面量构造空 base IndexEntry（flags=0，不含 EXTENDED）后调用
repo.merge_file_from_index(&empty_ref, &ours, &theirs, Some(&mut opts))   // opts.style_diff3(true)
# ⇒ automergeable=false，内容 <<<<<<< HEAD / ours / ||||||| / ======= / theirs / >>>>>>> THEIRS
```

同时确认：`repo.index().conflict_get(path)` 对 AA 返回 `ancestor: None`；对 DD 语义的
路径**根本不在 index 里**（无 unmerged 条目）。

### 0.3 顺带取证的既有陷阱（登记，不在本任务修）

`git diff -- <path>`（**不带 HEAD**）在冲突时输出 `--cc` 合并格式：

```
@@@ -1,5 -1,5 +1,9 @@@        ← 三个 @
```

而 `src-tauri/src/common/git/parsers/diff.rs:139` 是 `strip_prefix("@@ ")`（两个 `@` 加空格）
→ **整段 hunk 被静默丢弃**（`starts_with("@@")` 为真，但 `parse_hunk_header` 返回 `None`，
`if let Some(..)` 静默跳过，后续行因 `hunks.last_mut()` 为 `None` 也全部丢弃）。
当前生产路径带 `HEAD`（不触发），故本任务不改；但**必须登记**，否则下一个人用
`git diff` 凑冲突时会踩中且无从察觉。

---

## 1. 落点与形态

> **标 [L1] 的文件属 Layer 1（本任务）；标 [L2] 的属子任务 `10-14-git-conflict-resolve`。**
> 本设计文档由两个任务共用（§2.5 与 §4 的 T2/T3/T10 是 L2 的实现依据），故一张图列全。

```
src-tauri/src/common/git/conflict/          （新模块，红线 9：mod.rs 只 mod + pub use）
├── mod.rs            只 `pub mod types; pub use …`，无 fn/impl                      [L1]
├── types.rs          ConflictKind / ConflictSide / MergeRegion / ConflictStages —— 纯数据   [L1]
├── classify.rs       【纯函数】stage 存在性 + 路径分歧 + binary → ConflictKind  ← kind 的唯一判定点 [L1]
├── regions.rs        【纯函数】merge 输出 → Vec<MergeRegion>（行区间 + 三侧候选）      [L1]
├── probe.rs          【纯逻辑】两侧共用：blob 探测 + index 分组 + 三侧组装
│                      （`assemble_stages` = 唯一构造点）+ 惰性重命名映射判据      [L1]
├── local.rs          git2 实现（spawn_blocking 内）+ 空 base 字面量构造             [L1]
├── shell.rs          transport 实现（WSL / SSH）                                  [L1]
└── cap.rs            【纯函数】分栏共享载荷预算（红线 4 唯一实现）                     [L1]

src-tauri/src/common/git/operations/conflict.rs
    read_conflict_stages(...)       ← 派发缝（照抄 operations::get_file_diff 的形态）   [L1]
    apply_conflict_resolution(...)  ← 决议写回；两条原语（§2.5）                     [L2]

src-tauri/src/git/commands/conflict.rs      （红线 6：极薄，只校验 + 调度 + poke 快照）
    get_conflict_stages  [L1]  ·  resolve_conflict  [L2]
```

前端：

```
src/features/git/
├── components/conflict/
│   ├── ConflictView.tsx          编排（DiffView 的兄弟，不是改造它）           [L1 骨架 / L2 接按钮]
│   ├── ConflictRegionBlock.tsx   单区域：三侧候选（+ 决议按钮在 L2）              [L1]
│   ├── ConflictOpaqueCard.tsx    不可区域合并（binary / rename / delete）状态卡   [L1]
│   ├── ConflictToolbar.tsx       区域导航 + 在编辑器打开 + 截断提示（+ 整文件决议在 L2）[L1]
│   └── index.ts                  门面                                        [L1]
├── hooks/useConflictStages.ts    无状态消费者（同 useDiffData 形状）               [L1]
├── hooks/useConflictResolve.ts   决议提交（乐观 + 失败回滚 + 刷新）                 [L2]
└── utils/conflictEntry.ts        【纯函数】FileChange → DiffRevision（入口决策）    [L1]
```

**红线归属**：红线 4（三元载荷封顶）+ 6（命令层薄）+ 3（阻塞隔离）+ 8（路径校验）+
12（`DiffSource.workspace` 身份）+ 9（mod.rs 薄）。不新增红线。

## 2. 契约（数据模型）

### 2.1 后端类型

```rust
// conflict/types.rs
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    BothModified,   // UU：1+2+3
    BothAdded,      // AA：2+3（无 base）
    ModifyDelete,   // DU/UD：一方删除，整文件二选一
    RenameRename,   // 三侧路径不同
    Binary,         // 含 NUL，不可文本合并
}
impl ConflictKind {
    /// 是否可做区域级合并。**由决议语义决定**（见 design §0.1），不是实现能力限制。
    pub const fn is_region_mergeable(self) -> bool {
        matches!(self, Self::BothModified | Self::BothAdded)
    }
}

/// 一个 stage 侧。`content == None` = **该 stage 不存在**（合法状态，非错误）。
pub struct ConflictSide {
    pub path: Option<String>,   // rename/rename 下三侧路径可不同
    pub content: Option<String>,// binary / stage 缺失 → None（**绝不归一为空串**）
    pub size: u64,
    pub is_binary: bool,
    pub truncated: bool,
}

pub struct MergeRegion {
    pub id: u32,
    pub merged_start: u32,   // 合并输出中的行区间（0-based 半开）
    pub merged_end: u32,
    pub base_lines: Vec<String>,
    pub our_lines: Vec<String>,
    pub their_lines: Vec<String>,
    pub base_start: u32,     // 各侧原文行号（三栏对齐用）
    pub our_start: u32,
    pub their_start: u32,
}

pub struct ConflictStages {
    pub path: String,
    pub kind: ConflictKind,
    pub ancestor: Option<ConflictSide>,
    pub ours: Option<ConflictSide>,
    pub theirs: Option<ConflictSide>,
    pub merged: Option<String>,      // 仅 is_region_mergeable 且非 binary 时存在
    pub regions: Vec<MergeRegion>,
    pub truncated: bool,
    /// = `kind.is_region_mergeable()`，在唯一构造点派生一次并上 wire。
    /// 前端不得按 `kind` 重算（第二份领域判据），也不得用 `merged != None` 反推
    /// （`merged` 是派生展示数据，其存在与否由载荷预算支配而非语义）。
    pub region_mergeable: bool,
}
```

**`ConflictKind` 不含 `BothDeleted`**：DD 不产生 unmerged 条目（实测），因此永远不会进入
本读路径；给它一个 variant 就是造一个不可达状态。

### 2.2 语义判定（`classify.rs`，纯函数）

```rust
/// stage 存在性 + 路径分歧 + binary → ConflictKind。**无 I/O，唯一语义判定点。**
///
/// 判据严格来自实测（design §0 表），不猜：
///   DD 不产生条目 → 不在此处（DD 的 `has_base=true, ours=false, theirs=false` 组合
///   在真实 index 中不可达；给显式分支会造出假的可达路径）。
/// binary 优先级最高：即使三侧齐备也不做区域合并。
/// 路径分歧 + 两侧齐备 → RenameRename（只看存在性会误判为 BothAdded）。
pub fn classify(
    has_base: bool,
    has_ours: bool,
    has_theirs: bool,
    any_binary: bool,
    paths_differ: bool,
) -> ConflictKind {
    if any_binary {
        return ConflictKind::Binary;
    }
    if paths_differ {
        return ConflictKind::RenameRename;
    }
    match (has_base, has_ours, has_theirs) {
        (_, true, true) if has_base => ConflictKind::BothModified, // UU 或 rename/delete
        (false, true, true) => ConflictKind::BothAdded,            // AA
        (true, true, false) | (true, false, true) => ConflictKind::ModifyDelete, // UD / DU
        // 其余组合在真实 index 中不可达：显式归 ModifyDelete（最保守：整文件二选一）
        _ => ConflictKind::ModifyDelete,
    }
}
```

> `paths_differ` 在 `local.rs` / `shell.rs` 由三侧 path 比较得出，不在本函数内做 I/O。

### 2.3 载荷预算（`cap.rs`，红线 4 唯一实现）

```rust
pub const CONFLICT_PAYLOAD_MAX_BYTES: usize = 1_200_000;  // 留 0.8MB 给结构/merged/命令封装
const MIN_PER_SIDE_BYTES: usize = 64_000;                 // 保底：一栏巨大不得饿死其它栏
```

分配序：三侧各得保底 → 余量按 ancestor/ours/theirs 顺序填充、先到先得 → 行边界截断
（不切多字节字符）→ `merged` 最后分配（它是派生展示，超预算时优先牺牲区域）→
任一侧或 merged 被截断即 `stages.truncated = true`。

**接线纪律与 `cap_diff_payload` 完全一致**：`ConflictStages` 的所有出口都必须过它
（唯一构造出口在 `operations::read_conflict_stages` 末尾），新增 transport 自动受约束。

### 2.4 读路径（`operations/conflict.rs`）

```rust
/// 读一个冲突文件的三个 stage。
///
/// 契约（与单文件 diff 的三态契约同族）：
///   ① path 无 unmerged 条目 → Err（语义 = 调用方应回退普通 diff，不是空冲突）
///   ② 有 unmerged 条目 → 返回三侧现状，缺失 stage 以 content: None 表达
///   ③ binary → kind = Binary，三侧不解码内容
/// 路径安全（红线 8）由命令层完成；本函数只做 I/O 与语义组装。
pub async fn read_conflict_stages(
    transport: &dyn GitTransport,
    work_dir: &str,
    file_path: &str,
) -> Result<ConflictStages>
```

派发（**照抄 `operations::get_file_diff` 的形态**）：

```
transport.open_repo_async(work_dir).await
  Some(_) → spawn_blocking(conflict::local::read)        // 红线 3：git2 同步 + fs 探测整体隔离
  None    → conflict::shell::read(transport, ...)        // WSL / SSH
→ conflict::cap::cap_conflict_payload(stages)            // 红线 4：唯一封顶出口
```

**local（git2）要点**：
- `index.has_conflicts()` 为假 → `bail!`（契约 ①）；
- `index.conflict_get(path)` → `{ancestor, our, their}` 三个 `Option<IndexEntry>`；
- 逐侧 `repo.find_blob(oid)` 取字节：**NUL 探测判 binary**（与
  `common/file/reader.rs::is_binary_file` 同判据：前 8KB 含 `0x00`）；
- 三侧 path 由 `IndexEntry.path` 得到（rename/rename 会不同）；
- `is_region_mergeable()` 时提交 merge：
  - 有 base → `merge_file_from_index(base, ours, theirs, opts)`
  - 无 base（AA）→ **字面量构造空 base `IndexEntry`**（`mode=0o100644, flags=0, id=repo.blob(b"")`，
    `path` 用 ours 的路径），实测可用（design §0.2）

**shell（transport）要点**：
- `ls-files -u -z -- <path>` → `(<mode>, <oid>, <stage>, <path>)`；**`-z` 避免 C 转义**
  （`git-domain.md` §8）；
- `git cat-file blob <oid>` 逐 stage 取字节 → 同一 binary 判据；
- `is_region_mergeable()` 时 `git merge-file -p --object-id --diff3 -L … <ours> <base|empty> <theirs>`
  （**exit code = 冲突数**，非零不是错误）；base 缺失时用
  `git hash-object -t blob --stdin`（喂零字节）的 oid —— **不用 `/dev/null`**：那是 POSIX
  设备名，Windows 上不存在，而 backend-test 的 CI 矩阵含 windows-latest（护栏 A5 钉住；
  Layer 2 重算 merged 时同样适用）；
- **不使用工作区文件做输入**。

**区域解析（`regions.rs`）**：解析的是**我们自己调 merge 引擎产出的文本**（格式我们可控：
`style_diff3(true)` / `--diff3`），不依赖用户的 `merge.conflictStyle`。扫描
`<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` 得到合并输出的行区间与三侧行数与起点。
区间做了夹取（越界不 panic），`debug_assert` 暴露内部错误。

### 2.5 决议写回（**Layer 2 · 子任务 `10-14-git-conflict-resolve` 实现**）

> 本节是 Layer 2 的实现依据，随本文件一并交接。已实测取证，不重做实验。

```rust
pub enum ConflictResolution {
    WholeFile { take: TakeSide },                       // ours | theirs
    Regions { decisions: Vec<(u32, TakeSide)> },        // 区域 id → 采用侧
}
```

**核心约束（实测，不许想当然）**：

- **`git checkout --ours|--theirs` 在「该侧缺失」时报错**，实测：
  - DU（我方删）→ `git checkout --ours -- c.txt` → `error: path 'c.txt' does not have our version`，
    工作区不变；
  - UD（对方删）→ `git checkout --theirs -- c.txt` → `error: path 'c.txt' does not have their version`。
  ⇒ **不能把 `--ours/--theirs` 当作通用写回**。
- `git rm -- <path>` 对冲突路径可用，**同时清 index 与工作区**（实测：`git rm` 后
  `ls-files -u` 与 `status --porcelain` 均为空）。
- 从 stage blob 写字节后 `git add` 可用（实测：DU 取 stage 3 写回 + `git add` →
  `ls-files -u` 空，`porcelain` = `A  c.txt`）。

**统一写回原语**（两条，覆盖全部 kind）：

| 原语 | 行为 | 实测依据 |
| --- | --- | --- |
| `write_side_bytes(path, side)` | 若 side 存在 → 写其 blob 字节；若 side 缺失 → **写 0 字节（空文件，为让 `git add` 可 stat）**；然后 `git add -- path` | DU 取 stage3 + `add` → unmerged 清空 |
| `delete_path(path)` | `git rm -- path`（同时清 index 与工作区） | DU 采用删除 → 两侧均空 |

**各 kind 的决议映射表**：

| kind | 决议 | 执行 |
| --- | --- | --- |
| UU / AA + `Regions` | 区域级 | 重读 stages → 重算 merged → 按 `merged_start/end` splice（未决议区域保留 marker）→ 写字节 → `git add` |
| UU / AA + `WholeFile` | 选一侧 | `write_side_bytes(take side)` |
| DU / UD + `WholeFile` | 选存在侧 | `write_side_bytes(存在侧)` |
| DU / UD + `WholeFile` | 选删除侧 | `delete_path(path)` |
| Binary / RenameRename + `WholeFile` | 选一侧 | 同「选存在侧 / 选删除侧」两分支 |

流程：

```
1. 重读 index stages（**不信前端行号** —— 见风险 T2）
2. 按上表分派到两条原语之一
3. 写文件若需：`file::services::write_file_content`
4. `git add`：`operations::stage_files`（与 `useGitActions.handleStageFile` 同路径）
5. 写后：`wait_status_fresh(&state, &repo)`（`git::services::status.rs:30`）
```

**注意**：`--ours/--theirs` 的语义在 merge 与 rebase 下**相反**（rebase 时 ours = upstream）。
本任务按 merge 语义实现；rebase 场景在风险表登记（T4），不在本任务处理。

### 2.6 前端契约

```ts
// shared/types/git.ts —— DiffRevision 只多一个 variant（R7；不新增 TabData.kind）
export type DiffRevision =
  | { type: 'worktree' }
  | { type: 'commit'; commitHash: string }
  | { type: 'stash'; selector: string }
  | { type: 'conflict' };            // ← 修订维度 = index 的 unmerged 状态

export type ConflictKind =
  | 'both_modified' | 'both_added' | 'modify_delete' | 'rename_rename' | 'binary';

export interface ConflictSide {
  path: string | null;
  content: string | null;           // null = 该 stage 不存在（不是空文件）
  size: number;
  is_binary: boolean;
  truncated: boolean;
}
export interface MergeRegion {
  id: number;
  merged_start: number; merged_end: number;
  base_lines: string[]; our_lines: string[]; their_lines: string[];
  base_start: number; our_start: number; their_start: number;
}
export interface ConflictStages {
  path: string;
  kind: ConflictKind;
  ancestor: ConflictSide | null;
  ours: ConflictSide | null;
  theirs: ConflictSide | null;
  merged: string | null;
  regions: MergeRegion[];
  truncated: boolean;
}
export interface ConflictResolution {
  wholeFile?: 'ours' | 'theirs';
  regions?: Array<{ id: number; take: 'ours' | 'theirs' | 'both' }>;
}
```

**入口决策（`utils/conflictEntry.ts`）—— 唯一且复用既有判定**：

```ts
/**
 * 点击变更列表某文件 → 该开哪种视图。
 * 复用 `isConflictedEntry`（前端唯一冲突判定，禁止第二套 XY 判定）。
 * 这修掉了本地 git2 路径下冲突文件显示「No changes to display」的入口成因：
 * 此前 `useOpenDiffTab` 无条件开 { type: 'worktree' }。
 */
export function revisionForChange(file: FileChange): DiffRevision {
  return isConflictedEntry(file) ? { type: 'conflict' } : { type: 'worktree' };
}
```

**接线点（零新增 prop 管道）**：`GitCommitPanel` 已持有 `changedFiles`
（`status?.entries ?? []`）且已有 `onFileSelect(path)` 回调链（`ChangesList` → `ChangesSection`）。
把 `handleFileSelect` 从「直接 `openCommitDiffTab(path)`」改为
「按 `changedFiles` 查该 path → `revisionForChange` → 开对应视图」即可，**不新增参数**。

**渲染分派**：`PaneContent` 既有 `switch (activeTab.data.kind)`（`case 'diff'` 内）
按 `diffSource.revision.type` 二选一渲染 `ConflictView` / `DiffView`。`DiffView` **零改动**。

**`useConflictStages`**：与 `useDiffData` 同构（`loading` / `error` / 三刷新信号
`file-changed` + `git-status-snapshot` + `GitRefresh` → 重拉）。**关键差异**：读命令以
`Err` 表达「不是冲突」，hook 必须把它映射为 `notConflicted`（正常收敛）而不是 `error`（R10）。

## 3. 护栏（把不变量从 prose 提到 guard）

文件：`tools/guards/checks/check_conflict_read_contract.py`
（`checks/` 目录即注册表；框架**强制**同名测试
`tools/guards/tests/test_check_conflict_read_contract.py`，`registry.py::_validate`）

- **A1（真值来源唯一）**：`src-tauri/src/common/git/conflict/**` 内不得出现
  `"<<<<<<<"` 字面量（唯一的 marker 扫描在 `regions.rs` 内，且只扫 merge 引擎自产文本）——
  判据形态：字面量 `<<<<<<<` 只允许出现在 `regions.rs`，其它文件零命中。
  理由：marker 不是真值（四类冲突无 marker）。
- **A2（缺失 stage 不许归一）**：`conflict/**` 内 `unwrap_or_default()` / `unwrap_or("")`
  不得作用于 stage 内容取值路径。缺失 stage 必须以 `Option::None` 上浮
  （把「我方删除」显示成「空文件」即违规）。
- **A3（唯一封顶）**：`ConflictStages` 的 **wire 出口**必须过 `cap_conflict_payload`
  （照抄 `cap_diff_payload` 的接线纪律）。**两个单点不要混为一谈**：唯一**构造点**是
  `probe::assemble_stages`（领域算法只写一份），唯一**封顶出口**是 `operations/conflict.rs`
  派发缝（`local.rs` / `shell.rs` 在封顶上游，重复封顶会二次截断已截断内容）。
- **A4（前端不解析 marker）**：`src/features/git/components/conflict/**` 内不得出现
  `<<<<<<<` / `=======` / `>>>>>>>` 字面量（前端只渲染结构化区块，不扫文本）。
- **A5（跨平台中立）**：`conflict/**` 的**字符串字面量**内不得出现 `/dev/null`。
  它是 POSIX 设备名，Windows 上不存在 —— `git hash-object -t blob /dev/null`（AA 的空 base
  占位）会让 shell 分支在 windows-latest CI 上直接失败。等价写法：`--stdin` + 空输入。
  **为何靠护栏而不是测试**：`/dev/null` 在 macOS / Linux 上行为完全正确，夹具测试在 POSIX
  上永远绿 —— 只有静态判据能在写下当时拦住它。只扫引号内串（注释里解释「为何不用它」
  合法，否则护栏会逼人删掉恰好防止回潮的那段文档）。
- **A6（唯一构造点）**：传输实现不得自建 `ConflictStages { … }` 字面量，必须经
  `probe::assemble_stages`（领域算法只写一份）。允许名单：`types.rs`（定义）/ `probe.rs`
  （唯一构造点）/ `cap.rs`（内联测试夹具）+ 测试文件。判据先剥除返回类型位置
  （`-> ConflictStages {` 是签名而非构造）再找字面量 —— 否则正确调用 `assemble_stages`
  的新 transport 会被误报（误报的结局是逼人放宽判据，比没护栏更糟）；也不能整行豁免
  （单行函数里签名与真构造可共存）。新 transport 文件**默认在射程内**，不需登记。

台账形态照抄 `path_identity_scope.json` 的**轻量版**（本组判据目标为恒零，如
`check_workspace_identity` 的做法——「要的是永远为零」，不配计数台账，但必须在
docstring 写明扫描集为空判 ERROR）。

> **`GUARD.docs` 指针必须可解析**：实测 `registry.py::_validate`（L81-82）在 `guard.docs`
> 非空时校验 `(root / guard.docs).exists()`，不存在即 RegistryError。⇒ 批 4 的护栏上线**前**
> 必须先把 `docs/domain-model.md` 的 git 冲突小节写出来，否则 `pnpm lint` 直接红（不是违规，
> 是框架级注册失败）。

## 4. 风险与对策

| # | 风险 | 对策 |
| --- | --- | --- |
| T1 | 三元载荷击穿红线 4 | 分栏共享预算 + 每侧保底 + 行边界截断；单测断言 `serde_json::to_vec` 实测 ≤ 2MB（含三侧各 ~900KB 的用例） |
| T2 | 区域行区间漂移导致 splice 错位 | 决议时**服务端重读 index 重算 merged**，不信前端行号；`regions.rs` 做区间夹取 + `debug_assert` |
| T3 | 用户在工作区手改后 merged 与 stages 不一致 | `merged` 仅作展示；决议路径永远从 index stages 重算（工作区改动不参与语义）；工具栏提示「工作区有手工改动」 |
| T4 | rebase 下 `--ours/--theirs` 语义相反 | 本任务按 merge 语义实现；在 `switch` 处加注释指向本表；rebase 支持另起任务（需 `REBASE_HEAD` / `rebase-merge/` 判定） |
| T5 | CRLF 导致 merged 与工作区字节不一致 | 红线 11（`git-domain.md` §7）：一律按 `\n` 归一生成 merged；测试夹具**必须**用确定性 builder（`tests/unit/support.rs::TestRepo` 或 `operations/tests.rs::init_repo`，双保险 = `core.autocrlf=false` + `.gitattributes * -text`）；断言工作区字节走 `support::assert_content_eq`（内部归一化 CRLF），**禁止** `read_to_string` + `assert_eq!` 字节级断言（护栏 `check_worktree_byte_assertions`） |
| T6 | `@@@`（`--cc`）被现有 parser 静默丢弃 | 本任务不修（生产路径带 HEAD，不触发）；spec 登记为已知边界（design §0.3） |
| T7 | 新增 `conflict/` 模块触发红线 9（mod.rs 极薄） | `mod.rs` 只 `mod` + `pub use`；所有 `fn`/`impl` 在文件级子模块 |
| T8 | AA 的空 base 占位是「构造的」而非真实的 | 已在 design §0.2 实测；单测固定该行为（`empty_base_merge_region_shape`），git2 升级导致行为变化时立刻红 |
| T9 | 删除型冲突误做区域合并 → 写出空文件 | `is_region_mergeable()` **不含 `ModifyDelete`**（design §0.1）；单测断言 DU/UD 的 regions 为空且 kind 为 `ModifyDelete` |
| T10 | **删除侧用 `--ours/--theirs` 会报错**（实测 `does not have our/their version`） | 写回统一走两条原语（§2.5）：`write_side_bytes`（缺失侧写 0 字节使 `git add` 可 stat）/ `delete_path`（`git rm`）；单测覆盖删除侧四条分支 |

## 5. 迁移与实施纪律

1. **每批 Red 先行**：五类冲突各一条夹具测试**先失败再通过**；binary / AA / DU 三条
   是「当前实现必然错」的显式反证（现在要么 0 hunks，要么把它当普通改动）。
2. **真值来源只允许一种**：index stages。禁止「marker 优先、失败回退 stages」这类双轨
   （那是第二个真值口径）。
3. **`null` 与空串不许互相偷换**：API 层 `null` 是语义（stage 缺失）；空串是内容（文件确实是空的）。
   两者在 UI 上必须渲染成不同的东西。
4. **写路径不新增**：写走 `write_file_content`，暂存走 `stage_files`。
   任何「为了冲突解决新增一条写文件命令」的想法都要先说明为什么不复用。
5. **不修 `parsers/diff.rs`**（R11）：只登记。

## 6. 决策表

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 真值来源 | **index unmerged stages** | 四类冲突无 marker；rename/rename 三侧路径不同（实测） |
| 修订维度 | **`DiffRevision` 加 `'conflict'` variant** | 三元是「对 index 的 unmerged 状态做 diff」，属修订维度；不新增 tab 类型 = 不新增寻址路径 |
| 冲突类型 | **显式 `ConflictKind`（5 种），不含 BothDeleted** | DD 不产生 unmerged 条目（实测）→ 加它即造不可达状态 |
| 区域决议范围 | **仅 UU / AA** | modify/delete 是「保留哪一侧」而非内容选择（design §0.1） |
| 缺 base 的处理 | **空占位提交 merge，API 报 `null`** | 实测两个引擎都接受；API 语义与 merge 实现解耦 |
| merge 文本来源 | **我们自己调引擎产出**（`style_diff3` / `--diff3`） | 不依赖用户 `merge.conflictStyle` 配置 |
| 载荷封顶 | **分栏共享预算 + 保底 + 行边界截断** | 三元载荷是 diff 的三倍；一栏巨大不得饿死其它栏 |
| 入口决策 | **纯函数 `revisionForChange`，复用 `isConflictedEntry`** | 既有唯一冲突判定；零新增 prop 管道 |
| `@@@` parser 缺陷 | **登记不修** | 生产路径不触发（带 HEAD）；改它属另一个任务 |
| 状态栏 conflicts 槽位 | **不复用** | 它渲染 LSP 扩展路由冲突，与 git 合并冲突无关 |

## 7. 非目标（与 PRD 一致，此处补技术后果）

- **Layer 2 的决议交互不在本任务**：`apply_conflict_resolution` / `ConflictResolution` /
  `useConflictResolve` / 区域与整文件决议按钮均移交 `10-14-git-conflict-resolve`（硬依赖本层已合入）。
  本层只交付：三侧内容 + 区域列表 + 「在编辑器打开」逃生门。
- **编辑器内联三栏合并**：`@codemirror/merge` 未安装（实测）；引入需评估依赖与
  `check_codemirror_singleton` 护栏。区域决以「面板内按钮 → 拼接写回」交付（Layer 2）。
- **modify/delete 的区域级交互**：语义上不存在（design §0.1）。
- **rebase 场景**：`--ours/--theirs` 语义相反（T4）；需 `REBASE_HEAD` 判定 + 另一套文案。
- **`merge --abort` / 合并流程入口**：属 git 写操作编排，非 diff 展示。
- **冲突区域的词级内在 diff**：可后续复用 `computeWordDiff`（`diffAlgorithm.ts` 已有）。
