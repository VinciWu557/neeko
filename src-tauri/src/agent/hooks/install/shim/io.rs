//! shim 文件的落盘 / 删除 —— 三条安装腿与三条卸载腿的**唯一实现点**。
//!
//! # 为什么单独一个模块
//!
//! 「渲染期望内容 → 读现状 → 内容一致则不写 → 否则原子写」这段序列此前在
//! `Standalone` / `Structured` / `NotifyArgv` 三条腿里各写了一遍，失败样板
//! （`write shim: {err}` → `Failed`）出现 4 次。这不是风格问题：
//!
//! - `install_standalone` 当时用的是**裸 `std::fs::write`**，另两条腿用原子写 +
//!   权限继承 —— 同一契约三种写法，其中一种不是原子的（读者可见半截文件）；
//! - shim 写入恰是 2026-10-16「装了但没通知」的根因（配置指向的 shim 没落盘），
//!   单源化后这类缺陷只有一个地方能犯。
//!
//! 归属守卫（[`crate::agent::hooks::install::shim::ownership::shim_foreign_guard`]）**刻意不并入本模块**：
//! 三条腿需要它在**不同时点**执行（`structured` 必须在内存合并之前判定，
//! 否则会先改用户配置再报失败），故守卫仍是各腿显式调用的一步，写入是本模块的事。

use std::path::Path;

use crate::agent::hooks::install::outcome::{outcome, HookApplyOutcome, HookApplyStatus};
use crate::agent::hooks::install::shim::ownership::{content_token, ownership_of, render};
use crate::agent::hooks::targets::HookTarget;

/// shim 的绝对路径（定义在最低层 [`crate::agent::hooks::install::shim::ownership::shim_path`]，此处 re-export
/// 让三条腿只需 import 一个模块）。
pub(crate) use crate::agent::hooks::install::shim::ownership::shim_path;

/// shim 的期望内容（标记头 + 模板正文）。
#[must_use]
pub(crate) fn shim_content(target: &HookTarget) -> String {
    render(target.template)
}

/// shim 文件是否已是期望内容。
#[must_use]
pub(crate) fn shim_is_current(target: &HookTarget, dir: &Path) -> bool {
    let expected = shim_content(target);
    std::fs::read_to_string(shim_path(target, dir)).is_ok_and(|existing| existing == expected)
}

/// 写 shim 前的**统一归属守卫**：文件已存在且**不是**自家受管文件 → 拒绝覆盖。
///
/// # 为什么必须是一个共享函数
///
/// 「客人不喧宾」是三条安装腿（`Standalone` / `Structured` / `NotifyArgv`）**共同的**契约：
/// 用户在 `~/.claude/neeko-status.mjs` 放了自己的同名脚本时，任何一条腿覆盖它都是数据破坏。
/// 此前只有 `install_standalone` 有这道守卫，另两条腿直接写 —— 同一契约三个实现点里
/// 漏了两个。抽成单点后，「三条腿语义一致」由**调用点存在性**保证，而非靠审查记得住。
///
/// 返回值语义刻意做成 `Option<Outcome>` 而非 `bool`：调用方需要把**同一句**用户可见文案
/// 回执出去（`{file} exists and is not Neeko-managed`），让回执的书写点也只有一个。
///
/// 返回 `Some(回执)` = 应当跳过（他人资产）；`None` = 可以写。
#[must_use]
pub(crate) fn shim_foreign_guard(target: &HookTarget, dir: &Path) -> Option<HookApplyOutcome> {
    let path = shim_path(target, dir);
    if path.is_file() && !ownership_of(&path, &content_token(target.template)).is_managed() {
        return Some(outcome(
            target,
            HookApplyStatus::Skipped,
            format!("{} exists and is not Neeko-managed", target.file_name),
        ));
    }
    None
}

/// 把 shim 对齐到期望内容：**内容已一致则零写盘**（避免 mtime 抖动引起 CLI 无谓重载）。
///
/// 返回 `Ok(true)` = 本次写了盘；`Ok(false)` = 已是最新，未触碰。
/// `Err(detail)` = 写入失败（已格式化为可直接放进回执的文案）。
///
/// 调用方**必须先**执行归属守卫 —— 本函数无条件覆盖已存在的文件，守卫是它的前置条件。
pub(crate) fn write_shim_if_stale(target: &HookTarget, dir: &Path) -> Result<bool, String> {
    let path = shim_path(target, dir);
    let content = shim_content(target);
    if std::fs::read_to_string(&path).is_ok_and(|existing| existing == content) {
        return Ok(false);
    }
    match crate::platform::private_file::write_atomic_preserving_mode(&path, &content) {
        Ok(()) => Ok(true),
        Err(err) => Err(format!("write shim: {err}")),
    }
}

/// 删除 shim —— **只在它是自家受管文件时**。
///
/// 返回 `Ok(true)` = 已删除；`Ok(false)` = 文件不存在或属于他人（**未触碰**，非故障）。
///
/// 「他人文件不删」与「他人文件不写」（[`crate::agent::hooks::install::shim::ownership::shim_foreign_guard`]）是
/// 同一条客人义务的两半：删除同样是数据破坏。
pub(crate) fn remove_managed_shim(target: &HookTarget, dir: &Path) -> Result<bool, String> {
    let path = shim_path(target, dir);
    if !path.is_file() {
        return Ok(false);
    }
    if !ownership_of(&path, &content_token(target.template)).is_managed() {
        return Ok(false);
    }
    remove_shim_file(target, dir).map(|()| true)
}

/// 无条件删除 shim 文件（调用方**必须已**确认归属）。
///
/// 仅供 [`remove_managed_shim`] 与需要区分「他人资产」文案的调用方（`Standalone` 腿）
/// 使用 —— 后者要先给用户「该文件不是 Neeko 装的，已保留」这条提示。
pub(crate) fn remove_shim_file(target: &HookTarget, dir: &Path) -> Result<(), String> {
    let path = shim_path(target, dir);
    std::fs::remove_file(&path).map_err(|err| format!("remove shim: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::agent::hooks::install::test_support::target;

    /// 首次写入 → `true`；内容一致 → `false`（零写盘，幂等）；模板变 → 再写。
    #[test]
    fn write_shim_if_stale_is_idempotent_and_content_addressed() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let t = target("neeko-status.mjs");

        assert!(write_shim_if_stale(&t, tmp.path()).expect("first"));
        assert_eq!(
            std::fs::read_to_string(shim_path(&t, tmp.path())).expect("read"),
            render("BODY")
        );
        assert!(
            !write_shim_if_stale(&t, tmp.path()).expect("second"),
            "内容一致必须零写盘"
        );

        // 模板正文变（同版本号）→ 内容寻址的标记随之变 → 必须重写。
        let changed = HookTarget {
            template: "BODY2",
            ..target("neeko-status.mjs")
        };
        assert!(write_shim_if_stale(&changed, tmp.path()).expect("third"));
        assert!(shim_is_current(&changed, tmp.path()));
        assert!(!shim_is_current(&t, tmp.path()));
    }

    /// 删除：他人文件**不动**且不报错；自家文件删掉并报告。
    #[test]
    fn remove_managed_shim_never_touches_foreign() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let t = target("neeko-status.mjs");
        let path = shim_path(&t, tmp.path());

        std::fs::write(&path, "// mine\n").expect("seed");
        assert!(
            !remove_managed_shim(&t, tmp.path()).expect("foreign"),
            "他人文件不得删除"
        );
        assert!(path.is_file(), "他人文件必须原样保留");

        std::fs::write(&path, render("BODY")).expect("seed managed");
        assert!(remove_managed_shim(&t, tmp.path()).expect("managed"));
        assert!(!path.is_file());

        // 不存在：幂等，不报错。
        assert!(!remove_managed_shim(&t, tmp.path()).expect("absent"));
    }

    /// 守卫：他人文件 → `Skipped` 且不触碰；自家/不存在 → `None`（放行）。
    ///
    /// 这条契约由三条安装腿**共用**（各腿的回归钉子见 `tests.rs`），
    /// 故此处只需钉住守卫本身的行为。
    #[test]
    fn foreign_guard_blocks_only_foreign() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let t = target("neeko-status.mjs");
        let path = shim_path(&t, tmp.path());

        std::fs::write(&path, "// someone else's\n").expect("write");
        let got = shim_foreign_guard(&t, tmp.path()).expect("必须拦截");
        assert_eq!(got.status, HookApplyStatus::Skipped);
        assert!(
            std::fs::read_to_string(&path)
                .expect("read")
                .contains("someone else"),
            "他人文件必须原样保留"
        );

        std::fs::write(&path, render("BODY")).expect("write");
        assert!(shim_foreign_guard(&t, tmp.path()).is_none(), "自家放行");

        std::fs::remove_file(&path).expect("rm");
        assert!(shim_foreign_guard(&t, tmp.path()).is_none(), "不存在放行");
    }
}
