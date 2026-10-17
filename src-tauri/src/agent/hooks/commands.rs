//! CLI hook 薄命令（agent 域；红线 6：只调度 writers/settings，逻辑在域内）。
//!
//! 为什么命令在 agent 域而非 notification 域：install/uninstall 是「pi/opencode/omp/claude 系
//! 配置面」的业务知识（依赖方向：agent → notification，反向被护栏
//! `check_notification_core_direction` 禁止）。设置页保存后，前端接着调本命令完成文件面变更
//! （见 FE 串行链）。
//!
//! **两个开关的分工**（见 `agent/hooks/install/config/settings.rs`）：主开关（`NotificationSettings.cli_hooks`，
//! 核心域）表达「用户是否同意 Neeko 装 hook」；逐 CLI 覆盖（`agentHookSources`，本域配置键）
//! 表达「哪些 CLI 例外」。命令收 `enabled_sources`（已算好的生效集）而非原始覆盖表 ——
//! 判定逻辑留在 [`crate::agent::hooks::install::config::settings`]（纯函数、可直测），命令层只做调度。

use std::collections::HashSet;

use crate::agent::hooks::install::{self, HookApplyOutcome, HookInstallStatus};
use crate::AppError;

/// 应用 hook 开关。
///
/// - `master`：用户级主开关（`false` ⇒ 全部卸载，忽略覆盖表）；
/// - `enabled_sources`：主开关为真时**应处于安装态**的 CLI 集合
///   （由前端按 `agentHookSources` 算出，或留空表示「全部启用」）；
/// - 未列出的 CLI：主开关为真时一律卸载（含历史已装但本次被关掉的）。
///
/// 为什么收「集合」而非「覆盖 map」：命令层不该再实现一遍合并语义
/// （那会让 Rust 与 TS 各有一份判定，正是跨语言漂移的温床）。前端从
/// `agent_hooks_status` + 设置算出集合，Rust 只按集合执行。
#[tauri::command]
pub fn agent_hooks_apply(
    enabled: bool,
    enabled_sources: Option<Vec<String>>,
) -> Result<Vec<HookApplyOutcome>, AppError> {
    // 命令层只做「参数校验 + 调度」（红线 6）：把 `Option<Vec>` 归一为谓词，
    // 收敛语义（该装的装、不该装的卸、主开关是闸门）全部落在
    // [`install::apply_selection`]，与开机收敛**同一条**路径。
    let wanted: Option<HashSet<String>> = enabled_sources.map(|s| s.into_iter().collect());
    Ok(install::apply_selection(enabled, |source| {
        // 未给集合 = 全部启用（向后兼容旧前端）。
        wanted.as_ref().is_none_or(|set| set.contains(source))
    }))
}

/// 查询各 CLI 的 hook 安装状态（设置页数据行）。
#[tauri::command]
pub fn agent_hooks_status() -> Result<Vec<HookInstallStatus>, AppError> {
    Ok(install::status_all())
}
