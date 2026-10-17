"""`check:quick` —— 轻量档的单元测试部分与非阻塞语义。

定位（本轮修正）：`check:quick` = **延迟预算内的轻量检查**，不是「只查改动文件」。
静态检查复用框架的 lint 档（`--suite lint`），所以本模块**不再自造 eslint / tsc / clippy
清单** —— 那曾经是一份与 `gates.json` 重复、必然漂移的清单。只有「改动文件的单元测试」
需要改动集这个机制，故这一层单独测。

测试只覆盖**决策逻辑**，不真的调用 vitest / test:host —— 那会让单测跑几十秒，并把
「工具装没装」变成测试前提（本仓 `check_gate_topology` A5 事故的教训：护栏读真实文件 →
夹具缺该文件 → 20 条测试全 ERROR）。但**执行上下文必须测**：`run_step` 的历史缺陷
（不传 cwd、不建模超时/工具缺失）正是「全 mock 掉 subprocess 就看不见」的那一类。
"""
from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest
from unittest import mock

from guards.core import proc, quick


def py(script: str, *extra) -> list:
    """外部命令一律由 `sys.executable` 派生（红线 13：夹具路径不得硬编码 POSIX 绝对路径）。"""
    return [sys.executable, "-c", script, *extra]


class PlanTest(unittest.TestCase):
    def kinds(self, changed):
        return [s.kind for s in quick.plan(changed).steps]

    def test_no_changes_produce_no_steps(self):
        self.assertEqual(quick.plan([]).steps, [])

    def test_frontend_change_gets_related_tests(self):
        self.assertEqual(self.kinds(["src/a.ts"]), ["frontend_tests"])

    def test_frontend_step_carries_the_changed_paths(self):
        step = quick.plan(["src/a.ts", "src/b.tsx"]).steps[0]
        self.assertEqual(step.argv[:4], ["pnpm", "exec", "vitest", "related"])
        self.assertIn("src/a.ts", step.argv)
        self.assertIn("src/b.tsx", step.argv)

    def test_test_files_count_as_frontend_changes(self):
        """测试文件本身也是前端改动（`vitest related` 实测会跑它自己）。"""
        self.assertEqual(self.kinds(["src/x/__tests__/a.test.ts"]), ["frontend_tests"])

    def test_java_host_change_declares_the_test_gap_instead_of_running_it(self):
        """`test:host` 是重量级档的（用户决定）—— 它只被 test_host / build_host 覆盖，
        所以排除后必须**显式声明缺口**，不能静默跳过，否则「绿」会被读成「都查过了」。"""
        result = quick.plan(["tools/java-host/src/Foo.java"])
        self.assertEqual(result.steps, [])
        self.assertTrue(any("test:host" in n for n in result.notes))

    def test_rust_change_declares_the_test_gap_instead_of_silently_skipping(self):
        """Rust 无 import 图，推不出该跑哪些测试 —— 必须说出来，不能让「绿」被读成「都查过了」。"""
        result = quick.plan(["src-tauri/src/lib.rs"])
        self.assertEqual(result.steps, [])
        self.assertTrue(any("cargo test" in n for n in result.notes))

    def test_rust_gap_is_not_declared_when_no_rust_changed(self):
        self.assertEqual(quick.plan(["src/a.ts"]).notes, [])

    def test_java_host_gap_is_not_declared_when_not_touched(self):
        self.assertEqual(quick.plan(["src/a.ts"]).notes, [])

    def test_mixed_change_collects_every_applicable_step(self):
        kinds = self.kinds(["src/a.ts", "tools/java-host/x.java", "src-tauri/src/lib.rs"])
        self.assertEqual(kinds, ["frontend_tests"])
        # 两侧的缺口各自声明一条，不互相吞掉。
        result = quick.plan(["tools/java-host/x.java", "src-tauri/src/lib.rs"])
        self.assertEqual(len(result.notes), 2)

    def test_unrelated_files_produce_no_steps(self):
        self.assertEqual(quick.plan(["docs/x.md", "package.json"]).steps, [])

    def test_typescript_outside_src_is_not_a_frontend_change(self):
        """回归（2026-10-16）：判据曾只看后缀，把 `src/` 之外的 `.ts` 也当前端源码。

        `src-tauri/src/agent/hooks/templates/*.ts` 是**嵌进 Rust 二进制的模板**
        （由 `include_str!` 消费），vitest 的 `include`/`coverage.include` 都是 `src/**` ——
        把它们喂给 `vitest related` 恒得「无相关测试」→ 本命令**假失败**，
        而失败原因与改动无关。反证：把 `_is_frontend` 退回只判后缀，本用例必红。
        """
        for path in [
            "src-tauri/src/agent/hooks/templates/neeko-pi-status.ts",
            "src-tauri/src/agent/hooks/templates/neeko-omp-status.ts",
            "packages/dsh-neeko/src/protocol.ts",
            ".pi/extensions/trellis/index.ts",
            "vite.config.ts",
            "commitlint.config.ts",
        ]:
            self.assertFalse(quick._is_frontend(path), f"{path} 不是前端源码")
            self.assertEqual(quick.plan([path]).steps, [], f"{path} 不该产生前端测试步骤")

    def test_src_typescript_is_still_a_frontend_change(self):
        """反向：`src/` 下的 `.ts`/`.tsx` 必须仍然被识别（修正不得过度收紧）。"""
        for path in ["src/a.ts", "src/b.tsx", "src/x/__tests__/a.test.ts"]:
            self.assertTrue(quick._is_frontend(path), f"{path} 应被视为前端源码")

    def test_windows_separators_are_normalized_before_classification(self):
        """Windows 上 git 可能给出反斜杠路径 —— 归一后才判，否则会漏报（前端改动不被测）。"""
        self.assertTrue(quick._is_frontend("src\\features\\a.ts"))
        self.assertFalse(quick._is_frontend("src-tauri\\src\\agent\\hooks\\templates\\t.ts"))

    def test_java_host_classification_normalizes_windows_separators(self):
        """**前缀型**判据必须归一反斜杠 —— 与 `_is_rust`（纯后缀）不同。

        `_is_java_host` 判的是「以 JAVA_HOST_DIR 开头」，而 Windows 上
        编辑器/手工传参可能给 `tools\\java-host\\x.java`；不归一则 `startswith` 判假，
        Java host 改动被静默排除出测试计划（假失败）。

        反证：把 `_is_java_host` 的 `.replace("\\\\", "/")` 去掉，本用例必红。
        """
        self.assertTrue(quick._is_java_host("tools\\java-host\\x.java"))
        self.assertTrue(quick._is_java_host("tools/java-host/x.java"))
        self.assertFalse(quick._is_java_host("src\\a.java"))

    def test_kinds_are_unique_so_they_can_be_used_as_dispatch_keys(self):
        kinds = self.kinds(["src/a.ts", "src/b.tsx"])
        self.assertEqual(len(kinds), len(set(kinds)))


class StaticChecksTest(unittest.TestCase):
    """静态检查**复用框架的 lint 档** —— 这里一行清单都不该有。"""

    def test_delegates_to_the_framework_lint_suite(self):
        with mock.patch.object(quick.runner, "execute", return_value=0) as execute:
            code = quick.run_static_checks(["src/a.ts"])
        self.assertEqual(code, 0)
        kwargs = execute.call_args.kwargs
        self.assertEqual(kwargs["stage"], "local")
        self.assertEqual(kwargs["suite"], "lint", "静态检查必须走框架的 lint 档（单源）")

    def test_changed_set_is_forwarded_so_the_framework_filters(self):
        with mock.patch.object(quick.runner, "execute", return_value=0) as execute:
            quick.run_static_checks(["src-tauri/src/lib.rs"])
        self.assertEqual(execute.call_args.kwargs["changed"], ["src-tauri/src/lib.rs"])

    def test_no_lint_command_is_hardcoded_in_this_module(self):
        """回归：本模块曾把 eslint / tsc / clippy 抄成常量，那是与 gates.json 重复的清单。"""
        source = pathlib.Path(quick.__file__).read_text(encoding="utf-8")
        for forbidden in ("eslint", "tsc", "clippy", "lint:rust", "lint:fe"):
            self.assertNotIn(
                f'("{forbidden}"',
                source,
                f"{forbidden} 不该在 quick.py 里出现 —— lint 清单的唯一定义点是 gates.json",
            )

    def test_no_heavy_gate_is_invoked_from_this_module(self):
        """轻量档不许拉起重量级门禁命令 —— 那是 push 的事。

        回归：本模块曾跑 `pnpm test:host`（用户判定为重量级，已排除）。`.rs` 的
        `cargo test` 同理不做（只看 `RUST_TEST_GAP` 声明）。
        """
        source = pathlib.Path(quick.__file__).read_text(encoding="utf-8")
        for forbidden in ("test:host", "test:fe", "test:rust", "cargo", "build:host"):
            self.assertNotIn(
                f'("{forbidden}"',
                source,
                f"{forbidden} 是重量级门禁命令，不该在 quick.py 里被调用",
            )

    def test_framework_error_code_propagates(self):
        with mock.patch.object(quick.runner, "execute", return_value=2):
            self.assertEqual(quick.run_static_checks([]), 2)


class RunStepTest(unittest.TestCase):
    """真实子进程 —— 执行上下文（cwd / 超时 / 工具缺失）必须被覆盖。"""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = pathlib.Path(tmp.name)

    def test_successful_command_passes(self):
        result = quick.run_step(quick.Step("k", "t", py("print('fine')")), self.root)
        self.assertTrue(result.passed)
        self.assertFalse(result.unavailable)

    def test_nonzero_exit_is_a_code_failure(self):
        result = quick.run_step(quick.Step("k", "t", py("import sys; sys.exit(3)")), self.root)
        self.assertFalse(result.passed)
        self.assertFalse(result.unavailable)

    def test_step_runs_in_the_given_root_not_the_process_cwd(self):
        """回归：`run_step` 曾经不传 cwd，从子目录调用时相对路径必然找不到文件。"""
        (self.root / "marker.txt").write_text("x", encoding="utf-8")
        result = quick.run_step(
            quick.Step(
                "k",
                "t",
                py(
                    "import pathlib,sys; sys.exit(0 if pathlib.Path('marker.txt').exists() else 9)"
                ),
            ),
            self.root,
        )
        self.assertTrue(result.passed, "命令没有在传入的 root 下执行")

    def test_missing_tool_is_unavailable_not_a_violation(self):
        """工具链缺失（如未 `pnpm install`）是环境问题，不能报成「代码有问题」。"""
        result = quick.run_step(quick.Step("k", "t", ["definitely-not-a-real-binary-xyz"]), self.root)
        self.assertFalse(result.passed)
        self.assertTrue(result.unavailable)

    def test_timeout_is_unavailable_and_does_not_hang(self):
        """工具挂死时必须终止 —— 交互命令无限等待比失败更糟。"""
        with mock.patch.object(quick, "STEP_TIMEOUT_MS", 200):
            result = quick.run_step(quick.Step("k", "t", py("import time; time.sleep(30)")), self.root)
        self.assertFalse(result.passed)
        self.assertTrue(result.unavailable)

    def test_no_related_tests_is_not_a_pass_despite_exit_zero(self):
        """`vitest related` 无相关测试时退出码仍是 0 —— 当成通过就是静默绿。"""
        result = quick.run_step(
            quick.Step(
                "k",
                "t",
                py(f"print({quick.NO_RELATED_TESTS!r} + ', exiting with code 0')"),
                no_related_tests=True,
            ),
            self.root,
        )
        self.assertFalse(result.passed)
        self.assertFalse(result.unavailable)
        self.assertIn("未找到与本次改动相关的测试文件", result.output)

    def test_other_steps_ignore_the_no_related_tests_marker(self):
        """该标记只对 vitest 相关测试步生效，别把别的步骤误伤。"""
        result = quick.run_step(
            quick.Step("k", "t", py(f"print({quick.NO_RELATED_TESTS!r})"), no_related_tests=False),
            self.root,
        )
        self.assertTrue(result.passed)


class ChangedFilesTest(unittest.TestCase):
    def _git_outputs(self, tracked, untracked):
        def fake_run(argv, **kwargs):
            stdout = tracked if "diff" in argv else untracked
            return proc.Result(proc.COMPLETED, output=stdout, returncode=0)

        return mock.patch.object(quick.proc, "run", side_effect=fake_run)

    def test_tracked_and_untracked_are_merged_and_sorted(self):
        with self._git_outputs("src/b.ts\n", "src/a.ts\n"):
            self.assertEqual(quick.changed_files("/repo"), ["src/a.ts", "src/b.ts"])

    def test_blank_lines_are_dropped(self):
        with self._git_outputs("\nsrc/b.ts\n\n", ""):
            self.assertEqual(quick.changed_files("/repo"), ["src/b.ts"])

    def test_duplicates_collapse(self):
        with self._git_outputs("src/a.ts\n", "src/a.ts\n"):
            self.assertEqual(quick.changed_files("/repo"), ["src/a.ts"])

    def test_deleted_files_are_excluded_from_the_git_query(self):
        """删除的文件已不存在，喂给后续命令只会得到与改动无关的噪音。"""
        seen = []

        def fake_run(argv, **kwargs):
            seen.append(argv)
            return proc.Result(proc.COMPLETED, output="", returncode=0)

        with mock.patch.object(quick.proc, "run", side_effect=fake_run):
            quick.changed_files("/repo")
        self.assertTrue(
            any("--diff-filter=ACMR" in argv for argv in seen), f"未排除删除的文件：{seen}"
        )

    def test_git_failure_raises_rather_than_reporting_no_changes(self):
        with mock.patch.object(
            quick.proc, "run", return_value=proc.Result(proc.COMPLETED, returncode=128)
        ):
            with self.assertRaises(RuntimeError):
                quick.changed_files("/repo")

    def test_git_unavailable_raises_rather_than_reporting_no_changes(self):
        with mock.patch.object(
            quick.proc, "run", return_value=proc.Result(proc.SPAWN_FAILED, detail="no git")
        ):
            with self.assertRaises(RuntimeError):
                quick.changed_files("/repo")


class MainTest(unittest.TestCase):
    """端到端（外部调用被 mock）：退出码与「跳过」语义。"""

    def _main(self, argv, changed, step_result=None, static_code=0):
        patches = [
            mock.patch.object(quick.repo, "find_repo_root", return_value=pathlib.Path("/repo")),
            mock.patch.object(quick, "changed_files", return_value=changed),
        ]
        if step_result is not None:
            patches.append(mock.patch.object(quick, "run_step", return_value=step_result))
        out = []
        patches.append(
            mock.patch("builtins.print", lambda *a, **k: out.append(" ".join(map(str, a))))
        )
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        # 静态检查单独 mock 并**暴露给用例**。注意存 patcher（不是 `.start()` 的返回值）：
        # `Mock.stop()` 是 Mock 自动生成的子 mock，调用它不会停掉补丁，会把 Mock 泄漏给
        # 后续用例（实测就是这么炸的）。
        static_patcher = mock.patch.object(quick, "run_static_checks", return_value=static_code)
        self.static_checks = static_patcher.start()
        self.addCleanup(static_patcher.stop)
        self.out = out
        return quick.main(argv)

    def test_no_changes_exits_zero_with_an_explicit_skip_message(self):
        code = self._main([], [])
        self.assertEqual(code, 0)
        self.assertTrue(any("跳过" in line for line in self.out))
        self.assertTrue(any("不是「检查通过」" in line for line in self.out))

    def test_static_checks_run_even_when_no_step_applies(self):
        """纯文档改动：没有测试步骤，但静态检查仍须跑（lint 档本就无关改动集）。"""
        code = self._main([], ["docs/x.md"])
        self.assertEqual(code, 0)
        self.static_checks.assert_called_once()

    def test_failing_step_exits_one(self):
        code = self._main([], ["src/a.ts"], step_result=quick.StepResult(False, "boom"))
        self.assertEqual(code, 1)

    def test_static_check_failure_exits_one(self):
        code = self._main([], ["src/a.ts"], step_result=quick.StepResult(True, ""), static_code=1)
        self.assertEqual(code, 1)

    def test_unavailable_step_exits_two_not_one(self):
        """环境问题（工具缺失/超时）必须与代码问题区分开 —— 否则会去改不该改的地方。"""
        code = self._main(
            [], ["src/a.ts"], step_result=quick.StepResult(False, "no tool", unavailable=True)
        )
        self.assertEqual(code, 2)

    def test_framework_error_exits_two(self):
        code = self._main([], ["src/a.ts"], step_result=quick.StepResult(True, ""), static_code=2)
        self.assertEqual(code, 2)

    def test_passing_steps_exit_zero(self):
        code = self._main([], ["src/a.ts"], step_result=quick.StepResult(True, ""))
        self.assertEqual(code, 0)

    def test_explicit_paths_bypass_git(self):
        with (
            mock.patch.object(quick.repo, "find_repo_root", return_value=pathlib.Path("/repo")),
            mock.patch.object(quick, "changed_files") as git,
            mock.patch.object(quick, "run_static_checks", return_value=0),
            mock.patch.object(quick, "run_step", return_value=quick.StepResult(True, "")),
            mock.patch("builtins.print"),
        ):
            code = quick.main(["src/a.ts"])
        self.assertEqual(code, 0)
        git.assert_not_called()

    def test_repo_root_failure_exits_two(self):
        with (
            mock.patch.object(
                quick.repo, "find_repo_root", side_effect=quick.repo.RepoRootNotFound("nope")
            ),
            mock.patch("builtins.print"),
        ):
            code = quick.main([])
        self.assertEqual(code, 2)


if __name__ == "__main__":
    unittest.main()
