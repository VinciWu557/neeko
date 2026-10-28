"""`src/styles/` 目录规范护栏用例。

重点是「种一个违规必须被抓到」，否则恒绿与失效不可区分。
三条判据各自需要**正向 + 反证**用例 —— 反证尤其重要：
`components/agent-chat.css` 这类正常文件被误报，护栏就会被关掉。
"""
from __future__ import annotations

import unittest

from guards.checks import check_styles_layout as subject
from guards.core.contract import PASS, VIOLATION
from guards.tests.support import context, make_repo, temp_repo

#: 一个「够格算组件域」的 CSS 夹具：满足判据 4 的行数 / 顶层类门槛。
#: 与判据 4 无关的用例用它作底，避免被「文件太小」连带判红。
DOMAIN_CSS = (
    "@layer components {\n"
    + "".join(
        f"  .demo-{i} {{ display: flex; gap: {i}px; color: var(--text-primary); }}\n"
        for i in range(1, 26)
    )
    + "}\n"
)


class StylesLayoutGuardTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_repo(self)

    def run_guard(self, files):
        make_repo(self.root, files)
        return subject.check(context(self.root))

    # ── 判据 1：只允许四个子目录 ────────────────────────────────────

    def test_undeclared_subdirectory_is_a_violation(self):
        result = self.run_guard({"src/styles/random/foo.css": "a { color: red; }\n"})
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("random", result.findings[0].message)

    def test_every_allowed_subdirectory_passes(self):
        for subdir in sorted(subject.ALLOWED_DIRS):
            with self.subTest(subdir=subdir):
                result = self.run_guard({f"src/styles/{subdir}/x.css": DOMAIN_CSS})
                self.assertEqual(result.verdict, PASS, subdir)

    # ── 判据 2：根级只允许 index.css ────────────────────────────────

    def test_root_level_css_is_a_violation(self):
        # 2026-10-27 前的实际形态：jetbrains-mono.css / nerd-font.css 游离在根级
        result = self.run_guard({"src/styles/stray.css": "a { color: red; }\n"})
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("stray.css", result.findings[0].message)

    def test_index_css_at_root_is_allowed(self):
        result = self.run_guard({"src/styles/index.css": '@import "./base/base.css";\n'})
        self.assertEqual(result.verdict, PASS)

    # ── 判据 3：文件名 kebab-case ──────────────────────────────────

    def test_camel_case_filename_is_a_violation(self):
        result = self.run_guard({"src/styles/components/agentChat.css": DOMAIN_CSS})
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("kebab-case", result.findings[0].message)

    def test_snake_case_filename_is_a_violation(self):
        result = self.run_guard({"src/styles/components/agent_chat.css": DOMAIN_CSS})
        self.assertEqual(result.verdict, VIOLATION)

    def test_kebab_case_filename_is_allowed(self):
        # 反证：真实存在的正常文件名不得误报
        for name in ("agent-chat.css", "base.css", "lsp.css", "agent.css"):
            with self.subTest(name=name):
                result = self.run_guard({f"src/styles/components/{name}": DOMAIN_CSS})
                self.assertEqual(result.verdict, PASS, name)

    def test_digits_in_filename_are_allowed(self):
        result = self.run_guard({"src/styles/components/xterm2.css": DOMAIN_CSS})
        self.assertEqual(result.verdict, PASS)

    # ── 判据 4：components/ 下每个文件必须够一个「域」───────────────

    def test_single_control_stylesheet_is_a_violation(self):
        """真实案例：`components/form.css` 只有 14 行 / 1 个顶层类（`.custom-radio`）。

        它不构成一个组件域，却占了 `components/` 一个文件位。已迁到
        `ui/Radio.tsx` 用 Tailwind 表达，原文件删除。
        """
        result = self.run_guard(
            {
                "src/styles/components/form.css": (
                    ".custom-radio { display: inline-flex; gap: 6px; }\n"
                    ".custom-radio input { position: absolute; opacity: 0; }\n"
                    ".custom-radio .radio-mark { width: 15px; height: 15px; }\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("不足一个组件域", result.findings[0].message)

    def test_domain_sized_stylesheet_passes(self):
        result = self.run_guard({"src/styles/components/agent.css": DOMAIN_CSS})
        self.assertEqual(result.verdict, PASS)

    def test_rule_applies_only_to_components_dir(self):
        # base/ / themes/ / motion/ / fonts/ 是「层」而非「域」，不受判据 4 约束。
        for subdir in ("base", "themes", "motion", "fonts"):
            with self.subTest(subdir=subdir):
                result = self.run_guard(
                    {f"src/styles/{subdir}/x.css": "a { color: red; }\n"}
                )
                self.assertEqual(result.verdict, PASS, subdir)

    def test_many_lines_but_single_root_class_is_a_violation(self):
        # 判据是「行数 **且** 顶层类数」，只有一边达标不算一个域。
        one_root = "@layer components {\n" + "".join(
            f"  .only-root .child-{i} {{ color: red; }}\n" for i in range(1, 30)
        ) + "}\n"
        result = self.run_guard({"src/styles/components/one.css": one_root})
        self.assertEqual(result.verdict, VIOLATION)

    def test_mutation_removing_domain_judge_lets_single_control_pass(self):
        original_lines, original_classes = (
            subject.MIN_DOMAIN_LINES,
            subject.MIN_DOMAIN_CLASSES,
        )
        try:
            subject.MIN_DOMAIN_LINES = 0
            subject.MIN_DOMAIN_CLASSES = 0
            result = self.run_guard(
                {"src/styles/components/form.css": ".custom-radio { gap: 6px; }\n"}
            )
            self.assertEqual(result.verdict, PASS)
        finally:
            subject.MIN_DOMAIN_LINES = original_lines
            subject.MIN_DOMAIN_CLASSES = original_classes

    # ── 边界与统计 ────────────────────────────────────────────────

    def test_empty_scan_set_is_reported_as_nothing_checked(self):
        result = self.run_guard({})
        self.assertEqual(result.scanned, 0)

    def test_multiple_violations_in_one_file_are_all_reported(self):
        # 同时命中「根级」+ 不命中 kebab（根级已先报，不应重复报文件名）
        result = self.run_guard({"src/styles/BadName.css": "a { color: red; }\n"})
        self.assertEqual(result.verdict, VIOLATION)

    # ── 变异验证：删掉判据必须变绿 ─────────────────────────────────

    def test_mutation_removing_dir_judge_lets_undeclared_dir_pass(self):
        original = subject.ALLOWED_DIRS
        try:
            subject.ALLOWED_DIRS = frozenset({"random", "tokens", "base", "components", "fonts"})
            result = self.run_guard({"src/styles/random/foo.css": "a { color: red; }\n"})
            self.assertEqual(result.verdict, PASS)
        finally:
            subject.ALLOWED_DIRS = original

    def test_mutation_removing_kebab_judge_lets_camel_case_pass(self):
        import re

        original = subject.RE_KEBAB
        try:
            subject.RE_KEBAB = re.compile(r"^.*\.css$")
            result = self.run_guard({"src/styles/components/agentChat.css": DOMAIN_CSS})
            self.assertEqual(result.verdict, PASS)
        finally:
            subject.RE_KEBAB = original

    def test_mutation_removing_root_judge_lets_stray_root_file_pass(self):
        original = subject.ROOT_ALLOWED
        try:
            subject.ROOT_ALLOWED = frozenset({"index.css", "README.md", "stray.css"})
            result = self.run_guard({"src/styles/stray.css": "a { color: red; }\n"})
            self.assertEqual(result.verdict, PASS)
        finally:
            subject.ROOT_ALLOWED = original


if __name__ == "__main__":
    unittest.main()
