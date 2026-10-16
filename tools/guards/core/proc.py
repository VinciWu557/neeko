"""执行原语 —— 「怎么跑一个外部命令」的唯一实现。

第一性原理：跑一个外部命令是一个**物理事实**，它有且只有三个可变参数 ——
**在哪跑**（cwd）、**等多久**（timeout）、**谁在跑**（argv）。把这三件事建模完整，
调用方就只剩「怎么解释结果」这一件自己的事。

为什么必须收成一处：`start_new_session` + `os.killpg` 的进程组清场是**平台相关**的
（Windows 只能杀直接子进程），抄成第二份必然漂移 —— 而它的失效模式很隐蔽：超时后
孙进程存活，门禁「看起来超时了」，实际还在占着 CPU / 端口。框架原先只有 `runner` 一处
实现，本模块把它提为公开原语供 `quick` 复用，而不是让 `quick` 抄一份。

三种终局（`kind`）与它们的分工：
- `COMPLETED` —— 命令跑完了，`returncode` 有意义；**是不是「通过」由调用方按自己的判据决定**
  （框架看退出码 + 平台，`quick` 还要额外识别 vitest 的「无相关测试」标记）。本模块不知道
  什么算「通过」—— 那是判据，属于调用方。
- `SPAWN_FAILED` —— 命令根本没起来（工具链缺失）。这是**环境问题**，不是被检查代码的错，
  所以既不能崩栈、也不能当成违规。
- `TIMED_OUT` —— 超时，进程组已清场。

`kind` 而非「成功/失败」：本模块只报告**发生了什么**，不替调用方下判断。
"""
from __future__ import annotations

import os
import signal
import subprocess

COMPLETED = "completed"
SPAWN_FAILED = "spawn_failed"
TIMED_OUT = "timed_out"


class Result:
    """一次执行的原始事实：`kind` + 输出 + 退出码 + 失败细节。"""

    __slots__ = ("kind", "output", "returncode", "detail")

    def __init__(self, kind, output="", returncode=None, detail=""):
        self.kind = kind
        self.output = output
        self.returncode = returncode
        self.detail = detail


def _kill_tree(proc) -> None:
    """超时清场。POSIX 杀整个进程组；Windows 只能杀直接子进程（见模块头限制）。"""
    if os.name == "posix":
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    else:
        proc.kill()


def run(argv, cwd=None, timeout_ms=None) -> Result:
    """跑一条命令并返回原始事实。**不抛异常** —— 三种终局都由 `kind` 表达。

    `start_new_session=True` 不只是为了超时清场：它让子进程脱离父进程的进程组，
    从而 Ctrl-C 不会连带把正在跑的门禁杀成「一半完成」的状态。
    """
    try:
        proc = subprocess.Popen(
            list(argv),
            cwd=str(cwd) if cwd is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
    except (FileNotFoundError, NotADirectoryError, PermissionError) as exc:
        return Result(SPAWN_FAILED, detail=f"{type(exc).__name__}: {exc}")

    try:
        stdout, stderr = proc.communicate(timeout=None if timeout_ms is None else timeout_ms / 1000)
    except subprocess.TimeoutExpired:
        _kill_tree(proc)
        # 清场后再收一次：把子进程在超时前已经写出的输出拿到，供调用方展示线索。
        stdout, stderr = proc.communicate()
        partial = (stdout or "") + (("\n" + stderr) if stderr else "")
        return Result(TIMED_OUT, output=partial)

    output = (stdout or "") + (("\n" + stderr) if stderr else "")
    return Result(COMPLETED, output=output, returncode=proc.returncode)
