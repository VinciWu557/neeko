# 分析 — 注入粒度 / mock 深度 / 确定性等待

> 本文件是 `prd.md` 开放问题 1–3 的分析结论，不含实现。
> 所有判断基于 `manager/core.rs::watch()` 的实际结构（5 个阶段，~310 行）。

## `watch()` 的职责分解

注入粒度的选择取决于「哪些步骤是待测对象」。`watch()` 内部按注释分 5 段：

| 阶段 | 内容 | 依赖真实 IO？ |
|---|---|---|
| 0. 入口不变量 | `watchers.contains_key` 幂等检查 | 否（纯内存） |
| 0b. 快照作废 | `drop_snapshot_if_present`（顺序关键） | 否（纯内存） |
| 1. worker | `GitStatusWorker::start` + 票号签发/arm | 部分（worker 内部跑 git 子进程） |
| 2. scheduler | `ThrottleScheduler` | 否（纯内存） |
| 3. debounce | `DebounceSender` / `TreeChangeDebounceSender` | 否（纯内存，但内含线程） |
| 4. watcher | `create_file_watcher` → `WatchRegistration::register_root` | **是（真实 FSEvents）** |
| 4b. git meta | `create_git_meta_watcher` 或合并分支 | **是（真实 FSEvents）** |
| 5. heartbeat | 心跳线程 | 否（定时器） |
| 6. 登记 | `watchers.insert(handle)` | 否（纯内存） |

**关键观察**：真实 IO 只集中在阶段 4 / 4b。其余 7 段全部是纯内存状态机 ——
而它们正是 23 个测试真正断言的对象。

## 问题 1：注入「watcher 构造器」vs「整个 watch 动作」

### 方案 A — 注入 watcher 构造器

```rust
pub fn watch(&self, repo: WorkspaceRef, sink: Arc<dyn WatcherEventSink>);
// 内部改为：
pub(crate) fn watch_with<F>(&self, repo, sink, make_watcher: F)
where F: FnOnce(...) -> notify::Result<PlatformWatcher>;
pub fn watch(&self, repo, sink) {
    self.watch_with(repo, sink, |handler, cfg, excl| create_file_watcher(handler, cfg, excl))
}
```

**保留在测试覆盖内的**：阶段 0/0b/1/2/3/5/6 全部真实代码 —— 幂等检查、快照作废顺序、
票号签发与吊销、scheduler 构造、debounce sender、心跳线程、handle 登记。

**被替换的**：只有阶段 4/4b 的「建流」这一个动作。

**代价**：`PlatformWatcher` 目前是 `enum { Native, MacExclusion }`。mock 必须伪装成
其中一员。两条路：
- 给 enum 加 `#[cfg(test)] Mock(...)` 变体 —— 污染生产类型（违反开闭原则的常见误用）；
- 让 `create_file_watcher` 返回 `Box<dyn Watcher>` —— 改动生产签名，影响面大。

⇒ **需要额外决策**：注入缝的「返回值形态」本身是个设计问题，不是纯测试问题。

### 方案 B — 注入整个 watch 动作

```rust
pub fn watch(&self, repo, sink);           // 生产：完整实现
// 测试：直接调内部子步骤，或整个替换
```

**保留在测试覆盖内的**：几乎为零 —— 若测试直接操作 `snapshots` / `version_floors` /
`mount_tickets` 这些字段，它验证的是「字段的读写」，而不是「`watch()` 的编排」。

**被替换的**：阶段 0/0b/1/2/3 的**编排顺序**（幂等检查在作废之前、作废在 worker 之前）。

**致命问题**：`lifecycle_tests` 里最有价值的断言恰恰是编排顺序：

```rust
// core.rs:271-274 的注释说明了为什么顺序不能颠倒：
// 「worker 在 check() 里可能在本函数返回前插入新快照，那句 drop 若留在尾部
//   会把刚产出的首个快照一起删掉」
```

这类「顺序错了就出 bug」的不变量，**只有走完 `watch()` 全流程才能验证**。
方案 B 会把这批断言全部降级为「手动重放步骤」，失去对真实编排的约束。

### 结论：选 A，但需解决返回值形态

| 维度 | A（注入构造器） | B（注入整个动作） |
|---|---|---|
| 覆盖 `watch()` 编排顺序 | ✅ 完整 | ❌ 丢失 |
| 覆盖幂等 / 快照作废 / 票号 | ✅ 完整 | ❌ 退化为手动重放 |
| 需改生产签名 | 是（返回值形态） | 否 |
| 测试与生产偏离风险 | 低 | **高**（测的不是生产代码） |

**推荐 A**，并把「返回值形态」列为 A 的前置设计决策（见下方「遗留决策」）。

## 问题 2：mock 需要模拟到什么程度

### 用户判断

> 状态机测试是否真需要 mock 投递事件，应该需要 mock 投递事件，不然流程不能闭环

**这个判断正确，且有代码证据。**

`lifecycle_tests` 中 23 个「状态机」测试里，真正完全不依赖事件投递的其实很少。
抽查三条：

| 测试 | 是否依赖 mock 投递事件 |
|---|---|
| `watch_twice_is_idempotent` | 否 —— 只断言 `watcher_set_creations()` 计数 |
| `unwatch_stops_git_worker_snapshots` | **是** —— 断言「unwatch 后不再有新快照」，需要事件驱动 worker |
| `writes_in_unmounted_sibling_unit_leak_nothing_into_mounted_unit` | **是** —— 断言「兄弟单元的写入不得进入本单元」，需要事件路径 |
| `poke_after_unit_switch_recomputes_the_unit_that_was_written` | 否 —— `poke_status_worker_and_wait` 是主动触发，非事件驱动 |

⇒ 23 个里既有「只需 `Ok`」也有「必须投递事件」的。**统一按「能投递事件」实现**更简单，
且避免测试写作者以后误用。

### mock 的能力矩阵

| 能力 | 必要性 | 说明 |
|---|---|---|
| `watch(path, mode)` 返回 `Ok` | 必须 | 阶段 4 需要 |
| `unwatch(path)` 返回 `Ok` | 必须 | 释放路径需要 |
| **主动投递合成事件** | **必须** | 「写入 → worker 重算 → 快照更新」的闭环 |
| 记录 `watch`/`unwatch` 调用序列 | 必须 | 幂等/泄漏类断言依赖它（已有 `watcher_set_creations()`） |
| 模拟 `watch` 失败（EMFILE） | 可选 | 降级路径已由 `registration/tests.rs` 的 `FailureWatch` 覆盖，不必重复 |
| 模拟 overflow / 错误事件 | 可选 | 若现有测试未覆盖，不因本任务新增 |

**关键设计点**：mock 投递事件需要**绕过真实 debounce 线程**吗？

`DebounceSender` 内部有 200ms 滑动窗口 + 1500ms 上限。若 mock 投递的事件也要经过
debounce，则测试仍需等待 —— 只是从「等真实 FSEvents」变成「等自己的 debounce」，
**没有消除 sleep**。

⇒ mock 的投递路径必须能**同步驱动**到 sink，或提供「flush 完成」的可等待信号。
这是问题 3 的核心。

## 问题 3：用确定性信号替代 sleep

### 现状：sleep 在做三件事

| sleep | 用途 | 能否确定化 |
|---|---|---|
| `WATCH_SETTLE = 300ms` | 等 watcher 注册稳定后再写入 | **能** —— mock 下 `watch()` 返回即稳定 |
| `QUIET_WINDOW = 2000ms` | 「确认事件**没有**到达」 | **不能完全**，但可大幅缩短（见下） |
| `FIRST_EVENT_TIMEOUT = 8000ms` | 上界，非等待 | 已是轮询式，无需改 |
| 轮询间隔 `25ms` | `wait_for_event` 内部 | 可改为条件变量 |

### 「无事件」断言的根本困难

「确认 P 没有发生」在异步系统里**无法**用纯确定性手段证明 —— 只能等足够久。
这是停机问题的实际变体。

但有三种降级方式：

1. **mock 下变成确定性的**：mock 不主动投递 → 事件数必然为 0，
   不需要等 2000ms，只需「把 mock 的投递入口关掉后跑一遍流程」。
2. **真实 IO 下用「排空到静默」代替固定窗口**：轮询直到连续 N 次（如 3 次）
   25ms 内无新事件，上限仍为 `QUIET_WINDOW`。空载时几十毫秒即返回，
   有事件时退化为原等待。
3. **改为「结构判据」**：例如「unwatch 后 sink 的注册数应为 0」是确定性的，
   比「等 2 秒看有没有事件」更强 —— 但只对部分用例成立。

### 建议的分层策略

| 测试类别 | 等待方式 |
|---|---|
| 状态机（mock） | **零 sleep**。mock 同步投递 → 断言立即可读 |
| 事件投递（真实） | 保留轮询 + 上界；`QUIET_WINDOW` 改为「连续静默即返回」 |
| 性能测试 | 保留（它测的就是时序） |

## 遗留决策（需要你拍板）

### D1：注入缝的返回值形态

`create_file_watcher` 返回 `notify::Result<PlatformWatcher>`，而 `PlatformWatcher` 是
`enum { Native, MacExclusion }`。mock 要进入这条缝，三条路：

| 选项 | 做法 | 代价 |
|---|---|---|
| D1-a | 给 `PlatformWatcher` 加 `#[cfg(test)] Mock(...)` 变体 | 生产类型被测试污染；`match` 处要加 `#[cfg(test)]` 分支 |
| D1-b | 注入缝返回 `Box<dyn Watcher + Send>` | 改生产签名；但 `PlatformWatcher` 的 `set_exclusion_paths` 等**非 trait 方法**需要另行处理 |
| D1-c | 注入缝只在**构造**处，`PlatformWatcher` 保持 enum，mock 通过 `Native` 包装 | 需让 `notify::RecommendedWatcher` 可被替身，实际上不可行 |

**已核实：这两个方法不在状态机测试路径上。**

| 方法 | 唯一调用点 | 状态机测试是否经过 |
|---|---|---|
| `supports_subtree_exclusion()` | `registration/maintenance.rs:89,109` | **否**（那是 `ReloadAll` 规则重载路径） |
| `set_exclusion_paths()` | `registration/maintenance.rs:97` | **否**（同上） |

⇒ 若走 D1-b，只需让注入缝的返回类型满足 `notify::Watcher`；这两个非 trait 方法
可以继续留在 `PlatformWatcher` 上，由**生产路径**独占使用，mock 不实现它们。

**结论：倾向 D1-b**，且已验证不构成阻碍。

### D2：mock 是否走 debounce

若不经过 debounce，测试更快但与生产路径偏离（生产的事件一定过 debounce）。
若经过，则需为 debounce 提供「flush 完成」信号。

**倾向**：mock 提供**两条投递入口** —— `emit_raw()`（直连 sink，用于纯状态机）
与 `emit_via_debounce()`（走真实 debounce，用于验证 debounce 语义的少数用例）。

### D3：`QUIET_WINDOW` 是否改为「连续静默即返回」

改动小、收益明确（空载时 2000ms → ~75ms），但引入新的非确定性
（「连续 N 次静默」的 N 需要论证）。

## 下一步

以上三点确认后，再写 `design.md`（含失败模式覆盖矩阵）与 `implement.md`。
在此之前不改任何代码。
