//! 安装 / 卸载的**面聚合与分派**：按 `InstallShape` 选择实现腿，并把多面回执聚合为一条。
//!
//! 本模块是「一个 CLI 的多个配置面」这一事实的**唯一**处理点 —— 形态分派只在这里发生。
//!
//! 拆分自原 `agent/hooks/writers.rs`（单文件 7 职责，违反高内聚）。
//! 本文件只承载**一个**职责；跨切片共享的判据住在同级模块，不在此复制。

use std::path::Path;

use crate::agent::hooks::install::outcome::{outcome, HookApplyOutcome, HookApplyStatus};
use crate::agent::hooks::install::shape::notify_argv::{
    install_notify_argv, uninstall_notify_argv,
};
use crate::agent::hooks::install::shape::standalone::{install_standalone, uninstall_standalone};
use crate::agent::hooks::install::shape::structured::{install_structured, uninstall_structured};
use crate::agent::hooks::targets::{HookTarget, InstallShape};

/// 安装**全部面**（一个 CLI 可有多个配置面）。结果聚合为一条回执。
///
/// 聚合规则（`combine_outcomes`）：任一 `Failed` → 整体 `Failed`；
/// 否则任一 `Applied` → `Applied`；否则任一 `Skipped` → `Skipped`；否则 `Unchanged`。
/// `detail` 汇总各面的非空说明（多面时用户需要知道**哪个面**出了问题）。
#[must_use]
pub(crate) fn install_at(target: &HookTarget, dir: &Path) -> HookApplyOutcome {
    let outcomes: Vec<HookApplyOutcome> = target
        .shapes
        .iter()
        .map(|shape| match shape {
            InstallShape::Standalone => install_standalone(target, dir),
            InstallShape::Structured {
                settings_file,
                root_key,
                entries,
                ..
            } => install_structured(target, dir, settings_file, root_key, entries),
            InstallShape::NotifyArgv {
                config_file,
                key,
                event_key,
            } => install_notify_argv(target, dir, config_file, key, event_key),
        })
        .collect();
    combine_outcomes(target, outcomes)
}

/// 多个面的回执 → 一条（见 [`install_at`] 的聚合规则）。
#[must_use]
pub(crate) fn combine_outcomes(
    target: &HookTarget,
    outcomes: Vec<HookApplyOutcome>,
) -> HookApplyOutcome {
    if outcomes.is_empty() {
        return outcome(target, HookApplyStatus::Unchanged, String::new());
    }
    let status = if outcomes.iter().any(|o| o.status == HookApplyStatus::Failed) {
        HookApplyStatus::Failed
    } else if outcomes
        .iter()
        .any(|o| o.status == HookApplyStatus::Applied)
    {
        HookApplyStatus::Applied
    } else if outcomes
        .iter()
        .any(|o| o.status == HookApplyStatus::Skipped)
    {
        HookApplyStatus::Skipped
    } else if outcomes
        .iter()
        .any(|o| o.status == HookApplyStatus::Removed)
    {
        HookApplyStatus::Removed
    } else {
        HookApplyStatus::Unchanged
    };
    // detail：汇总各面非空说明；单面时原样（不加前缀，保持既有文案稳定）。
    let details: Vec<&str> = outcomes
        .iter()
        .map(|o| o.detail.as_str())
        .filter(|d| !d.is_empty())
        .collect();
    let detail = if outcomes.len() == 1 {
        details.first().copied().unwrap_or_default().to_string()
    } else {
        details.join("; ")
    };
    outcome(target, status, detail)
}

/// 卸载**全部面**；返回 `None` = 所有面本就没有自家痕迹（不产生噪音回执行）。
#[must_use]
pub(crate) fn uninstall_at(target: &HookTarget, dir: &Path) -> Option<HookApplyOutcome> {
    let outcomes: Vec<HookApplyOutcome> = target
        .shapes
        .iter()
        .filter_map(|shape| match shape {
            InstallShape::Standalone => uninstall_standalone(target, dir),
            InstallShape::Structured {
                settings_file,
                root_key,
                entries,
                ..
            } => uninstall_structured(target, dir, settings_file, root_key, entries),
            InstallShape::NotifyArgv {
                config_file, key, ..
            } => uninstall_notify_argv(target, dir, config_file, key),
        })
        .collect();
    if outcomes.is_empty() {
        return None;
    }
    Some(combine_outcomes(target, outcomes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::hooks::install::json_file::read_json;
    use crate::agent::hooks::install::outcome::HookApplyOutcome;
    use crate::agent::hooks::install::status::status_at;
    use crate::agent::hooks::install::test_support::*;

    /// **面聚合**：安装两个面都落盘（shim + config.toml 的 notify + hooks.json 的 3 条条目）。
    ///
    /// 反证：若 `install_at` 只处理第一个面（早期单 `shape` 实现的形态），
    /// `hooks.json` 不会被创建 → 本用例必红（审批通知静默失效）。
    #[test]
    fn dual_face_install_writes_every_face() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("config.toml"), &user_codex_config());
        write_at(&tmp.path().join("hooks.json"), "{}");
        let _node = with_node();
        let got = install_at(&dual_face_target(), tmp.path());
        assert_eq!(got.status, HookApplyStatus::Applied, "{got:?}");
        assert!(tmp.path().join("neeko-status.mjs").is_file(), "shim");
        let cfg = std::fs::read_to_string(tmp.path().join("config.toml")).expect("read");
        assert!(
            crate::agent::hooks::install::config::toml::read_notify(&cfg, "notify").is_some(),
            "面1 notify 必须在"
        );
        let hooks = read_json(&tmp.path().join("hooks.json")).expect("hooks.json");
        for evt in ["PermissionRequest", "Stop", "StopFailure"] {
            assert!(
                hooks.pointer(&format!("/hooks/{evt}")).is_some(),
                "面2 hooks.json 必须含 {evt}（审批通知的来源）"
            );
        }
    }

    /// **面聚合**：卸载清掉两个面。
    #[test]
    fn dual_face_uninstall_clears_every_face() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("config.toml"), &user_codex_config());
        write_at(&tmp.path().join("hooks.json"), "{}");
        let t = dual_face_target();
        let _node = with_node();
        let _ = install_at(&t, tmp.path());
        let got = uninstall_at(&t, tmp.path()).expect("outcome");
        assert_eq!(got.status, HookApplyStatus::Removed, "{got:?}");
        assert!(!tmp.path().join("neeko-status.mjs").exists(), "shim 必须删");
        let cfg = std::fs::read_to_string(tmp.path().join("config.toml")).expect("read");
        assert!(
            crate::agent::hooks::install::config::toml::read_notify(&cfg, "notify").is_none(),
            "面1 notify 必须清"
        );
        let hooks = read_json(&tmp.path().join("hooks.json")).expect("hooks.json");
        assert!(
            hooks.pointer("/hooks/PermissionRequest").is_none(),
            "面2 条目必须清"
        );
    }

    /// **面聚合**：任一缺失 → 整体 `installed == false`。
    ///
    /// 这是「装了但没通知」的防线：只报部分面就位等于撒谎。
    #[test]
    fn partial_faces_report_not_installed() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("config.toml"), &user_codex_config());
        write_at(&tmp.path().join("hooks.json"), "{}");
        let t = dual_face_target();
        let _node = with_node();
        let _ = install_at(&t, tmp.path());
        assert!(status_at(&t, tmp.path()).installed, "全在 → 已安装");

        // 抽掉 hooks.json 的条目（模拟用户手工清空第二个面）→ 整体必须报未安装。
        write_at(&tmp.path().join("hooks.json"), "{}");
        let s = status_at(&t, tmp.path());
        assert!(
            !s.installed,
            "缺第二个面必须报未安装（否则用户以为审批通知也生效）: {s:?}"
        );
    }

    /// 面聚合的优先级：`Failed` > `Applied` > `Skipped` > `Unchanged`；detail 汇总。
    #[test]
    fn combine_outcomes_uses_strictest_status() {
        let t = dual_face_target();
        let o = |status| HookApplyOutcome {
            source: "codex".into(),
            status,
            detail: String::new(),
        };
        // 任一 Failed 胜出（即使另一个 Applied）。
        assert_eq!(
            combine_outcomes(
                &t,
                vec![o(HookApplyStatus::Applied), o(HookApplyStatus::Failed)]
            )
            .status,
            HookApplyStatus::Failed
        );
        // Applied 胜 Skipped。
        assert_eq!(
            combine_outcomes(
                &t,
                vec![o(HookApplyStatus::Skipped), o(HookApplyStatus::Applied)]
            )
            .status,
            HookApplyStatus::Applied
        );
        // 全 Unchanged → Unchanged。
        assert_eq!(
            combine_outcomes(
                &t,
                vec![o(HookApplyStatus::Unchanged), o(HookApplyStatus::Unchanged)]
            )
            .status,
            HookApplyStatus::Unchanged
        );
        // detail 汇总各面非空说明（用户需要知道**哪个面**出了问题）。
        let with_details = vec![
            HookApplyOutcome {
                source: "codex".into(),
                status: HookApplyStatus::Skipped,
                detail: "config.toml already has a non-Neeko `notify`; left untouched".into(),
            },
            HookApplyOutcome {
                source: "codex".into(),
                status: HookApplyStatus::Applied,
                detail: String::new(),
            },
        ];
        let got = combine_outcomes(&t, with_details);
        assert!(got.detail.contains("non-Neeko"), "detail 应汇总: {got:?}");
    }
}
