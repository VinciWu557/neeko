//! `InstallShape::Structured` 腿：独立 shim 文件 + 在用户既有 `settings.json` 里增删**自家**条目。
//!
//! 适用于 claude / codebuddy / qoder。合并算法在 `crate::agent::hooks::install::config::json`（纯 JSON 变换，零 IO）。
//!
//! 拆分自原 `agent/hooks/writers.rs`（单文件 7 职责，违反高内聚）。
//! 本文件只承载**一个**职责；跨切片共享的判据住在同级模块，不在此复制。

use std::path::Path;

use crate::agent::hooks::install::config::json::{self as json_merge, MergeAction, MergeOutcome};
use crate::agent::hooks::install::json_file::read_json;
use crate::agent::hooks::install::outcome::{outcome, HookApplyOutcome, HookApplyStatus};
use crate::agent::hooks::install::shim::config_io::write_user_json;
use crate::agent::hooks::install::shim::io::{
    remove_shim_file, shim_foreign_guard, shim_is_current, write_shim_if_stale,
};
use crate::agent::hooks::install::shim::ownership::{ownership_of_target, shim_path};
use crate::agent::hooks::targets::{HookEntry, HookTarget, InstallShape};

/// 读用户配置，区分「可安全创建」与「必须 fail-safe 跳过」两种 `None`。
///
/// 三种状态必须分开（都经过 `read_json` 的 `None`，但语义完全不同）：
///   ①文件**不存在** → 可安全创建（CLI 已安装、只是还没写过它）；
///   ②文件存在但**不可解析** → fail-safe 跳过（绝不覆盖用户内容）；
///   ③目录不存在 → CLI 未安装 → 跳过，绝不代建目录（客人不喧宾）。
enum Loaded {
    /// 可继续（磁盘上已有或被允许新建的空壳）。
    Ready(serde_json::Value),
    /// 应当跳过，附原因。
    Skip(String),
}

fn load_settings(dir: &Path, settings_path: &Path, root_key: &str) -> Loaded {
    match read_json(settings_path) {
        Some(config) => Loaded::Ready(config),
        None if !settings_path.exists() => {
            // ①实测（2026-10-16）：`~/.codex/` 通常存在（`config.toml` / `auth.json` /
            // `sessions/` 都在），但 `hooks.json` **往往不存在**。若沿用「文件不在就
            // Skipped」，审批面会**静默缺失**且设置页看不出。
            if !dir.is_dir() {
                return Loaded::Skip(format!("{} not found", settings_path.display()));
            }
            // 空壳：以该形态声明的根键起手，`json_merge::apply` 在其中插入事件键。
            Loaded::Ready(serde_json::json!({ root_key: {} }))
        }
        None => Loaded::Skip(format!(
            "{} not valid JSON; left untouched",
            settings_path.display()
        )),
    }
}

/// `Structured` 安装：写 shim 文件 + 在用户配置里插入自家条目。
///
/// 顺序刻意是「先算清楚再落盘」：
/// 1. 读并解析用户配置 —— 不存在 / 畸形 → `Skipped`，**不创建** CLI 的配置目录
///    （与 `Standalone` 的「客人不喧宾」同判据）；
/// 2. 在内存里逐条 merge —— 任一条命中 fail-safe（`Noop`）→ `Skipped`，**不写任何文件**
///    （避免留下「shim 已装但条目没进去」的半成品）；
/// 3. 全部条目都 `Unchanged` 且 shim 内容已当前 → `Unchanged`（幂等，零写盘）；
/// 4. 落盘：shim + 配置各一次原子写（保留原权限）。
#[must_use]
pub(crate) fn install_structured(
    target: &HookTarget,
    dir: &Path,
    settings_file: &str,
    root_key: &str,
    entries: &[HookEntry],
) -> HookApplyOutcome {
    let settings_path = dir.join(settings_file);
    let mut config = match load_settings(dir, &settings_path, root_key) {
        Loaded::Ready(config) => config,
        Loaded::Skip(detail) => return outcome(target, HookApplyStatus::Skipped, detail),
    };
    let Some(commands) = structured_commands(target, dir) else {
        return outcome(
            target,
            HookApplyStatus::Skipped,
            "cannot resolve node executable (shim needs a JS runtime)".to_string(),
        );
    };

    // 「客人不喧宾」：同名他人文件**一律不动**（含配置面 —— 不留「条目指向别人的脚本」）。
    // 必须在任何写盘之前判定，否则会先删/改用户文件再报失败。
    if let Some(skip) = shim_foreign_guard(target, dir) {
        return skip;
    }

    let mut changed = false;
    for (entry, (native_event, command)) in entries.iter().zip(&commands) {
        match json_merge::apply(
            &mut config,
            root_key,
            native_event,
            entry.matcher,
            command,
            MergeAction::Insert,
        ) {
            MergeOutcome::Changed => changed = true,
            MergeOutcome::Unchanged => {}
            // Insert 路径下 `Noop` 只可能来自 fail-safe（配置结构不可处理）。
            MergeOutcome::Noop | MergeOutcome::Removed => {
                return outcome(
                    target,
                    HookApplyStatus::Skipped,
                    format!("{settings_file} has an unsupported structure; left untouched"),
                );
            }
        }
    }

    let shim_current = shim_is_current(target, dir);
    if !changed && shim_current {
        return outcome(target, HookApplyStatus::Unchanged, String::new());
    }

    // 落盘（顺序：shim 先、配置后 —— 配置里的条目指向 shim，先有文件再有条目，
    // 避免「条目已生效但文件还没写」的窗口内 hook 调用失败）。
    match write_shim_if_stale(target, dir) {
        Ok(_) => {}
        Err(detail) => return outcome(target, HookApplyStatus::Failed, detail),
    }
    if changed {
        if let Err(detail) = write_user_json(&settings_path, settings_file, &config) {
            return outcome(target, HookApplyStatus::Failed, detail);
        }
    }
    outcome(target, HookApplyStatus::Applied, String::new())
}

/// `Structured` 卸载：从用户配置移除自家条目 + 删除 shim。
///
/// 用户配置不可读/畸形 → `Skipped`（宁可不删也不能破坏用户文件）；
/// shim 与条目都本就不存在 → `None`（不产生噪音行）。
#[must_use]
pub(crate) fn uninstall_structured(
    target: &HookTarget,
    dir: &Path,
    settings_file: &str,
    root_key: &str,
    entries: &[HookEntry],
) -> Option<HookApplyOutcome> {
    let settings_path = dir.join(settings_file);
    let shim_managed = ownership_of_target(target, dir).is_managed();

    let mut removed_any = false;
    if settings_path.is_file() {
        let Some(mut config) = read_json(&settings_path) else {
            return Some(outcome(
                target,
                HookApplyStatus::Skipped,
                format!(
                    "{} is not valid JSON; left untouched",
                    settings_path.display()
                ),
            ));
        };
        for entry in entries {
            match json_merge::apply(
                &mut config,
                root_key,
                entry.native_event,
                entry.matcher,
                // Remove 不消费 command（判定走 shim 标记），传空串即可。
                "",
                MergeAction::Remove,
            ) {
                MergeOutcome::Removed => removed_any = true,
                // Remove 路径下 `Changed` / `Unchanged` 不可能出现（`apply` 只在 Insert 路径
                // 返回 `Changed`），但 enum 是穷尽的 —— 显式列出以免未来改 `apply` 时静默漏处理。
                MergeOutcome::Changed | MergeOutcome::Unchanged | MergeOutcome::Noop => {}
            }
        }
        if removed_any {
            if let Err(detail) = write_user_json(&settings_path, settings_file, &config) {
                return Some(outcome(target, HookApplyStatus::Failed, detail));
            }
        }
    }

    if shim_managed {
        if let Err(detail) = remove_shim_file(target, dir) {
            return Some(outcome(target, HookApplyStatus::Failed, detail));
        }
    }

    if removed_any || shim_managed {
        Some(outcome(target, HookApplyStatus::Removed, String::new()))
    } else {
        None
    }
}

/// 该 target 的 `(native_event, 期望 command)` 清单；无 node 或 token 非法 → `None`。
#[must_use]
pub(crate) fn structured_commands(
    target: &HookTarget,
    dir: &Path,
) -> Option<Vec<(String, String)>> {
    // 一个 target 可有多个面；本函数只服务 `Structured` 面，取其中第一个
    // （形态上不会有两个 `Structured` 面共享同一 `file_name` —— 若未来出现，
    // 本函数需改为接收具体 shape）。
    let entries = target.shapes.iter().find_map(|s| match s {
        InstallShape::Structured { entries, .. } => Some(*entries),
        _ => None,
    })?;
    let shim = shim_path(target, dir);
    entries
        .iter()
        .map(|entry: &HookEntry| {
            let command = crate::platform::hook_command::render_report_command(
                &shim,
                target.source,
                entry.event_key,
            )?;
            Some((entry.native_event.to_string(), command))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::hooks::install::dispatch::{install_at, uninstall_at};
    use crate::agent::hooks::install::shim::ownership::{render, MANAGED_MARKER};
    use crate::agent::hooks::install::status::status_at;
    use crate::agent::hooks::install::test_support::*;

    /// AC5：目录不存在（用户配置面未初始化）→ `Skipped`，**不创建**目录、不写任何文件。
    #[test]
    fn structured_install_skips_when_settings_absent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let missing = tmp.path().join("no-claude-dir");
        let got = install_at(&structured_target(), &missing);
        assert_eq!(got.status, HookApplyStatus::Skipped, "{got:?}");
        assert!(!missing.exists(), "不得代创建 CLI 的配置目录");
    }

    /// 首次安装：shim 文件 + 用户配置条目同时落盘；他人条目逐字保留（AC3①）。
    #[test]
    fn structured_install_writes_shim_and_entry_preserving_others() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("settings.json"), &user_settings());
        let t = structured_target();

        let _node = with_node();
        let got = install_at(&t, tmp.path());
        assert_eq!(got.status, HookApplyStatus::Applied, "{got:?}");
        let shim = std::fs::read_to_string(tmp.path().join("neeko-status.mjs")).expect("shim");
        assert!(shim.starts_with(MANAGED_MARKER), "shim 必须带归属标记");

        let cfg = read_json(&tmp.path().join("settings.json")).expect("cfg");
        let list = cfg["hooks"]["PermissionRequest"].as_array().expect("array");
        assert_eq!(list.len(), 3, "两条他人 + 一条自家");
        assert_eq!(
            list[0]["hooks"][0]["command"],
            serde_json::json!("/Users/x/.orca/agent-hooks/claude-hook.sh"),
            "他人 command 条目必须逐字保留"
        );
        assert_eq!(
            list[1]["hooks"][0]["url"],
            serde_json::json!("http://127.0.0.1:23333/permission"),
            "他人 http 条目必须逐字保留"
        );
        assert_eq!(
            cfg["env"]["ANTHROPIC_BASE_URL"],
            serde_json::json!("https://example.invalid")
        );
        // `Stop` / `StopFailure` 也被写入（entries 三行）。
        assert!(cfg["hooks"].get("Stop").is_some());
        assert!(cfg["hooks"].get("StopFailure").is_some());
    }

    /// **创建缺失的 `settings_file`**（CLI 目录已在，只是没写过该文件）。
    ///
    /// 场景来源（2026-10-16 实测）：Codex 的 `~/.codex/` 通常存在
    /// （`config.toml` / `auth.json` / `sessions/` 都在），但 **`hooks.json` 往往不存在**。
    /// 若沿用「文件不在就 Skipped」，审批面会**静默缺失**且设置页看不出。
    ///
    /// 反证：把 `install_structured` 的「文件缺失即 Skipped」分支加回来，本用例必红。
    #[test]
    fn structured_install_creates_missing_settings_file_when_dir_exists() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // 目录已在（tempdir），settings.json 不在。
        assert!(!tmp.path().join("settings.json").exists());
        let _node = with_node();
        let got = install_at(&structured_target(), tmp.path());
        assert_eq!(got.status, HookApplyStatus::Applied, "{got:?}");
        let cfg = read_json(&tmp.path().join("settings.json")).expect("created");
        for evt in ["PermissionRequest", "Stop", "StopFailure"] {
            assert!(
                cfg.pointer(&format!("/hooks/{evt}")).is_some(),
                "新建的配置必须含 {evt}: {cfg}"
            );
        }
    }

    /// **不可解析 ≠ 不存在**：文件存在但内容非法 JSON → fail-safe 跳过，**绝不覆盖**。
    ///
    /// 反证：若把「缺失」与「不可解析」都归到一个「创建空壳」分支，用户的坏文件会被覆盖。
    #[test]
    fn structured_install_never_overwrites_unparseable_existing_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("settings.json"), "{ this is not json");
        let got = install_at(&structured_target(), tmp.path());
        assert_eq!(got.status, HookApplyStatus::Skipped, "{got:?}");
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("settings.json")).expect("read"),
            "{ this is not json",
            "用户内容必须逐字保留"
        );
        assert!(
            !tmp.path().join("neeko-status.mjs").exists(),
            "配置不可处理时不得留下 shim 半成品"
        );
    }

    /// 幂等：第二次安装 → `Unchanged`，两个文件都零改写。
    #[test]
    fn structured_install_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("settings.json"), &user_settings());
        let t = structured_target();
        let _node = with_node();
        assert_eq!(install_at(&t, tmp.path()).status, HookApplyStatus::Applied);

        let cfg_before = std::fs::read_to_string(tmp.path().join("settings.json")).expect("read");
        let shim_before =
            std::fs::read_to_string(tmp.path().join("neeko-status.mjs")).expect("read");
        assert_eq!(
            install_at(&t, tmp.path()).status,
            HookApplyStatus::Unchanged
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("settings.json")).expect("read"),
            cfg_before
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("neeko-status.mjs")).expect("read"),
            shim_before
        );
    }

    /// AC3② fail-safe：用户配置畸形（`hooks` 非对象）→ `Skipped`，**两个文件都不写**。
    ///
    /// 反证：若先写 shim 再 merge，本用例会发现 shim 文件被创建（半成品）。
    #[test]
    fn structured_install_leaves_everything_untouched_on_malformed_config() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let broken = serde_json::json!({ "hooks": "not-an-object" }).to_string();
        write_at(&tmp.path().join("settings.json"), &broken);
        let t = structured_target();

        let got = install_at(&t, tmp.path());
        assert_eq!(got.status, HookApplyStatus::Skipped, "{got:?}");
        assert!(
            !tmp.path().join("neeko-status.mjs").exists(),
            "配置不可处理时不得留下 shim 半成品"
        );
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("settings.json")).expect("read"),
            broken,
            "用户配置必须逐字不变"
        );
    }

    /// AC4 权限继承：改写 0600 的用户配置后仍为 0600（Unix）。
    #[cfg(unix)]
    #[test]
    fn structured_install_preserves_settings_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let settings = tmp.path().join("settings.json");
        write_at(&settings, &user_settings());
        std::fs::set_permissions(&settings, std::fs::Permissions::from_mode(0o600)).expect("chmod");

        let _node = with_node();
        assert_eq!(
            install_at(&structured_target(), tmp.path()).status,
            HookApplyStatus::Applied
        );
        let mode = std::fs::metadata(&settings)
            .expect("meta")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "用户文件的 0600 必须保留（不得降权）");
    }

    /// R3.5：`installed` 要求 shim **与** 条目同时在场。
    #[test]
    fn structured_status_requires_both_shim_and_entry() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("settings.json"), &user_settings());
        let t = structured_target();
        let _node = with_node();

        // 都没有 → 未安装。
        assert!(!status_at(&t, tmp.path()).installed);

        // 只有 shim（用户手工清空配置）→ 仍报未安装（不生效）。
        write_at(&tmp.path().join("neeko-status.mjs"), &render(t.template));
        assert!(!status_at(&t, tmp.path()).installed);

        // 补上条目 → 已安装且版本当前。
        assert_eq!(install_at(&t, tmp.path()).status, HookApplyStatus::Applied);
        let s = status_at(&t, tmp.path());
        assert!(s.installed && s.version_current, "{s:?}");
    }

    /// 只有条目、没有 shim → 未安装（条目指向不存在的文件，不生效）。
    #[test]
    fn structured_status_false_when_shim_missing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("settings.json"), &user_settings());
        let t = structured_target();
        let _node = with_node();
        assert_eq!(install_at(&t, tmp.path()).status, HookApplyStatus::Applied);
        std::fs::remove_file(tmp.path().join("neeko-status.mjs")).expect("rm shim");
        assert!(!status_at(&t, tmp.path()).installed);
    }

    /// AC5/R6.4 卸载：自家条目移除 + shim 删除，他人条目原样；再卸一次 → `None`。
    #[test]
    fn structured_uninstall_removes_entry_and_shim() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("settings.json"), &user_settings());
        let t = structured_target();
        let _node = with_node();
        assert_eq!(install_at(&t, tmp.path()).status, HookApplyStatus::Applied);

        let got = uninstall_at(&t, tmp.path()).expect("outcome");
        assert_eq!(got.status, HookApplyStatus::Removed, "{got:?}");
        assert!(
            !tmp.path().join("neeko-status.mjs").exists(),
            "shim 必须删除"
        );

        let cfg = read_json(&tmp.path().join("settings.json")).expect("cfg");
        let list = cfg["hooks"]["PermissionRequest"].as_array().expect("array");
        assert_eq!(list.len(), 2, "只剩他人两条");
        assert!(
            cfg["hooks"].get("Stop").is_none(),
            "自家专属事件键必须整键删除（不留空壳）"
        );
        assert_eq!(
            cfg["env"]["ANTHROPIC_BASE_URL"],
            serde_json::json!("https://example.invalid")
        );

        assert!(
            uninstall_at(&t, tmp.path()).is_none(),
            "再卸一次不产生回执行"
        );
    }

    /// 卸载时用户配置畸形 → `Skipped`（不删 shim 也不改配置，宁可不删不破坏）。
    #[test]
    fn structured_uninstall_skips_on_malformed_config() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(&tmp.path().join("settings.json"), "not json at all");
        let t = structured_target();
        write_at(&tmp.path().join("neeko-status.mjs"), &render(t.template));

        let got = uninstall_at(&t, tmp.path()).expect("outcome");
        assert_eq!(got.status, HookApplyStatus::Skipped, "{got:?}");
        assert!(
            tmp.path().join("neeko-status.mjs").is_file(),
            "配置不可读时不得删 shim（避免留下悬空条目）"
        );
    }

    /// **`Structured` 腿**的归属守卫（Block 3 修复）：用户在 `~/.claude/neeko-status.mjs`
    /// 放了自己的同名脚本 → 安装必须 `Skipped`，且**配置文件一个字节都不许动**。
    ///
    /// 反证（原缺口）：删掉 `install_structured` 里的 `shim_foreign_guard` 调用，
    /// 本用例会得到 `Applied` 且 shim 被覆盖 —— 而这正是 2026-10-16 修过的真实数据破坏缺陷。
    #[test]
    fn structured_leg_never_overwrites_a_foreign_shim() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let shim = tmp.path().join("neeko-status.mjs");
        let settings = tmp.path().join("settings.json");
        let user_cfg = user_settings();
        write_at(&shim, "// someone else's script\n");
        write_at(&settings, &user_cfg);

        let got = install_at(&structured_target(), tmp.path());
        assert_eq!(got.status, HookApplyStatus::Skipped, "{got:?}");
        assert!(
            std::fs::read_to_string(&shim)
                .expect("read")
                .contains("someone else"),
            "他人 shim 必须原样保留"
        );
        assert_eq!(
            std::fs::read_to_string(&settings).expect("read"),
            user_cfg,
            "判定发生在任何写盘之前 → 用户配置一个字节都不许动"
        );
    }
}
