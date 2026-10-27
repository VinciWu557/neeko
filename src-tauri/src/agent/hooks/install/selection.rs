//! 「主开关 + 逐 CLI 生效谓词」→ 文件面的**唯一收敛入口**（design §2.5）。
//!
//! 开机收敛与设置页保存**都**只调本模块，故两条路径的行为不可能不对称。
//!
//! 拆分自原 `agent/hooks/writers.rs`（单文件 7 职责，违反高内聚）。
//! 本文件只承载**一个**职责；跨切片共享的判据住在同级模块，不在此复制。

use std::path::PathBuf;

use crate::agent::hooks::install::dispatch::{install_at, uninstall_at};
use crate::agent::hooks::install::outcome::{outcome, HookApplyOutcome, HookApplyStatus};
use crate::agent::hooks::targets::{HookTarget, HOOK_TARGETS};

/// 把「主开关 + 逐 CLI 生效谓词」收敛到文件面的**唯一入口**（design §2.5：设置是意图，
/// 文件是事实，单向对齐）。
///
/// # 为什么必须只有一个入口
///
/// 这条语义此前有两份实现：命令路径做「装应装的 + 卸不该装的」两趟差集，开机路径却只会
/// `install_selected` 或 `uninstall_all`。后果是不对称 —— **设置页关掉某个 CLI 后重启，
/// 它又被装了回来**（开机路径从不执行「关掉的那部分」卸载）。同一契约两处实现，漏一处
/// 就是「设置看起来生效、重启后失效」的温床。
///
/// 现由本函数单点表达；两个调用方（开机收敛、设置页保存）都只传「谁该装」。
///
/// # 幂等
///
/// `install_selected` 内容一致时返回 `Unchanged`（零写盘），`uninstall_selected` 对无自家
/// 痕迹的行不产生回执。故重复调用安全，开机无需先「判断是否需要动作」再执行 —— 那层
/// 判断（旧 `reconcile_action`）正是不对称的来源，已一并移除。
///
/// `master=false` ⇒ 无视谓词，卸掉全部（主开关是闸门，逐 CLI 覆盖只能在其内细分）。
#[must_use]
pub fn apply_selection(
    master: bool,
    should_install: impl Fn(&str) -> bool,
) -> Vec<HookApplyOutcome> {
    apply_selection_over(HOOK_TARGETS, |t| (t.dir)(), master, should_install)
}

/// [`apply_selection`] 的**可注入内核**：受管行集合与目录定位都由调用方给。
///
/// 为什么要这一层：动作函数一律按 `(target, dir)` 显式传目录（红线 13「夹具路径平台无关」
/// 的同款要求）—— 收敛语义若只能吃全局 `HOOK_TARGETS` 与真实用户目录，就**无法直测**，
/// 只能靠「在真机上点设置页」验证，而它恰恰是「关掉一个 CLI 后重启又装回来」那类
/// 不对称缺陷的藏身处。抽出内核后，行为可在 tempdir 上钉死。
pub(crate) fn apply_selection_over(
    targets: &[HookTarget],
    dir_of: impl Fn(&HookTarget) -> Option<PathBuf>,
    master: bool,
    should_install: impl Fn(&str) -> bool,
) -> Vec<HookApplyOutcome> {
    let mut outcomes: Vec<HookApplyOutcome> = targets
        .iter()
        // **自供源不参与收敛**（`shapes` 为空 = 接收上报但无安装腿，见
        // `targets::HOOK_TARGETS` 的 dsh 行）。它们必须在这里被排除，而不是走下面的
        // `dir_of` 分支：自供源的 `dir()` 恒 `None`，那会把「没有安装腿」误报成
        // `Failed("cannot locate user config directory")` —— 开机日志每次都说改了什么，
        // 设置页在 `getCliHookStatus()` 失败那档还会弹错误提示。
        .filter(|target| !target.shapes.is_empty())
        .map(|target| {
            if !master || !should_install(target.source) {
                return outcome(
                    target,
                    HookApplyStatus::Skipped,
                    "disabled by user setting".to_string(),
                );
            }
            match dir_of(target) {
                Some(dir) => install_at(target, &dir),
                None => outcome(
                    target,
                    HookApplyStatus::Failed,
                    "cannot locate user config directory".to_string(),
                ),
            }
        })
        .collect();

    // 不该装却仍在磁盘上的（本次被关掉 / 历史遗留）→ 卸掉。
    // `master=false` 时谓词形同全否，此处即「全部卸载」——闸门语义由同一表达式表达，
    // 不再需要一条独立的 `uninstall_all` 分支（分支正是两处语义漂移的来源）。
    outcomes.extend(
        targets
            .iter()
            .filter(|target| !target.shapes.is_empty())
            .filter(|target| !master || !should_install(target.source))
            .filter_map(|target| dir_of(target).and_then(|dir| uninstall_at(target, &dir))),
    );
    outcomes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::hooks::targets::InstallShape;

    /// **收敛入口的唯一性**：主开关 + 谓词 → 文件面，装/卸一次算清。
    ///
    /// 这是对「对称性」的回归钉子。旧实现有两条路径：命令侧做差集两趟，开机侧只会
    /// 安装或整体卸载 —— 于是**关掉某个 CLI 后重启会把它装回来**（开机路径从不执行
    /// 「关掉那部分」的卸载）。
    ///
    /// **反证**：删掉 `apply_selection_over` 里 `filter(|t| !should_install(t.source))`
    /// 那一趟，第三条断言必红。
    ///
    /// 走可注入内核（tempdir 作目录，红线 13），不触真实用户目录。
    #[test]
    fn apply_selection_installs_wanted_and_removes_unwanted() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let rows = [tmp.path().join("cli-a"), tmp.path().join("cli-b")];
        for d in &rows {
            std::fs::create_dir_all(d).expect("mkdir");
        }
        let dirs: Vec<PathBuf> = rows.to_vec();
        let targets: Vec<HookTarget> = ["a", "b"]
            .iter()
            .map(|src| HookTarget {
                source: src,
                file_name: "neeko-status.js",
                template: "BODY",
                dir: || None,
                shapes: &[InstallShape::Standalone],
            })
            .collect();
        let dir_of = |t: &HookTarget| {
            targets
                .iter()
                .position(|x| x.source == t.source)
                .map(|i| dirs[i].clone())
        };

        // 全装：两个 CLI 的文件都必须落盘（证明「装」这趟有效）。
        let all = apply_selection_over(&targets, dir_of, true, |_| true);
        assert_eq!(all.len(), 2);
        for d in &rows {
            assert!(
                d.join("neeko-status.js").is_file(),
                "该装的必须装：{}",
                d.display()
            );
        }

        // 只留 a：b 的文件必须被**卸掉**（差集那趟的存在性判据 —— 反证点）。
        let only_a = apply_selection_over(&targets, dir_of, true, |src| src == "a");
        assert!(
            !only_a
                .iter()
                .filter(|o| o.source == "b")
                .any(|o| o.status == HookApplyStatus::Applied),
            "谓词排除的 CLI 不得被安装: {only_a:?}"
        );
        assert!(rows[0].join("neeko-status.js").is_file(), "保留项必须仍在");
        assert!(
            !rows[1].join("neeko-status.js").exists(),
            "被关掉的 CLI 的文件必须删除（否则重启后又被认为已装）"
        );

        // 主开关关 = 闸门，谓词无权保留 → 全卸。
        let _ = apply_selection_over(&targets, dir_of, false, |_| true);
        assert!(
            rows.iter().all(|d| !d.join("neeko-status.js").exists()),
            "主开关关必须清空全部"
        );
    }
    /// 幂等：连续两次同一谓词，第二次不得再写盘（避免每次开机重写文件）。
    #[test]
    fn apply_selection_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("cli");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let targets = [HookTarget {
            source: "a",
            file_name: "neeko-status.js",
            template: "BODY",
            dir: || None,
            shapes: &[InstallShape::Standalone],
        }];
        let dir_of = |_t: &HookTarget| Some(dir.clone());

        let first = apply_selection_over(&targets, dir_of, true, |_| true);
        let second = apply_selection_over(&targets, dir_of, true, |_| true);
        assert_eq!(first[0].status, HookApplyStatus::Applied);
        assert_eq!(
            second[0].status,
            HookApplyStatus::Unchanged,
            "第二次收敛必须零写盘（幂等）"
        );
    }

    /// **自供源不参与收敛**：`shapes` 为空的行不得产生任何回执，尤其不得是 `Failed`。
    ///
    /// 自供源（`dsh`）的 `dir()` 恒 `None`（它根本没有安装腿）。若它落到
    /// `dir_of(target) == None` 分支，每次开机都会记一条
    /// `dsh:Failed("cannot locate user config directory")` —— 开机日志因此谎报「改了什么」，
    /// 设置页在 `getCliHookStatus()` 失败那档还会弹一个错误提示。
    ///
    /// **反证**：删掉 `apply_selection_over` 里的 `filter(|t| !t.shapes.is_empty())`，
    /// 本用例立刻变红（fail 分支出现在两份回执里）。
    ///
    /// 走可注入内核（红线 13），目录由 `dir_of` 给，不触真实用户目录。
    #[test]
    fn self_supplied_targets_produce_no_outcome() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path().join("cli");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let targets = [
            HookTarget {
                source: "installable",
                file_name: "neeko-status.js",
                template: "BODY",
                dir: || None,
                shapes: &[InstallShape::Standalone],
            },
            // 自供源：没有安装腿，也不该去任何目录。
            HookTarget {
                source: "self-supplied",
                file_name: "unused",
                template: "",
                dir: || None,
                shapes: &[],
            },
        ];
        let dir_of = |t: &HookTarget| (t.source == "installable").then(|| dir.clone());

        for master in [true, false] {
            let outcomes = apply_selection_over(&targets, dir_of, master, |_| true);
            assert!(
                outcomes.iter().all(|o| o.source != "self-supplied"),
                "自供源不得出现在收敛回执里（master={master}）: {outcomes:?}"
            );
            assert!(
                !outcomes.iter().any(|o| o.status == HookApplyStatus::Failed),
                "自供源不得被误报成 Failed（master={master}）: {outcomes:?}"
            );
        }
    }
}
