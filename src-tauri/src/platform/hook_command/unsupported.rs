//! 非 Unix / 非 Windows 平台的兜底实现（保证三端以上目标也能编译）。
//!
//! 这些目标上没有可依据的 shell 约定，故三个入口一律返回「无法生成」：
//! `render_report_command` / `report_argv` / `resolve_node` → `None`。
//! 调用方（`install::shape::*`）据此回执 `Skipped`（**不写**一个必定失败的 hook），
//! 与「无 node 可执行文件」时的既有降级路径完全一致。
//!
//! 满足红线 10 的 `const fn` 要求（clippy `missing_const_for_fn`）。

use std::path::Path;

/// 无法在此平台渲染 shell 命令。
#[must_use]
pub const fn render_report_command(
    _shim: &Path,
    _source: &str,
    _event_key: &str,
) -> Option<String> {
    None
}

/// 无法在此平台生成 argv 数组。
#[must_use]
pub const fn report_argv(_shim: &Path, _source: &str, _event_key: &str) -> Option<Vec<String>> {
    None
}

/// 无法在此平台解析 node 可执行文件。
#[must_use]
pub const fn resolve_node() -> Option<String> {
    None
}
