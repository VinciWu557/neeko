"""`--jobs auto` 的机器派生 —— 纯函数，决定本地全量档的并发度。

存在的理由（任务 10-16）：`check` 脚本要在**不改共享契约**（`--jobs` 默认仍是 1）
的前提下拿到「按机器并发」的意图。派生逻辑收在 core 层，push / ci 档可直接复用，
不必在 `package.json` 里写不可移植的 shell 表达式（本项目三平台门禁）。
"""
from __future__ import annotations

import unittest
from unittest import mock

from guards.core import platform


class DefaultJobsTest(unittest.TestCase):
    def _with_cpus(self, value):
        with mock.patch.object(platform.os, "cpu_count", lambda: value):
            return platform.default_jobs()

    def test_many_cores_are_capped_at_four(self):
        """上限 4：长杆 test_fe 自带 6 worker，再高的门禁并发只放大竞争衰减。"""
        self.assertEqual(self._with_cpus(10), 4)
        self.assertEqual(self._with_cpus(32), 4)

    def test_the_cap_boundary_is_inclusive(self):
        self.assertEqual(self._with_cpus(4), 4)

    def test_below_the_cap_falls_back_to_sequential(self):
        """CPU < 4 时并发无收益且互相拖慢，退回串行（=1）。"""
        self.assertEqual(self._with_cpus(2), 1)
        self.assertEqual(self._with_cpus(1), 1)

    def test_cpu_count_none_is_treated_as_a_single_core(self):
        """`os.cpu_count()` 可能返回 None —— 不能让它把派生炸掉。"""
        self.assertEqual(self._with_cpus(None), 1)


class ResolveJobsTest(unittest.TestCase):
    def test_auto_is_derived_from_the_machine(self):
        with mock.patch.object(platform, "default_jobs", lambda: 4):
            self.assertEqual(platform.resolve_jobs(platform.JOBS_AUTO), 4)

    def test_explicit_positive_int_is_returned_as_is(self):
        """派生只做默认；显式传入的覆盖能力不能丢。"""
        with mock.patch.object(platform, "default_jobs", lambda: 4):
            self.assertEqual(platform.resolve_jobs(3), 3)
            self.assertEqual(platform.resolve_jobs(10), 10)


if __name__ == "__main__":
    unittest.main()
