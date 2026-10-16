"""运行平台与机器事实 —— 全仓唯一一处 `sys.platform` / `os.cpu_count()` 判定。

命令门禁声明 `platforms`，框架据此决定「跑 / 显式跳过」。把判定收在这里，是为了让
`runner` 不再各自写 `sys.platform.startswith(...)`（那正是「同一规则抄成多份」的形状）。

`default_jobs()` 同理：并发度派生是**机器事实 + 策略**，收在框架内可被 package.json /
lefthook / CI 三处复用，调用方只表达「按机器并发」的意图（`--jobs auto`），不写不可移植的
shell 表达式。护栏 `check_gate_topology` 的 A5 判据保证调用点不会把 `JOBS_CAP` 抄成字面量。
"""
from __future__ import annotations

import os
import sys

# `--jobs` 的「按机器派生」取值。它是一个**显式选择**，不是新的默认值 ——
# 默认仍为 1（test_cli.py::test_defaults_are_the_unfiltered_sequential_form 有意钉住）。
JOBS_AUTO = "auto"

# 派生上限。本地全量档的长杆是 test_fe，它自己已占 vitest 的 maxWorkers=6 worker；
# 更高的门禁并发只会放大竞争衰减（实测 lint_fe 在 --jobs 4 下已从 9.5s 劣化到 34.5s），
# 而长杆不会因此变快。4 与 lefthook pre-push 的经验值一致，并给 cargo 测试线程留余量。
JOBS_CAP = 4


def jobs_rule() -> str:
    """派生规则的一句话陈述 —— `--jobs` 的 help / 护栏 / 文档共用同一句，不各写一份。"""
    return f"auto = 按 CPU 派生 min(cpu_count, {JOBS_CAP})"


def platform_tag() -> str:
    """把 `sys.platform` 归一到 `contract.PLATFORMS` 的词汇表。"""
    if sys.platform.startswith("linux"):
        return "linux"
    if sys.platform == "darwin":
        return "macos"
    if sys.platform in ("win32", "cygwin", "msys"):
        return "windows"
    return sys.platform


def default_jobs() -> int:
    """命令门禁并发度的机器派生值：`min(cpu_count, JOBS_CAP)`。

    核数不足 `JOBS_CAP` 时退回复行（返回 1）：那条机器上并发没有收益，只会让各门禁
    互相拖慢。`os.cpu_count()` 允许返回 None（无法探测），按单核处理 —— 派生函数不许炸。
    """
    cpus = os.cpu_count() or 1
    if cpus < JOBS_CAP:
        return 1
    return min(cpus, JOBS_CAP)


def resolve_jobs(value) -> int:
    """`--jobs` 的语义解析：`auto` 按机器派生，其余原样返回正整数。"""
    if value == JOBS_AUTO:
        return default_jobs()
    return int(value)
