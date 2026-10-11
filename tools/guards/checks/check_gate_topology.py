"""编排漂移护栏 —— 声明在 `ledger/gates.json` 的门禁必须真的被接线（A1 + A3 + A4）。

为什么需要它（PRD 动机）：门禁的「声明面」曾经是四份互不校验的复制品
（`package.json` 的 `&&` 链、`lefthook.yml` 的手写 glob、`ci.yml` 的 job、
`BRANCH_PROTECTION.md` 的 required checks），实测已漂移两次。改造后声明收敛成一份数据
（`ledger/gates.json`），本护栏负责回答：「这份声明里的每条 CI 门禁，命令真的出现在它
点名的 job 里吗？」以及「lefthook 里是不是又长回了第二份手写清单？」

- **A1**：声明了 `ci` 上下文的 gate，其命令必须在 `ci.yml` 的 `ci_job` 这个 job 的
  `run:` 步骤里找到。支持 `pnpm <script>` 与裸命令（如 `cargo check`）两种形态，
  且带词边界（`pnpm build` 不得被 `pnpm build:host` 满足）。
- **A3**：`lefthook.yml` 的 pre-commit / pre-push 只允许出现对护栏框架的**单次**调用，
  不得再出现手写门禁命令，也不允许 `&&`。（commit-msg 的 commitlint 不在 A3 范围。）
- **A4**：证据类 job（`*-test` / `*-coverage`）的 `needs` 不得含检查类 job（`*-check`）
  —— check 红时证据信号被整体短路。2026-10 事故：`backend-test needs backend-check`，
  静态检查红了一周 ⇒ 测试从未执行 ⇒ 测试层 flaky 积压到修复当天才第一次现身。
  门禁的价值 = 暴露频率 × 信号独立度（`frontend-build` 早已不 needs check，同理）。

只解析行（stdlib，无 YAML 解析器）：`ci.yml` 认 `jobs:` → 2 空格 job → 任意缩进的
`run:` 与 `needs:`（needs 支持 `needs: x` / `needs: [a, b]` / 块列表三形态，引号剥除）；
`lefthook.yml` 认顶层 hook 段 → 段内 `run:`。文件缺失/为空、或解析出 0 个
job/hook，一律判**护栏失效（ERROR）**，绝不报 PASS（否则改坏 YAML 结构会静默失效）；
两个 ci 解析器（run / needs）解析出的 job 集不一致同样判失效（防解析口径漂移）。

批次 2 待办（不在本护栏）：A2 = `BRANCH_PROTECTION.md` 的 required check 集与 `ci.yml`
job 集一致（需人肉核对 GitHub 后台实际规则，不应与框架改造混在一个 diff）。
"""
from __future__ import annotations

import re

from guards.core.contract import Context, Finding, Guard, GuardResult
from guards.core.gates import GATES_LEDGER, GateLedgerError, load_gates

CI_REL = ".github/workflows/ci.yml"
LEFTHOOK_REL = "lefthook.yml"
GATES_REL = f"tools/guards/ledger/{GATES_LEDGER}.json"

# A3 治理的 hook（commit-msg 跑 commitlint，不在此列）。
GOVERNED_HOOKS = ("pre-commit", "pre-push")
FRAMEWORK_CALL = "tools/guards/run.py"

# A4：证据类 job（测试 / 覆盖率）不得 needs 检查类 job（见模块 docstring）。
EVIDENCE_JOB_SUFFIXES = ("-test", "-coverage")
CHECK_JOB_SUFFIX = "-check"

GUARD = Guard(
    id="check_gate_topology",
    title="门禁声明与 CI/lefthook 接线一致（A1 命令落在指定 job；A3 hook 只有一条框架调用）",
    scopes=(
        CI_REL,
        LEFTHOOK_REL,
        GATES_REL,
        "package.json",
    ),
    red_lines=(),
    docs=".trellis/spec/guides/invariant-enforcement.md",
    fix_hint=(
        "改 ledger/gates.json 的声明，或把 ci.yml 的 job / lefthook.yml 的命令接回去；"
        "两者只能有一个事实源，不要手抄第二份清单。A4 违规则去掉证据类 job（*-test / "
        "*-coverage）指向 *-check 的 needs：check 红时测试/覆盖率信号必须仍被暴露。"
    ),
)


def _command_in(line: str, command: str) -> bool:
    """带词边界的整串匹配：`pnpm build` 不命中 `pnpm build:host`，反之亦然。"""
    return re.search(rf"(?<![\w:.-]){re.escape(command)}(?![\w:.-])", line) is not None


def _parse_ci_jobs(text: str) -> dict[str, list[str]]:
    """`jobs:` → {job: [run 命令, ...]}。只认 `jobs:` 段内的 2 空格 job 名。"""
    jobs: dict[str, list[str]] = {}
    current: str | None = None
    in_jobs = False
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        if indent == 0:
            in_jobs = stripped == "jobs:"
            current = None
            continue
        if not in_jobs:
            continue
        if indent == 2 and stripped.endswith(":"):
            current = stripped[:-1].strip()
            jobs.setdefault(current, [])
            continue
        if current is not None and stripped.startswith("run:"):
            value = stripped[len("run:") :].strip()
            if value and value not in ("|", ">", "|-", ">-"):
                jobs[current].append(value)
    return jobs


def _parse_ci_needs(text: str) -> dict[str, list[str]]:
    """`jobs:` → {job: [needs, ...]}。支持 `needs: x` / `needs: [a, b]` / 块列表（`needs:` + `- a`）。

    与 `_parse_ci_jobs` 共用 job 头（2 空格）识别口径；每个 job 都产出条目（空列表 = 无 needs），
    因此「两个解析器的 job 集必须相等」是一致性判据（见 `check`）。
    """
    needs: dict[str, list[str]] = {}
    current: str | None = None
    collecting: str | None = None
    in_jobs = False
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        if indent == 0:
            in_jobs = stripped == "jobs:"
            current = None
            collecting = None
            continue
        if not in_jobs:
            continue
        if indent == 2 and stripped.endswith(":"):
            current = stripped[:-1].strip()
            needs.setdefault(current, [])
            collecting = None
            continue
        if current is None:
            continue
        if stripped.startswith("needs:"):
            value = stripped[len("needs:") :].strip()
            if value:
                needs[current] = [
                    item.strip().strip("'\"")
                    for item in value.strip("[]").split(",")
                    if item.strip()
                ]
                collecting = None
            else:
                collecting = current  # 块列表形态：后续 `- x` 行
            continue
        if collecting is not None:
            if stripped.startswith("- "):
                item = stripped[2:].strip().strip("'\"")
                if item:
                    needs[collecting].append(item)
            else:
                collecting = None  # 非列表项 ⇒ 块结束
    return needs


def _parse_lefthook_runs(text: str) -> dict[str, list[str]]:
    """顶层 hook 段 → [run 命令, ...]（含嵌套 commands 下的 run）。"""
    hooks: dict[str, list[str]] = {}
    current: str | None = None
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        if indent == 0 and stripped.endswith(":"):
            current = stripped[:-1].strip()
            hooks.setdefault(current, [])
            continue
        if current is not None and stripped.startswith("run:"):
            value = stripped[len("run:") :].strip()
            if value:
                hooks[current].append(value)
    return hooks


def check_ci(gates, jobs) -> list[Finding]:
    """A1：CI 门禁的命令必须落在它点名的 job 里。"""
    findings: list[Finding] = []
    for gate in gates:
        if "ci" not in gate.stages:
            continue
        command = " ".join(gate.argv)
        if gate.ci_job not in jobs:
            findings.append(
                Finding(
                    f"gate {gate.id}: 声明在 CI job {gate.ci_job!r} 跑，但 {CI_REL} 没有这个 job "
                    "—— 声明了却没接线",
                    CI_REL,
                )
            )
            continue
        if not any(_command_in(line, command) for line in jobs[gate.ci_job]):
            findings.append(
                Finding(
                    f"gate {gate.id}: 声明 ci_job={gate.ci_job}，但该 job 的 run 步骤里找不到"
                    f"命令 `{command}` —— 声明了却没接线",
                    CI_REL,
                )
            )
    return findings


def check_lefthook(hooks) -> list[Finding]:
    """A3：pre-commit / pre-push 只允许一条命令，且必须是对门禁框架的调用，且无 `&&`。"""
    findings: list[Finding] = []
    for hook in GOVERNED_HOOKS:
        runs = hooks.get(hook)
        if not runs:
            findings.append(
                Finding(
                    f"{LEFTHOOK_REL} 的 {hook} 没有对门禁框架的调用"
                    f"（应有一条含 `{FRAMEWORK_CALL}` 的命令）",
                    LEFTHOOK_REL,
                )
            )
            continue
        if len(runs) != 1 or FRAMEWORK_CALL not in runs[0]:
            findings.append(
                Finding(
                    f"{LEFTHOOK_REL} 的 {hook} 只允许一条命令（对门禁框架的单次调用），"
                    f"实际 {len(runs)} 条：{[r for r in runs]} —— 不得手写第二份门禁清单",
                    LEFTHOOK_REL,
                )
            )
        for run in runs:
            if "&&" in run:
                findings.append(
                    Finding(
                        f"{LEFTHOOK_REL} 的 {hook} 命令不允许出现 `&&`：{run}",
                        LEFTHOOK_REL,
                    )
                )
    return findings


def check_signal_independence(needs: dict[str, list[str]]) -> list[Finding]:
    """A4：证据类 job（`*-test` / `*-coverage`）的 needs 不得含检查类 job（`*-check`）。

    为什么：check 红时被它 needs 的证据 job 整体不执行 —— 测试/覆盖率信号被隐藏，
    flaky 与真实缺陷积压（2026-10 事故整周）。check 是给合并门用的独立信号，
    不是任何证据 job 的前置；证据 job 要自带所需步骤（如 frontend-build 自带 tsc）。
    """
    findings: list[Finding] = []
    for job, deps in needs.items():
        if not job.endswith(EVIDENCE_JOB_SUFFIXES):
            continue
        blocking = [dep for dep in deps if dep.endswith(CHECK_JOB_SUFFIX)]
        if blocking:
            findings.append(
                Finding(
                    f"CI job {job!r} 的 needs 含检查类 job {blocking} —— check 红时 {job} 被短路，"
                    "测试/覆盖率信号被隐藏（2026-10 事故的放大因素）。去掉这条 needs："
                    "证据类 job 必须与检查类 job 独立并行暴露",
                    CI_REL,
                )
            )
    return findings


def check(ctx: Context) -> GuardResult:
    try:
        gates = load_gates(ctx.path(GATES_REL))
    except GateLedgerError as exc:
        return GuardResult.broken(f"gate 声明无法加载：{exc}")

    try:
        ci_text = ctx.read(CI_REL)
        lefthook_text = ctx.read(LEFTHOOK_REL)
    except (OSError, UnicodeDecodeError) as exc:
        return GuardResult.broken(
            f"无法读取 {CI_REL} 或 {LEFTHOOK_REL}：{type(exc).__name__}: {exc}"
        )
    if not ci_text.strip() or not lefthook_text.strip():
        return GuardResult.broken(
            f"{CI_REL} 或 {LEFTHOOK_REL} 为空 —— 结构损坏时必须报护栏失效，不是 PASS"
        )

    jobs = _parse_ci_jobs(ci_text)
    needs = _parse_ci_needs(ci_text)
    hooks = _parse_lefthook_runs(lefthook_text)
    if not jobs:
        return GuardResult.broken(f"{CI_REL} 没有解析出任何 job —— 解析口径或文件结构已变")
    if set(needs) != set(jobs):
        return GuardResult.broken(
            f"{CI_REL} 的 job 集在 run / needs 两个解析器之间不一致 —— 解析口径已漂移"
        )
    if not hooks:
        return GuardResult.broken(f"{LEFTHOOK_REL} 没有解析出任何 hook —— 解析口径或文件结构已变")

    findings = (
        check_ci(gates, jobs)
        + check_lefthook(hooks)
        + check_signal_independence(needs)
    )
    scanned = len(gates) + len(jobs) + len(hooks)
    metrics = (
        f"{len(gates)} 条 gate / {len(jobs)} 个 CI job / {len(hooks)} 个 hook / "
        f"{len(findings)} 处漂移"
    )
    if findings:
        return GuardResult.violated(scanned, findings, metrics=metrics)
    return GuardResult.passed(scanned, metrics=metrics)
