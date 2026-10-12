use super::sync::begin_git_run;
use crate::common::git::operations;
use crate::common::git::path_guard::validate_repo_relative_paths;
use crate::common::git::WorkspaceSession;
use crate::project::types::CommitResult;
use crate::AppError;
use crate::AppStateWrapper;
use tauri::{AppHandle, State};

/// Commit specific files with a message.
#[tauri::command]
pub async fn commit_files(
    workspace: WorkspaceSession,
    file_paths: Vec<String>,
    message: String,
    console_run_id: Option<String>,
    state: State<'_, AppStateWrapper>,
    app_handle: AppHandle,
) -> Result<CommitResult, AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    let repo_path = repo.root();
    validate_repo_relative_paths(&t, repo_path, &file_paths)?;
    let (hooks, _slot) = begin_git_run(&state, &repo, &app_handle, console_run_id.as_deref())?;
    let result = operations::commit_files(&t, repo_path, &file_paths, &message, hooks)
        .await
        .map_err(AppError::from)?;
    // 写成功后让**该单元**的快照落地再返回（spec/backend/git-domain.md §10）
    crate::git::services::status::wait_status_fresh(&state, &repo).await;
    Ok(result)
}

/// Cherry-pick a commit.
#[tauri::command]
pub async fn cherry_pick(
    workspace: WorkspaceSession,
    commit_hash: String,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    operations::cherry_pick(&t, repo.root(), &commit_hash)
        .await
        .map_err(AppError::from)?;
    // cherry-pick 改 HEAD 与工作树 ⇒ 被写入的那个单元的快照必须落地后再返回，
    // 否则前端立刻重读拿到的还是写前数据（「操作成功但列表要手动刷新」同因）。
    // 本命令按 WorkspaceSession 寻址，戳的就是被写入的那个单元（§10）。
    crate::git::services::status::wait_status_fresh(&state, &repo).await;
    Ok(())
}

/// Revert a commit.
#[tauri::command]
pub async fn revert(
    workspace: WorkspaceSession,
    commit_hash: String,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    operations::revert(&t, repo.root(), &commit_hash)
        .await
        .map_err(AppError::from)?;
    crate::git::services::status::wait_status_fresh(&state, &repo).await;
    Ok(())
}

/// Create a Git tag.
#[tauri::command]
pub async fn create_tag(
    workspace: WorkspaceSession,
    name: String,
    message: String,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    operations::create_tag(&t, repo.root(), &name, &message)
        .await
        .map_err(AppError::from)
}
