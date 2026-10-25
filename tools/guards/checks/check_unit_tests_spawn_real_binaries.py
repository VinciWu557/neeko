"""禁止单元测试 spawn 本机真实 agent 二进制。

## 第一性原理

单元测试的判据是「走不走这条代码路径」，不是「本机装没装那个程序」。把真实 CLI 拉起来
不会让断言更有力，却必然付出三个代价：

1. **孤儿进程**：测试二进制退出走 `std::process::exit`，**不跑 Drop**（实测确认），
   退出收敛机制（`child_registry` / `kill_all_live`）也只在应用的
   `shutdown_background_and_exit` 里被驱动 —— 测试根本不经过它。于是长驻子进程
   （`opencode serve` 是进程级 `OnceCell` 单例）整棵孤儿化。
2. **判据失效**：以 `ServeAdapter` 那条为例，真实断言只是
   `!matches!(e, AppError::Unsupported(_))`。装坏 / 起不来 / 401 全都「通过」，
   真跑进程对这条断言**零增益**。
3. **环境依赖 + 墙钟**：本机有 vs CI 没有是两条不同路径；再有 `STARTUP_TIMEOUT`
   与命令发现重试，单元测试被拖成进程/网络依赖。

## 事故

2026-10-25：`capability_probe::commands_bit_implies_list_commands_is_not_unsupported`
用 `ServeAdapter::new(vec!["opencode", "serve"])` 真起了 `opencode serve`。实测每跑一轮
`cargo test` 残留一个，累积到 7 个。修法：换成不存在的二进制名（判据是「覆写是否存在」，
不是「本机能不能列命令」），真实往返交给带 `#[ignore]` 的集成用例。

## 判据范围（刻意的窄）

只查**无 `#[ignore]`** 的测试函数里，把已知 agent CLI 名当**程序名**传进 spawn 的地方：

- `ServeAdapter::new(vec!["<bin>", ...])` / `PiRpcAdapter::new(vec!["<bin>", ...])`
- `exec::spawn(..., "<bin>", ...)` / `SpawnOptions::new("<bin>", ...)`
- `Command::new("<bin>")`（直接构造，绕过 facade 更不该有）

**不查**下面这些，它们不是本护栏的对象：
- 带 `#[ignore]` 的集成用例（那是它们存在的意义，跑法 `cargo test -- --ignored`）；
- `command_exists("<bin>")` —— 只探测 PATH，不 spawn 被探测的程序；
- 参数位上的名字（如 `--provider opencode`），只匹配**程序名位置**；
- `git` / `sh` / `bash` 等测试基础设施（它们已有既定的确定性约定，见
  `backend-testing.md`）。
"""
from __future__ import annotations

import re

from guards.core.contract import Context, Finding, Guard, GuardResult

SCOPES = ("src-tauri/src/**/*.rs", "src-tauri/tests/**/*.rs")

# 已知 agent CLI 的程序名。加新 agent 时在这里补一行即可。
AGENT_BINARIES = ("opencode", "pi", "omp", "claude", "gemini", "codex", "qoder", "codebuddy")

# 「程序名位置」的几种写法。`vec![...]` 指 adapter 构造，其余是直接 spawn。
#
# adapter 构造**本身不 spawn**（`ServeAdapter::new` 是 `const fn`，只存 cmd）——
# 真正拉起进程的是 `list_commands` / `list_models` / `create` / `resume`。
# 所以构造只是「候选」，还要同一函数里出现触发调用才算违规（见 check()）。
_ADAPTER_CTOR_RES = re.compile(
    r"(?:ServeAdapter|PiRpcAdapter|AcpAdapter)::new\s*\(\s*vec!\s*\[\s*\"([^\"]+)\""
)

# 直接 spawn：这里程序名就是真被执行的程序，无需再看别处。
_DIRECT_SPAWN_RES = (
    # exec::spawn(&target, "opencode", ..)
    re.compile(r"exec::spawn\s*\([^,]+,\s*\"([^\"]+)\""),
    # SpawnOptions::new("opencode", ..)
    re.compile(r"SpawnOptions::new\s*\(\s*\"([^\"]+)\""),
    # Command::new("opencode")
    re.compile(r"Command::new\s*\(\s*\"([^\"]+)\""),
)

# 会真正拉起 adapter 子进程的方法。
_SPAWN_TRIGGER_RE = re.compile(r"\.(?:list_commands|list_models|create|resume)\s*\(")

# 常量绑定：`const FOO: &str = "opencode";`（`#[ignore]` 用例里也这么写，
# 事故修复就用了 `NO_SUCH_BINARY`。不追这个绑定，护栏会被一个字面量搬到常量里绕过）。
_CONST_BIND_RE = re.compile(r"\b(?:const|let)\s+(\w+)\s*(?::\s*&str\s*)?=\s*\"([^\"]+)\"")

# 程序名位置的「变量位」：vec!["VAR".into()] / SpawnOptions::new(VAR, ..)
_VAR_IN_PROGRAM_POS_RES = (
    re.compile(r"(?:ServeAdapter|PiRpcAdapter|AcpAdapter)::new\s*\(\s*vec!\s*\[\s*([A-Za-z_]\w*)"),
    re.compile(r"exec::spawn\s*\([^,]+,\s*([A-Za-z_]\w*)"),
    re.compile(r"SpawnOptions::new\s*\(\s*([A-Za-z_]\w*)"),
    re.compile(r"Command::new\s*\(\s*([A-Za-z_]\w*)"),
)

IGNORE_RE = re.compile(r"#\[\s*ignore\b")


def fn_spans(text: str) -> list:
    """每个 `fn` 的 (name, fn_keyword_offset, body_start, body_end)。

    花括号配对，跳过字符串字面量。`fn_keyword_offset` 用于往回找属性块。
    """
    spans = []
    for m in re.finditer(r"\bfn\s+(\w+)", text):
        open_brace = text.find("{", m.end())
        if open_brace < 0:
            continue
        depth = 0
        i = open_brace
        while i < len(text):
            ch = text[i]
            if ch == '"':
                i += 1
                while i < len(text) and text[i] != '"':
                    i += 2 if text[i] == "\\" else 1
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    spans.append((m.group(1), m.start(), open_brace, i))
                    break
            i += 1
    return spans


def is_ignored_test(text: str, fn_name_offset: int) -> bool:
    """该函数是否**真的**标了 `#[ignore]`。

    只看函数签名上方的属性行（以 `#[` 开头、非注释行）。

    # 为什么不能直接子串搜 `#[ignore]`

    文档注释里会**提到**它（「对真实 adapter 标 `#[ignore]`」、
    「真实往返由两条 `#[ignore]` 用例覆盖」）—— 用子串判就会把那些函数误判成
    已豁免，变异验证时实测把违规数从 1 变成 0（漏报）。
    """
    # 从 `fn` 关键字的**行首**之前开始，避免把签名前缀（`pub async unsafe extern`）
    # 当成「非属性行」而提前 break。
    line_start = text.rfind("\n", 0, fn_name_offset) + 1
    head = text[:line_start]
    lines = head.splitlines()
    # 从最近一行往上遍历整个属性块；遇到既非属性、非空、非注释的行才停。
    # 属性间顺序任意（`#[tokio::test]` 与 `#[ignore]` 谁在前都合法）。
    for raw in reversed(lines):
        stripped = raw.strip()
        if not stripped:
            continue
        if IGNORE_RE.search(stripped) and stripped.startswith("#["):
            return True
        if stripped.startswith("#["):
            continue
        if stripped.startswith("//") or stripped.startswith("/*") or stripped.startswith("*"):
            # 注释不是属性来源，但也不终止属性块（doc 注释常见于属性之间）
            continue
        break
    return False


def scan_file(ctx: Context, path) -> tuple:
    text = ctx.read(ctx.rel(path))
    lines = text.splitlines()
    spans = fn_spans(text)

    hits: list[Finding] = []
    exempted: list[Finding] = []

    # 文件级常量绑定：`const NO_SUCH_BINARY: &str = "opencode";`
    # 事故修复就是这么写的 —— 不追绑定就会变成「把字面量搬进常量就绕过」。
    const_bindings = {m.group(1): m.group(2) for m in _CONST_BIND_RE.finditer(text)}

    for name, fn_kw, start, end in spans:
        body = text[start:end]
        ignored = is_ignored_test(text, fn_kw)
        triggered = bool(_SPAWN_TRIGGER_RE.search(body))

        candidates: list[tuple] = []  # (program, offset_in_body)
        for pattern in _DIRECT_SPAWN_RES:
            for m in pattern.finditer(body):
                candidates.append((m.group(1), m.start()))
        if triggered:
            for m in _ADAPTER_CTOR_RES.finditer(body):
                candidates.append((m.group(1), m.start()))
        # 变量位 → 查常量绑定
        for pattern in _VAR_IN_PROGRAM_POS_RES:
            for m in pattern.finditer(body):
                bound = const_bindings.get(m.group(1))
                if bound:
                    candidates.append((bound, m.start()))

        for program, offset_in_body in candidates:
            if program not in AGENT_BINARIES:
                continue
            offset = start + offset_in_body
            line_no = text.count("\n", 0, offset) + 1
            finding = Finding(
                f"{name}(): 以 \"{program}\" 为程序名 spawn 真实二进制"
                + ("（已标 #[ignore]，合规）" if ignored else ""),
                ctx.rel(path),
                line_no,
            )
            (exempted if ignored else hits).append(finding)
    return hits, exempted, len(lines)


def check(ctx: Context) -> GuardResult:
    files = sorted({p for scope in SCOPES for p in ctx.glob(scope)})
    if not files:
        return GuardResult.broken("扫描集为空 —— 本护栏的 glob 口径已失效", scanned=0)

    findings: list[Finding] = []
    exempted: list[Finding] = []
    for path in files:
        hits, exempt, _ = scan_file(ctx, path)
        findings.extend(hits)
        exempted.extend(exempt)

    metrics = f"{len(files)} 个 .rs / 违规 {len(findings)} / 豁免(#[ignore]) {len(exempted)}"
    notes = tuple(f"  [豁免] {f.as_text()}" for f in exempted)
    if findings:
        return GuardResult.violated(len(files), findings, metrics=metrics, notes=notes)
    return GuardResult.passed(len(files), metrics=metrics)


GUARD = Guard(
    id="check_unit_tests_spawn_real_binaries",
    title="单元测试不得 spawn 本机真实 agent 二进制（会留下孤儿进程 + 判据失效）",
    scopes=SCOPES,
    docs=".trellis/spec/unit-test/backend-testing.md",
    fix_hint=(
        "判据改成「走不走默认实现」——用不存在的二进制名（如 "
        '"definitely-not-a-real-binary"）；真实往返放进带 #[ignore] 的集成用例，'
        "跑法 `cargo test -- --ignored`"
    ),
)
