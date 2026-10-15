//! Git 冲突读取命令（红线 6：极薄，只做参数校验 + 调度）。

use crate::common::git::operations;
use crate::common::git::path_guard::validate_repo_relative_path;
use crate::common::git::workspace_ref::WorkspaceSession;
use crate::common::git::{ConflictResolution, ConflictStages};
use crate::AppError;
use crate::AppStateWrapper;
use tauri::State;

/// 读一个冲突文件的 index unmerged stages（三侧 + 区域）。
///
/// 契约：该 path 无 unmerged 条目时返回 `Err` —— 调用方据此回退普通 diff 视图
/// （「已解决」是正常收敛，不是错误态，R10）。
#[tauri::command]
pub async fn get_conflict_stages(
    workspace: WorkspaceSession,
    file_path: String,
    state: State<'_, AppStateWrapper>,
) -> Result<ConflictStages, AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    validate_repo_relative_path(&t, repo.root(), &file_path).map_err(AppError::from)?;
    operations::read_conflict_stages(&t, repo.root(), &file_path)
        .await
        .map_err(AppError::from)
}

/// 应用一处冲突决议（区域级 / 整文件级）。
///
/// 写回后调 `wait_status_fresh` 收口（git-domain §10）：不调它前端会立刻重读到写前数据。
/// 成功 = 该 path 退出 unmerged set，前端由快照事件驱动收敛回普通 diff（不是错误态）。
#[tauri::command]
pub async fn resolve_conflict(
    workspace: WorkspaceSession,
    file_path: String,
    resolution: ConflictResolution,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (t, repo) = state.resolve_workspace_target(&workspace).await?;
    validate_repo_relative_path(&t, repo.root(), &file_path).map_err(AppError::from)?;
    operations::apply_conflict_resolution(&t, repo.root(), &file_path, resolution)
        .await
        .map_err(AppError::from)?;
    crate::git::services::status::wait_status_fresh(&state, &repo).await;
    Ok(())
}
