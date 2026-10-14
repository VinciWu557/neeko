"""Terminal 键唯一 mint 护栏用例 —— G1 符号级 / G2 形态级 / G3 材质级 / 作用域边界。

G3 的用例成对写（拦下 vs 放行），因为它的两档语义只有一边能被单侧用例证明：
只测「出 mint 文件即违规」无法证明 `fileTree.ts` 的子树指纹分隔不被误伤，
只测放行又无法证明它真的会拦 —— 误报的结局是逼人放宽判据，比没护栏更糟。
"""
from __future__ import annotations

import unittest

from guards.checks import check_terminal_key_mint as subject
from guards.core.contract import ERROR, PASS, VIOLATION
from guards.tests.support import context, make_repo, temp_repo

OTHER = "src/features/other/thing.ts"
TERMINAL_FILE = "src/features/terminal/strategies/index.ts"
MINT_FILE = "src/features/terminal/components/terminalAddress.ts"
# 10-13 S4：地址层抽出后，缓存层**不再**是 mint 文件 —— 分隔符材质出现在这里即回退。
CACHE_FILE = "src/features/terminal/components/terminalCache.ts"
TEST_FILE = "src/features/terminal/components/__tests__/thing.test.ts"

# 夹具里要写的是**字面量** `\u0001`（JS 源码文本），不是真控制字符 ——
# 所以 Python 侧必须双写反斜杠。
SEP_ESC = "\\\\u0001"


class TerminalKeyMintGuardTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_repo(self)

    def run_guard(self, files: dict):
        make_repo(self.root, files)
        return subject.check(context(self.root))

    # ------------------------------------------------------------------ G1

    def test_retired_symbol_outside_mint_is_a_violation(self):
        result = self.run_guard({OTHER: "const k = terminalCacheKey(projectId, tabId);\n"})
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("terminalCacheKey", result.findings[0].message)

    def test_retired_symbol_inside_mint_file_is_allowed(self):
        result = self.run_guard(
            {MINT_FILE: "export function terminalAddress(session, tabId) {\n  return session.key;\n}\n"}
        )
        self.assertEqual(result.verdict, PASS)

    def test_test_file_with_retired_symbol_is_allowed(self):
        result = self.run_guard({TEST_FILE: "const k = wslCacheKey('Ubuntu', projectId);\n"})
        self.assertEqual(result.verdict, PASS)

    # ------------------------------------------------------------------ G2

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

    # ------------------------------------------------------------------ G3 强材质

    def test_sep_identifier_outside_mint_is_a_violation(self):
        """`TERMINAL_KEY_SEP` 这个名字没有第二种合法用途 → 出 mint 文件即材质化第二个键。"""
        result = self.run_guard(
            {OTHER: "import { TERMINAL_KEY_SEP } from '../terminal/components/terminalCache';\n"}
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(
            any("G3" in f.message for f in result.findings),
            [f.as_text() for f in result.findings],
        )

    def test_sep_identifier_inside_mint_is_allowed(self):
        result = self.run_guard(
            {MINT_FILE: "export const TERMINAL_KEY_SEP = '\\u0001';\n"}
        )
        self.assertEqual(result.verdict, PASS)

    def test_sep_identifier_in_cache_file_is_a_violation(self):
        """S4 后唯一 mint 是 `terminalAddress.ts`：材质再现在缓存层 = 地址层被内联回退。"""
        result = self.run_guard(
            {CACHE_FILE: "export const TERMINAL_KEY_SEP = '\\u0001';\n"}
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("G3" in f.message for f in result.findings))

    # ------------------------------------------------------------------ G3 语境材质

    def test_escaped_sep_with_terminal_context_is_a_violation(self):
        result = self.run_guard(
            {OTHER: f"const cacheKey = session.key + '{SEP_ESC}' + tabId;\n"}
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("G3" in f.message for f in result.findings))

    def test_x01_form_is_also_caught(self):
        """逐形态实测（docstring 的取证教训）：`\\x01` 与 `\\u0001` 同档。"""
        result = self.run_guard({OTHER: "const terminalKey = a + '\\x01' + paneId;\n"})
        self.assertEqual(result.verdict, VIOLATION)

    def test_fromCharCode_form_is_also_caught(self):
        result = self.run_guard(
            {OTHER: "const SEP = String.fromCharCode(1); // cacheKey 段界\n"}
        )
        self.assertEqual(result.verdict, VIOLATION)

    def test_escaped_sep_without_terminal_context_is_allowed(self):
        """`fileTree.ts` 的子树指纹分隔 —— 合法的无关命名空间，**必须不报**。

        这条是真实仓库里唯一的既存命中（实测 115/116/137 三行）；若它被拦，
        说明语境档退化成了「见到 `\\u0001` 就报」，那是 design §7 T7 的失效方式。
        """
        result = self.run_guard(
            {"src/shared/utils/fileTree.ts": f"const fps = kids.join('{SEP_ESC}');\n"}
        )
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    def test_escaped_sep_in_test_file_is_allowed(self):
        """测试夹具需要写 golden 键形态（`terminalAddress.test.ts`），走测试豁免。"""
        result = self.run_guard(
            {TEST_FILE: f"expect(key).toBe(`proj1\\u0000{SEP_ESC}tabA{SEP_ESC}p1`);\n"}
        )
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    # ------------------------------------------------------------------ 框架边界

    def test_empty_scan_is_broken(self):
        self.root.mkdir(parents=True, exist_ok=True)
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, ERROR)


if __name__ == "__main__":
    unittest.main()
