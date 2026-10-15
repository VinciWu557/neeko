# 技术设计：冲突决议闭环（Layer 2）

> 任务：`.trellis/tasks/10-14-git-conflict-resolve`（PRD `prd.md`）
> **本文件只写 Layer 2 特有的设计**。冲突模型（为什么是 index stages、为什么 marker 不是真值、
> 为什么区域决议只对 UU/AA 成立）已在父任务 `10-14-git-conflict-diff-view/design.md` §0–§1 推导过，
> **不复述**（复述会让同一结论在两个文件里各自漂移）。
> 决议的写回映射表与实测证据在**父任务 design §2.5**，本文件只补「为什么是这两条原语」
> 与前端决议状态模型。

---

## 0. 第一性原理：决议 = 把「哪一侧」翻译成一次幂等的索引操作

决议本身是**无状态的选择**（`region id → side`）。它有状态的部分只有一步：**落盘**。
所以本层的复杂度全部在「落盘这一步在四类冲突上各不相同」，而**不在**决议逻辑。

关键推论：**决议的正确性判据不是「写出的字节对不对」，而是「该 path 是否退出了 unmerged set」**。
因为 git 的「已解决」定义就是 index 里该 path 不再有 stage 1/2/3（父任务已实测：
`git rm` 与 `git add` 都能使 `ls-files -u` 变空）。这给了我们一个**与实现细节无关的验收口径**。

## 1. 为什么不是一个 `checkout --ours/--theirs`，而是按「要落盘什么」分派

直觉方案是 `git checkout --ours -- <path>`。**实测被否**（父任务 design §2.5）：

```
DU（我方删、对方改）：git checkout --ours -- c.txt
  → error: path 'c.txt' does not have our version   （工作区不变）
UD（我方改、对方删）：git checkout --theirs -- c.txt
  → error: path 'c.txt' does not have their version
```

根因：`checkout --ours/--theirs` 的语义是「从 index 的第 2/3 个 stage 取文件」。**该 stage 不存在时
git 直接报错** —— 而「该 stage 不存在」恰恰是删除类冲突的定义。所以这个命令对删除类**原理上不可用**，
不是用法问题。

⇒ 把决议拆成三条**按「要落盘什么」命名**的原语（整文件只在前两条之间选，永不「读 content 写回」）：

| 原语 | 语义 | 覆盖的决议 |
| --- | --- | --- |
| `write_text(path, text)` | 「这个文件应该有**这些文本**」（文本由我们算出） | 区域拼接结果 |
| `checkout_side(path, side)` | 「这个文件应该是**该侧 stage 的字节**」 | 采用存在侧（含 binary） |
| `delete_path(path)` | 「这个文件不应该存在」 | 采用删除侧 |

三条原语都是**幂等**的（重复执行收敛到同一状态），且都不依赖「哪一侧是 ours」的语义 ——
后者在 rebase 下会反转（父任务 T4），而「写文本 / 拷该侧字节 / 删文件」不会。

> **旧稿的 `write_side_bytes(path, content: Option<&str>)` 已废弃**（2026-10-15 实现期修正）：它
> 把「整文件的落盘」建在 `ConflictSide.content` 上，而 content 是**读 API 的解码视图** ——
> binary 侧为 `None`、超预算侧被截断。既会把 binary 误判成删除侧（删文件），又会把截断文本
> 写回工作区（损坏文件）。现改为：整文件走 `checkout_side`/`delete_path`（git 自己拷完整 blob），
> 只有「文本由我们算出」的区域 splice 才走 `write_text`。

**缺失 side 的等价性质**：`checkout_side` 只对**存在的 stage** 调用；对缺失 side，调用方走
`delete_path`（不是写空文件）。旧稿的「缺失 side 写 0 字节占位」是为「读 content 写回」方案
准备的 —— 改用 `checkout_side` 后不再需要（git 直接从 index 拷字节，无 stat 问题）。
这个 0 字节占位若存在于读层则**永不上浮到 wire**：读 API 仍按父任务 R3 报 `null`。

## 2. 契约

### 2.1 后端（追加到 `operations/conflict.rs`）

```rust
/// 决议：区域级 或 整文件级（二选一）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConflictResolution {
    /// 整文件采用某一侧（UU / AA / DU / UD / binary 通用；rename/rename 非目标）。
    WholeFile { take: TakeSide },
    /// 区域级：region id → 采用方式。仅 `kind.is_region_mergeable()` 时合法。
    ///
    /// **全函数契约**：`decisions` 的 id 集合必须与后端重读的 `regions` 恰好相等
    /// （无未知 / 无缺失 / 无重复），由 `validate_region_decisions` 校验。
    /// 原因：`git add` 的语义是「已解决」，而含 marker 的文件不是已解决 —— 部分覆盖会产出
    /// 既非已解决也非原文的无定义状态（要留半截请走编辑器逃生门）。
    Regions { decisions: Vec<(u32, RegionTake)> },
}

/// 整文件决议只可能取「存在的那一侧」，故无 `Both`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TakeSide {
    Ours,
    Theirs,
}

/// 区域决议多一个 `Both`（= 我方行 + 对方行按序拼接，PRD 的「逐区域 Ours/Theirs/Both」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegionTake {
    Ours,
    Theirs,
    Both,
}

/// 应用一处/整体决议。
///
/// 契约：成功后该 path 的 unmerged 条目消失（判据：`git ls-files -u -- <path>` 为空）；
/// 失败时不保证原子性（写文件与 git add 是两步），调用方依赖后续快照事件收敛。
pub async fn apply_conflict_resolution(
    transport: &dyn GitTransport,
    work_dir: &str,
    file_path: &str,
    resolution: ConflictResolution,
) -> Result<()>
```

**实现骨架（分派落点，勿把逻辑平铺在命令层 —— 红线 6）**：

> 类型位置：`ConflictResolution` / `TakeSide` / `RegionTake` 与既有 `ConflictKind` 同住
> `conflict/types.rs`（纯数据/wire 类型应在一处，且 `ConflictStages::side_of` 需要 `TakeSide`）；
> `apply_conflict_resolution` + 三条原语在 `operations/conflict.rs`（派发层）。

```rust
// 1. 重读 stages（唯一真值来源；不信前端行号）。
//    `read_conflict_stages` 已过 cap；区域 splice 需要完整 merged ⇒ 截断时显式拒绝（见下）。
let stages = read_conflict_stages(transport, work_dir, file_path).await?;

// 2. 决议 → 落盘动作
match resolution {
    ConflictResolution::Regions { decisions } if stages.kind.is_region_mergeable() => {
        // 截断的载荷不能做区域 splice：merged 被截 / regions 尾部被丢时，
        // merged_start/end 与前端看过的区域不再自洽 —— 显式拒绝，绝不静默拼出半截文件。
        if stages.truncated {
            anyhow::bail!("conflict payload truncated; resolve the whole file instead");
        }
        let merged = stages.merged.as_deref().context("merged missing for region merge")?;
        let text = splice_regions(merged, &stages.regions, &decisions);
        write_text(transport, work_dir, file_path, &text).await?;
    }
    ConflictResolution::Regions { .. } => {
        // 不可区域合并的 kind（modify_delete / binary / rename_rename）收到 Regions 决议：
        // 显式拒绝，不静默降级（T17）
        anyhow::bail!("region-level resolution is not applicable to {:?}", stages.kind);
    }
    ConflictResolution::WholeFile { take } => {
        // rename/rename 非目标（T19）：三侧路径不同，单条决议无法闭合整组。
        if stages.kind == ConflictKind::RenameRename {
            anyhow::bail!("rename/rename resolution is not supported");
        }
        // 判据是「该 stage 是否存在」，**不是** `side.content` 是否存在：
        // binary 侧的 content 也是 None（未解码），但它是一个**存在的实体** ——
        // 用 content 判会把它误判成删除侧（实测会删掉 binary 文件，T18）。
        match stages.side_of(take) {                 // Option<&ConflictSide>
            Some(_) => checkout_side(transport, work_dir, file_path, take).await?,
            // 采用「删除侧」= 该 stage 不存在 ⇒ 意图是删除文件（不是写空文件，T12）
            None => delete_path(transport, work_dir, file_path).await?,
        }
    }
}
// 3. 收口由命令层 wait_status_fresh 完成
```

**区域 splice 契约（`splice_regions`，纯函数）**：输入**服务端重读**的完整 `merged` 与
完整 `regions` + 决议列表，按 `merged_start..merged_end` **逆序**替换（逆序保证前面区域的
行偏移不影响后面的下标，T14）；未出现在决策里的区域**保留原 marker 行**（这是通用原语能力，
供未来扩展）。
`RegionTake::Both` = 该区域 `our_lines ++ their_lines` 按序拼接。

> **区域决议是全函数（T20，审查修正）**：`apply_conflict_resolution` 在 splice 前必须过
> `validate_region_decisions`（`conflict/regions.rs` 纯函数）——`decisions` 的 id 集合与
> `stages.regions` **恰好相等**（无未知 / 无缺失 / 无重复）。第一性原理：`git add` 的语义是
> 「该 path 已解决」，而含 marker 的文件不是已解决 —— 一旦放行未知/缺失 id 并 `git add`，
> 就会把带 marker 的半截文件标成已解决（可被提交）。「分批决议」在 UX 上由**前端草稿累积**
> （逐个决策、一次提交）实现，**不是**服务端写半截文件（后端写半截无法定义其 git 语义）。
> 未知 id 只能来自前端视图陈旧（读 → apply 之间仓库变了）⇒ **显式拒绝**，绝不静默。

纯函数落 `conflict/regions.rs`（与 marker/区域同一 owner），对其做单测。

> **分派判据必须是「stage 是否存在」，不是「content 是否存在」**（实现期修正，2026-10-15）：
> `ConflictSide.content` 是**读 API 的解码视图** —— binary 侧为 `None`、超预算侧被截断。
> 用 content 判会犯两个错：① 「binary 采用对方」被误判成删除侧 → **删掉文件**；
> ② 截断文本被写回工作区 → **损坏文件**。判据用 `stages.side_of(take).is_some()`。
> 同理，`None => delete_path` 若写成 `write_…(…, Some(""))`，DU 选「我方」会留下**空文件**。
> 父任务 AC 里「DU 选删除 → 文件不存在」钉的就是这一支。

**三条原语**（整文件**不再**「读 content 写回」，改由 git 拷 blob）：

```rust
/// 写入**我们自己拼出的文本**（区域 splice 的产物）→ `git add -- <path>`。
///
/// 只用于「文本是我们计算出来的」路径（`Regions`）。整文件绝不用它 —— `content` 是解码
/// 视图（binary 为 None、超预算被截断），写回会损坏文件。
async fn write_text(transport, work_dir, path, text: &str) -> Result<()> {
    crate::common::file::services::write_file_content(
        transport.exec_target(), work_dir, path, text.to_string(),
    ).await?;
    crate::common::git::operations::stage_files(transport, work_dir, &[path.to_string()]).await
}

/// 「这个文件应该是该侧的字节」：`git checkout --ours|--theirs -- <path>` → `git add`。
///
/// **整文件决议的通用原语**：覆盖 UU/AA（两侧都在）与 DU/UD（采用存在的那一侧）。
/// 选它而非「读 content 写回」的三个理由：① 字节保真（binary 无损）；② 与截断无关
/// （写的是完整 blob，不受 `cap_conflict_payload` 影响）；③ 三 transport 同一条 git 命令，
/// 零平台分叉。`checkout` 单独**不**清 unmerged（实测仍留 3 条 stage），必须跟一次 `git add`。
///
/// **前提**：该侧 stage 存在（调用方已按 stage 存在性分派）。对缺失 stage 调用会报
/// `does not have our/their version`（实测）—— 这正是删除侧绝不走本原语的原因（L2-R2）。
///
/// rename/rename 非目标：其三侧路径各不相同，`-- <file_path>` 只能覆盖路径匹配的那一侧，
/// 单条决议无法闭合整组（实测 `unmerged` 仍剩 2 条）。
async fn checkout_side(transport, work_dir, path, take: TakeSide) -> Result<()> {
    let flag = match take { TakeSide::Ours => "--ours", TakeSide::Theirs => "--theirs" };
    transport.run_git(&["checkout", flag, "--", path], work_dir).await?;
    crate::common::git::operations::stage_files(transport, work_dir, &[path.to_string()]).await
}

/// 删除该 path（同时清 index 与工作区）—— 与「写空文件」语义不同。
async fn delete_path(transport, work_dir, path) -> Result<()> {
    transport.run_git(&["rm", "--", path], work_dir).await?;
    Ok(())
}
```

> `transport.exec_target()` 是 `GitTransport` trait 的既有方法（`transport/mod.rs:267`），
> 直接用于 `write_file_content(target, …)` —— **不需要新增任何 transport 方法**。

### 2.2 前端（`useConflictResolve` + 决议状态模型）

决议是**待提交的本地草稿**（用户可能逐个区域点完再一次性 Apply），所以前端有状态：

```ts
/** 待提交的决议草稿。空对象 = 未做任何决议。 */
export interface ResolutionDraft {
  wholeFile?: 'ours' | 'theirs';
  regions: Map<number, 'ours' | 'theirs' | 'both'>;
}
```

| 事件 | 状态迁移 |
| --- | --- |
| 点区域按钮 | `regions.set(id, take)`；整文件决议与区域决议**互斥**（设了 wholeFile 就清 regions，反之亦然） |
| Apply | 提交 → 乐观置 `pending`；成功后 `reload()`（并等快照事件收敛） |
| 失败 | 回滚草稿到提交前 + toast（不静默） |
| 读命令返回 `Err`（已解决） | 清草稿，视图由 `useConflictStages` 的 `notConflicted` 接管 |

**`both` 的处理**：`take: 'both'` 只在区域级有意义（= 我方行 + 对方行按序拼接）。
`both` 不需要新的后端原语 —— 它就是「一个区域的合并文本」，由拼接函数产出后走同一 `write_text`。

**收敛（L2-R7）**：Apply 成功后**不主动切视图** —— 由 `git-status-snapshot` 事件驱动
`useConflictStages` 重拉 → 读命令返回 `Err` → `notConflicted` → 宿主回退 `DiffView`。
这样收敛路径与「用户在终端手动 `git add`」**走同一条**，不产生第二条收敛机制。

## 3. 测试契约

**必测（删除侧四大分支，一条都不能少）** —— 期望值全部实测，**不得用「同理」合并**：

| kind | 决议 | 工作区 | `ls-files -u` | `porcelain` |
| --- | --- | --- | --- | --- |
| DU | `WholeFile{Theirs}`（存在侧） | = stage 3 内容 | 空 | `A  c.txt` |
| DU | `WholeFile{Ours}`（删除侧） | **文件不存在** | 空 | **空** |
| UD | `WholeFile{Ours}`（存在侧） | = stage 2 内容 | 空 | **空** |
| UD | `WholeFile{Theirs}`（删除侧） | **文件不存在** | 空 | `D  c.txt` |
| UU | `Regions`（**覆盖全部区域**） | 已决议区域替换、无 marker 残留 | 空 | 按内容而定 |
| UU（binary） | `WholeFile{Theirs}` | = stage 3 原始字节 | 空 | 按字节 vs HEAD 而定 |
| UU（binary） | `Regions` | — | — | **报错**（不静默降级） |
| rename/rename | `WholeFile{any}` | — | — | **报错**（非目标，T19） |

> **binary 是 T18 的回归钉子**：`binary` 冲突选「对方」必须写出 stage 3 的**原始字节**且文件
> **存在** —— 旧稿「`content == None ⇒ delete_path`」会在此处删掉文件（实测可红）。

> `porcelain` 列是**逐例不同**的（DU-选对方=`A`、DU-选删除=空、UD-选我方=空、UD-选删除=`D`），
> 因为它算的是「相对 HEAD 的净变更」：DU-选删除后两侧都无此文件 → 净无变更 → 空；
> UD-选我方后内容 = HEAD → 无变更 → 空。**唯一跨例恒真的是「unmerged 已退出」。**
> 把这一列写对是真值；写「同理」会让其中两行成为错断言。

**反证（Red 必须能红）**：把 binary/删除侧分派判据从「stage 是否存在」改回「content 是否存在」，
「binary 选对方」用例必须变红（断言「文件被删除」失败）—— 这是本任务的核心防线之一。

## 4. 风险

| # | 风险 | 对策 |
| --- | --- | --- |
| T11 | 删除侧误走 `--ours/--theirs`（报错 `does not have our/their version`，工作区不变） | 分派按**该侧 stage 是否存在**：存在 → `checkout_side`，缺失 → `delete_path`。反证：DU 选我方 / UD 选对方 → 文件不存在（若误走 checkout 会报错） |
| T12 | 删除侧写成空文件（用户要删除却留下空文件） | §3 的「DU 选删除 → 文件不存在」用例；`Some(stage) → checkout_side` / `None → delete_path` 分派 |
| T13 | **把 `porcelain` 写成跨例恒同**（如断言 UD-选我方 = `A`） | §3 表已给出四例实测值；写对「净变更」语义而非「同理」 |
| T14 | 区域 splice 错位 | 重读重算 merged（不信前端行号）；**逆序**拼接；父任务 regions.rs 已做区间夹取 |
| T15 | 写后读旧数据 | 命令层 `wait_status_fresh`（父任务 T3 同因；git-domain §10） |
| T16 | 非原子（写文件成功、`git add` 失败） | 不假装原子：失败即上抛，靠快照事件让 UI 收敛到真实状态 |
| T17 | 区域决议被用于不可合并的 kind | 显式 `bail!`，不静默降级（§3 最后一条用例） |
| T18 | **binary / 截断侧被当删除侧或截断内容写回**（实现期发现） | 整文件走 `checkout_side`（git 拷完整 blob，与解码/截断无关）；区域走 `write_text`（只有文本路径）。反证：binary 选对方 → 文件存在且字节 = stage |
| T19 | **rename/rename 单条决议无法闭合整组**（实测 unmerged 仍剩 2 条） | 显式非目标：`apply_conflict_resolution` 对 `RenameRename` + `WholeFile` 返回显式错误（不静默做半闭），前端「Take Ours/Theirs」按钮不对该 kind 渲染 |
| T20 | **区域决议未覆盖全部区域 / 未知 region id 被静默放行**（审查发现） | `validate_region_decisions` 硬校验「id 集合恰好相等」；前端 `canApply` 要求 `regions.size === regionCount`。反证：去掉校验 → `partial_or_stale_region_decisions_are_rejected_not_silently_resolved` 红 |

## 5. 非目标

同 PRD：编辑器内联合并 / rebase 场景 / `merge --abort` / 新增 tab 类型 / 新增写文件命令。

**新增非目标（实现期定，T19）**：rename/rename 的决议 —— 三侧路径各不相同，单条 path 的决议
无法闭合整组（实测 `checkout --ours -- c.txt` + `add` 后 `unmerged` 仍剩 2 条）。
本任务只交付其**只读展示**（Layer 1 已可看），`apply_conflict_resolution` 对
`RenameRename` 的 `WholeFile` 决议**显式报错**，不静默做半闭。
