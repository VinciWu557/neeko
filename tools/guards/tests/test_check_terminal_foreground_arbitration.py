"""前台仲裁护栏用例 —— A1 台账四种失败模式 + A2/A3/A4 三条零命中判据 + 作用域边界。

判据本身在 docstring 里；本文件只负责「植入违规必须红、合法形态必须绿」，
以及两条边界必须**不**误报（别域的 `tabId?:`、后端 Tauri 事件名）——
误报的代价是逼人把注释和合法代码一起删掉，那比没有护栏更糟。
"""
from __future__ import annotations

import json
import pathlib
import shutil
import tempfile
import unittest
from unittest import mock

from guards.checks import check_terminal_foreground_arbitration as subject
from guards.core import ledger as ledger_mod
from guards.core.contract import ERROR, PASS, VIOLATION
from guards.tests.support import context, make_repo

# 夹具文件：带一次 order_sort 命中的合法命中（用于让「只测 A2/A3/A4」的用例不被 A1 干扰）。
# 2026-10-15 单源化后本域已无 owner（顺序改为布局数据派生，不再有那处 sort）。
FIXTURE = "src/features/terminal/components/terminalRouting.ts"
EVENTS = "src/shared/events.ts"
OTHER = "src/features/other/thing.ts"

# ① order 相减 —— 被禁止的第二套顺序口径
ORDER_SORT = "  const first = [...tabs].sort((a, b) => a.order - b.order)[1];\n"
# ② 取集合首个 —— 绕过仲裁
FIRST_OF = "  const t = terminalTabs[0];\n"


def tab_module(body: str) -> str:
    return "export function pick(tabs: any[]) {\n" + body + "  return tabs;\n}\n"


def manifest(entries: dict) -> dict:
    return {
        "valid_kinds": ["legit", "debt"],
        "manifest": {
            path: {"kind": kind, "counts": counts, "note": "夹具"}
            for path, (kind, counts) in entries.items()
        },
    }


class ForegroundArbitrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = self.tmp / "repo"
        self.ledger_dir = self.tmp / "ledger"
        self.ledger_dir.mkdir()
        patcher = mock.patch.object(ledger_mod, "LEDGER_DIR", self.ledger_dir)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_ledger(self, entries: dict) -> None:
        (self.ledger_dir / "terminal_foreground_arbitration.json").write_text(
            json.dumps(manifest(entries), ensure_ascii=False), encoding="utf-8"
        )

    # 框架的 load_ledger 禁止空 manifest（空台账 = 护栏失判却仍报 OK），所以每条用例
    # 都至少登记 FIXTURE 一处；夹具文件固定带一次 order_sort 命中，
    # 让「只测 A2/A3/A4」的用例不因 A1 报红。
    FIXTURE_FX = tab_module(ORDER_SORT)
    FIXTURE_ENTRY = (FIXTURE, ("legit", {"order_sort": 1}))

    def run_guard(self, files: dict, extra_entries=(), base_entries=None):
        """跑护栏。

        `base_entries` 默认是「FIXTURE 已登记 + 计数 1」——因为框架的 load_ledger
        禁止空 manifest，而多数用例只关心 A2/A3/A4，不该被 A1 的台账问题干扰。
        要测「未登记命中 / 登记失效 / 计数漂移」这类用例时显式传 base_entries。
        """
        make_repo(self.root, files)
        base = [self.FIXTURE_ENTRY] if base_entries is None else list(base_entries)
        self.write_ledger(dict([*base, *extra_entries]))
        return subject.check(context(self.root))

    # ------------------------------------------------------------------ A1

    def test_consistent_ledger_passes(self):
        result = self.run_guard(
            {
                FIXTURE: self.FIXTURE_FX,
                "src/features/status-bar/registry.ts": tab_module(ORDER_SORT),
                EVENTS: "export const A = 'file-changed';\n",
            },
            [("src/features/status-bar/registry.ts", ("legit", {"order_sort": 1}))],
        )
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    def test_second_sort_implementation_is_unregistered_hit(self):
        """新加一处自带 order 排序 → 未登记命中（这就是 Q2 要拦的形态）。"""
        result = self.run_guard(
            {
                FIXTURE: self.FIXTURE_FX,
                "src/features/browser/components/pickerUtils.ts": tab_module(ORDER_SORT),
                EVENTS: "",
            },
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(
            any("A1 未登记命中" in f.message for f in result.findings),
            [f.as_text() for f in result.findings],
        )

    def test_take_first_bypasses_arbitration(self):
        result = self.run_guard(
            {FIXTURE: self.FIXTURE_FX, "src/features/browser/x.ts": tab_module(FIRST_OF), EVENTS: ""},
            # 登记的是另一个口径（order_sort），而实测是 collection_first → 漂移 + 未登记
            [("src/features/browser/x.ts", ("legit", {"order_sort": 1}))],
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("collection_first" in f.message for f in result.findings))

    def test_stale_ledger_entry_is_caught(self):
        result = self.run_guard(
            {FIXTURE: self.FIXTURE_FX, EVENTS: ""},
            [("src/features/status-bar/registry.ts", ("legit", {"order_sort": 1}))],
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("登记失效" in f.message for f in result.findings))

    def test_count_drift_is_caught(self):
        result = self.run_guard({FIXTURE: tab_module(ORDER_SORT * 2), EVENTS: ""})
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("计数漂移" in f.message for f in result.findings))

    def test_illegal_kind_is_caught(self):
        result = self.run_guard(
            {FIXTURE: self.FIXTURE_FX, EVENTS: ""},
            [(FIXTURE, ("whatever", {"order_sort": 1}))],
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("分类非法" in f.message for f in result.findings))

    def test_comment_lines_are_not_hits(self):
        """判据自身写在注释里（解释「为什么只有一处」）不能算命中 —— 否则文档会被罚掉。

        夹具：注释里同时提到两种形态 + **恰好一次**真代码命中，台账登记 order_sort=1。
        若「忘了剔注释」，实测会变成 3（注释 2 + 代码 1）→ 计数漂移报红，
        所以本用例真能抓住这个退化，不是恒绿。
        """
        commented = (
            "/**\n"
            " * 全仓唯一的一次 tab 排序（a.order - b.order）；terminalTabs[0] 一律禁止。\n"
            " */\n"
            "export function pick(tabs: any[]) {\n"
            "  return [...tabs].sort((a, b) => a.order - b.order);\n"
            "}\n"
        )
        result = self.run_guard({FIXTURE: commented, EVENTS: ""})
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    # ------------------------------------------------------------------ A2

    def test_retired_second_source_symbol_is_caught(self):
        """Map 插入顺序首个 —— 本任务删掉的第二口径，回潮即拦。"""
        files = {
            FIXTURE: self.FIXTURE_FX,
            EVENTS: "",
            "src/features/terminal/components/terminalCache.ts": (
                "export function useIt(s: any) {\n  return firstTerminalKeyOfSession(s);\n}\n"
            ),
        }
        result = self.run_guard(files)
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(
            any("A2 已删除的第二口径回潮" in f.message for f in result.findings),
            [f.as_text() for f in result.findings],
        )

    def test_retired_symbol_in_comment_is_not_a_hit(self):
        files = {
            FIXTURE: self.FIXTURE_FX,
            EVENTS: "",
            "src/features/terminal/components/terminalAgentSwitch.ts": (
                "/** 旧形态是「传 null → 内部用 firstTerminalKeyOfSession 取 Map 首个」。 */\n"
                "export const x = 1;\n"
            ),
        }
        result = self.run_guard(files)
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    # ------------------------------------------------------------------ A3

    def test_optional_tab_id_in_terminal_domain_is_caught(self):
        """`tabId?:` 改回可选对现有调用方在 TS 上完全合法 → 只有跨文件判据抓得住。"""
        files = {
            FIXTURE: self.FIXTURE_FX,
            EVENTS: "",
            "src/features/terminal/components/terminalCommands.ts": (
                "export function sendToTerminal(session: any, text: string, tabId?: string) {}\n"
            ),
        }
        result = self.run_guard(files)
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(
            any("A3 tabId 可选性回退" in f.message for f in result.findings),
            [f.as_text() for f in result.findings],
        )

    def test_nullable_tab_id_in_terminal_domain_is_caught(self):
        files = {
            FIXTURE: self.FIXTURE_FX,
            EVENTS: "",
            "src/features/terminal/components/terminalCache.ts": (
                "export function sw(session: any, tabId: string | null, agentId: string) {}\n"
            ),
        }
        result = self.run_guard(files)
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("A3 tabId" in f.message for f in result.findings))

    def test_tab_id_optionality_outside_terminal_domain_is_allowed(self):
        """别域（layoutId / editorStore / saveFile）的 `tabId?:` 是另一套合法含义 → 不在射程。

        这条是**作用域边界**的防线：判据若全域拦，会把 5 处既存合法代码一并误报，
        而误报的结局是逼人放宽判据（比没有护栏更糟）。
        """
        files = {
            FIXTURE: self.FIXTURE_FX,
            EVENTS: "",
            "src/app/utils/layoutId.ts": (
                "export function buildLayoutId(p: any, g: string, tabId: string | null) {\n  return '';\n}\n"
            ),
            "src/shared/store/editorStore.ts": "export interface S {\n  add(k: string, tabId?: string): void;\n}\n",
        }
        result = self.run_guard(files)
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    # ------------------------------------------------------------------ A4

    def test_dom_event_without_listener_is_caught(self):
        """红线 14 同型：声明了（三个派发点）却零监听者 —— 本任务的根因形态。"""
        files = {
            FIXTURE: self.FIXTURE_FX,
            EVENTS: "export const INSERT_X_EVENT = 'neeko:insert-x';\n",
            OTHER: "window.dispatchEvent(new CustomEvent(INSERT_X_EVENT));\n",
        }
        result = self.run_guard(files)
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(
            any("A4 声明了却没人监听" in f.message for f in result.findings),
            [f.as_text() for f in result.findings],
        )

    def test_dom_event_with_listener_passes(self):
        files = {
            FIXTURE: self.FIXTURE_FX,
            EVENTS: "export const INSERT_X_EVENT = 'neeko:insert-x';\n",
            OTHER: "window.addEventListener(INSERT_X_EVENT, () => {});\n",
        }
        result = self.run_guard(files)
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    def test_backend_tauri_event_names_are_out_of_scope(self):
        """边界如实声明：后端 Tauri 事件的消费点在 Rust 侧 emit，不由本判据误报。

        实测 `BROWSER_LOADING_EVENT` 前端零引用而后端确实在发（webview_ops.rs:73,80）——
        那是「后端发、前端还没接」的另一类问题。
        """
        files = {
            FIXTURE: self.FIXTURE_FX,
            EVENTS: "export const BROWSER_LOADING_EVENT = 'browser://loading';\n",
        }
        result = self.run_guard(files)
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    # ------------------------------------------------------------------ 框架边界

    def test_test_files_are_exempt(self):
        """测试里写已退役符号会在 tsc 暴露；且测试需要把旧形态写进注释解释成因。"""
        files = {
            FIXTURE: self.FIXTURE_FX,
            EVENTS: "",
            "src/features/terminal/components/__tests__/x.test.ts": tab_module(
                ORDER_SORT + FIRST_OF
            )
            + "firstTerminalKeyOfSession(1);\n",
        }
        result = self.run_guard(files)
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    # ------------------------------------------------------------------ A5

    def test_project_tabs_active_tab_id_reintroduction_is_caught(self):
        """A5：`ProjectTabs.activeTabId` 重新声明即违规（单一表示回潮）。"""
        files = {
            FIXTURE: self.FIXTURE_FX,
            EVENTS: "",
            subject.TAB_TYPES_FILE: (
                "export interface ProjectTabs {\n  tabs: string[];\n"
                "  activeTabId: string | null;\n}\n"
            ),
        }
        result = self.run_guard(files)
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(
            any("A5 单一表示回潮" in f.message for f in result.findings),
            [f.as_text() for f in result.findings],
        )

    def test_tab_order_reintroduction_is_caught(self):
        """A5：`Tab.order` 重新声明即违规。"""
        files = {
            FIXTURE: self.FIXTURE_FX,
            EVENTS: "",
            subject.TAB_TYPES_FILE: (
                "export interface Tab {\n  id: string;\n  order: number;\n}\n"
            ),
        }
        result = self.run_guard(files)
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("A5 单一表示回潮" in f.message for f in result.findings))

    def test_layout_active_tab_id_in_source_is_not_a5_hit(self):
        """边界：布局的 `groups[].activeTabId`（合法）与注释解释成因不得误报。"""
        files = {
            FIXTURE: self.FIXTURE_FX,
            EVENTS: "",
            subject.TAB_TYPES_FILE: (
                "// 前台 = groups[activeGroupId].activeTabId（布局），不再有 ProjectTabs.activeTabId\n"
                "export interface Tab {\n  id: string;\n}\n"
            ),
        }
        result = self.run_guard(files)
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    def test_empty_scan_set_is_an_infra_failure(self):
        """扫到 0 个文件 = 口径失效，必须 ERROR（不能伪装成「检查过了」）。

        台账给一份**合法非空**的（框架禁止空 manifest），确保红的是扫描集、不是台账。
        """
        self.write_ledger({FIXTURE: ("legit", {"order_sort": 1})})
        (self.root / "repo-empty").mkdir(parents=True, exist_ok=True)
        result = subject.check(context(self.root / "repo-empty"))
        self.assertEqual(result.verdict, ERROR)
        self.assertIn("0 个文件", result.error)

    def test_real_repository_is_consistent(self):
        """真实仓库必须 PASS —— 否则本任务的收敛没做完，或判据与代码对不上。

        单测里 LEDGER_DIR 被 patch 到 tmp；本用例临时指回仓库内的真实台账。
        """
        from guards.core.repo import find_repo_root

        root = find_repo_root()
        with mock.patch.object(
            ledger_mod, "LEDGER_DIR", root / "tools" / "guards" / "ledger"
        ):
            result = subject.check(context(root))
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])
        self.assertGreater(result.scanned, 0)


if __name__ == "__main__":
    unittest.main()
