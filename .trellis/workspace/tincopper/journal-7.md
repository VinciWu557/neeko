# Journal - tincopper (Part 7)

> Continuation from `journal-6.md` (archived at ~2000 lines)
> Started: 2026-10-17

---



## Session 309: 10-17 收尾：子包自带 workspace 根导致类型双实例（改值三次才找到生成源）
<!-- trellis-session: v=2 fp=9c710cb88ecd1907 -->

**Date**: 2026-10-17
**Task**: 10-17 收尾：子包自带 workspace 根导致类型双实例（改值三次才找到生成源）
**Branch**: `dsh-neeko`

### Summary

Session summary was not supplied.

### Main Changes

收尾阶段抓到一个**只在干净安装下现形**的缺陷，而且我第一次归因也错了 —— 值得连纠错过程一起记。

**现象**：`pnpm run prepublishOnly` 多次全绿，某次重跑突然 `TS6200`：
`@deepseek-ai/schemastery` 的 `lib/types/index.d.ts` 在两个版本间「标识符冲突」
（From / TypeS / TypeT / Constructor …）。同时 `@deepseek-ai/cordis` 报
`has no exported member 'Volatile'`。

**第一次归因（错）**：以为是我的版本范围写宽了 —— 先改 cordis `^4.0.0` → `~4.0.4`
（确实对：dsh 0.2.x 各包声明 `~4.0.4`，4.0.1 缺 `Volatile`），再改 schemastery
`^3.18.1` → `~3.18.4` → `3.18.5`，逐次重装。**每次「修好」后重跑都绿，但下一次
干净安装又红。** 这就是信号：我在治症状，没找到生成源。

**真因**：`packages/dsh-neeko/pnpm-workspace.yaml` 存在。它让 pnpm 把这个**子包当成
独立 workspace 根**，于是根 `pnpm-workspace.yaml` 的 `overrides` 完全失效 —— 单实例收敛
规则进不来，schemastery 按不同 peer 上下文解析出 3.18.4 与 3.18.5 两份，两份 `.d.ts`
顶层声明同名类型 → TS6200。

那个文件原本只有一个用途：让 `dsh plugin install` 绕过 pnpm 的 release-age 门禁
（`minimumReleaseAgeExclude`）。它既不发布（不在 `files` 里）、也没人引用，而且里面
还钉着 0.1.x 的旧包名 —— 是旧契约的又一份残骸。

**修法**：删掉该文件；需要的豁免提升到**根** `overrides`（本仓已有 `@codemirror/view`
先例，同一类「同一依赖多实例」问题）。验证：`rm -rf node_modules && pnpm install` 后
`tsc` 干净、68 测试全绿、`prepublishOnly` 全绿、`dsh plugin install` 仍可用、桥仍能起
（listening + health 200 + session.init）。

**教训**：连续「修好又复现」时，停止改值，去找**谁在生成这个值**。
`pnpm why` / `--traceResolution` 才是定位工具；改版本号是猜。
已把「子包不得自带 pnpm-workspace.yaml」与「干净安装复验」两条写入 spec。


### Git Commits

| Hash | Message |
|------|---------|
| `8c71d81a` | fix(dsh-neeko): drop the stray nested workspace root causing duplicate types |
| `811dfc3a` | docs(spec): correct the duplicate-type lesson to the nested workspace root |

### Status

[OK] **Completed**


## Session 311: dsh-neeko /model 面板：槽位替换 + 模糊搜索
<!-- trellis-session: v=2 fp=16fa4fe382dc7114 -->

**Date**: 2026-10-18
**Task**: dsh-neeko /model 面板：槽位替换 + 模糊搜索
**Branch**: `dsh-neeko`

### Summary

Session summary was not supplied.

### Git Commits

(No commits - planning session)

### Status

[OK] **Completed**
