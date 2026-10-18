"""server/ 依赖方向护栏用例 —— 判据是「引擎层 .rs 内不得出现业务模块引用与 Tauri」。"""
from __future__ import annotations

import unittest

from guards.checks import check_server_no_business_dep as subject
from guards.core.contract import PASS, VIOLATION
from guards.tests.support import context, make_repo, temp_repo

ENGINE = "src-tauri/src/server/engine.rs"
GATE = "src-tauri/src/server/gate.rs"


class ServerNoBusinessDepTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_repo(self)

    def run_guard(self, files: dict):
        make_repo(self.root, files)
        return subject.check(context(self.root))

    def test_clean_engine_passes(self):
        result = self.run_guard(
            {
                ENGINE: (
                    "use std::sync::Arc;\n"
                    "use axum::Router;\n"
                    "use crate::common::runtime::AppRuntime;\n"
                    "use crate::server::group::RouteGroup;\n"
                ),
                GATE: "use subtle::ConstantTimeEq;\n",
            }
        )
        self.assertEqual(result.verdict, PASS)

    def test_business_module_import_is_a_violation(self):
        result = self.run_guard({ENGINE: "use crate::agent::hooks::targets::HOOK_TARGETS;\n"})
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("crate::agent", result.findings[0].message)
        self.assertEqual(result.findings[0].line, 1)

    def test_grouped_import_of_business_module_is_a_violation(self):
        result = self.run_guard({GATE: "use crate::{common::AppError, project::ProjectManager};\n"})
        self.assertEqual(result.verdict, VIOLATION)

    def test_tauri_import_is_a_violation(self):
        result = self.run_guard({ENGINE: "use tauri::AppHandle;\n"})
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("tauri", result.findings[0].message)

    def test_bare_app_handle_type_is_a_violation(self):
        result = self.run_guard({ENGINE: "fn deliver(app: AppHandle) {}\n"})
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("AppHandle", result.findings[0].message)

    def test_comments_and_strings_do_not_count(self):
        result = self.run_guard(
            {
                ENGINE: (
                    "// 这里刻意不 import tauri::AppHandle —— 引擎与 Tauri 解耦\n"
                    "/* crate::agent 也不允许 */\n"
                    'const NOTE: &str = "tauri::AppHandle 只是文档里的字符串";\n'
                    "use std::sync::Arc;\n"
                )
            }
        )
        self.assertEqual(result.verdict, PASS)

    def test_raw_string_is_ignored(self):
        result = self.run_guard(
            {ENGINE: 'const S: &str = r#"tauri::AppHandle crate::agent::x"#;\n'}
        )
        self.assertEqual(result.verdict, PASS)

    def test_files_outside_scope_are_ignored(self):
        result = self.run_guard(
            {"src-tauri/src/agent/hooks/ingest/server.rs": "use tauri::AppHandle;\n"}
        )
        self.assertEqual(result.verdict, PASS)


if __name__ == "__main__":
    unittest.main()
