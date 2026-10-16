# Implement — 本地门禁并发与前端测试环境开销优化

> 任务：`.trellis/tasks/10-16-guard-local-wall-clock`（PRD / design 见同目录）。
> 实施范围：R1（`--jobs auto` 并发派生）、R2（jsdom → node 迁移）、R3（文档同步）。

---

## R1 · `pnpm check` 接入并发

### 改动

| 文件 | 改动 |
| --- | --- |
| `tools/guards/core/platform.py` | 新增 `JOBS_AUTO` / `JOBS_CAP` 常量、`default_jobs()`、`resolve_jobs()` |
| `tools/guards/core/cli.py` | `_positive_int` → `_jobs_value`（接受 `auto`）；`--jobs` 的 `type` 换新；`main` 里 `jobs=platform.resolve_jobs(args.jobs)` |
| `package.json` | `check` = `python3 tools/guards/run.py run --stage local --jobs auto` |
| `tools/guards/tests/test_platform.py` | 新增：派生函数与解析函数的单测（6 条） |
| `tools/guards/tests/test_cli.py` | 新增：`--jobs auto` 派生、显式 `--jobs 3` 不被覆盖（2 条） |

### 契约保持（design §2.1）

- `--jobs` 的 `default=1` **未改**，`runner.execute(jobs=...)` 收到的仍是 `int`。
- `test_cli.py::test_defaults_are_the_unfiltered_sequential_form` **一字未改，仍绿**
  （已单跑确认）。
- `auto` 是**显式取值**，不是新默认值：`commit` 档 / `--only` / `--staged` 的调用方
  不传 `--jobs`，行为不变。

### 派生规则

```
default_jobs() = min(cpu_count, 4)  if cpu_count >= 4  else 1
```

- 上限 4：长杆 `test_fe` 自带 vitest 6 worker，更高的门禁并发只放大竞争衰减。
- CPU < 4 退回 1（并发无收益）。
- `os.cpu_count()` 返回 `None` 时按 1 核兜底（不炸）。
- 本机实测 `os.cpu_count() == 10` → `default_jobs() == 4`。

### Red / Green 证据

Red（实现前，仅加测试）：

```
$ PYTHONPATH=tools python3 -m unittest guards.tests.test_platform guards.tests.test_cli
ERROR: test_platform ... ModuleNotFoundError / AttributeError: 'platform' has no attribute 'default_jobs'
ERROR: guards.tests.test_cli.RunCommandTest.test_jobs_auto_is_resolved_by_the_framework
Ran 29 tests ... FAILED (errors=8)
```

Green（实现后）：

```
$ PYTHONPATH=tools python3 -m unittest guards.tests.test_platform guards.tests.test_cli
Ran 29 tests in 0.007s
OK
```

护栏框架自检（含全部 565 条）：

```
Ran 565 tests in 3.106s
OK
```

### AC2 核对

- `--jobs auto` 生效：`pnpm check` 日志中 `lint_fe` 与 `test_fe` 重叠执行（并发）。
- `--jobs 3` 仍生效：`test_explicit_jobs_is_not_overridden_by_the_auto_default` 绿。
- `test_defaults_are_the_unfiltered_sequential_form` 不改仍绿。

### AC3 核对

派生逻辑在 `tools/guards/core/platform.py::default_jobs`（框架内），调用方只写
`--jobs auto`；`package.json` 无 shell 表达式（Windows 可移植）。
`lefthook pre-push` 仍用 `--jobs 4`，可随时改成 `--jobs auto` 复用同一条派生。

---

## R2 · jsdom → node 迁移

### 结果

- 静态判据圈出 **28** 个候选（脚本见 PRD）。
- 实测后 **24 个迁移成功**、**4 个回退**。
- jsdom 文件数：362 → **338**；node 文件数：190 → **214**（`// @vitest-environment node`
  首行 docblock 计数，不含 `src/testing/setup.ts` 的注释提及）。

### 回退清单（传递性 DOM 依赖，node 环境必红）

| 文件 | 失败信号 | 传递依赖 |
| --- | --- | --- |
| `src/features/lsp/hooks/__tests__/lspHoverRouting.test.ts` | `ReferenceError: document is not defined` | `lspHoverExtension.ts` → `modKeyState.ts` 顶层 `document.addEventListener` |
| `src/features/editor/translation/__tests__/blocks.test.ts` | `ReferenceError: DOMParser is not defined` | `blocks.ts` 用 `new DOMParser()` |
| `src/features/runner/utils/__tests__/testResultParsers.test.ts` | 断言空结果（`DOMParser` 缺失静默降级） | `testResultParsers.ts` 的 XML 解析用 `DOMParser` |
| `src/shared/utils/__tests__/shortcutRegistry.test.ts` | `ReferenceError: KeyboardEvent is not defined` | 测试自身 `new KeyboardEvent(...)`（静态判据未收录该全局） |

回退手法：删除首行 docblock，回到默认 jsdom，**不改任何代码**。

### 成功迁移（24 个）

```
src/features/notification/__tests__/reflow.test.ts
src/features/runner/languages/rust/__tests__/commands.test.ts
src/features/terminal/api/__tests__/taskTerminal.test.ts
src/features/lsp/transport/__tests__/lspCompletionProbe.test.ts
src/features/lsp/transport/__tests__/tauriLspTransport.test.ts
src/features/lsp/utils/__tests__/diagnosticGroups.test.ts
src/features/lsp/components/__tests__/diagnosticCode.test.ts
src/features/lsp/api/__tests__/documentOwnership.test.ts
src/features/project/utils/__tests__/groupProjects.test.ts
src/features/task/__tests__/taskStore.console.test.ts
src/features/task/__tests__/taskRunner.test.ts
src/features/editor/__tests__/breadcrumb.test.ts
src/features/git/utils/__tests__/prDisplay.test.ts
src/features/git/api/__tests__/gitConsoleRun.test.ts
src/shared/utils/__tests__/tagColors.test.ts
src/shared/utils/__tests__/retryBudget.test.ts
src/shared/utils/__tests__/scrollMemory.test.ts
src/shared/utils/__tests__/workspaceSession.test.ts
src/shared/utils/__tests__/workspaceRef.test.ts
src/shared/utils/__tests__/promptQuery.test.ts
src/shared/utils/__tests__/drainLoop.test.ts
src/shared/store/__tests__/taskStore.runRoot.test.ts
src/shared/store/__tests__/taskStore.gitConsole.test.ts
src/testing/__tests__/timers.test.ts
```

### AC4 核对

- 迁移后在 **node 环境真跑过**：先整体跑（暴露 4 个红），回退 4 个后 `pnpm test:fe` 全绿。
- `pnpm test:fe`：**552 文件 / 4841 用例全过**，无用例被跳过或弱化（只加了一行 docblock）。
- `pnpm lint:fe` exit 0（新增 docblock 不影响 eslint / tsc）。

---

## R3 · 文档同步

| 文件 | 改动 |
| --- | --- |
| `.trellis/spec/frontend/quality-guidelines.md` | 「质量门禁」段：`pnpm check` 标注 `--jobs auto`，新增引用块解释并发派生（`min(cpu_count, 4)`）、上限理由、默认值仍为串行的契约 |
| `.trellis/spec/unit-test/frontend-testing.md` | 「node vs jsdom」段：新增「如何判断某个文件该不该迁到 node」四步（静态圈候选 → 候选只是候选 → 逐个实测 → `renderHook` 永不能迁） |

`check_script_references` / `check_gate_topology` / `check_agents_md_size` 对改动后的
spec 仍绿（见 AC5 全量运行）。

---

## AC5 / AC1 · 全量门禁与墙钟

### 30 条护栏全绿

```
$ pnpm check        # exit 0
30 条护栏：30 通过 / 0 违规 / 0 护栏失效 / 0 条跳过
```

### 墙钟对比（本机 10 核）

**空载窗口（load avg ~3.9，AC1 判定用）**：

| 运行 | 墙钟 | test_fe | lint_fe | test_rust |
| --- | --- | --- | --- | --- |
| 串行 `--jobs 1` | **135s** | 89.4s | 6.1s | 30.6s |
| 并发 `--jobs auto` | **82s** ✅ | 75.9s | 11.0s | 28.7s |

**→ 降幅 39%（135s → 82s），AC1 达成（≤100s）。**

**高负载窗口（load avg ~13，另一时段）**：

| 运行 | 墙钟 | test_fe | lint_fe | test_rust |
| --- | --- | --- | --- | --- |
| 串行 `--jobs 1` | 160s | 112.4s | 8.5s | 29.2s |
| 并发 `--jobs auto` | 115–125s | 109–119s | 22–30s | 47–58s |
| 单独 `pnpm test:fe` | 116s | 114.8s | — | — |

**结构性结论（与 design 一致）**：并发后 `pnpm check` 墙钟 ≈ `test_fe` 单项耗时 ——
短门禁已被藏进长杆的影子。空载下 82s vs 单跑 test_fe 76s；高负载下 115s vs 单跑 116s，
两种负载下都验证了「墙钟收敛到 `test_fe` 地板」。

### AC1 判定

- **空载窗口实测 82s ≤ 100s ✅**（对比串行 135s，降幅 39%，优于 PRD 预期的 33%）。
- 机器负载会整体拉高两个数字，但**并发相对串行的降幅在两种负载下都成立**
  （空载 39% / 高负载 28%），且并发墙钟恒 ≈ `test_fe` 单项耗时。
- `test_fe` 是并发后的唯一地板（PRD §1.1 已论证）；地板不降时 `pnpm check` 无法更快。

### 不违反 Non-Goals

- `maxWorkers` 未动（`vitest.config.ts` 仍为 6）。
- 未动 `isolate` / `pool`。
- `check` 未加 `--changed`。
- `check` 与 `guards run --stage local` 的别名关系保留（只是加了 `--jobs auto`）。

---

## 偏差与发现

1. **机器负载显著影响绝对秒数**：同一实现，空载 82s / 高负载 115–125s。
   并发相对串行的降幅（39% / 28%）与 design §1 的预期一致，且墙钟恒收敛到
   `test_fe` 地板 —— 即本轮优化的结构目标已达成。
2. **静态判据的漏网全局**：`KeyboardEvent` 不在 PRD 给的候选脚本正则里，导致
   `shortcutRegistry.test.ts` 被误圈（实测红后回退）。若后续再跑该脚本筛选，
   建议把 `KeyboardEvent` / `DOMParser` / `MutationObserver` 等 Web 全局一并加入排除项。
3. **`--jobs auto` 与任何现有测试无冲突**：`test_defaults_are_the_unfiltered_sequential_form`
   只断言不传 `--jobs` 时默认 1，与 `auto` 取值正交。

---

## 变更文件清单

框架 / 配置：
- `tools/guards/core/platform.py`
- `tools/guards/core/cli.py`
- `tools/guards/tests/test_platform.py`（新增）
- `tools/guards/tests/test_cli.py`
- `package.json`

测试 docblock（24 个新增 + 4 个回退后归零）：见 R2「成功迁移」清单。

文档：
- `.trellis/spec/frontend/quality-guidelines.md`
- `.trellis/spec/unit-test/frontend-testing.md`
