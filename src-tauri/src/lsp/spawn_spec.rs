//! LSP 执行上下文：一次动作（探测 / 启动 / 安装）的「在哪执行」唯一事实源（P2a）。
//!
//! 第一性原理：可用性判据与消费点必须在**同一环境、同一语义**下执行。命令与 argv 是
//! **动作的数据**（探测要 `--version`、安装命令与服务器完全不同），而 target / cwd /
//! env 是环境 —— 把两者分开后，「不带 cwd 的探测」在类型层面不可表达：`process.rs`
//! 的每个执行入口都要求 `&LspExecContext`。

use std::path::Path;

use crate::common::executor::factory::ExecTarget;
use crate::lsp::plugin::LspPlugin;

/// 「在哪执行」：一次 LSP 动作（探测 / 启动 / 安装）共用的执行环境。
#[derive(Clone)]
pub(crate) struct LspExecContext {
    pub(crate) target: ExecTarget,
    /// 工作目录（= 会话根）。**必有** —— 这正是 P2a 的落地方式。
    pub(crate) cwd: String,
    pub(crate) env: Vec<(String, String)>,
}

impl LspExecContext {
    #[must_use]
    pub(crate) fn new(target: ExecTarget, cwd: &str, env: Vec<(String, String)>) -> Self {
        Self {
            target,
            cwd: cwd.to_string(),
            env,
        }
    }

    /// 由会话装配输入派生：cwd = 会话根，env 来自插件 tuning（不按语言名分支）。
    ///
    /// 探测必须先于 spawn 拿到它，因此本构造器同时承担「env 派生提前」的职责。
    #[must_use]
    pub(crate) fn for_session(
        plugin: &LspPlugin,
        workspace_root: &Path,
        target: ExecTarget,
    ) -> Self {
        let env: Vec<(String, String)> = if plugin.tuning.java_home_from_path {
            crate::lsp::process::resolve_java_home(&target)
                .into_iter()
                .map(|home| ("JAVA_HOME".to_string(), home))
                .collect()
        } else {
            Vec::new()
        };
        Self::new(target, &workspace_root.to_string_lossy(), env)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// cwd 必须逐字来自传入的会话根（P2a：探测与启动共用同一个值）。
    #[test]
    fn session_context_keeps_workspace_root_as_cwd() {
        let registry = crate::lsp::plugin::LspPluginRegistry::with_defaults();
        let plugin = registry
            .resolve_by_language("rust")
            .expect("rust plugin exists");
        // 夹具路径由 tempdir 推导（红线 13）：不得硬编码 POSIX 绝对路径。
        let root = tempfile::tempdir().expect("tempdir");
        let root_str = root.path().to_string_lossy().to_string();

        let ctx = LspExecContext::for_session(&plugin, root.path(), ExecTarget::Local);

        assert_eq!(ctx.cwd, root_str);
        assert!(
            ctx.env.is_empty(),
            "rust 插件未声明 java_home_from_path，env 必须为空"
        );
    }

    /// env 逐字透传（JAVA_HOME 之类由构造器落进上下文，执行层不再有第二处拼装）。
    #[test]
    fn explicit_env_is_carried_verbatim() {
        let ctx = LspExecContext::new(
            ExecTarget::Local,
            "/tmp/ws",
            vec![("JAVA_HOME".to_string(), "/jdk-21".to_string())],
        );

        assert_eq!(ctx.cwd, "/tmp/ws");
        assert_eq!(
            ctx.env,
            vec![("JAVA_HOME".to_string(), "/jdk-21".to_string())]
        );
    }
}
