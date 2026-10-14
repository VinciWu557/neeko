"""「该往哪个 tab 插」只允许一处实现（台账：ledger/terminal_foreground_arbitration.json）。

## 第一性原理（为什么需要它）

同一个问题 ——「这个 workspace 空间里的插入目标终端是哪个」—— 在 10-12 之后仍有 **7 个
答案**：order 升序（`foregroundTerminalTab`）、order 降序（`findAgentCliTab`，注释称刻意）、
数组顺序（`findAgentTab` / `getActiveTab` / `ensureDefaultTab`）、**Map 插入顺序**
（`firstTerminalKeyOfSession`）。后果不是风格问题：同一时刻「插入落到哪个 tab」按 order 升序，
「刷新 / 切 agent 落到哪个 PTY」按 Map 插入顺序 —— **两个口径两个答案**。prompts 插入恒落
首个 tab 的原始事故正是这种漂移的一次实例（10-12 R2 已把这条写成纪律，但只归一两处）。

本护栏把「顺序口径只实现一次」从纪律变成可执行判据（决议 Q2 / R1）。

## 判据（四条，均确定性可复现）

**注释行一律不计入**：判据自身在注释里的引用（解释「为什么只有一处」）不是命中，
否则「把理由写进代码」这件事本身会被罚 —— 那是让文档退回口头约定。

- **A1（口径唯一，台账式）**：`src/features/{terminal,browser,status-bar}/**` 内不得出现
  ①`a.order - b.order` / `b.order - a.order`（自带一套 tab 顺序）
  ②`tabs[0]` / `terminalTabs[0]` / `agentTabs[0]` / `terminals[0]` / `candidates[0]` /
    `chatTabs[0]`（绕过仲裁直接取首个）。
  命中必须逐文件登记在台账，且 `kind == "owner"` 的恰为 `terminalRouting.ts` 一处。
  **基线实测**（写判据前重新量的；design §3 首轮记的「4 处合法命中」在实现后已过期）：
  `terminalRouting.ts`（owner）+ `StatusBarCluster.tsx` / `status-bar/registry.ts`
  （legit —— 状态栏 item 展示序与注册序，**同形但不同域**）。
  ⇒ 这就是必须台账式而非纯正则的原因：同一段字符串在不同域有完全不同的语义。
- **A2（第二口径退出）**：`firstTerminalKeyOfSession(` / `firstTerminalEntryOfSession(`
  在 `src` 内零命中。这两个符号随本任务**整体删除**（不是降为私有：消费者为零时留着
  就是下一个手搓的诱惑，按 10-12 R5 纪律删）。判据防的是**新造同类**。
- **A3（tabId 必填不回退）**：`src/features/terminal/**` 内 `tabId` 不允许是可选或可空参数
  （`tabId?:` / `tabId: string | null`）。
  **这条是 TS 给不了的那一条**：把已必填的 `tabId: string` 改回 `tabId?: string` 对现有调用方
  **完全合法**（它们本来就全传），编译期一声不响，而「缺省取 Map 首个」那条第二口径就此复活。
  作用域刻意限定 terminal 域：别域的 `tabId?:` / `tabId: string | null`
  （`app/utils/layoutId.ts`、`editorStore`、`useFileViewTabOps.saveFile`）是另一套合法含义。
- **A4（声明必须有消费点 —— 本次事故的根因形态）**：`shared/events.ts` 导出的每个
  `neeko:*` **DOM** 事件常量，必须在 `src` 内至少有一次 `addEventListener(` 命中；零监听者即违规。
  这是红线 14 的原文判据（「声明了却没人实现 = 静默功能缺失」）从 LSP capability 扩到 DOM 事件，
  **不新增红线**，只在护栏里落实既有红线。
  当前基线：`neeko:*` 常量数 = **0** —— `INSERT_TO_AGENT_INPUT_EVENT` 已按决议 Q5=A 删除，
  它是历史上唯一一个，且监听者**从未存在过**
  （`git log --all -S"addEventListener(INSERT_TO_AGENT_INPUT_EVENT"` → 0 条）。
  所以本判据现在零命中、将来拦的是「再声明一个没人听的 DOM 事件名」这一整类。
  **边界（如实声明，不过度声称）**：只管 `neeko:*`（纯前端 DOM 事件）。后端 Tauri 事件名
  （`browser://` / `file-changed` / `dap-event` …）的消费点在 Rust 侧 emit，不在射程内 ——
  实测 `BROWSER_LOADING_EVENT` 前端零引用但后端确实在发（`webview_ops.rs:73,80`），
  那是「后端发、前端还没接」的另一类问题，不由本判据误报。

> **取证纪律（本轮实测教训，写给下一个改这条护栏的人）**：形态/材质类判据必须**逐形态**量
> （标识符 / 转义 / 不同引号 / 代码行 vs 注释行），不能只测一种就写「基线为 N」。
> design §3 首轮的「4 处合法命中」正是只量了代码、没量注释 —— 照那版实现会得到一条
> **自指误报**（护栏拦下了自己文档里对判据的引用）。
"""
from __future__ import annotations

import re

from guards.core.contract import Context, Finding, Guard, GuardResult
from guards.core.ledger import load_ledger

LEDGER_NAME = "terminal_foreground_arbitration"
EVENTS_FILE = "src/shared/events.ts"
OWNER = "src/features/terminal/components/terminalRouting.ts"

A1_SCOPES = tuple(
    f"src/features/{domain}/**/*{ext}"
    for domain in ("terminal", "browser", "status-bar")
    for ext in (".ts", ".tsx")
)
SRC_SCOPES = ("src/**/*.ts", "src/**/*.tsx")
TERMINAL_SCOPES = ("src/features/terminal/**/*.ts", "src/features/terminal/**/*.tsx")

# A1 —— 两个「自带一套首个」的仲裁形态
PATTERNS: dict = {
    "order_sort": re.compile(r"a\.order - b\.order|b\.order - a\.order"),
    "collection_first": re.compile(
        r"\b(?:tabs|terminalTabs|agentTabs|terminals|candidates|chatTabs)\[0\]"
    ),
}
# A2 —— 已删除的第二口径符号（带调用括号，减少变量名误伤）
RETIRED_FALLBACK_RE = re.compile(
    r"\b(?:firstTerminalKeyOfSession|firstTerminalEntryOfSession)\s*\("
)
# A3 —— tabId 的可选性 / 可空性回退
OPTIONAL_TAB_ID_RE = re.compile(r"\btabId\?:|\btabId:\s*string\s*\|\s*null")
# A4 —— DOM 事件常量（值以 neeko: 开头 = 纯前端 CustomEvent 名，非后端 Tauri 通道）
DOM_EVENT_CONST_RE = re.compile(
    r"^export const ([A-Z_0-9]+)\s*=\s*['\"](neeko:[^'\"]*)['\"]", re.MULTILINE
)
ADD_LISTENER_RE = re.compile(r"addEventListener\(\s*([A-Za-z_][\w.]*|['\"][^'\"]*['\"])")

# 注释行不计入判据（见模块 docstring）
COMMENT_LINE_RE = re.compile(r"^\s*(?:\*|//|/\*)")

GUARD = Guard(
    id="check_terminal_foreground_arbitration",
    title="终端前台仲裁口径唯一 + 声明的 DOM 事件必须有消费点",
    scopes=A1_SCOPES + SRC_SCOPES + (EVENTS_FILE, f"tools/guards/ledger/{LEDGER_NAME}.json"),
    red_lines=(5, 12),
    docs="docs/domain-model.md",
    ledger=LEDGER_NAME,
    fix_hint=(
        "「该往哪个 tab」一律走 `terminalRouting.foregroundTerminalTab` / "
        "`foregroundAgentCliTab`（order 升序，决议 Q2）；要某一类 tab 就**在它给出的有序序列上 "
        "filter**，不自带 sort、不取 [0]、不把 tabId 改回可选。"
        "新增 neeko:* DOM 事件名必须同批改出 addEventListener 消费点，否则删掉它"
    ),
)


def _code_lines(text: str):
    """(行号, 内容) —— 只给非注释行。保留真实行号，CI 才能把违规钉回 diff 行。"""
    return [(n, ln) for n, ln in enumerate(text.splitlines(), start=1) if not COMMENT_LINE_RE.match(ln)]


def _files(ctx: Context, scopes) -> list:
    """按 glob 取文件（去重 + 稳定排序），并排除测试文件。

    测试豁免按**真实相对路径**判（不能拿 glob 模式串去判 `__tests__`，那恒为假）：
    测试里出现已退役符号会在 tsc 阶段暴露，且测试常需要把旧形态写进注释解释成因，
    把它们算进基线只会逼测试绕开注释、把理由从代码里删掉。
    """
    out = []
    for scope in scopes:
        for path in ctx.glob(scope):
            if "__tests__" in ctx.rel(path).split("/"):
                continue
            out.append(path)
    return sorted(set(out))


def _scan_a1(ctx: Context) -> tuple[int, dict]:
    """A1：逐文件的两个仲裁形态计数（剔注释）。返回 (扫描文件数, {路径: {口径: 次数}})。"""
    files = _files(ctx, A1_SCOPES)
    hits: dict[str, dict[str, int]] = {}
    for path in files:
        rel = ctx.rel(path)
        lines = _code_lines(ctx.read(rel))
        per = {name: sum(len(rx.findall(ln)) for _, ln in lines) for name, rx in PATTERNS.items()}
        per = {name: n for name, n in per.items() if n}
        if per:
            hits[rel] = per
    return len(files), hits


def check(ctx: Context) -> GuardResult:
    ledger = load_ledger(LEDGER_NAME, required_keys=("owner", "valid_kinds", "manifest"))
    manifest, valid_kinds = ledger["manifest"], set(ledger["valid_kinds"])

    a1_count, hits = _scan_a1(ctx)
    if a1_count == 0:
        return GuardResult.broken(
            f"在 {' / '.join(A1_SCOPES)} 下扫到 0 个文件 —— 判据口径失效", scanned=0
        )

    findings: list[Finding] = []

    # ---- A1：台账比对（未登记命中 / 登记失效 / 计数漂移 / 分类非法 / owner 漂移）----
    for path in sorted(set(hits) - set(manifest)):
        detail = "、".join(f"{k}×{v}" for k, v in sorted(hits[path].items()))
        findings.append(Finding(f"A1 未登记命中（第二套顺序口径）: {detail}", path))
    for path in sorted(set(manifest) - set(hits)):
        findings.append(Finding("A1 登记失效: 已无命中，请从台账删除", path))
    for path in sorted(set(manifest) & set(hits)):
        expected = manifest[path]["counts"]
        if expected != hits[path]:
            fmt = lambda d: "、".join(f"{k}×{v}" for k, v in sorted(d.items()))
            findings.append(
                Finding(f"A1 计数漂移: 登记 {fmt(expected)}，实测 {fmt(hits[path])}", path)
            )
    for path, entry in sorted(manifest.items()):
        if entry["kind"] not in valid_kinds:
            findings.append(
                Finding(
                    f"A1 分类非法: {entry['kind']!r}（只允许 {' / '.join(sorted(valid_kinds))}）",
                    f"tools/guards/ledger/{LEDGER_NAME}.json",
                )
            )
    owners = [p for p, e in manifest.items() if e["kind"] == "owner"]
    if owners != [OWNER]:
        findings.append(
            Finding(
                f"A1 owner 必须恰为 {OWNER}，实测 {owners} —— 「取首个」的实现处必须唯一",
                f"tools/guards/ledger/{LEDGER_NAME}.json",
            )
        )

    # ---- A2：第二口径符号回潮（扫全 src；测试文件豁免 —— 注释里解释成因不算命中）----
    src_files = _files(ctx, SRC_SCOPES)
    for path in src_files:
        rel = ctx.rel(path)
        text = ctx.read(rel)
        for line_no, line in _code_lines(text):
            m = RETIRED_FALLBACK_RE.search(line)
            if m:
                findings.append(
                    Finding(
                        f"A2 已删除的第二口径回潮：{m.group(0).rstrip('( ')!r} —— "
                        "「该往哪个 tab」只允许 `terminalRouting.foregroundTerminalTab`（决议 R1/Q2）",
                        rel,
                        line_no,
                    )
                )

    # ---- A3：terminal 域内 tabId 不得回到可选 / 可空 ----
    terminal_files = _files(ctx, TERMINAL_SCOPES)
    for path in terminal_files:
        rel = ctx.rel(path)
        text = ctx.read(rel)
        for line_no, line in _code_lines(text):
            m = OPTIONAL_TAB_ID_RE.search(line)
            if m:
                findings.append(
                    Finding(
                        f"A3 tabId 可选性回退：{m.group(0)!r} —— 改回可选对现有调用方在 TS 上"
                        "完全合法、编译期无声，却会让「缺省取 Map 首个」这条第二口径复活（决议 R3）",
                        rel,
                        line_no,
                    )
                )

    # ---- A4：声明的 neeko:* DOM 事件必须有监听者 ----
    dom_consts = dict(DOM_EVENT_CONST_RE.findall(ctx.read(EVENTS_FILE)))
    declared = set(dom_consts) | set(dom_consts.values())
    listened: set[str] = set()
    if declared:
        for path in src_files:
            rel = ctx.rel(path)
            for _, line in _code_lines(ctx.read_tolerant(rel)):
                for m in ADD_LISTENER_RE.finditer(line):
                    tok = m.group(1).strip("'\"")
                    if tok in declared:
                        listened.add(tok)
    for name, literal in sorted(dom_consts.items()):
        if name not in listened and literal not in listened:
            findings.append(
                Finding(
                    f"A4 声明了却没人监听：{name}（{literal!r}）在 src 内零 addEventListener —— "
                    "派发方拿不到「有没有人接住」，只会静默 no-op"
                    "（红线 14 同型；决议 Q5=A 的成因 —— 该常量的监听者历史上从未存在过）",
                    EVENTS_FILE,
                )
            )

    total = sum(sum(v.values()) for v in hits.values())
    scanned = a1_count + len(src_files) + len(terminal_files) + 1
    metrics = (
        f"A1 {a1_count} 文件 / 命中 {len(hits)} 处 {total} · "
        f"A2 零命中（{len(src_files)} 文件）· "
        f"A3 零命中（{len(terminal_files)} 文件）· "
        f"A4 neeko:* 常量 {len(dom_consts)} / 有监听 {len([n for n in dom_consts if n in listened or dom_consts[n] in listened])}"
    )
    notes = _notes(a1_count, hits, manifest, dom_consts, listened)
    if findings:
        return GuardResult.violated(scanned, findings, metrics=metrics, notes=notes)
    return GuardResult.passed(scanned, metrics=metrics, notes=notes)


def _notes(a1_count, hits, manifest, dom_consts, listened) -> tuple:
    lines = [f"前台仲裁台账（扫描 {a1_count} 文件，命中 {len(hits)}）"]
    for path in sorted(hits):
        kind = manifest.get(path, {}).get("kind", "未登记")
        lines.append(f"  [{kind:<6}] {path}  {hits[path]}")
    for path, entry in sorted(manifest.items()):
        if entry["kind"] == "debt":
            lines.append(f"  [debt] {path}: {entry['note']}")
    lines.append("  A2 已删除的第二口径：firstTerminalKeyOfSession / firstTerminalEntryOfSession")
    lines.append("  A3 tabId 必填（terminal 域；别域的 tabId?: 是另一套合法含义，不在射程）")
    lines.append(
        f"  A4 neeko:* DOM 事件常量 {len(dom_consts)} 个，"
        f"有监听者 {len([n for n in dom_consts if n in listened or dom_consts[n] in listened])} 个"
        "（后端 Tauri 事件名不在射程，见 docstring 边界声明）"
    )
    lines.append(f"  台账：ledger/{LEDGER_NAME}.json")
    return tuple(lines)
