# 本地门禁并发与前端测试环境开销优化

> 来源：2026-10-15 实测 `pnpm check` 墙钟 2m29s（`guards run --stage local` 1m55s），
> 其中 `test_fe` 单项 104s。用户要求优化，同时给出第一性原理约束。

## 背景：门禁耗时的结构

护栏框架的墙钟 = **各命令门禁耗时之和 × 串行度**。`cli.py` 的 `--jobs` 默认 1
（`test_cli.py::test_defaults_are_the_unfiltered_sequential_form` 有意钉住），
而 `lefthook pre-push` 已显式用 `--jobs 4` —— 说明作者知道并发更好，只是没接到本地 `check`。

实测（10 核机，暖缓存）：

| 门禁 | 单独实测 | 在 `--jobs 4` 下 |
| --- | --- | --- |
| `test_fe` | 82s | 83.5s |
| `test_rust` | 25.7s | 35.5s |
| `lint_fe` | 9.5s | 34.5s |
| `lint_rust_all_targets` | 4.9s | 3.7s |
| `test_host` | 4.4s | 3.4s |
| **墙钟** | **2m29s** | **1m29s** |

三条优化作用在**不同层级**，且有依赖：

| # | 作用层 | 减少什么 | 优先级 |
| --- | --- | --- | --- |
| 1 `--jobs` | 门禁**之间**的调度 | 墙钟（不改总工作量） | 高 |
| 2 别重复跑 | 人的操作重复 | 墙钟（无代码） | — |
| 3 jsdom→node | 门禁**内部**的地板 | 总工作量 | 低 |

**依赖：1 是 3 的前提。** 做了 `--jobs` 后墙钟由 `test_fe` 单点主导，此时优化
`test_rust`（26s）无收益，只有继续压低 `test_fe` 地板才有效。反过来只做 3 不做 1，
串行结构不变，`test_rust` 的 26s 仍全额叠加 —— 3 的收益会被 1 的缺失吃掉。

## 第一性原理：为什么这三条是"根治"而不是补丁

`test_fe` 慢的根因不是"某个用例慢"，而是**每文件的固定环境开销 × 文件数**：

```
vitest 自报（--maxWorkers=10）：
  environment 222s / setup 89s / import 85s / tests 74s / transform 16s
```

- 552 个测试文件中 **362 个是 jsdom**、190 个已迁 node。
- `environment` 222s ÷ 362 ≈ **600ms/文件**，纯用于为每个文件重建 jsdom；
  ÷ 6 worker ≈ 35s 墙钟，占 `test_fe` 的 ~45%。
- 真正跑用例只占 `tests 74s`，且 552 个文件的总时长仅 50s —— 大头全在环境/导入/装配。

因此 `maxWorkers` 已无空间（实测 6↔10 墙钟持平，历史记载 8 并发也无增益），
**唯一剩余的杠杆是减少 jsdom 文件数**。

## Requirements

### R1 · `check` 接入并发（改 `package.json`，不动框架默认值）

- R1.1 `check` 脚本改为 `... run --stage local --jobs <N>`。
- R1.2 **不改 `cli.py` 的 `default=1`** —— 该默认值被
  `test_cli.py::test_defaults_are_the_unfiltered_sequential_form` 有意钉住，
  是框架契约（"默认 = 无过滤 + 串行"）。为本地 `check` 的便利去动它会污染
  `commit` / `ci` 档与 `--only` / `--staged` 的全部调用方。
- R1.3 并发度取**按 CPU 派生的保守值**，不硬编码：10 核机上 `test_fe` 自己已占
  6 worker，无脑 `--jobs 10` 会严重超订、反而变慢（实测 `lint_fe` 在 `--jobs 4` 下
  从 9.5s 劣化到 34s）。取 `min(cpu_count, 4)`，`--jobs` 仍可显式覆盖。
- R1.4 派生逻辑放**框架内**（可被 push / ci 档复用），而不是在 `package.json` 里
  写 shell 表达式 —— 后者在 Windows 上不可移植（本项目是三平台门禁）。

### R2 · jsdom → node 环境迁移（收益小但是唯一的地板杠杆）

- R2.1 候选判据：`.ts`（非 `.tsx`）+ 不用 `@testing-library/react` + 无 DOM API
  直写。**静态判据只能圈候选，必须逐个实测**（node 环境 crash → 回退），
  `spec/frontend-testing.md` 已记载"误标在 node 环境必红，10 个误标已实证回退"。
- R2.2 只迁**确实不需要 DOM** 的文件。为凑数字把 `renderHook` 用例标成 node 是错的
  （`renderHook` 需要 `document`）。
- R2.3 **不设数量目标**。静态圈定 28 个候选（362 的 7.7%），放宽判据会混入假阳性。
  诚实预期：28 个 × 600ms CPU ÷ 6 worker ≈ **3s 墙钟**。收益极小，但地板确实在降。
- R2.4 迁移后该文件必须在 node 环境**真跑过**（不能只加 docblock 不验证）。

### R3 · 文档同步

- R3.1 `.trellis/spec/frontend/quality-guidelines.md` 的"质量门禁"段：`pnpm check`
  的行为（并发度）与实现一致。
- R3.2 `.trellis/spec/frontend/frontend-testing.md`（若存在）或
  `unit-test/frontend-testing.md` 的"node vs jsdom"段：补一条"如何判断该迁哪个文件"。

## Non-Goals

- **不改 `maxWorkers`**（实测 6↔10 墙钟持平，历史已记载 8 并发无增益）。
- **不动 `isolate: false` / 换 `pool`**（可复用环境、直击那 222s，但有状态泄漏风险，
  需单独任务小范围实验）。
- **不引入 CI 并行化改造**（CI 已有 per-job 并行，`--stage ci --suite lint --source python`
  只跑进程内判据，本任务不涉及）。
- **不给 `pnpm check` 加 `--changed` 增量过滤**（那是另一类改动：会让"本地全量"
  名义与实际不符，且 `AGENTS.md` 明确 `pnpm check` 是"本地全量门禁"）。
- **不改 `check` 与 `guards run --stage local` 的别名关系**（`docs` 与 `AGENTS.md`
  都引用 `pnpm check`，别名有存在价值；重复跑是使用习惯，无代码可改）。

## Acceptance Criteria

- [ ] AC1：`pnpm check` 走并发，实测墙钟 ≤ 1m40s（对比基线 2m29s）。
- [ ] AC2：`--jobs` 显式传入时仍生效（派生只做默认，不剥夺覆盖能力）；
      `test_cli.py::test_defaults_are_the_unfiltered_sequential_form` **不改仍绿**。
- [ ] AC3：派生逻辑可被 push 档复用（不在 `package.json` 写 shell 表达式）。
- [ ] AC4：迁移的文件在 node 环境**真跑过**；`pnpm test:fe` 全绿、无用例被跳过或弱化。
- [ ] AC5：`pnpm check` 全绿（30 护栏 + lint_fe + lint_rust_all_targets + 三套测试）。
- [ ] AC6：`AGENTS.md` / `quality-guidelines.md` 与实现一致。
