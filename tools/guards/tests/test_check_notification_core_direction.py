"""notification 依赖方向护栏用例 —— 判据是「核心域 .rs 内不得出现业务模块引用」。"""
from __future__ import annotations

import unittest

from guards.checks import check_notification_core_direction as subject
from guards.core.contract import PASS, VIOLATION
from guards.tests.support import context, make_repo, temp_repo

POLICY = "src-tauri/src/notification/policy.rs"
COMMANDS = "src-tauri/src/notification/commands.rs"


class NotificationCoreDirectionTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_repo(self)

    def run_guard(self, files: dict):
        make_repo(self.root, files)
        return subject.check(context(self.root))

    def test_clean_core_domain_passes(self):
        result = self.run_guard(
            {
                POLICY: "use std::collections::HashMap;\nuse crate::notification::types::DecisionEnv;\n",
                COMMANDS: "use crate::{AppError, AppStateWrapper};\n",
            }
        )
        self.assertEqual(result.verdict, PASS)

    def test_business_module_import_is_a_violation(self):
        result = self.run_guard(
            {POLICY: "use crate::agent::chat::events::StreamEvent;\n"}
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("crate::agent", result.findings[0].message)
        self.assertEqual(result.findings[0].line, 1)

    def test_bare_module_import_also_hits(self):
        result = self.run_guard({POLICY: "use crate::terminal;\n"})
        self.assertEqual(result.verdict, VIOLATION)

    def test_infrastructure_and_platform_imports_are_allowed(self):
        result = self.run_guard(
            {
                POLICY: (
                    "use crate::common::error::AppError;\n"
                    "use crate::platform::endpoint::render;\n"
                )
            }
        )
        self.assertEqual(result.verdict, PASS)

    def test_composition_root_import_is_a_violation_but_app_state_is_allowed(self):
        # `app` 是组合根：核心域反向 import 它 = 装配循环。`app_state` 是允许的基础设施，
        # 且 `app` 的 \b 边界不得误杀它（清单漂移过一次，两条都钉住）。
        violation = self.run_guard({POLICY: "use crate::app::boot::best_effort;\n"})
        self.assertEqual(violation.verdict, VIOLATION)
        allowed = self.run_guard({POLICY: "use crate::app_state::AppStateWrapper;\n"})
        self.assertEqual(allowed.verdict, PASS)

    def test_prefix_like_module_names_not_mistaken(self):
        # `crate::terminal_v2` 这类前缀相似的名字不应被 `terminal` 误杀（\b 边界）。
        result = self.run_guard({POLICY: "use crate::notification::terminal_state::x;\n"})
        self.assertEqual(result.verdict, PASS)

    def test_grouped_import_variants_are_violations(self):
        # 分组形态（`use crate::{common::Bar, agent::Foo};`）里业务模块不在 `crate::` 之后首位：
        # rustfmt **保留** 2+ 项分组（实测），故这不是理论缺口而是真实可达路径。
        for label, src in (
            ("分组单行", "use crate::{common::Bar, agent::Foo};\n"),
            ("分组多行", "use crate::{\n    common::Bar,\n    agent::Foo,\n};\n"),
            ("空白变体", "use crate :: agent::Foo;\n"),
            ("分组+空白", "use crate :: {common::Bar, agent::Foo};\n"),
        ):
            with self.subTest(label):
                result = self.run_guard({POLICY: src})
                self.assertEqual(result.verdict, VIOLATION, f"{label} 未被拦住")
                self.assertIn("crate::agent", result.findings[0].message)

    def test_grouped_import_of_infrastructure_only_is_allowed(self):
        # 分组形态本身不违规 —— 只有业务模块成员才违规（避免「形状敏感」的误杀）。
        result = self.run_guard(
            {POLICY: "use crate::{AppError, AppStateWrapper};\n"}
        )
        self.assertEqual(result.verdict, PASS)


if __name__ == "__main__":
    unittest.main()
