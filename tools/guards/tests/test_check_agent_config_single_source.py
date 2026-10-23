"""agent 配置单源护栏用例 —— 判据是「前端不得持有 agent 配置副本」。

三条判据各自独立成组：任意一条失效都对应一类真实事故（见护栏 docstring 的表格）。
"""
from __future__ import annotations

import unittest

from guards.checks import check_agent_config_single_source as subject
from guards.core.contract import PASS, VIOLATION
from guards.tests.support import context, make_repo, temp_repo

STORE = "src/shared/store/agentStore.ts"
API = "src/features/agent/api/agentApi.ts"
TERMINAL_CACHE = "src/features/terminal/components/terminalCache.ts"
TERMINAL_VIEW = "src/features/terminal/components/TerminalViewBase.tsx"
SETTINGS = "src/features/settings/components/BuiltInAgentsSection.tsx"


class AgentConfigSingleSourceTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_repo(self)

    def run_guard(self, files: dict):
        make_repo(self.root, files)
        return subject.check(context(self.root))

    # ── 判据 1：副本标识符不得出现 ──────────────────────────────────

    def test_clean_tree_passes(self):
        result = self.run_guard(
            {
                TERMINAL_CACHE: "const a = await resolveAgent(id);\n",
                SETTINGS: "const over = agent.is_overridden === true;\n",
            }
        )
        self.assertEqual(result.verdict, PASS)

    def test_agent_command_overrides_is_a_violation(self):
        result = self.run_guard(
            {TERMINAL_CACHE: "const cmd = agentCommandOverrides?.[id] ?? agent.command;\n"}
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("agentCommandOverrides", result.findings[0].message)
        self.assertEqual(result.findings[0].line, 1)

    def test_agent_overrides_is_a_violation(self):
        result = self.run_guard(
            {SETTINGS: "const cmd = config.agentOverrides?.[agent.id]?.command;\n"}
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("agentOverrides", result.findings[0].message)

    def test_store_may_mention_the_removed_fields_in_its_rationale(self):
        # 解释「它们已被删除」的注释允许提及，否则历史注释会被误报。
        result = self.run_guard(
            {STORE: " * 前端曾另存两份副本（`config.agentOverrides` / `agentCommandOverrides`）\n"}
        )
        self.assertEqual(result.verdict, PASS)

    def test_tests_are_exempt_from_the_identifier_rule(self):
        # 组件测试里的源码扫描校验的正是这条判据本身，不算「消费副本」。
        result = self.run_guard(
            {
                "src/features/settings/components/__tests__/noCopies.test.ts":
                    "expect(src).not.toContain('agentCommandOverrides');\n"
            }
        )
        self.assertEqual(result.verdict, PASS)

    # ── 判据 2：写路径只有 API 层 ───────────────────────────────────

    def test_api_layer_may_write(self):
        result = self.run_guard(
            {
                API: "await invoke<void>('add_agent', { agent });\n"
                     "await invoke<void>('remove_agent', { agentId });\n"
            }
        )
        self.assertEqual(result.verdict, PASS)

    def test_component_writing_directly_is_a_violation(self):
        result = self.run_guard({SETTINGS: "await invoke('add_agent', { agent });\n"})
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("saveAgent", result.findings[0].message)

    def test_generic_form_is_also_caught(self):
        result = self.run_guard({SETTINGS: "await invoke<void>('remove_agent', { agentId });\n"})
        self.assertEqual(result.verdict, VIOLATION)

    # ── 判据 3：终端取命令必须经 resolveAgent ───────────────────────

    def test_terminal_using_resolve_agent_passes(self):
        result = self.run_guard({TERMINAL_VIEW: "const agent = await resolveAgent(id);\n"})
        self.assertEqual(result.verdict, PASS)

    def test_terminal_reading_the_snapshot_directly_is_a_violation(self):
        result = self.run_guard(
            {TERMINAL_VIEW: "const agent = useAgentStore.getState().byId(tabAgentId);\n"}
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("resolveAgent", result.findings[0].message)

    def test_non_terminal_files_may_use_byId(self):
        # 判据只约束终端 —— 其它地方（表单初值等）同步取快照是合理的。
        result = self.run_guard({SETTINGS: "const a = useAgentStore.getState().byId(id);\n"})
        self.assertEqual(result.verdict, PASS)


if __name__ == "__main__":
    unittest.main()
