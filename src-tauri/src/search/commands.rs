//! Tauri command layer for content search.
//!
//! Kept thin per the command-layer rule: receives + validates args, resolves
//! the project target, registers cancellation, then delegates to the service.

use tauri::State;

use crate::app_state::AppStateWrapper;
use crate::common::error::AppError;
use crate::common::git::WorkspaceSession;
use crate::search::services;
use crate::search::types::{SearchCursor, SearchOptions, SearchPage};

/// Run a content search within a **Workspace**.
///
/// Args:
/// * `workspace` — 搜索地址（`{ projectId, worktreePath }`）。**根 = `WorkspaceRef::root()`**
///   （≡ `worktreePath ?? project.path`），与 file / terminal 域的运行根同一定义。
///   曾经本命令只收 `project_id` 并直取 `project.path`：linked worktree 被选中时
///   搜索仍扫主仓，而结果路径相对**主仓**根、点击打开时又相对**单元**根解析 ——
///   同一份结果列表里两种基准，点开会打到另一个对象（红线 12 违反形态）。
/// * `request_id` — monotonic id; a newer request with the same id cancels the
///   previous in-flight search (frontend increments per query change).
/// * `options` — mode / case / word / regex / include / exclude.
/// * `offset` / `limit` — pagination.
#[tauri::command]
pub async fn search_run(
    workspace: WorkspaceSession,
    query: String,
    request_id: String,
    options: Option<SearchOptions>,
    offset: Option<u32>,
    limit: Option<u32>,
    state: State<'_, AppStateWrapper>,
) -> Result<SearchPage, AppError> {
    let opts = options.unwrap_or_default();
    // `SearchPage.project_id` 是**元数据**（前端不参与寻址），与地址同源取出。
    let project_id = workspace.project_id.clone();
    if query.trim().is_empty() {
        return Ok(SearchPage {
            request_id,
            query,
            project_id,
            matches: Vec::new(),
            cursor: SearchCursor {
                offset: 0,
                total_pages: -1,
            },
            truncated: false,
        });
    }

    // 地址解析的唯一入口（红线 15）：环境与工作目录一次取齐，不再各自读项目表。
    let (target, repo) = state.resolve_workspace_target(&workspace).await?;
    let root_str = repo.root().to_string();

    let token = services::cancellations().begin(&request_id);
    let notified = token.notified();

    // Poll cancellation while the search runs; abort early if requested.
    let result = tokio::select! {
        _ = notified => {
            services::cancellations().end(&request_id);
            Err(AppError::InvalidInput(format!(
                "Search request '{request_id}' was superseded"
            )))
        }
        res = services::search(&target, &root_str, &query, &opts, offset.unwrap_or(0), limit, &request_id, &project_id) => {
            services::cancellations().end(&request_id);
            res
        }
    };
    result
}

/// Cancel an in-flight search by request id.
#[tauri::command]
pub async fn search_stop(request_id: String) -> Result<(), AppError> {
    services::cancellations().cancel(&request_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::types::SearchMode;

    #[test]
    fn empty_query_short_circuits_to_empty_page() {
        let page = SearchPage {
            request_id: "req-1".into(),
            query: String::new(),
            project_id: "p-1".into(),
            matches: Vec::new(),
            cursor: SearchCursor {
                offset: 0,
                total_pages: -1,
            },
            truncated: false,
        };
        assert!(page.matches.is_empty());
        assert!(!page.truncated);
    }

    #[test]
    fn options_default_serializes() {
        let opts = SearchOptions::default();
        let json = serde_json::to_string(&opts).unwrap();
        assert!(json.contains("\"mode\":\"Content\""));
    }

    #[test]
    fn options_file_name_mode_serializes() {
        let opts = SearchOptions {
            mode: SearchMode::FileName,
            ..Default::default()
        };
        let json = serde_json::to_string(&opts).unwrap();
        assert!(json.contains("\"mode\":\"FileName\""));
    }
}
