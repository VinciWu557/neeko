"""测试域平台 cfg 附着位置护栏（L2 禁令：门控粒度必须 ≥ 作用域粒度）。

第一性原理（详见 `.trellis/tasks/10-11-test-platform-cfg-item-scope/design.md` §0）：
「定义与消费者的编译配置可分离」只有一种结构条件 —— 门控挂在**片段**上（门控粒度 < 作用域粒度）。
把门控提到 item 级后，item 与其内部全部消费者同生共死，`unused_imports` / `unused_variables`
这一类（2026-08 `app_menu.rs` → 2026-09 `fonts.rs` → 2026-10 `commands.rs`/`factory.rs`/`instance.rs`）
**不可写出**。因此本护栏是**结构约束**（判附着位置，可完备、零误报），
与 `check_platform_imports`（消费者分析，语义近似、作兜底）互补。

判据：
- **域**（三种形态，见 `test_domain_ranges` / `external_test_modules`）：
  ① 内联 `#[cfg(test)] mod tests { … }`；② `#[cfg(test)] mod tests;` 指向的**整文件**；
  ③ cfg 谓词含 `test` 的 item（如 `#[cfg(all(test, unix))] fn …`）的块体。
- **允许**：平台 cfg 附着于 item 声明 —— `fn` / `mod` / `use` / `struct` / `enum` / `impl` /
  `trait` / `union` / `const` / `static` / `type` / `macro_rules`（含 `pub` / `async` / `unsafe` /
  `extern "C"` / `const` 前缀与 `#[tokio::test]` 这类叠加属性）。
- **违规**：附着于裸块 `{`、语句（`let` / 断言 / 表达式 / `for|if|while|match|loop`）、
  match arm（`=>`）、字段 init（`name: …` / 简写 `name,`）。
- **保守放行**：附着形态判不出（EOF、测试局部枚举的变体声明、未知构造）→ 不报，计为松弛面。
  宁可少报 —— 误报会阻断提交并诱发"关掉护栏"，漏报由 `check_platform_imports` 与
  CI 三平台 `--all-targets` 矩阵兜底。

基线（ratchet，过渡债表）`tools/guards/ledger/platform_test_cfg.json`：
- 文件**缺失 = 空基线（零容忍）**——这是本任务 DoD 的终态，因此**不登记进 `Guard.ledger`**
  （那要求文件必须存在，与终态自相矛盾）；存在但不可解析 → 护栏失效（退出码 2）。
- 已登记文件按 `{stmt, block}` 两类分别只许减小（防同文件内形态洗牌）；未登记文件计数 >0 即违规。
- 基线一次性生成（**禁手抄**）：

```bash
python3 - <<'PY'
import json, pathlib, sys
sys.path.insert(0, "tools")
from guards.core.contract import Context
from guards.checks import check_platform_cfg_placement as g
scan = g.collect(Context(repo_root=pathlib.Path(".").resolve()))
ledger = {"note": "基线由 check_platform_cfg_placement.py 模块 docstring 的命令一次性生成；只许缩小。",
          "baseline": scan.records}
pathlib.Path("tools/guards/ledger/platform_test_cfg.json").write_text(
    json.dumps(ledger, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
print(len(scan.files), "个 .rs；测试域门控", scan.domain_gates, "处；fragment",
      sum(sum(c.values()) for c in scan.records.values()), "处")
PY
```

已知边界（一律向"少报"收敛）：宏体内展开 / `cfg_if!`（本仓零使用）不看；生产域不在本判据
（含派生门控的 match arm / 字段 init 需类型层决策，属 L1 任务）；`#[cfg(feature)]` 非平台门控。
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from guards.core.contract import Context, Finding, Guard, GuardResult
from guards.core.ledger import LEDGER_DIR, LedgerError, load_ledger
from guards.core.rust_cfg import body_open_line, brace_end, is_platform_cfg, strip_noise

SCOPE = "src-tauri/src/**/*.rs"
LEDGER_NAME = "platform_test_cfg"

CFG_ATTR_RE = re.compile(r"^\s*#\s*\[\s*cfg\s*\((.*)\)\s*\]")
MOD_DECL_RE = re.compile(r"mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;")
ITEM_DECL_RE = re.compile(
    r"(?:(?:pub(?:\s*\([^)]*\))?|unsafe|async|const|extern\s+\"[^\"]*\"|default)\s+)*"
    r"(?:fn|mod|use|struct|enum|impl|trait|union|const|static|type|macro_rules)\b"
)
FIELD_INIT_WITH_TYPE_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\s*:")
FIELD_INIT_SHORT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\s*,")
KEYWORD_STATEMENTS = ("let ", "for ", "if ", "while ", "match ", "loop ")

KIND_LABEL = {"stmt": "语句/表达式/arm/字段", "block": "裸块"}

GUARD = Guard(
    id="check_platform_cfg_placement",
    title="测试域的平台 cfg 只许挂 item 声明（整测试 / gated helper），禁止 fragment 级门控",
    scopes=(SCOPE,),
    red_lines=(10,),
    docs=".trellis/spec/backend/quality-guidelines.md",
    fix_hint=(
        "把门控提到 item 级：① 平台断言 → 按平台命名的整测试（平台维度上移测试名）；"
        "② 平台常量 / 夹具 → `#[cfg(...)]` 的 item 级 const / helper（每个平台留一条真实腿，"
        "无腿平台给空 stub）；③ 差异本身 → 收进 src-tauri/src/platform/<theme>/ 的适配器数据"
    ),
)


def gate_includes_test(attr_line: str) -> bool:
    """该 cfg 属性是否含 `test` 且顶层不是否定（`not(test)` / `not(all(test, …))` 排除）。"""
    match = CFG_ATTR_RE.match(attr_line)
    if not match:
        return False
    body = match.group(1).strip()
    if body.startswith("not("):
        return False
    return re.search(r"\btest\b", body) is not None


def next_item_line(lines: list, i: int) -> int:
    """属性行之后首个"非属性、非注释、非空行"的行号（EOF 返回 -1）。"""
    j = i + 1
    while j < len(lines):
        s = lines[j].strip()
        if s and not s.startswith(("#", "//")):
            return j
        j += 1
    return -1


def test_domain_ranges(lines: list, noise_free: list) -> list:
    """内联测试模块与含 test 的 item 的块范围 [start, end]（外部模块见 external_test_modules）。

    只对**带块体的 item** 产生范围 —— 判据落在 `body_open_line`（结构：头部终止符前是否
    出现 `{`），不枚举 item 种类。`#[cfg(test)] use X;` 这类无体 item 必须跳过：否则
    `brace_end` 会向后找下一个 `{`，把**生产代码**吞进测试域（实测误报，`#[cfg(test)]
    use AtomicUsize;` 之后的生产 fragment 被判为测试域违规）。
    """
    ranges = []
    for i, line in enumerate(lines):
        if line.lstrip().startswith("//") or not gate_includes_test(line):
            continue
        j = next_item_line(lines, i)
        if j < 0:
            continue
        open_line = body_open_line(noise_free, j)
        if open_line is None:
            continue  # 无体 item（use/const/static/type/字段/mod X; …）→ 不产生范围（保守）
        ranges.append((i, brace_end(noise_free, open_line)))
    return ranges


def external_test_modules(files: list, lines_by_file: dict) -> set:
    """`#[cfg(test)] mod NAME;` 指向的测试子文件（`NAME.rs` 或 `NAME/mod.rs`）→ 整文件入域。"""
    present = set(files)
    out = set()
    for path, lines in lines_by_file.items():
        for i, line in enumerate(lines):
            if line.lstrip().startswith("//") or not gate_includes_test(line):
                continue
            j = next_item_line(lines, i)
            if j < 0:
                continue
            match = MOD_DECL_RE.match(lines[j].strip())
            if not match:
                continue
            for candidate in (
                path.parent / f"{match.group(1)}.rs",
                path.parent / match.group(1) / "mod.rs",
            ):
                if candidate in present:
                    out.add(candidate)
    return out


def attached_kind(lines: list, i: int) -> str:
    """门控附着的构造类别：`ok`（item 声明 / 判不出，保守放行）或 `block` / `stmt`。"""
    j = next_item_line(lines, i)
    if j < 0:
        return "ok"
    s = lines[j].strip()
    if s.startswith("{"):
        return "block"
    if ITEM_DECL_RE.match(s):
        return "ok"
    if "=>" in s:
        return "stmt"
    if s.startswith(KEYWORD_STATEMENTS):
        return "stmt"
    if FIELD_INIT_WITH_TYPE_RE.match(s) or FIELD_INIT_SHORT_RE.match(s):
        return "stmt"
    if s.endswith(";") or s.endswith("("):
        return "stmt"
    return "ok"  # 判不出 → 保守放行（宁可少报）


@dataclass(frozen=True)
class ScanResult:
    """一次全仓扫描的完整结果 —— 替代 4 元组：字段名即文档，调用点不再靠位置记忆。"""

    files: list  # 参与判定的 .rs（ctx.glob 结果）
    records: dict  # {rel: {"stmt": n, "block": m}} —— 与基线台账同构
    details: dict  # {rel: [(line, kind)]} —— 站点明细（报告与维护提示用）
    domain_gates: int  # 测试域内的平台门控总数（含合法 item 级）


def collect(ctx: Context) -> ScanResult:
    """扫描全仓测试域：文件集、按文件计数、站点明细、域内门控总数。"""
    files = ctx.glob(SCOPE)
    lines_by_file = {}
    for path in files:
        try:
            text = ctx.read_tolerant(ctx.rel(path))
        except OSError:
            continue
        lines_by_file[path] = text.splitlines()
    noise_by_file = {
        path: [strip_noise(line) for line in lines] for path, lines in lines_by_file.items()
    }
    external = external_test_modules(list(lines_by_file), lines_by_file)

    records: dict[str, dict] = {}
    details: dict[str, list] = {}
    domain_gates = 0
    for path, lines in lines_by_file.items():
        if not any(is_platform_cfg(line) and not line.lstrip().startswith("//") for line in lines):
            continue
        noise = noise_by_file[path]
        ranges = test_domain_ranges(lines, noise)
        whole_file_test = path in external
        rel = ctx.rel(path)
        for i, line in enumerate(lines):
            if not (CFG_ATTR_RE.match(line) and is_platform_cfg(line)):
                continue
            if not (whole_file_test or any(start <= i <= end for start, end in ranges)):
                continue
            domain_gates += 1
            kind = attached_kind(lines, i)
            if kind == "ok":
                continue
            records.setdefault(rel, {"stmt": 0, "block": 0})[kind] += 1
            details.setdefault(rel, []).append((i + 1, kind))
    return ScanResult(
        files=files, records=records, details=details, domain_gates=domain_gates
    )


def evaluate(records: dict, details: dict, baseline: dict) -> list[Finding]:
    """按 ratchet 判违规。两种报告粒度是有意的：

    - **未登记文件**：每文件一条 —— 零容忍场景把全部站点一次列全，便于一次迁完；
    - **已登记文件**：每形态类（stmt / block）一条 —— 把回归钉在具体类上，配合台账的两类
      计数，防止"同文件内把 stmt 换成 block"的洗牌。
    """
    findings: list[Finding] = []
    for rel, counts in sorted(records.items()):
        sites = ", ".join(f":{line}" for line, _ in details[rel])
        if rel not in baseline:
            findings.append(
                Finding(
                    "测试域出现 fragment 级平台门控（门控粒度必须 ≥ 作用域粒度）"
                    f"：{sites} —— 改为整测试 / item 级 gated helper（每平台一条真实腿）/ 适配器数据",
                    rel,
                    details[rel][0][0],
                )
            )
            continue
        limit = baseline[rel]
        for kind in ("stmt", "block"):
            count = counts.get(kind, 0)
            limit_n = int(limit.get(kind, 0))
            if count <= limit_n:
                continue
            kind_sites = ", ".join(f":{line}" for line, k in details[rel] if k == kind)
            findings.append(
                Finding(
                    f"已登记基线 {kind}={limit_n} 处，现存 {count} 处（{KIND_LABEL[kind]}：{kind_sites}）"
                    "—— ratchet 只许减小（迁移参考 design.md 附录 A）",
                    rel,
                    details[rel][0][0],
                )
            )
    return findings


def baseline_notes(records: dict, baseline: dict, present: set) -> list[str]:
    """基线维护提示：可清理（归零 / 文件已删）与可下调（迁移进行中的部分缩小）。"""
    notes = []
    for rel in sorted(baseline):
        limit = baseline[rel]
        if rel not in present:
            notes.append(f"基线残留（文件已删，可清理）：{rel}")
            continue
        counts = records.get(rel, {})
        if sum(counts.values()) == 0:
            notes.append(f"基线残留（已无 fragment 门控，可清理）：{rel}")
            continue
        for kind in ("stmt", "block"):
            if int(limit.get(kind, 0)) > counts.get(kind, 0):
                notes.append(
                    f"基线可下调（迁移进行中）：{rel} {kind} "
                    f"{int(limit.get(kind, 0))} → {counts.get(kind, 0)}"
                )
    return notes


def load_baseline() -> dict:
    """台账缺失 = 空基线（DoD 终态：零容忍）；存在但不可解析 → LedgerError（护栏失效）。"""
    if not (LEDGER_DIR / f"{LEDGER_NAME}.json").is_file():
        return {}
    data = load_ledger(LEDGER_NAME, required_keys=("baseline",))
    return {str(rel): {str(k): int(v) for k, v in counts.items()} for rel, counts in data["baseline"].items()}


def check(ctx: Context) -> GuardResult:
    try:
        baseline = load_baseline()
    except LedgerError as exc:
        return GuardResult.broken(str(exc))

    scan = collect(ctx)
    findings = evaluate(scan.records, scan.details, baseline)
    present = {ctx.rel(path) for path in scan.files}
    notes = baseline_notes(scan.records, baseline, present)

    fragment_total = sum(sum(counts.values()) for counts in scan.records.values())
    baseline_total = sum(sum(counts.values()) for counts in baseline.values())
    metrics = (
        f"{len(scan.files)} 个 .rs / 测试域门控 {scan.domain_gates} 处 / fragment {fragment_total} 处"
        f"（基线 {baseline_total} 处 / {len(baseline)} 文件）"
    )
    if findings:
        return GuardResult.violated(len(scan.files), findings, metrics=metrics, notes=notes)
    return GuardResult.passed(len(scan.files), metrics=metrics, notes=notes)
