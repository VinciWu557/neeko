# 执行计划：测试码平台门控只许挂 item

> 任务：`.trellis/tasks/10-11-test-platform-cfg-item-scope`
> 顺序原则：**先上锁、再还债、最后清账** —— 批 1 落地后新 fragment 即被本机拦截（未登记文件零容忍），
> 迁移批次只欠旧债。每批一个可独立回滚的提交（是否提交由开发者决定；默认停在未提交状态）。

---

## 批 0 · 抽语法表层 `tools/guards/core/rust_cfg.py`（纯重构，行为等价）

**动作**：把 `check_platform_imports.py` 中的语法表层搬到 `core/rust_cfg.py`，原模块改为 import：
`strip_noise` / `split_top_level` / `evaluate_cfg` / `parse_gate` / `brace_end` / `statement_end` /
`find_cfg_gated_ranges` / `inside_ranges` / `alive_platforms` / `build_identifier_index` /
`is_member_access` / `occurrences` / `has_cfg_gate` / `is_platform_cfg` / `CFG_*` 正则 / `PLATFORMS`。

**验证**（三重等价证据）：
1. `python3 -m unittest discover -s tools/guards/tests -t tools -p "test_check_platform_imports.py"` → 29 条全绿；
2. `python3 tools/guards/run.py run --stage local --suite lint --only check_platform_imports` → 本仓 0 命中；
3. 用 `git show HEAD:<path>` 还原三处事故基线跑一次 → 命中清单与已知 4 个消费者点逐行一致。

**回滚**：批 0 单批单文件改动，`git checkout` 即回滚。

---

## 批 1 · 新判据 + 基线（**上锁**）

1. **写测试（Red）**：`tools/guards/tests/test_check_platform_cfg_placement.py`，用例矩阵（≥ 14 条）：
   - **允许**：`#[cfg(...)]` + `fn`（含 `pub` / `pub(crate)` / `async` 前缀与 `#[tokio::test]` 叠加）/ `mod` /
     `use` / `struct` / `enum` / `impl` / `const` / `static` / `type` / `macro_rules`；
   - **违规**：裸块 `{` / `let` / 单行断言 / 多行 `assert!` / `for` / `if` / match arm / 字段 init；
   - **域**：内联 `mod tests { }` / 外部 `mod tests;`（fixture 造 `tests.rs`）/ `all(test, unix)` item /
     **同形态放生产域 → PASS**（边界证明）;
   - **基线**：未登记文件 >0 → 违规；已登记 = 基线 → 通过；+1 → 违规；-1 → 通过并提示可清理；台账损坏 → 护栏失效；
   - **保守**：附着形态判不出 → PASS（计入 metrics）。
2. **实现** `checks/check_platform_cfg_placement.py`（依赖 `core/rust_cfg`，判据见 design §2）：
   Guard 元数据（`id` / `scope` / `red_lines=(10,)` / `docs=".trellis/spec/backend/quality-guidelines.md"` / `fix_hint`）、
   `test_domain_ranges()`、`attached_is_item()`、`evaluate(records, baseline)`、metrics / notes。
   台账语义：**文件缺失 = 空基线（DoD 终态，零容忍）**；存在但不可解析 = 护栏失效（退出码 2）。
3. **生成基线**：按模块 docstring 的一次性命令写入 `tools/guards/ledger/platform_test_cfg.json`，
   期望内容 = design §2.3（12 文件 / `stmt` 25 / `block` 13 / 合计 **38**）。
4. **自检**：临时清空基线跑一次 → 必须报 **38** 处，且逐行等于 design 附录 A（判据完备且零误报的证据）。
5. `ledger/invariants.json` 增一条：`tier=guard`、`enforcement=[guard, test]`、`red_line=10`。
6. `pnpm lint` 全绿（新护栏在 local stage 自动生效，既有护栏无回归）。

---

## 批 A · 自证（R4）：`file/commands.rs` + `lsp/session/instance.rs`（9 处，T3）

- `test_normalize_path_windows` → 整测试 `#[cfg(target_os = "windows")] #[test]`（顺带消灭非 Windows 空测试）；
- 两个 reveal 测试的平台断言裸块 → 按平台命名整测试（含本会话新增的 Linux 块），共享准备逻辑提 item 级 helper；
- `instance.rs` 的 Windows / 非 Windows 断言行 → 两个整测试（语义与现状逐条等价）。
- **验证**：`cargo test --manifest-path src-tauri/Cargo.toml --lib file::commands` 与 `--lib lsp::session::instance`；
  重算基线（两文件 → 全 0）；断言对照表（每处 1–3 条断言逐条映射）。

## 批 B · `core/exec.rs` + `core/exec_env.rs` + `common/utils/command/local.rs`（12 处）

- T1 ×3 对（脚本常量：boom / env / exit）；T2 ×3（`make_executable`：三文件同形态，各文件 item 级 helper
  （`#[cfg(unix)]` 实现 + `#[cfg(not(unix))]` 空 stub），若三处逐字一致可在批末合并为共享测试工具 —— 可选）；
  T3 ×1 对（`cmd` vs `sh` → 两个整测试）。
- **验证**：`cargo test … --lib core::exec`、`--lib core::exec_env`、`--lib common::utils::command`；重算基线。

## 批 C · `lsp/process.rs` + `browser/url_validator.rs`（6 处）

- T1 ×2 对（`pwd`/`cd`、no-such-binary）；T3 ×1 对（路径绝对性）。
- **验证**：`cargo test … --lib lsp::process`、`--lib browser::url_validator`；重算基线。

## 批 D · `common/git/{checkout_path,path_guard,workspace_ref}.rs`（6 处，T4）

- 三文件各加 item 级 gated `symlink_dir` helper（两腿真实实现）；若可共享则放 `common/git` 下的
  `#[cfg(test)]` 工具模块（可选，不阻塞）。
- **验证**：`cargo test … --lib common::git`；重算基线。

## 批 E · `platform/watch_backend/types.rs` + `common/file/watcher/registration/tests.rs`（5 处，T3）

- 三平台各一个整测试（平台 → 后端能力位）；`on_rules_changed` 两端语义拆两个整测试，准备流程提 helper。
- **验证**：`cargo test … --lib platform::watch_backend`、`--lib common::file::watcher::registration`；重算基线。

## 批 F · 清账

- 重算基线 → 12 文件全 0 → **删除** `ledger/platform_test_cfg.json`（护栏退化为纯结构判据，零容忍生效）；
- `pnpm check` 全绿（含 Rust 覆盖率地板）；spec 两处更新（R5）；Trellis 会话记录（`add_session.py --no-commit`）。

---

## 评审材料（每批产出）

1. **断言守恒对照表**：

   | 位置（迁移前） | 断言（条） | 迁移后位置 | 断言（条） | 语义等价说明 |
   | --- | --- | --- | --- | --- |
   | `command.rs:257` 裸块 | 3 | `reveal_file_uses_select_prefix`（整测试） | 3 | 逐条对应（程序名 / 参数数 / `/select,` 前缀） |
   | … | … | … | … | … |

2. **基线计数轨迹**：批 1 = 38（stmt 25 + block 13）→ 批 A 后 29 → 批 B 后 17 → 批 C 后 11 → 批 D 后 5 → 批 E 后 0。
3. 每批 `git diff --stat` + 验证命令输出摘要（含平台腿提示：本机只跑一条腿，其余两条由 CI 三平台矩阵证明）。
4. 批 1 的「基线清空自检」输出（38 处逐行 = design 附录 A）。

## 命令速查

```bash
# 护栏单测（两条护栏一起跑）
python3 -m unittest discover -s tools/guards/tests -t tools -p "test_check_platform_cfg*.py"
# 单条护栏 + 本仓判定
python3 tools/guards/run.py run --stage local --suite lint --only check_platform_cfg_placement
# 目标 Rust 测试（filter 见各批）
cargo test --manifest-path src-tauri/Cargo.toml --lib <filter>
# 全量门禁（批末）
pnpm check
```

## 边界复述

- 不新增红线（映射红线 10）；生产域 44 处不在本任务（L1）；前端不适用；`cfg!()` / `#[cfg(feature)]` 不适用；
- 改动停在未提交状态；分批提交（若提交）每批独立可回滚；迁移不得修改产品代码语义。
