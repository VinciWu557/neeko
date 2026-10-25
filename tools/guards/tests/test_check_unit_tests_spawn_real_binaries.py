"""`check_unit_tests_spawn_real_binaries` 护栏用例。"""
from __future__ import annotations

import unittest

from guards.checks import check_unit_tests_spawn_real_binaries as subject
from guards.core.contract import ERROR, PASS, VIOLATION
from guards.tests.support import context, make_repo, temp_repo

TARGET = "src-tauri/src/agent/chat/x.rs"


def wrap(body: str, attrs: str = "#[tokio::test]") -> str:
    return f"{attrs}\nasync fn t() {{\n{body}\n}}\n"


class SpawnRealBinariesTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_repo(self)

    def run_guard(self, source: str, rel: str = TARGET):
        make_repo(self.root, {rel: source})
        return subject.check(context(self.root))

    # ── 违规 ──────────────────────────────────────────────────────────────

    def test_serve_adapter_with_real_binary_is_a_violation(self):
        """事故原样：构造 + 触发调用 = 真起进程。"""
        src = wrap(
            'let s = ServeAdapter::new(vec!["opencode".into(), "serve".into()], d);\n'
            'let _ = s.list_commands(&c, None).await;'
        )
        result = self.run_guard(src)
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("opencode", result.findings[0].message)

    def test_pi_rpc_adapter_with_real_binary_is_a_violation(self):
        src = wrap(
            'let p = PiRpcAdapter::new(vec!["pi".into()], d);\n'
            'let _ = p.list_commands(&c, None).await;'
        )
        self.assertEqual(self.run_guard(src).verdict, VIOLATION)

    def test_adapter_ctor_without_a_spawn_call_is_not_a_violation(self):
        """只看能力位（不调 list_*/create）不会起进程 —— 构造本身是 const fn。"""
        src = wrap(
            'let s = ServeAdapter::new(vec!["opencode".into(), "serve".into()], d);\n'
            'assert!(s.chat_capabilities().commands);'
        )
        self.assertEqual(self.run_guard(src).verdict, PASS)

    def test_exec_spawn_with_real_binary_is_a_violation(self):
        src = wrap('let c = exec::spawn(&t, "opencode", &args, spec).await?;')
        self.assertEqual(self.run_guard(src).verdict, VIOLATION)

    def test_spawn_options_with_real_binary_is_a_violation(self):
        src = wrap('let o = SpawnOptions::new("opencode", &a);')
        self.assertEqual(self.run_guard(src).verdict, VIOLATION)

    def test_command_new_with_real_binary_is_a_violation(self):
        src = wrap('let c = Command::new("opencode");')
        self.assertEqual(self.run_guard(src).verdict, VIOLATION)

    # ── 合规 ──────────────────────────────────────────────────────────────

    def test_placeholder_binary_passes(self):
        """正解写法：判据是「覆写是否存在」，用不存在的二进制名即可。"""
        src = wrap(
            'let s = ServeAdapter::new(vec!["definitely-not-a-real-binary".into()], d);'
        )
        self.assertEqual(self.run_guard(src).verdict, PASS)

    def test_ignored_integration_test_is_exempted_not_flagged(self):
        """`#[ignore]` 的集成用例是这类用例的正当归宿，应豁免而非违规。"""
        src = wrap(
            'let s = ServeAdapter::new(vec!["opencode".into(), "serve".into()], d);\n'
            'let _ = s.list_commands(&c, None).await;',
            attrs="#[tokio::test]\n#[ignore]",
        )
        result = self.run_guard(src)
        self.assertEqual(result.verdict, PASS)
        self.assertIn("豁免", result.metrics)

    def test_command_exists_probe_passes(self):
        """`command_exists` 只查 PATH，不 spawn 被探测的程序 —— 不在射程内。"""
        src = wrap('if !command_exists(&Local, "opencode").await { return; }')
        self.assertEqual(self.run_guard(src).verdict, PASS)

    def test_binary_name_in_argument_position_passes(self):
        """`--provider opencode` 里的名字是参数值，不是程序名。"""
        src = wrap('let a = exec::spawn(&t, "my-agent", &["--provider", "opencode"], s);')
        self.assertEqual(self.run_guard(src).verdict, PASS)

    def test_test_infrastructure_binaries_pass(self):
        """`git` / `sh` 是测试基础设施，另有确定性约定（见 backend-testing.md）。"""
        src = wrap('let o = SpawnOptions::new("git", &["status"]);')
        self.assertEqual(self.run_guard(src).verdict, PASS)

    def test_constant_bound_real_binary_is_a_violation(self):
        """把字面量搬进常量不能绕过 —— 事故修复正是用常量写的。"""
        src = wrap(
            'const BIN: &str = "opencode";\n'
            'let s = ServeAdapter::new(vec![BIN.into(), "serve".into()], d);\n'
            'let _ = s.list_commands(&c, None).await;'
        )
        self.assertEqual(self.run_guard(src).verdict, VIOLATION)

    # ── 护栏自身 ──────────────────────────────────────────────────────────

    def test_empty_scan_set_is_an_infra_failure(self):
        """扫描集为空属于「口径失效」，不能静默通过。"""
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, ERROR)


if __name__ == "__main__":
    unittest.main()
