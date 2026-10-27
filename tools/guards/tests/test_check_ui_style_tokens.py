"""UI 样式 token 护栏用例 —— 重点是「种一个违规必须被抓到」，否则恒绿与失效不可区分。

另含两条**反证**：注释里提到旧写法不得误报；已合规的写法不得误报。
这两条比「抓到违规」更重要 —— 误报会让人直接关掉护栏（比没有护栏更糟）。
"""
from __future__ import annotations

import re
import unittest

from guards.checks import check_ui_style_tokens as subject
from guards.core.contract import PASS, VIOLATION
from guards.tests.support import context, make_repo, temp_repo


class UiStyleTokensGuardTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_repo(self)

    def run_guard(self, files):
        make_repo(self.root, files)
        return subject.check(context(self.root))

    # ── 判据 1：硬编码 hex ──────────────────────────────────────────
    def test_hardcoded_hex_is_a_violation(self):
        result = self.run_guard(
            {"src/a/Bad.tsx": 'const c = "text-[#3fb950]";\n'}
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("#3fb950", result.findings[0].message)

    def test_every_hex_prefix_is_covered(self):
        for prefix in ("text", "bg", "border", "ring"):
            with self.subTest(prefix=prefix):
                result = self.run_guard(
                    {"src/a/Bad.tsx": f'const c = "{prefix}-[#a371f7]";\n'}
                )
                self.assertEqual(result.verdict, VIOLATION, prefix)

    def test_every_color_function_is_covered(self):
        """判据 1 的第一性原理是「禁一切写死色值」，不是「禁 hex」。

        2026-10-27 实测：`RemoteDialog` / `WSLDialog` 里 6 处
        `bg-[rgba(97,175,239,0.15)]`（One Dark 的蓝）在 claude / light /
        classic-dark 主题下全是错的颜色，而只认 hex 的护栏报「0 处违规」——
        真的 0 命中，也是真的漏网。
        """
        for literal in (
            "bg-[rgba(97,175,239,0.15)]",
            "bg-[rgba(97,175,239,0.08)]",
            "border-[rgba(97,175,239,0.3)]",
            "text-[rgb(255,0,0)]",
            "bg-[hsl(210,50%,40%)]",
            "bg-[oklch(0.7_0.1_250)]",
            "text-[color(display-p3_1_0_0)]",
        ):
            with self.subTest(literal=literal):
                result = self.run_guard({"src/a/Bad.tsx": f'const c = "{literal}";\n'})
                self.assertEqual(result.verdict, VIOLATION, literal)

    def test_token_with_var_fallback_is_allowed(self):
        """`accent-[var(--accent-blue,#4a9eff)]` 是「token 带兜底值」，不是逃逸。

        主路径走 token，兜底只在不支持时生效 —— 禁止它等于禁止写兜底。
        """
        result = self.run_guard(
            {"src/a/Ok.tsx": 'const c = "accent-[var(--accent-blue,#4a9eff)]";\n'}
        )
        self.assertEqual(result.verdict, PASS)

    def test_token_with_opacity_suffix_is_allowed(self):
        """`bg-accent-blue/15` 是 token + 透明度，没有方括号，不该命中。"""
        result = self.run_guard(
            {"src/a/Ok.tsx": 'const c = "bg-accent-blue/15 border-accent-blue/30";\n'}
        )
        self.assertEqual(result.verdict, PASS)

    # ── 判据 2：暗色假设 ────────────────────────────────────────────
    def test_dark_assumption_is_a_violation(self):
        result = self.run_guard(
            {"src/a/Bad.tsx": 'const c = "border-b border-white/[0.04]";\n'}
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("暗色假设", result.findings[0].message)

    def test_bg_white_hover_is_a_violation(self):
        result = self.run_guard(
            {"src/a/Bad.tsx": 'const c = "hover:bg-white/10";\n'}
        )
        self.assertEqual(result.verdict, VIOLATION)

    def test_bare_bg_white_is_a_violation(self):
        """裸 `bg-white`（无斜杠与数值）也必须被抓。

        回归：护栏上线后的第一次真实运行，靠这一条抓出 `src/ui/Switch.tsx`
        的滑块 —— 手写 grep `bg-white/` 会漏掉裸写法。
        """
        result = self.run_guard(
            {"src/a/Bad.tsx": 'const c = "rounded-full bg-white shadow-sm";\n'}
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("暗色假设", result.findings[0].message)

    def test_bare_border_white_is_a_violation(self):
        result = self.run_guard(
            {"src/a/Bad.tsx": 'const c = "border border-white";\n'}
        )
        self.assertEqual(result.verdict, VIOLATION)

    # ── 判据 3：写死白字 ────────────────────────────────────────────
    def test_hardcoded_white_text_is_a_violation(self):
        result = self.run_guard(
            {"src/a/Bad.tsx": 'const c = "bg-accent-blue text-white";\n'}
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("text-white", result.findings[0].message)

    def test_text_on_accent_is_allowed(self):
        """`text-text-on-accent` 里含子串 'text-white'？不 —— 但 `text-whiter` 之类不能误报。"""
        result = self.run_guard(
            {"src/a/Ok.tsx": 'const c = "bg-accent-blue text-text-on-accent";\n'}
        )
        self.assertEqual(result.verdict, PASS)

    # ── 判据 4：focus 可见性 ────────────────────────────────────────
    def test_focus_outline_none_without_focus_visible_is_a_violation(self):
        result = self.run_guard(
            {"src/a/Bad.tsx": 'const c = "focus:outline-none";\n'}
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("focus-visible", result.findings[0].message)

    def test_focus_visible_in_same_file_satisfies_the_rule(self):
        result = self.run_guard(
            {
                "src/a/Ok.tsx": (
                    'const a = "focus:outline-none focus-visible:ring-2";\n'
                    'const b = "focus:outline-none";\n'
                )
            }
        )
        self.assertEqual(result.verdict, PASS)

    # ── 反证：不得误报 ──────────────────────────────────────────────
    def test_comment_mentioning_old_pattern_is_not_a_violation(self):
        """注释里解释「以前写死 border-white/[0.04]」不得被当成违规。

        这条是**护栏能不能活下来**的关键：token 文件里就有这种说明文字。
        """
        result = self.run_guard(
            {
                "src/styles/tokens/theme.css": (
                    "/* 业务层过去写死 border-white/[0.04] */\n"
                    "/* text-[#3fb950] 与 text-white 也要清零 */\n"
                ),
                "src/a/Ok.tsx": "export const x = 1;\n",
            }
        )
        self.assertEqual(result.verdict, PASS)

    def test_clean_code_passes(self):
        result = self.run_guard(
            {
                "src/a/Ok.tsx": (
                    'const c = "bg-bg-selected border-border-subtle '
                    'text-text-on-accent text-diff-added-text '
                    'focus-visible:ring-2 focus-visible:ring-accent-blue";\n'
                )
            }
        )
        self.assertEqual(result.verdict, PASS)
        self.assertEqual(result.scanned, 1)

    def test_empty_scan_set_is_reported_as_nothing_checked(self):
        result = subject.check(context(self.root))
        self.assertEqual(result.scanned, 0)

    # ── 变异验证：删掉判据必须变绿 ──────────────────────────────────
    def test_mutation_removing_color_judge_lets_hex_traffic_pass(self):
        """删掉判据 1 → 硬编码 hex 不再被抓（证明该判据真的在起作用）。"""
        original = subject.RE_COLOR_LITERAL.pattern
        try:
            subject.RE_COLOR_LITERAL = re.compile(r"(?!)")  # 永不匹配
            result = self.run_guard(
                {"src/a/Bad.tsx": 'const c = "text-[#3fb950]";\n'}
            )
            self.assertEqual(result.verdict, PASS)
        finally:
            subject.RE_COLOR_LITERAL = re.compile(original)

    def test_mutation_removing_focus_judge_lets_focus_violation_pass(self):
        original = subject.RE_FOCUS_NONE.pattern
        try:
            subject.RE_FOCUS_NONE = re.compile(r"(?!)")
            result = self.run_guard(
                {"src/a/Bad.tsx": 'const c = "focus:outline-none";\n'}
            )
            self.assertEqual(result.verdict, PASS)
        finally:
            subject.RE_FOCUS_NONE = re.compile(original)


if __name__ == "__main__":
    unittest.main()
