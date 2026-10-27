//! 受管 hook 的**状态查询**：`installed` / `version_current` / `trusted` 三态的判定。
//!
//! 只读 —— 不创建目录、不写文件（`status` 被设置页在渲染期调用，任何副作用都是 bug）。
//!
//! 拆分自原 `agent/hooks/writers.rs`（单文件 7 职责，违反高内聚）。
//! 本文件只承载**一个**职责；跨切片共享的判据住在同级模块，不在此复制。

use std::path::Path;

use serde_json::Value;

use crate::agent::hooks::install::config::json::entry_command;
use crate::agent::hooks::install::json_file::read_json;
use crate::agent::hooks::install::trust;
use crate::agent::hooks::targets::{HookTarget, InstallShape, HOOK_TARGETS};

use crate::agent::hooks::install::outcome::HookInstallStatus;
use crate::agent::hooks::install::shape::notify_argv::notify_argv_status;
use crate::agent::hooks::install::shape::structured::structured_commands;
use crate::agent::hooks::install::shim::ownership::{ownership_of_target, shim_path};

/// 各 CLI 的安装状态（设置页数据行；一个 CLI 一行，目录未建也如实回报未安装）。
#[must_use]
pub fn status_all() -> Vec<HookInstallStatus> {
    HOOK_TARGETS
        .iter()
        .map(|target| match (target.dir)() {
            Some(dir) => status_at(target, &dir),
            None => HookInstallStatus {
                source: target.source.to_string(),
                path: String::new(),
                installed: false,
                version_current: false,
                // 目录都定位不到 ≠ 自供源：它仍可被安装（只是本机没有该 CLI）。
                self_supplied: target.shapes.is_empty(),
                // 目录都定位不到：不报「未信任」（那是误导），报不适用。
                trusted: None,
            },
        })
        .collect()
}

/// 单个 CLI 的状态（`status_all` 的单行内核；目录由调用方给定，故可 tempdir 直测）。
#[must_use]
pub(crate) fn status_at(target: &HookTarget, dir: &Path) -> HookInstallStatus {
    let file = shim_path(target, dir);
    let (installed, version_current) = shape_status(target, dir);
    // 该 CLI 的 `trusted` 态：所有面都无需信任，或用户在 CLI 侧已确认过。
    // 只有 Codex 的 `hooks.json` 面需要 —— 判据是 `config.toml` 的 `[hooks.state]` 里
    // 出现过我们自己 hooks.json 的键（Codex 只在用户确认后写它）。**只读探测**。
    HookInstallStatus {
        source: target.source.to_string(),
        path: file.display().to_string(),
        installed,
        version_current,
        self_supplied: target.shapes.is_empty(),
        trusted: trust_status(target, dir),
    }
}

/// 一个 target 的**全部面**聚合状态。
///
/// `installed` = **每个面都在位**（部分面缺失 = 整体未完成 —— 否则用户看到「已安装」
/// 却收不到某类通知，正是「装了但没通知」的复发形态）。
/// `version_current` 同理，且只在 `installed` 为真时才有意义。
fn shape_status(target: &HookTarget, dir: &Path) -> (bool, bool) {
    let mut installed = !target.shapes.is_empty();
    let mut current = true;
    for shape in target.shapes {
        let (i, c) = match shape {
            InstallShape::Standalone => standalone_status(target, dir),
            InstallShape::Structured {
                settings_file,
                root_key,
                ..
            } => structured_status(target, dir, settings_file, root_key),
            InstallShape::NotifyArgv {
                config_file,
                key,
                event_key,
            } => notify_argv_status(target, dir, config_file, key, event_key),
        };
        installed &= i;
        current &= c;
    }
    (installed, current)
}

/// 该 target 是否需要「CLI 侧信任」且尚未获得（三态，见 [`HookInstallStatus::trusted`]）。
///
/// 本函数只做**数据分发**：「哪个面需要信任」由 [`InstallShape::Structured::trust`] 声明，
/// 探测逻辑（CLI 无关）在 [`crate::agent::hooks::install::trust`]。此前这里硬编码 `"hooks.json"` / `"config.toml"`
/// 与 Codex 的键格式 —— 那是让通用写入器携带单个 CLI 的身份，加 CLI 必改本文件。
#[must_use]
pub(crate) fn trust_status(target: &HookTarget, dir: &Path) -> Option<bool> {
    // 取第一个带信任门的 `Structured` 面；无 = 该 CLI 无信任概念。
    let (settings_file, root_key, entries, spec) = target.shapes.iter().find_map(|s| match s {
        InstallShape::Structured {
            settings_file,
            root_key,
            entries,
            trust: Some(spec),
        } => Some((*settings_file, *root_key, *entries, spec)),
        _ => None,
    })?;
    Some(trust::probe(spec, dir, settings_file, root_key, entries))
}

/// `Standalone` 状态：只看受管文件本身。
fn standalone_status(target: &HookTarget, dir: &Path) -> (bool, bool) {
    if !dir.is_dir() {
        // 目录不存在 = 该 CLI 未在此机器初始化过配置面；状态查询不代创建（客人不喧宾）。
        return (false, false);
    }
    let ownership = ownership_of_target(target, dir);
    if !ownership.is_managed() {
        return (false, false);
    }
    (true, ownership.is_current())
}

/// `Structured` 状态：**文件面与配置面都要看**。
///
/// `installed` = shim 是自家受管文件 **且** 用户配置里至少有一条自家条目 ——
/// 只有 shim 没有条目（配置被用户手工清空）= 不生效，报未安装才诚实；
/// 只有条目没有 shim = 条目指向不存在的文件，同样不生效。
///
/// `version_current` = shim 标记当前 **且** 每条 entries 的 command 与当前渲染一致。
fn structured_status(
    target: &HookTarget,
    dir: &Path,
    settings_file: &str,
    root_key: &str,
) -> (bool, bool) {
    // 归属判据只算**一次**：原先同一入参被算两遍（`is_managed` 与 `version_current`），
    // 改判据时漏一处即静默不一致。
    let ownership = ownership_of_target(target, dir);
    if !ownership.is_managed() {
        return (false, false);
    }
    let Some(config) = read_json(&dir.join(settings_file)) else {
        return (false, false);
    };
    let Some(expected) = structured_commands(target, dir) else {
        return (false, false); // 无 node 等：无法判定为已安装
    };
    let mut any_present = false;
    let mut all_current = true;
    for (native_event, command) in &expected {
        let present = config
            .pointer(&format!("/{root_key}/{native_event}"))
            .and_then(Value::as_array)
            .is_some_and(|list| {
                list.iter()
                    .any(|e| entry_command(e) == Some(command.as_str()))
            });
        any_present |= present;
        all_current &= present;
    }
    (any_present, all_current && ownership.is_current())
}
