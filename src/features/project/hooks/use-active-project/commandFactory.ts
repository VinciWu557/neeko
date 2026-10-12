import {
  cherryPick,
  checkoutBranch,
  commitFiles,
  createBranch,
  createTag,
  deleteBranch,
  discardFiles,
  fetch,
  fetchWithCredentials,
  getAheadBehind,
  getChangedFilesDiffStats,
  getCommitDetail,
  getCommitFileDiff,
  getCommitFiles,
  getCommitLog,
  getFileDiff,
  getGitInfo,
  getStashFileDiff,
  getStashFiles,
  getStashList,
  getUntrackedFiles,
  getWorkspaceStatus,
  generateCommitMessage,
  pull,
  pullWithCredentials,
  push,
  pushWithCredentials,
  revert,
  stageFiles,
  stashApply,
  stashPop,
  unstageFiles,
} from '@/features/git/api/gitApi';
import type { ProjectCommands } from '@/shared/types/activeProject';
import type { WorkspaceSession } from '@/shared/utils/workspaceRef';

/**
 * ProjectCommands 工厂：把**激活 Workspace** 绑成一组零参 git 命令。
 *
 * **纯委托 `gitApi`**：本文件不再自建任何 `invoke`（历史上它有 34 个 invoke 副本，
 * 与 `gitApi` 是同一命令的两个调用点 —— 改 wire 要改两处，必然漂移）。
 * 委托后全前端只有 `gitApi.ts` 一个 invoke 面（护栏 `check_file_io_scope` 判据 A 的精神）。
 *
 * 地址是**构造时绑定**的 `WorkspaceSession`：调用方（`useActiveProject`）传入
 * `activeWorkspaceSession(activeProject.id)`，方法内部不再各自拼 projectId / worktreePath。
 */
export function createProjectCommands(workspace: WorkspaceSession): ProjectCommands {
  return {
    refreshGitInfo: () => getGitInfo(workspace),
    refreshWorkspaceStatus: () => getWorkspaceStatus(workspace),
    getAheadBehind: () => getAheadBehind(workspace),
    getChangedFilesDiffStats: () => getChangedFilesDiffStats(workspace),
    getFileDiff: (filePath, collapse) => getFileDiff(workspace, filePath, collapse),
    listUntrackedFiles: (dirPath) => getUntrackedFiles(workspace, dirPath),
    stageFiles: (filePaths) => stageFiles(workspace, filePaths),
    unstageFiles: (filePaths) => unstageFiles(workspace, filePaths),
    discardFiles: (filePaths) => discardFiles(workspace, filePaths),
    commitFiles: (filePaths, message, consoleRunId) =>
      commitFiles(workspace, filePaths, message, consoleRunId),
    fetch: (consoleRunId) => fetch(workspace, consoleRunId),
    pull: (consoleRunId) => pull(workspace, consoleRunId),
    push: (setUpstream, consoleRunId) => push(workspace, setUpstream, consoleRunId),
    fetchWithCredentials: (username, password, consoleRunId) =>
      fetchWithCredentials(workspace, username, password, consoleRunId),
    pullWithCredentials: (username, password, consoleRunId) =>
      pullWithCredentials(workspace, username, password, consoleRunId),
    pushWithCredentials: (setUpstream, username, password, consoleRunId) =>
      pushWithCredentials(workspace, setUpstream, username, password, consoleRunId),
    checkoutBranch: (branchName) => checkoutBranch(workspace, branchName),
    createBranch: (branchName, startPoint) =>
      createBranch(workspace, branchName, startPoint ?? null),
    deleteBranch: (branchName) => deleteBranch(workspace, branchName),
    getCommitLog: (count, skip) => getCommitLog(workspace, count, skip),
    getCommitDetail: (commitHash) => getCommitDetail(workspace, commitHash),
    getCommitFiles: (commitHash) => getCommitFiles(workspace, commitHash),
    getStashList: () => getStashList(workspace),
    getStashFiles: (selector) => getStashFiles(workspace, selector),
    getStashFileDiff: (selector, filePath, collapse) =>
      getStashFileDiff(workspace, selector, filePath, collapse),
    stashApply: (selector) => stashApply(workspace, selector),
    stashPop: (selector) => stashPop(workspace, selector),
    getCommitFileDiff: (commitHash, filePath, collapse) =>
      getCommitFileDiff(workspace, commitHash, filePath, collapse),
    cherryPick: (commitHash) => cherryPick(workspace, commitHash),
    revert: (commitHash) => revert(workspace, commitHash),
    createTag: (tagName, message) => createTag(workspace, tagName, message ?? ''),
    generateCommitMessage: (agentId, filePaths, agentCommandOverride) =>
      generateCommitMessage(workspace, agentId, agentCommandOverride ?? null, filePaths),
  };
}
