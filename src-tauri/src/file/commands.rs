use crate::common::git::WorkspaceSession;
use crate::platform::reveal::{build_reveal_command, normalize_path};
use crate::project::types::FileContent;
use crate::AppError;
use crate::AppStateWrapper;
use std::path::Path;
use tauri::State;

// ── Opener Command ───────────────────────────────────────────────────────────

/// 在系统文件管理器中打开或 reveal 指定路径
#[tauri::command]
pub fn reveal_in_file_manager(path: String) -> Result<(), AppError> {
    let normalized = normalize_path(&path);
    let path = Path::new(&normalized);

    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "Path does not exist: {}",
            normalized
        )));
    }

    if let Some(mut cmd) = build_reveal_command(path) {
        cmd.spawn()
            .map_err(|e| AppError::Io(format!("Failed to reveal in file manager: {}", e)))?;
    }

    Ok(())
}
// ── Existence probe ──────────────────────────────────────────────────────────

/// 存在性探测（O(1) stat，不读内容）：任务命令构造等前端逻辑用，返回 bool
/// 而非 NotFound 错误。仅元数据访问，无内容泄露面。
#[tauri::command]
pub fn file_exists(path: String) -> Result<bool, AppError> {
    Ok(Path::new(&normalize_path(&path)).exists())
}

// ── File operations ──────────────────────────────────────────────────────────
//
// **按 Workspace 寻址**：每个文件命令的地址是一个 [`WorkspaceSession`]（`worktree_path = None` =
// 主 checkout），由 `AppStateWrapper::resolve_workspace_target` **唯一解析**为
// `(执行环境, WorkspaceRef)`；工作树根取 `WorkspaceRef::root()`（宿主形态）—— 与 git 的 `-C`、
// watcher 挂载根、gitignore 过滤器同源。不再有「任意 root 路径」参数，也不再有各自拼
// `project_id` + `root_path` 的散参。

/// Read the directory tree.
#[tauri::command]
pub async fn read_dir_tree(
    workspace: WorkspaceSession,
    sub_path: Option<String>,
    max_depth: Option<u32>,
    state: State<'_, AppStateWrapper>,
) -> Result<crate::common::file::services::DirTreeResult, AppError> {
    // 深度常量单一事实源：crate::common::file::services::DEFAULT_TREE_DEPTH
    let depth = max_depth.unwrap_or(crate::common::file::services::DEFAULT_TREE_DEPTH);
    let (target, repo) = state.resolve_workspace_target(&workspace).await?;
    let base = repo.root();
    // S5：gitignore 语义由 watcher 的分层过滤器原生提供（读前剪枝 + ignored 标记），
    // 前端 ignored_files 平行数组退役。watcher 未挂载（切换项目时首载与 watch
    // 并发的 race）→ resolve_gitignore_filter 现场构建兜底，保证首屏即带 ignored
    // 标注；非 git 项目 → None（仅 .git 硬过滤）。
    // 过滤器按**Workspace**取：主仓与 worktree 的 .gitignore 规则链不同（各自工作树根
    // + 各自 gitdir 的 exclude）。
    //
    // base 与 gitignore 单元来自**同一个** WorkspaceRef（一次解析）—— 归一含
    // `exists` / `canonicalize`（阻塞 fs），经 `resolve_workspace_target` 内部隔离到阻塞池（红线 3）。
    //
    // 用户排除模式读 config.json 是阻塞 I/O（红线 3）→ 经阻塞池；且只有 Local 目标会消费
    // （远程 ignored 走远程 `git ls-files`），远程/非 git 无需读。
    let user_excludes = if matches!(target, crate::common::executor::factory::ExecTarget::Local) {
        let watcher_manager = state.watcher_manager.clone();
        tokio::task::spawn_blocking(move || watcher_manager.watcher_excludes())
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let gitignore = crate::common::file::services::resolve_gitignore_filter(
        &target,
        state.watcher_manager.gitignore_for(&repo),
        Path::new(base),
        &user_excludes,
    )
    .await;
    crate::common::file::services::read_dir_tree(
        repo.project_id(),
        &target,
        base,
        sub_path.as_deref(),
        depth,
        gitignore.as_deref(),
    )
    .await
}

/// Read file content.
#[tauri::command]
pub async fn read_file_content(
    workspace: WorkspaceSession,
    file_path: String,
    state: State<'_, AppStateWrapper>,
) -> Result<FileContent, AppError> {
    let (target, ws) = state.resolve_workspace_target(&workspace).await?;
    let base = ws.root();
    crate::common::file::reader::read_file(
        crate::common::file::reader::FileAccessScope::InProject {
            root: std::path::PathBuf::from(base),
        },
        crate::common::file::reader::FileReadRequest {
            target,
            base: base.to_string(),
            path: file_path,
            // 行为保持：项目内读取无大小上限，二进制检测与既有实现一致
            max_bytes: None,
            detect_binary: true,
        },
    )
    .await
}

/// Write file content.
#[tauri::command]
pub async fn write_file_content(
    workspace: WorkspaceSession,
    file_path: String,
    content: String,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (target, ws) = state.resolve_workspace_target(&workspace).await?;
    crate::common::file::services::write_file_content(&target, ws.root(), &file_path, content).await
}

/// Create a new empty file (with parent directories).
#[tauri::command]
pub async fn create_new_file(
    workspace: WorkspaceSession,
    file_path: String,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (target, ws) = state.resolve_workspace_target(&workspace).await?;
    crate::common::file::services::create_new_file(&target, ws.root(), &file_path).await
}

/// Save a new file with content at `directory/filename`, returning the relative path.
#[tauri::command]
pub async fn save_new_file(
    workspace: WorkspaceSession,
    directory: String,
    filename: String,
    content: String,
    state: State<'_, AppStateWrapper>,
) -> Result<String, AppError> {
    let (target, ws) = state.resolve_workspace_target(&workspace).await?;
    crate::common::file::services::save_new_file(&target, ws.root(), &directory, &filename, content)
        .await
}

/// Create a new directory (with parent directories).
#[tauri::command]
pub async fn create_directory(
    workspace: WorkspaceSession,
    dir_path: String,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (target, ws) = state.resolve_workspace_target(&workspace).await?;
    crate::common::file::services::create_directory(&target, ws.root(), &dir_path).await
}

/// Delete a file or directory (recursively for directories).
#[tauri::command]
pub async fn delete_path(
    workspace: WorkspaceSession,
    path: String,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (target, ws) = state.resolve_workspace_target(&workspace).await?;
    crate::common::file::services::delete_path(&target, ws.root(), &path).await
}

/// Rename a file or directory (within the same parent directory).
#[tauri::command]
pub async fn rename_path(
    workspace: WorkspaceSession,
    path: String,
    new_name: String,
    state: State<'_, AppStateWrapper>,
) -> Result<(), AppError> {
    let (target, ws) = state.resolve_workspace_target(&workspace).await?;
    crate::common::file::services::rename_path(&target, ws.root(), &path, &new_name).await
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::reveal::build_reveal_command;
    #[cfg(target_os = "windows")]
    use crate::platform::reveal::normalize_path;
    use std::fs;

    // ── 平台专属整测试：平台维度在测试名上（fragment 级平台门控被
    //    check_platform_cfg_placement 禁止；见红线 10）────────────────────────

    /// Windows 路径规范化：正 / 反斜杠统一为反斜杠。
    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_path_windows_uses_backslashes() {
        assert_eq!(
            normalize_path("C:/Users/test/file.rs"),
            "C:\\Users\\test\\file.rs"
        );
        assert_eq!(
            normalize_path("C:\\Users\\test\\file.rs"),
            "C:\\Users\\test\\file.rs"
        );
        assert_eq!(normalize_path("./src/main.rs"), ".\\src\\main.rs");
    }

    /// reveal 一个**文件**（Windows）：`explorer /select,<path>`。
    #[cfg(target_os = "windows")]
    #[test]
    fn reveal_file_uses_select_prefix() {
        let dir = tempfile::tempdir().expect("tempdir");
        let temp = reveal_fixture_file(dir.path(), "cmd_target.txt");
        let cmd = reveal_command_for(&temp);
        let args: Vec<&std::ffi::OsStr> = cmd.get_args().collect();
        assert_eq!(cmd.get_program(), "explorer");
        assert_eq!(args.len(), 1);
        assert!(args[0].to_string_lossy().starts_with("/select,"));
    }

    /// reveal 一个**文件**（macOS）：`open -R <path>`（`-R` 才是「选中文件」）。
    #[cfg(target_os = "macos")]
    #[test]
    fn reveal_file_uses_open_reveal_flag() {
        let dir = tempfile::tempdir().expect("tempdir");
        let temp = reveal_fixture_file(dir.path(), "cmd_target.txt");
        let cmd = reveal_command_for(&temp);
        let args: Vec<&std::ffi::OsStr> = cmd.get_args().collect();
        assert_eq!(cmd.get_program(), "open");
        assert_eq!(args[0], "-R");
    }

    /// reveal 一个**文件**（Linux）：无「选中文件」语义 → 打开其父目录（`xdg-open <parent>`）。
    #[cfg(target_os = "linux")]
    #[test]
    fn reveal_file_opens_parent_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        let temp = reveal_fixture_file(dir.path(), "cmd_target.txt");
        let cmd = reveal_command_for(&temp);
        let args: Vec<&std::ffi::OsStr> = cmd.get_args().collect();
        assert_eq!(cmd.get_program(), "xdg-open");
        assert_eq!(args.len(), 1);
        assert_eq!(args[0], temp.parent().unwrap().as_os_str());
    }

    /// reveal 一个**目录**（Windows）：`explorer <dir>`。
    #[cfg(target_os = "windows")]
    #[test]
    fn reveal_dir_uses_explorer() {
        let dir = tempfile::tempdir().expect("tempdir");
        let temp = reveal_fixture_dir(dir.path(), "cmd_target_dir");
        let cmd = reveal_command_for(&temp);
        let args: Vec<&std::ffi::OsStr> = cmd.get_args().collect();
        assert_eq!(cmd.get_program(), "explorer");
        assert_eq!(args.len(), 1);
    }

    /// reveal 一个**目录**（macOS）：`open <dir>`。
    #[cfg(target_os = "macos")]
    #[test]
    fn reveal_dir_uses_open() {
        let dir = tempfile::tempdir().expect("tempdir");
        let temp = reveal_fixture_dir(dir.path(), "cmd_target_dir");
        let cmd = reveal_command_for(&temp);
        let args: Vec<&std::ffi::OsStr> = cmd.get_args().collect();
        assert_eq!(cmd.get_program(), "open");
        assert_eq!(args.len(), 1);
    }

    /// reveal 一个**目录**（Linux）：`xdg-open <dir>`。
    #[cfg(target_os = "linux")]
    #[test]
    fn reveal_dir_uses_xdg_open() {
        let dir = tempfile::tempdir().expect("tempdir");
        let temp = reveal_fixture_dir(dir.path(), "cmd_target_dir");
        let cmd = reveal_command_for(&temp);
        let args: Vec<&std::ffi::OsStr> = cmd.get_args().collect();
        assert_eq!(cmd.get_program(), "xdg-open");
        assert_eq!(args.len(), 1);
        assert_eq!(args[0], temp.as_os_str());
    }

    #[test]
    fn test_is_directory_with_existing_dir() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(Path::new(dir.path().to_str().unwrap()).is_dir());
    }

    #[test]
    fn test_is_directory_with_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let temp = dir.path().join("marker.txt");
        fs::write(&temp, "test").unwrap();
        assert!(!Path::new(temp.to_str().unwrap()).is_dir());
    }

    #[test]
    fn test_reveal_nonexistent_path() {
        let result = reveal_in_file_manager("/nonexistent/path/that/does/not/exist".to_string());
        assert!(result.is_err());
        match result.unwrap_err() {
            AppError::NotFound(_) => {} // expected
            other => panic!("Expected NotFound error, got: {:?}", other),
        }
    }

    // ── 夹具（item 级、无平台 cfg：平台差异只允许出现在测试函数上）────────────

    /// 在给定临时目录下建一个**文件**夹具并返回其路径（路径由 `tempdir()` 派生，红线 13）。
    fn reveal_fixture_file(dir: &Path, name: &str) -> std::path::PathBuf {
        let temp = dir.join(name);
        fs::write(&temp, "test").unwrap();
        temp
    }

    /// 在给定临时目录下建一个**目录**夹具并返回其路径。
    fn reveal_fixture_dir(dir: &Path, name: &str) -> std::path::PathBuf {
        let temp = dir.join(name);
        fs::create_dir_all(&temp).unwrap();
        temp
    }

    /// 现存的路径必须能构造出 reveal 命令（等价于原 `assert!(cmd.is_some())`）。
    fn reveal_command_for(path: &Path) -> std::process::Command {
        build_reveal_command(path).expect("existing path must yield a reveal command")
    }

    // ── 平台无关测试 ─────────────────────────────────────────────────────

    #[test]
    fn test_file_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let temp = dir.path().join("marker");
        assert!(!file_exists(temp.to_str().unwrap().to_string()).unwrap());

        fs::write(&temp, b"x").unwrap();
        assert!(file_exists(temp.to_str().unwrap().to_string()).unwrap());
    }

    #[test]
    fn test_build_reveal_command_for_nonexistent() {
        let cmd = build_reveal_command(Path::new("/nonexistent/path"));
        assert!(cmd.is_some());
    }
}
