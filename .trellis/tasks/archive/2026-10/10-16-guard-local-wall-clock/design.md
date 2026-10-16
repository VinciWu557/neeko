# Design — 本地门禁并发与前端测试环境开销优化

> 任务：`.trellis/tasks/10-16-guard-local-wall-clock`（PRD 见 `prd.md`）。
> 结论先行：**三条优化作用在不同层级，1 是 3 的前提**。只做 3 不做 1，
> 3 的收益会被串行结构吃掉；只做 1 不做 3，墙钟停在 `test_fe` 的地板上。

---

## 1. 第一性原理：耗时从哪里来

护栏框架墙钟 = **Σ(各命令门禁耗时) × 串行度**。三个层级：

```
总工作量（CPU 秒）          ← 由测试用例数、每文件环境开销决定   →  R3 作用于此
   ↓
墙钟 = 总工作量 / 并行度     ← 由门禁间调度 + 每门禁内部 worker 数决定
   ↓
实际墙钟 = 墙钟 + 竞争衰减   ← CPU 超订时各门禁互相拖慢           →  R1 作用于此
```

实测数据（10 核，暖缓存）：

| 门禁 | 单独 | jobs=4 下 | 说明 |
| --- | --- | --- | --- |
| `test_fe` | 82s | 83.5s | 长杆；自带 6 worker |
| `test_rust` | 25.7s | 35.5s | cargo 自己起 N 个测试线程 |
| `lint_fe` | 9.5s | 34.5s | tsc 被 vitest 抢核，劣化 3.6× |
| `lint_rust_all_targets` | 4.9s | 3.7s | — |
| `test_host` | 4.4s | 3.4s | — |

**竞争衰减是真实的**：`lint_fe` 劣化到 34.5s。但墙钟仍从 127s 降到 89s ——
因为串行时短门禁全额叠加，并发时它们被藏进长杆的影子里。

### 1.1 为什么并发度不能取 CPU 数

10 核机上，`--jobs 4` 已在跑：vitest(6 worker) + tsc(1) + clippy(1) + cargo test(N)
= 9+ 个活跃执行体。取 `--jobs 10` 会让 `lint_fe` 的劣化进一步放大，
而 `test_fe` 作为长杆不会因此变快（它自己已被 6 worker 打满）。

**并发度的正确形态 = min(cpu_count, 长杆门禁自身的 worker 数)**。取 4 是经验值
（与 lefthook pre-push 一致），且留有余量给 `test_rust` 的 cargo 线程。

### 1.2 为什么 jsdom 是唯一的地板杠杆

vitest 自报：`environment 222s / setup 89s / import 85s / tests 74s`。
362 个 jsdom 文件 × ~600ms = 222s ÷ 6 worker ≈ 35s 墙钟。

`maxWorkers` 无空间（实测 6↔10 持平）。`isolate: false` 能复用环境、直击这 222s，
但有状态泄漏风险（本任务的显式 Non-Goal，需单独实验）。

**剩下的只有减少 jsdom 文件数。** 190 个文件已迁过（历史成果），
静态判据只圈出 28 个候选（7.7%）—— 因为大部分 jsdom 文件是真需要 DOM 的。

---

## 2. R1 设计：并发度派生放哪

三个选项：

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| (a) `package.json` 写死 `--jobs 4` | 改动最小 | 把"适配 10 核机"写死；Windows 不可移植（若是 shell 表达式） |
| (b) 改 `cli.py` 默认值 | 一处生效 | **污染框架契约**（见 §2.1） |
| (c) 框架新增派生函数，`package.json` 不传 `--jobs` | 可被 push/ci 复用；可移植 | 新增代码 |

### 2.1 为什么不能选 (b) —— 默认值是钉住的契约

`test_cli.py::test_defaults_are_the_unfiltered_sequential_form` 这个用例名本身
说明了意图：**"默认 = 无过滤 + 串行"是有意设计**。理由：

- `--only` / `--staged` / `--suite` 过滤后可能只剩 1-2 条门禁，此时并发无意义；
- 串行时 fail-fast 语义最直观（第一个违规即停，不启动后续）；
- 改默认值会让 `commit` 档（增量、快反馈场景）也变成并发，改变它的延迟特征。

**为本地 `check` 的便利去动一个被测试钉住的共享契约，是把局部需求升级成全局变更。**

### 2.2 选 (c)：派生逻辑进框架，调用方只表达意图

新增一个纯函数（放 `core/platform.py`，与 `platform_tag()` 同住 —— 它已经是
"机器/平台相关事实"的归属处）：

```python
def default_jobs() -> int:
    """命令门禁的并发度派生：min(cpu_count, 4)。

    上限 4 的理由：本地全量档的长杆是 test_fe，它自己已占 maxWorkers=6 worker。
    再高的门禁并发只会放大竞争衰减（实测 lint_fe 在 jobs=4 下已劣化 3.6×），
    不会让长杆变快。CPU 少于 4 核时退回串行（并发无收益且互相拖慢）。
    """
```

**但这里有个关键问题**：`package.json` 的 `check` 怎么用它？

若 `cli.py` 读它作默认值 → 就是方案 (b)，违反 §2.1。
若 `package.json` 写 `--jobs $(...)` → 不可移植。

**解法：区分"框架默认"与"调用方意图"。**

- 框架默认保持 1（契约不变）；
- 新增 `--jobs auto`，语义 = "按机器派生"，调用方显式选择；
- `check` 脚本写 `--jobs auto`。

这样：
- 契约未动（默认仍是 1，`test_cli.py` 不改仍绿）；
- 调用方表达了"我要并发"的**意图**，而不是硬编码一个数字；
- push / ci 档以后想用，同样写 `auto` 即可（复用）；
- 显式 `--jobs 3` 仍然有效（覆盖能力不丢）。

```python
def resolve_jobs(value) -> int:
    """--jobs 的解析：正整数原样返回；'auto' 按机器派生。"""
```

### 2.3 fail-fast 语义核对（必须确认，不能盲改）

`runner._run_commands` 在 `jobs>1` 时：出现第一个 VIOLATION/ERROR 后
**不启动新的 gate，但不中断已在跑的**。与 `jobs=1` 的 `&&` 语义等价
（中断一个跑了一半的外部命令会浪费它已付的暖缓存成本）。

报告顺序恒为声明顺序（`test_runner.py:249` 有用例钉住）。**两项都不受本改动影响。**

---

## 3. R2 设计：迁移判据与验证

### 3.1 静态判据只能圈候选

判据：`.ts` + 无 `@testing-library/react` + 无 DOM API 直写。圈出 28 个。

**放宽判据会混入假阳性**：
- `renderHook` 需要 `document`（jsdom 提供）—— 不能迁；
- 传递性 import 了 DOM 的（store → 某组件）—— 不能迁。

所以必须**逐个实测**。手法：加 docblock → 跑该文件 → 绿则留，红则回退。
`spec/unit-test/frontend-testing.md` 已记载"误标在 node 环境必红，10 个误标已实证回退"。

### 3.2 不设数量目标

28 个候选 × 600ms ÷ 6 worker ≈ 3s 墙钟。**这是诚实预期**，写进验收：
AC4 只要求"迁过的真跑过 + 全绿"，不要求迁满 28 个。

---

## 4. 实施顺序

1. R1：`core/platform.py` 加 `default_jobs()` + `cli.py` 支持 `--jobs auto`
   + `runner` 透传 + 单测（含 `auto` 派生、显式覆盖仍生效、默认仍为 1）
2. `package.json` 的 `check` 改 `--jobs auto`
3. 验证 AC1/AC2/AC3
4. R2：逐个迁 28 个候选（每迁一个跑一次）
5. R3：文档同步
6. AC5：`pnpm check` 全绿

## 5. 风险

| 风险 | 对策 |
| --- | --- |
| 并发改变 fail-fast 可观测性（红的时候输出交错） | 框架已按声明顺序渲染报告，交错只在 gate 进行中可见；fail-fast 语义不变 |
| `--jobs auto` 在 CI 上取值过大 | CI 不传 `--jobs`（`--stage ci` 只用进程内判据），不受影响 |
| 派生上限 4 在低核机上是串行 | 有意：`cpu_count < 4` 时并发无收益（§2.2） |
| 误标 node 环境导致假绿 | 每个迁过的文件必须真跑过；node 环境 crash 会直接红，不会静默 |
| 28 个候选大部分不能迁 | 诚实预期已写进 PRD；不设数量目标 |

## 6. 回滚

纯参数 + docblock 改动，无持久化影响。回滚 = revert 提交。
