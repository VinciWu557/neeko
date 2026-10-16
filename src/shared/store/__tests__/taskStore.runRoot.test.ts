// @vitest-environment node
/**
 * 运行根按 Workspace 寻址：`taskStore.runTask` 的缺省 cwd 由激活 Workspace 身份派生，
 * 不再用 `activeProject.path`。
 *
 * 症状回归：worktree 激活时点 Run Task，命令实际在主仓执行（污染主仓、产物落错位置）。
 * 修法：`activeWorkspaceSession(projectId)` → `workspaceRootOf(session.key, projectPath)`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockStart = vi.hoisted(() => vi.fn());
const mockStop = vi.hoisted(() => vi.fn());
const mockDiscover = vi.hoisted(() => vi.fn());
const mockImport = vi.hoisted(() => vi.fn());
const mockDeleteConfig = vi.hoisted(() => vi.fn());

vi.mock('@/features/task/taskRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/task/taskRunner')>();
  return {
    ...actual,
    startTaskProcess: (...args: unknown[]) => mockStart(...args),
    stopTaskProcess: (...args: unknown[]) => mockStop(...args),
  };
});

vi.mock('@/features/project/store', () => ({
  useProjectStore: {},
}));

vi.mock('@/shared/store/projectStore', () => ({
  useProjectStore: {
    getState: () => ({
      activeProject: { id: 'proj-1', path: '/tmp/proj', name: 'proj' },
    }),
  },
}));

vi.mock('@/shared/utils/bottomPanelExclusive', () => ({
  exclusiveOpenTaskConsole: vi.fn(),
  registerTaskConsoleCloser: vi.fn(),
}));

vi.mock('@/features/task/api/taskApi', () => ({
  getTaskConfigs: vi.fn().mockResolvedValue([]),
  saveTaskConfig: vi.fn(),
  deleteTaskConfig: (...args: unknown[]) => mockDeleteConfig(...args),
  discoverTaskConfigs: (...args: unknown[]) => mockDiscover(...args),
  importDiscoveredTask: (...args: unknown[]) => mockImport(...args),
}));

vi.mock('@/features/lsp/api/lspApi', () => ({
  lspGetServerLogs: vi.fn(),
}));

vi.mock('@/features/git/api/gitApi', () => ({
  cancelGitSync: vi.fn(),
}));

import { useTaskStore } from '@/shared/store/taskStore';
import { useWorkspaceStore } from '@/shared/store/workspaceStore';
import type { ProjectId } from '@/shared/utils/workspaceRef';

const PROJECT_ID = 'proj-1' as ProjectId;
const PROJECT_PATH = '/tmp/proj';
const WORKTREE_PATH = '/tmp/proj/.worktrees/dev';

function activateWorkspace(path: string | null) {
  useWorkspaceStore.getState().setActiveWorkspace(PROJECT_ID, path);
}

describe('taskStore.runTask — run root derived from Workspace identity', () => {
  beforeEach(() => {
    mockStart.mockReset();
    mockStop.mockReset();
    mockDiscover.mockReset().mockResolvedValue([]);
    mockImport.mockReset().mockResolvedValue({});
    mockDeleteConfig.mockReset().mockResolvedValue(undefined);
    mockStart.mockResolvedValue({ processId: 'pty-1', dispose: vi.fn() });
    mockStop.mockResolvedValue(undefined);
    useWorkspaceStore.setState({ byProject: {} });
    useTaskStore.setState({
      configs: [],
      discovered: [],
      discovering: false,
      selectedConfigId: null,
      consolePanelOpen: false,
      consoleSessions: [],
      activeConsoleId: null,
    });
  });

  it('should_default_cwd_to_worktree_root_when_worktree_active', async () => {
    activateWorkspace(WORKTREE_PATH);

    useTaskStore.getState().runTask('pnpm build', 'cfg-build');
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1));

    const opts = mockStart.mock.calls[0][0];
    // 缺省 cwd = 激活 Workspace 的运行根（工作树路径），**不是** activeProject.path。
    expect(opts.cwd).toBe(WORKTREE_PATH);
    expect(opts.cwd).not.toBe(PROJECT_PATH);
    // session 透传给后端（运行根权威来源）。
    expect(opts.workspace.worktreePath).toBe(WORKTREE_PATH);
    // 展示 / git console id 同源记录工作树根。
    expect(useTaskStore.getState().consoleSessions[0].projectPath).toBe(WORKTREE_PATH);
  });

  it('should_default_cwd_to_project_root_in_main_checkout', async () => {
    activateWorkspace(null);

    useTaskStore.getState().runTask('pnpm build', 'cfg-build');
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1));

    const opts = mockStart.mock.calls[0][0];
    expect(opts.cwd).toBe(PROJECT_PATH);
    expect(opts.workspace.worktreePath).toBeNull();
    expect(useTaskStore.getState().consoleSessions[0].projectPath).toBe(PROJECT_PATH);
  });

  it('should_let_language_runner_cwd_override_win_over_workspace_root', async () => {
    activateWorkspace(WORKTREE_PATH);

    useTaskStore
      .getState()
      .runTask('gradle test', 'cfg-java', { cwd: `${WORKTREE_PATH}/module-a` });
    await vi.waitFor(() => expect(mockStart).toHaveBeenCalledTimes(1));

    const opts = mockStart.mock.calls[0][0];
    expect(opts.cwd).toBe(`${WORKTREE_PATH}/module-a`);
    // 覆盖不改变 session 透传（后端仍按工作区根做 within-root 校验）。
    expect(opts.workspace.worktreePath).toBe(WORKTREE_PATH);
  });

  // ── 发现根与存储根分离（Q2）：mutator 后的发现刷新不得回落项目根 ──────────
  it('should_discover_from_workspace_root_after_import_in_worktree', async () => {
    activateWorkspace(WORKTREE_PATH);
    const task = {
      id: 'disc-1',
      name: 'build',
      command: 'pnpm build',
      source: 'npm',
      group: 'npm',
      priority: 1,
    };

    await useTaskStore.getState().importDiscovered(task, PROJECT_PATH, PROJECT_ID, WORKTREE_PATH);

    // 存储落项目根，发现刷新仍用工作树根（否则 worktree 的发现列表被主仓覆盖）。
    expect(mockImport).toHaveBeenCalledWith(task, PROJECT_PATH, PROJECT_ID);
    expect(mockDiscover).toHaveBeenCalledWith(WORKTREE_PATH);
    expect(mockDiscover).not.toHaveBeenCalledWith(PROJECT_PATH);
  });

  it('should_discover_from_workspace_root_after_delete_in_worktree', async () => {
    activateWorkspace(WORKTREE_PATH);

    await useTaskStore.getState().deleteConfig('cfg-x', 'project', PROJECT_PATH, WORKTREE_PATH);

    expect(mockDeleteConfig).toHaveBeenCalledWith('cfg-x', 'project', PROJECT_PATH);
    expect(mockDiscover).toHaveBeenCalledWith(WORKTREE_PATH);
    expect(mockDiscover).not.toHaveBeenCalledWith(PROJECT_PATH);
  });
});
