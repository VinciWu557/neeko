//! `InstallShape::Standalone` 腿：只写一个受管文件，**绝不修改用户既有配置**。
//!
//! 适用于 opencode / pi / OMP —— 它们的扩展机制本身就是「丢一个文件进目录」。
//!
//! 拆分自原 `agent/hooks/writers.rs`（单文件 7 职责，违反高内聚）。
//! 本文件只承载**一个**职责；跨切片共享的判据住在同级模块，不在此复制。

use std::path::Path;

use crate::agent::hooks::install::outcome::{outcome, HookApplyOutcome, HookApplyStatus};
use crate::agent::hooks::install::shim::io::{
    remove_managed_shim, shim_foreign_guard, shim_path, write_shim_if_stale,
};
use crate::agent::hooks::install::shim::ownership::ownership_of_target;
use crate::agent::hooks::targets::HookTarget;

/// `Standalone` 安装：投放目录不存在则创建（安装是用户显式同意的动作，空目录对 CLI 无害）；
/// 「客人」边界守在文件内容 —— 同名他人文件（无自家标记）绝不覆盖。
#[must_use]
pub(crate) fn install_standalone(target: &HookTarget, dir: &Path) -> HookApplyOutcome {
    if let Err(err) = std::fs::create_dir_all(dir) {
        return outcome(
            target,
            HookApplyStatus::Failed,
            format!("mkdir {}: {err}", dir.display()),
        );
    }
    // 「客人不喧宾」：同名他人文件一律不动（三条安装腿共用同一守卫）。
    if let Some(skip) = shim_foreign_guard(target, dir) {
        return skip;
    }
    // 落盘统一走 `shim_io`：与另两条腿同一条原子写 + 权限继承路径
    //（此前本腿用的是裸 `std::fs::write` —— 同一契约三种写法里唯一非原子的那种）。
    match write_shim_if_stale(target, dir) {
        Ok(true) => outcome(target, HookApplyStatus::Applied, String::new()),
        Ok(false) => outcome(target, HookApplyStatus::Unchanged, String::new()),
        Err(detail) => outcome(target, HookApplyStatus::Failed, detail),
    }
}

/// `Standalone` 卸载：**只删自家受管文件**。
///
/// 从未安装（文件不存在）→ `None`（不产生噪音回执）；
/// 同名他人文件 → `Skipped` 且原样保留（删除同样是数据破坏，与安装的守卫同一条契约）。
#[must_use]
pub(crate) fn uninstall_standalone(target: &HookTarget, dir: &Path) -> Option<HookApplyOutcome> {
    if !shim_path(target, dir).is_file() {
        return None; // 从未安装：不产生噪音行
    }
    if !ownership_of_target(target, dir).is_managed() {
        // 他人资产：保留并如实回报（不产生「已卸载」的假象）。
        return Some(outcome(
            target,
            HookApplyStatus::Skipped,
            format!("{} is not Neeko-managed, kept", target.file_name),
        ));
    }
    Some(match remove_managed_shim(target, dir) {
        Ok(_) => outcome(target, HookApplyStatus::Removed, String::new()),
        Err(detail) => outcome(target, HookApplyStatus::Failed, detail),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::hooks::install::dispatch::{install_at, uninstall_at};
    use crate::agent::hooks::install::shim::ownership::{render, MANAGED_MARKER};
    use crate::agent::hooks::install::status::status_at;
    use crate::agent::hooks::install::test_support::*;
    use crate::agent::hooks::targets::InstallShape;

    /// install_at：目录不存在时创建并写入（安装是用户显式同意，建投放目录属正常语义）。
    #[test]
    fn install_creates_missing_dir_and_writes() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let nested = tmp.path().join("not-yet");
        let got = install_at(&target("neeko-status.js"), &nested);
        assert_eq!(got.status, HookApplyStatus::Applied, "{got:?}");
        assert_eq!(got.source, "demo");
        assert!(nested.join("neeko-status.js").is_file());
    }

    /// install_at：首次 Applied，再次同内容 = Unchanged（幂等，无 mtime 抖动）。
    #[test]
    fn install_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let t = target("neeko-status.js");
        assert_eq!(install_at(&t, tmp.path()).status, HookApplyStatus::Applied);
        assert_eq!(
            install_at(&t, tmp.path()).status,
            HookApplyStatus::Unchanged
        );
    }

    /// 同名他人文件（无标记）绝不覆盖；不可读（非 UTF-8）同判他人资产。
    #[test]
    fn foreign_file_is_never_touched() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("neeko-status.js");
        let t = target("neeko-status.js");

        write_at(&file, "// someone else's plugin\nconsole.log(1)");
        let got = install_at(&t, tmp.path());
        assert_eq!(got.status, HookApplyStatus::Skipped, "{got:?}");
        assert!(std::fs::read_to_string(&file)
            .expect("read")
            .contains("someone else"));

        let raw = vec![0xff_u8, 0xfe, 0x00, 0x01];
        std::fs::write(&file, &raw).expect("write bytes");
        assert_eq!(install_at(&t, tmp.path()).status, HookApplyStatus::Skipped);
        // 字节级断言在此**有意为之**（红线 11 针对的是工作区换行的字节断言）：
        // `raw` 是本用例刚写入的**非 UTF-8 二进制夹具**，判据恰是「写入器一根字节都不许改」。
        // 走 `read_to_string` 会因非 UTF-8 失败，行尾无关比较也无从谈起（它没有行）。
        assert_eq!(std::fs::read(&file).expect("read"), raw);
    }

    /// status_at：受管且版本一致 / 版本旧 / 他人文件 / 目录缺失四态。
    #[test]
    fn status_reflects_marker_and_version() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("neeko-status.js");
        let t = target("neeko-status.js");

        write_at(&file, &render(t.template));
        let s = status_at(&t, tmp.path());
        assert!(s.installed && s.version_current);

        write_at(&file, &format!("{MANAGED_MARKER} v0.0.0\nbody"));
        let s = status_at(&t, tmp.path());
        assert!(s.installed && !s.version_current);

        write_at(&file, "// foreign\n");
        assert!(!status_at(&t, tmp.path()).installed);

        let missing = tmp.path().join("nope");
        let s = status_at(&t, &missing);
        assert!(!s.installed && !s.version_current);
        assert_eq!(
            s.path,
            missing.join("neeko-status.js").display().to_string()
        );
    }

    /// D13 的核心不变量：模板正文变了（版本号不变）→ 已装文件被判过期 → 收敛触发 Install。
    ///
    /// 反证：把 `content_token` 退回 `v{CARGO_PKG_VERSION}` 实现，本用例必红。
    #[test]
    fn template_body_change_marks_install_stale_without_version_bump() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("neeko-status.js");
        // 用旧正文安装。
        write_at(&file, &render("OLD_BODY"));

        // 同版本号、新正文：status 必须判过期。
        let updated = HookTarget {
            source: "demo",
            file_name: "neeko-status.js",
            template: "NEW_BODY",
            dir: || None,
            shapes: &[InstallShape::Standalone],
        };
        let s = status_at(&updated, tmp.path());
        assert!(s.installed && !s.version_current, "改正文必须判过期");
        assert!(
            !s.version_current && s.installed,
            "过期 + 已装 → 收敛入口必须能识别为需重装（不需要碰发布版本）"
        );
    }

    /// 旧标记（无 `+hash`，如 `v1.0.9`）与当前期望键不匹配 → 首启自动重装一次（迁移方向安全）。
    #[test]
    fn legacy_version_marker_triggers_reinstall() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let file = tmp.path().join("neeko-status.js");
        let t = target("neeko-status.js");
        write_at(
            &file,
            &format!("{MANAGED_MARKER} v{}\nBODY", env!("CARGO_PKG_VERSION")),
        );
        let s = status_at(&t, tmp.path());
        assert!(s.installed && !s.version_current, "旧纯版本标记应被判过期");
    }

    /// uninstall_at：只删受管文件；他人文件 Skipped；从未安装不产生回执行。
    #[test]
    fn uninstall_only_removes_managed() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_at(
            &tmp.path().join("managed.js"),
            &format!("{MANAGED_MARKER} v1\nbody"),
        );
        write_at(&tmp.path().join("foreign.js"), "// foreign\n");

        let got = uninstall_at(&target("managed.js"), tmp.path()).expect("outcome");
        assert_eq!(got.status, HookApplyStatus::Removed);
        assert!(!tmp.path().join("managed.js").exists());

        let got = uninstall_at(&target("foreign.js"), tmp.path()).expect("outcome");
        assert_eq!(got.status, HookApplyStatus::Skipped);
        assert!(tmp.path().join("foreign.js").is_file());

        assert!(uninstall_at(&target("never-installed.js"), tmp.path()).is_none());
    }

    /// 目录缺失时 status 不越权创建目录（查询是只读的）。
    #[test]
    fn status_never_creates_directories() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let missing = tmp.path().join("absent");
        // 查询结果本身不重要 —— 本用例的判据是「查询没有副作用」。故显式丢弃返回值。
        let _ = status_at(&target("neeko-status.js"), &missing);
        assert!(!missing.exists());
    }
}
