"""Terminal 缓存键必须由唯一 mint（`terminalAddress`）派生，禁止手搓 env 命名空间键。

## 第一性原理

terminal 条目的地址是 `WorkspaceSession` 的纯函数投影：

    terminalAddress(session, tabId, paneId) = session.key + SEP + tabId + SEP + paneId

env（local/wsl/remote）是**传输/存储维度**，不是寻址维度 —— 物理 Map 三分，但键内不编码
env（Remote 的 `Environment` 不含 entryId，env 段无法从 session 派生，是「第二身份表示」）。
历史病根：三套手搓前缀（`''` / `wsl:` / `remote:`）+ 两套后缀 scheme + 两套前缀扫描，
"找不到时拿第一个" 让插入恒落首个 tab。本护栏把「只有一处键构造」从纪律变成可执行判据。

## 判据（三条，均确定性可复现）

- **G1 符号级**：已退役的键构造 / 寻址符号不得出现在 mint 文件
  （`terminalAddress.ts`；`terminalAddress` 本身除外）之外
  （`terminalCacheKey(` / `wslCacheKey(` / `remoteCacheKey(` / `findSessionIdForProject(` /
  `terminalSpacePrefix(` / `parseProjectIdFromWslKey(` / `resolveBackendForKey(` /
  `resolveCacheKey(` / `destroyCachesByPrefix(` / 三个 `destroy*CachesByPrefix(`）。
  符号随本任务删除后引用即编译错；护栏防的是**新造同类**（换个名字重新手搓不在此列，
  由 G2 形态判据兜底）。
- **G2 形态级（仅 terminal 域）**：`src/features/terminal/**` 内禁止「模板字符串内插 `${`
  且字面量含 `wt:` / `wsl:` / `remote:`」的键拼接。作用域刻意收窄，与
  `check_workspace_identity` 判据 6 的既有边界对齐（终端缓存曾有自己的合法 `:` 命名空间）。
- **G3 材质级（10-12 R6 遗留，本任务补）**：terminal 段的保留分隔符材质不得出现在
  mint 文件（`terminalAddress.ts`，10-13 S4 前为 `terminalCache.ts`）之外。这条把 10-12 R6
  「所有段用同一保留分隔符」从纸面变成判据。
  **必须像 `check_workspace_identity` 判据 6 那样分两档，不能一刀切**：

  | 档 | 判据 | 基线（实测） |
  | --- | --- | --- |
  | 强材质 | `TERMINAL_KEY_SEP` **标识符**（这个名字没有第二种合法用途）→ 出 mint 文件即违规 | **0**（唯一出 mint 的命中在 `terminalAddress.test.ts`，测试豁免） |
  | 语境材质 | `\\u0001` / `\\x01` / `fromCharCode(1)` **转义** 且**同行**命中 terminal 语境词（`cacheKey`/`terminalKey`/`terminalAddress`/`tabId`/`paneId`/`TerminalCache`）才拦 | 非 0：`src/shared/utils/fileTree.ts:115,116,137` 用 `\\u0001` 做**子树指纹分隔** —— 合法的无关命名空间，与判据 6 注释里 runner 的 `${projectId}\\0${filePath}` 同型 |

> **G1/G2 的豁免边界（如实声明，不过度声称）**：两者对 `MINT_FILE` **整文件放行**
> （键构造必须发生在那里面，`test_retired_symbol_inside_mint_file_is_allowed` 钉住了这个行为）。
> 代价是「在 mint 内部另造一个私有 `destroyCachesByPrefix`」**不会**被本护栏抓到 ——
> 那一层由 TS（`noUnusedLocals` 让未使用即报错）+ code review 兜，不由正则兜。
> 写在这里是让下一个人知道这条护栏**没**覆盖什么，而不是误以为它覆盖了全部。

> 未覆盖：`session.key` / `terminalAddress` 的合法使用不拦；测试文件不拦
> （引用已删符号会在 tsc 阶段暴露）。
>
> **取证教训（写给下一个改这条护栏的人）**：G3 首轮只 grep 了 `TERMINAL_KEY_SEP` 就写下
> 「基线为 0」，漏了 `\\u0001` 字面量形态 —— 按那一版实现会得到 3 条误报，而它拦的正是
> 它自己依赖的那个假设。材质类判据必须**逐形态实测**（标识符 / `\\u0001` / `\\x01` /
> `fromCharCode` / 裸控制字节 / 不同引号），不能只测一种。
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

# 唯一寻址模块：键构造（材质 + mint）只在它内部发生。
# 10-13 结构整理 S4 把地址层（`TERMINAL_KEY_SEP` / `terminalAddress` / `decodeTerminalKey` /
# `terminalKeyLabel`）从 `terminalCache.ts` 抽到同级 `terminalAddress.ts` —— 唯一 mint 随之迁移，
# `terminalCache.ts` **失去** G3 豁免（它现在只消费地址，不再铸造；若它又出现分隔符标识符，
# 说明地址层被重新内联回缓存层，正是 G3 要拦的回退）。
MINT_FILE = "src/features/terminal/components/terminalAddress.ts"
# G2 作用域：terminal 域。
TERMINAL_DOMAIN = "src/features/terminal/"
# 合法/非法模板字面量判定
TEMPLATE_RE = re.compile(r"`([^`]*)`")
LEGACY_ENV_MARKERS = ("wt:", "wsl:", "remote:")
TEST_PATH_MARKERS = ("__tests__/", ".test.ts", ".test.tsx", ".spec.ts", ".spec.tsx")

# G3：分隔符材质 —— 分两档（见 docstring 的表），形态必须逐档实测过
SEP_MATERIAL_STRONG_RE = re.compile(r"\bTERMINAL_KEY_SEP\b")
SEP_MATERIAL_ESCAPED_RE = re.compile(r"\\u0001|\\x01|String\.fromCharCode\(\s*1\s*\)")
# 语境词：同一行出现才认定为「terminal 键材质化」（否则 fileTree 的子树指纹会被误伤）
SEP_MATERIAL_CONTEXT_RE = re.compile(
    r"cacheKey|terminalKey|terminalAddress|tabId|paneId|TerminalCache", re.IGNORECASE
)

GUARD = Guard(
    id="check_terminal_key_mint",
    title="Terminal 键唯一 mint（禁手搓 env 命名空间键）",
    scopes=SCAN_SCOPES,
    red_lines=(10, 12),
    docs="docs/domain-model.md",
    fix_hint=(
        "terminal 地址一律走 terminalAddress.ts 的 `terminalAddress(session, tabId, paneId)` / "
        "terminalCache.ts 的 `resolveTerminalEntry` / `destroyTerminalsForTab|Session|Project`；"
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

        # G3：分隔符材质出 mint 文件即违规（强材质无条件拦；转义需同行语境词）
        if rel != MINT_FILE:
            for idx, line in enumerate(text.splitlines(), start=1):
                strong = SEP_MATERIAL_STRONG_RE.search(line)
                escaped = SEP_MATERIAL_ESCAPED_RE.search(line) and SEP_MATERIAL_CONTEXT_RE.search(line)
                if not (strong or escaped):
                    continue
                findings.append(
                    Finding(
                        "G3 terminal 段分隔符材质化：`TERMINAL_KEY_SEP` / `\\u0001` 只允许活在 "
                        f"{MINT_FILE}（唯一 mint）—— 第二处材质化必然与它漂移（10-12 R6）",
                        rel,
                        idx,
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
