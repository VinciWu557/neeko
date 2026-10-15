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

## 1. 为什么是两条原语，而不是一句 `checkout --ours/--theirs`

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

⇒ 把决议拆成两条**按「要落盘什么」命名**的原语：

| 原语 | 语义 | 覆盖的决议 |
| --- | --- | --- |
| `write_side_bytes(path, side)` | 「这个文件应该有这些内容」 | 采用存在侧 / 区域拼接结果 |
| `delete_path(path)` | 「这个文件不应该存在」 | 采用删除侧 |

两条原语都是**幂等**的（重复执行收敛到同一状态），且都不依赖「哪一侧是 ours」的语义 ——
后者在 rebase 下会反转（父任务 T4），而「写内容 / 删文件」不会。

**缺失 side 的 0 字节占位**：`write_side_bytes` 在 side 缺失时写空文件，唯一目的是让随后的
`git add` 能 stat 到该路径（`git add` 对不存在的路径报错）。这个空占位**只在写回实现内部存在**：
读 API 仍按父任务 R3 报 `null`（「我方已删除」），空占位永不上浮到 wire。

## 2. 契约

### 2.1 后端（追加到 `operations/conflict.rs`）

```rust
/// 决议：区域级 或 整文件级（二选一）。
pub enum ConflictResolution {
    /// 整文件采用某一侧（UU / AA / DU / UD / binary / rename 通用）。
    WholeFile { take: TakeSide },
    /// 区域级：region id → 采用侧。仅 `kind.is_region_mergeable()` 时合法。
    /// 未出现在列表中的区域**保留 marker**（分批决议）。
    Regions { decisions: Vec<(u32, TakeSide)> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TakeSide {
    Ours,
    Theirs,
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

```rust
// 1. 重读 stages（唯一真值来源；不信前端行号）
let stages = read_conflict_stages(transport, work_dir, file_path).await?;

// 2. 决议 → 落盘动作（两条原语之一）
match resolution {
    ConflictResolution::Regions { decisions } if stages.kind.is_region_mergeable() => {
        // 重算 merged（与读路径同一引擎）→ 按 merged_start/merged_end 逆序 splice
        // 逆序是为了让先前的区间偏移不影响后续下标
        let merged = recompute_merged(transport, work_dir, file_path).await?;
        let text = splice_regions(&merged, &stages.regions, &decisions);
        write_side_bytes(transport, work_dir, file_path, Some(&text)).await?;
    }
    ConflictResolution::Regions { .. } => {
        // 不可区域合并的 kind 收到 Regions 决议：显式拒绝，不静默降级
        anyhow::bail!("region-level resolution is not applicable to {:?}", stages.kind);
    }
    ConflictResolution::WholeFile { take } => {
        let side = stages.side_of(take);          // Option<ConflictSide>
        match side.and_then(|s| s.content.as_deref()) {
            Some(text) => write_side_bytes(transport, work_dir, file_path, Some(text)).await?,
            // 采用「删除侧」= 该 side 不存在 ⇒ 意图是删除文件（不是写空文件）
            None => delete_path(transport, work_dir, file_path).await?,
        }
    }
}
// 3. 收口由命令层 wait_status_fresh 完成
```

> **`None => delete_path` 这一支是本任务最容易被写错的地方**：若写成
> `write_side_bytes(…, Some(""))`，DU 选「我方」会**留下一个空文件**，而用户要的是删除。
> 父任务 AC 里「DU 选删除 → 文件不存在」钉的就是这一支。

**两条原语**：

```rust
/// 写一侧内容（缺失侧写 0 字节以让 `git add` 可 stat）→ `git add -- <path>`。
async fn write_side_bytes(transport, work_dir, path, content: Option<&str>) -> Result<()> {
    crate::common::file::services::write_file_content(
        transport.exec_target(), work_dir, path, content.unwrap_or("").to_string(),
    ).await?;
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
`both` 不需要新的后端原语 —— 它就是「一个区域的合并文本」，由拼接函数产出后走同一 `write_side_bytes`。

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
| UU | `Regions`（部分决议） | 已决议区域替换、**未决议区域保留 marker** | 空 | 按内容而定 |
| UU（binary） | `Regions` | — | — | **报错**（不静默降级） |

> `porcelain` 列是**逐例不同**的（DU-选对方=`A`、DU-选删除=空、UD-选我方=空、UD-选删除=`D`），
> 因为它算的是「相对 HEAD 的净变更」：DU-选删除后两侧都无此文件 → 净无变更 → 空；
> UD-选我方后内容 = HEAD → 无变更 → 空。**唯一跨例恒真的是「unmerged 已退出」。**
> 把这一列写对是真值；写「同理」会让其中两行成为错断言。

**反证（Red 必须能红）**：把 `None => delete_path` 改成 `None => write_side_bytes("")`，
「DU 选删除」用例必须变红（断言「文件不存在」失败）—— 这是本任务的核心防线。

## 4. 风险

| # | 风险 | 对策 |
| --- | --- | --- |
| T11 | 删除侧误走 `--ours/--theirs`（报错） | 两条原语不含 checkout；`grep checkout` 反证 |
| T12 | 删除侧写成空文件（用户要删除却留下空文件） | §3 的「DU 选删除 → 文件不存在」用例；§2.1 的 `None => delete_path` 支 |
| T13 | **把 `porcelain` 写成跨例恒同**（如断言 UD-选我方 = `A`） | §3 表已给出四例实测值；写对「净变更」语义而非「同理」 |
| T14 | 区域 splice 错位 | 重读重算 merged（不信前端行号）；**逆序**拼接；父任务 regions.rs 已做区间夹取 |
| T15 | 写后读旧数据 | 命令层 `wait_status_fresh`（父任务 T3 同因；git-domain §10） |
| T16 | 非原子（写文件成功、`git add` 失败） | 不假装原子：失败即上抛，靠快照事件让 UI 收敛到真实状态 |
| T17 | 区域决议被用于不可合并的 kind | 显式 `bail!`，不静默降级（§3 最后一条用例） |

## 5. 非目标

同 PRD：编辑器内联合并 / rebase 场景 / `merge --abort` / 新增 tab 类型 / 新增写文件命令。
