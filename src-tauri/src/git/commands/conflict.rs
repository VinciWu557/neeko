//! Git 冲突读取命令（红线 6：极薄，只做参数校验 + 调度）。

use crate::common::git::operations;
use crate::common::git::path_guard::validate_repo_relative_path;
use crate::common::git::workspace_ref::WorkspaceSession;
use crate::common::git::ConflictStages;
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
