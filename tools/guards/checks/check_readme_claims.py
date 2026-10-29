"""README 的**可机器判定**事实必须与代码一致（只钉最容易抄错的 5 类）。

背景：`README.md` / `README_CN.md` 曾把版本号、快捷键表、Agent 清单手抄了一遍，缺少校验 →
内容停在两个多月前（2026-08-24），期间 828 次提交；`Ctrl+R` / `Ctrl+Alt+T` 等绑定早已不成立，
`Rust 1.70+` 与钉死的 toolchain 相差 29 个小版本。

判据刻意**窄**（与 `.trellis/spec/guides/invariant-enforcement.md` 的分层一致）：
只判「有限枚举」——版本字符串、id 集合、数组长度、路径存在。语义正确性（这段描述还成立吗）
永远靠人；把语义判断塞进 guard 只会产出误报，然后被 `# noqa` 掉，最后等于没有护栏。

C1 工具链：`Prerequisites` 里的 Node / pnpm（以及可选的 Rust）数字必须等于
   `package.json` engines / packageManager / `rust-toolchain.toml` channel。
C2 Agent 清单：`providers.rs` 的内置 agent 必须全部出现在 README，且声明的数量一致。
C3 主题数量：README 声明的内置主题数必须等于 `BUILTIN_THEMES.length`。
C4 禁止快捷键表：绑定表只能存在于 `src/shared/utils/shortcutRegistry.ts` 与
   `docs/keyboard-shortcuts.md`；README 只允许**链接**（历史教训：抄了 3 项就错 3 项）。
C5 本地图片必须存在：README 引用的相对路径图片（`docs/.img/*`）不得指向不存在的文件。

解析失效（比如 `providers.rs` 改了写法、抽取到 0 个 id）一律判 ERROR 而不是 PASS ——
否则正则悄悄不匹配时护栏会"永远绿"，这是本仓库已经踩过两次的失效模式。
"""
from __future__ import annotations

import json
import re

from guards.core.contract import Context, Finding, Guard, GuardResult

README_EN = "README.md"
README_CN = "README_CN.md"
PACKAGE_JSON = "package.json"
TOOLCHAIN = "rust-toolchain.toml"
SETTINGS = "src/shared/types/settings.ts"
PROVIDERS = "src-tauri/src/agent/builtin/providers.rs"

# 内置 CLI agent：id → README 里允许出现的展示名。
# 新加内置 agent 时这张表必须同步 —— 这是**刻意的摩擦**：加 agent 就要改 README。
CLI_AGENT_NAMES = {
    "claude-code": "Claude Code",
    "opencode": "OpenCode",
    "gemini": "Gemini",
    "codex": "Codex",
    "qoder": "Qoder",
    "codebuddy": "CodeBuddy",
    "omp": "OMP",
    "pi": "Pi",
    "reasonix": "Reasonix",
    "grok": "Grok",
}

RE_REQ_NODE = re.compile(r"^\s*[-*]\s*\[?Node(?:\.js)?\]?", re.M)
RE_REQ_PNPM = re.compile(r"^\s*[-*]\s*\[?pnpm\]?", re.M)
RE_REQ_RUST = re.compile(r"^\s*[-*]\s*\[?Rust\]?", re.M)
RE_VERSION = re.compile(r"(\d+(?:\.\d+)*)")

RE_SHELL_AGENT = re.compile(r'shell_agent\(\s*\n?\s*"([a-z0-9-]+)"')
RE_EXPLICIT_ID = re.compile(r'id:\s*"([A-Za-z0-9-]+)"\.into\(\)')
RE_BUILTIN_THEMES = re.compile(r"BUILTIN_THEMES\s*=\s*\[(.*?)\]", re.S)
RE_QUOTED = re.compile(r"'([^']+)'|\"([^\"]+)\"")

RE_TABLE_ROW = re.compile(r"^\s*\|.*$", re.M)
RE_MD_IMAGE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)")
RE_HTML_IMAGE = re.compile(r"<img[^>]+src=\"([^\"]+)\"", re.I)
RE_SHORTCUT_LINK = re.compile(r"docs/keyboard-shortcuts\.md")
# HTML 注释里的内容不参与判定：README 常把待定/停用的图注、旧表格注释掉，
# 把它们算进来会产出假违规（quality-guidelines §18(b)：对源码做字符串断言必须先剥注释）。
RE_HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)


def _strip_comments(text: str) -> str:
    return RE_HTML_COMMENT.sub("", text)

# README 里这几段是"要求"，不是"能力列表"：只在这类行上取版本号，避免把
# LSP 语言清单里的 "Rust"、功能段里的 "Node" 误判成版本声明。
GUARD = Guard(
    id="check_readme_claims",
    title="README 的版本 / Agent 清单 / 主题数 / 快捷键表 / 图片必须与代码一致",
    scopes=(
        README_EN,
        README_CN,
        PACKAGE_JSON,
        TOOLCHAIN,
        SETTINGS,
        PROVIDERS,
        "docs/.img/*",
        "docs/features.md",
    ),
    docs="docs/features.md",
    fix_hint=(
        "改 README 而不是改代码：版本数字对齐 package.json / rust-toolchain.toml；"
        "agent 清单对齐 src-tauri/src/agent/builtin/providers.rs；主题数对齐 "
        "src/shared/types/settings.ts；快捷键只链 docs/keyboard-shortcuts.md"
    ),
)


def _requirements_line(text: str, pattern: re.Pattern) -> str | None:
    """取「前置要求」里匹配到的那一行（`Node.js 24+` 这类）。"""
    match = pattern.search(text)
    if not match:
        return None
    start = text.rfind("\n", 0, match.start()) + 1
    end = text.find("\n", match.end())
    return text[start : end if end != -1 else len(text)]


def _version_in(line: str | None) -> str | None:
    if not line:
        return None
    found = RE_VERSION.search(line)
    return found.group(1) if found else None


def _major(version: str) -> str:
    return version.split(".")[0]


def _major_minor(version: str) -> str:
    parts = version.split(".")
    return ".".join(parts[:2])


def _expected_toolchain(ctx: Context) -> tuple[str, str, str]:
    try:
        pkg = json.loads(ctx.read(PACKAGE_JSON))
    except json.JSONDecodeError as exc:
        raise ValueError(f"{PACKAGE_JSON} 解析失败：{exc}") from exc

    node_range = str(pkg.get("engines", {}).get("node", ""))
    node = _version_in(node_range)
    if not node:
        raise ValueError(f"{PACKAGE_JSON} 的 engines.node 里取不到版本号：{node_range!r}")

    manager = str(pkg.get("packageManager", ""))
    pnpm = _version_in(manager.split("@")[-1]) if "@" in manager else None
    if not pnpm:
        raise ValueError(f"{PACKAGE_JSON} 的 packageManager 里取不到 pnpm 版本：{manager!r}")

    channel = re.search(r'channel\s*=\s*"([^"]+)"', ctx.read(TOOLCHAIN))
    if not channel:
        raise ValueError(f"{TOOLCHAIN} 里取不到 channel")

    # README 写的是**主版本**（`Node 24+` / `pnpm 11+`）—— 与「升级补丁号也要改文档」相比，
    # 这个粒度才是读者真正需要的。Rust 写到次版本（`1.99`），与 toolchain 的滚动节奏对齐。
    return _major(node), _major(pnpm), _major_minor(channel.group(1))


def _builtin_agent_ids(ctx: Context) -> list[str]:
    source = ctx.read(PROVIDERS)
    ids = RE_SHELL_AGENT.findall(source) + RE_EXPLICIT_ID.findall(source)
    if not ids:
        raise ValueError(
            f"{PROVIDERS} 里抽取到 0 个内置 agent —— 构造方式可能已改，本护栏的解析口径失效"
        )
    return ids


def _builtin_theme_count(ctx: Context) -> int:
    body = RE_BUILTIN_THEMES.search(ctx.read(SETTINGS))
    if not body:
        raise ValueError(f"{SETTINGS} 里找不到 BUILTIN_THEMES 数组")
    names = [a or b for a, b in RE_QUOTED.findall(body.group(1))]
    if not names:
        raise ValueError(f"{SETTINGS} 的 BUILTIN_THEMES 解析出 0 个主题")
    return len(names)


def _check_toolchain(
    ctx: Context, doc: str, node: str, pnpm: str, rust: str
) -> list[Finding]:
    text = _strip_comments(ctx.read(doc))
    findings: list[Finding] = []

    for label, pattern, expected, compare in (
        ("Node", RE_REQ_NODE, node, lambda a, b: _major(a) == b),
        ("pnpm", RE_REQ_PNPM, pnpm, lambda a, b: _major(a) == b),
        ("Rust", RE_REQ_RUST, rust, lambda a, b: _major_minor(a) == b),
    ):
        declared = _version_in(_requirements_line(text, pattern))
        if declared is None:
            if label == "Rust":
                # Rust 允许写成"版本固定在 rust-toolchain.toml"而不写数字（刻意设计）。
                continue
            findings.append(Finding(f"前置要求里缺少 {label} 版本声明", doc))
            continue
        if not compare(declared, expected):
            findings.append(
                Finding(
                    f"前置要求写 {label} {declared}，真实值 {expected}"
                    f"（{PACKAGE_JSON} / {TOOLCHAIN}）",
                    doc,
                )
            )
    return findings


def _check_agents(ctx: Context, doc: str, ids: list[str]) -> list[Finding]:
    text = _strip_comments(ctx.read(doc))
    cli_ids = [i for i in ids if i != "mockAgent"]
    findings: list[Finding] = []

    for agent_id in cli_ids:
        name = CLI_AGENT_NAMES.get(agent_id)
        if name is None:
            findings.append(
                Finding(
                    f"内置 agent {agent_id!r} 未登记展示名 —— 在 CLI_AGENT_NAMES 里补一行，"
                    "同时把它写进 README",
                    PROVIDERS,
                )
            )
        elif name not in text:
            findings.append(Finding(f"缺少内置 agent {name!r} 的说明", doc))

    for name in CLI_AGENT_NAMES.values():
        if name in text and name not in [
            CLI_AGENT_NAMES[i] for i in cli_ids if i in CLI_AGENT_NAMES
        ]:
            findings.append(Finding(f"README 声明了不存在的内置 agent {name!r}", doc))

    declared = re.search(r"(\d+)\s*(?:built-in CLI agents|个内置 CLI Agent)", text)
    if not declared:
        findings.append(
            Finding("Features 里应写出内置 CLI Agent 数量（如 “10 built-in CLI agents”）", doc)
        )
    elif int(declared.group(1)) != len(cli_ids):
        findings.append(
            Finding(f"声明的内置 CLI Agent 数是 {declared.group(1)}，真实值 {len(cli_ids)}", doc)
        )

    if "mockAgent" in ids and "MockAgent" not in text:
        findings.append(Finding("缺少 MockAgent 说明（无 CLI 也能试 Agent Chat）", doc))
    return findings


def _check_themes(ctx: Context, doc: str, expected: int) -> list[Finding]:
    declared = re.search(r"(\d+)\s*(?:built-in themes|个内置主题)", _strip_comments(ctx.read(doc)))
    if not declared:
        return [Finding("Reference 里应写出内置主题数量（如 “5 built-in themes”）", doc)]
    if int(declared.group(1)) != expected:
        return [
            Finding(f"声明的内置主题数是 {declared.group(1)}，真实值 {expected}（{SETTINGS}）", doc)
        ]
    return []


def _check_no_shortcut_table(ctx: Context, doc: str) -> list[Finding]:
    text = _strip_comments(ctx.read(doc))
    findings: list[Finding] = []
    for line in RE_TABLE_ROW.findall(text):
        if "Ctrl+" in line or "⌘" in line:
            findings.append(
                Finding(
                    "README 不得内联快捷键表 —— 绑定表的唯一事实源是 shortcutRegistry，"
                    "抄一份必然漂移（历史 7 条错 3 条）",
                    doc,
                )
            )
            break
    if not RE_SHORTCUT_LINK.search(text):
        findings.append(Finding("应给出 docs/keyboard-shortcuts.md 的链接", doc))
    return findings


def _check_images(ctx: Context, doc: str) -> list[Finding]:
    text = _strip_comments(ctx.read(doc))
    refs = RE_MD_IMAGE.findall(text) + RE_HTML_IMAGE.findall(text)
    findings: list[Finding] = []
    for ref in refs:
        clean = ref.split("#", 1)[0].split("?", 1)[0]
        if not clean or clean.startswith(("http://", "https://", "data:", "mailto:")):
            continue
        if not ctx.path(clean).is_file():
            findings.append(Finding(f"引用了不存在的图片：{clean}", doc))
    return findings


def check(ctx: Context) -> GuardResult:
    for required in (README_EN, README_CN, PACKAGE_JSON, TOOLCHAIN, SETTINGS, PROVIDERS):
        if not ctx.path(required).is_file():
            return GuardResult.broken(f"缺少护栏判据所需的文件：{required}")

    try:
        node, pnpm, rust = _expected_toolchain(ctx)
        ids = _builtin_agent_ids(ctx)
        themes = _builtin_theme_count(ctx)
    except (ValueError, OSError) as exc:
        return GuardResult.broken(str(exc))

    findings: list[Finding] = []
    for doc in (README_EN, README_CN):
        findings += _check_toolchain(ctx, doc, node, pnpm, rust)
        findings += _check_agents(ctx, doc, ids)
        findings += _check_themes(ctx, doc, themes)
        findings += _check_no_shortcut_table(ctx, doc)
        findings += _check_images(ctx, doc)

    metrics = (
        f"node={node} pnpm={pnpm} rust={rust} · agents={len(ids)} · themes={themes} · "
        f"2 README"
    )
    notes = (
        f"内置 agent：{', '.join(ids)}",
        f"内置主题数：{themes}",
        f"仅比对本护栏覆盖的 5 类事实；功能语义仍需人工评审",
    )
    if findings:
        return GuardResult.violated(2, findings, metrics=metrics, notes=notes)
    return GuardResult.passed(2, metrics=metrics, notes=notes)
