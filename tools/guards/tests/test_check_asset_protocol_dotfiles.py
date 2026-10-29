"""assetProtocol scope dotfile 护栏用例。"""
from __future__ import annotations

import json
import unittest

from guards.checks import check_asset_protocol_dotfiles as subject
from guards.core.contract import ERROR, PASS, VIOLATION
from guards.tests.support import context, make_repo, temp_repo

CONF = subject.CONF


def conf_with(asset_scope, enable: bool = True) -> str:
    return json.dumps(
        {
            "app": {
                "security": {
                    "assetProtocol": (
                        {"enable": enable, "scope": asset_scope} if enable else {"enable": False}
                    )
                }
            }
        }
    )


class AssetProtocolDotfilesTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_repo(self)

    def run_guard(self, text: str):
        make_repo(self.root, {CONF: text})
        return subject.check(context(self.root))

    def test_object_scope_with_dotfiles_allowed_passes(self):
        result = self.run_guard(
            conf_with({"allow": ["**"], "requireLiteralLeadingDot": False})
        )
        self.assertEqual(result.verdict, PASS)
        self.assertIn("requireLiteralLeadingDot=false", result.metrics)

    def test_kebab_alias_is_accepted(self):
        """Tauri 的 serde 别名 require-literal-leading-dot 等价，不该误报。"""
        result = self.run_guard(
            conf_with({"allow": ["**"], "require-literal-leading-dot": False})
        )
        self.assertEqual(result.verdict, PASS)

    def test_shorthand_array_is_a_violation(self):
        """简写数组 = Unix 默认禁止点开头路径段 ⇒ docs/.img/*.png 静默 403（本次事故形态）。"""
        result = self.run_guard(conf_with(["**"]))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("简写数组", result.findings[0].message)
        self.assertIn(".img", result.findings[0].message)

    def test_object_scope_without_the_flag_is_a_violation(self):
        result = self.run_guard(conf_with({"allow": ["**"]}))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("requireLiteralLeadingDot", result.findings[0].message)

    def test_explicit_true_is_a_violation(self):
        result = self.run_guard(conf_with({"allow": ["**"], "requireLiteralLeadingDot": True}))
        self.assertEqual(result.verdict, VIOLATION)

    def test_empty_allow_list_is_a_violation(self):
        result = self.run_guard(conf_with({"allow": [], "requireLiteralLeadingDot": False}))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("allow", result.findings[0].message)

    def test_disabled_asset_protocol_is_out_of_scope(self):
        result = self.run_guard(conf_with(["**"], enable=False))
        self.assertEqual(result.verdict, PASS)
        self.assertIn("不适用", result.metrics)

    def test_missing_config_is_an_infra_failure(self):
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, ERROR)

    def test_invalid_json_is_an_infra_failure(self):
        result = self.run_guard("{ not json")
        self.assertEqual(result.verdict, ERROR)
        self.assertIn("JSON", result.error)


if __name__ == "__main__":
    unittest.main()
