"""执行原语 —— 三种终局与它们的边界。

`proc.run` 是「怎么跑外部命令」的唯一实现，被 `runner`（门禁）与 `quick` 共同复用。
它的价值在于把**平台相关的进程组清场**收成一份，所以这里的用例既有逻辑边界
（三种 `kind`），也有平台语义（POSIX 的孙进程必须被杀）。

夹具命令一律由 `sys.executable` 派生 —— 红线 13：不得硬编码 POSIX 绝对路径 / 依赖 bash。
"""
from __future__ import annotations

import os
import sys
import time
import unittest

from guards.core import proc


def py(script: str, *extra) -> list:
    return [sys.executable, "-c", script, *extra]


class RunTest(unittest.TestCase):
    def test_completed_carries_the_exit_code(self):
        result = proc.run(py("import sys; sys.exit(3)"))
        self.assertEqual(result.kind, proc.COMPLETED)
        self.assertEqual(result.returncode, 3)

    def test_stdout_and_stderr_are_both_captured(self):
        result = proc.run(py("import sys; print('out'); print('err', file=sys.stderr)"))
        self.assertIn("out", result.output)
        self.assertIn("err", result.output)

    def test_missing_binary_is_spawn_failed_not_an_exception(self):
        """工具链缺失必须是一条可读结论 —— 抛出会崩掉调用方，而不是让它报「护栏失效」。"""
        result = proc.run(["definitely-not-a-real-binary-xyz"])
        self.assertEqual(result.kind, proc.SPAWN_FAILED)
        self.assertIn("FileNotFoundError", result.detail)

    def test_timeout_is_reported_as_its_own_kind(self):
        result = proc.run(py("import time; time.sleep(30)"), timeout_ms=150)
        self.assertEqual(result.kind, proc.TIMED_OUT)

    def test_timeout_returns_promptly_instead_of_waiting_for_the_command(self):
        started = time.perf_counter()
        proc.run(py("import time; time.sleep(30)"), timeout_ms=150)
        self.assertLess(time.perf_counter() - started, 5.0, "超时后没有及时返回")

    def test_output_written_before_the_timeout_is_kept(self):
        """超时前已经写出的输出是定位线索 —— 丢掉它等于让超时变成哑巴。"""
        result = proc.run(
            py("import sys, time; print('clue'); sys.stdout.flush(); time.sleep(30)"),
            timeout_ms=300,
        )
        self.assertEqual(result.kind, proc.TIMED_OUT)
        self.assertIn("clue", result.output)

    def test_no_timeout_means_wait_indefinitely(self):
        result = proc.run(py("print('done')"), timeout_ms=None)
        self.assertEqual(result.kind, proc.COMPLETED)
        self.assertEqual(result.returncode, 0)

    def test_cwd_is_honoured(self):
        import pathlib
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            (pathlib.Path(tmp) / "marker").write_text("x", encoding="utf-8")
            result = proc.run(
                py("import pathlib,sys; sys.exit(0 if pathlib.Path('marker').exists() else 9)"),
                cwd=tmp,
            )
        self.assertEqual(result.returncode, 0)

    @unittest.skipUnless(os.name == "posix", "进程组语义仅 POSIX 可测")
    def test_timeout_kills_the_whole_process_group(self):
        """孙进程存活会让「已超时」变成谎言：门禁看似结束，实际还在占着 CPU / 端口。"""
        import pathlib
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            marker = pathlib.Path(tmp) / "grandchild-ran"
            script = (
                "import subprocess, sys, time\n"
                "subprocess.Popen([sys.executable, '-c',"
                " 'import pathlib,sys,time; time.sleep(0.5);"
                " pathlib.Path(sys.argv[1]).write_text(\"x\")', sys.argv[1]])\n"
                "time.sleep(30)\n"
            )
            result = proc.run(py(script, str(marker)), timeout_ms=200)
            self.assertEqual(result.kind, proc.TIMED_OUT)
            time.sleep(0.9)
            self.assertFalse(marker.exists(), "超时后孙进程仍在运行 —— 进程组未被清理")


if __name__ == "__main__":
    unittest.main()
