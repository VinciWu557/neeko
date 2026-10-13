"""终端运行根护栏用例：G1 身份 / G2 禁 fail-open / G3 前端禁裸 project 根。"""
from __future__ import annotations

import unittest

from guards.checks import check_terminal_run_root as subject
from guards.core.contract import ERROR, PASS, VIOLATION
from guards.tests.support import context, make_repo, temp_repo

RS_COMMANDS = "src-tauri/src/terminal/commands.rs"
TS_STRATEGIES = "src/features/terminal/strategies/index.ts"
TS_TASK_STORE = "src/shared/store/taskStore.ts"
TS_OUT_OF_SCOPE = "src/features/git/components/CommitDialog.tsx"

CLEAN_RS = (
    "#[tauri::command]\n"
    "pub async fn create_terminal_session(\n"
    "    workspace: crate::common::git::WorkspaceSession,\n"
    "    state: State<'_, AppStateWrapper>,\n"
    ") -> Result<TerminalSession, AppError> {\n"
    "    let (_target, repo) = state.resolve_workspace_target(&workspace).await?;\n"
    "    let cwd = repo.root();\n"
    "    Ok(cwd)\n"
    "}\n"
)

CLEAN_TS = (
    "export function useTerminalStrategy() {\n"
    "  const created = createTerminalSession(session, cols, rows, null, null, null);\n"
    "  return created;\n"
    "}\n"
)


class TerminalRunRootTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_repo(self)

    def run_guard(self, files: dict):
        merged = dict(files)
        if not any(k.startswith("src-tauri/src/terminal/") for k in merged):
            merged[RS_COMMANDS] = CLEAN_RS
        if not any(
            k.startswith(
                ("src/features/terminal/", "src/features/task/", "src/shared/store/taskStore.ts")
            )
            for k in merged
        ):
            merged[TS_STRATEGIES] = CLEAN_TS
        make_repo(self.root, merged)
        return subject.check(context(self.root))

    # ── 正例 ──────────────────────────────────────────────────────────────
    def test_workspace_addressed_command_is_clean(self):
        result = self.run_guard({})
        self.assertEqual(result.verdict, PASS)

    def test_project_path_outside_scope_is_clean(self):
        result = self.run_guard(
            {TS_OUT_OF_SCOPE: "const x = { workingDir: activeProject.path };\n"}
        )
        self.assertEqual(result.verdict, PASS)

    # ── G4：会话拆除不得绕过 router（SSH 关不掉 + owners 泄漏）──────────
    def test_router_bypass_close_is_violation(self):
        result = self.run_guard(
            {
                "src-tauri/src/task/commands.rs": (
                    "pub fn stop_task(session_id: String, state: State<AppStateWrapper>) {\n"
                    "    state.terminal_router.local().close_session(&session_id);\n"
                    "}\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(
            any("close_session" in f.message for f in result.findings),
            f"findings={[f.message for f in result.findings]}",
        )

    def test_router_teardown_entry_is_clean(self):
        result = self.run_guard(
            {
                "src-tauri/src/task/commands.rs": (
                    "pub fn stop_task(session_id: String, state: State<AppStateWrapper>) {\n"
                    "    state.terminal_router.close_session(&session_id);\n"
                    "}\n"
                )
            }
        )
        self.assertEqual(result.verdict, PASS)

    def test_exempt_sites_do_not_fire(self):
        # 路由器自身 / 取 manager 实例 / 连接级能力：不判。
        result = self.run_guard(
            {
                RS_COMMANDS: CLEAN_RS,
                "src-tauri/src/terminal/router.rs": (
                    'pub fn x(r: &TerminalRouter) { r.local().close_session("a"); }\n'
                ),
                "src-tauri/src/app_state.rs": (
                    "let m = self.terminal_router.local().clone();\n"
                ),
                "src-tauri/src/connection/commands.rs": (
                    "state.terminal_router.remote().close_session(&id);\n"
                ),
            }
        )
        self.assertEqual(result.verdict, PASS)

    def test_test_files_are_exempt(self):
        result = self.run_guard(
            {
                "src/features/terminal/__tests__/foo.test.ts": (
                    "const x = { workingDir: activeProject.path };\n"
                )
            }
        )
        self.assertEqual(result.verdict, PASS)

    # ── G1：后端身份 ─────────────────────────────────────────────────────
    def test_missing_workspace_param_is_violation(self):
        result = self.run_guard(
            {
                RS_COMMANDS: (
                    "#[tauri::command]\n"
                    "pub async fn create_terminal_session(\n"
                    "    project_id: String,\n"
                    ") -> Result<TerminalSession, AppError> {\n"
                    "    let (_target, repo) = state.resolve_workspace_target(&workspace).await?;\n"
                    "    Ok(repo)\n"
                    "}\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("workspace: WorkspaceSession", result.findings[0].message)

    def test_resolve_project_inside_command_is_violation(self):
        result = self.run_guard(
            {
                RS_COMMANDS: (
                    "#[tauri::command]\n"
                    "pub async fn create_terminal_session(\n"
                    "    workspace: WorkspaceSession,\n"
                    ") -> Result<TerminalSession, AppError> {\n"
                    "    let (_t, path) = state.resolve_project(&workspace.project_id)?;\n"
                    "    Ok(path)\n"
                    "}\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("resolve_project", result.findings[0].message)

    # ── G2：后端禁 fail-open ─────────────────────────────────────────────
    def test_unwrap_or_project_path_is_violation(self):
        result = self.run_guard(
            {
                RS_COMMANDS: CLEAN_RS
                + (
                    "\npub fn create_session(\n"
                    "    project_path: &str,\n"
                    "    working_dir: Option<String>,\n"
                    ") -> String {\n"
                    "    let cwd = working_dir.as_deref().unwrap_or(project_path);\n"
                    "    cwd.to_string()\n"
                    "}\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("回落主仓", result.findings[0].message)

    # ── G3：前端禁裸 project 运行根 ──────────────────────────────────────
    def test_frontend_project_path_as_working_dir_is_violation(self):
        result = self.run_guard(
            {
                TS_STRATEGIES: (
                    "export const create = () =>\n"
                    "  invoke('create_terminal_session', { workspace, workingDir: activeProject.path });\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)
        self.assertIn("运行根", result.findings[0].message)

    def test_frontend_task_cwd_project_path_is_violation(self):
        result = self.run_guard(
            {
                TS_TASK_STORE: (
                    "export const runTask = () => startTaskProcess({ cwd: activeProject.path });\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)

    def test_frontend_selfcomputed_run_root_is_violation(self):
        result = self.run_guard(
            {
                TS_STRATEGIES: (
                    "export const p = session.worktreePath ?? activeProject.path;\n"
                )
            }
        )
        self.assertEqual(result.verdict, VIOLATION)

    # ── 反空转 ───────────────────────────────────────────────────────────
    def test_missing_command_is_broken(self):
        result = self.run_guard({RS_COMMANDS: "pub fn noop() {}\n"})
        self.assertEqual(result.verdict, ERROR)


if __name__ == "__main__":
    unittest.main()
