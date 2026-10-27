"""UI 样式 token 护栏：禁止在 `src/` 下新增**样式层**的反模式。

背景：2026-07-26 的 UI 设计审计结论（`design.md` §3）在三个月里**0 落地** ——
不是没时间，是没有护栏。实测那三个月代码量 +68%（235→396 个 tsx），而：

| 反模式 | 7 月基线 | 三个月后 |
| --- | --- | --- |
| 硬编码 hex 色（`text-[#3fb950]`） | 多 | 9 |
| 暗色假设（`border-white/[0.04]`） | ~33 | 39 |
| accent 底上的写死白字（`text-white`） | 多 | 32 |

比率持平 = **每个新 PR 都在复制旧问题**。先做清理、新代码继续灌入，
就是这三个月发生的事。故本护栏的作用是「让清理不白做」。

## 四条判据（全部只拦**新增**，不判存量）

本轮（2026-10-27）已把存量清零，所以不需要 ratchet 基线台账 ——
任何一条命中都是**新引入**的，直接报。

| # | 判据 | 为什么它是 Bug 而非风格 |
| --- | --- | --- |
| 1 | 硬编码 hex 色（`text-[#hex]` / `bg-[#hex]` / `border-[#hex]`） | 主题切换后不跟着变 —— Light / Claude 下与整体不搭 |
| 2 | 暗色假设（`border-white/N` / `bg-white/N`） | 假设底色是暗的；亮色主题下分割线**直接消失** |
| 3 | accent 底上的写死白字（`text-white`） | 主题有 `--text-on-accent` 专门处理「accent 底上该用什么字色」 |
| 4 | `focus:outline-none` 所在文件无任何 `focus-visible:` | 键盘用户**看不到焦点在哪**（P0-6） |

## 三条豁免

1. **CSS 文件内**：判据 1/2/3 只作用于 TSX —— `theme.css` 里写 hex 是**定义源**，
   不是逃逸。
2. **注释与字符串**：判据读的是源码文本，需剥注释与引号内容，
   否则「注释里提到 `border-white/[0.04]`」会误报（本仓库的 token 文件里就有这种说明文字）。
3. **判据 4 只看文件级**：一个文件里既有合规的 focus-visible、又有不合规的元素，
   本护栏不逐元素判定 —— 那是 `eslint` 规则的职责（它能逐 JSX 元素判断）。
   本护栏只兜住「整个文件都没有 focus-visible」这种粗疏情况。

## 为什么不做 ratchet

存量已清零（见 `prd.md` AC1）。若日后重新出现存量，应该先清零再放宽阈值，
而不是把基线做大 —— 基线做大的那一刻，护栏就退化成「记录现状」而不是「阻止回潮」。
"""
from __future__ import annotations

import re

from guards.core.contract import Context, Finding, Guard, GuardResult

SCOPES = ("src/**/*.tsx",)

# ── 判据 1：任意「绕过 token 的色值」─────────────────────────────────
#
# 第一性原理：要禁止的不是「hex 这个写法」，而是**任何写死的颜色**——
# 它不会跟随主题切换。按**色值表示法**枚举，而不是按 hex 一种：
#
#   text-[#3fb950]                 ← hex
#   bg-[rgba(97,175,239,0.15)]     ← rgba   （2026-10-27 实测漏网 6 处）
#   border-[rgb(1,2,3)]            ← rgb
#   text-[hsl(210,50%,40%)]        ← hsl
#   bg-[oklch(0.7_0.1_250)]        ← oklch
#
# 漏掉后四种的代价是实测过的：`RemoteDialog` / `WSLDialog` 里 6 处
# `rgba(97,175,239,...)`（One Dark 的蓝）在 claude / light / classic-dark
# 主题下全是错的颜色，而护栏报「0 处违规」——**真的 0 命中，也是真的漏网**。
#
# 只认「任意值语法 `[...]` 内的颜色函数或 hex」：`bg-accent-blue/15` 这类
# token + 透明度写法不受影响（它没有方括号）。
#
# **排除 `var()`**：`accent-[var(--accent-blue,#4a9eff)]` 是「token 带兜底值」，
# 主路径走 token、兜底只在不支持时生效 —— 这是正确写法，不是逃逸。
# 判据用 `(?![^\]]*var\()` 在方括号内做负向断言（不能只看行首，
# 因为 var() 出现在括号内）。
RE_COLOR_LITERAL = re.compile(
    r"(?:text|bg|border|ring|fill|stroke|from|to|via|shadow|outline|decoration|"
    r"divide|placeholder|caret|accent)-"
    r"\[(?![^\]]*var\()[^\]]*"
    r"(?:#[0-9a-fA-F]{3,8}|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\s*\()[^\]]*\]"
)

# ── 判据 2：暗色假设 ───────────────────────────────────────────────────
# 注意：必须覆盖**裸** `bg-white`（无斜杠与数值）—— 护栏上线后的第一次真实运行
# 就是靠这一条抓出 `src/ui/Switch.tsx` 的滑块（手写 grep `bg-white/` 会漏掉它）。
RE_DARK_ASSUMPTION = re.compile(
    r"(?:border|bg|hover:bg|active:bg|from|to|via)-white(?:/[\d.]+)?(?![-\w])"
)

# ── 判据 3：accent 底上的写死白字 ─────────────────────────────────────
RE_HARDCODED_WHITE = re.compile(r"(?<!-)\btext-white\b")

# ── 判据 4：focus:outline-none 且整文件无 focus-visible ────────────────
RE_FOCUS_NONE = re.compile(r"focus:outline-none")
RE_FOCUS_VISIBLE = re.compile(r"focus-visible:")

# 注释：判据只应作用于**真实的 class 属性值**
RE_COMMENT_BLOCK = re.compile(r"/\*.*?\*/", re.DOTALL)
RE_COMMENT_LINE = re.compile(r"//[^\n]*")


def strip_noise(source: str) -> str:
    """剥掉注释 —— 保留字符串字面量。

    为什么**只**剥注释：TSX 里的 class 属性值**就是字符串**
    （`className="text-[#3fb950]"`），剥掉字符串等于把判据的对象全删了 ——
    护栏会恒绿而看起来在工作（最坏的一类失效）。

    为什么必须剥注释：token 文件的注释里会写「业务层过去写死 `border-white/[0.04]`」
    这类说明文字；不剥就会把**说明**当成**违规**。

    代价：字符串里若出现 `//` （如 URL `https://`）会被当成行注释误删后续内容。
    ���接受 —— 误删只可能**少报**（漏报），不会误报，而少报只影响个别含 URL 的行。
    """
    source = RE_COMMENT_BLOCK.sub(" ", source)
    source = RE_COMMENT_LINE.sub(" ", source)
    return source


GUARD = Guard(
    id="check_ui_style_tokens",
    title="UI 样式层禁止硬编码色 / 暗色假设 / 写死白字 / 无焦点环",
    scopes=SCOPES,
    red_lines=(),
    docs=".trellis/spec/frontend/quality-guidelines.md",
    fix_hint=(
        "硬编码色 → 语义 token（--git-status-* / --diff-* / --accent-red 等）；"
        "暗色假设 → border-border-subtle / bg-bg-hover；"
        "accent 底上的白字 → text-text-on-accent（浅色底用 text-accent-foreground）；"
        "焦点环 → focus-visible:ring-2 focus-visible:ring-accent-blue"
    ),
)


def check(ctx: Context) -> GuardResult:
    findings: list[Finding] = []
    files = ctx.glob(SCOPES[0])

    for path in files:
        rel = ctx.rel(path)
        raw = ctx.read_tolerant(rel)
        code = strip_noise(raw)
        lines = code.splitlines()
        raw_lines = raw.splitlines()

        for idx, line in enumerate(lines, start=1):
            for match in RE_COLOR_LITERAL.finditer(line):
                findings.append(
                    Finding(f"硬编码色值（应走语义 token）: {match.group(0)}", rel, idx)
                )
            for match in RE_DARK_ASSUMPTION.finditer(line):
                findings.append(
                    Finding(f"暗色假设（亮色主题下会消失）: {match.group(0)}", rel, idx)
                )
            for match in RE_HARDCODED_WHITE.finditer(line):
                findings.append(
                    Finding(
                        "写死白字（accent 底上应走 text-text-on-accent）: text-white",
                        rel,
                        idx,
                    )
                )

        # 判据 4：文件级
        if RE_FOCUS_NONE.search(code) and not RE_FOCUS_VISIBLE.search(code):
            idx = next(
                (i for i, l in enumerate(lines, start=1) if RE_FOCUS_NONE.search(l)),
                1,
            )
            findings.append(
                Finding(
                    "整个文件用了 focus:outline-none 却没有任何 focus-visible: 替代"
                    "（键盘用户看不到焦点在哪）",
                    rel,
                    idx,
                )
            )

    metrics = f"{len(files)} 个 tsx / {len(findings)} 处违规"
    if findings:
        return GuardResult.violated(len(files), findings, metrics=metrics)
    return GuardResult.passed(len(files), metrics=metrics)
