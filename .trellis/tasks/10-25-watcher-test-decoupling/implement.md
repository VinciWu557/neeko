# Implement — watcher 测试架构重构

> 配套 `prd.md` + `analysis.md` + `design.md`。
> 执行顺序按 `design.md §7`：P1 → P2 → P5 → P3 → P4。
> 全程**不改生产行为**，只改字段形态（P1）与测试。

## 阶段总览

```
P1 (worker_only 构造器)  ─┐
P2 (A 层回调测试，新增)   ─┤  独立，可并行
P5 (C 层串行化)          ─┘
        ↓
P3 (25 个测试下沉)  ← 依赖 P1
        ↓
P4 (合并重复用例)   ← 依赖 P3 稳定
```

**先做 P2 和 P5**：P2 是纯增量（不改现有测试），P5 立即把 fseventsd 从 100% 压下来。
两者都不依赖 P1。

---

## P1 — `WatcherHandle` 支持无 watcher 构造

### 文件

- `src-tauri/src/common/file/watcher/manager/handle.rs`
- `src-tauri/src/common/file/watcher/manager/core.rs`（构造处填 `Some`）

### 步骤

- [ ] 1.1 `_watcher` 字段改为 `Option<Arc<Mutex<PlatformWatcher>>>`。
      先确认全仓零读取（`grep -rn "\._watcher" src-tauri/src` 应为空）。
- [ ] 1.2 `core.rs:625` 构造处填 `Some(watcher)` —— 生产路径逐字不变。
- [ ] 1.3 新增 `#[cfg(test)] pub(super) fn worker_only(...)` 构造器：
      只需 `worker` / `_debounce` / `_tree_debounce` / `stop_signal`，
      其余字段给最小占位（`_watcher: None`、`_registration: 空`、`_scheduler: None`、
      `mount_ticket: None`、`_head_watcher: None`、`_gitignore: None`、`_heartbeat: None`）。
- [ ] 1.4 回归测试：生产路径的 `watch()` 仍建真实流（现有 C 层测试即可证明）。

### 验证

```bash
cd src-tauri && cargo test --lib watcher
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

### 回滚点

单字段类型 + 一个测试构造器，`git revert` 无副作用。

---

## P2 — A 层回调测试（新增，纯增量）

### 文件

- 新增 `src-tauri/src/common/file/watcher/manager/callback_tests.rs`
- `manager/mod.rs` 加 `#[cfg(test)] mod callback_tests;`

### 步骤

- [ ] 2.1 写夹具：构造 `build_notify_callback` 全部参数（channel + `CollectingSink`），
      **不建任何 watcher**。返回 `(callback, sink, channels)`。
- [ ] 2.2 覆盖以下语义（每条都是同步断言，零 sleep）：

  | 用例 | 喂入 | 断言 |
  |---|---|---|
  | gitignore 过滤 | `Modify(Data)` on `debug.log` | `sink.count(FILE_CHANGED)==0` |
  | hard-noise 丢弃 | `Modify(Data)` on `.git/index`（无 git_meta ctx） | 无事件、无 maintenance 消息 |
  | 正常源码路径 | `Modify(Data)` on `src/main.rs` | `sink.count(FILE_CHANGED)==1` |
  | 结构事件边界保留 | `Create(Folder)` on `target`（ignored 根） | tree-debounce 收到 |
  | 结构事件内部丢弃 | `Create(File)` on `target/x.o` | tree-debounce 不收 |
  | git 元数据分类 | `.git/objects/ab/cd` / `.git/refs/heads/main` / `.git/HEAD` | 分别 Nothing / refs hint / head emit |
  | gitignore 变更 | `Modify(Data)` on `.gitignore` | maintenance 收到 `ReloadAll` |
  | overflow 错误 | `Err(notify::Error)` | `TreeChanged` 且 `dirs` 为空 |

- [ ] 2.3 每个用例必须有 **RED 验证**：临时改坏对应判据（如去掉 `is_hard_noise_path`），
      确认测试变红后恢复。

### 验证

```bash
cd src-tauri && cargo test --lib callback_tests
# 关键：测试期间 fseventsd CPU 必须保持 0%
ps -o %cpu= -p $(pgrep -x fseventsd)
```

### 回滚点

新增文件，删除即回滚。

---

## P5 — C 层 3 个真实投递测试串行化

### 文件

- `src-tauri/src/common/file/watcher/manager/lifecycle_tests.rs`

### 步骤

- [ ] 5.1 给 `watch_delivers_file_changed` / `unwatch_stops_delivering_events` /
      `edit_to_push_latency_p95_worktree_vs_main` 加串行标记。
      优先用 `serial_test` crate；若不想加依赖，用进程级 `Mutex` 守卫（已有先例可查）。
- [ ] 5.2 在文件头注释里说明**为什么**这 3 个必须串行
      （27 条并发流会让 fseventsd 达到 95%+，实测数据见 `prd.md`）。

### 验证

```bash
cd src-tauri && cargo test --lib watcher
# 测试期间 fseventsd CPU 峰值应 < 30%
```

### 回滚点

属性标注 + 注释，删除即回滚。

---

## P3 — 25 个测试从 C 层下沉

### 前置

- P1 完成（`worker_only` 可用）。

### 文件

- `src-tauri/src/common/file/watcher/manager/lifecycle_tests.rs`

### 步骤

按 `design.md §3` 的分层表逐条迁移：

- [ ] 3.1 **A 层（4 条）**：`#5 #12 #14 #28` —— 用 P2 的夹具喂合成事件，
      断言 sink / 快照。
- [ ] 3.2 **D 层（21 条）**：用 `worker_only` 构造 handle，直接驱动
      `poke_status_worker_and_wait` / `snapshot` / 票号 API。
      **删除全部 `WATCH_SETTLE` / `QUIET_WINDOW`**。
- [ ] 3.3 每迁一条，跑一次 `cargo test --lib <name>` 确认绿。
      批量迁移后一次性 RED 验证会失去定位能力。
- [ ] 3.4 迁移完成后，**对 5 条关键用例做变异验证**：

  | 用例 | 改坏什么 | 期望 |
  |---|---|---|
  | 重复挂载 | 删 `watchers.contains_key` 检查 | 变红 |
  | 票号误吊销 | `release_one` 去掉 compare-and-remove | 变红 |
  | 快照跨单元串味 | `snapshot` 按 project 而非 workspace 查 | 变红 |
  | 号段回退 | `release` 时清 `version_floors` | 变红 |
  | 切走残留 | 删 `drop_snapshot_if_present` | 变红 |

### 验证

```bash
cd src-tauri && cargo test --lib watcher
# 耗时目标：< 15s（当前 48s）
```

### 回滚点

测试文件改动，`git revert` 恢复。

---

## P4 — 合并重复用例

### 前置

- P3 完成且稳定（覆盖矩阵已核对）。

### 步骤

- [ ] 4.1 按 `design.md §6` 的失败模式矩阵合并。
      **判据是「不丢失败模式」，不是「减少行数」。**
- [ ] 4.2 重点合并号段类三兄弟（`#20 #21 #22`）为一条参数化用例，
      覆盖「重挂载 / 释放后 / 未挂载 pull」三种序列。
- [ ] 4.3 合并后重跑 4.1 的变异验证，确认覆盖未退化。

### 验证

```bash
cd src-tauri && cargo test --lib watcher
```

---

## 收尾

- [ ] `pnpm check`（全量门禁）
- [ ] 更新 `.trellis/spec/backend/` 与 `.trellis/spec/unit-test/`：
      记录「测试按 A/B/C/D 分层」「单元测试禁止固定 sleep」两条约定。
- [ ] 记录实测对比：测试耗时、fseventsd CPU 峰值（修复前后）。
- [ ] `python3 ./.trellis/scripts/add_session.py`

## 不做什么

- 不给 `PlatformWatcher` 加 mock 变体。
- 不改 `create_file_watcher` 签名。
- 不改 C 层 `QUIET_WINDOW` 的窗口策略（缩短需单独论证）。
- 不拆 `lifecycle_tests.rs` 文件本身。
