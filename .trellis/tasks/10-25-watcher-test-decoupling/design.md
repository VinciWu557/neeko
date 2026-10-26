# Design — watcher 测试架构重构

> 配套 `prd.md` 与 `analysis.md`。
> **关键结论先行**：`build_notify_callback` 已经是纯函数（9 个参数全是 channel /
> trait object / 纯值），但**没有任何测试直接调用它**。所有测试都绕道真实 FSEvents
> 流 → 内核投递 → debounce 线程，绕三层异步去验证一个纯函数的行为。
> 因此本任务的重心不是「加注入缝」，而是**把测试下沉到它本来该在的层**。

## 1. 分层模型：断言的输入在哪

```
真实文件变更
    ↓  ← 层 C：FSEvents 投递（内核，不可控）
notify::Event
    ↓  ← 层 A：build_notify_callback（纯函数，可直接喂事件）
sink / scheduler_tx / debounce_tx / maintenance_tx
    ↓  ← 层 B：DebounceSender（自有线程，可确定等待）
FileChangedEvent → sink
    ↓  ← 层 D：WatcherManager 编排（幂等/作废/票号/登记）
snapshots / version_floors / mount_tickets
```

**测试应该只覆盖它能确定性控制的那一层。** 现状是所有测试都从 C 层进入。

## 2. 代码事实（已核实）

### 2.1 `build_notify_callback` 可直接构造，零 IO

9 个参数全部无需真实 IO：

| 参数 | 类型 | 是否需真实 IO |
|---|---|---|
| `repo` | `WorkspaceRef` | 否（纯值） |
| `sink` | `Arc<dyn WatcherEventSink>` | 否（已有 `CollectingSink` 替身） |
| `gitignore_filter_for_notify` | `Option<Arc<GitIgnoreFilter>>` | 否（可指向 tempdir，不建流） |
| `maintenance_tx_for_closure` | `mpsc::Sender<WatchMaintenance>` | 否 |
| `debounce_tx_for_notify` | `mpsc::Sender<PathBuf>` | 否 |
| `tree_debounce_tx` | `mpsc::Sender<PathBuf>` | 否 |
| `scheduler_tx` | `Option<mpsc::Sender<()>>` | 否 |
| `git_repo` | `bool` | 否 |
| `git_meta` | `Option<GitMetaCallbacks>` | 否（闭包） |

返回 `impl FnMut(Result<Event, notify::Error>)` —— 可同步调用、同步断言。

### 2.2 `poke_status_worker_and_wait` 不依赖 watcher

```rust
// core.rs:203-213
pub fn poke_status_worker_and_wait(&self, repo: &WorkspaceRef, timeout: Duration) -> bool {
    let Some(handle) = self.watchers.lock().ok()
        .and_then(|m| m.get(&repo.key()).and_then(|h| h.worker.as_ref().cloned()))
    else { return false; };
    handle.check_and_wait(timeout)
}
```

只取 `handle.worker`，**与 watcher 实例无关**。`GitStatusWorker::start` 同样不依赖
watcher（`worker.rs:55-58`，只要 `repo` 与回调）。

⇒ 「快照 / poke / 票号」类测试**不需要建流**，只需要 worker。

### 2.3 现有测试无一直连回调层

```bash
$ grep -rn "build_notify_callback" --include=*.rs | grep -i test
# （无输出）
```

## 3. 28 个测试的分层归类（已逐条核实断言对象）

| # | 测试 | 断言对象 | 目标层 | 需真实流 |
|---|---|---|---|---|
| 1 | `watch_delivers_file_changed` | sink 事件 | **C** | 是 |
| 2 | `unwatch_stops_delivering_events` | sink 事件（无） | **C** | 是 |
| 3 | `watch_twice_is_idempotent` | watch 计数 | **D** | 否 |
| 4 | `rewatch_after_unwatch_rebuilds_single_set` | watch 计数 | **D** | 否 |
| 5 | `unwatch_stops_git_worker_snapshots` | sink + poke | **A/D** | 否 |
| 6 | `poke_..._confirms_fresh_snapshot_after_write` | 快照 + poke | **D** | 否 |
| 7 | `poke_..._is_noop_for_non_git_project` | poke | **D** | 否 |
| 8 | `two_units_..._independent_snapshots` | 快照 + 计数 | **D** | 否 |
| 9 | `unwatch_drops_only_that_unit_snapshot` | 快照 | **D** | 否 |
| 10 | `unwatch_project_releases_every_workspace` | 快照 | **D** | 否 |
| 11 | `poke_after_unit_switch_recomputes` | 快照 | **D** | 否 |
| 12 | `linked_worktree_edit_pushes_versioned_snapshot` | sink + 快照 | **A/D** | 否（事件可合成） |
| 13 | `twenty_unit_switches_do_not_accumulate_mounts` | （内部状态） | **D** | 否 |
| 14 | `writes_in_unmounted_sibling_..._leak_nothing` | sink + 快照 | **A/D** | 否（事件可合成） |
| 15 | `pull_cannot_overwrite_a_live_push_snapshot` | 快照 | **D** | 否 |
| 16 | `activate_style_release_except_keeps_only_target` | 快照 + 票号 | **D** | 否 |
| 17 | `push_with_current_ticket_is_written_and_emitted` | sink + 快照 + 票号 | **D** | 否 |
| 18 | `push_after_release_with_stale_ticket_is_rejected` | sink + 快照 + 票号 | **D** | 否 |
| 19 | `remount_rejects_previous_mounts_late_push` | 快照 + 票号 | **D** | 否 |
| 20 | `unmounted_pulls_advance_the_same_registry_sequence` | 快照 | **D** | 否 |
| 21 | `remount_continues_the_unit_version_sequence` | 快照 | **D** | 否 |
| 22 | `pull_after_a_release_still_continues_the_sequence` | 快照 + 票号 | **D** | 否 |
| 23 | `edit_to_push_latency_p95_worktree_vs_main` | 延迟 | **C** | 是 |
| 24 | `concurrent_mount_of_different_units_keeps_single_mount` | watch 计数 | **D** | 否 |
| 25 | `concurrent_mount_of_same_unit_creates_one_set` | watch 计数 | **D** | 否 |
| 26 | `mount_only_reasserting_same_unit_is_a_noop` | watch 计数 | **D** | 否 |
| 27 | `concurrent_pulls_on_one_unit_never_regress_slot` | 快照 | **D** | 否 |
| 28 | `external_ref_update_pushes_new_snapshot` | sink + 快照 | **A/D** | 否（事件可合成） |

**统计**：

| 层 | 数量 | 需真实 FSEvents |
|---|---|---|
| A（回调，合成事件） | 4 | 否 |
| D（编排/状态机） | 21 | 否 |
| C（真实投递） | 3 | **是** |
| 合计 | 28 | 3 |

⇒ **25 个（89%）可以不建流。**

> 与 `prd.md` 原估的「23 个状态机 / 5 个真实」略有出入：逐条核实后，
> 真实投递只有 **3 个**（#1 #2 #23），另 2 个（#12 #28）的断言对象其实是
> 「快照是否更新」而非「事件是否到达」，可用合成事件覆盖。

## 4. 三层测试的具体形态

### 4.1 A 层：回调纯函数测试

```rust
fn make_callback(root: &Path) -> (impl FnMut(Result<Event, notify::Error>), Sink, RxBundle) {
    // 构造全部 channel + CollectingSink，不建任何 watcher
}

#[test]
fn gitignored_path_is_dropped_before_reaching_sink() {
    let (mut cb, sink, _rx) = make_callback(root);
    cb(Ok(Event::new(EventKind::Modify(DataChange::Content))
        .add_path(root.join("debug.log"))));       // 被 .gitignore 忽略
    assert_eq!(sink.count(FILE_CHANGED_EVENT), 0);  // 同步断言，零 sleep
}
```

**覆盖的语义**（这些都是当前只在真实 IO 下被间接验证的）：
- gitignore 过滤、hard-noise 丢弃、结构事件边界保留
- git 元数据分类（`.git/objects` → Nothing、`refs/**` → RefsChanged）
- overflow 错误事件 → 空 dirs 的 TreeChanged
- `.gitignore` 变更 → `ReloadAll` 消息投递

**这一层目前完全没有直接测试**，是本任务的最大增量。

### 4.2 D 层：编排与状态机

需要 worker 但不需 watcher。两条路：

| 选项 | 做法 | 取舍 |
|---|---|---|
| D-1 | `WatcherManager` 内部加 `#[cfg(test)]` 的 `mount_without_watcher()` | 生产类型被测试污染 |
| D-2 | 注入 `make_watcher: Fn() -> notify::Result<W>`，`W: Watcher` | 生产签名变更 |
| **D-3** | **`_watcher` 改为 `Option`，加 `worker_only()` 构造器** | 需改字段类型（但字段零读取） |

**选 D-3**，已核实其可行性：

- `_watcher: Arc<Mutex<PlatformWatcher>>` **在整个代码库中零读取**
  （`grep "\._watcher"` 无输出）—— 它是纯保活字段，`_` 前缀即声明意图；
- 维护线程用的是**独立**的 `Arc::downgrade(&watcher)`（`core.rs:478`），
  不经过 handle 里的那份；
- `WatcherHandle` **没有 `impl Drop`** —— 释放靠字段自身 drop 顺序，
  `Option` 化不改变任何语义。

⇒ 把 `_watcher` 改为 `Option<Arc<...>>`，并加 `worker_only()` 构造器
（其余字段给最小占位）。生产路径仍填 `Some`，行为逐字不变。

**D 层断言为什么够**：`poke_status_worker_and_wait` 只取 `handle.worker`
（`core.rs:203-213`），`snapshot` 只读 `self.snapshots`。两者都不碰 `_watcher`。

### 4.3 B 层：debounce 合并

`DebounceSender` 有自己的线程与 `recv_timeout`。测试可：

```rust
debounce_tx.send(path);
let event = out_rx.recv_timeout(Duration::from_millis(500))?;  // 确定等待，非固定 sleep
```

`recv_timeout` 是**事件驱动**的（有数据立即返回），不是 sleep。

### 4.4 C 层：3 个真实投递测试

保留真实 FSEvents，串行执行。

## 5. sleep 的替换矩阵

| 现有 sleep | 出现位置 | 替换方案 |
|---|---|---|
| `WATCH_SETTLE = 300ms` | A/D 层测试 | **删除** —— 无 watcher 可等 |
| `WATCH_SETTLE` | C 层测试 | 保留（真实流需要稳定期） |
| `QUIET_WINDOW = 2000ms`（「无事件」） | A 层 | **删除** —— 同步断言 `count == 0` |
| `QUIET_WINDOW` | C 层 | 保留（见下「理论边界」） |
| 轮询 `25ms` | `wait_for_event` | A/D 层改 `recv_timeout`；C 层保留 |

### 理论边界（必须如实记录）

「确认事件**没有**发生」在异步系统里无法用纯确定性手段证明 —— 只能等足够久。
这是停机问题的实际变体。

因此：
- **A/D 层**能做到真正确定性（同步执行完即结论）；
- **C 层**的「无事件」断言必须保留一个时间窗。可优化为「连续 N 次静默即返回」，
  但那是**缩短**而非**消除**，且引入新的参数选择问题。本任务不改 C 层的窗口策略。

## 6. 失败模式覆盖矩阵（R4 合并的依据）

合并前先列「每个测试守护哪个失败模式」，避免按行数砍掉覆盖。

| 失败模式 | 守护测试 | 合并后 |
|---|---|---|
| 重复挂载（同单元 watch 两次） | #3 #25 | 保留 1 条 |
| 释放后泄漏（unwatch 不停） | #2 #4 | 保留 1 条（D 层） |
| 快照跨单元串味 | #8 #14 | 保留 1 条 |
| 号段回退（version 归零） | #20 #21 #22 | **合并为 1 条**（同一不变量的三种操作序列） |
| 票号误吊销（并发重挂载） | #19 #16 | 保留 2 条（方向相反） |
| 陈旧票仍可写 | #18 | 保留 |
| 未挂载单元被顺带重算 | #11 #7 | 保留 1 条 |
| 切走后残留旧快照 | #9 #10 | 保留 1 条 |

**合并后预计**：28 → 约 20 条（其中 A 层新增约 6 条，净减 8 条重复）。

## 7. 分阶段与依赖

| 阶段 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| P1 | `WatcherHandle::worker_only()`（D-3） | — | 低 |
| P2 | A 层回调测试（新增 ~6 条，零 IO） | — | 低 |
| P3 | 25 个测试从 C 层下沉到 A/D 层 | P1 | **中** |
| P4 | R4 合并重复用例 | P3 | 中（需覆盖矩阵核对） |
| P5 | C 层 3 个测试串行化 | — | 低 |

建议顺序：P1 → P2 → P5 → P3 → P4。
P2 先行：它是**纯增量**，不改现有测试，可独立验证「回调层能测出什么」。
P5 先行：立即可把 fseventsd 从 100% 压到可接受水平。

## 8. 回滚

- P1/P2 纯新增，revert 无副作用。
- P3/P4 改测试文件，`git revert` 恢复原状（无生产代码变更）。
- 全阶段不改 `WatcherManager` 的公开行为，生产风险为零。

## 9. 不做什么

- 不给 `PlatformWatcher` 加 mock 变体（已论证不需要）。
- 不改 `create_file_watcher` 签名。
- 不改 C 层的 `QUIET_WINDOW` 策略（缩短它需要单独的论证）。
- 不拆 `lifecycle_tests.rs` 文件（1642 行 → 预计 ~1200 行，拆分是独立议题）。

---

## 10. 实施结果（2026-10-25 实测，取代 §3-§7 的预估）

### 实际分层（与 §3 预估的偏差）

| 层 | 预估 | 实际 | 偏差原因 |
|---|---|---|---|
| A 回调注入 | 4 条 | **8 条新增** | 落地时发现回调层原本零测试，补全了 8 条 |
| D 状态机 | 21 条 | **19 条** | 6 条实测后回退（见下） |
| C 真实投递 | 3 条 | **0 条** | 全部删除，见「第三方契约」结论 |

**§3 分类表的 6 处误判**：`watch_twice_is_idempotent` / `rewatch_after_unwatch_rebuilds_single_set` /
`mount_only_reasserting_same_unit_is_a_noop` / `remount_continues_the_unit_version_sequence` /
`linked_worktree_edit_pushes_versioned_snapshot_without_manual_poke` /
`external_ref_update_pushes_a_new_snapshot_without_manual_poke` —— 它们经 `without_real_fs`
后失败，因为断言依赖「事件真的驱动 worker」。改用**投喂合成事件**后才通过。

### 关键结论：不为第三方 OS 契约写测试

`macos_fsevent` 的 3 个真实流测试（`excluded_subtree_delivers_zero_events` 等）**全部删除**。
它们验证的是「FSEvents 是否按 Apple 文档投递事件」——那是 Apple 的既成事实，不是本仓契约。

本仓真正拥有的判据被抽成纯函数，`0.00s` 覆盖：

- `should_handle_event(path, recursive_info)` —— 路径是否在订阅范围内
- `translate_flags(flags, precise)` —— flags → `EventKind`
- `dispatch_git_meta_event(paths, meta, ..)` —— 一批路径 → 分类 → 三出口

### 量化结果

| 指标 | 改造前 | 改造后 |
|---|---|---|
| `cargo test --lib` | 36s | **13.5s** |
| `cargo test --lib watcher` | 48s | **6.6s** |
| `cargo test --lib git_meta` | 6.4s | **0.01s** |
| `cargo test --lib macos_fsevent` | 6.4s | **0.00s** |
| 全量测试期间建流数 | 数十条 | **0 条**（`watch` 调用计数 = 0） |

### 一个被证伪的假设（避免后人重复）

调研中曾判断「FSEvents 建流本身有设备级 journal 对齐成本」。**实测否定**：

| 实验 | CPU |
|---|---|
| Swift 独立进程：3 次建流/拆流 | 0~0.2% |
| Swift：1 条流复用 | 0% |
| Swift：1:1 复现 Rust 测试（含 `SetExclusionPaths`、相同路径/写入/时长） | 0% |
| **Rust debug 构建同一逻辑** | **78%** |
| **Rust release 构建同一逻辑** | **0.1~0.7%** |

⇒ 成本来自 **debug 构建下未优化的回调路径**（`PathBuf` 构造 / `HashMap` 查找 / `format!`），
比 release 慢约 100 倍；fseventsd 的 100% 是「消费方太慢 → mach 队列积压」的**结果**。

**「复用 fseventsd」不可行也不必要** —— 建流本身零成本，复不复用都一样。

### 全量测试仍见 fseventsd 高 CPU 时

不是本仓测试。判定方法：在 `with_exclusions` / `watch` 加一次性计数器（比 `sample` 可靠，
后者需 sudo）。本仓全量测试的调用计数为 **0**。高 CPU 来自系统里其它 FSEvents client
（Electron 应用 / 微信 / 云盘 / 编辑器索引）被「大量临时文件创建删除」唤醒。

---

## 11. 收尾补齐（2026-10-26 第二轮）

§10 记录的是第一轮落地的形态。第二轮按 PRD 逐条复核，补了三处**实际未达成**的验收项、
修了一个实测坏掉的用例，并补齐了 §10 缺失的验证记录。

### 11.1 R4 — 三条号段用例合并为一条

`unmounted_pulls_advance_the_same_registry_sequence` /
`remount_continues_the_unit_version_sequence` /
`pull_after_a_release_still_continues_the_sequence`
→ 合并为 `version_sequence_stays_monotonic_across_every_producer_and_release`。

判据是「不丢失败模式」，不是「减少行数」。合并后 4 条子场景各对应一个独立失败模式：

| 子场景 | 失败模式（改坏什么会红） |
| --- | --- |
| ① pull → pull | 号源改成「每次 pull 从 1 起」/ 未挂载 pull 不登记 |
| ② 挂载内 push → push | worker 推送不走注册表盖章 |
| ③ 释放 → 重挂载 | `release_one` 连带清 `version_floors`（原缺陷） |
| ④ 挂载 → 释放 → pull | 释放后的 pull 另起号段 |

`lifecycle_tests.rs`：28 → 27 条（净减 1 条夹具重复，覆盖不减）。

### 11.2 R2 — sleep 的真正削减（不是「删注释」）

删除的等待（全部是「等一个由构造保证的空集」）：

| 位置 | 原等待 | 为什么不需要 |
| --- | --- | --- |
| `unwatch_stops_delivering_events` | 300ms | `unwatch` → handle 移出 → `DebounceSender` drop → channel 全灭 → 线程退出；回调也已随 handle drop，测试**没有可再喂的入口** |
| `unwatch_stops_git_worker_snapshots` | `WATCH_SETTLE + QUIET_WINDOW` = 2.3s | 同上：worker / scheduler / debounce 三条线程都已随 handle 关闭 |

保留的窗口（**唯一一处**，且在 PRD 边界内）：
`writes_in_unmounted_sibling_unit_leak_nothing_into_mounted_unit` 的 `QUIET_WINDOW`
—— 它要收敛的是「A 自己那次变更引发的异步推送」，属真实调度，无法同步化。

顺带删除死常量 `WATCH_SETTLE`（唯一使用者已被删）。`cargo test --lib watcher`：6.6s。

### 11.3 变异验证（PRD R2「至少 5 条」→ 实际 6 条，逐条红→绿）

| # | 被测守卫 | 变异体 | 变红的用例 |
| --- | --- | --- | --- |
| 1 | `classify_git_meta_event` 的 head **精确路径**匹配 | `p == head` → `p.file_name() == head.file_name()` | `sibling_unit_gitdir_event_is_classified_as_nothing` |
| 2 | `release_one` **不清** `version_floors` | 加 `floors.remove(workspace)` | `version_sequence_stays_monotonic_...` |
| 3 | 票号 **compare-and-remove** | `if get==seq {remove}` → 无条件 `remove` | `release_does_not_revoke_a_ticket_issued_by_a_concurrent_remount` |
| 4 | `snapshot` 按**单元**而非项目取 | 改成按 project_id 前缀找第一条 | 4 条（`two_units_...` / `unwatch_drops_only_...` / `poke_after_unit_switch_...` / `writes_in_unmounted_sibling_...`）|
| 5 | `release_one` **作废数据** | 删掉 `drop_snapshot_if_present` | 5 条（含 `version_sequence_...`）|
| 6 | `watch` 入口**幂等护栏** | `contains_key` 判定恒 false | `watch_twice_is_idempotent` |

**变异过程中抓到两处假绿（记录以避免重复）**：

1. #1 的第一次变异**没红** —— 原因不是守卫无关，而是新用例喂的路径未 `canonicalize`，
   过不了回调里的 `starts_with(&ctx.paths.git_dir)` 前缀判定，事件根本没进分类。
   已修（喂前 `.canonicalize()`，并注明真实 FSEvents 上报的就是 realpath）。
   这是本仓第二次踩同一个坑（先前 `external_ref_update_*` 已记过一次）。
2. #3 的第一次变异**没红** —— 原 `remount_rejects_previous_mounts_late_push` 走完整
   `unwatch` → `watch` 序列，此时「无条件删除」与「compare-and-remove」**行为等价**
   （删除落点永远是旧票）。真正区分两者的是**交错**：A 取出 handle 后、吊销前，
   B 完成重挂载并签发新票。为此新增 `revoke_dead_mount_for_test`（暴露
   `release_one` 的同一条吊销路径）并写了构造该交错的用例。

⇒ **PRD R2「断言内容不得弱化」在本轮才算真正被验证**：第一轮的两条「状态机」用例
（票号误吊销、跨单元泄漏）在 `without_real_fs` 夹具下其实是**构造性真**，靠变异验证才暴露。

### 11.4 修掉一个实测坏掉的用例

`measure_push_latency` 在 §10 的改造里被一并加了 `.without_real_fs()`，但它是
**端到端时延测量**（AC4 现场项）：Noop watcher 永不投递事件 ⇒ 第 0 轮必然超时。
实测确认：`第 0 轮写入后 8s 内快照 version 未前进`。

已恢复为 `WatcherManager::new()`（真实流，`#[ignore]` + `real_fs_guard()`），并复测：

```
linked worktree 单元: n=20 p50=88.6ms p95=112.8ms max=112.8ms mean=94ms
主仓单元          : n=20 p50=87.3ms p95=112.4ms max=112.4ms mean=94ms
```

⇒ `real_fs_guard()` 现在有且仅有这一个使用者（注释已同步，原注释称「3 个用例」已失真）。

### 11.5 下沉「兄弟单元泄漏」的真实判据

`writes_in_unmounted_sibling_unit_leak_nothing_into_mounted_unit` 在 Noop 夹具下的
负向断言是**构造性真**（watcher = Noop + `skip_real_fs` 跳过 git_meta 流 ⇒ 兄弟单元
写入无论如何都不产生事件）。它守护的历史缺陷（`.git/worktrees/**` 广播给所有消费者）
因此失去可证伪性。

真正属于本仓判据的两件事已下沉到 `callback_tests.rs`（合成事件，零流零 sleep）：

- `own_git_index_event_signals_scheduler_without_emitting_a_fact` —— 本单元 index
  只发查询调度信号、不 emit 事实（公理 1）；
- `sibling_unit_gitdir_event_is_classified_as_nothing` —— **别的单元**的 gitdir
  （`<root>/.git/worktrees/other/HEAD`）事件必须归为 `Nothing`。

### 11.6 与 §9「不做什么」的偏差（如实登记）

§9 写「不给 `PlatformWatcher` 加 mock 变体」，实际落地加了 `#[cfg(test)] Noop`
（`platform/watch_backend/platform_watcher.rs:27`）。§10 未记录这条偏差，现补记：

- `Noop` 只在 `without_real_fs()` 分支出现，`#[cfg(test)]` 门控，不进发布产物；
- 但仍然**是**一个 `PlatformWatcher` 变体，与 §9 的字面承诺冲突；
- 采纳理由：`worker_only()` 构造器方案（§2 的 D-3）只能覆盖 D 层，覆盖不到
  「`watch()` 全流程 + 回调层」——而那正是 6 条必须投喂事件的用例需要的。
  `Noop` 让 `watch()` 的 7 段编排全部照常执行。

### 11.7 门禁

- `cargo fmt --check` 干净
- `cargo clippy --all-targets -- -D warnings` 无 issue
- `cargo test --lib`：2241 passed / 5 ignored / 15.5s
- `cargo test --lib watcher`：123 passed / 1 ignored / 6.6s
- `pnpm check:quick`：10 条护栏全通过，含 `check_nondeterministic_event_assertions` 违规 0
