//! CLI hook 薄命令（agent 域；红线 6：只调度 writers，逻辑在 writers/模板）。
//!
//! 为什么命令在 agent 域而非 notification 域：install/uninstall 是「pi/opencode 配置面」
//! 的业务知识（依赖方向：agent → notification，反向被护栏 `check_notification_core_direction`
//! 禁止）。设置页保存 `cliHooks` 字段后，前端接着调本命令完成文件面变更（见 FE 串行链）。

use crate::agent::hooks::writers::{self, HookApplyOutcome, HookInstallStatus};
use crate::AppError;

/// 应用「外部 CLI hooks」开关：enabled=true 安装（幂等），false 卸载（只删自家受管文件）。
/// 逐 CLI 机器可读回执（status 枚举 + detail），由设置页分类呈现。
#[tauri::command]
pub fn agent_hooks_apply(enabled: bool) -> Result<Vec<HookApplyOutcome>, AppError> {
    Ok(if enabled {
        writers::install_all()
    } else {
        writers::uninstall_all()
    })
}

/// 查询两个 CLI 的 hook 安装状态（设置页数据行）。
#[tauri::command]
pub fn agent_hooks_status() -> Result<Vec<HookInstallStatus>, AppError> {
    Ok(writers::status_all())
}
