"""notification 核心域禁止 import 业务域（依赖方向的机器钉子）。

## 第一性原理

不变量（design.md v2/v3 T4/D6）：**通知是应用级横切能力，核心域不认识任何业务。**
`src-tauri/src/notification/` 只允许依赖：std / tauri / 官方插件 / `crate::common`（基础设施）/
`crate::AppStateWrapper`+`AppError`（组合根入口）/ 自身。一旦有人写 `use crate::agent::...`，
「新业务接入零核心改动」的开闭承诺就开始腐烂——第二、第三个业务会顺着这条缝往核心里堆分支，
回到 v1 被评审否决的老路。这类「约定级」不变量历史上全靠 review 维持的都会长回来
（参照 git-optional-lock 四次复发复盘），因此钉成确定性静态判据。

## 判据（最简、显然正确）

判据（**清单 = 下方 `BUSINESS_MODULES` 元组本身**，不要在本段 prose 里另列一份副本 —— 
历史上两处漂移过）：`src-tauri/src/notification/**/*.rs` 中任何位置（含注释外的 import 与
全路径引用）出现 `crate::<业务域>::` 即违规。`app_menu` 之外的 `crate::app::`（组合根）同样
禁止：核心域反过来 import 组合根会形成装配循环。

允许的基础设施依赖：`crate::common` / `crate::core` / `crate::platform`（红线 10 的平台适配器，
如 `system_notify`）/ `crate::app_state`，以及 crate 根 re-export 的 `AppError` / `AppStateWrapper`
（裸类型名不带 `::module`，不命中判据）。

判据实现取「字符串级」而非 AST：模式 = `crate::(agent|git|terminal|...)` 出现即违规，
与本文件其余护栏（单源字面量类）同风格——宁可注释里提到业务模块名就要求改写措辞，
也不要引入需要维护的 Rust 词法扫描器。
"""
from __future__ import annotations

import re

from guards.core.contract import Context, Finding, Guard, GuardResult

SCOPES = ("src-tauri/src/notification/**/*.rs",)

# lib.rs 声明的业务/领域模块 + 组合根 `app`（crate 根 re-export 的 AppError/AppStateWrapper
# 不在其中，因此不被拦）。基础设施 common/core/platform/app_state 刻意不列 —— 允许依赖。
BUSINESS_MODULES = (
    "agent",
    "app",
    "app_menu",
    "browser",
    "connection",
    "conversation",
    "dap",
    "file",
    "git",
    "library",
    "lsp",
    "project",
    "search",
    "session",
    "settings",
    "task",
    "terminal",
    "theme",
)

FORBIDDEN = re.compile(r"crate::(?:%s)\b" % "|".join(BUSINESS_MODULES))

# 分组形态（`use crate::{common::Bar, agent::Foo};`）里业务模块不在 `crate::` 之后首位，
# `FORBIDDEN` 匹配不到 —— 且 rustfmt **保留** 2+ 项分组（实测），不是理论缺口。
# 故按「`crate::` 起始 → 语句窗口 → 窗口内业务模块作为路径段出现」二次判定。
# 分隔符集合 `[::{,]` 覆盖分组成员位置；前瞻排除 `application` / `agentFoo` 这类前缀撞名。
GROUP_MEMBER = re.compile(
    r"(?:^|[::{,])\s*(?:%s)\s*(?=$|::|,|;|\}})" % "|".join(BUSINESS_MODULES)
)


def _statement_window(text: str, start: int) -> str:
    """`crate::` 之后的语句窗口（至最近的 `;`）—— 分组列表不会跨 `;`。"""
    end = text.find(";", start)
    return text[start : end if end != -1 else len(text)]


def _scan(text: str):
    """产出 (位置, 命中的完整引用文本)。两种形态都覆盖：直接路径与分组成员。"""
    for m in re.finditer(r"crate\s*::", text):
        window = _statement_window(text, m.end())
        for inner in GROUP_MEMBER.finditer(window):
            # 拼回完整引用（`crate::` + 命中处起的路径），让报错可直接定位/复制。
            hit = inner.group(0).lstrip("{,:").strip()
            yield m.start(), f"crate::{hit}"
        # 直接形态（`crate::agent::…`）：窗口首位即业务模块，GROUP_MEMBER 的 `^` 分支已覆盖，
        # 但 `crate::agent` 这类**裸模块** import（无后续 `::`）在窗口里是纯 `agent` 结尾，
        # 由 `(?=$)` 分支命中 —— 无需重复判定。


GUARD = Guard(
    id="check_notification_core_direction",
    title="notification 核心域禁止 import 业务域（依赖方向：业务 → 门面，不可反向）",
    scopes=SCOPES,
    red_lines=(),
    docs=".trellis/spec/backend/quality-guidelines.md",
    fix_hint=(
        "notification/ 是业务无关的核心域：把业务知识留在各自域内的投影文件"
        "（如 agent/chat/notify.rs），业务只经 NotificationCenter 门面进来。"
    ),
)


def check(ctx: Context) -> GuardResult:
    files = sorted({p for scope in SCOPES for p in ctx.glob(scope)})
    findings = []
    for path in files:
        rel = ctx.rel(path)
        text = ctx.read(rel)
        for pos, hit in _scan(text):
            findings.append(
                Finding(
                    f"notification 核心域出现业务模块引用 {hit!r} —— "
                    "依赖方向必须保持「业务 → NotificationCenter 门面」，核心域零业务 import",
                    rel,
                    text.count("\n", 0, pos) + 1,
                )
            )

    metrics = f"{len(files)} 个 .rs / 违规 {len(findings)}"
    if findings:
        return GuardResult.violated(len(files), findings, metrics=metrics)
    return GuardResult.passed(len(files), metrics=metrics)
