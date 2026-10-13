"""终端 / 任务运行根必须由 Workspace 身份派生（后端唯一解析 + 三环境同构 + 前端零裸 project 运行根）。

## 第一性原理

一次终端 / 任务进程启动的真值依赖是 `(Workspace, 启动意图)`，其中运行根 cwd 是 Workspace 的
纯函数：

    cwd(session) = session.worktreePath ?? project.path ≡ repo.root()

历史三处失真（与 10-12 终端键、2026-09-26 git status 同构）：

| 失真 | 形态 | 后果 | 判据 |
| --- | --- | --- | --- |
| **身份是 project 级** | `create_terminal_session(project_id, …, working_dir)` | cwd 靠前端传不透明串，worktree 维度丢失 | **G1** |
| **缺省静默回落主仓** | `working_dir.unwrap_or(project_path)` | worktree 视图命令实际在主仓执行 | **G2** |
| **前端自算运行根** | `workingDir: activeProject.path` / `cwd: activeProject.path` | 前端持第二份运行根，WSL/Remote 白算 | **G3** |

## 判据（三条，均确定性可复现）

- **G1 后端身份**：`src-tauri/src/terminal/**` 内 `fn create_terminal_session` 必须带
  `workspace: …WorkspaceSession` 形参；带该形参的函数体内不得调 `resolve_project(`
  （那会丢 worktree 维度，与 `check_workspace_session_addressing` 的 A2 同形）。
- **G2 后端禁 fail-open**：`src-tauri/src/terminal/**` 不得出现 `unwrap_or(project_path)` /
  `unwrap_or(&project_path)`（主仓静默回落形态）。
- **G3 前端禁裸 project 运行根**：`src/features/terminal/**`、`src/features/task/**` 与
  `src/shared/store/taskStore.ts` 不得把 `activeProject.path` / `project.path` 作为终端
  `workingDir` / `cwd` 传入，也不得前端自算 `session.worktreePath ?? activeProject.…`。
- **G4 会话生命周期不得绕过 router**（同 defect family 的**拆除侧**）：`src-tauri/src/**` 生产代码
  不得对会话做 `terminal_router.local()` / `.remote()` 直连操作（`close*` / `resize` / `drain`）——
  绕过 owner 路由表会：① SSH 会话静默关不掉；② `owners` 登记永久泄漏（`take_owner` 不被调用）。
  唯一合法拆除入口是 `TerminalRouter::close_session`。豁免：`terminal/router.rs`（路由器自身）、
  `app_state.rs`（取 manager 实例注入字段，不操作会话）、`connection/commands.rs`（连接级探活/枚举，
  本来就只有远端管理器有该能力）。

> 豁免：测试文件（`__tests__` / `*.test.ts(x)` / `#[cfg(test)]` 所在文件按路径不判；Rust 测试
> 内联在源文件，故 G1/G2 只跳过整个测试文件）。
"""
from __future__ import annotations

import re

from guards.core.contract import Context, Finding, Guard, GuardResult

RS_SCOPES = (
    "src-tauri/src/terminal/**/*.rs",
    "src-tauri/src/task/**/*.rs",
    "src-tauri/src/project/**/*.rs",
    "src-tauri/src/connection/**/*.rs",
    "src-tauri/src/app_state.rs",
)
TS_SCOPES = (
    "src/features/terminal/**/*.ts",
    "src/features/terminal/**/*.tsx",
    "src/features/task/**/*.ts",
    "src/features/task/**/*.tsx",
    "src/shared/store/taskStore.ts",
)

# G1：命令身份必须收 WorkspaceSession（允许 `crate::common::git::WorkspaceSession` 全限定名）
WS_PARAM_RE = re.compile(r"\bworkspace\s*:\s*(?:[A-Za-z_]\w*::)*WorkspaceSession\b")
RESOLVE_PROJECT_RE = re.compile(r"\bresolve_project\s*\(")
# 函数边界：`pub async fn <name>(` 起，到下一个同类声明或文件尾
FN_START_RE = re.compile(r"^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)", re.M)

# G2：主仓静默回落形态（`working_dir.unwrap_or(project_path)`）
FAIL_OPEN_RE = re.compile(r"unwrap_or\s*\(\s*&?\s*project_path\s*\)")

# G3：把项目级 path 当终端 workingDir / 任务 cwd，或前端自算运行根
PROJECT_PATH = r"(?:activeProject\??\.path|project\.path)"
G3_PATTERNS = (
    re.compile(r"\bworkingDir\s*:\s*[^,;\n]*" + PROJECT_PATH),
    re.compile(r"\bcwd\s*:\s*[^,;\n]*" + PROJECT_PATH),
    re.compile(r"session\.worktreePath\s*\?\?\s*activeProject"),
)

# G4：绕过 owner 路由表直连某个后端做会话操作（SSH 关不掉 + owners 泄漏）。
# `register` / `take_owner` / `owner_of` 只在 router.rs 内部（已排除），故此处不判。
ROUTER_BYPASS_RE = re.compile(r"terminal_router\s*\.\s*(?:local|remote)\s*\(\s*\)\s*\.\s*\w*", re.S)
# 豁免：路由器自身（唯一合法的操作者）与只取 manager 实例/连接级能力的站点。
G4_EXEMPT_FILES = {
    "src-tauri/src/terminal/router.rs",
    "src-tauri/src/app_state.rs",
    "src-tauri/src/connection/commands.rs",
}

TEST_PATH_RE = re.compile(r"(^|/)(__tests__|tests)(/|$)|\.test\.(ts|tsx)$")


def _strip_line_comments(text: str) -> str:
    """把 `//` 到行尾替换为同长空格（保持偏移与行号）。

    注释里复述禁用字面量不构成违规（真调用才判）；保留 `scheme://` 这类 URL 形态。
    """
    out: list[str] = []
    for line in text.split("\n"):
        idx = line.find("//")
        if idx > 0 and line[idx - 1] == ":":
            out.append(line)
        elif idx >= 0:
            out.append(line[:idx] + " " * (len(line) - idx))
        else:
            out.append(line)
    return "\n".join(out)


def _is_test(rel: str) -> bool:
    return bool(TEST_PATH_RE.search(rel))


def _iter_functions(text: str):
    """按 `fn` 声明切出 `(name, 起始偏移, 结束偏移)`。"""
    matches = list(FN_START_RE.finditer(text))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        yield m.group(1), m.start(), end


GUARD = Guard(
    id="check_terminal_run_root",
    title="终端/任务运行根按 Workspace 寻址（后端唯一解析 / 禁 fail-open / 前端零裸 project 根 / 拆除走路由）",
    scopes=RS_SCOPES + TS_SCOPES,
    red_lines=(8, 10, 12),
    docs="docs/domain-model.md",
    fix_hint=(
        "后端：`create_terminal_session` 首参收 `workspace: WorkspaceSession`，内部经 "
        "`resolve_workspace_target(&workspace)` 解析出 `repo.root()` 作为缺省 cwd；"
        "前端：运行根由 `workspaceRootOf(activeWorkspaceSession(projectId).key, projectPath)` "
        "派生，不得把 `activeProject.path` 当 workingDir / cwd；后端拆除会话用 "
        "`terminal_router.close_session(&id)`，不得 `.local()` / `.remote()` 直连"
    ),
)


def check(ctx: Context) -> GuardResult:
    rs_files = sorted({p for scope in RS_SCOPES for p in ctx.glob(scope)})
    ts_files = sorted({p for scope in TS_SCOPES for p in ctx.glob(scope)})
    if not rs_files:
        return GuardResult.broken("在 src-tauri/src/terminal/** 下扫到 0 个文件 —— 口径失效", scanned=0)
    if not ts_files:
        return GuardResult.broken("在 terminal/task 前端作用域扫到 0 个文件 —— 口径失效", scanned=0)

    findings: list[Finding] = []
    command_seen = False

    # ── G1：命令身份 + 禁丢 worktree 维度；G2：禁 fail-open ────────────────
    for path in rs_files:
        rel = ctx.rel(path)
        if _is_test(rel):
            continue
        text = _strip_line_comments(ctx.read(rel))
        for m in FAIL_OPEN_RE.finditer(text):
            findings.append(
                Finding(
                    "终端运行根禁止静默回落主仓（`unwrap_or(project_path)`）："
                    "缺省必须来自 Workspace 身份（`repo.root()`）",
                    rel,
                    text.count("\n", 0, m.start()) + 1,
                )
            )
        for name, start, end in _iter_functions(text):
            body = text[start:end]
            if name != "create_terminal_session":
                continue
            command_seen = True
            if not WS_PARAM_RE.search(body):
                findings.append(
                    Finding(
                        "`create_terminal_session` 首参必须收 `workspace: WorkspaceSession`"
                        "（身份化，编译期阻止丢 worktree）",
                        rel,
                        text.count("\n", 0, start) + 1,
                    )
                )
            for m in RESOLVE_PROJECT_RE.finditer(body):
                findings.append(
                    Finding(
                        "收 `workspace` 却调 `resolve_project(`：会丢弃 worktree 维度；"
                        "用 `resolve_workspace_target(&workspace)`",
                        rel,
                        text.count("\n", 0, start + m.start()) + 1,
                    )
                )

    if not command_seen:
        return GuardResult.broken(
            "未在 src-tauri/src/terminal/** 找到 `fn create_terminal_session` —— 口径失效",
            scanned=len(rs_files),
        )

    # ── G3：前端禁裸 project 运行根 ───────────────────────────────────────
    for path in ts_files:
        rel = ctx.rel(path)
        if _is_test(rel):
            continue
        text = _strip_line_comments(ctx.read(rel))
        for pattern in G3_PATTERNS:
            for m in pattern.finditer(text):
                findings.append(
                    Finding(
                        "运行根不得用项目级 `activeProject.path` / `project.path`："
                        "任务侧用 `workspaceRootOf(activeWorkspaceSession(projectId).key, projectPath)`，"
                        "交互终端不传 cwd（后端从 session 派生）",
                        rel,
                        text.count("\n", 0, m.start()) + 1,
                    )
                )

    # ── G4：会话生命周期不得绕过 router 直连某个后端（SSH 关不掉 + owners 泄漏）────
    for path in rs_files:
        rel = ctx.rel(path)
        if _is_test(rel) or rel in G4_EXEMPT_FILES:
            continue
        text = _strip_line_comments(ctx.read(rel))
        for m in ROUTER_BYPASS_RE.finditer(text):
            findings.append(
                Finding(
                    "会话拆除/操作必须走 `TerminalRouter::close_session(...)`（按 owner 路由且释放登记）："
                    f"直连后端 {m.group(0).replace(chr(10), '')!r} 会漏关 SSH 会话并泄漏 owners",
                    rel,
                    text.count("\n", 0, m.start()) + 1,
                )
            )

    scanned = len(rs_files) + len(ts_files)
    metrics = f"Rust {len(rs_files)} / 前端 {len(ts_files)} 个文件 / 违规 {len(findings)}"
    if findings:
        return GuardResult.violated(scanned, findings, metrics=metrics)
    return GuardResult.passed(scanned, metrics=metrics)
