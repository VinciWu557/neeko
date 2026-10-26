# Implement — fsevent-stream-consolidation

> 配套 `prd.md` + `design.md`。执行顺序按 `design.md §7`：P1 → P2 → P4 → P3。
> 每个阶段独立可验证、可回滚；不要求一次性完成全部阶段。

## 阶段划分与依赖

```
P1 (R1 排序)  ─┐
P2 (R4 日志)  ─┤  相互独立
P4 (R3 护栏)  ─┘
                  ↓
P3 (R2 合并)  ← 依赖 P2 的日志做验证；风险最高，放最后
```

**P3 不在本次实现范围内**，除非 P1/P2/P4 已验证且你明确要求。
理由：P3 改事件来源，是本任务唯一有功能性回滚需求的改动。

---

## P1 — R1 排除集合按成本排序

### 文件

- `src-tauri/src/platform/watch_backend/factory.rs`
- `src-tauri/src/platform/watch_backend/factory.rs` 的 `mod tests`

### 步骤

- [x] 1.1 新增 `exclusion_cost_tier(path: &Path) -> u8`。**实际是 3 档**（非 PRD 的 2 档）：
      tier 0 = `target`/`node_modules`/`DerivedData`/`Pods`；tier 1 = `dist`/`build`/`.next`/
      `.venv`/`__pycache__` 等 12 个；tier 2 = 其余。理由见 `factory.rs:26-44` 与 `design.md §10.3`。
- [x] 1.2 在 `build_exclusion_paths` 内：先 `HashSet` 去重，再按 `(tier, depth, file_name)` 排序。
- [x] 1.3 文档契约已改写为「去重 + 按成本降序」，保留「不新增**忽略判定**语义」的区分。
- [x] 1.4 单测（4 条，已落地）：
  - `exclusion_sort_keeps_heavy_roots_when_truncated`：构造 12 个 ignored_roots，
    顺序打乱（`target`/`node_modules` 放末尾），断言排序后前 8 含二者。
  - `exclusion_sort_is_deterministic`：同一集合两次排序结果逐位相同。
  - `exclusion_sort_preserves_membership`：排序前后集合成员一致（只是顺序变）。
  - `exclusion_sort_ranks_heavy_above_light`：混合 `target` + `some-random-dir`，
    断言 tier 0 在前（**这条才能真暴露排序未生效**）。

  ⚠️ **既有测试会「假通过」（已核实）**：
  `build_exclusion_paths_dedupes_and_preserves_order`（`factory.rs:106-113`）
  用的是 `a = node_modules`、`b = target` —— **两个都是 tier 0**、同 depth，
  按 `file_name` 排序后 `node_modules < target`，结果恰好等于输入顺序 ⇒
  **排序完全未生效时它也 pass**。

  因此**不能靠它转红来证明实现正确**。已按下列三点完成：
  1. [x] 重命名为 `build_exclusion_paths_dedupes`；
  2. [x] 新增 `exclusion_sort_ranks_heavy_above_light` 作为真正的判别测试；
  3. [x] 先写新测试 → RED → 再改实现。

### 验证

```bash
cd src-tauri && cargo test --lib watch_backend
cd src-tauri && cargo clippy --all-targets -- -D warnings
```

### 回滚点

单文件 + 注释，`git revert` 无副作用。

---

## P2 — R4 可观测性日志

### 文件

- `src-tauri/src/platform/watch_backend/factory.rs`（构造成功后）
- 或 `src-tauri/src/platform/watch_backend/macos_fsevent.rs`（`with_exclusions` 内）

### 步骤

- [~] 2.1 打了 `info!`，但**字段不全**：实际是
      `[WatchBackend] fsevents stream: exclusion_roots=<applied>/<requested> truncated=<bool> applied=[...]`，
      **缺 `streams=`**（`macos_fsevent.rs:307`）。多打了 `applied=[...]`（超出 PRD 要求，
      用于回答「`node_modules` 到底排进去没有」）。
- [x] 2.2 既有 `warn!`（`macos_fsevent.rs:289`）保持不动。
- [ ] 2.3 `merged_git_meta=<bool>` **未加进这条日志**。合并状态打在另一条
      （`core.rs:468`，不带 workspace key），两条无法关联到同一挂载。
      见 `design.md §10.2②`。

> P2 按「记录偏差」收口，不继续实施。接手成本约 30min。

### 验证

```bash
cd src-tauri && cargo test --lib watch_backend
# 手工：pnpm tauri dev，挂载一个项目后看日志
# 预期：[WatchBackend] streams=1 exclusion_roots=N/M truncated=<bool>
```

### 回滚点

纯日志，无行为影响。

---

## P4 — R3 测试隔离护栏

### 文件

- 新增 `tools/guards/checks/check_watcher_test_isolation.py`
- `tools/guards/ledger/gates.json`（注册护栏）
- 可能需修 `src-tauri/src/common/file/watcher/**/tests*.rs`

### 步骤

- [x] 4.1 **已核实（由前序任务完成）**：`10-25-watcher-test-decoupling` 实测
      `cargo test --lib` 全量建流数 = **0**（`watch()` 调用计数 0 次）。
      另 `registration/tests.rs` 与 `git_meta/tests/watcher.rs` 均已注入 mock `watch_fn`。
      ⇒ 无需改测试代码，护栏的价值是**防回归**。
- [ ] 4.2 **未写**：`tools/guards/checks/check_watcher_test_isolation.py` 不存在。
- [ ] 4.3 **未注册**：`gates.json` 无该条目。

> P4 整个阶段**未实施**（本任务最大的缺口）。`design.md §10.2①` 记录：
> 缺的是防回归而非缺修复，风险等级低，接手约 1h（仿
> `check_unit_tests_spawn_real_binaries.py` 的结构 + ledger 一行）。

### 验证

```bash
python3 tools/guards/checks/check_watcher_test_isolation.py
pnpm guards list check_watcher_test_isolation
```

### 回滚点

新增文件 + 一行 ledger，删除即回滚。

---

## P3 — R2 流合并（**需单独确认后才做**）

### 前置门禁

- [x] **P3.0 已核实完成**：`.git` **不会**出现在 exclusion 列表中。

  证据链：
  1. `manifest.rs:59-62` — 遍历时遇 `.git` 直接 `continue`，**既不进 `visible_dirs`
     也不进 `ignored_roots`**；
  2. `core.rs:371-373` — exclusion 输入是 `manifest.ignored_roots()`；
  3. ⇒ `.git` 不在 exclusion ⇒ 主 watcher 的递归订阅**会**送达 `.git` 事件。

  **结论：合并可行。** 但实施时仍建议加一条断言测试（把「`.git` ∉ exclusions」
  固化为可执行契约），防止未来 manifest 改动静默破坏此前提。

### 文件

- `src-tauri/src/common/file/watcher/manager/callbacks.rs`（核心改动）
- `src-tauri/src/common/file/watcher/manager/core.rs`（构造 ctx、条件建独立流）
- `src-tauri/src/common/file/watcher/manager/classify.rs`（若需导出判定）
- 新增回滚开关（`factory.rs` 或新模块）

### 步骤（按 `design.md §3.1` 的回调结构）

- [x] 3.1 落地为 `GitMetaCallbacks`（`callbacks.rs:44`，比计划的
      `GitMetaMergeContext` 更窄：只承载三条回调 + paths）。
- [x] 3.2 `build_notify_callback` 第 9 个参数 `git_meta: Option<GitMetaCallbacks>`；
      短路条件为 `p == &ctx.paths.head || p.starts_with(&ctx.paths.git_dir)`
      （`callbacks.rs:96-99`）。**比计划的 `is_under_git` 更严格**：判据是「落在
      该单元的 git_dir 之下」而非「含 `.git` 组件」，否则会把别的单元的 gitdir
      （`<root>/.git/worktrees/other/HEAD`）也放进分类。
- [x] 3.3 语义逐字保持（I3）：`classify_git_meta_event` 仍是唯一判定点（I1 未破）。
- [x] 3.4 `core.rs:466` 的 `head_watcher` 改为条件构造；合并成立 → `None` + 传 ctx。
- [x] 3.5 `NEEKO_DISABLE_GIT_META_MERGE`（`git_meta_merge.rs:30`）独立于
      `NEEKO_DISABLE_FSEVENT_EXCLUSION`。
- [~] 3.6 单测：7 项中 6 项已覆盖，**缺「回滚开关置位 → 仍建独立流」**：
      `.git/objects` → Nothing ✅ / `refs/heads` → RefsChanged ✅ / HEAD ✅ / index ✅ /
      源码路径不进入 git 分类 ✅（`merged_git_meta_does_not_swallow_source_events`）/
      hard-noise 仍丢弃 ✅ / **回滚开关 ❌**（`decide()` 的 env 分支零覆盖，
      见 `design.md §10.2③`）。
  - `.git/objects/ab/cdef` → `Nothing`（不得误判为 refs）
  - `.git/refs/heads/main` → `RefsChanged`
  - `.git/HEAD` → `HeadChanged`
  - `.git/index` → `IndexChanged`
  - 普通源码路径 + ctx 存在 → 不进入 git 分类（短路生效）
  - `.git` 路径命中分类后，**仍被 hard-noise 丢弃**（I2：不得漏进前端事件）
  - 回滚开关置位 → 仍建独立流

### 验证

```bash
cd src-tauri && cargo test --lib watcher      # [x] 123 passed / 1 ignored
cd src-tauri && cargo clippy --all-targets -- -D warnings   # [x] 干净
# [ ] 手工：挂载 N 个项目，lsof -p <pid> | grep -c FSEvents 应从 2N 降到 N
# [ ] 手工：日志应出现 merged_git_meta=true（该字段尚不存在，见 P2 2.3）
# [ ] 手工回归：切分支、暂存、外部 git push 都要触发正确刷新
```

> 三条手工验证**均未执行**（`design.md §10.2④`）。代码层面「合并成立 ⇒ 不建第二条流」
> 是构造性保证，缺的是端到端确认；而 P2 的 `streams=` 字段缺失让确认变得困难
> —— 两个缺口耦合。

### 回滚点

`NEEKO_DISABLE_GIT_META_MERGE=1` 运行时回退；代码层 revert 涉及 3 个文件。

---

## 全阶段完成后的收尾

- [x] `pnpm check:quick` 全绿（10 条护栏 / 0 违规），`cargo clippy --all-targets
      -D warnings` 干净。**未跑** `pnpm check` —— 按 AGENTS.md 硬指令由 pre-push 与 CI 执行。
- [ ] 更新 `.trellis/spec/backend/`：**未做**。`git-domain.md:545` 的
      「一个单元一套资源（worker + file watcher + git-meta watcher）」
      在 macOS 上已被本次改动推翻（仅 Linux 成立），该文件 `:1066` 的目录说明也未提合并。
      这是本任务留下的**最实质技术债**，见 `design.md §10.5`。
- [x] `design.md §9` 的重启窗口风险：已接受（`update_exclusions` 变更集才 `stop()`→`run()`，
      属低频；窗口内丢失的信号由下一次 `git status` 查询覆盖，公理 1）。
- [ ] `python3 ./.trellis/scripts/add_session.py` —— 由归档流程统一执行。

## 实际交付范围（供接手者）

| 阶段 | 状态 | 提交 |
| --- | --- | --- |
| P1 R1 排序 | ✅ 完成 | `e575e590` |
| P2 R4 日志 | ⚠️ 部分（缺 `streams=` / `merged_git_meta=`） | 随 `0eadd1c1` |
| P3 R2 合并 | ✅ 完成（除 env 开关测试） | `0eadd1c1` |
| P4 R3 护栏 | ❌ 未实施 | — |
| R5 截断 warn | ✅ 完成 | 随 `0eadd1c1` |

后续任务划分与成本估算见 `design.md §10.6`。

## 不做什么（防止范围蔓延）

- 不做 `fs_usage` 的 bundle 扫描溯源（PRD 已移交）。
- 不为「降低 CPU」而改 `latency` / flags。
- 不重构 `WatchBackend` 能力位枚举。
- 不把 `git_meta` 合并扩展到 Linux（后端拿不到 `.git` 事件，合并即丢功能）。
