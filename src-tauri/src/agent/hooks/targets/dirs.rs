//! 各 CLI 配置目录的**解析规则**（本机环境事实，不是契约）。
//!
//! # 为什么独立于数据表
//!
//! 「配置目录在哪」取决于宿主环境（`XDG_CONFIG_HOME` / `CODEX_HOME` / `CLAUDE_CONFIG_DIR`），
//! 是唯一需要读环境变量的部分；而「支持哪几个 CLI、各自什么形态」是纯静态数据。
//! 两者变化频率与测试方式都不同：前者要覆盖 env 组合（含相对值/空值回落），
//! 后者只需断言表自洽 —— 混在一起会让数据表的读者被迫越过 7 个 env 解析函数。
//!
//! 全部 `#[must_use]` + `Option`：解析不到 = 该 CLI 在本机未初始化（调用方据此跳过）。

use std::path::{Path, PathBuf};

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

/// OMP 扩展目录（`~/.omp/agent/extensions`）—— 与 pi 同 API 的扩展面，
/// 本机已装 orca 的 `orca-agent-status.ts` 为证（其文件内注释明写
/// 「Pi and OMP expose the same extension API」）。
#[must_use]
pub fn omp_extensions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".omp").join("agent").join("extensions"))
}

/// Claude Code 配置根（`~/.claude`）。`CLAUDE_CONFIG_DIR` 优先（官方支持的重定位变量）。
///
/// 注意：这里返回的是**配置根目录**，hook 条目落在 `<root>/settings.json` 的 `hooks` 键下
/// （与 opencode/pi 的「扩展目录」语义不同 —— `InstallShape` 负责区分这个差异）。
#[must_use]
pub fn claude_config_dir() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        // 同 XDG 的绝对路径要求：相对值会让 install 与 status 指向不同地方。
        Some(dir) if Path::new(&dir).is_absolute() => Some(PathBuf::from(dir)),
        _ => dirs::home_dir().map(|h| h.join(".claude")),
    }
}

/// CodeBuddy 配置根（`~/.codebuddy`）。它是 Claude Code 的 fork（同 CLI 旗标、
/// 同 hooks schema），故与 claude 共用 `CLAUDE_COMPAT_ENTRIES`。
#[must_use]
pub fn codebuddy_config_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codebuddy"))
}

/// Qoder 配置根（`~/.qoder`）。2026-10-16 spike 实证其 `settings.json` 的 `hooks` 键生效
/// （qodercli 二进制内含 `hooks migrate --from-claude`，迁移逻辑写
/// `g.set(["hooks", eventName, ...])` 到 `~/.qoder/settings.json`）。
#[must_use]
pub fn qoder_config_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".qoder"))
}

/// Codex 配置根（`~/.codex`）。`CODEX_HOME` 优先（官方支持的重定位变量）。
///
/// 这里返回的是**配置根目录**，`config.toml` 与 `hooks.json` 都落在其中；
/// 本任务只碰 `config.toml` 的 `notify` 键（`hooks.json` 因信任门不可自动化而放弃）。
#[must_use]
pub fn codex_config_dir() -> Option<PathBuf> {
    match std::env::var_os("CODEX_HOME") {
        // 同 XDG 的绝对路径要求：相对值会让 install 与 status 指向不同地方。
        Some(dir) if Path::new(&dir).is_absolute() => Some(PathBuf::from(dir)),
        _ => dirs::home_dir().map(|h| h.join(".codex")),
    }
}
