"""`src/styles/` 目录与命名规范护栏。

背景：`styles/` 曾有三个同型问题，都不是「代码写错」而是「没有约定」：

| 问题 | 后果 |
| --- | --- |
| 根级游离 CSS（`jetbrains-mono.css`、`nerd-font.css`） | 看不出归属层；新文件效仿后根级堆积 |
| 文件名 camelCase | 与 `check-file/folder-naming-convention` 的 kebab 约定不一致 |
| 新增目录 | 无人声明它属于哪一层 |

规范全文在 `src/styles/README.md`。本护栏把其中**可机器判定**的三条钉住：

1. **只允许五个目录**：`base/` / `themes/` / `motion/` / `components/` / `fonts/`。
   新增目录必须同时改本文与 README —— 那是一次有意识的决定，不是顺手加。
2. **根级只允许 `index.css`**（入口）与 `README.md`。
   任何新根级文件都无法判断归属层。
3. **文件名 kebab-case**（`agent-chat.css`，不是 `agentChat.css`）。
4. **`components/` 下每个文件必须够一个「域」** —— 判据：非注释行 > 20 行，
   且至少 2 个顶层类。不足者应合并进相邻域，或改用 Tailwind utility
   （`.custom-radio` 只有 14 行 1 个类，已迁到 `ui/Radio.tsx`）。

## 为什么这三条值得写成护栏

它们全部是「加一个文件时顺手做错」的类型，且**错了不会报错** ——
样式照样生效，只是目录逐渐失序。这类问题靠 review 抓不住，只能靠机器。

反过来说：**不要**把「`components/` 一个文件只服务一个域」这类需要语义判断的
规则写进护栏 —— 那是 review 的职责，写成正则只会产生误报。
"""
from __future__ import annotations

import re

from guards.core.contract import Context, Finding, Guard, GuardResult

SCOPE = "src/styles/**/*.css"

#: 允许的子目录（新增必须同时改 README 与本文）
ALLOWED_DIRS = frozenset({"base", "themes", "motion", "components", "fonts"})

#: 根级允许的文件（入口 + 说明）
ROOT_ALLOWED = frozenset({"index.css", "README.md"})

#: kebab-case：小写字母开头，只含小写字母 / 数字 / 连字符
RE_KEBAB = re.compile(r"^[a-z][a-z0-9-]*\.css$")

#: `components/` 下一个文件要算「一个域」的最低门槛。
#: 数字取的是「小到不会误伤真域、大到能拦住单控件样式」的中位：
#: 现存最小的真域是 `onboarding.css`（33 行 / 2 类）。
MIN_DOMAIN_LINES = 20
MIN_DOMAIN_CLASSES = 2

#: 顶层类选择器（行首点号，缩进可有可无）
RE_TOP_LEVEL_CLASS = re.compile(r"^\s*\.[a-zA-Z][\w-]*", re.M)

GUARD = Guard(
    id="check_styles_layout",
    title="src/styles 目录与文件命名规范（见 src/styles/README.md）",
    scopes=(SCOPE,),
    red_lines=(),
    docs="src/styles/README.md",
    fix_hint=(
        "新 CSS 归入 tokens/ base/ components/ fonts/ 之一；"
        "文件名用 kebab-case；根级只允许 index.css。"
        "确需新目录时同时更新 README 与本护栏的 ALLOWED_DIRS"
    ),
)


def check(ctx: Context) -> GuardResult:
    findings: list[Finding] = []
    files = ctx.glob(SCOPE)

    for css_file in files:
        rel = ctx.rel(css_file)
        # 相对 src/styles 的路径段
        parts = rel.split("/")
        try:
            styles_idx = parts.index("styles")
        except ValueError:  # pragma: no cover - SCOPE 已保证前缀
            continue
        tail = parts[styles_idx + 1 :]

        # 判据 2：根级只允许 index.css
        if len(tail) == 1:
            if tail[0] not in ROOT_ALLOWED:
                findings.append(
                    Finding(
                        f"根级不允许放 CSS（{tail[0]}）—— 归入 tokens/ base/ components/ fonts/",
                        rel,
                        1,
                    )
                )
            continue

        # 判据 1：子目录必须在白名单内
        subdir = tail[0]
        if subdir not in ALLOWED_DIRS:
            findings.append(
                Finding(
                    f"未声明的样式子目录 `{subdir}/`"
                    f"（允许：{' / '.join(sorted(ALLOWED_DIRS))}）",
                    rel,
                    1,
                )
            )

        # 判据 3：文件名 kebab-case
        if not RE_KEBAB.match(css_file.name):
            findings.append(
                Finding(f"文件名不是 kebab-case：{css_file.name}", rel, 1)
            )

        # 判据 4：components/ 下每个文件必须够一个「域」
        if subdir == "components":
            text = ctx.read_tolerant(rel)
            code_lines = [
                ln
                for ln in text.splitlines()
                if ln.strip() and not ln.strip().startswith(("/*", "*", "//"))
            ]
            roots = set(RE_TOP_LEVEL_CLASS.findall(text))
            if len(code_lines) < MIN_DOMAIN_LINES or len(roots) < MIN_DOMAIN_CLASSES:
                findings.append(
                    Finding(
                        f"不足一个组件域（{len(code_lines)} 行 / {len(roots)} 个顶层类，"
                        f"门槛 {MIN_DOMAIN_LINES} 行 / {MIN_DOMAIN_CLASSES} 类）"
                        f" —— 合并进相邻域，或改用 Tailwind utility",
                        rel,
                        1,
                    )
                )

    metrics = f"{len(files)} 个 css / {len(findings)} 处违规"
    if findings:
        return GuardResult.violated(len(files), findings, metrics=metrics)
    return GuardResult.passed(len(files), metrics=metrics)
