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


## Session 267: 批 1：类型化挂载票号（MountTicket）—— 写入权与挂载同生共死

**Date**: 2026-10-11
**Task**: 批 1：类型化挂载票号（MountTicket）—— 写入权与挂载同生共死
**Branch**: `main`

### Summary

2026-10 CI 竞态根治（A 簇）：写权载体从隐式 Arc（进程级）收紧为显式票（挂载级）。MountTicket 私有字段唯一签发方 + RAII 守卫覆盖 setup 失败出口 + release_one 先吊销票再删快照（compare-and-remove）；store_snapshot 拆为 store_push（凭证闸门）/store_pull（不变）/stamp_and_insert 内核；3 条确定性回归测试；pnpm check 24 条全绿

### Main Changes

## 背景
CI backend-test 在 macOS 偶发 `activate_style_release_except_keeps_only_the_target_unit` 失败：
worker 推送回调活在 watch() 栈之外，释放单元后晚到的首推会把已作废槽位重新填上权威数据。
10-08 同测试已挂过（既存 flaky），本次改动只是让测试 job 从被静态检查短路中恢复执行、暴露旧账。

## 实现（src-tauri/src/common/file/watcher/manager/core.rs）
- `MountTicket { key, seq }`：字段私有、只能由 issue_ticket 构造 ⇒ 票不可伪造；key 嵌在票里
  ⇒ 票是单元专属的（不能给别的单元写）。
- `mount_tickets: HashMap<key, seq>` + `ticket_serial: AtomicU64`：在册登记表 + 单调发号器。
- `MountTicketGuard`（RAII）：watch() 签发后立即 arm；**4 个 setup 失败出口全部由 Drop 兜底吊销**，
  不靠「每个出口记得回收」；handle 登记成功才 commit。
- watch()：**先于 worker 创建**签发票号（覆盖「首个快照先于 handle 登记到达」的合法窗口，
  这也是旧实现不敢用 watchers.contains_key 做守卫的原因）；回调改走 deliver_push。
- release_one：先吊销票（compare-and-remove，只杀本挂载自己的票，防并发重挂载误杀新票）
  **再**作废快照 —— 顺序契约，排除「校验通过→释放发生→晚到插入复活槽位」窗口。
- stop_all：清空票表（全停 ⇒ 无有效写入者）；WatcherHandle 增 mount_ticket 字段（释放依据）。
- store_snapshot 拆三：stamp_and_insert（盖章内核，签名强制持 store 锁）/
  store_pull_snapshot（R2.4 守卫不变，无闸门）/ store_push_snapshot（凭证闸门与插入同临界区，
  失效返 None）；deliver_push 统一「写入 + emit 决策」，失效丢弃且**不 emit**。
- 锁纪律文档更新：嵌套锁序新增 store → tickets，禁止反向。

## 确定性回归测试（lifecycle_tests.rs，全部不依赖线程时序）
1. push_with_current_ticket_is_written_and_emitted：当期票接受 + 写入 + emit + 同版本；
2. push_after_release_with_stale_ticket_is_rejected：释放后旧票拒绝 + 槽位空 + 无 emit 增量 + 票已注销；
3. remount_rejects_previous_mounts_late_push：释放→重挂载后旧票拒绝（槽位 version 不动）+ 新票可用。

## 验证
- manager 38 测试全绿（含 CI 曾失败的 activate_style_release_except 那条）
- 新测试连跑 8 轮全绿（确定性）；下游 services 41 / status_worker 26 / git::services 11 全绿
- clippy --all-targets -D warnings 全绿；pnpm check 24 条护栏全绿；CR/NUL 校验干净
- 改动 4 文件（+447/−68），停在未提交状态

## 待办（批 2/3，未开始）
- 批 2（B 簇）：activate 就绪等待语义定档（Pending 化或预算抬升），Windows CI 冷 FS 超时问题；
- 批 3（治理）：ci.yml 去 backend-check→backend-test 短路；spec 三问扩章 + 不变量登记。


### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 268: 批 2：activate 就绪等待语义定档 —— Pending 一等结果（写入权之后的第二次保证强度对齐）

**Date**: 2026-10-11
**Task**: 批 2：activate 就绪等待语义定档 —— Pending 一等结果（写入权之后的第二次保证强度对齐）
**Branch**: `main`

### Summary

B 簇：冷窗口超时从错误空间移出。WorkspaceActivation{Ready|Pending}（serde tag=state）+ read_mounted_snapshot（等待降级为延迟优化）+ 命令层/前端类型同步 + 3 条新测试（含 pull 恒 Ready 与前端两条 pending 用例）；pnpm check 24 条全绿

### Main Changes

## 背景
CI backend-test 在 Windows 偶发 `activate_releases_the_previous_unit` /
`remote_branch_pulls_without_mounting_and_releases_the_previous_unit` 失败：
`NotFound("status for workspace … is not available yet")` —— 冷启动窗口（挂载已成立、
worker 首轮重算在途）在慢环境（CI 冷 FS / Defender）上超过 1500ms 预算，超时被当成错误。
与批 1（macOS 槽位竞态）同属「保证强度脱钩」类：实现给 best-effort，消费方假定 must-succeed。

## 方案判定（用户选型：Pending 一等结果）
合理 —— 但前提是「等待」必须降级为**延迟优化**，正确性归推送事件：
1. 未就绪是一等状态而非错误 ⇒ 超时从错误空间消失，该类结构性消灭（不是调大赌注）；
2. 收敛通道已存在：useActiveWorkspaceSync 的 reconciliation 环（判据 = 槽位为空）+
   git-status-snapshot 推送 —— Pending 只是把后端契约对齐到前端已有的收敛模型；
3. 等待保留（毫秒级就绪时同步返回，避免首屏闪 loading），但不再承担正确性；
4. 边界：只在挂载已成立时 Pending（非 git 库/解析失败仍 Err）；pull 分支恒 Ready（测试钉住）；
   Pending 与 failed 在前端分开处理。

## 实现
Rust（git/services/status.rs）：
- `WorkspaceActivation { Ready { snapshot } | Pending { workspace_key } }`（serde tag = "state"）；
- 抽 `read_mounted_snapshot()`：等待 = 事件驱动（poke + Condvar 谓词）+ 预算防死锁，
  返回 Option（不判错），两个调用方各自定义 None 语义（读命令 Err，激活命令 Pending）；
- `first_snapshot_outcome()` 纯映射（便于直测）：None → Pending，绝不 Err；
- `activate_with` push 分支：挂载未成立退化为一次性 pull（保持旧行为）；成立则 Ready/Pending；
- 命令层 `set_active_workspace` 返回类型同步；read 命令（get_workspace_status）语义不动
  （其消费方均为 catch→null→未知，收益/波及不成比例，留作后续可选）。
前端：
- `shared/types/git.ts` 新增 `WorkspaceActivation`（与 Rust 同形）；`git/types.ts` 转出；
- `gitApi.activateWorkspace` 返回类型；`useActivateWorkspace` 处理 pending（不写槽位、不报错、
  返回 'pending'，收敛交给调用方）；`useActiveWorkspaceSync` 注释同步 pending。

## 测试
- Rust 新纯映射测试 `cold_window_maps_to_pending_never_to_error`（时序不可控但归宿必须恒为
  Ready|Pending；旧实现把超时映射进 Err 正是事故根因）；
- `activate_mounts_…` 改为「冷窗口不得为错误 + 事件通道有界等待收敛」（原断言依赖预算内就绪）；
- `remote_branch_…` 钉住 pull 恒 Ready（Pending 只属于 push 生产者的冷窗口）；
- 前端：两个测试文件的 mock 改为 ready 信封；各新增 1 条 pending 用例
  （useActivateWorkspace：不写槽位不报错；useActiveWorkspaceSync：不判死、退避重试直到落地）。

## 验证
- cargo：git::services::status 7 全绿；clippy --all-targets -D warnings 全绿（含 missing-docs）；
- vitest：22 全绿（两文件）；tsc --noEmit 全绿；
- pnpm check 24 条护栏全绿（首次复跑曾抓到 1 处：测试里手写 `\u{0}` key 字面量触发
  check_workspace_identity，已改为占位串并注明透传语义）；
- spec 同步：git-domain.md「挂载唯一入口」段改为 Ready|Pending 契约 + 有界等待定性；
- 16 文件改动，NUL/CR 校验干净，停在未提交。

## 待办（批 3，未开始）
- ci.yml 去 backend-check → backend-test 短路（flaky 积压一周的放大因素）；
- spec 三问扩章（写入凭证/等待语义/门禁独立性）+ 不变量登记。


### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 269: 批 3：治理收口 —— 门禁信号独立性（A4 判据）+ 设计期三问 + 不变量登记

**Date**: 2026-10-11
**Task**: 批 3：治理收口 —— 门禁信号独立性（A4 判据）+ 设计期三问 + 不变量登记
**Branch**: `main`

### Summary

C 簇：去 ci.yml 三条 check→test/coverage 短路（2026-10 flaky 积压一周的放大因素）；check_gate_topology 新增 A4 判据（*-test/*-coverage 的 needs 不得含 *-check，红/绿双向验证）；spec 三问章节 + 票号契约第 6 条；invariants 17→20 条；pnpm check 24 条全绿

### Main Changes

## 背景
批 1/2 修掉 A（槽位竞态）、B（冷窗口超时）两簇；批 3 处理放大因素与机制保障（"C 簇"）：
`backend-test needs backend-check` ⇒ 静态检查红了一周 ⇒ 测试从未执行 ⇒ 测试层 flaky
（正好是 A/B 两簇）积压到修复当天才第一次现身。原则：**门禁的价值 = 暴露频率 × 信号独立度**。

## 1) CI 拓扑（.github/workflows/ci.yml）
- 去掉三条「check 短路证据」：`frontend-test needs frontend-check`、`backend-test needs
  backend-check`、`backend-coverage needs backend-check`；
- 每个 job 上方留注释写明原因（引 2026-10 事故 + 指向 A4 判据）；
- 对齐既有先例：`frontend-build` 的注释早已写着「不 needs frontend-check：静态检查结论不构成
  前置条件，独立并行出反馈更快」—— 本批只是把同一条理念贯彻到其余三个 job。

## 2) A4 判据（tools/guards/checks/check_gate_topology.py）
- 新增 `_parse_ci_needs`：`jobs:` → {job: [needs]}，支持 `needs: x` / `needs: [a, b]` /
  块列表（`needs:` + `- x`）三形态，引号剥除；
- 新增 `check_signal_independence`（A4）：证据类 job（`*-test` / `*-coverage`）的 needs
  不得含检查类 job（`*-check`）；违规消息直接给出事故语境与修法；
- 防静默失效：run / needs 两个解析器的 job 集必须相等，不等判 broken；
- 单测 +6（正例×2 / 负例×4 覆盖三种 needs 形态与 build 依赖豁免）；
- **红/绿双向验证**：把 `needs: backend-check` 加回 backend-test ⇒ A4 立即报精确违规；
  还原 ⇒ 绿。

## 3) spec 落地
- `quality-guidelines.md` 新增「保证强度对齐（设计期三问）」章节：写入者问（凭证寿命 vs 状态
  寿命）/ 等待者问（事件 vs 时间；超时进状态不进错误）/ 门禁问（信号短路与暴露频率），
  各配 2026-10 反例与结构化解法落点；
- `concurrency-guidelines.md` 的 watcher 所有权契约补第 6 条「写入凭证随挂载失效（票号）」
  —— 批 1 机制的权威叙述（为什么不是 contains_key、三条确定性契约测试、RAII 兜底）；
- 批 2 时已同步 `git-domain.md` 的「挂载唯一入口」段（Ready|Pending 契约）。

## 4) 不变量登记（tools/guards/ledger/invariants.json：17 → 20 条）
- `mount-write-credential-lifetime`（tier=type：无凭证写入编译不过；测试落点 lifecycle_tests）；
- `activation-readiness-is-a-state-not-an-error`（tier=type：枚举无错误分支；Rust + 前端双侧测试）；
- `gate-check-test-signal-independence`（tier=guard：check_gate_topology A4 + 其自测）。

## 验证
- check_gate_topology 单测 22 全绿；`check_invariant_enforcement` 20 条不变量 / 20 个 guard
  文件 / 0 违规；全量 lint 档 21 条护栏绿；pnpm check（进行中→结果见下）；
- 改动 22 文件（批 1+2+3 累计，未提交）。

## 三批收束
A（票号）/ B（Pending）/ C（信号独立）各配：类型或凭证落点 + 确定性测试 + spec 口径 +
不变量台账。同一缺陷类「保证强度脱钩」的三次实例全部关掉，且各自有机械判据防回归。


### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 270: neeko-check 评审修复：台账措辞收窄 + 守卫 arm 提前 + A4 注释剥除 + pending staleness 对齐

**Date**: 2026-10-11
**Task**: neeko-check 评审修复：台账措辞收窄 + 守卫 arm 提前 + A4 注释剥除 + pending staleness 对齐
**Branch**: `main`

### Summary

22 文件增量审核 0 Block / 1 Warning + 3 Nit，本轮全部修复；manager 38 测试 + A4 单测 24 + 前端 23 用例全绿；pnpm check 24 条全绿；改动累计 22 文件未提交

### Main Changes

## 审核范围
neeko-check 增量（22 文件）：批 1（票号）/ 批 2（Pending）/ 批 3（信号独立）三阶段产物的对抗性复读。
结论：0 Block；1 Warning（台账措辞）+ 3 Nit。本轮全部修复。

## 修复（1 Warning + 3 Nit）
1. [Warning] 不变量第 19 条措辞与读路径范围张力 → 标题收窄为「**激活命令的**就绪性是一等状态」，
   首条 enforcement note 增补范围说明：「读命令（get_workspace_status）冷窗口仍返回
   Err(NotFound) —— 消费方按『未知』收敛（catch→null），如需同化另行评估」。
2. [Nit] watch() 的签发→arm 之间的 panic 逃生窗口 → `MountTicketGuard` 改为**在签发行后立刻
   arm**（分支内创建、随 4 元组带出：`(worker, scheduler, mount_ticket, mut ticket_guard)`），
   worker 线程创建 panic 的 unwind 现在也走 Drop 吊销；旧的分支后 arm 块删除。
3. [Nit] A4 needs 解析不吃行内注释 → `_parse_ci_needs` 两处（内联值与块列表项）增补
   `split(" #", 1)[0]` 注释剥除 + docstring 同步；新增 2 条单测（内联注释 / 块列表项注释）。
4. [Nit] 前端 pending 先于 staleness 检查 → `useActivateWorkspace` 改为**staleness 守卫先行**
   （ready/pending 共用，取 respondedKey），pending 判断后置；新增 1 条「迟到 pending ⇒ stale」用例。

## 验证（冻结态）
- cargo：fmt/clippy 全绿；manager 38 测试全绿（含票号三例）
- 护栏：check_gate_topology 24 单测全绿；真实仓库 0 违规；check_invariant_enforcement 通过
- 前端：tsc 全绿；两测试文件 23 用例全绿（含新增迟到 pending 用例）
- **pnpm check 24 条护栏全绿**（test_rust / test_fe / test_host / 两档 lint）
- NUL/CR 校验干净；改动累计 22 文件，停在未提交

## 复核要点（本轮机械证据）
- diff 内 4 处 .expect 全在 #[cfg(test)] 域；无新增 unwrap / 平台 cfg / std::process / 硬编码路径
- 无锁跨 await（status.rs 新增代码零直接 .lock()；core.rs 新增代码全同步）
- A4 判据红/绿双向验证保持（批 3）；行内注释形态由新单测钉住


### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 271: 收尾 10-07 统一命令执行：核验全部 AC 并归档

**Date**: 2026-10-12
**Task**: 收尾 10-07 统一命令执行：核验全部 AC 并归档
**Branch**: `main`

### Summary

核验 10-07-unify-command-execution 的 6 条 AC 全部达成（含 Windows CI），勾选 AC1、P5 最后一项，修正两处计数偏差，归档任务。

### Main Changes

## 会话性质

只读核验 + 任务收尾，未改任何功能代码（除勾选 AC 复选框与计数修正外）。

## 核验过程与证据

逐项对照 `implement.md` 的 P0–P6 与 PRD 的 AC1–AC6，用可执行判据而非文档自述：

| 判据 | 命令 | 结果 |
|---|---|---|
| 护栏 0 违规 | `guards run --only check_command_execution` | 351 文件 / 0 违规 |
| 护栏负例测试 | `python3 -m unittest guards.tests.test_check_command_execution` | 10 条 OK |
| git 行为冻结 | `cargo test --lib -- git::transport` | 24 passed（含 golden argv） |
| Windows 回归 | CI run 38135300006 | backend-test win/mac/ubuntu 三平台全绿 |
| 全量 lib 测试 | `cargo test --lib` | 1555 passed / 0 failed |
| 全量门禁 | `guards run --stage local` | 24 条护栏全过 |

代码落点抽样确认：`run_shell_streaming` → `run_spawn_streaming(SpawnOptions, …)` 三端合一；
`transport/{local,wsl,ssh}.rs` 已无 `fn run_git`；`shell_quote`/`safe_path` 在 transport 下零命中；
`common/file/services/shell_cmd.rs` 已删除；`platform/fonts/{macos,windows,linux,default}.rs` 走
`collect_blocking`；`dap/process.rs` 与 `dap/build.rs` 走 `collect_script`；
`theme/common.rs` 抽出 6 个 WSL helper 收敛 pi/opencode 重复。

## AC1 闭合方式

原 PRD 把 Windows 判据留给 CI，`gh run view` 确认最新绿 run（38135300006 @ 286cdff5）
既包含 10-07 全部迁移提交（`93b8bff5` 是其祖先），其后又无触及 10-07 文件范围的新提交 ——
故该次 CI 绿等价于「当前代码状态三平台全绿」，判据闭合而非「某次曾绿」。

## 偏差修正

- implement.md 称护栏 9 例负例 → 实际 10 条（含 `test_facade_is_scanned_not_exempt`）
- implement.md / PRD 称 338 个生产文件 → 实际 351（文件数自然增长）

## 归档

`task.py archive 10-07-unify-command-execution` → `archive/2026-10/`。

## 待留意（非本任务范围）

`guards run --stage ci` 中 `rust_check` FAIL：`could not find Cargo.toml` —— `cargo check`
需在 `src-tauri/` 下执行，属 CI job 的配置问题（`lint_rust_all_targets` 同 stage 通过，故未
影响实际判定）。留待后续处理。


### Git Commits

| Hash | Message |
|------|---------|
| `60ebbed1` | (see git log) |
| `c41902ae` | (see git log) |
| `a1241401` | (see git log) |
| `f9467699` | (see git log) |
| `d6726ea0` | (see git log) |
| `62cf8f7e` | (see git log) |
| `b3b08ce1` | (see git log) |
| `a0d33d94` | (see git log) |
| `93b8bff5` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 272: 收尾 10-08 命名收敛：核验 AC 并归档

**Date**: 2026-10-12
**Task**: 收尾 10-08 命名收敛：核验 AC 并归档
**Branch**: `main`

### Summary

核验 10-08-workspace-naming 的 5 条 AC 全达成（Tier 0/1/2/3 全栈落地远超初版范围），对齐 PRD 与实际落地的文档落差，归档任务。

### Main Changes

## 会话性质

只读核验 + 文档对齐 + 归档，未改任何功能代码（仅修订 PRD 的 Scope/Out/缺口段措辞）。

## 核验证据（可执行判据，非文档自述）

| 判据 | 命令 | 结果 |
|---|---|---|
| type-check | `pnpm type-check` | 通过 |
| 全量门禁 | `guards run --stage local` | **24/24 全过**（含 test_fe / test_rust / test_host） |
| AC2 | `rg ProjectWorkspace src` | 0 命中 |
| AC3 | `rg unitRootForProject src` | 0 命中 |
| AC4 | 术语表唯一性 | `docs/domain-model.md` 唯一定文处；三处 spec 均为一句话指针 + 「不复述」声明 |
| 旧名核验 | 全仓 `rg`（src-tauri/src + src + tools） | `RepoRef`/`WorktreeRef`/`UnitPath`/`ExecUnit`/`RepoKey`/`repoKeyOf`/`repo_key`/`get_repo_status`/`set_active_repo_unit`/`read_unit_status`/`release_unit`/`useWorktreeStore`/`WorktreeUnitState`/`selectActiveWorktreePath`/`WorktreeSnapshotItem`/`useActivateRepoUnit` 全 0 命中 |

新符号抽样在位：`workspaceStore.ts`、`workspaceRef.ts`、`workspace_ref.rs`、`checkout_path.rs`、
`ProjectView.tsx`、`check_workspace_identity.py`；后端 `WorkspaceRef`/`Checkout`/`CheckoutPath`/
`ExecWorkspace` + `resolve_workspace`/`resolve_exec_workspace`/`resolve_workspace_root`；
命令 `get_workspace_status`/`set_active_workspace` 已在 `lib.rs:229-230` 注册；
wire `workspace_key` 落在 `git.ts`/`file.ts` 与 session/git/file hooks。

刻意保留项确认（非遗漏）：`repo_key_prefix`（cache 键，4 文件）、`isActiveWorktree`
（linked-vs-main 类型谓词，6 文件）、`isWorktreeDirty`/`create_worktree` 等 git 原生操作。

## 范围落差（本次文档对齐的主体）

PRD 初版把 Tier 2 大改名（75 import 点）与 Tier 3（后端类型 + wire）列为 Out，且决策
「默认不改」；实际四轮落地中两者都做了（Tier 2 实际跨 78 文件；Tier 3 比原设想更彻底）。
修订方式：保留原始规划口径 + 删除线标注「后续已落地」+ 指向 implement.md 对应记录段，
便于将来对照「计划 vs 实际」的差距来源，而不是静默改写历史。

另修正一处：R1.3 提到的 `RepoKey`/`RepoRef` 补注 Tier 3 后符号名为 `WorkspaceKey`/`WorkspaceRef`（语义不变）。

## CI 覆盖

`f784b8e7`（主改名提交）是最新绿 run 38135300006（286cdff5）的祖先；该 run 之后无任何提交
触及本任务文件范围（命名/术语相关 12 条路径全部无 diff）→ CI 绿等价于当前代码状态绿。

## 归档

`task.py archive 10-08-workspace-naming` → `archive/2026-10/`。


### Git Commits

| Hash | Message |
|------|---------|
| `f784b8e7` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 273: terminal 插入链路 WorkspaceSession 寻址迁移（env-blind 键 + session 内路由 + 护栏）

**Date**: 2026-10-12
**Task**: terminal 插入链路 WorkspaceSession 寻址迁移（env-blind 键 + session 内路由 + 护栏）
**Branch**: `main`

### Summary

terminal 缓存键统一为 terminalAddress(session,...)；读侧/③ 面（前缀销毁/刷新/切换）全部 session 化；插入路由按 workspace session 仲裁；删除手搓 wt:/wsl:/remote: 键与零消费者死代码；新增 check_terminal_key_mint 护栏。pnpm check 26/26 全绿，前端 4689 用例通过。

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 274: 运行根按 Workspace 寻址：终端/任务 cwd 身份化 + 三环境统一

**Date**: 2026-10-13
**Task**: 运行根按 Workspace 寻址：终端/任务 cwd 身份化 + 三环境统一
**Branch**: `main`

### Summary

从用户报障（worktree 下 Run Task 实际在主仓执行）出发做第一性原理归因：运行根是 Workspace 的纯函数 cwd(session)=workspace.root，却被三处当 Project 属性使用——前端 taskStore 缺省 activeProject.path、后端 create_terminal_session 身份是 project_id + 不透明 working_dir + unwrap_or(project_path) fail-open、WSL/Remote 分支整个丢弃 working_dir。命令边界收 WorkspaceSession，解析收敛为单一核心 resolve_workspace_core + 按需投影（resolve_workspace / 新增 resolve_workspace_target_with_env），消除命令层二次读项目；Local/WSL/Remote 消费同一已解析 cwd，workspace_root 另传给主题准备，使语言 runner 的子目录覆盖不再搬迁项目级产物；working_dir 越界显式 InvalidInput。前端运行根统一经 activeWorkspaceRootOf / useActiveWorkspaceRoot 委托既有 workspaceRootOf mint，交互终端不再自带第二份 cwd；任务配置存储保持项目根、发现与执行走 workspace 根。拆除侧同样收口：stop_task 原经 terminal_router.local() 直连，对 SSH 会话永远关不掉且泄漏 owners 登记，改走 close_session（take_owner 路由+释放）。删除零消费者的 run_task。新增护栏 check_terminal_run_root（G1 身份/G2 禁 fail-open/G3 前端禁裸 project 根/G4 禁绕过 router 拆除，13 条自测含逐条 Red 形态）。三轮 neeko-check 复核分别发现并修复：prepare_project_theme 收到 post-override cwd、import/delete 后刷新误用存储根抹掉 worktree 发现列表、以及本轮的 SSH 拆除旁路（含 take_owner 退回 owner_of 的变异验证）；另撤回一条自己的误判避免脏改。pnpm check 27/27 全绿；真机 worktree/WSL/Remote 验证仍待办。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `fbe6f4de` | (see git log) |
| `ce4f76ba` | (see git log) |
| `c29b3395` | (see git log) |
| `efb04ba6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 275: agent 插入接通 + 前台仲裁归一（10-13 批 1–5）

**Date**: 2026-10-13
**Task**: agent 插入接通 + 前台仲裁归一（10-13 批 1–5）
**Branch**: `main`

### Summary

接通 agent 投递（agentInputRegistry 身份注册表，决议 Q1/Q5=A）并把「该往哪个 tab」收敛为 terminalRouting 唯一 order 升序仲裁（决议 Q2）；删 INSERT_TO_AGENT_INPUT_EVENT / isTextInputElement / pasteToTerminal 与 Map 插入顺序第二口径；新护栏 check_terminal_foreground_arbitration（A1 口径唯一+台账 / A2 第二口径退出 / A3 tabId 必填 / A4 声明的 DOM 事件必须有消费点）与 check_terminal_key_mint G3 材质双档，三条不变量登台账；交互 spec 整节重写。pnpm check 28/28 全绿；pnpm tauri dev 真机核验未执行（无 GUI），PTY 回收与多 pane 行为仍待真机确认。

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 276: 10-13 B1-B3修复+校验+spec沉淀

**Date**: 2026-10-14
**Task**: 10-13 B1-B3修复+校验+spec沉淀
**Branch**: `main`

### Summary

(Add summary)

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `d947ec72` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 277: 10-13 S1/S2/S4结构拆分+主会话校验

**Date**: 2026-10-14
**Task**: 10-13 S1/S2/S4结构拆分+主会话校验
**Branch**: `main`

### Summary

(Add summary)

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `a73c0f0a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 278: 10-13 清单修复/journal手术+文档Nit

**Date**: 2026-10-14
**Task**: 10-13 清单修复/journal手术+文档Nit
**Branch**: `main`

### Summary

(Add summary)

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `d3614006` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 279: 10-13 功能分组提交+全量测试

**Date**: 2026-10-14
**Task**: 10-13 功能分组提交+全量测试
**Branch**: `main`

### Summary

(Add summary)

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `e08ea65e` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 280: Agent 通知 Phase A 实施（应用级 notification 域）

**Date**: 2026-10-12
**Task**: Agent 通知 Phase A 实施（应用级 notification 域）
**Branch**: `neeko-notify`

### Summary

核心交付：notification/{types,policy,center,dispatch,commands}.rs 应用级核心域（语义闭集 enum + 来源开集数据、纯函数裁决 15 单测）、agent/chat/notify.rs 投影 + spawn_session_pipeline 旁路挂接、FocusTracker 挂 on_window_event、AgentChatManager 可见会话槽 + agent_chat_set_visible、三层开关设置挂 config.json、tauri-plugin-notification 2.6.0 全链路 + extra.deepLink 点击精确回流（onAction）、前端 NotificationSettingsSection + 投递列表。pnpm check 24/24 护栏全绿（Rust 1579 + 前端 4675）；useAgentChat 按 ratchet 拆两个单职责 hook 并下调基线 834→824。待办：三平台人工肉眼验收、Phase B（CLI hook 摄入）实施。详见 .trellis/tasks/10-12-agent-notify。未提交代码。

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 281: Agent 通知 /neeko-check 审核整改

**Date**: 2026-10-12
**Task**: Agent 通知 /neeko-check 审核整改
**Branch**: `neeko-notify`

### Summary

按审核清单修复：①capabilities notification:default 收紧为 3 项最小权限；②notification/ 依赖方向防腐护栏 check_notification_core_direction + 自测 5 例 + 不变量台账登记（本地首个吃狗粮案例：护栏命中并修正了 mod.rs 注释自复述字面量）；③NotificationSettings::normalized() 边界归一（命令 set + config 读盘双入口，含 4 项 types 单测与 camelCase 契约钉子）；④双端常量镜像测试补齐：notification-delivered 事件名、extra deepLink 键、event_keys↔NOTIFIABLE_EVENTS；⑤测试投递构造下沉 dispatch（红线 6）；⑥设置前端保存串行链（RMW 丢更新防护）+ Switch 可访问名；⑦补 useVisibleChatSession/useMessagesCacheSync/NotificationSettingsSection 测试 11 例 + manager 可见槽 Rust 单测；⑧Focused 转发从 close.rs 移至 boot.rs 组合层。test_gates 计数 19→20 同步。pnpm check 25/25 全绿。未提交代码。

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 282: Agent 通知第三轮复检（能力面精确化 + 覆盖表有界）

**Date**: 2026-10-12
**Task**: Agent 通知第三轮复检（能力面精确化 + 覆盖表有界）
**Branch**: `neeko-notify`

### Summary

深检上轮整改自身，发现并修复：①capabilities 收紧不彻底——对照 @tauri-apps/api PluginListener.unregister() 源码确认 JS 侧真实用量仅 register/remove-listener 两条（allow-notify 是 JS sendNotification 的权限，无调用点；Rust 原生 API 不经 ACL 校验），移除 allow-notify；②NotificationSettings.event_overrides 无体积上限（磁盘可触达边界输入）→ MAX_EVENT_OVERRIDES=64，超限整体回空=跟随类别（确定性降级），+2 单测；③修复过程中引入并被编译器当场拦下：结构体模式不支持「..绑定其余字段」，且 FRU ..self 在部分移动后会重复移动（E0425/E0382）——normalized() 改为显式全字段解构重建。复核确认：SettingsPanel revert 为零 diff、护栏正则无假阳性、event_keys/deepLink 镜像测试内容匹配。pnpm check 25/25 复绿（Rust notification 27 测）。未提交代码。

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 283: Phase B 实装：外部 Agent CLI hook 摄入（源 B）

**Date**: 2026-10-12
**Task**: Phase B 实装：外部 Agent CLI hook 摄入（源 B）
**Branch**: `neeko-notify`

### Summary

响应用户「启动时 hooks 没注册」的反馈：诊断确认 Phase B 未实施（用户目录无 hook 文件），随即完成 B0-B3。B0 实测推翻设计假设：opencode 1.19 事件为 session.status(idle)/permission.asked、pi 1.1 为 agent_end/tool_call(askuserquestion|requestuserinput)/ui_prompt_start，design 映射表已修订。B1：agent/hooks/{attribution,endpoint,notify,server}.rs —— std TCP 手写最小 HTTP（零新依赖），ingest 纯内核 + fail-open 204；新 platform 主题 private_file（unix 0600+rename / windows 先删后改名）；27 单测。B2：writers 受管文件语义（标记/幂等/他人文件保护/三态状态）+ 两模板（endpoint 重读+mtime 缓存+800ms fail-open+hints）+ agent_hooks_apply/status 薄命令（命令归 agent 域，依赖方向护栏逼出的正确落位）+ 设置页 cliHooks 开关串行链。B3 真机验证：dev 启动 endpoint.env 0600 发布、curl 三向 204/403/204、无投递失败。pnpm check 25/25。遗留：自有 PTY env 注入（D8 第 1 级接线）、AC11/13/14 人工项（遵守客人义务未替用户安装）、B4 WSL。未提交代码。

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 284: CLI hooks 开启报错修复（opencode 目录事实源 + 开机收敛）

**Date**: 2026-10-12
**Task**: CLI hooks 开启报错修复（opencode 目录事实源 + 开机收敛）
**Branch**: `neeko-notify`

### Summary

用户设置页开启 hooks 报错「opencode skipped dir not initialized」。根因两条：①opencode_plugins_dir 误用 dirs::config_dir()（macOS 指到 Library/Application Support），opencode 实际约定 XDG_CONFIG_HOME/~/.config/opencode（用户机 open-island.js 实证）；②「目录不存在即跳过」策略过保守，用户显式同意安装却半套失败还被弹错误。修复：目录解析改 opencode 自身约定（+XDG 约定测试钉子）、install 自动 create_dir_all（客人边界守在文件内容不碰他人文件）、FE 结果三级分类（failed=error/skipped=info 中性/成功=简报）、新增 reconcile_action 开机收敛纯函数（设置是意图文件是事实，双向对齐，+5 断言）接 boot on_setup。真机验证：重启后日志 reconciling install → opencode: ok + pi unchanged，两文件落盘带标记，第二次启动零冗余（幂等）。29 Rust hooks 测 + FE 93 测 + 25/25 全绿。未提交代码。

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 285: macOS 系统通知修复：UNUserNotificationCenter 后端替换失效的 NSUserNotification

**Date**: 2026-10-12
**Task**: macOS 系统通知修复：UNUserNotificationCenter 后端替换失效的 NSUserNotification
**Branch**: `neeko-notify`

### Summary

用户反馈通知只在应用内可见、系统层无横幅。根因取证：tauri-plugin-notification 2.6.0 的 macOS 底座是 notify-rust 4.18 的 NSUserNotificationCenter 路径（Apple 已在 macOS 26+ 移除，调用成功但静默无显示，与日志零错误吻合；Linux/Windows 底座仍活）。修复：新 platform 主题 system_notify（红线 10 三平台形态：macos=UNUserNotificationCenter via objc2+block2，default=插件路径），dispatch 平台后端优先回退插件；裸 dev 二进制 bundleIdentifier 守卫防 UN abort（dev 无系统横幅为诚实现状，打包后走通）；thread_local 主线程缓存 center + 一次授权请求（denied 时区分弹窗未答/系统拒绝注册并带 NSError 描述）。真机验证：tauri build --debug 产 Neeko.app，注入 hook 事件 → 链路打到 requestAuthorization，系统授权弹窗挂起等待用户（上一轮未签名时报 denied 带出错误路径工作正常）。25/25 门禁全绿。遗留：用户在弹窗点允许后做最终横幅目视；UN 点击 delegate（userInfo deepLink 精确回流）登记后续。未提交代码。

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 286: Agent 通知第四轮 /neeko-check 审计与整改

**Date**: 2026-10-13
**Task**: Agent 通知第四轮 /neeko-check 审计与整改
**Branch**: `neeko-notify`

### Summary

增量审计 68 个文件，重点覆盖前三轮未审的 `agent/hooks/*`（Phase B 全域）、
`platform/{system_notify,private_file}/*`、`dispatch.rs` 平台回退、`app/boot.rs` 接线与前端
设置分区，产出 2 Block + 8 Warning + 6 Nit，本轮全部整改完毕。

### Main Changes

**Block 1 · 跨平台编译（红线 10 / CI 阻断）** —— `platform/system_notify/default.rs` 的 stub 被
clippy `missing_const_for_fn` 逼成 `const fn`，却按值收 `String` → 参数在函数尾要跑 `Drop` →
`E0493: destructor of String cannot be evaluated at compile-time`。在工作区内用同签名最小样本
实测复现。本地 `pnpm check` 25/25 是假绿：macOS 走 `macos.rs`，该文件根本不进编译单元，
Windows/Linux CI 矩阵一编译即红。修法 = 门面签名改 `&str`（借用无析构，`const fn` 合法且
红线 10 仍满足），owned 化下沉进真要跳主线程的 macOS 腿内部，`dispatch.rs` 两处 `.clone()`
随之消失（Win/Linux 不再为空 stub 白克隆）。陷阱已固化进
`.trellis/spec/backend/quality-guidelines.md`「平台差异集中化」。

**Block 2 · 域启动不变量** —— ingest 启动 + 开机收敛内联在组合根 `on_setup`（还在裸块里
`use ...writers`），违反 `src-tauri/AGENTS.md`「每域启动期只暴露一个 boot 入口，组合根只管
顺序与失败策略」；实测四域都有 `boot.rs`，唯独 `agent/hooks` 没有。新增
`agent/hooks/boot.rs::boot(app, neeko_dir, want_cli_hooks)`，入参给「具体事实」而非
`&AppStateWrapper`（对齐 `lsp::boot::attach` 既有写法），组合根降到一次调用。

**Warning 整改**
- 红线 13：`endpoint.rs` 的 `/tmp/x`、`writers.rs` 的 `/xdg-base-test` 夹具改 `tempdir()` 派生；
  `XDG_CONFIG_HOME` 改写包进 `ScopedEnv`（Drop 还原，断言 panic 也不污染同进程）。
- DRY / 开闭：`(source, 目录, 文件名, 模板)` 三处手抄 + `HOOK_TARGET_CLIS` 计数常量 +
  `server::KNOWN_SOURCES` 白名单（接第三个 CLI 要改 5 处，一致性只剩注释级约定）→ 合并为
  `targets::HOOK_TARGETS` 单表；writers 三动作变成对表的遍历，目录解析（环境事实）与文件动作
  （纯逻辑）分层为 `*_all` / `*_at`，后者可 tempdir 直测；ingest 路由白名单由表派生。
- 跨语言契约：hook 回执从 `Vec<String>`（前端 `includes('failed')` 嗅英文散文）改为机器可读
  `HookApplyOutcome{source,status,detail}` + `HookApplyStatus` 枚举，前端按 status 分类且只呈现
  失败/跳过项；补 Rust↔TS 镜像测试（5 枚举值 + 字段名），模板锚点测试改为引用 `TOKEN_HEADER` /
  `ENV_KEY_*` 常量本身。`HookInstallStatus.cli` 更名 `source`，与路由段同一个事实只留一个名字。
- 资源底线：accept 循环每连接无条件 `thread::spawn` 且无上限 → `InflightGuard`（RAII，拒绝路径
  必须归还 `fetch_add` 的计数，否则永久泄漏名额），上限 16 + 单测证明不泄漏。
- 护栏与文档一致：`check_notification_core_direction` docstring 声称禁 `app/core/…` 而元组里没有
  （`crate::app::` 静默漏检）→ docstring 改为「清单 = 元组本身」，元组补 `app`、删已不存在的
  `skill`，selftest 补 `crate::app::` 违规 / `crate::app_state::` 允许两条边界。
- 文档漂移：`dispatch.rs` 头「平台差异全部由插件处理」（UN 后端上线后为假）、`notification/mod.rs`
  同句、`endpoint.rs` 指向不存在的 `IngestServer::start`、design.md「官方插件即平台层」判断行
  → 全部按实测改写，design 增 v3.2 修订记录；`head_complete` 去掉无用入参；opencode 模板
  `sessionDirs` 加 200 上限防常驻进程无界增长。

### Git Commits

(No commits - 仓库约定「不要主动提交代码」)

### Testing

- [OK] `pnpm check` 25/25 全绿（Rust 单测 + 前端 + 461 条护栏用例 + eslint/tsc + clippy -D warnings）
- [OK] 新增/改写：`writers` 9 条（目录缺失创建 / 幂等 Applied+Unchanged / 他人文件与非 UTF-8
  双拒覆盖 / 状态四态 / 卸载三态 / 查询不建目录 / 模板锚点引常量 / 收敛决策 / 双端镜像契约）、
  `targets` 4 条（XDG 约定 + 空值兜底 + pi 目录 + 表自洽唯一性）、`server` 2 条
  （路由白名单派生自表 + InflightGuard 不泄漏名额）
- [--] 未做真机启动验证：另一工作树 `~/RustroverProjects/neeko` 有正在运行的 Neeko 实例，再起一个
  会用新端口/token 覆盖共享的 `~/.neeko/agent-hooks/endpoint.env`，打断用户当前实例的 hook 摄入，
  并与 `sessions.json` 抢同一份状态 —— 属侵入性副作用，停在单测 + 门禁层

### Status

[OK] **Completed**

### Next Steps

- macOS UN 后端点击 delegate（`userInfo.deepLink` 精确回流）未接，当前应用内列表兜底
- **已知限制（本轮新发现，未改语义）**：`version_current` 只比归属标记里的应用版本、不比模板正文
  → 同版本号内改模板不会自动推到用户机器（本轮 `sessionDirs` 上限即属此类）。改成与 `render()`
  全文比对可自愈，但会覆盖用户对受管文件的手改；模板头写的是「请勿原地编辑」，两种语义都说得通，
  留给下次决策
- `platform/notify_base` 与新增 `system_notify` 名字相邻易误读（实为浏览器注入 URI 基地址，
  零重叠），更名 `uri_base` 待办
- 自有 PTY 的 `NEEKO_SESSION_ID/PROJECT_ID` env 注入未接线（归属链第 1 级数据源）
- B4 WSL / E5 SSH 可达性；AC11/13/14 人工目视项；代码待用户授权后提交


## Session 287: opencode-2x插件与通知兼容

**Date**: 2026-10-14
**Task**: opencode-2x插件与通知兼容
**Branch**: `main`

### Summary

(Add summary)

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c5d84e6f` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 288: git-conflict-diff-view: Layer 1 批 0+批 1（纯语义层 + 读路径）

**Date**: 2026-10-14
**Task**: git-conflict-diff-view: Layer 1 批 0+批 1（纯语义层 + 读路径）
**Branch**: `main`

### Summary

以 index unmerged stages 为唯一真值读冲突三侧；批 0 纯语义（classify/regions/cap），批 1 双 transport 读路径。41 条 conflict 测试绿，29 护栏全过，1690 lib 测试无回归。

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 289: git-conflict-diff-view: Layer 1 批 2（前端只读展示，修跨 transport 分叉）

**Date**: 2026-10-14
**Task**: git-conflict-diff-view: Layer 1 批 2（前端只读展示，修跨 transport 分叉）
**Branch**: `main`

### Summary

前端冲突视图：DiffRevision 加 conflict variant（不新增 TabData.kind）、useConflictStages（Err→notConflicted 收敛非错误）、ConflictView 三侧只读 + 区域 + 未接决议。R6 入口决策复用 isConflictedEntry（零新增 prop）。66 文件 572 测试绿，29 护栏全过。

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 290: git-conflict-diff-view: Layer 1 批 4+批 5（护栏 A1-A4 + spec 沉淀 + @@ 登记 + pnpm check 全绿）

**Date**: 2026-10-14
**Task**: git-conflict-diff-view: Layer 1 批 4+批 5（护栏 A1-A4 + spec 沉淀 + @@ 登记 + pnpm check 全绿）
**Branch**: `main`

### Summary

新增护栏 check_conflict_read_contract（A1-A4，目标恒零）与同名测试 15 例；git-domain §5c 冲突读路径三态契约 + @@ 静默丢弃登记（R11）；docs/domain-model 冲突小节；10 条 Layer 1 AC 全勾。30 护栏全过。

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 291: git-conflict-diff-view: Layer 1 独立复核（修 2 处跨 transport 真分叉）

**Date**: 2026-10-15
**Task**: git-conflict-diff-view: Layer 1 独立复核（修 2 处跨 transport 真分叉）
**Branch**: `main`

### Summary

trellis-check 发现并修复：P1 shell other_commit 用 .ok()? 在首个缺失 ref 提前退出 → cherry-pick 的 rename/rename 退化 modify_delete；P2 shell size 用 lossy String 长度 → 非 UTF-8 blob 两 transport size 分叉（改 git cat-file -s）。3 条回归钉子经变异验证可红。Layer 1 完成。

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 292: git-conflict-diff-view: 审核修复（Block /dev/null + DRY 收敛 + region_mergeable 上 wire + 惰性映射 + A5/A6 护栏）

**Date**: 2026-10-15
**Task**: git-conflict-diff-view: 审核修复（Block /dev/null + DRY 收敛 + region_mergeable 上 wire + 惰性映射 + A5/A6 护栏）
**Branch**: `main`

### Summary

修 /neeko-check 的 5 条发现；44 条既有测试断言未改，新增 12 后端 + 2 前端钉子，护栏扩至 A1–A6；每条修复均经变异验证可红

### Main Changes

### Summary

修复 `/neeko-check` 审出的 5 条（1 Block + 3 Warning + 1 Nit），并为其中 2 条补上机器判据。
Layer 1 的 44 条既有测试**断言一字未改**（行为保持型重构），新增 12 条后端 + 2 条前端钉子。

### 修了什么

1. **[Block] `/dev/null` 不可移植** —— `shell.rs::empty_blob_oid` 改用
   `run_git_with_stdin(&["hash-object","-t","blob","--stdin"], …, b"")`。`/dev/null` 是 POSIX 设备名，
   Windows 上不存在，而 backend-test 的 CI 矩阵含 windows-latest ⇒ AA 冲突会在 Windows 上读不出三侧。
   **为何靠护栏而不是测试**：`/dev/null` 在 macOS/Linux 上行为完全正确，夹具测试在 POSIX 上永远绿 ——
   只有静态判据能在写下当时拦住它。新增护栏判据 **A5**（只扫引号内串；实测覆盖普通串 / `r"…"` /
   `r#"…"#` / argv 内嵌四种形态；注释里的解释合法，否则护栏会逼人删掉恰好防止回潮的那段文档）。
2. **[W1] 领域算法按 transport 重复** —— `distinct_paths` / `side_lines` 曾各持一份（md5 逐字相同），
   两份 `assemble` 整段同构。收敛到 `probe.rs`：`ConflictSides` → `assemble_stages`
   （**`ConflictStages` 唯一构造点**）→ `attach_regions`。两 transport 现在只剩「怎么取三侧字节 +
   怎么取 merge 文本」。新增护栏判据 **A6**（传输实现不得自建 `ConflictStages` 字面量）——
   删掉重复只是清今天，护栏才能拦住明天。
3. **[W2] 前端第二份领域判据** —— 删掉 `ConflictView.isRegionMergeable`，改由后端在唯一构造点派生
   `region_mergeable` 上 wire。**不能用 `merged != null` 反推**：`merged` 是派生展示数据，其存在与否由
   载荷预算支配而非语义支配，两者同进退只是巧合（复核时发现我最初写的理由是假的 —— cap 截断后总回填
   `Some(capped)`，从不置 null；已改正为真实理由并补钉子）。
4. **[W3] `default:` 削弱穷尽性** —— `ConflictOpaqueCard` 改为对 `ConflictKind` 穷尽 switch、header 与
   body 合并成一张文案表（对齐同目录 `ConflictToolbar.kindLabel`）。
5. **[Nit] 每次读冲突白跑全仓 tree diff** —— 新增纯判据 `probe::needs_rename_maps`：仅当 stage 1/2/3
   **全部落在同一路径**（常见 UU）才跳过重命名映射。实测取证：当 stage1 存在于路径 P 时，P 在
   merge-base 就已存在（`diff --name-status -M` 报 `M` 而非 `A`），git 不可能把任何文件配对成「重命名到 P」
   ⇒「三侧同路径」与「该路径是重命名目标」在 git 语义上互斥，惰性判据的交叠情形不可达。

### 变异验证（每条钉子都证明可红）

| 变异 | 结果 | 含义 |
| --- | --- | --- |
| `needs_rename_maps` 恒 `false`（永远跳过） | 6 条红，含 2 条端到端 rename/rename | 判据是载荷性的 |
| `needs_rename_maps` 恒 `true`（永远算，= 修复前行为） | 仅判据自身单测红，端到端全绿 | 惰化是纯优化，不改变分类结论 |
| `ConflictView` 改回 `kind === 'both_modified' \|\| …` | 新钉子红 | W2 已收口 |
| `ConflictView` 改回 `merged !== null` | 2 条钉子红 | 假理由也被钉住了 |
| 给 `ConflictKind` 加 `'future_kind'` | 现状：OpaqueCard + Toolbar 双双 TS2366；恢复 `default:` 后只有 Toolbar 失败、OpaqueCard **静默通过** | W3 指控的形态已消除 |
| 护栏植入 `/dev/null` 字面量 / `unwrap_or_default()` / `ConflictStages { … }` | A5 / A2 / A6 各 VIOLATION（exit 1） | 三条判据在真实仓库可红 |

A6 首版把「返回类型位置 `-> ConflictStages {`」整行豁免，被自己的测试
`test_new_transport_file_is_in_scope_without_registration` 逮住（单行函数里签名与真构造可共存）⇒
改为「先剥除返回类型位置，再找字面量」。误报的结局是逼人放宽判据，比没护栏更糟。

### Testing

- `cargo test … conflict` → **56 passed**（44 Layer 1 基线断言未改 + 12 新增）
- `npx vitest run src/features/git` → 66 文件 / **575 用例**
- `tools/guards/tests` → **549 用例全绿**（护栏自身 23 条）
- `pnpm check` → **30/30 护栏通过**（含 lint_fe=tsc、clippy 全目标、test_fe/test_rust/test_host）

### 复核方式说明

`trellis-check` 子代理这次**没有文件/命令工具**，它拒绝在无证据下填写 ✓/行号/计数（正确行为 ——
伪造的复核比缺失的复核危险）。其提出的 3 条待查点由主会话逐条实测收口，其中第 1 条命中真问题
（design.md 落点图把 `probe.rs` 标为「纯 I/O」，已升级为「纯逻辑」并如实描述新增职责），
第 2 条纠出了我自己写下的假理由。

### 文档同步

`git-domain.md` §5c（新增 4 段可执行契约 + 护栏扩至 A1–A6）、`docs/domain-model.md`（`region_mergeable`
入术语表）、任务 `design.md`（落点图 / §2.1 stages / §3 A5+A6 / §2.4 空 blob 写法）、`implement.md`、
`invariants.json` note。

### Status

[OK] **Completed** —— 改动停在未提交状态（项目规则：不主动提交）。

### Next Steps

- 用户决定是否提交；Layer 2（`10-14-git-conflict-resolve`）硬前置 = 本轮 + Layer 1 批 0/1/2 已合入。
- 端到端 GUI 手测（`pnpm tauri dev`）与真 WSL/SSH transport 仍未执行（本机无 GUI），已如实登记。


### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 293: 冲突决议闭环（Layer 2）：三条写回原语 + stage 存在性分派 + 区域 splice

**Date**: 2026-10-15
**Task**: 冲突决议闭环（Layer 2）：三条写回原语 + stage 存在性分派 + 区域 splice
**Branch**: `main`

### Summary

实现期修正 design 缺陷（binary/截断被当删除侧）；后端 apply_conflict_resolution（write_text/checkout_side/delete_path）+ resolve_conflict 命令 + splice_regions 纯函数；前端 useConflictResolve + 决议按钮；删除侧四分支逐条断言（porcelain 逐例不同）；T18 变异验证可红；pnpm check 30/30 全绿

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 294: 冲突决议审查整改：区域决议全函数化（修 Block 静默半截 + Warning 分批契约）

**Date**: 2026-10-15
**Task**: 冲突决议审查整改：区域决议全函数化（修 Block 静默半截 + Warning 分批契约）
**Branch**: `main`

### Summary

neeko-check 发现：未知/缺失 region id 被 splice_regions 静默丢弃后仍 git add → 带 marker 的文件被标为已解决（可提交）。按第一性原理修复：区域决议是全函数，新增纯函数 validate_region_decisions（id 集合必须恰好相等，无未知/缺失/重复），前端 canApply 要求 regions.size===regionCount；分批决议改由草稿累积实现。T20 变异验证可红。后端 conflict 78 绿 / 前端 19 绿 / pnpm check 30/30

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 295: 冲突决议复审：UU 整文件决议可达性修复（声明与实现一致）

**Date**: 2026-10-15
**Task**: 冲突决议复审：UU 整文件决议可达性修复（声明与实现一致）
**Branch**: `main`

### Summary

第二轮 neeko-check 复审发现：PRD AC 表要求「UU 支持整文件二选一」，后端支持但前端把 UU 的整文件按钮隐藏（wholeFileResolvable = resolvable && !regionMergeable），且前端测试把该缺口固化成期望。修复为 wholeFileResolvable = resolvable（UU 同时给区域与整文件按钮，草稿互斥），修正测试断言 + 新增后端 uu_whole_file 用例。conflict 79 绿 / 前端 20 绿 / pnpm check 30/30

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 296: 编辑器 tab 状态单源化（删除 activeTabId/order 双表示）

**Date**: 2026-10-15
**Task**: 编辑器 tab 状态单源化（删除 activeTabId/order 双表示）
**Branch**: `main`

### Summary

从状态模型层面根治：删除 ProjectTabs.activeTabId / Tab.order / 顶层 activeTabId，新增 editorTabSelectors 唯一派生点；分屏/换 pane/pin 后拖拽与 Cmd+W 落点正确

### Main Changes

### 任务
`10-15-editor-tab-single-source` — 编辑器 tab 状态单源化（根治，非补同步）。

### 诊断（第一性原理）
用户实测「分屏后拖文件落到上一个 pane 的输入框」。定位：`editorStore` 把同一「tab 空间」用两个结构描述
（平铺的 `ProjectTabs{tabs, activeTabId}` + `Tab.order`，与分屏权威 `editorLayout`），于是「哪个 tab 在前台」
与「tab 顺序」**各有两个表示**。分屏前两者恰好重合、冗余无害；2026-05-13 引入分屏后分离，冗余即缺陷。
从分屏出生起 `setActiveGroup` 就只改布局不同步投影 → 是**约定**而非**构造**；已落地补丁 `projectActiveTab`
实测仍漏 `pinTab`/`unpinTab` —— 证明「逐点补同步」不是根治。

### 方案
删字段让错误不可表示：删除 `ProjectTabs.activeTabId` / `Tab.order` / 顶层 `EditorStoreState.activeTabId` /
`restoreActiveTabId`（含 4 处调用）/ 补丁 `projectActiveTab`。新增唯一派生点
`src/shared/store/editorTabSelectors.ts`（`selectActiveTabId` / `selectOrderedTabIds` / `selectOrderedTabs` /
`selectActiveTab`）。布局成为唯一权威：顺序 = `groups[*].tabIds`（左→右→pinned），前台 =
`groups[activeGroupId].activeTabId`。pinned 激活态保持正交（有意保留）。

### 执行
- 批 1 建派生点 + AC 用例（Red 先行）；批 2 改全部读点；批 3 删字段（TS 编译期列全漏改点）；批 4 护栏 + 文档；
  批 5 验证。80+ 文件改动，含 14 个测试文件夹具迁移（跨两个并行子代理）。
- 护栏：A1 的 `owner` 概念退役（删 `Tab.order` 后那处唯一 sort 彻底消失，顺序改为纯数据派生）；新增 A5
  判据钉住三字段不得回潮。

### 验证
- `pnpm test:fe` 552 files / 4841 passed；`pnpm check` 30/30；`type-check` 干净。
- Red 已实测：AC1/AC2（前台错位）、AC4（顺序陈旧）在旧读法下必红，恢复即绿。
- AC5 四符号字面零命中。

### 审查（trellis-check 独立验证）发现并修复
1. 漏删的生产构造点 `PaneContent.tsx` 的 `order: 0` —— 被赋给推断类型的 `const tab`，绕过 tsc 的
   excess-property 检查。修复：删字段 + 显式标注 `const tab: Tab`。
2. AC5 过度声称：测试夹具约 40 处对已删字段的死写入（`tsconfig` 排除 `__tests__` 故不可见）。已全量清扫。
附带：A5 regex 放宽覆盖 `activeTabId?:` / `readonly order?:` 变体；`terminalRouting` 两处陈旧 docstring 改写。

### 交付物
`prd.md` / `design.md` / `implement.md`（含 Red 证据 + 验收结果 + 审查修复记录）；
spec 同步：`state-management.md`（新增「编辑器 tab 前台/顺序单源化」场景七段契约）/ `interaction-patterns.md` /
`docs/domain-model.md`。


### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 297: Guard wall clock: --jobs auto and node-environment migration
<!-- trellis-session: v=2 fp=b1944b4418196cbe -->

**Date**: 2026-10-16
**Task**: Guard wall clock: --jobs auto and node-environment migration
**Branch**: `main`

### Summary

Cut pnpm check wall clock by making command gates concurrent and moving DOM-free test files to the node vitest environment.

### Main Changes

- perf(guards): add --jobs auto so the framework derives min(cpu_count, 4); point check and lefthook's pre-push at it instead of a literal.
- Add A5 to check_gate_topology plus the gate-jobs-derivation-single-source invariant: call sites must write auto, never a literal cap.
- test(frontend): opt 24 DOM-free suites into the node environment via docblock; four candidates rolled back on transitive DOM deps.
- Docs: quality-guidelines, frontend-testing and invariant-enforcement synced to the new behavior.

### Git Commits

| Hash | Message |
|------|---------|
| `683f0e7d` | perf(guards): run command gates concurrently in the local stage |
| `934b2036` | test(frontend): move DOM-free suites to the node vitest environment |
| `3c63b07d` | docs(trellis): record the guard concurrency and node-environment migration |

### Testing

- [OK] pnpm check 30/30 guards green, 0 violations
- [OK] pnpm test: test_fe / test_rust / test_host all pass; guards self-test 570 OK
- [OK] Measured idle window: 135s -> 82s wall clock (-39%); converges to the test_fe floor
- [OK] Mutation-verified A5 catches a literal --jobs 4 before revert

### Status

[OK] **Completed**

### Next Steps

- AC1-AC6 all satisfied; task ready for finish-work


## Session 298: 冲突决议闭环（Layer 2）收尾核验与归档
<!-- trellis-session: v=2 fp=1f0ab38f69c4b698 -->

**Date**: 2026-10-16
**Task**: 冲突决议闭环（Layer 2）收尾核验与归档
**Branch**: `main`

### Summary

核验 10-14-git-conflict-resolve 全部 AC 已落地并全量门禁复跑通过；spec 沉淀完成（git-domain.md §5d + docs/domain-model.md）；记录 session 并归档任务。

### Main Changes

- 后端 apply_conflict_resolution 三条写回原语（write_text / checkout_side / delete_path）+ resolve_conflict 命令（写后 wait_status_fresh 收口），分派判据 = stage 存在性而非 content 存在性（T18）。
- 前端 useConflictResolve + ConflictView 决议按钮（区域 Ours/Theirs/Both 与整文件二选一互斥草稿），收敛走既有 notConflicted 路径。
- 删除侧四分支逐条断言（porcelain 逐例不同），binary 选对方不得删文件，rename/rename 与不可合并 kind 显式报错；区域决议全函数化（validate_region_decisions）。
- spec 沉淀：.trellis/spec/backend/git-domain.md §5d 决议写回小节 + docs/domain-model.md git 冲突决议小节。

### Git Commits

| Hash | Message |
|------|---------|
| `43bc29d7` | feat(git): resolve conflicts by writing whole sides or per-region splices |
| `02d5a784` | docs(trellis): record git-conflict-resolve Layer 2 sessions and task state |

### Testing

- [OK] cargo test conflict：79 passed / 0 failed（含 T18/T19/T20 变异可红的回归钉子）。
- [OK] npx vitest run src/features/git：68 files / 596 passed。
- [OK] pnpm lint：27 条护栏全过 / 617 护栏自测 OK / lint_fe(tsc) / lint_rust_all_targets 干净。
- [OK] pnpm check：30 条护栏全通过 / 0 违规 / 0 失效（test_fe + test_host + test_rust 全绿）。

### Status

[OK] **Completed**

### Next Steps

- 端到端 GUI 手测（pnpm tauri dev：造 UU/DU/UD/binary 冲突→决议→写回→视图收敛）与真 WSL/SSH transport 仍未执行（本机无 GUI），已如实登记为非自动化项。
- rebase 场景（--ours/--theirs 语义相反）按父任务 T4 登记不修。


## Session 299: opencode 2.x 插件与通知兼容收尾核验与归档
<!-- trellis-session: v=2 fp=0c34e385eb0fd603 -->

**Date**: 2026-10-16
**Task**: opencode 2.x 插件与通知兼容收尾核验与归档
**Branch**: `main`

### Summary

核验 10-14-opencode-2x-support 四项 AC 全部落地；V2 插件与通知模板已随 0ec055df / 16163f31 合入 main，工作区无遗留改动；记录 session 并归档。

### Main Changes

- V2 重写三个项目插件（trellis-inject-subagent / trellis-session-start / trellis-workflow-state，{id, setup} 裸对象零依赖），形状检查全过。
- 通知模板 neeko-opencode-status-v2.js 接入 targets.rs（安装文件名不变，版本号变化触发重装）；V1 模板与 V1 插件文件物理冻结在 plugins-v1/ 存档。
- Rust 侧 V2 契约锚点测试 opencode_v2_template_keep_contract_anchors（形状 + V2 生命周期事件 + 上报硬约束 + V1 已死形态不得出现）。

### Git Commits

| Hash | Message |
|------|---------|
| `0ec055df` | feat(agent-hooks): add OpenCode 2.x status reporter template |
| `16163f31` | feat(agent-hooks): support multi-instance coordinates and content-addressed markers |
| `81e05f5d` | chore(release): bump the version to 1.0.9 |

### Testing

- [OK] node --check 4 个文件全过；check-plugin-shape.mjs 三个插件 ok（id 唯一）。
- [OK] cargo test agent::hooks：48 passed / 0 failed。
- [OK] opencode.log 中我方 4 个文件在 10-15/10-16 重启后均为 loading plugin（无 failed to load）；历史失败记录全部早于 10-14 修复。真机 ~/.config/opencode/plugins/neeko-status.js 正文与 V2 模板逐字节一致。
- [OK] pnpm check：30 条护栏全通过 / 0 违规 / 0 失效。

### Status

[OK] **Completed**

### Next Steps

- 真机 opencode 触发一次 turn 完成与一次 permission 的手工确认仍待执行（需用户在真实 CLI 会话操作）；open-island.js 为用户个人插件，其 V1 拒载故障需另行告知用户（本任务非目标）。
