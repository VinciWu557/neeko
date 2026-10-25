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

- [ ] 1.1 新增 `exclusion_cost_tier(path: &Path) -> u8`（tier 0 = 已知高成本目录名，
      tier 1 = 其余）。目录名常量表放在函数旁，附注释说明「这是启发式，不是忽略判定」。
- [ ] 1.2 在 `build_exclusion_paths` 内：先 `HashSet` 去重（保持现有逻辑），
      再按 `(tier, depth, file_name)` 排序。
      **depth 定义**：`path.components().count()`。
- [ ] 1.3 更新 `build_exclusion_paths` 的文档契约：
      旧「去重 + 保序，不新增判定语义」→ 新「去重 + 按成本降序（保证截断保留高成本子树）」，
      并明确「不新增**忽略判定**语义」这半句仍成立（哪些路径被排除不变）。
- [ ] 1.4 单测（TDD，先写再实现）：
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

  因此**不能靠它转红来证明实现正确**。必须：
  1. 重命名为 `build_exclusion_paths_dedupes`（去掉「preserves order」这个已失真的名字）；
  2. 新增上面 `exclusion_sort_ranks_heavy_above_light` 作为真正的判别测试；
  3. 先写新测试 → 确认 RED（旧实现下 tier 0 不在前）→ 再改实现。

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

- [ ] 2.1 在 `with_exclusions` 成功构造后打一条 `info!`：
      `streams=1 exclusion_roots=<applied>/<requested> truncated=<bool>`
- [ ] 2.2 保持既有 `warn!`（`macos_fsevent.rs:265`）不动 —— 它是截断的告警，
      与新增的 info 不重复（一个在超限时警告，一个在每次构造时记录事实）。
- [ ] 2.3 合并场景预留 `merged_git_meta=<bool>` 字段（P3 才填值，P2 先填 `false`）。
      **不要**在 P2 就写 `merged_git_meta=true`（尚无合并逻辑，日志会撒谎）。

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

- [ ] 4.1 **先核实**：`cargo test --lib` 运行时用
      `lsof -p <test-pid> | grep -c FSEvents` 观察是否真的建流。
      若确认测试已全部隔离，护栏仍要加（防回归），但无需改测试代码。
- [ ] 4.2 写护栏：扫描 `src-tauri/src/**/*.rs` 中含 `#[cfg(test)]` 或文件名含 `tests` 的
      文件，检测：
      - `env!("CARGO_MANIFEST_DIR")` / `env!("CARGO_WORKSPACE_DIR")` 作为 `watch()` 参数
      - `current_dir()` 直接 `watch()`
      - 硬编码的仓库根路径字符串
      豁免机制：`tools/guards/ledger/watcher_test_isolation.json` 台账。
- [ ] 4.3 在 `gates.json` 注册，并接 `pnpm lint`（**不是** `check:quick` —— 它扫 Rust，
      属全量档）。

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

- [ ] 3.1 定义 `GitMetaMergeContext { paths: GitMetaPaths, on_index/head/refs: ... }`，
      承载三条既有回调闭包的等价物。
- [ ] 3.2 `build_notify_callback` 入参增加 `Option<GitMetaMergeContext>`。
      **先短路**：`if ctx.is_some() && event.paths.iter().any(|p| is_under_git(p))`
      才进入分类，避免对每个源码事件跑三次 `Path` 比较（`design.md §9` 的警告）。
- [ ] 3.3 分类命中后投递到既有出口，**语义逐字保持**（I3）：
      index/refs → 只发 scheduler hint；head → hint + `emit(GitChanged)`。
- [ ] 3.4 `core.rs` 的 `head_watcher` 构造改为条件：
      合并可行（自检通过）→ `None` + 传 ctx；否则保留现状独立流 + `warn!`。
- [ ] 3.5 新增回滚开关 `NEEKO_DISABLE_GIT_META_MERGE=1`（**独立于**
      `NEEKO_DISABLE_FSEVENT_EXCLUSION`，理由见 `design.md §8`）。
- [ ] 3.6 单测（这是 P3 的主要风险区）：
  - `.git/objects/ab/cdef` → `Nothing`（不得误判为 refs）
  - `.git/refs/heads/main` → `RefsChanged`
  - `.git/HEAD` → `HeadChanged`
  - `.git/index` → `IndexChanged`
  - 普通源码路径 + ctx 存在 → 不进入 git 分类（短路生效）
  - `.git` 路径命中分类后，**仍被 hard-noise 丢弃**（I2：不得漏进前端事件）
  - 回滚开关置位 → 仍建独立流

### 验证

```bash
cd src-tauri && cargo test --lib watcher
cd src-tauri && cargo clippy --all-targets -- -D warnings
# 手工：挂载 N 个项目，lsof -p <pid> | grep -c FSEvents 应从 2N 降到 N
#      日志应出现 merged_git_meta=true
# 手工回归：切分支、暂存、外部 git push 都要触发正确刷新
```

### 回滚点

`NEEKO_DISABLE_GIT_META_MERGE=1` 运行时回退；代码层 revert 涉及 3 个文件。

---

## 全阶段完成后的收尾

- [ ] `pnpm check`（全量门禁，含 Rust clippy 全目标）
- [ ] 更新 `.trellis/spec/backend/` 下与 watcher 相关的文档：
      记录「macOS 上 `.git` 由主 watcher 覆盖」这一事实，
      以及「R1 排序改变了 `build_exclusion_paths` 的保序契约」。
- [ ] 若 P3 完成：更新 `design.md §9` 的「未解决」项（重启窗口风险已被接受并观测）。
- [ ] `python3 ./.trellis/scripts/add_session.py`

## 不做什么（防止范围蔓延）

- 不做 `fs_usage` 的 bundle 扫描溯源（PRD 已移交）。
- 不为「降低 CPU」而改 `latency` / flags。
- 不重构 `WatchBackend` 能力位枚举。
- 不把 `git_meta` 合并扩展到 Linux（后端拿不到 `.git` 事件，合并即丢功能）。
