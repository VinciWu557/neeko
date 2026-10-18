"""`server/` 基础设施层禁止 import 业务域与 tauri（依赖方向的机器钉子）。

## 第一性原理

不变量（task 10-17-cs-http-gateway A2/A8）：**网关引擎是进程级基础设施，不认识任何业务，
也不认识 Tauri。** `src-tauri/src/server/` 只允许依赖：std / axum / tower / tower-http /
subtle / tokio / log / `crate::common`（基础设施）/ 自身。

两条边各自防一种腐烂：

1. **业务边** —— 一旦 `server/` 里出现 `crate::agent::…`，引擎就长出了业务分支，
   「新增客户端形态 = 加一个路由组，引擎零改动」的开闭承诺开始腐烂。
2. **Tauri 边** —— `server/` 不 import `tauri` 是**可测试性契约**：引擎因此能在纯 tokio
   测试里被驱动（`engine/tests.rs` 全程无 `tauri::test`）。业务句柄由调用方注入，
   一旦引擎自取 `AppHandle`，这条缝就关不上了。

## 判据

清单单源：业务模块清单纯粹从 [`check_notification_core_direction`] 同一元组导入
（禁止维护第二份副本 —— 历史上两处漂移过）。判定在**剥掉注释与字符串字面量后**的文本上做：

- `crate::<业务域>::` 出现即违规（含 `use` 分组形态，复用同款 `_scan`）；
- `tauri::`（含 `use tauri::…`）或裸 `AppHandle` 标识符出现即违规。

`crate::common` / `crate::server` 与 crate 根 re-export 的类型不在判据内。
"""
from __future__ import annotations

import re

from guards.core.contract import Context, Finding, Guard, GuardResult

from .check_notification_core_direction import BUSINESS_MODULES, _scan

SCOPES = ("src-tauri/src/server/**/*.rs",)

# `tauri::` 全路径与 `AppHandle` 裸类型名（`use tauri::AppHandle` 已被前者覆盖，
# 但 `fn f(app: AppHandle)` 这种经其它路径引入的形态只有裸名能拦）。
TAURI_REF = re.compile(r"\btauri\s*::|\bAppHandle\b")


def _strip_comments_and_strings(text: str) -> str:
    """抹掉注释与字符串/字符字面量，只留代码骨架。

    与 `check_service_no_delivery_dep` 同思路：注释里解释「为什么不用 tauri」是合法文档，
    不能算违规；而字符串字面量里的 `tauri::` 只是数据。
    """
    out = []
    i = 0
    length = len(text)
    while i < length:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < length else ""
        if ch == "/" and nxt == "/":
            end = text.find("\n", i)
            i = length if end == -1 else end
        elif ch == "/" and nxt == "*":
            end = text.find("*/", i + 2)
            i = length if end == -1 else end + 2
        elif ch == "r" and nxt in ("#", '"'):
            # 原始字符串 r"…" / r#"…"#（可多级 #）。
            j = i + 1
            hashes = 0
            while j < length and text[j] == "#":
                hashes += 1
                j += 1
            if j < length and text[j] == '"':
                terminator = '"' + "#" * hashes
                end = text.find(terminator, j + 1)
                i = length if end == -1 else end + len(terminator)
            else:
                out.append(ch)
                i += 1
        elif ch == '"':
            j = i + 1
            while j < length:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == '"':
                    j += 1
                    break
                j += 1
            i = j
        else:
            out.append(ch)
            i += 1
    return "".join(out)


GUARD = Guard(
    id="check_server_no_business_dep",
    title="server/ 基础设施层禁止 import 业务域与 tauri（引擎零业务分支、零 Tauri）",
    scopes=SCOPES,
    red_lines=(),
    docs=".trellis/spec/backend/directory-structure.md",
    fix_hint=(
        "引擎只认 RouteGroup 值对象：业务知识留在对应路由组里（如 "
        "agent/hooks/ingest/server.rs::route_group），业务句柄由组合根注入。"
    ),
)


def check(ctx: Context) -> GuardResult:
    files = sorted({p for scope in SCOPES for p in ctx.glob(scope)})
    findings = []
    for path in files:
        rel = ctx.rel(path)
        text = _strip_comments_and_strings(ctx.read(rel))
        for pos, hit in _scan(text):
            findings.append(
                Finding(
                    f"server/ 出现业务模块引用 {hit!r} —— "
                    "引擎与门必须零业务依赖（业务知识落各自路由组）",
                    rel,
                    text.count("\n", 0, pos) + 1,
                )
            )
        for match in TAURI_REF.finditer(text):
            findings.append(
                Finding(
                    f"server/ 出现 Tauri 引用 {match.group(0)!r} —— 引擎必须与 Tauri 解耦"
                    "（可在纯 tokio 测试里驱动；业务句柄由调用方注入）",
                    rel,
                    text.count("\n", 0, match.start()) + 1,
                )
            )

    metrics = f"{len(files)} 个 .rs / 违规 {len(findings)}"
    if findings:
        return GuardResult.violated(len(files), findings, metrics=metrics)
    return GuardResult.passed(len(files), metrics=metrics)
