use crate::common::git::operations;
use crate::common::git::path_guard::validate_repo_relative_path;
use crate::common::git::types::DiffResult;
use crate::common::git::WorkspaceSession;
use crate::project::types::{
    AheadBehind, CommitDetail, CommitEntry, CommitFileChange, StashActionResult, StashEntry,
};
use crate::AppError;
use crate::AppStateWrapper;
use tauri::State;

/// Get the commit log.
#[tauri::command]
pub async fn get_commit_log(
    workspace: WorkspaceSession,
    count: usize,
    skip: Option<usize>,
    state: State<'_, AppStateWrapper>,
) -> Result<Vec<CommitEntry>, AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    operations::get_commit_log(&t, repo.root(), count, skip.unwrap_or(0))
        .await
        .map_err(AppError::from)
}

/// Get details for a specific commit.
#[tauri::command]
pub async fn get_commit_detail(
    workspace: WorkspaceSession,
    commit_hash: String,
    state: State<'_, AppStateWrapper>,
) -> Result<CommitDetail, AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    operations::get_commit_detail(&t, repo.root(), &commit_hash)
        .await
        .map_err(AppError::from)
}

/// Get files changed in a commit.
#[tauri::command]
pub async fn get_commit_files(
    workspace: WorkspaceSession,
    commit_hash: String,
    state: State<'_, AppStateWrapper>,
) -> Result<Vec<CommitFileChange>, AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    operations::get_commit_files(&t, repo.root(), &commit_hash)
        .await
        .map_err(AppError::from)
}

/// List stash entries.
#[tauri::command]
pub async fn get_stash_list(
    workspace: WorkspaceSession,
    state: State<'_, AppStateWrapper>,
) -> Result<Vec<StashEntry>, AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    let repo_path = repo.root();
    operations::get_stash_list(&t, repo_path)
        .await
        .map_err(AppError::from)
}

/// Get files changed in a stash entry.
#[tauri::command]
pub async fn get_stash_files(
    workspace: WorkspaceSession,
    selector: String,
    state: State<'_, AppStateWrapper>,
) -> Result<Vec<CommitFileChange>, AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    let repo_path = repo.root();
    operations::get_stash_files(&t, repo_path, &selector)
        .await
        .map_err(AppError::from)
}

/// Get the diff for a single file in a stash entry.
#[tauri::command]
pub async fn get_stash_file_diff(
    workspace: WorkspaceSession,
    selector: String,
    file_path: String,
    collapse: Option<bool>,
    state: State<'_, AppStateWrapper>,
) -> Result<DiffResult, AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    let repo_path = repo.root();
    operations::get_stash_file_diff(
        &t,
        repo_path,
        &selector,
        &file_path,
        collapse.unwrap_or(true),
    )
    .await
    .map_err(AppError::from)
}

/// Apply a stash entry to the working tree.
#[tauri::command]
pub async fn stash_apply(
    workspace: WorkspaceSession,
    selector: String,
    state: State<'_, AppStateWrapper>,
) -> Result<StashActionResult, AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    let repo_path = repo.root();
    let outcome = operations::stash_apply(&t, repo_path, &selector)
        .await
        .map_err(AppError::from)?;
    // stash 落回工作树 ⇒ 该单元 status 变了。本命令按 WorkspaceSession 寻址，戳的就是被写的单元。
    crate::git::services::status::wait_status_fresh(&state, &repo).await;
    Ok(outcome)
}

/// Pop (apply + drop) a stash entry.
#[tauri::command]
pub async fn stash_pop(
    workspace: WorkspaceSession,
    selector: String,
    state: State<'_, AppStateWrapper>,
) -> Result<StashActionResult, AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    let repo_path = repo.root();
    let outcome = operations::stash_pop(&t, repo_path, &selector)
        .await
        .map_err(AppError::from)?;
    // stash 落回工作树 ⇒ 该单元 status 变了。本命令按 WorkspaceSession 寻址，戳的就是被写的单元。
    crate::git::services::status::wait_status_fresh(&state, &repo).await;
    Ok(outcome)
}

/// Get the diff for a file in a commit.
#[tauri::command]
pub async fn get_commit_file_diff(
    workspace: WorkspaceSession,
    commit_hash: String,
    file_path: String,
    collapse: Option<bool>,
    state: State<'_, AppStateWrapper>,
) -> Result<DiffResult, AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    validate_repo_relative_path(&t, repo.root(), &file_path)?;
    operations::get_commit_file_diff(
        &t,
        repo.root(),
        &commit_hash,
        &file_path,
        collapse.unwrap_or(true),
    )
    .await
    .map_err(AppError::from)
}

/// Get ahead/behind counts for the current branch.
#[tauri::command]
pub async fn get_ahead_behind(
    workspace: WorkspaceSession,
    state: State<'_, AppStateWrapper>,
) -> Result<AheadBehind, AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    let repo_path = repo.root();
    operations::get_ahead_behind(&t, repo_path)
        .await
        .map_err(AppError::from)
}

/// Get the default branch name.
#[tauri::command]
pub async fn default_branch(
    workspace: WorkspaceSession,
    state: State<'_, AppStateWrapper>,
) -> Result<String, AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    operations::default_branch(&t, repo.root())
        .await
        .map_err(AppError::from)
}
