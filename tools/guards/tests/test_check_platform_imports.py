"""平台 import 门控护栏用例（回归来源：fonts.rs 的 unused_imports 只在 Linux/Windows 暴露）。"""
from __future__ import annotations

import pathlib
import unittest

from guards.checks import check_platform_imports as subject
from guards.core.contract import PASS, VIOLATION
from guards.tests.support import context, make_repo, temp_repo

SCOPE_FILE = "src-tauri/src/common/utils/fonts.rs"


class PlatformImportsTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_repo(self)

    def run_guard(self, body: str):
        make_repo(self.root, {SCOPE_FILE: body})
        return subject.check(context(self.root))

    def test_ungated_use_used_only_in_platform_block_is_a_violation(self):
        result = self.run_guard(
            "use std::collections::BTreeSet;\n"
            "\n"
            '#[cfg(target_os = "macos")]\n'
            "fn collect() -> BTreeSet<u32> {\n"
            "    BTreeSet::new()\n"
            "}\n"
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("BTreeSet", result.findings[0].message)
        self.assertEqual(result.findings[0].line, 1)

    def test_same_condition_gate_on_the_use_is_accepted(self):
        result = self.run_guard(
            '#[cfg(target_os = "macos")]\n'
            "use std::collections::BTreeSet;\n"
            "\n"
            '#[cfg(target_os = "macos")]\n'
            "fn collect() -> BTreeSet<u32> {\n"
            "    BTreeSet::new()\n"
            "}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_use_also_reachable_off_the_platform_path_is_accepted(self):
        result = self.run_guard(
            "use std::collections::BTreeSet;\n"
            "\n"
            '#[cfg(target_os = "macos")]\n'
            "fn mac() -> BTreeSet<u32> {\n"
            "    BTreeSet::new()\n"
            "}\n"
            "\n"
            "fn every_one() -> BTreeSet<u32> {\n"
            "    BTreeSet::new()\n"
            "}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_file_without_platform_cfg_is_skipped_without_noise(self):
        result = self.run_guard("use std::path::Path;\n\nfn p(x: &Path) {}\n")
        self.assertEqual(result.verdict, PASS)
        self.assertEqual(result.scanned, 1)

    def test_braced_use_list_is_checked_per_name(self):
        result = self.run_guard(
            "use std::path::{Path, PathBuf};\n"
            "\n"
            '#[cfg(windows)]\n'
            "fn w(a: &Path, b: PathBuf) {}\n"
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertEqual(len(result.findings), 1, result.findings)
        self.assertIn("Path", result.findings[0].message)

    def test_alias_is_judged_by_the_bound_name(self):
        """`use a::b as C` 引入的名字是 C —— 按 b 判会永远查不到使用点。"""
        result = self.run_guard(
            "use std::path::Path as MyPath;\n"
            "\n"
            '#[cfg(target_os = "windows")]\n'
            "fn w(a: &MyPath) {}\n"
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("MyPath", result.findings[0].message)

    def test_glob_use_is_never_flagged(self):
        """glob 没有具体符号名，逐个符号判定无从下手 —— 报出来只能是噪音。"""
        result = self.run_guard(
            "use std::collections::*;\n"
            "\n"
            '#[cfg(target_os = "macos")]\n'
            "fn m() -> BTreeSet<u32> {\n"
            "    BTreeSet::new()\n"
            "}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_use_after_a_gated_block_is_left_alone(self):
        """刻意保守：cfg 在 use 上方 1-3 行内就不报，即使那个 cfg 门控的是别的 item。

        漏报可靠 CI 三平台矩阵兜住，误报会让整条护栏被人关掉 —— 方向上选宁可少报。
        """
        result = self.run_guard(
            '#[cfg(unix)]\n'
            "mod gated { pub fn a() {} }\n"
            "use std::path::Path;\n"
            "\n"
            "fn free(p: &Path) {}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_dangling_cfg_at_eof_is_not_fatal(self):
        result = self.run_guard(
            "use std::path::Path;\nfn b(p: &Path) {}\n#[cfg(unix)]\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_blank_lines_and_stacked_attributes_between_cfg_and_item(self):
        result = self.run_guard(
            "use std::collections::BTreeSet;\n"
            "fn free(x: BTreeSet<u32>) {}\n"
            "\n"
            "#[cfg(unix)]\n"
            "\n"
            "#[inline]\n"
            "fn mac() {}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_block_opening_brace_far_below_the_signature(self):
        result = self.run_guard(
            "use std::path::Path;\n"
            "fn b(p: &Path) {}\n"
            "\n"
            '#[cfg(windows)]\n'
            "fn win(\n"
            "    a: &Path,\n"
            ") {\n"
            "    let _ = a;\n"
            "}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_unconditional_use_that_is_simply_unused_is_not_this_guard(self):
        """完全没使用是 unused_imports 的活，这里再报一遍就是两处口径重复。"""
        result = self.run_guard(
            "use std::path::Path;\n"
            "\n"
            '#[cfg(unix)]\n'
            "fn a() {}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_blank_line_between_stacked_attribute_and_item_still_finds_the_item(self):
        """`#[cfg]` + `#[inline]` + 空行 + `fn` —— 空行必须被跳过而不是把 item 丢掉。"""
        result = self.run_guard(
            "use std::collections::BTreeSet;\n"
            "fn free(x: BTreeSet<u32>) {}\n"
            "\n"
            "#[cfg(unix)]\n"
            "#[inline]\n"
            "\n"
            "fn mac() { let _ = 1; }\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_unreadable_file_is_skipped_without_breaking_the_scan(self):
        class Exploding:
            def rel(self, path):
                return str(path)

            def read_tolerant(self, rel):
                raise OSError("EACCES")

        self.assertEqual(subject.scan_file(Exploding(), pathlib.Path("/x.rs")), [])


class PlatformSoleConsumerTest(unittest.TestCase):
    """平台 cfg 独占消费者（判据升级：2026-10 三平台 CI 红）。

    回归来源：`common/executor/factory.rs` 的 `ExecError`（在 `#[cfg(test)]` 模块里，只被
    `#[cfg(not(target_os = "windows"))]` 用例消费）、`lsp/session/instance.rs` 的 `info`
    （只被平台门控的 `assert!` 消费）、`file/commands.rs` 的 `args`（只被 windows/macos
    块消费 → Linux 报 unused_variables）。
    """

    def setUp(self):
        self.root = temp_repo(self)

    def run_guard(self, body: str):
        make_repo(self.root, {SCOPE_FILE: body})
        return subject.check(context(self.root))

    def test_use_in_test_module_consumed_only_by_platform_gate_is_a_violation(self):
        """factory.rs 形态：`#[cfg(test)]` 不再是免检区。"""
        result = self.run_guard(
            "#[cfg(test)]\n"
            "mod tests {\n"
            "    use crate::common::executor::ExecError;\n"
            "\n"
            '    #[cfg(not(target_os = "windows"))]\n'
            "    #[tokio::test]\n"
            "    async fn wsl() {\n"
            "        assert!(matches!(r, Err(ExecError::Wsl(_))));\n"
            "    }\n"
            "}\n"
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("ExecError", result.findings[0].message)
        self.assertEqual(result.findings[0].line, 3)

    def test_let_consumed_only_by_platform_gated_assert_is_a_violation(self):
        """instance.rs 形态：断言是多行宏，整段必须算进门控范围。"""
        result = self.run_guard(
            "#[cfg(test)]\n"
            "mod tests {\n"
            "    #[test]\n"
            "    fn t() {\n"
            "        let info = snapshot();\n"
            '        #[cfg(not(target_os = "windows"))]\n'
            "        assert!(\n"
            "            info.memory_mb > 0.0,\n"
            '            "expected live RSS sample, got {}",\n'
            "            info.memory_mb\n"
            "        );\n"
            "    }\n"
            "}\n"
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("info", result.findings[0].message)
        self.assertEqual(result.findings[0].line, 5)

    def test_let_consumed_by_every_platform_leg_is_accepted(self):
        """成对门控（unix + windows 各消费一次）→ 每个平台都留了活口，不得报。"""
        result = self.run_guard(
            "fn t() {\n"
            "    let info = snapshot();\n"
            "    #[cfg(unix)]\n"
            "    let a = info.clone();\n"
            "    #[cfg(windows)]\n"
            "    let b = info.clone();\n"
            "    let _ = (a, b);\n"
            "}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_let_used_off_the_gated_path_is_accepted(self):
        result = self.run_guard(
            "fn t(cmd: Command) {\n"
            "    let args: Vec<&OsStr> = cmd.get_args().collect();\n"
            "    #[cfg(windows)]\n"
            "    assert_eq!(args.len(), 1);\n"
            "    println!(\"{:?}\", args);\n"
            "}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_let_same_name_in_another_function_does_not_count_as_usage(self):
        """作用域按定义所在块收口：别的函数里的同名绑定不算它的使用点。"""
        result = self.run_guard(
            "fn t() {\n"
            "    let args = collect();\n"
            "    #[cfg(windows)]\n"
            "    assert_eq!(args.len(), 1);\n"
            "}\n"
            "fn other(args: Vec<u8>) {\n"
            "    drop(args);\n"
            "}\n"
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertEqual(result.findings[0].line, 2)

    def test_underscore_prefixed_binding_is_left_alone(self):
        result = self.run_guard(
            "fn t() {\n"
            "    let _info = snapshot();\n"
            "    #[cfg(windows)]\n"
            "    assert!(_info.memory_mb == 0.0, \"{}\", _info.memory_mb);\n"
            "}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_let_defined_inside_the_gate_is_left_alone(self):
        """成对定义（per-platform 各定义一次）是既有安全写法，不得报。"""
        result = self.run_guard(
            "fn t() {\n"
            "    #[cfg(unix)]\n"
            "    let script = \"pwd\";\n"
            "    #[cfg(windows)]\n"
            "    let script = \"cd\";\n"
            "    shell(script);\n"
            "}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_use_consumed_only_inside_a_bare_braced_gate_is_a_violation(self):
        """`#[cfg]` + 裸 `{` 块（无 item）同样门控其块体。"""
        result = self.run_guard(
            "use std::os::unix::fs::PermissionsExt;\n"
            "\n"
            "fn t(mode: u32) {\n"
            "    #[cfg(unix)]\n"
            "    {\n"
            "        let _p = PermissionsExt::from_mode(mode);\n"
            "    }\n"
            "}\n"
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertEqual(result.findings[0].line, 1)

    def test_member_access_of_the_same_name_is_not_a_usage(self):
        """`self.info` / `foo::info` 不是局部绑定的使用点。"""
        result = self.run_guard(
            "fn t() {\n"
            "    let info = snapshot();\n"
            "    self.info = 1;\n"
            '    #[cfg(not(target_os = "windows"))]\n'
            "    assert!(info.memory_mb > 0.0, \"{}\", info.memory_mb);\n"
            "}\n"
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertEqual(result.findings[0].line, 2)

    def test_unknown_gate_condition_is_left_alone(self):
        """解析不了的 cfg 条件（如 feature）→ 放行，宁可少报。"""
        result = self.run_guard(
            "fn t() {\n"
            "    let info = snapshot();\n"
            '    #[cfg(feature = "lsp-probe")]\n'
            "    assert!(info.memory_mb > 0.0);\n"
            "}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_commented_out_usage_does_not_count(self):
        result = self.run_guard(
            "fn t() {\n"
            "    let info = snapshot();\n"
            "    // println!(\"{}\", info.memory_mb);\n"
            '    #[cfg(not(target_os = "windows"))]\n'
            "    assert!(info.memory_mb > 0.0, \"{}\", info.memory_mb);\n"
            "}\n"
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertEqual(result.findings[0].line, 2)

    def test_template_pattern_binding_is_not_a_candidate(self):
        """`let Some(x) = ...` 的名字不是 `Some`，不得拿它去查使用点。"""
        result = self.run_guard(
            "fn t() {\n"
            "    let Some(info) = get();\n"
            '    #[cfg(not(target_os = "windows"))]\n'
            "    assert!(info.memory_mb > 0.0, \"{}\", info.memory_mb);\n"
            "}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_enum_variant_gate_does_not_swallow_the_next_variant(self):
        """门控范围不得越过变体边界 —— 曾把 `Remote` 的 `AuthMethod` 吞进 Wsl 的门控范围。"""
        result = self.run_guard(
            "use crate::common::connection::types::AuthMethod;\n"
            "\n"
            "pub enum ProjectEnvironment {\n"
            "    Local,\n"
            '    #[cfg(target_os = "windows")]\n'
            "    /// WSL distribution execution.\n"
            "    Wsl {\n"
            "        distro: String,\n"
            "    },\n"
            "    Remote {\n"
            "        auth: AuthMethod,\n"
            "    },\n"
            "}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_struct_field_gate_does_not_swallow_the_next_field(self):
        """结构体字段门控（`#[cfg(windows)] job_handle,`）同样不得越界。"""
        result = self.run_guard(
            "use tauri::EventId;\n"
            "\n"
            "struct PtyHandle {\n"
            "    #[cfg(windows)]\n"
            "    job_handle,\n"
            "    input_listener_id: EventId,\n"
            "}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_let_used_in_a_struct_literal_field_is_not_swallowed(self):
        """terminal/services.rs 形态：字段门控不得吞掉同一字面量里的其它字段。"""
        result = self.run_guard(
            "fn t(app: App) {\n"
            "    let input_listener_id = spawn();\n"
            "    handles.insert(PtyHandle {\n"
            "        #[cfg(windows)]\n"
            "        job_handle,\n"
            "        input_listener_id,\n"
            "        app: app.clone(),\n"
            "    });\n"
            "}\n"
        )
        self.assertEqual(result.verdict, PASS, result.findings)


if __name__ == "__main__":
    unittest.main()
