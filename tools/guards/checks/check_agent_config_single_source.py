"""Agent 配置单一数据源：前端不得再持有任何副本。

## 第一性原理

后端 `AgentManager` 是 agent 配置的唯一真相（`add_agent` 写覆盖层、`list_agents`
读生效值、`adapter_for` 用它 spawn）。前端曾经为「改完立刻看到」另存三份副本：

| 副本 | 曾是 | 症状 |
| --- | --- | --- |
| `AppConfig.agentCommandOverrides` | 终端的唯一来源 | 设置页改了启动命令，终端仍读旧值 |
| `AppConfig.agentOverrides` | 替后端保管「是否被覆盖」 | 与后端覆盖表两份真相 |
| `config.customAgents`（读侧） | 自定义 agent 列表 | 写入方已删，新建/删除不反映 |

**根因不是「哪个同步点漏了」，而是「存在需要同步的东西」。** 三份可写、三份可读，
一致性维护点分散到设置页/终端/Skill 页/项目设置 —— 必然有遗漏。

## 为什么必须是静态判据而不是行为测试

这类漂移的运行时表现是「某个值没更新」，而每份副本各自的单元测试**永远会通过**：
它们各自 mock 自己那个数据源。实测已发生两处（见上表），行为测试一次都没抓到。
只有「副本本身不许存在」这个判据能被机械验证。

## 判据

1. `src/` 下（排除 `src-tauri/`）不得出现 `agentCommandOverrides` / `agentOverrides`
   标识符。唯一例外是解释「它们已被删除」的注释文件（`shared/store/agentStore.ts`）。
2. 只有 `features/agent/api/agentApi.ts` 可以 `invoke('add_agent' | 'remove_agent')` ——
   其它位置直接写会绕过「落盘后刷新缓存」，界面停留在旧值。
3. 终端链路取 agent 命令必须经 `resolveAgent`（未加载会等一次幂等加载），
   不得直接查快照 `getState().byId(...)` —— 那会把「还没加载」误判成「不存在」，
   用户得到空终端。
"""
from __future__ import annotations

import re

from guards.core.contract import Context, Finding, Guard, GuardResult

SCOPES = ("src/**/*.ts", "src/**/*.tsx")

# 副本标识符。允许它们只出现在解释「已删除」的注释里 —— 那些文件在 ALLOWED_MENTIONS。
FORBIDDEN_IDENTIFIERS = ("agentCommandOverrides", "agentOverrides")

# 说明性注释允许提及（否则解释历史的注释会被误报）。
# 路径是 `ctx.rel` 形态（含 `src/` 前缀）。
ALLOWED_MENTIONS = frozenset({"src/shared/store/agentStore.ts"})

# 写路径唯一出口：API 层。
API_LAYER = "src/features/agent/api/agentApi.ts"
WRITE_CALL = re.compile(r"""invoke(?:<[^>]*>)?\(\s*['"](?:add_agent|remove_agent)['"]""")

# 终端取 agent 的命令来源（唯一）。
TERMINAL_FILES = (
    "src/features/terminal/components/terminalCache.ts",
    "src/features/terminal/components/TerminalViewBase.tsx",
)
DIRECT_SNAPSHOT = re.compile(r"getState\(\)\s*\.\s*byId\s*\(")

# 组件测试里做源码扫描不算「消费」，跳过 —— 它们校验的正是本护栏的判据本身。
TEST_MARKER = "__tests__/"

GUARD = Guard(
    id="check_agent_config_single_source",
    title="Agent 配置单一数据源：前端不得持有 agent 配置副本",
    scopes=SCOPES,
    red_lines=(),
    docs=".trellis/spec/frontend/state-management.md",
    fix_hint=(
        "读：`useAgentStore((s) => s.agents)` / `resolveAgent(id)`；"
        "写：只经 `saveAgent` / `resetAgent`（内部落盘 + 刷新缓存）。"
        "「是否被覆盖」由后端 `AgentConfig.is_overridden` 回答，不要自己存键集合。"
    ),
)


def check(ctx: Context) -> GuardResult:
    files = sorted({p for scope in SCOPES for p in ctx.glob(scope)})
    findings: list[Finding] = []

    for path in files:
        rel = ctx.rel(path)
        if TEST_MARKER in rel:
            continue
        text = ctx.read(rel)

        # 1) 副本标识符不得出现
        if rel not in ALLOWED_MENTIONS:
            for ident in FORBIDDEN_IDENTIFIERS:
                if ident in text:
                    findings.append(
                        Finding(
                            f"前端持有 agent 配置副本 `{ident}` —— 数据源必须唯一"
                            "（后端 AgentManager），前端只读 agentStore",
                            rel,
                            text.count("\n", 0, text.index(ident)) + 1,
                        )
                    )

        # 2) 写路径只有 API 层
        if rel != API_LAYER and WRITE_CALL.search(text):
            findings.append(
                Finding(
                    "直接 invoke add_agent/remove_agent 会绕过 `saveAgent`/`resetAgent`，"
                    "缓存不刷新 ⇒ 界面停留在旧值",
                    rel,
                    text.count("\n", 0, WRITE_CALL.search(text).start()) + 1,
                )
            )

        # 3) 终端取命令必须经 resolveAgent
        if rel in TERMINAL_FILES:
            m = DIRECT_SNAPSHOT.search(text)
            if m:
                findings.append(
                    Finding(
                        "终端直接查快照 `getState().byId(...)` 会把「尚未加载」误判成"
                        "「agent 不存在」⇒ 空终端。改用 `resolveAgent(id)`",
                        rel,
                        text.count("\n", 0, m.start()) + 1,
                    )
                )

    metrics = f"{len(files)} 个 ts/tsx / 违规 {len(findings)}"
    if findings:
        return GuardResult.violated(len(files), findings, metrics=metrics)
    return GuardResult.passed(len(files), metrics=metrics)
