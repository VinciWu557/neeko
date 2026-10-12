# 技术设计：测试码平台门控只许挂 item

> 任务：`.trellis/tasks/10-11-test-platform-cfg-item-scope`
> 目标：把「平台的编译配置可分离」这一类失败从**靠检测**改为**不可写出**，并把测试侧存量收敛到零。
> 本文件从第一性原理推导判据与结构，不从「最小改动」倒推。

---

## 0. 第一性原理：门控粒度必须 ≥ 作用域粒度

### 0.1 不变量

> **I（消费者可达性）**：对任一名字（绑定、导入、常量），在其每个消费者存在的编译配置下，定义必须存在。
> 违反 I 的后果就是本类事故：某配置下定义为 `unused_*`，被 `-D warnings` 升级为编译错误。

### 0.2 I 被违反的唯一结构条件

设名字的**定义位置**与其**使用位置**分别受门控。若门控粒度 < 作用域粒度（即门控挂在**片段**上），
定义与使用就可能落在**不同的编译配置集合**中 —— I 被违反。反之：

> **C1**：门控粒度 = item 粒度（整测试 / 整 helper / 整模块）时，item 内部的所有消费者与 item 同生共死，
> **I 不可违反**（by construction）。

### 0.3 推论（决定了本任务用什么手段）

- **C2（判据落在"附着位置"，不落在"消费者分析"）**：C1 是**语法位置属性**，可以完备、零误报地检查；
  而"消费者分析"是语义近似 —— 本轮实测同一事故有四种形态（顶层 import / `let` / 测试内 `use` / 多行 `assert`），
  且参数、`for` 绑定、宏生成、同名遮蔽仍会漏。**结构约束优于检测**。
- **C3（测试域可以先一刀切）**：生产码存在**派生门控** —— match arm / 字段 init 镜像 cfg-gated 的
  变体 / 字段声明，是类型结构的强制后果，不能只靠禁令（需要类型平台中立化，属 L1）。测试域实测
  **零派生形态**（38 处全是语句 / 裸块），因此可以用最严格的禁令，且**不设逃生口**。
- **C4（禁令的正确形式）**：不是"禁止平台分支"，而是"**把门控提到 item 级**"。三条正路：
  ① 整测试（平台维度上移测试名）；② item 级 gated helper（每个平台都有腿）；③ 平台适配器数据。

---

## 1. 取证

### 1.1 口径修正：按"附着形态"判定，不用缩进代理

首轮统计用「cfg 属性缩进 ≥ 8」代理"在函数体内"，**会漏浅缩进测试文件**：`common/file/watcher/registration/tests.rs:360/368`
（外部测试模块，属性在缩进 4）就是这样漏网的。权威口径 = **附着构造的形态**（跳过后续属性 / 空行 / 文档注释后，
首个非空行是否为 item 声明）。本设计全部数字用此口径。

### 1.2 substrate 面积（权威口径，实测）

| 域 | item 级门控（合法） | **fragment 门控（判据目标）** | 形态分布 |
| --- | --- | --- | --- |
| 测试域 | 40 | **38** | 语句 25（let 12 + 断言/表达式 13）、裸块 13；**零 arm / 零字段 init** |
| 生产域 | — | **44** | 语句 15 + 裸块 18 + let 8 + arm 7（派生）+ 字段 init 1（派生）等 |

> 测试域 38 处全量清单见**附录 A**（含 recipe 归属）；生产域 44 处清单见**附录 B**（L1 输入）。
> 生产域另有 4 处**声明位置**门控（枚举变体 ×2、结构体字段 ×1、函数参数 ×1）在 L1 里按"类型平台中立化"处理，
> 不计入 44（形态判定见附录 B 备注）。

### 1.3 测试域的三个识别形态（护栏必须都覆盖）

| 形态 | 实例 | 本仓数量 |
| --- | --- | --- |
| ① 内联 `#[cfg(test)] mod tests { … }` | 绝大多数模块 | 210 个文件含 `#[cfg(test)]` |
| ② 外部 `#[cfg(test)] mod tests;` → 子文件 | `common/file/watcher/registration/tests.rs`、`common/git/operations/tests.rs` … | **10 个文件**（`tests.rs` / `tests/mod.rs` / `lifecycle_tests.rs` / `probe.rs` / `dap/testing.rs` …） |
| ③ `#[cfg(all(test, …))]` item 的块体 | `platform/watch_backend/platform_watcher.rs:154`、`common/executor/local.rs:139` | 2 处 |

### 1.4 为什么测试域优先（两次事故全在这里，且本地不可见）

- 2026-10 三处 CI 红（`file/commands.rs` ×2、`factory.rs`、`instance.rs`）**全在测试域**；
- 2026-08 `app_menu.rs` / 2026-09 `fonts.rs` 在生产域（import 类），已被既有消费分析护栏覆盖；
- 测试域的额外病灶：**断言静默消失**。`file/commands.rs` 的 Linux 腿在修复前是零断言；
  `test_normalize_path_windows` 在非 Windows 是空测试；`registration/tests.rs` 两条腿各断言一半。
  这类"空跑侵蚀"没有任何门禁可见 —— 整测试化顺带把它消灭（平台维度出现在**测试名**里，缺失的腿肉眼可见）。

---

## 2. 判据（禁令语义，给护栏实现）

### 2.1 适用域

测试域 = 下述任一：
1. 内联 `#[cfg(test)] mod NAME { … }` 的块范围；
2. `#[cfg(test)] mod NAME;` 指向的文件（`<dir>/NAME.rs` 或 `<dir>/NAME/mod.rs`）**整文件**；
3. `#[cfg(all(test, …))]` item 的块范围。

### 2.2 允许 / 违规

**允许**（item 声明，正则前缀显式列举 —— 覆盖实测 40 处 item 指纹：`fn` / `async fn` / `mod tests` /
`use super` / `use crate` / `impl PlatformWatcher` …）：
`fn`（含 `pub` / `pub(crate)` / `pub(super)` / `async` / `const` / `unsafe` / `extern "C"` 前缀）、
`mod`、`use`、`struct`、`enum`、`impl`、`trait`、`union`、`const`、`static`、`type`、`macro_rules`。

**违规**（fragment）：附着构造不是 item 声明 —— 裸块 `{`、语句（`let` / 断言 / 表达式 / `for|if|while|match|loop`）、
match arm（含 `=>`）、字段 init（表达式位置）。
**保守放行**：附着形态判不出（EOF、宏包裹等）→ 不报，计入 metrics（可见的松弛面）。

### 2.3 基线（ratchet）

`tools/guards/ledger/platform_test_cfg.json`：

```json
{
  "note": "基线由 tools/guards/checks/check_platform_cfg_placement.py 模块 docstring 的命令一次性生成；只许缩小。",
  "baseline": {
    "src-tauri/src/file/commands.rs":                     {"stmt": 0, "block": 7},
    "src-tauri/src/core/exec.rs":                         {"stmt": 6, "block": 1},
    "src-tauri/src/core/exec_env.rs":                     {"stmt": 2, "block": 1},
    "src-tauri/src/common/utils/command/local.rs":         {"stmt": 0, "block": 2},
    "src-tauri/src/common/file/watcher/registration/tests.rs": {"stmt": 0, "block": 2},
    "src-tauri/src/lsp/process.rs":                        {"stmt": 4, "block": 0},
    "src-tauri/src/lsp/session/instance.rs":               {"stmt": 2, "block": 0},
    "src-tauri/src/platform/watch_backend/types.rs":       {"stmt": 3, "block": 0},
    "src-tauri/src/browser/url_validator.rs":              {"stmt": 2, "block": 0},
    "src-tauri/src/common/git/checkout_path.rs":           {"stmt": 2, "block": 0},
    "src-tauri/src/common/git/path_guard.rs":              {"stmt": 2, "block": 0},
    "src-tauri/src/common/git/workspace_ref.rs":           {"stmt": 2, "block": 0}
  }
}
```

语义：**已登记文件只许减小**（`> 基线` 即违规）；**未登记文件 >0 即违规**（新债止步）；
条目归零 / 文件消失 → `notes` 提示清理；**台账文件缺失 = 空基线（DoD 终态：零容忍）**；
台账存在但不可解析 → 护栏失效（退出码 2，沿用 `component_size` 纪律）。
两类计数（`stmt` / `block`）防"同文件内形态洗牌"。基线是**过渡债表**：任务 DoD 是清零后删除。

### 2.4 已知边界（诚实声明）

不覆盖：宏体内展开、`cfg_if!`（本仓零使用）、生产域（L1）、函数参数与 `for` 绑定形态的门控（本仓测试域为零，
出现时会被"非 item 即违规"直接命中，因为参数/`for` 是**语句位置**）。

---

## 3. 迁移 recipe（38 处 → 4 类）

| recipe | 定义 | 目标形态 | 处数 | 归属文件 |
| --- | --- | --- | --- | --- |
| **T1 成对常量** | 两平台各一句 `let script = "…"`（断言本身与平台无关） | item 级 gated `const`（两腿都是真实定义；缺腿编译不过） | 10 | `core/exec.rs` ×6、`lsp/process.rs` ×4 |
| **T2 权限位块** | `#[cfg(unix)] { use PermissionsExt; …set_mode(0o755)… }`（4 处 9 行逐字重复） | `#[cfg(unix)] fn make_executable(p: &Path)` + `#[cfg(not(unix))] fn make_executable(_: &Path) {}`（调用点无条件；DRY） | 4 | `core/exec.rs` ×1、`core/exec_env.rs` ×1、`common/utils/command/local.rs` ×2 |
| **T3 平台断言** | 测试体内按平台断不同语义（裸块 / 断言行） | **整测试**：平台维度上移测试名（`#[cfg(target_os = "linux")] #[test] fn …`），共享准备逻辑提 item 级（无 cfg）helper | 18 | `file/commands.rs` ×7、`platform/watch_backend/types.rs` ×3、`core/exec_env.rs` ×2、`lsp/session/instance.rs` ×2、`browser/url_validator.rs` ×2、`common/file/watcher/registration/tests.rs` ×2 |
| **T4 平台 symlink** | 两平台各一句 `symlink` / `symlink_dir`（构造夹具） | `#[cfg(unix)] fn symlink_dir(real, link)` + `#[cfg(windows)] fn symlink_dir(real, link)`（两腿真实实现） | 6 | `common/git/{checkout_path,path_guard,workspace_ref}.rs` ×各 2 |

**共同性质**：迁移后测试体内零平台 `cfg`；每个平台至少一条真实腿；断言逐条保留（见 §5 迁移纪律）。

### 3.1 骨架示例

```rust
// T1（core/exec.rs）：成对 let → item 级 gated const
#[cfg(unix)]    const BOOM_SCRIPT: &str = "echo boom >&2; exit 3";
#[cfg(windows)] const BOOM_SCRIPT: &str = "echo boom 1>&2 & exit /b 3";
// 测试体：let out = run(BOOM_SCRIPT);  ← 无 cfg

// T2（三文件共用形态）：权限位 → gated helper + 空 stub
#[cfg(unix)]    fn make_executable(path: &Path) { /* chmod 0o755 */ }
#[cfg(not(unix))] fn make_executable(_path: &Path) {}
// 测试体：make_executable(&bin_path);  ← 无 cfg

// T3（file/commands.rs）：平台断言裸块 → 整测试（R4 自证样板）
#[cfg(target_os = "linux")]
#[test]
fn reveal_file_opens_parent_dir() { /* 原 Linux 块的三条断言 */ }
// 共享准备（建临时文件、构造 cmd）提 item 级 helper，无 cfg

// T4（common/git/*）：平台 symlink → gated helper（两腿真实）
#[cfg(unix)]    fn symlink_dir(real: &Path, link: &Path) { std::os::unix::fs::symlink(real, link).unwrap(); }
#[cfg(windows)] fn symlink_dir(real: &Path, link: &Path) { std::os::windows::fs::symlink_dir(real, link).unwrap(); }
```

---

## 4. 结构（落点 / 依赖方向 / 单一职责）

```
tools/guards/
├── core/rust_cfg.py                      【新】Rust 平台 cfg 语法表层：strip_noise / brace_end /
│                                              test_domain_ranges / attached_construct / 平台谓词
├── checks/check_platform_imports.py      【改】消费者分析判据（既有）改为从 core/rust_cfg 取语法层（行为等价）
├── checks/check_platform_cfg_placement.py【新】结构禁令 + ratchet 基线
├── tests/test_check_platform_cfg_placement.py 【新】伴随单测（注册表强制）
├── ledger/platform_test_cfg.json         【新】基线台账（命令生成，禁手抄）
└── ledger/invariants.json                【改】增一条：tier=guard, ref=新护栏+测试, red_line=10
```

- **依赖方向**：`checks/* → core/rust_cfg`（单向）；判据在 check、数据在 ledger（判据与基线分离）。
- **为什么抽 `core/rust_cfg`**：同领域知识（Rust 平台 cfg 的语法表层）出现**第三个**消费者（L1 可预期）已可见，
  且第 3 步（新判据）若不抽就会复制 `strip_noise` / `brace_end` / 范围识别 ≈ 60 行 —— 两份表示必然漂移。
  等价性由既有 29 条 `check_platform_imports` 单测 + 全仓命中恒等（消费者命中清单不变）证明。
- **spec 同步**：`quality-guidelines.md` Pre-Development Checklist 增禁令一条 + 护栏清单小节加新护栏一行；
  迁移 recipe 以"测试域平台门控三条正路"的形式落 spec（供 L1 复用）。
- **红线归属**：不新增红线，映射**红线 10**（平台差异集中化）——本禁令补齐它的"门控粒度"维度。

---

## 5. 迁移纪律（测试代码重构的正确性判据）

1. **断言守恒**：每处迁移前后逐条对照（对照表模板见 implement.md），涉及文件的 `assert*` 计数不减；
   整测试化时**两条腿都必须存在**（不允许"只留目标平台那条"）。
2. **只动测试**：迁移不得修改产品代码语义；跨文件改动仅限 `#[cfg(test)]` 区域与测试域文件（附录 A）。
3. **可归因**：每批独立可回滚；批次完成后重算基线并记录计数轨迹（应为单调下降）。

---

## 6. 决策表（取舍已定）

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 新护栏 vs 并入 `check_platform_imports` | **新增 check 模块** | 判据单一职责；独立 ratchet 与红线条目；注册表自动接入 stage |
| 判据类型 | **附着位置（结构）** | 可完备、零误报；消费者分析保留为语义兜底（互补，不是替代） |
| 基线 key | **文件 × {stmt, block}** | 无行号 → 不随编辑漂移；两类计数防同文件洗牌 |
| 生产域是否纳入 | **不纳入（L1 另立）** | 派生门控需类型层决策；测试域先清零可独立验收 |
| 逃生口 | **不设** | 三条正路（整测试 / gated helper / 适配器数据）已覆盖全部实测形态；逃生口会让禁令退化 |
| 未判出形态 | **保守放行 + metrics** | 误报会阻断提交、诱发"关掉护栏"；漏报由消费分析护栏 + CI 矩阵兜底 |

---

## 7. 风险与对策

| # | 风险 | 对策 |
| --- | --- | --- |
| R1 | 迁移改变测试语义（丢断言） | §5 迁移纪律：断言守恒 + 逐处对照表 + `pnpm test:rust` + 覆盖率地板 |
| R2 | 护栏误报（item 形态识别不全，如 `pub(in path) fn` / `extern "C" fn`） | 允许集合显式列举并覆盖实测指纹；未判出 → 放行；单测锁定形态矩阵 |
| R3 | 测试域识别漏（外部模块 / `all(test)`） | 单测固定三种形态；漏识别方向是"少报"，可接受 |
| R4 | 与 L1 的边界漂移（生产 44 处长期不收敛） | L1 任务另立；spec 保留附录 B 清单指针；消费分析护栏继续兜底 |
| R5 | 基线成为"永久豁免" | DoD 明确"清零 + 删除台账"；任务完成后护栏无基线运行（纯结构判据） |

---

## 附录 A：测试域 38 处全量清单（recipe 归属）

| # | 位置 | 门控 | recipe | 迁移目标 |
| --- | --- | --- | --- | --- |
| 1-2 | `browser/url_validator.rs:229,231` | windows / not(windows) | T3 | 两个整测试（路径绝对性语义分平台） |
| 3-4 | `common/file/watcher/registration/tests.rs:360,368` | linux / not(linux) | T3 | 两个整测试（`on_rules_changed` 两端语义），准备流程提 helper |
| 5-6 | `common/git/checkout_path.rs:286,288` | unix / windows | T4 | gated `symlink_dir` helper |
| 7-8 | `common/git/path_guard.rs:206,208` | unix / windows | T4 | 同上 |
| 9-10 | `common/git/workspace_ref.rs:385,387` | unix / windows | T4 | 同上 |
| 11-12 | `common/utils/command/local.rs:297,348` | unix ×2 | T2 | gated `make_executable` + stub |
| 13 | `core/exec.rs:517` | unix | T2 | 同上 |
| 14-19 | `core/exec.rs:609/611,636/638,671/673` | unix / windows ×3 | T1 | gated 脚本常量 ×3 |
| 20-21 | `core/exec_env.rs:101,103` | windows / not(windows) | T3 | 两个整测试（`cmd` vs `sh`） |
| 22 | `core/exec_env.rs:120` | unix | T2 | gated `make_executable` + stub |
| 23-29 | `file/commands.rs:206,257,264,271,292,298,304` | windows/macos/linux | T3 | 整测试化（含 R4：本会话新增的 Linux 块在此迁移） |
| 30-33 | `lsp/process.rs:246/248,319/321` | unix / windows ×2 | T1 | gated 脚本常量 ×2 |
| 34-35 | `lsp/session/instance.rs:1190,1192` | windows / not(windows) | T3 | 两个整测试（R4：本会话新增的 Windows 断言行在此迁移） |
| 36-38 | `platform/watch_backend/types.rs:60,65,70` | linux / macos / windows | T3 | 三个整测试（平台 → 后端能力位） |

## 附录 B：生产域 44 处清单（L1 输入，本任务不动）

按形态分组（明细见任务评论/会话记录中的扫描输出）：

| 形态 | 处数 | 代表位置 | L1 处理方向 |
| --- | --- | --- | --- |
| 裸块（`#[cfg(unix)] { … }` 等） | 18 | `common/utils/command/local.rs:78,100,126,156`、`library/skill/*`、`project/commands_ide.rs:151,155`、`terminal/services.rs` 多处 | 抽 `platform/<theme>/` 同签名函数 + 非目标平台 stub |
| 语句（含 `for` / `if let` / 调用） | 15 | `session/model.rs:96,114`、`session/types.rs:96,114`、`terminal/services.rs:133,135,413`、`library/skill/commands.rs:1691,2398` | 同上；`session/*` 两处是同一实现的重复，合并后再迁 |
| `let` | 8 | `platform/watch_backend/factory.rs:54,56,94`、`terminal/services.rs:44,114,323,330,405` | 抽返回 `Option<T>` / 策略值的平台函数 |
| match arm（派生） | 7 | `core/project.rs:48`、`terminal/router.rs:144`、`theme/service.rs:136`、`platform_watcher.rs:89,97,105`、`agent/chat/commands.rs:57` | 类型平台中立化（`ProjectEnvironment::Wsl` 变体、`PlatformWatcher::MacExclusion` 变体去 cfg） |
| 字段 init（派生） | 1 | `terminal/services.rs:125` | 随 `PtyHandle` 字段平台中立化 |

> 另有 4 处**声明位置**门控不计入 44（L1 的类型层议题）：枚举变体 `core/project.rs:16`、
> `platform/watch_backend/platform_watcher.rs:15`；结构体字段 `terminal/manager.rs:23`；函数参数 `terminal/services.rs:298`。
