"""git 命令寻址必须是 `WorkspaceSession` 值对象（后端唯一入口 + 前端禁散签 + 禁手搓字面量）。

## 第一性原理

一次 git 操作的真值依赖是 `(Workspace, 操作)`。地址信息的保真度决定正确性，
当前架构在三处让它失真，本护栏逐条钉住：

| 失真 | 形态 | 后果 | 判据 |
| --- | --- | --- | --- |
| **可手搓** | 前端 `worktreePath?: string \\| null` 可选散参 | 漏传 → 静默按主仓执行 | **B** |
| **可拆分** | 后端 `(project_id, worktree_path)` 两个 wire 字段 | 两字段可独立缺失/错配 | **签名**（收单 `workspace` 对象，AC2 + 类型检查；半用对象由 **A2** 兜底） |
| **可绕过** | 命令层直调 `resolve_workspace(&str, Option<&str>)` | 解析逻辑两个外观 | **A** |
| **半迁移** | 签名收了 `workspace`，却仍从 `get_project(...).path` 取根 | worktree 视图扫主仓（签名看着对） | **D** |

与前置任务 `10-09-file-io-workspace-scope` 的 `check_file_io_scope` 互补：那条管**文件 IO**的
唯一命令面与旧编码，本条管**命令层**的地址形态（不限 git 域 —— file / terminal / search 同理）。
两者的 B 判据作用域不同（那条管 `rootPath` 退役，本条管 `gitApi.ts` 的 `worktreePath` 散签），
不重叠。

## 判据（四条，均确定性可复现）

- **A1 后端唯一解析入口（无条件）**：命令层（`src-tauri/src/**/commands*.rs` 与
  `**/commands/**/*.rs`，扣除 `RS_EXEMPT_DIRS`）内不得直调 `resolve_workspace(`
  （唯一入口是 `resolve_workspace_target(&workspace)`）。
  收口完成后已无 `worktree_path: Option<String>` 散参，旧的"函数带散参形参才判"前置会永真空
  （2026-10-12 实证：history/commit 8 个命令收了 `workspace` 却走 `resolve_project`，护栏盲区）——
  故不设前置，字面零命中（AC3）。
- **A2 收对象必须真用对象**：带 `workspace: WorkspaceSession` 形参的命令不得调 `resolve_project(`
  （那会丢弃 worktree 维度，worktree 视图静默按主仓执行；写命令再配 `wait_main_status_fresh`
  就是戳错单元，违反 git-domain §10）。无 `workspace` 形参的命令（`canonical_worktree_path` /
  `is_git_repo` / worktree 目标型 ops）走 `resolve_project` 合法，不判。
- **B 前端禁散签**：`gitApi.ts` 内不得保留 `worktreePath` **形参**（迁移后地址是首参
  `workspace: WorkspaceSession`；内部 `const { projectId, worktreePath } = workspace`
  的解构行是唯一合法出现处）。
  **豁免 C 类命令**：`createWorktree` / `removeWorktree` / `renameWorktree` / `isWorktreeDirty`
  的 `worktreePath` 是**被操作的目标**（worktree 名/路径），不是寻址散参（design.md §2.3 例外）。
- **C 前端禁伪造地址**：`src/**` 生产代码不得把字面量**断言/标注成** `WorkspaceSession`
  （`{ projectId, worktreePath } as WorkspaceSession`、`: WorkspaceSession = { … }`）——
  class 私有构造已挡住直接 `new`，这两种是仅剩的绕过形态。
- **D 收了地址就不得再按 project 取根（半迁移态）**：函数带 `workspace: WorkspaceSession` 形参，
  却仍 `get_project( … )` 取 `project.path` 当工作目录 —— 签名看着对（A2 过），但它把**另一个**
  根交给了下游（worktree 视图扫主仓）。2026-10-13 的 `search/commands.rs` 正是此形（旧形态
  `search_run` 无`workspace` 形参，与 `set_active_project` 这类**合法的 project 级命令**语法同形，
  无法用静态规则区分 —— 故本判据只钉「已收地址却还用另一个根」这个**可判定**的子集）。

> **为何不拦裸 `{ projectId, worktreePath }`**：该形态在 `commandFactory.ts` 里是**合法 wire 载荷**
> （`invoke('stage_files', { projectId, worktreePath })`，由 `gitApi` 内部解构产生），与「手搓地址」
> 在语法上同形、语义上相反。用正则区分二者无稳定指纹（spec 结论：无稳定指纹时不硬上静态检查），
> 故只拦**带类型意图**的两形 —— 那才是"我要造一个 session"的明确表达。

> 豁免：`shared/utils/workspaceRef.ts`（值对象自身，字面量出现在 JSDoc 说明里）、
> 测试文件（`__tests__` / `.test.ts` / `tests/`）与 `#[cfg(test)]`。
"""
from __future__ import annotations

import re

from guards.core.contract import Context, Finding, Guard, GuardResult

TS_SCOPES = ("src/**/*.ts", "src/**/*.tsx")
# 后端域：不限于 git —— 「在哪个 Workspace 执行」是**跨域**不变量（file / terminal / search …）。
# 曾仅扫 `git/commands/**` + `agent/commands_commit.rs`，search 域的同类缺陷因此**不可见**
# （2026-10-13 实证：`search_run` 直取 `project.path` 作搜索根，三重基准错位）。
RS_SCOPES = (
    "src-tauri/src/**/commands*.rs",
    "src-tauri/src/**/commands/**/*.rs",
)

# 非「在一个 Workspace 里执行」的域：它们按 project 或全局概念工作，不适用本护栏。
# （保留目录形式以便新增域时显式决定，而不是静默被扫。）
RS_EXEMPT_DIRS = (
    "src-tauri/src/project/",  # 项目管理本身（set_active_project / primary_language …）
    "src-tauri/src/library/",  # 资源库（按 project 绑定的 skill / prompt 安装）
    "src-tauri/src/app/",  # 组合根（启动 / 关闭协议）
    "src-tauri/src/about/",  # 版本信息
)

# D：收了 `workspace` 却仍从 `get_project(...).path` 取根（半迁移态）
GET_PROJECT_RE = re.compile(r"\bget_project\s*\(")
PROJECT_PATH_RE = re.compile(r"\bproject\.path\b|\bp\.path\b")

# A1：后端直调旧解析入口（`resolve_workspace_target` 是合法入口，负向查断言它不在）
RESOLVE_DIRECT_RE = re.compile(r"(?<!_target)\bresolve_workspace\s*\(")
# A2：收了 workspace 却只按 project 解析（丢弃 worktree 维度）
WS_PARAM_RE = re.compile(r"\bworkspace\s*:\s*WorkspaceSession\b")
RESOLVE_PROJECT_RE = re.compile(r"\bresolve_project\s*\(")
# 函数边界：`pub async fn <name>(` 起，到下一个同类声明或文件尾
FN_START_RE = re.compile(r"^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+\w+", re.M)

# B：gitApi 的 worktreePath 形参（`worktreePath?: string | null` / `worktreePath: string | null`）
# 解构行（`const { projectId, worktreePath } = workspace`）不是形参，用 `?`/`:` 后的类型标注区分。
# 豁免 C 类命令：它们的 `worktreePath` 是**被操作的目标**（worktree 名/路径），不是寻址散参。
# `activateWorkspace` 旧属此表，现已改为 A 类（收 `workspace: WorkspaceSession`）。
B_EXEMPT_FNS = {"createWorktree", "removeWorktree", "renameWorktree", "isWorktreeDirty"}
GIT_API_FILE = "src/features/git/api/gitApi.ts"
WORKTREE_PARAM_RE = re.compile(r"\bworktreePath\s*\??\s*:\s*(?:string|WorkspaceSession)")

# C：伪造地址（把字面量断言 / 标注成 WorkspaceSession）
# 只拦带**类型意图**的两形；裸 `{ projectId, worktreePath }` 是合法 wire 载荷（gitApi 内部解构产出），
# 与手搓地址语法同形、语义相反，无稳定指纹可区分（见模块 docstring）。
FORGED_CAST_RE = re.compile(r"\{\s*projectId\s*:?[^}]*?worktreePath[^}]*?\}\s*as\s+WorkspaceSession")
FORGED_ANNOTATION_RE = re.compile(r":\s*WorkspaceSession\s*=\s*\{[^}]*?projectId")

# C 的豁免文件：值对象自身（JSDoc 里以字面量说明 wire 形态）
C_EXEMPT_FILES = {"src/shared/utils/workspaceRef.ts"}

# 测试域豁免（与 check_command_execution 同口径）
TEST_PATH_RE = re.compile(r"(^|/)(__tests__|tests)(/|$)|\.test\.(ts|tsx)$|_test\.rs$|/tests\.rs$")


def _is_test(rel: str) -> bool:
    return bool(TEST_PATH_RE.search(rel))


def _is_exempt_dir(rel: str) -> bool:
    """非「在一个 Workspace 里执行」的域（见 `RS_EXEMPT_DIRS` 注释）。"""
    return rel.startswith(RS_EXEMPT_DIRS)


GUARD = Guard(
    id="check_workspace_session_addressing",
    title="按 WorkspaceSession 寻址（后端唯一解析入口 / 前端禁散签 / 禁手搓地址）",
    scopes=TS_SCOPES + RS_SCOPES,
    red_lines=(12,),
    docs="docs/domain-model.md",
    fix_hint=(
        "后端：`state.resolve_workspace_target(&workspace).await?`（勿直调 resolve_workspace）；"
        "前端：gitApi 首参收 `workspace: WorkspaceSession`，地址由 activeWorkspaceSession / "
        "WorkspaceSession.of / fromKey 构造，禁止手搓 { projectId, worktreePath }"
    ),
)


def _iter_functions(text: str):
    """按 `fn` 声明切出 `(起始偏移, 结束偏移)`，供函数级判据使用。"""
    starts = [m.start() for m in FN_START_RE.finditer(text)]
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(text)
        yield start, end


def _owning_function(text: str, pos: int) -> str | None:
    """TS 侧：偏移 `pos` 所属的 `export function <name>` 名（找不到返回 None）。"""
    owner = None
    for m in re.finditer(r"export (?:async )?function (\w+)\(", text):
        if m.start() > pos:
            break
        owner = m.group(1)
    return owner


def check(ctx: Context) -> GuardResult:
    ts_files = sorted({p for scope in TS_SCOPES for p in ctx.glob(scope)})
    # `mod.rs` 只允许声明 + re-export（红线 9），不可能承载命令体 —— 排除，免得它们充数。
    rs_files = sorted(
        p for scope in RS_SCOPES for p in ctx.glob(scope) if p.name != "mod.rs"
    )
    if not ts_files:
        return GuardResult.broken("在 src/**/*.{ts,tsx} 下扫到 0 个文件 —— 口径失效", scanned=0)
    if not rs_files:
        return GuardResult.broken(
            "在 src-tauri/src/**/commands*.rs 下扫到 0 个文件 —— 口径失效", scanned=0
        )

    findings: list[Finding] = []

    # ── A1：后端唯一解析入口（无条件：命令层不得直调旧入口，AC3 字面零命中）
    # ── A2：收 workspace 的命令不得只按 project 解析（丢 worktree 维度，§10 戳错单元）
    # ── D ：收了地址却仍从 `get_project(...).path` 取根（半迁移态）
    for path in rs_files:
        rel = ctx.rel(path)
        if _is_test(rel) or _is_exempt_dir(rel):
            continue
        text = ctx.read(rel)
        for start, end in _iter_functions(text):
            body = text[start:end]
            for m in RESOLVE_DIRECT_RE.finditer(body):
                findings.append(
                    Finding(
                        "命令层不得直调 `resolve_workspace(`：唯一入口是 "
                        f"`resolve_workspace_target(&workspace)`；直调 {m.group(0)!r} "
                        "会让解析逻辑存在两个外观",
                        rel,
                        text.count("\n", 0, start + m.start()) + 1,
                    )
                )
            if WS_PARAM_RE.search(body):
                for m in RESOLVE_PROJECT_RE.finditer(body):
                    findings.append(
                        Finding(
                            "收 `workspace: WorkspaceSession` 却调 `resolve_project(`："
                            "会丢弃 worktree 维度（worktree 视图静默按主仓执行）；"
                            "用 `resolve_workspace_target(&workspace)`",
                            rel,
                            text.count("\n", 0, start + m.start()) + 1,
                        )
                    )
                # D：收了地址却仍从 `get_project(...).path` 取根（半迁移态）。
                # 两个信号**同时**出现才算：只有 `get_project(` 可能只是读元数据（名称 / 环境），
                # 只有 `.path` 也可能是无关字段 —— 合起来才是「用项目路径当工作目录」。
                if GET_PROJECT_RE.search(body) and PROJECT_PATH_RE.search(body):
                    for m in GET_PROJECT_RE.finditer(body):
                        findings.append(
                            Finding(
                                "收 `workspace: WorkspaceSession` 却仍从 `get_project(...).path` "
                                "取工作目录：那会把**另一个**根交给下游（worktree 视图扫主仓）；"
                                "根唯一来源是 `resolve_workspace_target(&workspace)` → `repo.root()`",
                                rel,
                                text.count("\n", 0, start + m.start()) + 1,
                            )
                        )

    # ── B：前端禁散签（只查 gitApi.ts 的形参；C 类命令的 worktreePath 是被操作目标，豁免）
    for path in ts_files:
        rel = ctx.rel(path)
        if rel != GIT_API_FILE or _is_test(rel):
            continue
        text = ctx.read(rel)
        # 逐函数：C 类函数体内的形参不判
        for m in WORKTREE_PARAM_RE.finditer(text):
            owner = _owning_function(text, m.start())
            if owner in B_EXEMPT_FNS:
                continue
            findings.append(
                Finding(
                    f"旧散参形参 {m.group(0)!r} 已退役：gitApi 首参改为 "
                    "`workspace: WorkspaceSession`（内部解构取 worktreePath）",
                    rel,
                    text.count("\n", 0, m.start()) + 1,
                )
            )

    # ── C：前端禁伪造地址
    for path in ts_files:
        rel = ctx.rel(path)
        if _is_test(rel) or rel in C_EXEMPT_FILES:
            continue
        text = ctx.read(rel)
        for m in FORGED_CAST_RE.finditer(text):
            findings.append(
                Finding(
                    "不得把字面量 `as WorkspaceSession` 伪造地址："
                    "用 activeWorkspaceSession / WorkspaceSession.of / fromKey 构造",
                    rel,
                    text.count("\n", 0, m.start()) + 1,
                )
            )
        for m in FORGED_ANNOTATION_RE.finditer(text):
            findings.append(
                Finding(
                    "不得用类型标注把字面量写成 WorkspaceSession："
                    "用 activeWorkspaceSession / WorkspaceSession.of / fromKey 构造",
                    rel,
                    text.count("\n", 0, m.start()) + 1,
                )
            )

    metrics = f"后端 {len(rs_files)} / 前端 {len(ts_files)} 个文件 / 违规 {len(findings)}"
    if findings:
        return GuardResult.violated(len(ts_files) + len(rs_files), findings, metrics=metrics)
    return GuardResult.passed(len(ts_files) + len(rs_files), metrics=metrics)
