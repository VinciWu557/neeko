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

## 五条判据（全部只拦**新增**，不判存量）

本轮（2026-10-27）已把存量清零，所以不需要 ratchet 基线台账 ——
任何一条命中都是**新引入**的，直接报。

| # | 判据 | 为什么它是 Bug 而非风格 |
| --- | --- | --- |
| 1 | 硬编码 hex 色（`text-[#hex]` / `bg-[#hex]` / `border-[#hex]`） | 主题切换后不跟着变 —— Light / Claude 下与整体不搭 |
| 2 | 暗色假设（`border-white/N` / `bg-white/N`） | 假设底色是暗的；亮色主题下分割线**直接消失** |
| 3 | accent 底上的写死白字（`text-white`） | 主题有 `--text-on-accent` 专门处理「accent 底上该用什么字色」 |
| 4 | `focus:outline-none` 所在文件无任何 `focus-visible:` | 键盘用户**看不到焦点在哪**（P0-6） |
| 5 | **CSS 里** accent 实底 + 非 `--text-on-accent` 的前景色 | 与判据 3 同源，但发生在 CSS 文件里；暗色主题下字与底几乎同色 |

## 三条豁免

1. **CSS 文件内**：判据 1/2/3 只作用于 TSX —— `themes/*.css` 里写 hex 是**定义源**，
   不是逃逸。**判据 5 反过来只作用于 CSS**（TSX 侧由「用 `optionSecondary()`」保证，
   见下方「为什么 TSX 侧没有对应判据」）。
2. **注释与字符串**：判据读的是源码文本，需剥注释与引号内容，
   否则「注释里提到 `border-white/[0.04]`」会误报（本仓库的 token 文件里就有这种说明文字）。
3. **判据 4 只看文件级**：一个文件里既有合规的 focus-visible、又有不合规的元素，
   本护栏不逐元素判定；本护栏只兜住「整个文件都没有 focus-visible」这种粗疏情况。

## 为什么 TSX 侧没有「accent 实底 + 错前景色」的判据

这条判据**曾经**由本地 ESLint 规则 `neeko/ui/accent-foreground` 承担（AST 判定），
2026-10-28 删除。删除理由不是「不需要」，而是**它的防护面与正确写法互斥**：

| 写法 | ESLint 规则能否看到 |
| --- | --- |
| `className="text-text-muted"` 字面量 | ✅ |
| `className={optionSecondary(selected)}` | ❌ 函数返回值不在 AST 静态范围 |
| CSS 文件里的 `color:` | ❌ 规则只扫 `.tsx?` |

而那 7 处真实 bug 修完后**全部改用 `optionSecondary()`** —— 规则恰好对它们失明。
7 处里有 2 处在 CSS（`agent.css` / `base.css`），规则从来就看不到。

所以现在的分工是：

- **TSX 侧**：`shared/utils` 的 `optionSecondary(selected)` 是唯一入口，
  用对了就天然正确（护栏不必逐元素判定，也判不了）。
- **CSS 侧**：本判据 5 —— 这是真正的盲区，此前**零覆盖**。

## 为什么不做 ratchet

存量已清零（见 `prd.md` AC1）。若日后重新出现存量，应该先清零再放宽阈值，
而不是把基线做大 —— 基线做大的那一刻，护栏就退化成「记录现状」而不是「阻止回潮」。
"""
from __future__ import annotations

import re

from guards.core.contract import Context, Finding, Guard, GuardResult

TSX_SCOPES = ("src/**/*.tsx",)
CSS_SCOPES = ("src/styles/**/*.css",)

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

# ── 判据 5：CSS 里 accent 实底 + 错前景色 ────────────────────────────
#
# 与判据 3（TSX 的 `text-white`）同源：accent 实底上的前景色必须是
# `--text-on-accent`。区别是这条发生在 CSS 文件里。
#
# 实测那 7 处「灰字压 accent 底」的 bug 里有 2 处在 CSS：
#   agent.css  .agent-bar-btn.selected { background: var(--accent-blue); color: var(--text-primary) }
#   base.css   .wc-close:hover        { background-color: var(--accent-red); color: #fff }
#
# **只认「值就是 var(--accent-*)」的实底**。以下都不算实底，不得判违规：
#   background: color-mix(in srgb, var(--accent-blue) 32%, transparent)   ← 半透明
#   background-color: rgba(var(--accent-blue-rgb), 0.28)                  ← 半透明
# 半透明底是「海面 + 淡 accent」，上面用普通文字色是**对的**（editor.css 有 5 处）。
RE_SOLID_ACCENT_BG = re.compile(
    r"background(?:-color)?\s*:\s*var\(\s*--(?:accent-(?:blue|green|yellow|red|orange|brick)|destructive)\s*\)"
)

# 合法前景的**值**部分（`RE_FG_DECL.group(1)` 抓到的就是它）
RE_ON_ACCENT_FG = re.compile(r"var\(\s*--text-on-accent\s*\)(?:\s*!important)?")

# 任意前景色声明。负向断言排除 `background-color:`（`(?<!background-)`）。
RE_FG_DECL = re.compile(r"(?<!background-)(?<!-)\bcolor\s*:\s*([^;]+);")

#: 一条 CSS 规则块（body 不含嵌套 `{}`，所以 `@layer X { .y { … } }` 只会匹配到 `.y`）
RE_CSS_RULE_BLOCK = re.compile(r"([^{}]+)\{([^{}]*)\}")

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
    title="UI 样式层禁止硬编码色 / 暗色假设 / 写死白字 / 无焦点环 / accent 底错前景",
    scopes=TSX_SCOPES + CSS_SCOPES,
    red_lines=(),
    docs=".trellis/spec/frontend/quality-guidelines.md",
    fix_hint=(
        "硬编码色 → 语义 token（--git-status-* / --diff-* / --accent-red 等）；"
        "暗色假设 → border-border-subtle / bg-bg-hover；"
        "accent 底上的白字 → text-text-on-accent（浅色底用 text-accent-foreground）；"
        "焦点环 → focus-visible:ring-2 focus-visible:ring-accent-blue；"
        "CSS 里 accent 实底的前景色 → color: var(--text-on-accent)"
    ),
)


def check(ctx: Context) -> GuardResult:
    findings: list[Finding] = []
    tsx_files = ctx.glob(TSX_SCOPES[0])
    css_files = ctx.glob(CSS_SCOPES[0])
    files = list(tsx_files) + list(css_files)

    for path in tsx_files:
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

    # ── 判据 5：CSS 里 accent 实底 + 错前景色 ──────────────────────────
    for path in css_files:
        rel = ctx.rel(path)
        code = strip_noise(ctx.read_tolerant(rel))
        for block in RE_CSS_RULE_BLOCK.finditer(code):
            selector, body = block.group(1).strip(), block.group(2)
            if not RE_SOLID_ACCENT_BG.search(body):
                continue
            for fg in RE_FG_DECL.finditer(body):
                if RE_ON_ACCENT_FG.fullmatch(fg.group(1).strip()):
                    continue
                line = code[: block.start()].count("\n") + 1
                findings.append(
                    Finding(
                        f"accent 实底上的前景色应为 var(--text-on-accent)，"
                        f"实际是 `{fg.group(1).strip()}`（{selector[:60]}）",
                        rel,
                        line,
                    )
                )

    metrics = (
        f"{len(tsx_files)} 个 tsx + {len(css_files)} 个 css / {len(findings)} 处违规"
    )
    if findings:
        return GuardResult.violated(len(files), findings, metrics=metrics)
    return GuardResult.passed(len(files), metrics=metrics)
