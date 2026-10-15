"""Git 冲突读路径护栏用例 —— A1–A6 各一对（合法现状 → pass / 植入违规 → VIOLATION）。

为什么每档都成对写：只测「植入违规被拦」无法证明合法现状不被误伤，而误报的结局是逼人放宽
判据（`regions.rs` 是 marker 扫描的合法 owner，`operations/conflict.rs` 是唯一封顶出口）——
比没护栏更糟。同时钉住空扫描集判 ERROR（口径失效不能静默通过）。
"""
from __future__ import annotations

import shutil
import unittest

from guards.checks import check_conflict_read_contract as subject
from guards.core.contract import ERROR, PASS, VIOLATION
from guards.tests.support import context, make_repo, temp_repo

REGIONS = "src-tauri/src/common/git/conflict/regions.rs"
LOCAL = "src-tauri/src/common/git/conflict/local.rs"
CONFLICT_TESTS = "src-tauri/src/common/git/conflict/tests.rs"
OPERATIONS = "src-tauri/src/common/git/operations/conflict.rs"
OPERATIONS_OTHER = "src-tauri/src/common/git/operations/diff.rs"
FE_VIEW = "src/features/git/components/conflict/ConflictView.tsx"
FE_VIEW_TEST = "src/features/git/components/conflict/__tests__/ConflictView.test.tsx"


class ConflictReadContractTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_repo(self)
        # 一份最小合法仓库树：A1 owner + 一个非 owner 后端文件 + 封顶的 operations 出口
        # + 前端组件。每条用例在其上做单点修改，避免互相污染。
        make_repo(
            self.root,
            {
                REGIONS: 'const MARKER_OURS: &str = "<<<<<<<";\n',
                LOCAL: "pub fn read() {}\n",
                OPERATIONS: (
                    "pub async fn read_conflict_stages() -> Result<ConflictStages> {\n"
                    "    Ok(cap_conflict_payload(stages))\n"
                    "}\n"
                ),
                FE_VIEW: "export default function ConflictView() { return null; }\n",
            },
        )

    def _write(self, rel: str, body: str):
        make_repo(self.root, {rel: body})

    # ------------------------------------------------------------------ A1

    def test_marker_literal_outside_owner_is_a_violation(self):
        self._write(LOCAL, 'pub const M: &str = "<<<<<<<";\n')
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("A1" in f.message for f in result.findings))

    def test_marker_literal_in_owner_is_allowed(self):
        # regions.rs 是 marker 扫描的唯一 owner —— 合法现状必须不报。
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    def test_marker_literal_in_backend_test_file_is_allowed(self):
        self._write(CONFLICT_TESTS, 'assert!(!content.contains("<<<<<<<"));\n')
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    # ------------------------------------------------------------------ A2

    def test_unwrap_or_default_is_a_violation(self):
        self._write(LOCAL, "let c = entry.content.unwrap_or_default();\n")
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("A2" in f.message for f in result.findings))

    def test_empty_string_normalization_is_a_violation(self):
        self._write(LOCAL, 'let c = side.content.unwrap_or("");\n')
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("A2" in f.message for f in result.findings))

    def test_option_none_is_allowed(self):
        self._write(LOCAL, "let c = match side { Some(s) => s.content, None => None };\n")
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    # ------------------------------------------------------------------ A3

    def test_operations_without_cap_is_a_violation(self):
        self._write(
            OPERATIONS,
            "pub async fn read_conflict_stages() -> Result<ConflictStages> {\n"
            "    Ok(stages)\n"
            "}\n",
        )
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("A3" in f.message for f in result.findings))

    def test_operations_with_cap_is_allowed(self):
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    def test_operations_with_cap_only_in_comment_is_a_violation(self):
        # 删除真实调用、留下 doc comment 提及 `cap_conflict_payload` = 假绿陷阱，必须报。
        self._write(
            OPERATIONS,
            "//! 唯一封顶出口是 cap_conflict_payload\n"
            "pub async fn read_conflict_stages() -> Result<ConflictStages> {\n"
            "    Ok(stages)\n"
            "}\n",
        )
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("A3" in f.message for f in result.findings))

    def test_operations_without_conflict_return_is_not_in_scope(self):
        # diff.rs 不返回 ConflictStages —— A3 不得误伤。
        self._write(OPERATIONS_OTHER, "pub fn get_file_diff() -> Result<DiffResult> { todo!() }\n")
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    # ------------------------------------------------------------------ A4

    def test_frontend_marker_is_a_violation(self):
        self._write(FE_VIEW, "const M = '<<<<<<<';\n")
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("A4" in f.message for f in result.findings))

    def test_frontend_split_marker_is_a_violation(self):
        self._write(FE_VIEW, "if (line === '=======') return;\n")
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, VIOLATION)

    def test_frontend_without_marker_is_allowed(self):
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    def test_frontend_test_file_marker_is_allowed(self):
        self._write(FE_VIEW_TEST, "expect(text).toContain('<<<<<<<');\n")
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    # ------------------------------------------------------------------ A5

    def test_dev_null_literal_is_a_violation(self):
        # POSIX 设备名在 windows-latest CI 上不存在；本地 macOS/Linux 测试永远绿 ⇒ 只能静态拦。
        self._write(
            LOCAL,
            'let oid = run_git(&["hash-object", "-t", "blob", "/dev/null"]).await?;\n',
        )
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("A5" in f.message for f in result.findings))

    def test_dev_null_mention_in_comment_is_allowed(self):
        # 解释「为何不用它」的注释必须合法，否则护栏会逼人删掉恰好防止回潮的那段文档。
        self._write(
            LOCAL,
            "/// 用 `--stdin` 喂零字节，不用 /dev/null（Windows 上不存在）。\n"
            'let oid = run_git(&["hash-object", "-t", "blob", "--stdin"]).await?;\n',
        )
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    def test_dev_null_outside_conflict_scope_is_not_in_scope(self):
        # 仓内其它处的 `/dev/null`（diff hunk 头、远端 shell 脚本）不属本护栏射程 —— 不得误伤。
        self._write(
            OPERATIONS_OTHER,
            'lines.push(format!("--- /dev/null\n+++ b/{}", fp));\n',
        )
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    # ------------------------------------------------------------------ A6

    def test_transport_constructing_stages_literal_is_a_violation(self):
        # 传输实现只取数；领域算法（classify / region_mergeable / 区域构建）只允许写一份。
        self._write(
            LOCAL,
            "pub fn read() -> Result<ConflictStages> {\n"
            "    Ok(ConflictStages { path: p, kind, region_mergeable: kind.is_region_mergeable() })\n"
            "}\n",
        )
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("A6" in f.message for f in result.findings))

    def test_new_transport_file_is_in_scope_without_registration(self):
        # 新 transport 默认就在射程内（不需登记）—— 否则下一个实现者拄一份就静默过关。
        self._write(
            "src-tauri/src/common/git/conflict/http.rs",
            "pub fn read() -> ConflictStages { ConflictStages { path: p } }\n",
        )
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("A6" in f.message for f in result.findings))

    def test_assemble_via_probe_is_allowed(self):
        # 合法形态：传输实现只调 `probe::assemble_stages`，不自建字面量。
        self._write(
            LOCAL,
            "pub fn read() -> Result<ConflictStages> {\n"
            "    Ok(assemble_stages(path, &group, sides))\n"
            "}\n",
        )
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    def test_return_type_annotation_is_not_a_construction(self):
        # `-> ConflictStages {` 是签名（`{` 是函数体），不是构造 —— 误报的结局是逼人放宽判据。
        self._write(
            LOCAL,
            "pub fn read() -> ConflictStages {\n"
            "    assemble_stages(path, &group, sides)\n"
            "}\n",
        )
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    def test_owner_files_may_construct_the_literal(self):
        # `probe.rs`（唯一构造点）/ `types.rs`（定义）/ `cap.rs`（内联测试夹具）均合法。
        make_repo(
            self.root,
            {
                "src-tauri/src/common/git/conflict/probe.rs": (
                    "pub fn assemble_stages() -> ConflictStages {\n"
                    "    ConflictStages { path: p }\n}\n"
                ),
                "src-tauri/src/common/git/conflict/cap.rs": (
                    "#[cfg(test)]\nmod tests {\n"
                    "    fn stage_with() -> ConflictStages { ConflictStages { path: p } }\n}\n"
                ),
            },
        )
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, PASS, [f.as_text() for f in result.findings])

    # ------------------------------------------------------------------ 框架边界

    def test_empty_scan_is_broken(self):
        shutil.rmtree(self.root / "src-tauri", ignore_errors=True)
        shutil.rmtree(self.root / "src", ignore_errors=True)
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, ERROR)


if __name__ == "__main__":
    unittest.main()
