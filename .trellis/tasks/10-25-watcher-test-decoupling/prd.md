# watcher 测试架构重构：状态机语义与真实 IO 解耦

## Goal

把 `WatcherManager` 的测试从「真实 FSEvents 流 + 真实 git 子进程 + 秒级 sleep」中解耦，
使**纯内存状态机**的断言不再触发内核监听，同时保留真正需要端到端验证的那部分。

## 背景：实测证据

### 触发条件

`cargo test --lib watcher::manager::lifecycle_tests` 运行期间：

| 观测 | 数据 |
|---|---|
| fseventsd CPU | **95~99%**（持续整个测试期） |
| 测试结束后 | **0.0%**（立即回落） |
| 对照组 `macos_fsevent` 的 3 个真实流测试 | **0.0%** |
| 串行执行耗时 | **48 秒**（28 个测试） |

### 隔离实验（定位根因）

用独立 Swift 程序直接建流，排除 Rust 侧干扰：

| 场景 | 写入量 | fseventsd CPU |
|---|---|---|
| 27 条流 + 8,700 次写入 | 8,700 | **61%** |
| 1 条流 + 262,286 次写入 | 262,286 | **36%** |
| 27 条流重叠订阅同一父目录 + 218,677 次写入 | 218,677 | **35%** |

**关键推论**：单流写入量是 27 流场景的 30 倍，CPU 反而更低。
⇒ 开销 ∝ **Σ(每条流 × 该流订阅范围内的事件数)**，是乘积不是单一因素。
同一次文件变更被 N 条流的订阅范围覆盖时，fseventsd 要为每条流各做一遍路径处理。

### 测试为何满足这三个条件

1. **27 个测试并发**（`cargo test` 默认按核数并行，本机 10 核）
2. **每个测试建 1-2 条真实 FSEvents 流**（`lifecycle_tests` 有 56 处 `manager.watch`，
   走真实 `create_file_watcher`）
3. **每个测试都在 churn**：`git2::Repository::init` + `commit` + 反复写探针文件

且所有流的订阅根都在 `/var/folders/.../T/` 下 —— 该父目录有 **5257 个条目**。

## 核心问题：测试性质与夹具不匹配

按断言对象分类这 28 个测试：

| 类别 | 数量 | 是否需要真实 FS 事件 | 现状 |
|---|---|---|---|
| 版本号 / 票号语义 | 8 | **否** | 建真实流 |
| 挂载 / 释放编排 | 11 | **否** | 建真实流 |
| git status 查询 | 3 | **否** | 建真实流 |
| 事件投递语义 | 5 | **是** | 建真实流 |
| 性能 | 1 | 是 | 建真实流 |

**23 个（82%）测的是纯内存状态机** —— 版本号单调性、票号吊销、挂载幂等、
快照槽位隔离。这些断言的对象是 `Mutex<HashMap>` 里的状态机，
与「FSEvents 是否真的投递了事件」无关，却被迫付出真实流的代价。

### 时间成本同样来自不匹配

`QUIET_WINDOW = 2000ms` 用于「无事件」断言（必须大于 debounce 上限 1.5s），
全文件引用 **6 处** = **12 秒纯等待**。`WATCH_SETTLE = 300ms` 另有 8 处。

这些等待是为了「确认事件**没有**到达」，只对真实 IO 有意义。
状态机断言根本不需要它们。

### 项目内已有正确先例（不一致）

| 文件 | 做法 | 理由（源码注释） |
|---|---|---|
| `registration/tests.rs` | mock watcher（`FailureWatch`） | 「真实 notify 对不可监听路径的行为三平台不统一，直接断言会 flaky」 |
| `git_meta/watcher.rs` | 注入 `watch_fn` | 「不依赖 notify，失败分支可确定性验证」 |
| `lifecycle_tests.rs` | **真实 watcher** | 「人肉看日志发现，没有 CI 守护就必然回归」 |

第三个理由只对 5 个事件投递测试成立，却被套用到全部 28 个。

## Requirements

### R1 — 测试下沉到它本来该在的层（**取代原「注入缝」方案**）

**分析结论（详见 `design.md §2`）**：`build_notify_callback` 已经是纯函数
（9 个参数全是 channel / trait object / 纯值），返回 `impl FnMut(Result<Event, _>)`，
可直接喂合成事件。但**全仓没有任何测试直接调用它** —— 所有测试都绕道真实 FSEvents。

`poke_status_worker_and_wait`（`core.rs:203-213`）只取 `handle.worker`，与 watcher 无关；
`GitStatusWorker::start` 同样不依赖 watcher。

⇒ **不需要给 `PlatformWatcher` 加 mock 变体，也不需要改 `create_file_watcher` 签名。**
只需让 `WatcherHandle` 能在无 watcher 的情况下构造（`_watcher` 改为 `Option`，
该字段全仓零读取、无 `Drop` 实现，改类型不改语义）。

分层与目标：

| 层 | 内容 | 测试数 | 需真实 FSEvents |
|---|---|---|---|
| A | `build_notify_callback`（合成事件） | 4 + 新增约 6 | 否 |
| D | `WatcherManager` 编排 / 快照 / 票号 | 21 | 否 |
| C | 真实投递 | 3 | **是** |

- 生产路径行为**逐字不变**（`core.rs:625` 仍填 `Some(watcher)`）。

### R2 — 25 个测试改走 A / D 层，删除固定 sleep

覆盖 `design.md §3` 分层表中的 A 层（4 条）与 D 层（21 条）。

- 断言内容**不得弱化**：这些测试守护的是真实缺陷（号段回退、票号误吊销、
  跨单元串味、挂载重复、切走残留），下沉后判据必须等价或更强。
- **必须变异验证**（至少 5 条关键用例）：把被测守卫改坏 → 测试变红 → 恢复后变绿。
- **禁止固定 sleep**：A/D 层测试内不得出现 `std::thread::sleep`。
  同步执行完即结论。

### R3 — 保留 3 个真实投递测试，串行执行

逐条核实断言对象后，真正依赖「事件确实到达」的只有 3 个：
`watch_delivers_file_changed` / `unwatch_stops_delivering_events` /
`edit_to_push_latency_p95_worktree_vs_main`。

（原估的 5 个里，`linked_worktree_edit_...` 与 `external_ref_update_...` 的断言对象
是「快照是否更新」而非「事件是否到达」，可用合成事件覆盖。）

- 这 3 个不得并发执行（`serial_test` 或等价机制）。
- `QUIET_WINDOW` 只保留在这 3 个内，不得被 A/D 层测试继承。

### R4 — 削减重复用例

存在明显重叠的用例需合并（同一不变量的多次表达）：

- `remount_continues_the_unit_version_sequence`
- `pull_after_a_release_still_continues_the_sequence`
- `unmounted_pulls_advance_the_same_registry_sequence`

三者都在验证「version 号段跨挂载周期单调」这一条不变量。合并后应保留
**每个失败模式一条**用例，而非每种操作序列一条。

- 合并必须以「不丢失失败模式覆盖」为判据，不能只按行数削减。

## Non-Goals

- 不改 `WatcherManager` 的生产行为（`watch` / `unwatch` / `mount_only` 语义不变）。
- 不改 `registration/tests.rs`（已正确使用 mock）。
- 不引入新的测试框架或依赖（除非 `serial_test` 是唯一可行方案）。
- 不重构 `WatcherManager` 的其它职责（它已 1046 行，但拆分是独立议题）。

## Acceptance Criteria

- [ ] R1：`WatcherHandle::_watcher` 改 `Option`；生产路径仍填 `Some`（现有 C 层测试证明）。
- [ ] R2：25 个测试下沉到 A/D 层；运行它们时 **fseventsd CPU < 5%**，且测试内**零 `thread::sleep`**。
- [ ] R2：至少 5 条关键用例完成变异验证（改坏守卫 → 变红 → 恢复后变绿）。
- [ ] R3：3 个真实投递测试串行执行；整体测试期间 fseventsd CPU **峰值 < 30%**。
- [ ] R4：合并后的用例数与失败模式覆盖矩阵一并记录在 `design.md`。
- [ ] 整体耗时：`cargo test --lib watcher` 从 48s 降至 **< 15s**。
- [ ] `pnpm check` 全绿（含 clippy 全目标）。

## 移交项（不在本任务范围）

`lifecycle_tests.rs` 有 1642 行、28 个测试。本任务只解决「夹具与断言对象不匹配」，
不承担「文件整体拆分」。若合并后仍 >800 行，另起任务按语义边界拆分文件。

## 已解决的开放问题（见 `design.md`）

1. **注入粒度** → 不需要注入缝。`build_notify_callback` 已是纯函数；
   `poke_status_worker_and_wait` 只依赖 `handle.worker`。
   仅 `_watcher` 需 Option 化（该字段全仓零读取）。
2. **mock 深度** → 直接喂合成 `notify::Event`，不经 mock watcher。
3. **sleep** → A/D 层完全删除；C 层保留（「确认事件没发生」无法纯确定性证明，
   详见 `design.md §5` 的理论边界）。
