use crate::common::git::operations;
use crate::common::git::WorkspaceSession;
use crate::AppError;
use crate::AppStateWrapper;
use tauri::State;

/// Checkout a branch.
#[tauri::command]
pub async fn checkout_branch(
    workspace: WorkspaceSession,
    branch_name: String,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    operations::checkout_branch(&t, repo.root(), &branch_name)
        .await
        .map_err(AppError::from)?;
    // checkout 改 HEAD 与工作树 ⇒ 戳**被写入的那个单元**（§10：写命令按 Workspace 收口）。
    crate::git::services::status::wait_status_fresh(&state, &repo).await;
    Ok(())
}

/// Create a new branch.
#[tauri::command]
pub async fn create_branch(
    workspace: WorkspaceSession,
    branch_name: String,
    start_point: Option<String>,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    operations::create_branch(&t, repo.root(), &branch_name, start_point.as_deref())
        .await
        .map_err(AppError::from)
}

/// Delete a branch.
#[tauri::command]
pub async fn delete_branch(
    workspace: WorkspaceSession,
    branch_name: String,
    force: Option<bool>,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    operations::delete_branch(&t, repo.root(), &branch_name, force.unwrap_or(false))
        .await
        .map_err(AppError::from)
}

/// Rename a branch.
#[tauri::command]
pub async fn rename_branch(
    workspace: WorkspaceSession,
    old_name: String,
    new_name: String,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    operations::rename_branch(&t, repo.root(), &old_name, &new_name)
        .await
        .map_err(AppError::from)?;
    // 改的正是当前检出分支时，`.git/HEAD` 的目标 ref 变了 ⇒ 快照的 branch 字段跟着变。
    crate::git::services::status::wait_status_fresh(&state, &repo).await;
    Ok(())
}

/// Create and switch to a new branch.
#[tauri::command]
pub async fn create_and_switch_branch(
    workspace: WorkspaceSession,
    branch_name: String,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    operations::create_and_switch_branch(&t, repo.root(), &branch_name)
        .await
        .map_err(AppError::from)?;
    // 建并切 = HEAD 与工作树都变了，与 checkout_branch 同一收口契约（§10）。
    crate::git::services::status::wait_status_fresh(&state, &repo).await;
    Ok(())
}

/// Checkout a commit in detached HEAD state.
#[tauri::command]
pub async fn checkout_detached(
    workspace: WorkspaceSession,
    commit_hash: String,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    operations::checkout_detached(&t, repo.root(), &commit_hash)
        .await
        .map_err(AppError::from)?;
    crate::git::services::status::wait_status_fresh(&state, &repo).await;
    Ok(())
}
