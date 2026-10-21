//! Tauri commands for agent CRUD and installation checks.

use crate::agent::chat::adapter::ModelCatalogResult;
use crate::agent::chat::commands::resolve_agent_config;
use crate::common::agent::types::{AgentConfig, ModelInfo};
use crate::AppError;
use crate::AppStateWrapper;
use std::collections::HashMap;
use std::path::Path;
use tauri::State;

/// List all registered agents.
#[tauri::command]
pub fn list_agents(state: State<AppStateWrapper>) -> Result<Vec<AgentConfig>, AppError> {
    state
        .agent_manager
        .lock()
        .map_err(AppError::from)
        .map(|am| am.get_agents().to_vec())
}

/// Get a single agent by ID.
#[tauri::command]
pub fn get_agent(agent_id: String, state: State<AppStateWrapper>) -> Result<AgentConfig, AppError> {
    state
        .agent_manager
        .lock()
        .map_err(AppError::from)?
        .get_agent(&agent_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("Agent not found: {}", agent_id)))
}

/// List agents that support Agent Chat（声明了 CHAT 能力）。
///
/// 前端 Agent Chat 页面的 agent 列表单一事实源：只有 `chat: Some(_)` 的
/// agent 才会出现，避免把仅终端 TUI 的 agent 误展示在页面选择器里。
#[tauri::command]
pub fn list_chat_agents(state: State<AppStateWrapper>) -> Result<Vec<AgentConfig>, AppError> {
    state
        .agent_manager
        .lock()
        .map_err(AppError::from)
        .map(|am| {
            am.get_agents()
                .iter()
                .filter(|a| a.chat.is_some())
                .cloned()
                .collect()
        })
}

/// List the models an agent offers, for the chat / settings model pickers.
///
/// # 分派依据是传输类型，不是 agent id
///
/// 能力挂在 `ChatStart` 上（`adapter_for` 已经按它分派），因此新增一个支持模型的
/// agent **不需要**改动本函数 —— 这正是旧实现缺失的性质：
///
/// ```ignore
/// // 旧实现：每个新 agent 都得回头改这里
/// if agent_id == "opencode" { return discover_opencode_models(None).await; }
/// Ok(Vec::new())
/// ```
///
/// # 三种结果，不是一个空数组
///
/// - `Available`：有独立目录（目前只有 opencode 的 `models --verbose` 快速路径）；
/// - `SessionScoped`：支持模型选择，但列表只能在会话内取（ACP 协议约束 ——
///   模型来自 `session/new` 响应的 `configOptions`，没有独立查询方法）；
/// - `Unsupported`：该 agent 不支持模型选择。
///
/// 三者对用户是三种不同处境，UI 需要分别措辞（旧实现把它们都压成 `[]`）。
#[tauri::command]
pub async fn list_agent_models(
    agent_id: String,
    state: State<'_, AppStateWrapper>,
) -> Result<ModelCatalogResult, AppError> {
    let agent = resolve_agent_config(&state, &agent_id)?;

    // 两步，彼此独立：
    //
    // 1. **有没有独立的列模型命令**（`model_list_args`）。这是纯 CLI 查询，
    //    与 chat 能力无关 —— `pi --list-models` 在 `chat: None` 时照样能跑，
    //    而它正是「让用户在发第一条消息之前看到列表」的唯一途径。
    // 2. 没有命令时，再看 transport 能不能**在会话内**选模型（ACP 就是这样）。
    //
    // 早先这里先取 adapter 再问 catalog，把「列模型」和「能聊天」绑死：
    // `chat: None` 的 agent 连问都问不到，即使它有列模型命令。
    if let Some(models) = try_list_via_command(&agent).await? {
        return Ok(ModelCatalogResult::Available { models });
    }

    let session_scoped = crate::agent::chat::adapter::adapter_for(&agent)
        .is_ok_and(|adapter| adapter.supports_model_selection());

    Ok(if session_scoped {
        ModelCatalogResult::SessionScoped
    } else {
        ModelCatalogResult::Unsupported
    })
}

/// 用 agent 声明的列模型命令取列表。
///
/// `None` = 这个 agent 没有这样的命令；`Some(_)` = 拿到了（可能是空列表 —— 空是
/// 合法答案，不是失败）。**命令执行失败要往上抛**，否则用户会把「装坏了」看成
/// 「本来就没有模型」。
async fn try_list_via_command(agent: &AgentConfig) -> Result<Option<Vec<ModelInfo>>, AppError> {
    if agent.model_list_args.is_none() {
        return Ok(None);
    }
    crate::agent::model_discovery::list_models_by_command(agent)
        .await
        .map(Some)
}

/// Add or update an agent and persist to config.
///
/// 内置 agent → 内存原位覆盖 + 持久化到 config.json `agentOverrides`（不写
/// `customAgents`，避免产生内置副本）；
/// 自定义 agent → 现状（`customAgents` 数组 upsert）。
#[tauri::command]
pub fn add_agent(agent: AgentConfig, state: State<AppStateWrapper>) -> Result<(), AppError> {
    let is_builtin = {
        let am = state.agent_manager.lock().map_err(AppError::from)?;
        am.is_builtin_id(&agent.id)
    };
    if is_builtin {
        // 内置：内存原位覆盖（AgentManager 保留 is_builtin 身份）+ 持久化覆盖层。
        state
            .agent_manager
            .lock()
            .map_err(AppError::from)?
            .add_agent(agent.clone());
        return state
            .storage_manager
            .save_agent_override(&agent.id, Some(&agent))
            .map_err(|e| AppError::Storage(format!("Failed to persist agent override: {e}")));
    }

    {
        let mut am = state.agent_manager.lock().map_err(AppError::from)?;
        if am.get_agent(&agent.id).is_some() {
            am.remove_agent(&agent.id);
        }
        am.add_agent(agent.clone());
    }
    // Upsert: replace existing entry with same ID, or append
    let mut custom = state.storage_manager.load_custom_agents();
    if let Some(pos) = custom
        .iter()
        .position(|a| a.get("id").and_then(|v| v.as_str()) == Some(&agent.id))
    {
        custom[pos] = serde_json::to_value(&agent).map_err(AppError::from)?;
    } else {
        custom.push(serde_json::to_value(&agent).map_err(AppError::from)?);
    }
    state
        .storage_manager
        .save_custom_agents(&custom)
        .map_err(|e| AppError::Storage(format!("Failed to persist custom agents: {e}")))
}

/// Remove an agent and persist the change.
///
/// 内置 agent → 内存恢复出厂 + 清除 config.json `agentOverrides` 覆盖（不是删除）；
/// 自定义 agent → 现状（从内存与 `customAgents` 移除）。
#[tauri::command]
pub fn remove_agent(agent_id: String, state: State<AppStateWrapper>) -> Result<(), AppError> {
    let is_builtin = {
        let am = state.agent_manager.lock().map_err(AppError::from)?;
        am.is_builtin_id(&agent_id)
    };
    if is_builtin {
        // 内置：恢复出厂（清除覆盖）。
        state
            .agent_manager
            .lock()
            .map_err(AppError::from)?
            .remove_agent(&agent_id);
        return state
            .storage_manager
            .save_agent_override(&agent_id, None)
            .map_err(|e| AppError::Storage(format!("Failed to clear agent override: {e}")));
    }
    state
        .agent_manager
        .lock()
        .map_err(AppError::from)?
        .remove_agent(&agent_id);
    let mut custom = state.storage_manager.load_custom_agents();
    custom.retain(|a| a.get("id").and_then(|v| v.as_str()) != Some(&agent_id));
    state
        .storage_manager
        .save_custom_agents(&custom)
        .map_err(|e| AppError::Storage(format!("Failed to persist custom agents: {e}")))
}

/// Set the selected agents for a project.
#[tauri::command]
pub fn set_project_agents(
    project_id: String,
    agent_ids: Vec<String>,
    state: State<AppStateWrapper>,
) -> Result<(), AppError> {
    state
        .project_manager
        .lock()
        .map_err(AppError::from)?
        .set_selected_agents(&project_id, agent_ids);
    Ok(())
}

/// Check whether agent CLIs exist in a project's execution environment.
#[tauri::command]
pub async fn check_agents_installed(
    agent_ids: Option<Vec<String>>,
    project_id: Option<String>,
    state: State<'_, AppStateWrapper>,
) -> Result<HashMap<String, bool>, AppError> {
    let env = match project_id.as_deref() {
        Some(pid) => state.project_environment(pid)?,
        None => state.active_project_environment()?,
    };
    let target = env.to_exec_target();

    // Snapshot under lock — never hold the mutex across await / remote checks.
    let commands = {
        let am = state.agent_manager.lock().map_err(AppError::from)?;
        let ids =
            agent_ids.unwrap_or_else(|| am.get_agents().iter().map(|a| a.id.clone()).collect());
        am.resolve_commands(&ids)
    };

    log::info!(
        "[agent] check_agents_installed env={:?} count={}",
        std::mem::discriminant(&env),
        commands.len()
    );

    Ok(crate::agent::manager::AgentManager::check_installed(&commands, &target).await)
}

/// Import an agent icon image file into the app data directory.
#[tauri::command]
pub async fn import_agent_icon(
    source_path: String,
    app_handle: tauri::AppHandle,
) -> Result<String, AppError> {
    use tauri::Manager;

    let source = Path::new(&source_path);

    // Validate source exists
    if !source.exists() {
        return Err(AppError::Io(format!(
            "Source file not found: {source_path}"
        )));
    }

    // Validate file extension
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .filter(|e| {
            matches!(
                e.as_str(),
                "png" | "jpg" | "jpeg" | "svg" | "gif" | "webp" | "ico" | "bmp"
            )
        })
        .ok_or_else(|| {
            AppError::InvalidInput(
                "Unsupported image format. Supported: png, jpg, jpeg, svg, gif, webp, ico, bmp"
                    .to_string(),
            )
        })?;

    // Validate file size (max 1MB)
    let metadata = source.metadata().map_err(AppError::from)?;
    if metadata.len() > 1_048_576 {
        return Err(AppError::InvalidInput(format!(
            "File too large ({} bytes). Maximum is 1MB.",
            metadata.len()
        )));
    }

    // Determine destination directory
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(format!("Failed to resolve app data directory: {e}")))?;
    let dest_dir = app_data_dir.join("agent-icons");
    tokio::fs::create_dir_all(&dest_dir)
        .await
        .map_err(AppError::from)?;

    // Generate unique filename
    let uuid = uuid::Uuid::new_v4();
    let dest_filename = format!("{uuid}.{ext}");
    let dest_path = dest_dir.join(&dest_filename);

    // Copy file
    tokio::fs::copy(source, &dest_path)
        .await
        .map_err(AppError::from)?;

    log::info!(
        "Imported agent icon: {source_path} -> {}",
        dest_path.display()
    );

    Ok(dest_path.to_string_lossy().to_string())
}

/// Discover models supported by OpenCode.
///
/// Thin wrapper over [`crate::agent::model_discovery::discover_opencode_models`]:
/// executes `opencode models --verbose` and parses the JSON output to extract
/// model information. The actual execution + parsing lives in the domain layer.
#[tauri::command]
pub async fn discover_opencode_models(
    binary_path: Option<String>,
) -> Result<Vec<ModelInfo>, AppError> {
    crate::agent::model_discovery::discover_opencode_models(binary_path).await
}
