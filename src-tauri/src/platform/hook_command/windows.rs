//! Windows 实现：`cmd /c` + 双引号转义。
//!
//! 为什么是双引号而非单引号：Windows 的 `cmd.exe` **不把单引号当引号**（它是普通字符），
//! 只有双引号能保护含空格的路径（`C:\Users\Tom Gs\…`）。
//!
//! 为什么不加 `cmd /c` 前缀：`command` 字段本身已经由 CLI 通过 shell 执行
//! （`cmd /c <command>`），再加一层 `cmd /c` 会变成 `cmd /c cmd /c …`。
//! 这里只负责**命令内容**的引号规则 —— 这正是平台差异的边界。

use std::path::Path;

use super::is_safe_token;

/// `cmd.exe` 双引号包裹：内部的 `"` 以 `\"` 转义（`cmd` 对 `\"` 的处理与 `CRT` 一致），
/// 并把 `%` 双写以避免变量展开（路径里出现 `%` 时不被当作环境变量引用）。
fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\"").replace('%', "%%"))
}

/// 渲染写进 CLI 配置 `command` 字段的 shim 启动命令（Windows 形态）。
#[must_use]
pub fn render_report_command(shim: &Path, source: &str, event_key: &str) -> Option<String> {
    if !is_safe_token(source) || !is_safe_token(event_key) {
        return None;
    }
    let node = resolve_node()?;
    Some(format!(
        "{} {} {source} {event_key}",
        quote(&node),
        quote(&shim.to_string_lossy())
    ))
}

/// 渲染 shim 的 **argv 数组**（不经 shell）：`[node, shim, source, event_key]`。
///
/// 与 Unix 实现同形 —— argv 形态**无平台差异**（不经 shell ⇒ 无引号/分隔符规则）。
/// 保留平台实现是为了与 [`render_report_command`] 对称（同一模块内的门面一致性）。
#[must_use]
pub fn report_argv(shim: &Path, source: &str, event_key: &str) -> Option<Vec<String>> {
    if !is_safe_token(source) || !is_safe_token(event_key) {
        return None;
    }
    let node = resolve_node()?;
    Some(vec![
        node,
        shim.to_string_lossy().to_string(),
        source.to_string(),
        event_key.to_string(),
    ])
}

/// 解析 `node` 可执行文件路径（`where.exe` 语义由 `which` crate 跨平台提供）。
///
/// 与 Unix 实现同判据：走 `PATH`（Neeko 启动时已注入用户级 node 目录，
/// 兼容 nvm-windows / fnm / volta），不硬编码。
#[must_use]
pub fn resolve_node() -> Option<String> {
    // 测试期覆盖优先（与 unix.rs 同判据，见 `rules::test_node_override`）。
    if let Some(forced) = super::test_node_override() {
        return forced;
    }
    let path_env = std::env::var_os("PATH")?;
    // 同 unix.rs：兜底取 `temp_dir()`，不硬编码盘符根。
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
    let found = which::which_in("node", Some(path_env), cwd).ok()?;
    Some(found.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Windows 引号规则：双引号包裹 + `%` 双写（防 cmd 变量展开）。
    #[test]
    fn quote_uses_double_quotes_and_escapes_percent() {
        assert_eq!(quote("C:\\a b\\c"), "\"C:\\a b\\c\"");
        assert_eq!(quote("C:\\100%\\x"), "\"C:\\100%%\\x\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
    }

    /// token 白名单与 Unix 实现同判据（注入面被拒）。
    #[test]
    fn unsafe_tokens_are_rejected() {
        let shim = std::path::PathBuf::from("C:\\neeko\\neeko-status.mjs");
        for bad in ["a& calc", "a b", "", "a|b"] {
            assert!(render_report_command(&shim, bad, "turn_completed").is_none());
            assert!(render_report_command(&shim, "claude", bad).is_none());
        }
    }

    /// argv 形态：与 Unix 同形（无平台差异，不经 shell）。
    #[test]
    fn report_argv_shapes_plain_array() {
        let shim = std::path::PathBuf::from("C:\\neeko\\neeko-status.mjs");
        let Some(argv) = report_argv(&shim, "codex", "turn_completed") else {
            return;
        };
        assert_eq!(argv.len(), 4);
        assert_eq!(argv[1], "C:\\neeko\\neeko-status.mjs");
        assert_eq!(argv[2], "codex");
        assert_eq!(argv[3], "turn_completed");
    }

    /// 命令形态（本机有 node 时）：node + 双引号 shim + 裸 token。
    #[test]
    fn render_shapes_command_when_node_present() {
        let shim = std::path::PathBuf::from("C:\\neeko\\neeko-status.mjs");
        if let Some(cmd) = render_report_command(&shim, "claude", "approval_requested") {
            assert!(cmd.ends_with(" claude approval_requested"), "{cmd}");
            assert!(cmd.contains("\"C:\\neeko\\neeko-status.mjs\""), "{cmd}");
        }
    }
}
