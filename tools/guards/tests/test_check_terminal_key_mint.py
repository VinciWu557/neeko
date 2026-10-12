"""Terminal 键唯一 mint 护栏用例 —— G1 符号级 / G2 形态级 / 作用域边界。"""
from __future__ import annotations

import unittest

from guards.checks import check_terminal_key_mint as subject
from guards.core.contract import ERROR, PASS, VIOLATION
from guards.tests.support import context, make_repo, temp_repo

OTHER = "src/features/other/thing.ts"
TERMINAL_FILE = "src/features/terminal/strategies/index.ts"
MINT_FILE = "src/features/terminal/components/terminalCache.ts"
TEST_FILE = "src/features/terminal/components/__tests__/thing.test.ts"


class TerminalKeyMintGuardTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_repo(self)

    def run_guard(self, files: dict):
        make_repo(self.root, files)
        return subject.check(context(self.root))

    def test_retired_symbol_outside_mint_is_a_violation(self):
        result = self.run_guard({OTHER: "const k = terminalCacheKey(projectId, tabId);\n"})
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("terminalCacheKey", result.findings[0].message)

    def test_retired_symbol_inside_mint_file_is_allowed(self):
        result = self.run_guard(
            {MINT_FILE: "export function terminalAddress(session, tabId) {\n  return session.key;\n}\n"}
        )
        self.assertEqual(result.verdict, PASS)

    def test_template_env_key_in_terminal_domain_is_a_violation(self):
        result = self.run_guard(
            {TERMINAL_FILE: "const key = `${projectId}:wt:${path}:${tabId}`;\n"}
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("wt:" in f.message for f in result.findings))

    def test_template_env_key_outside_terminal_domain_is_allowed(self):
        result = self.run_guard({OTHER: "const key = `${projectId}:wt:${path}`;\n"})
        self.assertEqual(result.verdict, PASS)

    def test_plain_colon_string_without_interpolation_is_allowed(self):
        result = self.run_guard({TERMINAL_FILE: "const label = 'wt: main checkout';\n"})
        self.assertEqual(result.verdict, PASS)

    def test_test_file_with_retired_symbol_is_allowed(self):
        result = self.run_guard({TEST_FILE: "const k = wslCacheKey('Ubuntu', projectId);\n"})
        self.assertEqual(result.verdict, PASS)

    def test_empty_scan_is_broken(self):
        self.root.mkdir(parents=True, exist_ok=True)
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, ERROR)


if __name__ == "__main__":
    unittest.main()
