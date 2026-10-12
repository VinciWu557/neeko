# 迁移证据：断言守恒对照表 + 基线计数轨迹

> 任务：`.trellis/tasks/10-11-test-platform-cfg-item-scope`
> 纪律（design.md §5）：① 断言守恒；② 只动测试；③ 每批独立可回滚、基线单调下降。

## 基线计数轨迹

| 节点 | 测试域 fragment | 说明 |
| --- | --- | --- |
| 批 1 上锁 | **38**（stmt 25 / block 13，12 文件） | 判据清空自检：38 处逐行 = design 附录 A |
| 批 A 后 | **29**（−9） | `file/commands.rs` block 7→0；`lsp/session/instance.rs` stmt 2→0 |
| 批 B 后 | **17**（−12） | `core/exec.rs` 7→0；`core/exec_env.rs` 3→0；`common/utils/command/local.rs` 2→0 |
| 批 C/D 后 | **5**（−12） | `lsp/process.rs` 4→0；`browser/url_validator.rs` 2→0；`common/git/{checkout_path,path_guard,workspace_ref}.rs` 各 2→0 |
| 批 E 后 | **0**（−5） | `platform/watch_backend/types.rs` 3→0；`common/file/watcher/registration/tests.rs` 2→0 |
| 清账 | **0**（台账已删除） | 零容忍生效：无台账 = 空基线（DoD 终态） |

## 批 A：`file/commands.rs` + `lsp/session/instance.rs`（9 处 → 整测试）

| 迁移前（fragment） | 断言 | 迁移后（整测试） | 断言 | 语义等价说明 |
| --- | --- | --- | --- | --- |
| `commands.rs:206` `#[cfg(windows)] { … }` | 3 | `normalize_path_windows_uses_backslashes`（`#[cfg(windows)]`） | 3 | 逐条：`C:/→C:\`、`C:\→C:\`、`./→.\` |
| `commands.rs:257` Windows 块 | 3 | `reveal_file_uses_select_prefix` | 3 | 程序名 `explorer` / 1 参数 / `/select,` 前缀 |
| `commands.rs:264` macOS 块 | 2 | `reveal_file_uses_open_reveal_flag` | 2 | 程序名 `open` / `args[0] == "-R"` |
| `commands.rs:271` Linux 块 | 3 | `reveal_file_opens_parent_dir` | 3 | 程序名 `xdg-open` / 1 参数 / 父目录 |
| `commands.rs:292` Windows 块 | 2 | `reveal_dir_uses_explorer` | 2 | 程序名 `explorer` / 1 参数 |
| `commands.rs:298` macOS 块 | 2 | `reveal_dir_uses_open` | 2 | 程序名 `open` / 1 参数 |
| `commands.rs:304` Linux 块 | 3 | `reveal_dir_uses_xdg_open` | 3 | 程序名 `xdg-open` / 1 参数 / 目录路径 |
| `instance.rs:1190` Windows 断言行 | 1 | `snapshot_server_info_memory_is_zero_on_windows` | 1 | `memory_mb == 0.0`（Windows 采样按设计跳过） |
| `instance.rs:1192` 非 Windows 断言 | 1 | `snapshot_server_info_refreshes_live_memory` | 1 | `memory_mb > 0.0`（活体 RSS） |
| 附带：`assert!(cmd.is_some())` ×2 | 2 | `reveal_command_for()` 的 `.expect()`（6 个平台测试各调一次） | 6 | `None → panic`，语义被包含而非削弱 |

**顺带收益**：`test_normalize_path_windows` 在非 Windows 原为空测试（空跑侵蚀）→ 现在整测试门控，
平台缺失的腿在测试名上肉眼可见；`file/commands.rs` 的 Linux 腿在本会话修复前是零断言（已在新整测试中补齐）。

## 批 B：`core/exec.rs` + `core/exec_env.rs` + `common/utils/command/local.rs`（12 处）

| 迁移前（fragment） | 迁移后（item 级） | 断言 / expect 守恒 | 说明 |
| --- | --- | --- | --- |
| `exec.rs:517`、`exec_env.rs:120`、`local.rs:297`、`local.rs:348`（chmod 裸块 ×4） | `common::testing::make_executable`（`#[cfg(unix)]` 实现 + `#[cfg(not(unix))]` 空 stub） | 每处 2 个 `expect`（metadata / chmod）+ 2 条动作 → helper 内 1:1 保留；4 个调用点各 1 行 | **DRY 归并**（4 份 9 行 → 1 份；越过「重复 ≥3」线）；调用点无条件 |
| `exec.rs:609/611`（boom 脚本对） | `#[cfg(unix)]/#[cfg(windows)] const BOOM_SCRIPT` | 2 断言不变（exit_code==3 / stderr 含 boom） | 两腿都是真实定义 |
| `exec.rs:636/638`（cwd+env 脚本对） | `const CWD_ENV_SCRIPT`（两腿） | 3 断言不变 | 同上 |
| `exec.rs:671/673`（exit 3 脚本对） | `const EXIT3_SCRIPT`（两腿） | 1 断言不变 | 同上 |
| `exec_env.rs:101/103`（cmd / sh 断言） | `should_report_true_for_cmd_on_windows` + `should_report_true_for_a_posix_shell`（两个整测试） | 1 断言各一 → 共 2 | 平台维度上移测试名 |

## 批 C：`lsp/process.rs` + `browser/url_validator.rs`（6 处）

| 迁移前 | 迁移后 | 断言守恒 | 说明 |
| --- | --- | --- | --- |
| `process.rs:246/248`（pwd/cd 对） | `const CWD_SCRIPT`（两腿） | 不变 | 探测 cwd 语义未变（P2a） |
| `process.rs:319/321`（no-such-binary 对） | `const NO_SUCH_BINARY_SCRIPT`（两腿） | 不变 | 版本文案逐字保留 |
| `url_validator.rs:229/231`（平台绝对路径样例） | `windows_drive_path_is_absolute` + `posix_path_is_absolute`（两个整测试） | 1 断言各一 → 共 2 | 断言语义（`is_absolute()`）不变 |

## 批 D：`common/git/{checkout_path,path_guard,workspace_ref}.rs`（6 处）

| 迁移前 | 迁移后 | 说明 |
| --- | --- | --- |
| 三文件各一对 `#[cfg(unix)] symlink` / `#[cfg(windows)] symlink_dir` | `common::testing::symlink_dir`（**两腿都是真实实现**，无 stub；缺腿则编译错误） | DRY 归并（3 份 → 1 份）；`path_guard.rs` 顺带把 `root.join("src/link")` 提为局部 `outside_link`（可读性） |

## 批 E：`platform/watch_backend/types.rs` + `common/file/watcher/registration/tests.rs`（5 处）

| 迁移前 | 迁移后 | 断言守恒 | 说明 |
| --- | --- | --- | --- |
| `types.rs:60/65/70`（三平台后端断言） | `watch_backend_is_*_on_{linux,macos,windows}`（三个整测试） | 1 断言 ×3 → 3 | 平台维度上移测试名 |
| `tests.rs:360/368`（`on_rules_changed` 两端语义） | `on_rules_changed_unwatches_all_then_reregisters`（linux）+ `on_rules_changed_is_noop_for_recursive_platforms`（非 linux）；准备流程提 item 级 helper `register_then_change_rules` + 夹具 `prepare_rules_change_repo` | 2+2 断言逐条保留 | 两端语义各自成为独立测试名的**契约**；`.gitignore` 夹具由多行字面量改为 `"unused\n"`（等值） |

> 批 E 完成后：**测试域 fragment = 0**，删除 `tools/guards/ledger/platform_test_cfg.json` → 护栏进入零容忍。

---

# 评审修复记录（neeko-check 增量审核后）

审核范围：本任务 25 项改动。发现并修复的问题（逐条按第一性原理定位根因）：

| # | 级别 | 根因（第一性原理） | 修复 |
| --- | --- | --- | --- |
| 1 | Block | **「有无块体」不能按 item 种类枚举**：对无体 item（`use`/`const`/字段）做花括号配平，必然向后匹配到**别的 item** 的 `{` → 生产代码被吞进测试域（实测误报）。判据应是结构性的：头部终止符（深度 0 的 `;`/`,`）前是否出现 `{` | `core/rust_cfg.py` 新增 `body_open_line()`（结构性、括号深度感知、不枚举种类）；`find_cfg_gated_ranges` 与 `test_domain_ranges` 共用；删除脆弱的 `BLOCK_PREFIXES` 前缀启发式。回归测试 2 条（误报形态 + 非平台 cfg 忽略） |
| 2 | Warning | **夹具的资源生命周期必须由消费者作用域界定**（RAII）：返回裸路径 = 丢失所有者 → 只能人工清理，且固定名在系统 TEMP 里可被外部状态撞成存在 | `file/commands.rs` 夹具改为接收 `&Path`（由调用方的 `tempdir()` 派生）：6 个平台测试 + 3 个平台无关测试去固定名、去 6 处手工清理；`collapsed_probe.rs` 的「不存在路径」改为 tempdir 派生（保证不存在） |
| 3 | Warning | **约束必须与其强制层级同层**：红线 10 全文只覆盖生产域，测试域豁免只写在 spec → 两处措辞不同步，按红线全文字面审查会误判 | `src-tauri/AGENTS.md` 红线 10 内补「测试域只允许 item 级门控」条款（含判据指针），体积 12,305B（上限 16,384B） |
| 4 | Warning | **同一资源的所有权原则应全仓一致**：`services/tests` 的 `temp_root` 返回裸 `PathBuf`，28 处调用点里只有部分写了人工清理 | `TestRoot` newtype（持有 `TempDir`，`Deref<Path>` + `AsRef<Path>` 保持 28 处调用点写法；仅 7 处 `root.clone()` → `to_path_buf()`）。`AsRef` 由编译器证明必需，非预防性抽象 |
| 5 | Nit | 可读性：命名与职责漂移、位置记忆、粒度不对称缺解释 | guard：`stale_notes` → `baseline_notes`；`collect()` 4 元组 → `ScanResult` dataclass；`evaluate` 补两种报告粒度的理由；docstring 生成命令同步 |
| 6 | Nit | DRY：两处 4 行构造重复 | `instance.rs` 提 `live_process_session()`（返回 `LspSession`，规避 `LspServerInfo` 可见性；两平台测试共用） |

**回归证据（修复后）**：两条护栏单测 23 + 29 全绿；本仓 `测试域门控 68 处 / fragment 0 处`（无覆盖损失）；
修复前基线 4 个消费者点逐行命中（等价性保持）；`file::commands` 7 / `services` 41 / `status_worker` 26 /
`instance` 29 测试全绿；`pnpm check` 24 条护栏全绿。

**未改动（判定为不适用/合理，附理由）**：`agent/chat/adapter/serve.rs:1506` 的 `env::temp_dir()` 是
项目 id 的纯字符串语义（非夹具路径）；`url_validator.rs` 的 `/tmp`、`C:\tmp` 是**被断言对象**
（路径语义取样）且已整测试门控（红线 13 不适用）；`path_ops.rs` 中残留的 `remove_dir_all(&root)`
现为冗余（TempDir 已负责回收）但无害，留待下次触碰该文件时清理。
