"""测试域平台 cfg 附着位置护栏用例。

判据（L2 禁令）：测试域内的平台 cfg 只允许附着在 **item 声明**上；附着于裸块 / 语句 /
match arm / 字段 init → 违规。回归来源：2026-10 三平台 CI 红（fragment 级门控 → 某平台
unused）+ 平台门控断言在非目标平台静默消失（空跑侵蚀）。

基线用 mock 注入（不依赖真实台账文件 —— 台账在任务 DoD 里会被清零删除）。
"""
from __future__ import annotations

import unittest
from unittest import mock

from guards.checks import check_platform_cfg_placement as subject
from guards.core.contract import ERROR, PASS, VIOLATION
from guards.core.ledger import LedgerError
from guards.tests.support import context, make_repo, temp_repo

FILE = "src-tauri/src/x/thing.rs"
SIBLING = "src-tauri/src/x/sibling.rs"


def inner(body: str) -> str:
    """把内容包进内联 `#[cfg(test)] mod tests { … }`。"""
    return "#[cfg(test)]\nmod tests {\n" + body + "}\n"


class PlacementJudgementTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_repo(self)

    def run_guard(self, files: dict, baseline=None):
        make_repo(self.root, files)
        with mock.patch.object(subject, "load_baseline", return_value=dict(baseline or {})):
            return subject.check(context(self.root))

    # ── 允许：item 声明（门控粒度 = 作用域粒度）─────────────────────────────

    def test_item_attached_gates_are_allowed(self):
        result = self.run_guard(
            {
                FILE: inner(
                    "    #[cfg(unix)]\n"
                    "    use std::os::unix::fs::PermissionsExt;\n"
                    "\n"
                    "    #[cfg(unix)]\n"
                    "    const MODE: u32 = 0o755;\n"
                    "\n"
                    "    #[cfg(windows)]\n"
                    "    static DRIVE: &str = \"C:\\\\\";\n"
                    "\n"
                    "    #[cfg(unix)]\n"
                    "    type Fd = std::os::fd::RawFd;\n"
                    "\n"
                    "    #[cfg(target_os = \"linux\")]\n"
                    "    struct LinuxOnly;\n"
                    "\n"
                    "    #[cfg(target_os = \"linux\")]\n"
                    "    #[test]\n"
                    "    fn linux_state_machine() { assert!(true); }\n"
                    "\n"
                    "    #[cfg(target_os = \"macos\")]\n"
                    "    mod macos_tests { #[test] fn a() { assert!(true); } }\n"
                )
            }
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_async_test_with_stacked_attribute_is_recognized(self):
        result = self.run_guard(
            {
                FILE: inner(
                    "    #[cfg(not(target_os = \"windows\"))]\n"
                    "    #[tokio::test]\n"
                    "    async fn spawns() { assert!(true); }\n"
                )
            }
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    # ── 违规：fragment（门控粒度 < 作用域粒度）────────────────────────────

    def test_bare_block_gate_is_a_violation(self):
        result = self.run_guard(
            {
                FILE: inner(
                    "    #[test]\n"
                    "    fn t() {\n"
                    "        #[cfg(target_os = \"linux\")]\n"
                    "        {\n"
                    "            assert!(true);\n"
                    "        }\n"
                    "    }\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertEqual(result.findings[0].line, 5)

    def test_let_gate_is_a_violation(self):
        result = self.run_guard(
            {
                FILE: inner(
                    "    #[test]\n"
                    "    fn t() {\n"
                    "        #[cfg(unix)]\n"
                    "        let script = \"pwd\";\n"
                    "        let _ = script;\n"
                    "    }\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertEqual(result.findings[0].line, 5)

    def test_single_line_assert_gate_is_a_violation(self):
        result = self.run_guard(
            {
                FILE: inner(
                    "    #[test]\n"
                    "    fn t() {\n"
                    "        let info = sample();\n"
                    "        #[cfg(target_os = \"windows\")]\n"
                    "        assert_eq!(info.memory_mb, 0.0);\n"
                    "    }\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertEqual(result.findings[0].line, 6)

    def test_multiline_assert_gate_is_a_violation(self):
        result = self.run_guard(
            {
                FILE: inner(
                    "    #[test]\n"
                    "    fn t() {\n"
                    "        let info = sample();\n"
                    "        #[cfg(not(target_os = \"windows\"))]\n"
                    "        assert!(\n"
                    "            info.memory_mb > 0.0,\n"
                    "            \"expected live RSS sample, got {}\",\n"
                    "            info.memory_mb\n"
                    "        );\n"
                    "    }\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertEqual(result.findings[0].line, 6)

    def test_for_and_if_gates_are_violations(self):
        result = self.run_guard(
            {
                FILE: inner(
                    "    #[test]\n"
                    "    fn t() {\n"
                    "        let xs = vec![1];\n"
                    "        #[cfg(windows)]\n"
                    "        for x in &xs { assert!(*x == 1); }\n"
                    "        #[cfg(unix)]\n"
                    "        if !xs.is_empty() { assert!(true); }\n"
                    "    }\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertEqual(len(result.findings), 1, result.findings)  # 未登记文件合并为一条
        self.assertIn(":6, :8", result.findings[0].message)

    def test_match_arm_gate_is_a_violation(self):
        result = self.run_guard(
            {
                FILE: inner(
                    "    #[test]\n"
                    "    fn t() {\n"
                    "        let env = pick();\n"
                    "        let tag = match env {\n"
                    "            #[cfg(target_os = \"windows\")]\n"
                    "            Env::Wsl { .. } => \"wsl\",\n"
                    "            _ => \"other\",\n"
                    "        };\n"
                    "        assert!(!tag.is_empty());\n"
                    "    }\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertEqual(result.findings[0].line, 7)

    def test_field_init_gate_is_a_violation(self):
        result = self.run_guard(
            {
                FILE: inner(
                    "    #[test]\n"
                    "    fn t() {\n"
                    "        let handle = PtyHandle {\n"
                    "            #[cfg(windows)]\n"
                    "            job_handle,\n"
                    "            id: 1,\n"
                    "        };\n"
                    "        let _ = handle;\n"
                    "    }\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertEqual(result.findings[0].line, 6)

    # ── 域识别（三种形态）与边界 ──────────────────────────────────────────

    def test_external_test_module_file_is_in_domain(self):
        result = self.run_guard(
            {
                "src-tauri/src/x/mod.rs": "#[cfg(test)]\nmod tests;\n",
                "src-tauri/src/x/tests.rs": (
                    "#[test]\n"
                    "fn t() {\n"
                    "    #[cfg(target_os = \"linux\")]\n"
                    "    assert!(true);\n"
                    "}\n"
                ),
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(result.findings[0].file.endswith("x/tests.rs"))

    def test_all_test_item_body_is_in_domain(self):
        result = self.run_guard(
            {
                FILE: (
                    "#[cfg(all(test, unix))]\n"
                    "fn helper() {\n"
                    "    #[cfg(unix)]\n"
                    "    let x = 1;\n"
                    "    let _ = x;\n"
                    "}\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertEqual(result.findings[0].line, 3)  # 内层 `#[cfg(unix)]` 属性行

    def test_same_fragment_shape_outside_test_domain_is_out_of_scope(self):
        """生产域不在本判据（L1 任务范围）—— 同形态必须放行，避免越界。"""
        result = self.run_guard(
            {
                FILE: (
                    "pub fn run() {\n"
                    "    #[cfg(unix)]\n"
                    "    let fd = raw_fd();\n"
                    "    let _ = fd;\n"
                    "}\n"
                )
            }
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_unparsable_attachment_is_left_alone(self):
        """附着形态判不出（测试局部枚举的变体声明）→ 保守放行（宁可少报）。"""
        result = self.run_guard(
            {
                FILE: inner(
                    "    enum Local {\n"
                    "        #[cfg(target_os = \"windows\")]\n"
                    "        Wsl { distro: String },\n"
                    "        Other,\n"
                    "    }\n"
                    "    #[test]\n"
                    "    fn t() { assert!(matches!(Local::Other, Local::Other)); }\n"
                )
            }
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    # ── 基线 ratchet ─────────────────────────────────────────────────────

    def fragment_body(self, count: int) -> str:
        return inner(
            "    #[test]\n"
            "    fn t() {\n"
            + "".join(
                f"        #[cfg(unix)]\n        let v{i} = {i};\n        let _ = v{i};\n"
                for i in range(count)
            )
            + "    }\n"
        )

    def test_unregistered_file_with_fragments_is_a_violation(self):
        result = self.run_guard({FILE: self.fragment_body(1)})
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("fragment", result.findings[0].message)

    def test_baselined_file_at_recorded_count_passes(self):
        result = self.run_guard({FILE: self.fragment_body(2)}, baseline={FILE: {"stmt": 2, "block": 0}})
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_baselined_file_shrinking_passes_with_cleanup_note(self):
        result = self.run_guard({FILE: self.fragment_body(1)}, baseline={FILE: {"stmt": 2, "block": 0}})
        self.assertEqual(result.verdict, PASS, result.findings)
        self.assertTrue(any("可下调" in note for note in result.notes), result.notes)

    def test_baselined_file_growing_is_a_violation(self):
        result = self.run_guard({FILE: self.fragment_body(3)}, baseline={FILE: {"stmt": 2, "block": 0}})
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("只许减小", result.findings[0].message)

    def test_shape_shuffle_inside_a_file_is_a_violation(self):
        """同文件内把 stmt 换成 block（总数不变）也必须违规 —— 两类计数独立 ratchet。"""
        body = inner(
            "    #[test]\n"
            "    fn t() {\n"
            "        #[cfg(unix)]\n"
            "        let v = 1;\n"
            "        let _ = v;\n"
            "        #[cfg(unix)]\n"
            "        { assert!(true); }\n"
            "    }\n"
        )
        result = self.run_guard({FILE: body}, baseline={FILE: {"stmt": 2, "block": 0}})
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("block", " ".join(f.message for f in result.findings))

    def test_missing_ledger_file_means_empty_baseline(self):
        import pathlib

        make_repo(self.root, {FILE: self.fragment_body(1)})
        with mock.patch.object(subject, "LEDGER_DIR", pathlib.Path(self.root / "nowhere")):
            result = subject.check(context(self.root))
        self.assertEqual(result.verdict, VIOLATION)

    def test_corrupt_ledger_is_a_guard_error(self):
        make_repo(self.root, {FILE: self.fragment_body(1)})
        with mock.patch.object(subject, "load_baseline", side_effect=LedgerError("台账解析失败")):
            result = subject.check(context(self.root))
        self.assertEqual(result.verdict, ERROR)

    def test_cfg_test_use_item_does_not_swallow_following_production_code(self):
        """回归：`#[cfg(test)] use X;`（无体 item）不得把后续生产代码吞进测试域。

        实测误报形态：`#[cfg(test)] use AtomicUsize;` 之后的**生产** fragment 被判为测试域违规
        —— 一旦误报，门禁会拦下与 L2 无关的提交。
        """
        result = self.run_guard(
            {
                FILE: (
                    "#[cfg(test)]\n"
                    "use std::sync::atomic::AtomicUsize;\n"
                    "\n"
                    "pub fn run() {\n"
                    "    #[cfg(unix)]\n"
                    "    let fd = raw_fd();\n"
                    "    let _ = fd;\n"
                    "}\n"
                )
            }
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_non_platform_cfg_in_test_domain_is_ignored(self):
        """非平台 cfg（feature / debug_assertions）不是本判据的对象。"""
        result = self.run_guard(
            {
                FILE: inner(
                    "    #[test]\n"
                    "    fn t() {\n"
                    '        #[cfg(feature = "lsp-probe")]\n'
                    "        let probed = true;\n"
                    "        let _ = probed;\n"
                    "    }\n"
                )
            }
        )
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_scanned_counts_files(self):
        result = self.run_guard({FILE: self.fragment_body(0), SIBLING: "fn x() {}\n"})
        self.assertEqual(result.scanned, 2)


if __name__ == "__main__":
    unittest.main()
