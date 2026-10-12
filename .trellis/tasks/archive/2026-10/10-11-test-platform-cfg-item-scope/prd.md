# 测试码平台门控只许挂 item（L2 禁令 + 结构护栏 + 存量迁移）

## 背景：一类反复出现、且本地不可见的失败

**根因结构（不是三个 bug，是一种形态）**：平台门控挂在**片段**上（语句 / 裸块 / 断言 / match arm / 字段），
门控粒度 < 作用域粒度 ⇒ 定义的编译配置与消费者的编译配置**可以分离** ⇒ 在某个平台上定义为
`unused_imports` / `unused_variables`，被 clippy `-D warnings` 升级为编译错误。

事故史：

| 时间 | 位置 | 形态 | 当时防线 |
| --- | --- | --- | --- |
| 2026-08 | `app_menu.rs` | 顶层未门控 import 只在 macOS 分支用 | 无 → 事后有消费分析护栏 |
| 2026-09 | `utils/fonts.rs` | 同上 | 同上 |
| 2026-10（本会话） | `file/commands.rs` ×2、`common/executor/factory.rs`、`lsp/session/instance.rs` | `let` / 测试内 `use` / 多行 `assert` | 无（护栏跳过 `#[cfg(test)]` 模块） |

**实测 substrate（本仓，口径见 design.md §1.1：按"附着形态"判定，不用缩进代理）**：
门控粒度不足的平台 cfg 共 **82 处** = 生产 **44** + **测试域 38**。
测试域 38 处**全部**是语句（25）与裸块（13）形态，零派生形态 —— 可以用最严格的禁令一刀切。

测试域的两个附带事实，决定了它是第一优先：

1. **本地门禁看不见**：宿主机（macOS）clippy 不编译非 mac 平台分支，CI 三平台矩阵是唯一落点；
2. **断言会静默消失（空跑侵蚀）**：fragment 门控在非目标平台整体不编译 —— `file/commands.rs` 的
   Linux 腿在修复前是零断言，`test_normalize_path_windows` 在非 Windows 是空测试，且无任何门禁可见。

## Goal

让「测试码里的平台门控只挂 item」成为**结构事实**：fragment 形态在测试域写不出来（写出来即被本机护栏拦下），
并把存量 38 处收敛到零；收敛期间用 ratchet 基线保证只减不增。生产码 44 处不在本任务（见 Requirements R6）。

## Requirements

**R1 · 禁令语义**（判据细节见 design.md §2）
测试域内（三种识别形态：内联 `#[cfg(test)] mod tests { }`、外部 `#[cfg(test)] mod tests;` 指向的文件、
`#[cfg(all(test, ...))]` item 的块体），平台 cfg 属性**只允许附着在 item 声明**上
（`fn` / `mod` / `use` / `struct` / `enum` / `impl` / `trait` / `const` / `static` / `type` / `union` / `macro_rules`）。
附着于裸块 `{}`、语句（`let` / 断言 / 表达式 / `for|if|while|match|loop`）、match arm、字段 init → 违规。

**R2 · 机械化强制**（约束与强制层级同层）
新增护栏 `check_platform_cfg_placement`（`tools/guards/checks/`，自动接入 local / commit / ci stage）
+ 伴随单测 + 基线台账 `tools/guards/ledger/platform_test_cfg.json` + `ledger/invariants.json` 登记一条
（tier=`guard`，red_line=10）。基线语义：**只许减小**；未登记文件计数 >0 即违规；台账由命令生成（禁手抄）。

**R3 · 存量迁移**
38 处按 4 类 recipe（design.md §3：成对常量 / 权限位 helper / 平台断言整测试化 / symlink helper）
收敛为 item 级 gated helper 或整测试。**断言语义守恒**：逐处对照表 + 涉及文件的断言计数不减，
不得以「CI 绿了」为由删除或弱化断言。

**R4 · 自证（dogfooding）**
本会话为修 CI 引入的两处 fragment 修复（`file/commands.rs` 的 Linux 断言块、`lsp/session/instance.rs`
的 Windows 断言行）必须迁成 L2 正解（整测试），以证明禁令可执行且不损失覆盖。

**R5 · 文档与知识沉淀**
`quality-guidelines.md`：平台相关 checklist 增一条禁令；护栏清单小节加新护栏一行；
迁移 recipe 落 spec（供后续 L1 复用）。

**R6 · 边界（明确不做）**
- 生产码 44 处**不在本任务**：含派生门控（match arm / 字段 init 镜像 cfg-gated 变体/字段），
  需类型层决策（变体 / 字段平台中立化），另立 L1 任务（清单见 design.md 附录 B）；
- 前端不适用（TS 无编译期平台分支）；`cfg!()`（运行时宏）与 `#[cfg(feature)]` 不适用。

## Acceptance Criteria

- [x] 新护栏单测全绿，覆盖：附着形态矩阵（item 允许 × N、语句 / 裸块 / 块语句 / arm / 字段 init 违规）、
      三种测试域识别、基线 ratchet（只许减小）、未登记文件零容忍、台账缺失 → 护栏失效（退出码 2）；
- [x] `pnpm lint` 全绿（新护栏在 local stage 生效、既有护栏不回归）；
- [x] 38 处迁移完成；`ledger/platform_test_cfg.json` 基线清零并**删除**（零容忍生效，护栏退化为纯结构判据）；
- [x] `pnpm test:rust` 全绿；迁移涉及文件的断言数不减；逐处语义对照表作为评审材料产出；
- [x] `file/commands.rs` / `instance.rs` 的上一轮 fragment 修复已被整测试化（R4）；
- [x] spec 两处更新；Trellis 会话记录已写；改动停在**未提交**状态（是否提交由开发者决定）。

## Notes

- 红线归属：不新增红线，映射**红线 10**（平台差异集中化）——本禁令是它的"门控粒度"补充。
- 执行分批与验证命令见 `implement.md`；技术推导与取舍见 `design.md`。
- 基线是**过渡债表**不是审计账：任务完成的判据是基线清零并删除，不是"计数下降"。
