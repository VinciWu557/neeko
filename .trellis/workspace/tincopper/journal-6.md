# Journal - tincopper (Part 6)

> Continuation from `journal-5.md` (archived at ~2000 lines)
> Started: 2026-10-11

---



## Session 264: CI 三平台静态检查红：平台 cfg 独占消费者（修 3 处 + 护栏判据升级）

**Date**: 2026-10-11
**Task**: CI 三平台静态检查红：平台 cfg 独占消费者（修 3 处 + 护栏判据升级）
**Branch**: `main`

### Summary

绑定/导入的唯一消费者落在其他平台的 #[cfg] 块内，macOS 单平台 clippy 看不见；修 file/commands.rs、factory.rs、instance.rs 三处，check_platform_imports 判据升为按平台求值的独占消费者（含 test 模块与 let 绑定），spec 口径同步

### Main Changes

## 根因
平台 cfg 独占消费者：定义在平台 cfg 外，全部使用点却落在某个平台的 #[cfg] 门控内 →
该平台 rustc 报 unused_imports / unused_variables，被 CI 的 -D warnings 升级为编译错误。
Linux 报 file/commands.rs 的 `let args`（只被 windows/macos 块消费）；Windows 报
factory.rs 的 `use ExecError` 与 instance.rs 的 `let info`（都只被 not(target_os="windows") 的测试消费）。

## 修复
- file/commands.rs：两个 reveal 测试补 `#[cfg(target_os = "linux")]` 判据块（xdg-open + 参数语义），
  顺带消灭 Linux 上「断言为空跑」的测试侵蚀。
- factory.rs：`use ExecError` 收进被门控的测试函数体内（局部 use，最紧作用域）。
- instance.rs：补 Windows 侧 `assert_eq!(info.memory_mb, 0.0)`，钉住 process_memory/windows.rs 的按设计返回 None。
- 验证补强：三段新代码都在非宿主的 cfg 里，macOS clippy 不编译 → 临时把门控改成 cfg(unix) 跑 clippy 验证类型/语法，随后按 diff 逐字还原。

## 护栏升级（tools/guards/checks/check_platform_imports.py）
判据统一为「平台 cfg 独占消费者」：无门控的 `use` 名 / 简单 `let` 绑定名，对 linux/macos/windows
逐平台求值，存在一个平台使其全部使用点都被编译掉 → 违规。要点：
- `#[cfg(test)]` 不再是免检区（旧版对 factory.rs / instance.rs 全数漏报）；
- 成对门控（unix + windows 各消费一次）不误报（旧判据的「全在用点落在 cfg 内」会被该形态误伤）；
- 门控范围补齐裸 `{` 块与多行语句（attr 贴 assert!/let），并对枚举变体/结构体字段这类非语句项
  退回单行范围（三个误报形态已用回归测试锁住）；
- 判不了的条件、函数参数、for 绑定一律放行（宁可少报，误报会让人关掉护栏）。
- 实测：对修复前基线逐行命中 CI 报的 4 个消费者点（factory.rs:80 / commands.rs:255,282 / instance.rs:1188），
  对本仓现状 0 误报，452 文件 97ms。

## 遗留观察
平台门控断言消失会导致测试静默空跑（本次顺带补了 reveal 的 Linux 腿）；无门禁可发现，属同族风险。


### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 265: L2 禁令落地：测试域平台门控只许挂 item（结构护栏 + 38 处迁移清零）

**Date**: 2026-10-11
**Task**: L2 禁令落地：测试域平台门控只许挂 item（结构护栏 + 38 处迁移清零）
**Branch**: `main`

### Summary

批 0 抽 guards/core/rust_cfg 语法表层；批 1 新增 check_platform_cfg_placement（附着位置判据）+ ratchet 基线（38=逐行等于设计附录 A）；批 A-E 迁移 38 处为整测试/item 级 gated helper/适配器夹具；批 F 删台账进零容忍；pnpm check 24 条全绿

### Main Changes

## 交付
- 新护栏 `tools/guards/checks/check_platform_cfg_placement.py`：测试域（内联 mod tests / 外部 tests.rs / all(test,…) item）内平台 cfg 只允许附着 item 声明；非 item 即违规。判据=附着位置（结构约束，可完备零误报），与 check_platform_imports（消费者分析，兜底）互补。
- `tools/guards/core/rust_cfg.py`：语法表层抽取（两护栏共用），等价性由既有 29 条单测 + 本仓命中恒等 + 修复前基线逐行命中证明。
- 存量 38 处 → 0（12 文件）：整测试化（平台维度上移测试名）11 处形态、item 级 gated const 10 处、gated helper 归并 4 处 chmod + 6 处 symlink（收进 common::testing，DRY 越过 3 次线）。
- 台账 `ledger/platform_test_cfg.json` 迁移期 ratchet（38→29→17→5→0），批 F 删除 → 零容忍生效。
- invariants.json 增一条（tier=guard, red_line=10）；spec 两处同步（checklist 增「门控粒度 ≥ 作用域粒度（测试域硬禁令）」+ 护栏清单）；test_gates.py 计数 pin 18→19。

## 关键证据
- 判据完备性：清空基线跑一次报 38 处、逐行等于 design 附录 A（无多余命中）。
- 断言守恒：migration-evidence.md 逐处对照表（含 `assert!(cmd.is_some())` → expect 的蕴含关系）。
- 顺带收益：消灭「断言在非目标平台静默消失」（test_normalize_path_windows 非 Windows 空跑、registration/tests.rs 两腿语义进测试名）。
- `pnpm check` 24 条护栏全绿（445 护栏自测 OK + test_rust/test_fe/test_host + lint 两档）。

## 遗留（已登记）
- 生产域 44 处 fragment（含 7 match arm + 1 字段 init 派生门控）→ L1 任务：类型平台中立化（ProjectEnvironment::Wsl 变体、PlatformWatcher::MacExclusion 变体、PtyHandle 字段），清单见 design.md 附录 B。
- 任务目录：.trellis/tasks/10-11-test-platform-cfg-item-scope（prd/design/implement/migration-evidence）。


### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 266: neeko-check 评审修复：判据结构性重构 + 夹具所有权（TestRoot）+ 红线 10 测试域条款

**Date**: 2026-10-11
**Task**: neeko-check 评审修复：判据结构性重构 + 夹具所有权（TestRoot）+ 红线 10 测试域条款
**Branch**: `main`

### Summary

审核 25 项改动发现 1 Block（域识别过延伸致生产码误报）+ 2 Warning（夹具生命周期、红线全文缺口）+ 3 Nit；全部按第一性原理修复：body_open_line 结构性判据两护栏共用、TestRoot 持有 TempDir、instance.rs 去重、guard 命名/结构澄清；pnpm check 24 条全绿

### Main Changes

## 修复（按第一性原理定位根因）
1. [Block] 「有无块体」不能枚举 item 种类 → `core/rust_cfg.body_open_line()`：头部终止符（深度 0 的 `;`/`,`）前是否出现 `{`；两条护栏共用，删除 BLOCK_PREFIXES 前缀启发式；2 条回归测试（含实测误报形态）。
2. [Warning] 夹具所有权 → file/commands.rs 夹具接收 `&Path`（tempdir 派生、去固定名、去手工清理）；collapsed_probe 的「不存在路径」用 tempdir 保证不存在。
3. [Warning] 约束与强制层级同层 → src-tauri/AGENTS.md 红线 10 内补「测试域只允许 item 级门控」条款（12,305B / 上限 16,384B）。
4. [Warning] 资源所有权全仓一致 → services/tests 的 `temp_root` 改为 `TestRoot`（持有 TempDir，Deref<Path>+AsRef<Path>；29 调用点写法不变，7 处 clone→to_path_buf）。
5. [Nit] guard：stale_notes→baseline_notes、collect→ScanResult dataclass、evaluate 粒度注释、docstring 生成命令同步。
6. [Nit] instance.rs 两平台测试共用 `live_process_session()`。

## 等价性与回归证据
- 消费者分析判据：修复前基线 4 个消费者点（factory.rs:80 / commands.rs:255,282 / instance.rs:1188）逐行命中不变。
- 域判据：本仓 测试域门控 68 处 / fragment 0 处（无覆盖损失）。
- 护栏单测 23 + 29 全绿；file::commands 7 / services 41 / status_worker 26 / instance 29 全绿；pnpm check 24 条护栏全绿。

## 判定不适用（附理由，未改）
- serve.rs:1506 env::temp_dir() = 项目 id 字符串语义；url_validator 的 /tmp、C:\tmp = 被断言对象且已整测试门控（红线 13 不适用）；path_ops.rs 残留 remove_dir_all(&root) 冗余但无害。


### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
