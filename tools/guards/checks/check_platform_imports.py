"""平台 cfg 独占消费者护栏（`use` 引入名 / 局部 `let` 绑定）。

两代事故，同一类：定义在平台 cfg 之外，全部使用点却被某个平台的编译配置排除 →
该平台上 rustc 报 unused_imports / unused_variables，被 clippy `-D warnings` 升级为编译
错误；而宿主机（macOS）的单平台 clippy 看不见，只能靠 CI 三平台矩阵兜底。本护栏让它在
macOS 本机就暴露。

- `common/utils/fonts.rs`（2026-09）：`BTreeSet` / `Path` 无条件 `use` 在文件顶部，却只在
  `#[cfg(target_os = "macos")]` 分支里用 → Linux/Windows 红。
- 2026-10 三平台 CI 红的三处变体（旧版判据对它们全数漏报：只查无门控 `use`，且跳过
  `#[cfg(test)]` 模块）：
  - `file/commands.rs`：`let args` 只被 windows / macos 两个断言块消费 → Linux 报
    unused_variables；
  - `common/executor/factory.rs`：`use ExecError` 只被 `#[cfg(not(target_os = "windows"))]`
    的**测试**消费 → Windows 报 unused_imports；
  - `lsp/session/instance.rs`：`let info` 只被 `#[cfg(not(target_os = "windows"))]` 的
    **多行 assert!** 消费 → Windows 报 unused_variables。

判据：
- 定义 = 自身无平台门控的 `use` 引入名，或自身无平台门控的简单 `let` 绑定名
  （`let NAME` / `let mut NAME`，后随 `:` / `=` / `;`）；
- 使用点 = 作用域内的同名出现（`use` 为整个文件，`let` 为定义所在块），字段/路径访问
  （`self.x`、`a::x`）不算，注释与字符串里的出现不算；
- 对 linux / macos / windows 逐平台求值：**存在一个平台**使全部使用点都被编译掉 → 违规。
  成对门控（如 `#[cfg(unix)]` 与 `#[cfg(windows)]` 各消费一次）因此不会误报。
- 门控范围识别覆盖 `#[cfg]` + item、`#[cfg]` + 裸 `{` 块、`#[cfg]` + 多行非块语句
  （`assert!(...)` 这类 attr 贴语句的形态）。
- 符号完全未使用则放行（交给 unused_imports / unused_variables 本身，避免两处口径重复）。

已知未覆盖（一律走保守方向，宁可少报 —— 误报会让人把整条护栏关掉，漏报有 CI 三平台矩阵
兜底）：函数参数与 for 绑定、解构模式绑定、嵌套 cfg 的内层条件、同一块内同名遮蔽
（使用点会并集）、解析不了的 cfg 条件（`feature` 等）。

语法表层（正则、块 / 语句 / item 范围、cfg 谓词求值）已抽到 `guards.core.rust_cfg`，
与 `check_platform_cfg_placement`（附着位置判据）共用同一份表示。
"""
from __future__ import annotations

import re

from guards.core.contract import Context, Finding, Guard, GuardResult
from guards.core.rust_cfg import (
    build_identifier_index,
    enclosing_block_end,
    find_cfg_gated_ranges,
    has_cfg_gate,
    inside_ranges,
    is_platform_cfg,
    occurrences,
    some_platform_drops_all,
    strip_noise,
)

SCOPE = "src-tauri/src/**/*.rs"

USE_RE = re.compile(r"^\s*use\s+([^;]+);")
LET_RE = re.compile(r"^\s*let\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[:=;]")

GUARD = Guard(
    id="check_platform_imports",
    title="平台 cfg 独占消费者（`use` / `let`）必须把定义收进同条件 #[cfg]，或抽入 src-tauri/src/platform/<theme>/",
    scopes=(SCOPE,),
    red_lines=(10,),
    docs=".trellis/spec/backend/quality-guidelines.md",
    fix_hint=(
        "把定义收进它的唯一消费者所在作用域（`use` 加同条件 #[cfg]，或在被门控的测试函数内 "
        "局部 `use`；`let` 挪进平台块、或给每个平台补一条判据），或把该段代码抽入 "
        "src-tauri/src/platform/<theme>/（红线 10）"
    ),
)


def extract_imported_names(use_body: str) -> list:
    body = use_body.split("//")[0].strip()
    brace = re.search(r"\{([^}]+)\}", body)
    if brace:
        names = []
        for part in brace.group(1).split(","):
            part = part.strip()
            if part:
                names.append(part.split(" as ")[-1].strip() if " as " in part else part)
        return names
    if " as " in body:
        return [body.split(" as ")[-1].strip().split()[0].strip()]
    if "::*" in body:
        return []
    last = re.split(r"[^A-Za-z0-9_]", body.split("::")[-1].strip())[0]
    return [last] if last and last not in ("self", "super", "crate") else []


def scan_uses(lines: list, noise_free: list, ranges: list, index: dict):
    findings = []
    for idx, line in enumerate(noise_free):
        match = USE_RE.match(line)
        if not match:
            continue
        if inside_ranges(idx, ranges) or has_cfg_gate(lines, idx):
            continue
        for name in extract_imported_names(match.group(1)):
            usages = [
                u
                for u in occurrences(index, noise_free, name, 0, len(noise_free) - 1)
                if u != idx  # 定义行自身不算使用点
            ]
            if usages and some_platform_drops_all(usages, ranges):
                findings.append(
                    (
                        f"无条件 `use` 的 `{name}` 在某个平台上的全部使用点都会被编译掉",
                        idx + 1,
                    )
                )
                break
    return findings


def scan_lets(noise_free: list, ranges: list, index: dict):
    findings = []
    for idx, line in enumerate(noise_free):
        match = LET_RE.match(line)
        if not match:
            continue
        name = match.group(1)
        if name.startswith("_") or inside_ranges(idx, ranges):
            continue
        scope_end = enclosing_block_end(noise_free, idx)
        usages = occurrences(index, noise_free, name, idx + 1, scope_end)
        if usages and some_platform_drops_all(usages, ranges):
            findings.append(
                (f"`let {name}` 在某个平台上的全部使用点都会被编译掉", idx + 1)
            )
    return findings


def scan_file(ctx: Context, path) -> list:
    try:
        text = ctx.read_tolerant(ctx.rel(path))
    except OSError:
        return []
    lines = text.splitlines()
    if not any(is_platform_cfg(ln) and not ln.lstrip().startswith("//") for ln in lines):
        return []

    noise_free = [strip_noise(ln) for ln in lines]
    ranges = find_cfg_gated_ranges(lines, noise_free)
    index = build_identifier_index(noise_free)

    findings: list[Finding] = []
    for message, line_no in scan_uses(lines, noise_free, ranges, index) + scan_lets(
        noise_free, ranges, index
    ):
        findings.append(Finding(message, ctx.rel(path), line_no))
    return findings


def check(ctx: Context) -> GuardResult:
    files = ctx.glob(SCOPE)
    findings: list[Finding] = []
    for rs_file in files:
        findings.extend(scan_file(ctx, rs_file))

    metrics = f"{len(files)} 个 .rs / {len(findings)} 处独占消费者"
    if findings:
        return GuardResult.violated(len(files), findings, metrics=metrics)
    return GuardResult.passed(len(files), metrics=metrics)
