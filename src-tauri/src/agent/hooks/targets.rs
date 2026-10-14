//! 受管外部 Agent CLI 的**唯一事实表**（design §2.5）——「本机支持接入哪几个 CLI」这一个问题
//! 的唯一答案。
//!
//! 第一性原理：接入一个新 CLI 应该只改一行数据。此前 (source, 目录, 文件名, 模板) 四元组被
//! 手抄在 `install_all` / `status_all` / `uninstall_all` 三处，外加 ingest 的路由白名单与一个
//! 计数常量 —— 一致性只剩注释级约定（根 `AGENTS.md`：重复 3 次必须抽象；开闭原则：新能力靠
//! 加数据而非改核心）。本表是那些副本的唯一来源：writers 按行安装/卸载/查询，server 按行校验路由。

use std::path::{Path, PathBuf};

/// opencode 插件模板（1.19.0 实测事件面：session.created / session.updated /
/// session.status(idle) / permission.asked / question.asked）。
///
/// 「等待用户行动」在 opencode 是**两个独立事件族**：`permission.asked`（权限门）与
/// `question.asked`（ask 类工具阻塞）—— 只订阅前者时后者在任何通知里都不出现（实测）。
const OPENCODE_TEMPLATE: &str = include_str!("templates/neeko-opencode-status.js");

/// pi 扩展模板（1.1.0 实测事件面：agent_end / tool_call(ask 类工具) / ui_prompt_start）。
const PI_TEMPLATE: &str = include_str!("templates/neeko-pi-status.ts");

/// 一个受管 CLI 的接入数据。
pub struct HookTarget {
    /// CLI 标识：既是 ingest 路由段 `/hook/{source}`，也是设置页与回执里的展示名
    /// （同一个事实只有一个名字，不再另设 `cli` 字段）。
    pub source: &'static str,
    /// 受管文件名（落在 [`HookTarget::dir`] 下）。
    pub file_name: &'static str,
    /// 模板正文（不含归属标记头 —— 由 writers 统一前置，保证标记格式单点）。
    pub template: &'static str,
    /// 该 CLI 在本机的扩展目录定位器（`None` = 无法确定用户目录）。
    pub dir: fn() -> Option<PathBuf>,
}

/// 全部受管 CLI：**新增一行即完成接入**，writers / server / 设置页零改动。
pub const HOOK_TARGETS: &[HookTarget] = &[
    HookTarget {
        source: "opencode",
        file_name: "neeko-status.js",
        template: OPENCODE_TEMPLATE,
        dir: opencode_plugins_dir,
    },
    HookTarget {
        source: "pi",
        file_name: "neeko-status.ts",
        template: PI_TEMPLATE,
        dir: pi_extensions_dir,
    },
];

/// opencode 插件目录：opencode 全平台使用 XDG 风格 `~/.config/opencode`
/// （`$XDG_CONFIG_HOME` 优先），**不是** macOS 的 `~/Library/Application Support`
/// —— 2026-10-12 用户机实测纠错（`~/.config/opencode/plugins/open-island.js` 为证）。
/// `dirs::config_dir()` 在 mac/win 上会给错误位置，故显式按 opencode 约定解析。
#[must_use]
pub fn opencode_plugins_dir() -> Option<PathBuf> {
    // XDG Base Directory Spec §2：这些变量里的路径**必须**是绝对路径，相对值应视为无效并忽略。
    // 只判 `!is_empty()` 时，相对值会让 install 写出 CWD 相对路径而 status 报「未安装」——
    // 意图与事实错位（同一份 `~/.config` 契约在两种调用下指向不同地方）。
    let config_root = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(xdg) if Path::new(&xdg).is_absolute() => PathBuf::from(xdg),
        _ => dirs::home_dir()?.join(".config"),
    };
    Some(config_root.join("opencode").join("plugins"))
}

/// pi 扩展目录（`~/.pi/agent/extensions`，orca 实测验证的安装面）。
#[must_use]
pub fn pi_extensions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".pi").join("agent").join("extensions"))
}

// ── TDD：目录约定的纠错钉子（夹具全部 tempdir 推导，红线 13）────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 进程级 env 的成对还原（断言 panic 也必须恢复，否则污染同进程其他测试线程）。
    struct ScopedEnv {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl ScopedEnv {
        fn set(key: &'static str, value: &std::path::Path) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for ScopedEnv {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    /// XDG_CONFIG_HOME 优先（2026-10-12 纠错钉子：macOS 上曾误用 `dirs::config_dir()`
    /// 指到 Library/Application Support）。值取 tempdir 派生前缀，不硬编码平台路径。
    #[test]
    fn opencode_dir_follows_xdg_convention() {
        let base = tempfile::tempdir().expect("tempdir");
        let _scoped = ScopedEnv::set("XDG_CONFIG_HOME", base.path());
        let expected = base.path().join("opencode").join("plugins");
        assert_eq!(opencode_plugins_dir(), Some(expected));
    }

    /// 空 XDG_CONFIG_HOME 视同未设置（否则会得到相对路径 `opencode/plugins`）。
    #[test]
    fn empty_xdg_value_falls_back_to_home() {
        let _scoped = ScopedEnv::set("XDG_CONFIG_HOME", std::path::Path::new(""));
        let got = opencode_plugins_dir().expect("home-derived");
        assert!(
            got.is_absolute() && got.ends_with("opencode/plugins"),
            "must derive from home dir, got {got:?}"
        );
    }

    /// 相对 XDG_CONFIG_HOME 同样视为无效（XDG Spec §2 要求绝对路径）。
    ///
    /// 只判空时相对值会被接受 —— install 写出 CWD 相对路径、status 却在别处查找，
    /// 表现为「装了但报未安装」且随 CWD 漂移。
    #[test]
    fn relative_xdg_value_falls_back_to_home() {
        let _scoped = ScopedEnv::set("XDG_CONFIG_HOME", std::path::Path::new("relative/config"));
        let got = opencode_plugins_dir().expect("home-derived");
        assert!(
            got.is_absolute() && got.ends_with("opencode/plugins"),
            "相对值必须被忽略并回落 home，got {got:?}"
        );
    }

    /// pi 目录约定（`.pi/agent/extensions`）。
    #[test]
    fn pi_dir_sits_under_home() {
        let got = pi_extensions_dir().expect("home");
        assert!(got.is_absolute());
        assert!(got.ends_with(std::path::Path::new(".pi").join("agent").join("extensions")));
    }

    /// 事实表自洽：source 唯一、文件名唯一（新 CLI 接入不会撞路由或撞文件）。
    #[test]
    fn hook_targets_are_unique() {
        for (i, a) in HOOK_TARGETS.iter().enumerate() {
            assert!(!a.source.is_empty() && !a.file_name.is_empty());
            for b in HOOK_TARGETS.iter().skip(i + 1) {
                assert_ne!(a.source, b.source);
                assert_ne!(a.file_name, b.file_name);
            }
        }
        assert!(!HOOK_TARGETS.is_empty());
    }
}
