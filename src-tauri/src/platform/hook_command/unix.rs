//! Unix 实现：POSIX 单引号转义。
//!
//! 为什么单引号而非双引号：路径可能含空格（`/Users/tomgs/Rustrover Projects/…`）与
//! shell 元字符（`$` / `` ` `` / `!`）。POSIX 单引号内**一切字符都是字面量**，
//! 无需逐个转义；唯一需要处理的是字符串自身含 `'` —— 用 `'\''` 关闭-转义-重开。

use std::path::Path;

use super::is_safe_token;

/// POSIX 单引号包裹（`'` → `'\''`）。与 `common::utils::command::quote_shell_arg` 同法，
/// 但本函数属平台层，不反向依赖业务工具模块。
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// 渲染写进 CLI 配置 `command` 字段的 shim 启动命令。
///
/// 形态：`<node> '<shim>' <source> <event_key>`。
///
/// `node` 由 `resolve_node` 解析（见下）；解析不到 → `None`。
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
/// 供 Codex 的 `notify` 用（它接收 argv 数组，自己 exec，不经 shell）。
/// 与 [`render_report_command`] 的差异**只有交付形态**：那边产出 shell 字符串
/// （供 Claude 面写进 `command` 字段），这边产出 argv 数组。
/// node 解析与 token 校验**共用**（不重复实现）。
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

/// 解析 `node` 可执行文件路径。
///
/// 为什么走 `PATH` 查找而非硬编码：用户可能用 nvm / fnm / volta 管理 node，
/// 路径每次切换版本都变（本机实测 `~/.local/share/fnm/node-versions/v24.17.0/…`）。
/// 硬编码会在用户切版本后静默失效。
///
/// 用**当前进程的 PATH** 解析：Neeko 启动时已由 `core::exec_env` 注入（含 fnm/nvm 的
/// 用户目录），故这里拿到的是用户实际可用的 node。
#[must_use]
pub fn resolve_node() -> Option<String> {
    resolve_on_path("node")
}

/// 在 `PATH` 上查找可执行文件，返回绝对路径。
fn resolve_on_path(program: &str) -> Option<String> {
    // 测试期覆盖优先（见 `rules::test_node_override` 的"为什么"）。
    // 生产构建该函数恒返回 `None`，故这里是零成本的短路。
    if let Some(forced) = super::test_node_override() {
        return forced;
    }
    let path_env = std::env::var_os("PATH")?;
    // cwd 只是 `which_in` 解析相对路径的基准；当前目录不可得时用 `temp_dir()`，
    // 而非硬编码 POSIX 根（同一形态在 Windows 上要写成 `C:\` —— 那种按平台分叉的
    // 字面量正是红线 13 要消除的对象）。
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::env::temp_dir());
    let found = which::which_in(program, Some(path_env), cwd).ok()?;
    Some(found.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 命令形态：node + 引号包裹的 shim + 两个裸 token。
    /// 用 tempdir 推导 shim 路径（红线 13：不硬编码 POSIX 绝对路径）。
    #[test]
    fn render_shapes_command_with_quoted_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shim = dir.path().join("neeko-status.mjs");
        let Some(cmd) = render_report_command(&shim, "claude", "approval_requested") else {
            return; // 本机无 node：由 install_at 回执 Skipped（此处不作断言）
        };
        assert!(cmd.ends_with(" claude approval_requested"), "{cmd}");
        assert!(
            cmd.contains(&format!("'{}'", shim.display())),
            "shim 路径必须被引号包裹：{cmd}"
        );
        // node 自身也被引号包裹（fnm 路径含空格时同样安全）。
        assert!(cmd.starts_with('\''), "node 路径必须被引号包裹：{cmd}");
    }

    /// 含空格与单引号的路径被正确转义（POSIX 单引号规则：`'` → `'\''`）。
    #[test]
    fn quote_handles_spaces_and_single_quotes() {
        assert_eq!(quote("/a b/c"), "'/a b/c'");
        assert_eq!(quote("/a'b"), "'/a'\\''b'");
    }

    /// token 白名单：注入面被拒（`None`），合法值放行。
    ///
    /// 反证：去掉 `is_safe_token` 校验，`"x; rm -rf /"` 会被拼进命令行。
    #[test]
    fn unsafe_tokens_are_rejected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shim = dir.path().join("s.mjs");
        for bad in ["a; rm -rf /", "a b", "a$(x)", "", "a|b", "a\nb"] {
            assert!(
                render_report_command(&shim, bad, "turn_completed").is_none(),
                "source={bad:?} 必须被拒"
            );
            assert!(
                render_report_command(&shim, "claude", bad).is_none(),
                "event_key={bad:?} 必须被拒"
            );
        }
        for good in ["claude", "codebuddy", "qoder", "turn_completed", "a-b_c9"] {
            assert!(is_safe_token(good), "{good:?} 应被接受");
        }
    }

    /// argv 形态：首项是 node，次项是 shim，后两项是裸 token（无引号 —— 不经 shell）。
    #[test]
    fn report_argv_shapes_plain_array_without_quoting() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shim = dir.path().join("neeko-status.mjs");
        let Some(argv) = report_argv(&shim, "codex", "turn_completed") else {
            return; // 本机无 node：由 install 回执 Skipped（此处不断言）
        };
        assert_eq!(argv.len(), 4);
        assert!(
            std::path::Path::new(&argv[0]).is_absolute(),
            "node 路径: {}",
            argv[0]
        );
        assert_eq!(argv[1], shim.to_string_lossy());
        assert_eq!(argv[2], "codex");
        assert_eq!(argv[3], "turn_completed");
        // 不经 shell ⇒ 不得出现引号包装。
        assert!(
            !argv[1].starts_with('\''),
            "argv 项不得带 shell 引号: {}",
            argv[1]
        );
    }

    /// argv 形态与 shell 形态共用同一 token 白名单（注入面同判据）。
    #[test]
    fn report_argv_rejects_unsafe_tokens() {
        let dir = tempfile::tempdir().expect("tempdir");
        let shim = dir.path().join("s.mjs");
        for bad in ["a; rm -rf /", "a b", "", "a|b"] {
            assert!(report_argv(&shim, bad, "turn_completed").is_none());
            assert!(report_argv(&shim, "codex", bad).is_none());
        }
    }

    /// `resolve_node` 在本机（有 node）应命中；无 node 环境返回 `None` 而非 panic。
    #[test]
    fn resolve_node_is_total() {
        // 不断言必须 Some（CI 环境可能无 node）—— 只断言不 panic 且路径形态正确。
        if let Some(node) = resolve_node() {
            assert!(!node.is_empty());
            assert!(std::path::Path::new(&node).is_absolute(), "got {node}");
        }
    }
}
