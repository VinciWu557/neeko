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

---

## R4 · `pnpm check:quick`（追加需求，方案 A）

### 定位（第一性原理）

`check:quick` 是**快速反馈**，不是门禁。判据与 CI **刻意不同**（用 `vitest related` 的
import 图反推换取速度），因此结果不能作为提交 / 合并依据。判据不同的东西不该叫同一个
名字 —— 否则「门禁」同时表示强/弱两种含义，本地「绿」不再构成 CI「绿」的证据。

选方案 A（独立脚本）而非给 gate 加 `preview_argv`：框架的 gate 把判据写死在
`gates.json` 的静态 `argv` 里，而 `check:quick` 的命令行必须按改动集动态拼；加预览语义
会引入占位符替换 + `check_gate_topology` 新增「preview 不得进 CI」判据 —— 为一件事付
两份复杂度。独立脚本对框架只有一处依赖（`repo.find_repo_root`），耦合最低。

### 改动

| 文件 | 改动 |
| --- | --- |
| `tools/guards/core/quick.py` | 新增：计划构造（`plan`）、改动集读取（`changed_files`）、步骤执行（`run_step`）、CLI（`main`） |
| `tools/guards/quick.py` | 新增：薄启动器（与 `run.py` 同构，`sys.path` 注入 + 调 `guards.core.quick.main`） |
| `tools/guards/tests/test_quick.py` | 新增：25 条单测 |
| `tools/guards/core/runner.py` | 把框架规则提为公开谓词 `touches_framework()`（`_apply_framework_rule` 改为调用它）—— `check:quick` 与门禁增量跳过对「什么算框架改动」必须判得一致，规则只写一处 |
| `package.json` | 新增 `check:quick` |
| `AGENTS.md` | Development Commands 段加一行（含「不是门禁」的标注） |
| `.trellis/spec/frontend/quality-guidelines.md` | 「质量门禁」段：定位、前后端覆盖面、`vitest related` 盲区、静默绿防线 |

### 覆盖面（前后端能力不对称 —— 客观事实，不是设计偷懒）

| 改动 | 检查 | 依据 |
| --- | --- | --- |
| `.ts` / `.tsx` | `pnpm exec eslint <files> --cache` | eslint 原生收文件列表 |
| `.ts` / `.tsx` | `pnpm exec tsc --noEmit`（全量） | 类型检查是全局语义，塞改动路径是假精确 |
| `.ts` / `.tsx` | `pnpm exec vitest related <files>` | vitest 原生按 import 图反推 |
| `.rs` | `rustfmt --edition 2021 --check <files>` | 原生收文件列表，且跟随 `mod` 递归 |

**后端不做 clippy / cargo test**：两者最小粒度都是整个 crate（Rust 无 import 图，无法从
改动文件反推该跑哪些测试）。脚本每次都在输出里声明这条缺口。

### 实测

| 场景 | 耗时 |
| --- | --- |
| 前端 1 文件改动（+框架文件）3 步 | **17.9s**（vs 全量 `test_fe` 82–132s） |
| 后端改动 1 步（rustfmt） | **0.67s** |
| 前端+后端混合 4 步 | 全绿 |

### 静默绿防线（本仓库反复踩的失效模式）

`vitest related` 在「无相关测试」时**退出码仍是 0**，只打印 `No test files found`。
`run_step` 显式识别该标记并判**失败**（并改写原文里那句会误导人的 "exiting with code 0"）。
同理：无改动 / 改动不在覆盖范围时打印明确的「跳过」而非静默 exit 0。

### Red / Green 证据

```
$ PYTHONPATH=tools python3 -m unittest guards.tests.test_quick
Ran 25 tests in 0.006s
OK

$ python3 -m unittest discover -s tools/guards/tests -t tools -p 'test_*.py'
Ran 595 tests in 2.918s
OK        # R1 的 565 → +30（其中 25 条为本节新增）

$ pnpm check                                 # exit 0
30 条护栏：30 通过 / 0 违规 / 0 护栏失效 / 0 条跳过
```

单测**不真实调用** eslint / vitest / rustfmt（决策逻辑与进程调用分离，测试总耗时 0.01s）——
这是 `check_gate_topology` A5 事故（护栏读真实文件 → 夹具缺文件 → 20 条 ERROR）的直接教训。

### 一处设计取舍

`RUST_EDITION` 在 `quick.py` 里是**字面量 2021**，刻意不解析 `src-tauri/Cargo.toml`：
那会为一个字符串引入 TOML 解析。代价是 edition 升级时要记得改这里 —— 但失效模式很轻
（会与门禁的 `cargo fmt` 报出不同格式），且本模块结果本就不构成判定依据。已在代码注释写明。

---

## R5 · check:quick 的审核修复（2 Block / 2 Warning / 3 Nit）

`/neeko-check` 增量审核（8 文件）的修复。两个 Block 是**同一个根因**，故一并根治。

### 根因（第一性原理）

`run_step` 是一个**漏抽象的执行原语** —— 它不建模执行上下文。跑一条外部命令只有三个
可变参数：**在哪跑**（cwd）、**等多久**（timeout）、**谁在跑**（argv）。框架的 `_run_gate`
三样都建模了，`run_step` 一样都没建模。

所以修复不是给 `run_step` 补三个参数 —— 那会把 `_kill_tree` 的**平台相关**逻辑
（POSIX `killpg` / Windows `proc.kill()`）抄成第二份并漂移，而它的失效模式很隐蔽：
超时后孙进程存活，门禁「看起来超时了」，实际还在占 CPU / 端口。

**正解**：把这个物理事实抽成公开原语 `core/proc.py::run()`，`runner` 与 `quick` 共用。

### 改动

| 项 | 处置 |
| --- | --- |
| **[Block] `run_step` 不传 cwd** | `proc.run(step.argv, cwd=root, ...)` —— 从任意子目录调用现在正确（实测从 `src/` 下由「全红」变全绿） |
| **[Block] 无超时 / spawn 失败崩栈** | 统一由 `proc.run` 收口为 `TIMED_OUT` / `SPAWN_FAILED` 两种 `kind`，不再抛异常；新增退出码 **2**（工具/环境问题）与 1（代码问题）区分 |
| **[Warning] 函数内延迟 import** | 提到模块顶部（实测无循环依赖，`runner` 不 import `quick`） |
| **[Warning] 覆盖面硬编码** | 保留两条显式分支（YAGNI：第三语言不存在），但**显式注释**「真要加第三种语言时改表驱动是机械替换」；`Step.kind` 已是稳定分派键 |
| **[Nit] `dict` 当去重集合** | 改 `sorted({...})` |
| **[Nit] 测试靠 title 子串** | `Step` 加稳定 `kind` 字段，测试全改按 `kind` 定位，不再按展示文案 |
| **[Nit] 红线 13 边界** | 审核判定为**不违规**（`/repo` 只进被 mock 的 `cwd`，无 `Path` 语义），未改动 |

### 新增文件 / 测试

| 文件 | 内容 |
| --- | --- |
| `tools/guards/core/proc.py` | 新公开原语：`run()` + `Result(kind, output, returncode, detail)` |
| `tools/guards/tests/test_proc.py` | 9 条：三种终局、超时前输出保留、cwd 生效、**POSIX 孙进程清场** |
| `tools/guards/tests/test_quick.py` | 25 → 33 条：新增 6 条**真实子进程**用例（cwd / 超时 / 工具缺失 / 静默绿标记） |

`runner.py` 的 `_kill_tree` 与 `subprocess.Popen` 调用被删除，改为复用 `proc.run` ——
平台相关逻辑回到单份实现。`test_runner.py::test_timeout_kills_the_whole_process_group`
仍绿（证明迁移前后行为等价）。

### 变异验证（证明新测试真能捕获旧 bug）

```
$ # 把 run_step 的 cwd 拿掉
FAIL: test_step_runs_in_the_given_root_not_the_process_cwd
Ran 33 tests ... FAILED (failures=1)
```

### 实测

| 场景 | 结果 |
| --- | --- |
| 从 `src/` 子目录跑（原 Block 场景） | **全绿**（修复前：eslint + vitest 全红，exit 1） |
| 超时（200ms 上限，命令 sleep 30s） | 0.20s 精确终止，`unavailable=True`，退出码 2 |
| 工具缺失（不存在的二进制） | `unavailable=True`，退出码 2（不再抛 `FileNotFoundError`） |
| 前端 1 文件改动 | 15.4s |
| 后端改动 | 0.70s |

```
$ python3 -m unittest discover -s tools/guards/tests -t tools -p 'test_*.py'
Ran 612 tests in 5.020s
OK        # R4 的 595 → +17（9 条 proc + 8 条 quick 净增）

$ pnpm check
30 条护栏：30 通过 / 0 违规 / 0 护栏失效 / 0 条跳过      # 1m35s
```

### 一处设计取舍

`proc.run` 返回的是 `kind`（**发生了什么**）而非「成功/失败」—— 因为「什么算通过」是
**判据**，属于调用方：门禁看退出码 + 平台，`quick` 还要额外识别 vitest 的
「无相关测试」标记。原语只报告事实，判据留给各自，这正是两边能共用同一份执行逻辑
却不互相污染的原因。

---

## R6 · check:quick 定位修正（用户反馈）——「轻量档」而非「只查改动文件」

### 我原先的定位错误

我把 `check:quick` 的身份定义成**「只针对改动文件」**，于是一路推导出：
`eslint <改动文件>` / `tsc --noEmit` 全量 / `rustfmt --check <改动文件>` / `vitest related <改动>`。
**这个身份是错的** —— 它把「改动集」当成了命令的边界，而改动集其实只是「单元测试」这一项
需要的机制。

正确身份：**延迟预算内的轻量检查**。判据是「会不会让人等」，不是「是不是改动文件」。

这条原则本仓库**早已写明**（`lefthook.yml` 文件头）：

> 阶段边界按**延迟预算**划，不按语言划：commit 是快静态检查……push 是全目标静态检查 +
> 三套分钟级门禁……CI 是三平台终审。

### 由此暴露的两个具体错误

**错误 1（更严重）：自造了一份与 `gates.json` 重复的 lint 清单。**
`quick.py` 里硬编码 `eslint` / `tsc` / `lint:rust:all-targets`。而框架的 `kind=lint` 就是
「静态检查」这个概念的**唯一定义点** —— `runner.execute(stage="local", suite="lint")`
已经选出全部静态检查门禁。自造清单的代价是**静默漂移**：将来新增一条 lint 门禁
（比如为 CSS 加一条），`pnpm check` 会跑、`check:quick` 不会，且没人会知道。

**错误 2：把 clippy 当成「重量级」排除掉了。** 实测改 `.rs` 后
`cargo fmt + clippy --all-targets` 只要 **4.4s**，比前端 `tsc --noEmit` 全量（~6s）还快。
用户指出「clippy 属于静态检查」是对的 —— 我原先只跑 `rustfmt --check <files>`，
是同一件事的弱化版（会漏掉改动引入的跨文件错误）。

### 修正后的结构

```
check:quick
  ├─ 静态检查 → runner.execute(stage="local", suite="lint")   ← 复用框架，清单零重复
  └─ 改动文件的单元测试（框架表达不了这两条，才留在这里）
       ├─ .ts/.tsx  → vitest related <files>
       ├─ java-host → pnpm test:host（1.4s）
       └─ .rs       → 不做，输出声明缺口（Rust 无 import 图）
```

`run_static_checks()` 一行清单都没有 —— 它只表达「跑框架的 lint 档」这个意图。
新增 lint 门禁自动纳入，`--changed` 透传给框架按 scope 过滤（框架自身的改动规则也随之生效）。

### 回归防线

新增测试 `test_no_lint_command_is_hardcoded_in_this_module`：断言 `quick.py` 源码里
不出现 `eslint` / `tsc` / `clippy` / `lint:rust` / `lint:fe` 作为命令字面量。
—— 这类「重复清单」的失效模式是静默的，只能靠测试钉住。

### 实测（修正后）

| 场景 | 耗时 | 内容 |
| --- | --- | --- |
| 纯文档改动 | 13.9s | 静态检查 27 条 + lint_fe + lint_rust（无测试步骤） |
| 前端 1 文件改动 | 26.7s | 静态检查 + `vitest related` |
| 后端 1 文件改动 | 16.0s | 静态检查（含 clippy）+ 声明 `cargo test` 缺口 |
| 对照：全量 `pnpm check` | 1m55s | 含全量测试 |

### 一处测试设计教训

`MainTest._main` 里 `mock.patch.object(...).start()` 的返回值**不是** patcher ——
它上面的 `.stop()` 是 Mock 自动生成的子 mock，调用它不会撤销补丁，于是 Mock 泄漏给
后续测试类（实测 4 条测试被污染）。必须保存 patcher 本身
（`p = mock.patch.object(...); p.start(); addCleanup(p.stop)`）。
用 `unittest tests` 的正序与反序各跑一次才能发现这类顺序依赖。

---

## R7 · 排除 `test:host`（用户判定为重量级）

### 改动

`tools/guards/core/quick.py`：删除 `JAVA_HOST_TEST` 常量与 `java_host_tests` 步骤，
改为 `JAVA_HOST_TEST_GAP` 缺口声明。

### 为什么必须「声明缺口」而不是「静默跳过」

`tools/java-host/**` 的**唯一**门禁就是 `test_host` / `build_host`（两者都是 `kind=test`）。
实测确认：排除 `test:host` 后，该目录的改动在 lint 档里**没有任何检查覆盖** ——

```
$ python3 tools/guards/run.py run --stage local --suite lint --changed tools/java-host/test/Foo.java
stage=local：本次改动未触及任何护栏的 scope，跳过。
```

所以若静默跳过，一个实际零覆盖的改动会显示为「绿」。这与本仓库反复踩的静默绿失效模式
（`GuardResult.broken` 的设计意图、`vitest related` 的 "No test files found"）是同一类，
故与 Rust 缺口同构处理。

### 最终形态

```
check:quick
  ├─ 静态检查 → runner.execute(stage="local", suite="lint")   ← 复用框架，清单零重复
  └─ 改动文件的单元测试
       └─ .ts/.tsx → vitest related <files>
  缺口声明（不静默跳过）
       ├─ .rs              → 不跑 cargo test（无 import 图，crate 粒度）
       └─ tools/java-host/ → 不跑 test:host（重量级，且是该目录唯一门禁）
```

### 回归防线

新增测试 `test_no_heavy_gate_is_invoked_from_this_module`：断言 `quick.py` 源码里
不出现 `test:host` / `test:fe` / `test:rust` / `cargo` / `build:host` 作为命令字面量。
最终 `quick.py` 里只剩一个命令字面量 `("pnpm", "exec", "vitest", "related")`。

### 实测

| 场景 | 耗时 | 内容 |
| --- | --- | --- |
| java-host 改动 | 13.4s | 静态检查 + 声明 `test:host` 缺口 |
| 纯文档改动 | 13.9s | 静态检查 |
| 前端 1 文件改动 | 26.7s | 静态检查 + `vitest related` |
| 后端 1 文件改动 | 16.0s | 静态检查（含 clippy）+ 声明 `cargo test` 缺口 |
| 对照：全量 `pnpm check` | 1m22s | 含全量测试（30/30 绿） |

自测 617 → **619 条**（+2：新增缺口用例与重量级命令回归防线；正序/反序均绿）。

---

## R8 · Agent 门禁指令改为「开发循环用 quick」

### 需求

「同步更新 Agent 的门禁检查，不要在任务执行过程中执行全量门禁检测，应该执行 quick，
除非人为指定要全量检测才执行。」

### 调研结论：指令落在 4 个面，且有两处是「跑全量」的直接源头

| 面 | 性质 | 问题 |
| --- | --- | --- |
| `AGENTS.md`「AI Assistant Workflow Notes」 | 项目自有（TRELLIS 块外） | 只说「跑质量命令确认通过」—— 没说是哪条 |
| `.trellis/workflow.md` Phase 2.2 | Trellis 托管 | "Final pass ... must run **full-scope**" —— agent 读成「跑全量门禁」 |
| `trellis-check` skill `Step 3`（5 平台副本） | Trellis 托管 | "Run the project's lint, type-check, **and test** commands" —— 字面含 test |
| `.trellis/workflow.md` 的 sub-agent 任务描述 | Trellis 托管 | "Run lint and typecheck to verify" —— 同样含糊 |

关键歧义：**"full-scope" 本意是「比对覆盖全部受影响的包」，不是「跑全量测试套件」**。
Phase 2.2 原文已澄清了前者（列出所有 affected packages、加载各包 spec 的 Quality Check 段），
但没否定后者 —— 于是 agent 两条都做。

### 改法：单一源 + 托管文件只做指针

命令名**只在 `AGENTS.md` 出现一次**（该文件在 `check_script_references` 的扫描面内，改名会被护栏
抓到）；Trellis 模板（`workflow.md` / skill）只写「项目声明的开发循环检查命令」并指向 `AGENTS.md`，
不抄命令名 —— 否则 workflow.md 不在扫描面，将来改名会静默漂移。

| 文件 | 改动 |
| --- | --- |
| `AGENTS.md` | 新增「检查用哪条命令（硬指令）」：开发循环 `pnpm check:quick`；`pnpm check` 只留给收尾那一次 / 用户明确要求 / 怀疑跨模块影响 |
| `.trellis/workflow.md` | Phase 2.2 两处任务描述改为「项目的开发循环检查命令（见根 AGENTS.md）」；**Final pass 明确写 "full-scope means review coverage, not re-run every gate"** |
| `.agents/.pi/.claude/.opencode/.omp/skills/trellis-check/SKILL.md` | `Step 3` 改为「跑项目的开发循环检查命令（快的那个，不是全量门禁）」，并写明何时才该跑全量 |

`AGENTS.md` 体积：原 15,532B → 16,182B / 上限 16,384B。第一版写到 16,780B 触发
`check_agents_md_size` 护栏，故把详述下沉到 spec（已在「质量门禁」段），`AGENTS.md` 只留
硬指令 + 指针 —— 这同时符合 DRY。

### 为什么 `check:quick` 的结果不能替代全量

spec 已写：它**不是门禁**（`vitest related` 有 import 图盲区）。所以本轮**没有**把全量检查
从流程里删掉，只是把它移到**正确的位置**：开发循环不跑，`lefthook pre-push` 自动跑。
改动前 agent 每个迭代都跑一次全量（分钟级），改动后一迭代 ~15-20s。

### 验证

- `pnpm check` 30/30 绿（1m14s）
- `check_agents_md_size` / `check_script_references` 绿
- `workflow.md` 中 `pnpm` 引用为 0（单一源成立）
