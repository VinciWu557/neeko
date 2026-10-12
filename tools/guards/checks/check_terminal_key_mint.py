"""Terminal 缓存键必须由唯一 mint（`terminalAddress`）派生，禁止手搓 env 命名空间键。

## 第一性原理

terminal 条目的地址是 `WorkspaceSession` 的纯函数投影：

    terminalAddress(session, tabId, paneId) = session.key + SEP + tabId + SEP + paneId

env（local/wsl/remote）是**传输/存储维度**，不是寻址维度 —— 物理 Map 三分，但键内不编码
env（Remote 的 `Environment` 不含 entryId，env 段无法从 session 派生，是「第二身份表示」）。
历史病根：三套手搓前缀（`''` / `wsl:` / `remote:`）+ 两套后缀 scheme + 两套前缀扫描，
"找不到时拿第一个" 让插入恒落首个 tab。本护栏把「只有一处键构造」从纪律变成可执行判据。

## 判据（两条，均确定性可复现）

- **G1 符号级**：已退役的键构造 / 寻址符号不得出现在 `terminalCache.ts` 之外
  （`terminalCacheKey(` / `wslCacheKey(` / `remoteCacheKey(` / `findSessionIdForProject(` /
  `terminalSpacePrefix(` / `parseProjectIdFromWslKey(` / `resolveBackendForKey(` /
  `resolveCacheKey(` / `destroyCachesByPrefix(` / 三个 `destroy*CachesByPrefix(`）。
  符号随本任务删除后引用即编译错；护栏防的是**新造同类**（换个名字重新手搓不在此列，
  由 G2 形态判据兜底）。
- **G2 形态级（仅 terminal 域）**：`src/features/terminal/**` 内禁止「模板字符串内插 `${`
  且字面量含 `wt:` / `wsl:` / `remote:`」的键拼接。作用域刻意收窄，与
  `check_workspace_identity` 判据 6 的既有边界对齐（终端缓存曾有自己的合法 `:` 命名空间）。

> 未覆盖：`session.key` / `terminalAddress` 的合法使用不拦；测试文件不拦
> （引用已删符号会在 tsc 阶段暴露）。
"""
from __future__ import annotations

import re

from guards.core.contract import Context, Finding, Guard, GuardResult

SCAN_SCOPES = ("src/**/*.ts", "src/**/*.tsx")

# G1：退役符号（带调用括号，减少变量名误伤）
RETIRED_SYMBOL_RE = re.compile(
    r"\b(?:terminalCacheKey|wslCacheKey|remoteCacheKey|findSessionIdForProject|"
    r"terminalSpacePrefix|parseProjectIdFromWslKey|resolveBackendForKey|resolveCacheKey|"
    r"destroyCachesByPrefix|destroyTerminalCachesByPrefix|destroyWslCachesByPrefix|"
    r"destroyRemoteCachesByPrefix)\s*\("
)

# 唯一寻址模块：键构造只在它内部发生。
MINT_FILE = "src/features/terminal/components/terminalCache.ts"
# G2 作用域：terminal 域。
TERMINAL_DOMAIN = "src/features/terminal/"
# 合法/非法模板字面量判定
TEMPLATE_RE = re.compile(r"`([^`]*)`")
LEGACY_ENV_MARKERS = ("wt:", "wsl:", "remote:")
TEST_PATH_MARKERS = ("__tests__/", ".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx")

GUARD = Guard(
    id="check_terminal_key_mint",
    title="Terminal 键唯一 mint（禁手搓 env 命名空间键）",
    scopes=SCAN_SCOPES,
    red_lines=(10, 12),
    docs="docs/domain-model.md",
    fix_hint=(
        "terminal 地址一律走 terminalCache.ts 的 `terminalAddress(session, tabId, paneId)` / "
        "`resolveTerminalEntry` / `destroyTerminalsForTab|Session|Project`；"
        "禁止再手搓 `proj:wt:` / `wsl:` / `remote:` 形态的键"
    ),
)


def check(ctx: Context) -> GuardResult:
    files = sorted({p for scope in SCAN_SCOPES for p in ctx.glob(scope)})
    if not files:
        return GuardResult.broken("在 src/**/*.{ts,tsx} 下扫到 0 个文件 —— 口径失效", scanned=0)

    findings: list[Finding] = []
    for path in files:
        rel = ctx.rel(path)
        if any(marker in rel for marker in TEST_PATH_MARKERS):
            continue
        text = ctx.read(rel)

        # G1：退役符号只允许活在唯一 mint 模块内
        if rel != MINT_FILE:
            for m in RETIRED_SYMBOL_RE.finditer(text):
                findings.append(
                    Finding(
                        f"退役符号 {m.group(0).rstrip('( ') !r} 不得回潮：terminal 地址唯一 mint = "
                        "`terminalAddress(session, ...)`（见 docs/domain-model.md）",
                        rel,
                        text.count("\n", 0, m.start()) + 1,
                    )
                )

        # G2：terminal 域内禁模板字符串手搓 env 命名空间键
        if rel.startswith(TERMINAL_DOMAIN) and rel != MINT_FILE:
            for m in TEMPLATE_RE.finditer(text):
                body = m.group(1)
                if "${" not in body:
                    continue
                marker = next((x for x in LEGACY_ENV_MARKERS if x in body), None)
                if marker is None:
                    continue
                findings.append(
                    Finding(
                        f"terminal 域内禁止模板字符串手搓 {marker!r} 键："
                        "走 `terminalAddress(session, tabId, paneId)`",
                        rel,
                        text.count("\n", 0, m.start()) + 1,
                    )
                )

    metrics = f"{len(files)} 个 ts/tsx / 违规 {len(findings)}"
    if findings:
        return GuardResult.violated(len(files), findings, metrics=metrics)
    return GuardResult.passed(len(files), metrics=metrics)
