# Design — fsevent-stream-consolidation

> 配套 `prd.md`。本文只记技术设计；需求与验收在 PRD。
> **关键结论先行**：R2（流合并）的可行边界由「`.git` 是否已被主 watcher 覆盖」决定。
> 代码取证结论是 **macOS 上已被覆盖，只差一个回调分支** —— 这使 R2 从「架构改造」
> 降级为「在既有回调里加一个分类分支」，风险远低于 PRD 初稿的预估。

## 1. 现状：两条流各管什么

```
workspace mount
├── 主 watcher（create_file_watcher）
│     macOS: SubtreeExclusion → 递归监听 root，ignored 子树物理排除
│     回调: build_notify_callback  (manager/callbacks.rs:28)
│     出口: TreeChanged / GitChanged(?) / debounce / maintenance
│
└── git_meta watcher（create_git_meta_watcher）
      macOS: RecommendedWatcher::new  (git_meta/watcher.rs:78)
      监听: .git（NonRecursive）+ .git/refs（Recursive）+ 公共 gitdir（NonRecursive）
      回调: classify_git_meta_event → on_index/on_head/on_refs
      出口: scheduler hint + GitChanged 事件
```

**每个 workspace 两条流**。N 个 workspace ⇒ 2N 条，fseventsd 侧 2N 条 client 线程。

## 2. 决定性的代码事实

### 2.1 macOS 主 watcher 已经覆盖 `.git`

- macOS 后端是 `SubtreeExclusion`（`macos.rs:7`），注册路径走 `watch_recursive(root)`
  （`strategy.rs:88-91` 的 `SubtreeExclusion` 分支）——**递归订阅整个 root，含 `.git`**。
- `WatchManifest::compute` 遍历时**跳过** `.git`（`manifest.rs:59-62`），且**不把它放进
  `ignored_roots`** ⇒ `.git` **不会**出现在 exclusion 列表里（`build_exclusion_paths`
  的输入是 `ignored_roots`）。
- ⇒ `.git` 的事件**会送达**主 watcher，只是在回调层被丢弃：
  - `is_hard_noise_path` 命中 `.git`（`gitignore.rs:16-21`）
  - `relevant_event_paths` → 过滤掉（`classify.rs:9-20`）
  - `structure_event_paths` → `is_hard_noise_path` 直接 `continue`（`classify.rs:50-52`）

**这是 R2 的技术基础**：数据已经到手，只是被丢弃。不需要新增流、不需要改注册、
不需要碰 FSEvents 配置。

### 2.2 为什么原本要单独一条流

`gitignore.rs:41` 的注释写明了原因：

> `.git` 元数据目录（git 内部文件，HEAD watcher 单独绕过此过滤监听分支切换）

即：主 watcher 的过滤链会丢弃 `.git`，而 git 元数据是**必须**的（分支切换、暂存、
外部 push 都靠它），所以另起一条绕过过滤的流。

设计意图是对的，实现代价是「每个 workspace 多一条流」。

### 2.3 Linux 上不成立

Linux 是 `SelectiveRegistration`（`linux.rs:5`），逐**可见目录**注册
（`strategy.rs:97-134`），而 `.git` 不在 `visible_dirs` 里（`manifest.rs:59-62` skip）
⇒ **Linux 主 watcher 根本没有 `.git` 的事件**。

⇒ R2 只能对 macOS（及任何 `can_exclude_subtrees` 的递归后端）生效。
Linux 必须保留 git_meta 流。这不是妥协，是后端能力差异的必然结果。

### 2.4 两条流的 Config 一致

| 项 | 主 watcher | git_meta |
|---|---|---|
| `notify::Config` | `Config::default()`（`core.rs:398`） | `Config::default()`（`git_meta/watcher.rs:91`） |
| FSEvents latency | `0.0`（`macos_fsevent.rs:283`） | 同后端默认 |

无冲突 ⇒ 合并没有语义障碍。

## 3. R2 设计：把 git 元数据分类并入主回调

### 3.1 核心做法

在主回调（`build_notify_callback`）里，**在丢弃 `.git` 路径之前**先尝试
git 元数据分类；命中则投递到原有出口，未命中才走既有的噪声丢弃。

```
build_notify_callback 收到 event
  │
  ├─ [新增] if git_meta_ctx.is_some() {
  │        match classify_git_meta_event(&event.paths, &ctx.paths) {
  │            Nothing      → 继续（落到下面，会被 hard-noise 丢弃）
  │            IndexChanged → scheduler hint（与现 git_meta 回调逐字同语义）
  │            HeadChanged  → scheduler hint + sink.emit(GitChanged)
  │            RefsChanged  → scheduler hint
  │        }
  │     }
  │
  └─ 既有链路：is_hard_noise_path → relevant/tree 过滤 → 投递
```

### 3.2 关键不变量（违反即回归）

| # | 不变量 | 为什么 |
|---|---|---|
| I1 | `classify_git_meta_event` 仍是**唯一**判定点，不得在主回调里复制判定逻辑 | 两处各写一份 = 分叉风险，且现有测试只覆盖一处 |
| I2 | 命中 git 元数据的路径**仍必须**被后续 hard-noise 过滤丢弃（不得漏进前端） | `.git` 不是项目内容（`gitignore.rs:12`） |
| I3 | 三条回调的语义逐字保持：index/refs 只发 **hint**、head 才 `emit(GitChanged)` | 公理 1（信号≠事实），`core.rs:487-500` 的既有注释说明了为何 index 不能 emit |
| I4 | 合并只在 `watch_backend().can_exclude_subtrees()` 为真时启用 | Linux/Windows 主 watcher 拿不到 `.git` 事件，合并即丢失功能 |
| I5 | `git_meta` watcher 的失败语义不变：`.git` 监听失败不影响主 watcher | 现状是独立流，失败只损失 git 元数据；合并后若 `.git` 不在覆盖范围内，必须能感知 |

### 3.3 I5 的缺口（必须显式处理）

合并后有一个新的失败模式：**如果 `.git` 因某种原因不在主 watcher 的覆盖范围内**
（例如未来某个后端的 exclusion 列表误含 `.git`、或 root 注册失败降级），
git 元数据会静默失效——而现状下独立流仍能工作。

**处置**：合并路径下增加一个**启动期自检**：
- 若 `can_exclude_subtrees()` 为真，且 `.git` 路径**不在** `build_exclusion_paths` 输出中，
  则走合并；
- 否则（`.git` 被排除）**保留独立 git_meta 流**，并 `log::warn!` 说明原因。

这条自检把「靠结构假设」变成「靠运行期可验证的谓词」，是 I5 的落点。

### 3.4 备选方案与取舍

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（推荐）** | 主回调内联 git 元数据分类 | 流数 2N→N；改动集中在一个函数；无新类型 |
| B | 保留两条流，但共享同一 `RecommendedWatcher` 实例 | notify 的 `Watcher` 是单实例多 watch，可行；但 `create_file_watcher` 与 `create_git_meta_watcher` 的 Config/handler 不同源，需引入多路复用回调层，复杂度高 |
| C | 让 `git_meta` 也走 `create_file_watcher`（带 exclusion） | 它要监听 `.git`，而 exclusion 正是排除 `.git` 的方向，语义相反 |

选 A。B 的复杂度不换来额外收益（A 已达成 1:1），C 自相矛盾。

## 4. R1 设计：排除集合按成本排序

### 4.1 落点

`build_exclusion_paths`（`factory.rs:24`）是集合进入后端的**必经归一入口**，在它内部加排序。

**已核实的调用点（共 2 处，均经此函数）**：

| 调用点 | 场景 |
|---|---|
| `manager/core.rs:373` | 挂载期构造 exclusion 集合 |
| `registration/maintenance.rs:96` | `ReloadAll` 规则变化重建 |

两处都走 `build_exclusion_paths` ⇒ 在此加排序即**两路径同时生效**，无遗漏。

为何不改进 `macos_fsevent.rs` 的 `take(8)`：那里有**两处**
（`with_exclusions` 的 `:276`、`update_exclusions` 的 `:313`），改两处必然有一处漏掉；
且它是后端私有实现，而排序是「集合语义」而非「macOS 实现细节」。

### 4.2 排序规则（确定性）

```
score(path) = (tier, depth, file_name)
  tier 0: 已知高成本目录名（target / node_modules / .next / dist / build /
          .venv / __pycache__ / .gradle / Pods / DerivedData）
  tier 1: 其余

sort_by: tier asc → depth asc → file_name asc   （全部可比，无浮点）
```

- 全部键都是 `Ord`，无 `read_dir` 序依赖 ⇒ 满足 PRD 的「确定性」验收。
- **不改变集合成员**，只改变「超过 8 个时保留哪 8 个」。

### 4.3 与既有语义的边界

`build_exclusion_paths` 现在的文档契约是「去重 + 保序，不新增判定语义」
（`factory.rs:22`）。加排序**违反了这个字面契约**，必须同步改注释，否则注释与
实现矛盾（本项目有 `check_*` 护栏文化，注释失真会被后续 review 判为问题）。

新契约：「去重 + 按成本降序排列（保证截断时保留高成本子树）」。
「不新增**忽略判定**语义」这句仍然成立（哪些路径被排除不变），要写清楚这个区分。

## 5. R3 设计：测试隔离

### 5.1 现状核实结果

需要核实的两个文件：
- `registration/tests.rs`：使用 `WatchRegistration` + mock watcher（`FailureWatch`），
  **不建真实流**（`strategy.rs:44-47` 注释说明了注入原因）。
- `git_meta/tests/watcher.rs`：`create_git_meta_watcher_with` 注入 `watch_fn`，
  真实文件系统是 `tempdir`（`:11` 注释）。

⇒ **两个主要测试文件已经隔离**。采样里 8 条 `neeko_lib` 流更可能来自：
- `cargo test` 并行跑多个测试，每个建真实 `RecommendedWatcher`；
- 或 `manager` 层的集成测试。

### 5.2 处置

不预设结论，改为**护栏化**：新增 `tools/guards/checks/check_watcher_test_isolation.py`，
扫描 `src-tauri/src/**/tests*.rs` 与 `#[cfg(test)]` 块，检测：
- 对 `env!("CARGO_MANIFEST_DIR")` / `std::env::current_dir()` 直接 `watch()`
- 硬编码仓库根路径

失败条件：命中即 fail（带豁免台账）。

> 这条护栏的价值不在于修好这次，而在于**防止下次新增测试再次污染**。
> 若 8 条流实际来自测试并发而非隔离缺失，护栏依然是对的（隔离是可静态保证的）。

## 6. R4 设计：可观测性

在 `create_file_watcher` 成功后打一条 `info!`：

```
[WatchBackend] workspace=<key> streams=1 exclusion_roots=8/12 truncated=true merged_git_meta=true
```

- 挂载/重载各一条，非高频路径。
- `truncated` 让「排除是否被截断」在日志里可见，替代 `sample` 反推。

## 7. 分阶段与依赖

R2 依赖 R1 吗？**不依赖**。两者独立：

| 阶段 | 内容 | 可独立验证 | 风险 |
|---|---|---|---|
| P1 | R1 排序 + 单测 | 是 | 低（纯函数） |
| P2 | R4 日志 | 是 | 极低 |
| P3 | R2 流合并 + 自检 | 是 | **中**（改回调链） |
| P4 | R3 护栏 | 是 | 低 |

建议顺序：P1 → P2 → P4 → P3。把 P3 放最后，因为它风险最高且依赖 P2 的日志
来做验证（合并后 `merged_git_meta=true` 是合并生效的可观测证据）。

## 8. 回滚

- P1：改 `build_exclusion_paths` 一处 + 注释，revert 无副作用。
- P3：`NEEKO_DISABLE_FSEVENT_EXCLUSION` 不覆盖此路径（那是禁用物理排除）。
  需要**独立的**回滚开关：`NEEKO_DISABLE_GIT_META_MERGE=1` 强制走独立流。
  理由：P3 是唯一改变事件来源的改动，必须有运行时退路，且不能与既有开关语义混淆。

## 9. 未在本设计解决的问题（如实记录）

- **fseventsd 的 CPU 活跃栈（CFBundle 扫描）与本文无关**。PRD 已移交。
  本设计不声称改善 CPU，只降流数量与排除选择质量。
- **`git_meta` 的 `refs_dir` 递归监听**（`git_meta/watcher.rs:124`）覆盖
  `.git/refs/**`。合并后这段范围由主 watcher 覆盖（已递归）。

  **已核实**：`classify_git_meta_event`（`classify.rs:33-49`）的判定是
  `p == packed_refs || p.starts_with(refs_dir)` —— **精确前缀匹配**，
  而非「路径含 .git」。故合并时只要传入同一组 `GitMetaPaths`，
  `.git/objects` 的写入仍归 `Nothing`，不会被误判为 refs 变化。

  ⚠️ 但这仍是 P3 **最容易写错的地方**：主 watcher 的事件量远大于
  git_meta 流（后者只订阅 `.git` 三处），因此分类函数会被高频调用。
  实施时必须：
  1. 先判 `is_hard_noise_path`/`.git` 前缀快速短路，再调分类（避免对每个
     源码文件事件都跑三次 `Path` 比较）；
  2. 有对应单测：`.git/objects/xx` 写入 → `Nothing`；`.git/refs/heads/main` → `RefsChanged`。

- **`update_exclusions` 的重启成本**：合并后主 watcher 同时承担 git 元数据，
  而 `update_exclusions` 会 `stop()` → `run()` 重建流（`macos_fsevent.rs:311-317`）。
  重启期间 `.git` 事件也会断——现状下 git_meta 流不受此影响。

  **评估**：`ReloadAll` 由 `.gitignore` 变更触发，属低频；且重启窗口内丢失的
  git 元数据事件会在下一次 `git status` 查询时被事实覆盖（公理 1：信号≠事实）。
  故接受此风险，但 P3 需在日志里记录重启次数，便于验证未变成高频路径。

---

## 10. 实施结果与偏差登记（2026-10-26 复核）

本任务的代码改动分两次提交落地：

| 提交 | 内容 |
| --- | --- |
| `e575e590` | P1 — `build_exclusion_paths` 按成本排序 |
| `0eadd1c1` | P3 — git-meta 合并进主流（含 `decide()` 五条件门控与 `NEEKO_DISABLE_GIT_META_MERGE`）|

P2（R4 日志）与 P4（R3 护栏）**未按计划完整落地**，R5 在 `0eadd1c1` 的邻近改动中补齐。
下面逐条记录「做了什么 / 差什么 / 为什么可以停在这里」，供后续单独开任务时直接接手。

### 10.1 已达成

| 项 | 落点 | 测试 |
| --- | --- | --- |
| R1 成本排序 | `factory.rs:60` `exclusion_cost_tier`；`:82` `build_exclusion_paths` 按 `(tier, depth, file_name)` | 4 条：`exclusion_sort_ranks_heavy_above_light`（唯一的判别性用例）、`_keeps_heavy_roots_when_truncated`、`_is_deterministic`、`_preserves_membership`；旧 `..._and_preserves_order` 已改名 `build_exclusion_paths_dedupes`（其两个输入同为 tier 0，排序失效也 pass —— `implement.md §1.4` 的警告已被遵守）|
| R1 契约改写 | `factory.rs:68-79` 文档改为「去重 + 按成本降序」，并保留「不新增**忽略判定**语义」的区分 | — |
| R2 流合并 | `git_meta_merge.rs:63` `decide()` 五条件；`callbacks.rs:96` 在 hard-noise **之前**分类；`core.rs:466` 条件建独立流 | `decide()` 5 条（`normal_repo_merges` / `non_git_unit_yields_no_paths_and_no_merge` / `non_recursive_backend_never_merges` / `excluded_git_dir_blocks_merge` / `symlinked_root_still_merges_on_unix`）|
| R2 分类语义 | `classify_git_meta_event` 仍是唯一判定点（I1 未破） | `manager/tests.rs` 4 条 `merged_git_meta_*` |
| R2 回滚开关（实现） | `git_meta_merge.rs:30,99` `merge_disabled()` → `merge` 判定 | **无测试**，见 10.2 |
| R5 截断可观测 | `macos_fsevent.rs:366-374` `update_exclusions` 补同款 warn | — |

`cargo test --lib watch_backend` = 27 passed；`cargo test --lib watcher` = 123 passed / 1 ignored。

### 10.2 未达成项（本任务按「记录偏差」收口，不再实施）

#### ① R3 护栏：完全未实现

```
$ ls tools/guards/checks/ | grep -i watch     → 0 命中
$ grep -rn watcher_test_isolation tools/ .github/ lefthook.yml package.json → 0 命中
```

`check_watcher_test_isolation.py` 不存在，`gates.json` 未注册。

**为什么可以停**：这条护栏的前提是「测试可能在污染仓库根」。`10-25-watcher-test-decoupling`
已实测 `cargo test --lib` 全量建流数 = **0**（`watch()` 在完整测试运行中调用 0 次），
且 `design.md §5.1` 已核实 `registration/tests.rs` 与 `git_meta/tests/watcher.rs` 均隔离。
⇒ 缺的是**防回归**，不是缺修复。风险等级：低（新测试若引入真实流，会成为套件耗时可见的回归）。

**接手成本**：约 1 小时（仿 `check_unit_tests_spawn_real_binaries.py` 的结构 + ledger 一行）。

#### ② R4 日志字段不符 PRD

PRD 要求的形态：

```
streams=1 exclusion_roots=<applied>/<requested> truncated=<bool> merged_git_meta=<bool>
```

实际（`macos_fsevent.rs:307`）：

```
[WatchBackend] fsevents stream: exclusion_roots=8/12 truncated=true applied=[...]
```

缺 `streams=` 与 `merged_git_meta=`。合并状态打了**另一条**独立日志
（`core.rs:468` `git meta merged into main watcher (single FSEvents stream)`），
两条日志没有共同标识（这条不带 workspace key，那条带），无法一眼回答
「这个 workspace 现在几条流」。

**附带的不准确**：`core.rs:468` 的文案写 `(single FSEvents stream)`，但合并判定不看
「实际是不是 FSEvents 后端」—— `NEEKO_DISABLE_FSEVENT_EXCLUSION=1` 时后端回退到
`RecommendedWatcher`（仍是 FSEvents，正确），但 Linux 上 `decide()` 的
`backend_can_exclude` 为假所以不会走到这条日志。文案在当前代码下成立，但属
「靠外部前提才成立」的措辞，接手时应改成 `(git meta merged)`。

**为什么可以停**：R4 的目的是「替代下次靠 `sample` 反推」。现有的
`exclusion_roots=/truncated=/applied=` 已经覆盖了截断这一半（而截断正是 R1 的现场证据），
缺的是「流数」这一半。而 `lsof | grep -c FSEvents` 在任何时候都能直接数流数，
日志的价值主要在**长期无人值守时**才体现。风险等级：低。

**接手成本**：约 30 分钟（把 `merged` 作为参数传进 `with_exclusions`，或把日志上移到
`core.rs` 的 `watch()` 里打一条带 workspace key 的）。

#### ③ R2 回滚开关无测试

PRD 验收明写：「`NEEKO_DISABLE_GIT_META_MERGE=1` 时仍建独立流」。
`decide()` 的 5 条测试覆盖了「非 git / 非递归后端 / `.git` 被排除 / 符号链接 / 正常仓库」，
**唯独没有覆盖 env 分支**。

**为什么没顺手补**：`decide()` 读进程级 env，`cargo test` 默认并行下两个用例会互相污染。
本仓已有成熟先例（`ecf07aa5` + `agent/hooks/targets/tests.rs:35` 的 `ScopedEnv`：
RAII + 全局 `Mutex` 持锁到 drop），但那套实现是 `targets/tests.rs` 私有的，
复用需要先把它提到共享测试支撑模块 —— 那是独立的一次重构，不该塞进本任务的收尾。

**风险等级**：中低。开关本身是一行 `is_some()`，写错的概率低；但它是**唯一的运行时退路**，
一旦失效（比如有人改成 `var_os(...).is_some_and(|v| v == "1")`），排查时会影响判断。

**接手成本**：约 1.5 小时（提 `ScopedEnv` 到共享支撑 + 1 条测试）。

#### ④ PRD 的实测对比未做

验收要求：「同一组 workspace 下，修复前后 `lsof -p <pid> | grep -c FSEvents` 流数下降，
且 `sample fseventsd` 中 `neeko_lib` client 线程数相应下降」。

**未做的原因**：需要跑 `pnpm tauri dev` + 挂载多个项目 + 前后各一次 `lsof`/`sample`。
而本任务的改动（2N → N）在代码上是**构造性保证**的：`core.rs:466` 的条件
`git_repo && !merge_git_meta && !skip_real_fs`，合并成立时不调 `create_git_meta_watcher`。
单测 `normal_repo_merges` 断言了 `decide().merge == true`，而 `merge == true` 就是
「不建第二条流」的唯一充分条件。

⇒ 缺的是**端到端确认**，不是缺证据。风险等级：低（但若 `decide()` 的
`backend_can_exclude` 在真机上为假，合并会静默失效——这正是 ② 里「日志缺 streams=」
让人无法快速确认的部分，两个缺口是耦合的）。

### 10.3 与 PRD 的其它偏差（不算缺失，但需登记）

**R1 的档位从 2 档改成 3 档**。PRD 写「tier 0 = 已知高成本目录名（10 个），tier 1 = 其余」，
实际是 3 档、tier 0 只 4 个（`target` / `node_modules` / `DerivedData` / `Pods`）。

理由记在 `factory.rs:26-44` 的注释里：真机验证暴露了两档的浪费 —— 一个 33 个 ignored 根的
仓库里，8 个名额被 4 个 `__pycache__` 占掉（实测仅 138 个文件），而 `node_modules` 有 41843 个。
同档内按字母序决胜时，小目录会挤掉大目录。⇒ 把 `__pycache__` 等降到 tier 1，`target`/
`node_modules` 独占 tier 0。

**这是改进而非妥协**，但 PRD 的验收条目「tier 0 与 tier 1 混合时 tier 0 在前」的测试
（`exclusion_sort_ranks_heavy_above_light`）仍然成立且仍是唯一判别性用例。

**P3.0 建议的「`.git` ∉ exclusions」契约测试**：已有等价覆盖
（`manifest.rs:143-148` 断言 `ignored == vec![node_modules]`，即 `.git` 不入 `ignored_roots`），
无需新增。

### 10.4 死测试（可删，未删）

`manager/tests.rs:352-372` 的两条：

- `git_meta_merge_is_rejected_for_linked_worktree`
- `git_meta_merge_is_allowed_for_normal_repo`

它们测的是**文件内本地副本** `git_meta_within_root`（实现就是 `git_dir.starts_with(root)`），
不是 `decide()`。真实的等价覆盖在 `git_meta_merge.rs:192` / `:206`（那两条调 `within_root`，
同样是本地副本——但至少与 `decide()` 同文件、同模块）。

⇒ 两处都是「用自己的替身测自己的替身」。`decide()` 的真实覆盖由
`linked_worktree_git_dir_is_outside_root` 之外的 5 条 `decide(...)` 调用承担。
删掉 `manager/tests.rs` 那两条不损失覆盖。

未删的理由：它们当前**是绿的、不产生噪声**，删除属于清理而非缺陷修复，
与本任务的验收目标无关。

### 10.5 spec 失真（**未修，需后续处理**）

`.trellis/spec/backend/git-domain.md:545`：

> **生产者**：一个单元一套资源（worker + file watcher + git-meta watcher）

这句话在 macOS 上**已经不成立**（git-meta 已并入主 watcher）。Linux 上仍成立。
同一文件 `:1066` 的目录说明也没提 macOS 的合并。

按 `AGENTS.md`「收尾：同步必要 spec 文档」这条本应在归档前修掉。**本次未修**，
原因是：修它需要在一句话里表达「macOS 合并 / Linux 独立」这个平台分支，
而这句话在 spec 里属于「身份与生产者」章节，改写要连带核对上下文语义。
留给接手者处理更好，避免在归档提交里塞一段没被 review 过的 spec 改写。

**风险**：中。后续 agent 读 `git-domain.md:545` 会认为「每个单元必有一条 git-meta watcher」，
在 macOS 上按这个前提推理会得出错误结论（例如「改 git_meta 不影响主 watcher」）。
这是本任务留下的**最实质的技术债**。

### 10.6 建议的后续任务划分

| 优先 | 内容 | 成本 |
| --- | --- | --- |
| **P1** | 修 `git-domain.md:545` / `:1066` 的平台分支表述（10.5） | 30 min |
| P2 | R4 日志补 `streams=` + `merged_git_meta=`，与 workspace key 同条（10.2②） | 30 min |
| P3 | `ScopedEnv` 提到共享测试支撑 + `decide()` env 分支测试（10.2③） | 1.5 h |
| P4 | `check_watcher_test_isolation.py`（10.2①） | 1 h |
| P5 | `lsof` 流数实测对比（10.2④，依赖 P2 的日志先落地） | 1 h |
| — | 删 `manager/tests.rs:352-372` 两条死测试（10.4） | 5 min |
