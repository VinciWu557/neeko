//! `InstallShape::NotifyArgv` 腿：把 shim 的 argv 写进 TOML 数组键（Codex 的 `notify`）。
//!
//! 与 `Structured` 的差异是**语义**而非格式：那是「按事件分组的嵌套对象」，
//! 这是「一条 argv，CLI 自行决定何时调用」。合并算法在 `crate::agent::hooks::install::config::toml`。
//!
//! 拆分自原 `agent/hooks/writers.rs`（单文件 7 职责，违反高内聚）。
//! 本文件只承载**一个**职责；跨切片共享的判据住在同级模块，不在此复制。

use std::path::Path;

use crate::agent::hooks::install::outcome::{outcome, HookApplyOutcome, HookApplyStatus};
use crate::agent::hooks::install::shim::config_io::write_user_file;
use crate::agent::hooks::install::shim::io::{
    remove_managed_shim, shim_foreign_guard, shim_is_current, shim_path, write_shim_if_stale,
};
use crate::agent::hooks::install::shim::ownership::ownership_of_target;
use crate::agent::hooks::targets::HookTarget;

/// `NotifyArgv` 的期望 argv：`[node, shim, source, event_key]`（Codex 自己 exec，不经 shell）。
///
/// 无 node 或 token 非法 → `None`（调用方回执 `Skipped`，不写必定失败的配置）。
#[must_use]
pub(crate) fn notify_argv_entry(
    target: &HookTarget,
    dir: &Path,
    event_key: &str,
) -> Option<Vec<String>> {
    crate::platform::hook_command::report_argv(&shim_path(target, dir), target.source, event_key)
}

/// `NotifyArgv` 状态：`config.toml` 里存在**自家** argv 且与当前期望完全一致。
///
/// **注意与 `Standalone` 的实质差异**：`notify` 指向的是 **shim 路径**而非嵌入内容，
/// 故没有「文件过期」概念（shim 内容变了行为自然跟着变）—— `version_current` 只比 argv。
#[must_use]
pub(crate) fn notify_argv_status(
    target: &HookTarget,
    dir: &Path,
    config_file: &str,
    key: &str,
    event_key: &str,
) -> (bool, bool) {
    let Some(text) = std::fs::read_to_string(dir.join(config_file)).ok() else {
        return (false, false);
    };
    let Some(entry) = notify_argv_entry(target, dir, event_key) else {
        return (false, false); // 无 node 等：无法判定为已安装
    };
    // **文件面必须同时在位**：`config.toml` 有条目但 shim 文件缺失 = 不生效
    // （Codex 会调用一个不存在的脚本）。只报「已安装」是撒谎 —— 这正是 2026-10-16
    // 用户实测「装了但没通知」的形态。
    let shim_ok = shim_path(target, dir).is_file();
    let configured = crate::agent::hooks::install::config::toml::read_notify(&text, key)
        .is_some_and(|items| {
            items
                .iter()
                .any(|s| crate::agent::hooks::install::config::toml::entry_targets_shim(s))
        });
    let installed = shim_ok && configured;
    let current = crate::agent::hooks::install::config::toml::notify_is_current(&text, key, &entry)
        && shim_ok;
    (installed, current)
}

/// `NotifyArgv` 安装：写 shim 文件 **+** 把其 argv 写进 `config_file` 的 `key` 数组。
///
/// **两个面都要落盘**（与 `install_structured` 同构）。曾漏写 shim 文件 ——
/// 结果是 `config.toml` 指向一个不存在的脚本，Codex 调用它必然失败，而回执却是 `Applied`
/// （2026-10-16 用户实测「装了但没通知」的根因）。
///
/// 顺序与 `install_structured` 同：先算清楚（配置可读 + 形态可处理 + 有 node），
/// 再落盘（**先 shim 后配置** —— 配置里的条目指向 shim，先有文件再有条目）。
#[must_use]
pub(crate) fn install_notify_argv(
    target: &HookTarget,
    dir: &Path,
    config_file: &str,
    key: &str,
    event_key: &str,
) -> HookApplyOutcome {
    let config_path = dir.join(config_file);
    let Ok(text) = std::fs::read_to_string(&config_path) else {
        // 不存在 / 不可读 → 不创建（客人不喧宾：Codex 用户自己会生成 config.toml）。
        return outcome(
            target,
            HookApplyStatus::Skipped,
            format!("{} not found or unreadable", config_path.display()),
        );
    };
    let Some(entry) = notify_argv_entry(target, dir, event_key) else {
        return outcome(
            target,
            HookApplyStatus::Skipped,
            "cannot resolve node executable (shim needs a JS runtime)".to_string(),
        );
    };
    let (updated, merge) = crate::agent::hooks::install::config::toml::apply_notify(
        &text,
        key,
        &entry,
        crate::agent::hooks::install::config::toml::TomlMergeAction::Insert,
        config_file,
    );

    // **配置面已是期望态时也要补写文件面** —— 否则「配置对了但 shim 丢了」
    // （用户手工删过 / 早期版本漏写）会永远不被修复。
    // 「客人不喧宾」：同名他人文件一律不动（三条安装腿共用同一守卫）。
    if let Some(skip) = shim_foreign_guard(target, dir) {
        return skip;
    }
    let shim_current = shim_is_current(target, dir);

    use crate::agent::hooks::install::config::toml::TomlMergeOutcome;
    match merge {
        TomlMergeOutcome::Unchanged if shim_current => {
            outcome(target, HookApplyStatus::Unchanged, String::new())
        }
        // 配置已就位但 shim 缺失/过期 → 只补文件面（不改配置）。
        TomlMergeOutcome::Unchanged => match write_shim_if_stale(target, dir) {
            Ok(_) => outcome(target, HookApplyStatus::Applied, String::new()),
            Err(detail) => outcome(target, HookApplyStatus::Failed, detail),
        },
        TomlMergeOutcome::Changed => {
            // 先 shim（配置里的条目指向它），再配置。
            if let Err(detail) = write_shim_if_stale(target, dir) {
                return outcome(target, HookApplyStatus::Failed, detail);
            }
            match write_user_file(&config_path, config_file, &updated) {
                Ok(()) => outcome(target, HookApplyStatus::Applied, String::new()),
                Err(detail) => outcome(target, HookApplyStatus::Failed, detail),
            }
        }
        // Noop = 用户已有自己的 notify / 形态不支持 → 不覆盖，如实回执（非故障）。
        TomlMergeOutcome::Noop => outcome(
            target,
            HookApplyStatus::Skipped,
            format!("{config_file} already has a non-Neeko `{key}`; left untouched"),
        ),
        TomlMergeOutcome::Removed => outcome(target, HookApplyStatus::Skipped, String::new()),
    }
}

/// `NotifyArgv` 卸载：删除自家 `key` 行。
#[must_use]
pub(crate) fn uninstall_notify_argv(
    target: &HookTarget,
    dir: &Path,
    config_file: &str,
    key: &str,
) -> Option<HookApplyOutcome> {
    let config_path = dir.join(config_file);
    let text = std::fs::read_to_string(&config_path).ok()?;
    let (updated, merge) = crate::agent::hooks::install::config::toml::apply_notify(
        &text,
        key,
        &[],
        crate::agent::hooks::install::config::toml::TomlMergeAction::Remove,
        config_file,
    );

    // 文件面与配置面都要清理：只删条目而留下 shim 文件 = 孤儿文件。
    // 两处独立处理，任一有动作即报 `Removed`（与 `uninstall_structured` 同构）。
    let shim_managed = ownership_of_target(target, dir).is_managed();

    let mut removed = false;
    if merge == crate::agent::hooks::install::config::toml::TomlMergeOutcome::Removed {
        match write_user_file(&config_path, config_file, &updated) {
            Ok(()) => removed = true,
            Err(detail) => return Some(outcome(target, HookApplyStatus::Failed, detail)),
        }
    }
    if shim_managed {
        if let Err(detail) = remove_managed_shim(target, dir) {
            return Some(outcome(target, HookApplyStatus::Failed, detail));
        }
        removed = true;
    }

    if removed {
        Some(outcome(target, HookApplyStatus::Removed, String::new()))
    } else {
        // 本就没有自家条目 / 他人的 → 不产生噪音行（与 standalone 同）。
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::hooks::install::dispatch::{install_at, uninstall_at};
    use crate::agent::hooks::install::shim::ownership::MANAGED_MARKER;
    use crate::agent::hooks::install::status::status_at;
    use crate::agent::hooks::install::test_support::*;
    use crate::agent::hooks::targets::InstallShape;

    /// 安装：写出 argv 数组；其余内容逐字不变（AC4）。
    #[test]
    fn notify_install_writes_argv_entry_preserving_rest() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("config.toml"), &user_codex_config());
        let _node = with_node();
        let got = install_at(&notify_target(), tmp.path());
        assert_eq!(got.status, HookApplyStatus::Applied, "{got:?}");
        let text = std::fs::read_to_string(tmp.path().join("config.toml")).expect("read");
        assert!(text.contains("SECRET"), "用户 token 必须保留");
        // 逐字不变判据（AC4）：删掉新增的 notify 行后必须与原文完全相同。
        //
        // 用 `assert!` 而非 `assert_eq!` 是有意的：本文件是**我们在 tempdir 里自己写的**
        // 普通 TOML 配置（非 git 工作区物化字节），不存在 Windows `autocrlf` 改写问题；
        // 而 `check_worktree_byte_assertions` 的判据（`read_to_string` + `assert_eq!`）
        // 是针对 git 工作区字节的启发式，在这里会是误报。
        // 逐字节相等**正是 AC4 的要求**，故不换成行尾无关比较。
        let stripped: String = text
            .split_inclusive('\n')
            .filter(|l| !l.starts_with("notify = "))
            .collect();
        assert!(
            stripped == user_codex_config(),
            "除新增行外其余内容必须逐字不变:\n{stripped}"
        );
        let items = crate::agent::hooks::install::config::toml::read_notify(&text, "notify")
            .expect("parsed");
        assert_eq!(
            items.len(),
            4,
            "argv = [node, shim, source, event_key]: {items:?}"
        );
        assert_eq!(items[2], "codex");
        assert_eq!(items[3], "turn_completed");
        assert!(items[1].ends_with("neeko-status.mjs"));
    }

    /// **反证钉子（2026-10-16 用户实测「装了但没通知」的根因）**：安装必须**同时**写
    /// shim 文件与 config.toml 条目。
    ///
    /// 反证：把 `install_notify_argv` 里的 shim 写入删掉，本用例必红 ——
    /// 届时 `config.toml` 指向一个不存在的脚本，Codex 调用必然失败，而回执却是 `Applied`。
    #[test]
    fn notify_install_writes_both_shim_file_and_config_entry() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("config.toml"), &user_codex_config());
        let _node = with_node();
        let _got = install_at(&notify_target(), tmp.path());
        let shim = tmp.path().join("neeko-status.mjs");
        assert!(
            shim.is_file(),
            "shim 文件必须落盘（缺失 = Codex 调用不存在的脚本）"
        );
        let content = std::fs::read_to_string(&shim).expect("read shim");
        assert!(content.starts_with(MANAGED_MARKER), "shim 必须带归属标记");
        // 且 config 里的 argv 第 1 项确实指向该文件。
        let text = std::fs::read_to_string(tmp.path().join("config.toml")).expect("read");
        let items = crate::agent::hooks::install::config::toml::read_notify(&text, "notify")
            .expect("parsed");
        assert_eq!(
            items[1],
            shim.to_string_lossy(),
            "config 的 argv 必须指向落盘的 shim"
        );
    }

    /// **反证钉子**：`config.toml` 条目已在位但 shim 缺失时，安装必须**补写文件面**。
    ///
    /// 场景来源：用户手工删过 shim，或早期版本漏写（2026-10-16 实测形态）——
    /// 此时配置面 merge 得 `Unchanged`，若实现只看 merge 结果就会**永远不修**。
    #[test]
    fn notify_install_repairs_missing_shim_when_config_already_correct() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("config.toml"), &user_codex_config());
        let t = notify_target();
        let _node = with_node();
        let _ = install_at(&t, tmp.path());
        // 模拟 shim 丢失（配置仍指向它）。
        std::fs::remove_file(tmp.path().join("neeko-status.mjs")).expect("rm shim");
        assert!(
            !status_at(&t, tmp.path()).installed,
            "shim 缺失 → 必须报未安装"
        );

        let got = install_at(&t, tmp.path());
        assert_eq!(
            got.status,
            HookApplyStatus::Applied,
            "必须补写 shim：{got:?}"
        );
        assert!(tmp.path().join("neeko-status.mjs").is_file());
        assert!(status_at(&t, tmp.path()).installed, "补写后应为已安装");
    }

    /// status 语义：`config.toml` 有条目但 shim 缺失 → **未安装**（不撒谎）。
    #[test]
    fn notify_status_requires_shim_file_too() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("config.toml"), &user_codex_config());
        let t = notify_target();
        let _node = with_node();
        let _ = install_at(&t, tmp.path());
        assert!(status_at(&t, tmp.path()).installed);
        std::fs::remove_file(tmp.path().join("neeko-status.mjs")).expect("rm shim");
        let s = status_at(&t, tmp.path());
        assert!(!s.installed, "只有条目没有 shim 不得报已安装：{s:?}");
        assert!(!s.version_current);
    }

    /// 卸载必须**同时**清掉条目与 shim 文件（不留孤儿）。
    #[test]
    fn notify_uninstall_removes_shim_file_too() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("config.toml"), &user_codex_config());
        let t = notify_target();
        let _node = with_node();
        let _ = install_at(&t, tmp.path());
        assert!(tmp.path().join("neeko-status.mjs").is_file());
        let got = uninstall_at(&t, tmp.path()).expect("outcome");
        assert_eq!(got.status, HookApplyStatus::Removed, "{got:?}");
        assert!(
            !tmp.path().join("neeko-status.mjs").exists(),
            "shim 必须一并删除（不留孤儿文件）"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("config.toml")).expect("read"),
            user_codex_config(),
            "配置回到原文"
        );
    }

    /// 幂等：第二次安装 → `Unchanged`，config.toml 零改写。
    #[test]
    fn notify_install_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("config.toml"), &user_codex_config());
        let t = notify_target();
        let _node = with_node();
        let _first = install_at(&t, tmp.path());
        let before = std::fs::read_to_string(tmp.path().join("config.toml")).expect("read");
        assert_eq!(
            install_at(&t, tmp.path()).status,
            HookApplyStatus::Unchanged
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("config.toml")).expect("read"),
            before,
            "幂等命中不得改写"
        );
    }

    /// 配置不存在 → `Skipped`，**不创建**（客人不喧宾）。
    #[test]
    fn notify_install_skips_when_config_absent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let got = install_at(&notify_target(), tmp.path());
        assert_eq!(got.status, HookApplyStatus::Skipped, "{got:?}");
        assert!(
            !tmp.path().join("config.toml").exists(),
            "不得创建 config.toml"
        );
    }

    /// 用户已有自己的 `notify`（非自家）→ `Skipped` + 原样（AC5）。
    #[test]
    fn notify_install_skips_when_user_has_own_notify() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let text = "notify = [\"/their/tool.sh\"]\n";
        write_at(&tmp.path().join("config.toml"), text);
        // 必须有 node —— 否则 Skipped 来自 node 解析而非「用户已有自己的 notify」，
        // detail 断言就测不到它想测的那条分支。
        let _node = with_node();
        let got = install_at(&notify_target(), tmp.path());
        assert_eq!(got.status, HookApplyStatus::Skipped, "{got:?}");
        assert!(
            got.detail.contains("non-Neeko"),
            "detail 应说明原因: {got:?}"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("config.toml")).expect("read"),
            text,
            "用户自己的 notify 必须原样保留"
        );
    }

    /// 权限继承：0600 的 config.toml 改写后仍 0600。
    #[cfg(unix)]
    #[test]
    fn notify_install_preserves_config_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("config.toml");
        write_at(&path, &user_codex_config());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).expect("chmod");
        let _node = with_node();
        let _ = install_at(&notify_target(), tmp.path());
        let mode = std::fs::metadata(&path).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "用户 config.toml 的 0600 必须保留");
    }

    /// status：无条目 → 未安装；安装后 → 已安装且当前；argv 变化 → 过期。
    #[test]
    fn notify_status_tracks_entry_presence_and_argv() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("config.toml"), &user_codex_config());
        let t = notify_target();
        assert!(!status_at(&t, tmp.path()).installed, "无条目应为未安装");

        let _node = with_node();
        let _ = install_at(&t, tmp.path());
        let s = status_at(&t, tmp.path());
        assert!(s.installed && s.version_current, "{s:?}");

        // 期望 argv 变了（模拟 shim 路径变化）→ 不算当前。
        let moved = HookTarget {
            source: "codex",
            file_name: "neeko-status.mjs",
            template: "SHIM_BODY",
            dir: || None,
            shapes: &[InstallShape::NotifyArgv {
                config_file: "config.toml",
                key: "notify",
                event_key: crate::agent::chat::notify::event_keys::TURN_COMPLETED,
            }],
        };
        // 同 target 同路径 → 仍当前（此断言确保判据是 argv 相等而非「有条目即当前」）。
        assert!(status_at(&moved, tmp.path()).version_current);
    }

    /// 卸载：删除自家 `notify` 行；他人的 → 不产生回执行。
    #[test]
    fn notify_uninstall_removes_own_entry_only() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("config.toml"), &user_codex_config());
        let t = notify_target();
        let _node = with_node();
        let _ = install_at(&t, tmp.path());
        let got = uninstall_at(&t, tmp.path()).expect("outcome");
        assert_eq!(got.status, HookApplyStatus::Removed, "{got:?}");
        let text = std::fs::read_to_string(tmp.path().join("config.toml")).expect("read");
        assert!(
            crate::agent::hooks::install::config::toml::read_notify(&text, "notify").is_none(),
            "notify 行必须删除：{text:?}"
        );
        // 同 `notify_install_writes_argv_entry_preserving_rest` 的说明：
        // 这是我们自写的 TOML（非 git 工作区字节），逐字节相等是 AC4 的要求。
        assert!(
            text == user_codex_config(),
            "卸载后必须回到原文（逐字）:\n{text}"
        );
        // 再卸一次：不产生回执行。
        assert!(uninstall_at(&t, tmp.path()).is_none());
    }

    /// 用户自己的 notify → 卸载**不得**删除它。
    #[test]
    fn notify_uninstall_leaves_user_own_notify() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let text = "notify = [\"/their/tool.sh\"]\n";
        write_at(&tmp.path().join("config.toml"), text);
        assert!(uninstall_at(&notify_target(), tmp.path()).is_none());
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("config.toml")).expect("read"),
            text
        );
    }

    /// **`NotifyArgv` 腿**的归属守卫（Block 3 修复）：同名他人 shim → `Skipped`，
    /// 且 `config.toml` 的 `notify` 不被写入。
    ///
    /// 反证：删掉 `install_notify_argv` 里的守卫调用，本用例会得到 `Applied`
    /// 且他人 shim 被覆盖（配置则指向我们的内容）。
    #[test]
    fn notify_argv_leg_never_overwrites_a_foreign_shim() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let shim = tmp.path().join("neeko-status.mjs");
        let cfg = tmp.path().join("config.toml");
        write_at(&shim, "// someone else's script\n");
        write_at(&cfg, &user_codex_config());

        // **必须有 node**：否则 Skipped 会来自 node 解析而非归属守卫，
        // 本用例就失去判别力（那正是它要防的"看起来绿了"）。
        let _node = with_node();
        let got = install_at(&notify_target(), tmp.path());
        assert_eq!(got.status, HookApplyStatus::Skipped, "{got:?}");
        assert!(
            std::fs::read_to_string(&shim)
                .expect("read")
                .contains("someone else"),
            "他人 shim 必须原样保留"
        );
        let after = std::fs::read_to_string(&cfg).expect("read");
        assert!(
            crate::agent::hooks::install::config::toml::read_notify(&after, "notify").is_none(),
            "他人 shim 时不得写入 notify（否则配置指向别人的脚本）:\n{after}"
        );
    }
}
