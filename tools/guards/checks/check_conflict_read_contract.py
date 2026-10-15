"""Git 冲突读路径的契约护栏 —— 钉住「index stages 是唯一真值」与「缺失不归一」。

## 第一性原理

冲突不能用单文件 diff 的二元模型表达（`DiffResult = diff(A, B)`），它是三元关系
`(base, ours, theirs) + 逐区域决议`。用二元类型表达三元只有一条路 —— **丢掉一维**，
而那正是「解析工作区 `<<<<<<<` marker」的本质缺陷：

- modify/delete、binary、rename/rename 三类冲突**根本没有 marker**（marker 是合并尝试的
  渲染产物）；rename/rename 的三侧连路径都不同。
- marker 里没有 base（除非用户配了 `diff3`），于是「我方 / 对方 / 共同祖先」这一维永远缺失。

所以真值只能来自 `git ls-files -u` 的 index unmerged stages（1/2/3）。缺失 stage（DU 的
ours / UD 的 theirs / AA 的 base）必须以 `Option::None` 上浮（UI 据此显示「我方已删除」），
**绝不归一为空串** —— 把「删除」画成「空文件」既误导又丢掉决议语义。

## 判据（六条，均确定性可复现；目标恒零，不配计数台账）

- **A1（真值来源唯一）**：`src-tauri/src/common/git/conflict/**` 内 `<<<<<<<` 字面量只允许
  出现在 `regions.rs`（唯一扫描 merge 引擎自产文本的 owner）。其它文件零命中 —— 从工作区
  字节反解冲突即违规。测试文件豁免（夹具要写 golden marker 形态）。
- **A2（缺失 stage 不许归一）**：同一目录内 `unwrap_or_default()` / `unwrap_or("")` 零命中。
  缺失 stage 必须以 `Option::None` 上浮；`is_region_mergeable()` 之外的 kind 更不能把
  删除侧当空内容合并（否则选「删除」会写出空文件）。
- **A3（唯一封顶）**：`operations/` 层（派发缝）返回 `ConflictStages` 的函数必须过
  `cap_conflict_payload`（红线 4 三元载荷，唯一 wire 出口）。`conflict/local.rs` /
  `conflict/shell.rs` 是**派发缝上游的内部组装**，不在射程内 —— 封顶只做一次，重复封顶会
  对已截断内容二次截断（见下方「为什么 A3 不扫 conflict/」）。
- **A4（前端不解析 marker）**：`src/features/git/components/conflict/**` 内不得出现
  `<<<<<<<` / `=======` / `>>>>>>>` 字面量 —— 前端只渲染结构化区块，不扫文本。
- **A5（跨平台中立：禁 `/dev/null` 字面量）**：`src-tauri/src/common/git/conflict/**` 的**字符串
  字面量**内不得出现 `/dev/null`。它是 POSIX 设备名，Windows 上不存在 —— 曾使
  `git hash-object -t blob /dev/null`（AA 的空 base 占位）在 shell 分支上直接失败，
  而 backend-test 的 CI 矩阵含 windows-latest。跨平台等价写法是 `--stdin` + 空输入
  （仓内先例：`transport/tests.rs`、`common/git/credential.rs`）。
  **为何需要护栏而不是测试**：`/dev/null` 在 macOS / Linux 上行为完全正确，夹具测试
  在 POSIX 上永远绿 —— 只有静态判据能在写下的当时就拦住它（注释里的说明不算字面量，
  故只扫引号内串）。

- **A6（唯一构造点）**：传输实现（`local.rs` / `shell.rs` 及未来新增的 `*.rs`）不得自行构造
  `ConflictStages { … }` 字面量 —— 必须经 `probe::assemble_stages`。允许名单：`types.rs`（定义）、
  `probe.rs`（唯一构造点）、`cap.rs`（其内联 `#[cfg(test)]` 夹具）+ 测试文件。
  理由：领域算法按 transport 各写一份就是分叉温床（本任务已踩过两次：`other_commit` 的
  `.ok()?` 与 `size` 的 lossy 长度，均只在一侧发生）；删掉重复只是清今天，护栏才能拦住明天。
  判据扫 `ConflictStages {` 字面量，因此新 transport 文件**默认就在射程内**（不需登记）。

> 台账形态：本组判据**要的是永远为零**，故**不配计数台账**（照 `check_workspace_identity`）。
> 任一扫描集为空（glob 匹配不到文件）即判 ERROR —— 说明路径或 scope 写错，护栏实际什么都没
> 检查，绝不能静默通过（框架的 `scanned<=0` 反空转 + 这里显式 `broken` 双保险）。

## 为什么 A3 不扫 conflict/

判据的真实语义是「**跨 IPC 边界的 `ConflictStages` 必须封顶**」。唯一 wire 出口是
`common/git/operations/conflict.rs::read_conflict_stages`（派发缝，`git/commands/conflict.rs`
命令层经它取数）。`conflict/local.rs`（git2）与 `conflict/shell.rs`（WSL/SSH）**也**构造并返回
`ConflictStages`，但它们是**传输实现**，在封顶的上游：若把 cap 也压到它们头上，同一个值会被
截断两次（第二次作用在已 `truncated` 的内容上），且第三个 transport 还必须记得各自 cap ——
单一出口就没了。因此 A3 只对 `operations/` 目录内的 `ConflictStages` 返回函数判定。

## 已知边界（诚实声明）

A1/A2/A5 都是**行级**字面量判据，两类规避不在射程内：① 把字面量拆开构造
（`"<".repeat(7)`、`["/dev", "null"].join("")`）；② 把字面量放进**跨行** raw string
（`r#"…\n/dev/null\n…"#` 占多行时，逐行扫描看不到完整串）。那类规避由 `regions.rs` 的单测
（marker 解析）与 `local.rs` / `shell.rs` 的夹具测试（三侧 `content` 不含 marker、缺失侧为 `None`、
AA 经空 base 真的产出区域）兜底 —— 护栏钉的是「最可能写出的形态」，不是「所有图灵等价形态」。
"""
from __future__ import annotations

import re

from guards.core.contract import Context, Finding, Guard, GuardResult

BACKEND_CONFLICT_SCOPE = "src-tauri/src/common/git/conflict/**/*.rs"
BACKEND_OPERATIONS_SCOPE = "src-tauri/src/common/git/operations/**/*.rs"
FRONTEND_CONFLICT_SCOPE = "src/features/git/components/conflict/**/*.tsx"
FRONTEND_CONFLICT_SCOPE_TS = "src/features/git/components/conflict/**/*.ts"

# A1：唯一允许出现 `<<<<<<<` 的后端文件（marker 扫描 owner）。
A1_MARKER_OWNER = "src-tauri/src/common/git/conflict/regions.rs"
# A2：缺失 stage 归一化的两种写法。
A2_NORMALIZE_RE = re.compile(r"unwrap_or_default\s*\(\s*\)|unwrap_or\s*\(\s*\"\"\s*\)")
# A3：返回 ConflictStages 的函数签名 / 构造。
A3_RETURN_RE = re.compile(r"->\s*Result<\s*ConflictStages\s*>|->\s*ConflictStages\b")
A3_CAP_CALL = "cap_conflict_payload("
# 注释行（含 `//!` / `///` doc comment）里的 `cap_conflict_payload` 只是说明，不是接线 ——
# 判据必须只认真实调用（否则「删掉调用、留下注释」会假绿，实测踩过）。
COMMENT_LINE_RE = re.compile(r"^\s*(?://|/\*|\*)")
# A4：前端不得出现的三种冲突 marker 字面量。
A4_MARKER_RE = re.compile(r"<<<<<<<|=======|>>>>>>>")
# A1/A4 的 marker 字面量扫描（区别于注释里的说明：这里只认引号内的字符串字面量）。
MARKER_LITERAL_RE = re.compile(r"\"<<<<<<<\"")
# A5：字符串字面量内的 `/dev/null`（POSIX 设备名，Windows 上不存在）。
# 只认引号内：注释 / docstring 里解释「为何不用它」是合法的（不扫注释才拦得住真调用）。
A5_DEV_NULL_RE = re.compile(r"\"[^\"]*/dev/null[^\"]*\"")
# A6：`ConflictStages` 字面量构造 —— 只允许在唯一构造点与其合法拥有者。
A6_CONSTRUCT_RE = re.compile(r"ConflictStages\s*\{")
# 返回类型位置（`-> ConflictStages {`）是**签名**不是构造，先剥掉再找构造 —— 否则一个
# 正确调用 `assemble_stages` 的新 transport 会被误报，而误报的结局是逼人放宽判据。
# 注：只能剥除而非「整行豁免」—— 同一行既写签名又写真构造时（单行函数）必须仍拦得住。
A6_RETURN_TYPE_RE = re.compile(r"->\s*ConflictStages\s*\{")
A6_ALLOWED_OWNERS = frozenset(
    {
        "src-tauri/src/common/git/conflict/types.rs",  # 类型定义
        "src-tauri/src/common/git/conflict/probe.rs",  # 唯一构造点 assemble_stages
        "src-tauri/src/common/git/conflict/cap.rs",    # 内联 #[cfg(test)] 夹具
    }
)

TEST_PATH_MARKERS = ("tests.rs", "__tests__/", ".test.", ".spec.")


def _is_test(rel: str) -> bool:
    return any(marker in rel for marker in TEST_PATH_MARKERS)


def _scan_a1(ctx: Context) -> tuple[int, list[Finding]]:
    paths = list(ctx.glob(BACKEND_CONFLICT_SCOPE))
    findings: list[Finding] = []
    for path in paths:
        rel = ctx.rel(path)
        if rel == A1_MARKER_OWNER or _is_test(rel):
            continue
        for number, line in enumerate(ctx.read(rel).splitlines(), start=1):
            if MARKER_LITERAL_RE.search(line):
                findings.append(
                    Finding(
                        "A1 从工作区 marker 反解冲突：`<<<<<<<` 字面量只允许活在 "
                        f"{A1_MARKER_OWNER}（唯一扫描 merge 引擎自产文本的 owner）。"
                        "冲突真值是 index unmerged stages —— 四类冲突根本没有 marker",
                        rel,
                        number,
                    )
                )
    return len(paths), findings


def _scan_a2(ctx: Context) -> tuple[int, list[Finding]]:
    paths = list(ctx.glob(BACKEND_CONFLICT_SCOPE))
    findings: list[Finding] = []
    for path in paths:
        rel = ctx.rel(path)
        for number, line in enumerate(ctx.read(rel).splitlines(), start=1):
            if A2_NORMALIZE_RE.search(line):
                findings.append(
                    Finding(
                        "A2 缺失 stage 被归一为空串：`null`（stage 不存在）与 `''`（确实是空文件）"
                        "是两种语义，把「我方已删除」画成「空文件」既误导又丢掉决议依据。"
                        "缺失 stage 必须以 `Option::None` 上浮",
                        rel,
                        number,
                    )
                )
    return len(paths), findings


def _scan_a3(ctx: Context) -> tuple[int, list[Finding]]:
    paths = list(ctx.glob(BACKEND_OPERATIONS_SCOPE))
    findings: list[Finding] = []
    for path in paths:
        rel = ctx.rel(path)
        text = ctx.read(rel)
        if not A3_RETURN_RE.search(text):
            continue
        # 只认真实调用（注释行 / doc comment 里的提及不算接线）。
        code = "\n".join(
            "" if COMMENT_LINE_RE.match(line) else line for line in text.splitlines()
        )
        if A3_CAP_CALL not in code:
            findings.append(
                Finding(
                    "A3 `operations/` 返回 ConflictStages 却没过 `cap_conflict_payload`："
                    "冲突是三元载荷（三侧内容叠加极易击穿单次 IPC JSON ≤ 2MB，红线 4）。"
                    "唯一 wire 出口必须封顶",
                    rel,
                    1,
                )
            )
    return len(paths), findings


def _scan_a4(ctx: Context) -> tuple[int, list[Finding]]:
    paths = list(ctx.glob(FRONTEND_CONFLICT_SCOPE)) + list(ctx.glob(FRONTEND_CONFLICT_SCOPE_TS))
    findings: list[Finding] = []
    for path in paths:
        rel = ctx.rel(path)
        if _is_test(rel):
            continue
        for number, line in enumerate(ctx.read(rel).splitlines(), start=1):
            if A4_MARKER_RE.search(line):
                findings.append(
                    Finding(
                        "A4 前端解析冲突 marker 字面量：前端只渲染后端结构化的三侧 + 区域，"
                        "不扫文本 —— marker 不是真值（见 docs/domain-model.md）",
                        rel,
                        number,
                    )
                )
    return len(paths), findings


def _scan_a5(ctx: Context) -> tuple[int, list[Finding]]:
    paths = list(ctx.glob(BACKEND_CONFLICT_SCOPE))
    findings: list[Finding] = []
    for path in paths:
        rel = ctx.rel(path)
        for number, line in enumerate(ctx.read(rel).splitlines(), start=1):
            if A5_DEV_NULL_RE.search(line):
                findings.append(
                    Finding(
                        "A5 字符串字面量内出现 `/dev/null`：那是 POSIX 设备名，Windows 上不存在，"
                        "会让 shell 分支在 windows-latest CI 上直接失败（而本地 macOS/Linux 永远绿）。"
                        "跨平台等价写法：`--stdin` + 空输入",
                        rel,
                        number,
                    )
                )
    return len(paths), findings


def _scan_a6(ctx: Context) -> tuple[int, list[Finding]]:
    paths = list(ctx.glob(BACKEND_CONFLICT_SCOPE))
    findings: list[Finding] = []
    for path in paths:
        rel = ctx.rel(path)
        if rel in A6_ALLOWED_OWNERS or _is_test(rel):
            continue
        for number, line in enumerate(ctx.read(rel).splitlines(), start=1):
            # 剥掉返回类型位置后剩下的才是真构造（单行函数里两者可共存）。
            if A6_CONSTRUCT_RE.search(A6_RETURN_TYPE_RE.sub("", line)):
                findings.append(
                    Finding(
                        "A6 传输实现自行构造 ConflictStages 字面量：领域算法（any_binary / paths_differ /"
                        " classify / region_mergeable / 区域构建）只允许写一份 —— 经"
                        " `probe::assemble_stages`。按 transport 各写一份就是分叉温床"
                        "（`other_commit` 与 `size` 已各分叉过一次）",
                        rel,
                        number,
                    )
                )
    return len(paths), findings


GUARD = Guard(
    id="check_conflict_read_contract",
    title="Git 冲突读路径：index stages 唯一真值 / 缺失不归一 / 唯一封顶 / 前端不解析 marker / 无 /dev/null / 唯一构造点",
    scopes=(
        BACKEND_CONFLICT_SCOPE,
        BACKEND_OPERATIONS_SCOPE,
        FRONTEND_CONFLICT_SCOPE,
        FRONTEND_CONFLICT_SCOPE_TS,
    ),
    red_lines=(4, 12),
    docs="docs/domain-model.md",
    fix_hint=(
        "冲突真值只来自 index unmerged stages（`git ls-files -u` / `index.conflicts()`），"
        "不从工作区 `<<<<<<<` 反解；缺失 stage 以 `Option::None` 上浮（不 `unwrap_or_default`）；"
        "三元载荷在 `operations/conflict.rs` 派发缝经 `cap_conflict_payload` 封顶；"
        "空 blob 等占位一律用 `--stdin` 喂字节，不得依赖 `/dev/null`；"
        "传输实现只取数，三侧组装一律经 `probe::assemble_stages`（不自建 `ConflictStages` 字面量）。"
    ),
)


def check(ctx: Context) -> GuardResult:
    scanned_a1, findings_a1 = _scan_a1(ctx)
    scanned_a2, findings_a2 = _scan_a2(ctx)
    scanned_a3, findings_a3 = _scan_a3(ctx)
    scanned_a4, findings_a4 = _scan_a4(ctx)
    scanned_a5, findings_a5 = _scan_a5(ctx)
    scanned_a6, findings_a6 = _scan_a6(ctx)

    empty = [
        name
        for name, count in (
            ("A1 conflict 后端", scanned_a1),
            ("A2 conflict 后端", scanned_a2),
            ("A3 operations", scanned_a3),
            ("A4 conflict 前端", scanned_a4),
            ("A5 conflict 后端", scanned_a5),
            ("A6 conflict 后端", scanned_a6),
        )
        if count <= 0
    ]
    if empty:
        return GuardResult.broken(
            "扫描集为空 —— 判据口径或 scope 已失效，护栏实际什么都没检查："
            + ", ".join(empty)
        )

    findings = findings_a1 + findings_a2 + findings_a3 + findings_a4 + findings_a5 + findings_a6
    metrics = (
        f"conflict 后端 {scanned_a1} / operations {scanned_a3} / conflict 前端 {scanned_a4} 个文件"
        f"，{len(findings)} 处违规"
    )
    scanned = scanned_a1 + scanned_a2 + scanned_a3 + scanned_a4 + scanned_a5 + scanned_a6
    if findings:
        return GuardResult.violated(scanned, findings, metrics=metrics)
    return GuardResult.passed(scanned, metrics=metrics)
