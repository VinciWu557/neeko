//! `install` 子域的**跨腿契约测试**（只在 `#[cfg(test)]` 下编译）。
//!
//! # 这个文件里放什么
//!
//! 只放**不属于任何单一形态**的断言，目前只有两条：
//!
//! 1. `uninstall_legs_never_remove_a_foreign_shim` —— 循环三条腿，验「删除他人 shim」这条
//!    契约在三处一致（单腿的覆盖守卫已各自内联在 `shape/*.rs`）；
//! 2. `every_leg_skips_when_node_is_absent` —— 验「无 node 时**所有**依赖 node 的腿都 Skip」
//!    （单腿角度看是同一句，但它的价值在于**跨腿一致性**：漏一条腿就是「装了但没通知」）。
//!
//! 放任何一个 shape 文件里都名不副实 —— 它们测的是「三条腿互相对齐」。
//!
//! 单个形态自身的行为测试住在其生产文件内联的 `mod tests` 里
//! （`shape/standalone.rs` / `shape/structured.rs` / `shape/notify_argv.rs`）——
//! 这样可以 `use super::*` 零路径依赖，移动文件时测试跟着走。
//!
//! 共享夹具在 [`super::test_support`]（12 个构造函数，避免跨文件复制导致漂移）。

use super::test_support::*;
use crate::agent::hooks::install::dispatch::{install_at, uninstall_at};
use crate::agent::hooks::install::outcome::HookApplyStatus;

/// **卸载腿**同样不许删他人 shim（删除与覆盖是同一契约的两半）。
///
/// 反证：把 `remove_managed_shim` 的归属判定去掉，本用例三个文件都会被删掉。
#[test]
fn uninstall_legs_never_remove_a_foreign_shim() {
    for t in [
        target("neeko-status.js"),
        structured_target(),
        notify_target(),
    ] {
        let tmp = tempfile::tempdir().expect("tempdir");
        let shim = tmp.path().join(t.file_name);
        let user_cfg = user_settings();
        write_at(&shim, "// someone else's script\n");
        write_at(&tmp.path().join("settings.json"), &user_cfg);
        write_at(&tmp.path().join("config.toml"), &user_codex_config());

        let _ = uninstall_at(&t, tmp.path());
        assert!(shim.is_file(), "source={} 的他人 shim 不得被删除", t.source);
        assert_eq!(
            std::fs::read_to_string(&shim).expect("read"),
            "// someone else's script\n",
            "source={} 的他人 shim 必须逐字保留",
            t.source
        );
    }
}

// ── Structured 形态（父任务 AC3/AC4/AC5）──────────────────────────────────

// ── NotifyArgv 形态（Codex；AC1/AC3/AC4/AC5/AC6）────────────────────────────

/// **无 node** → 三条安装腿都回执 `Skipped`，且**不写任何文件**。
///
/// 这是 `with_node()` 的对照面：以前这条语义只能靠"本机恰好没装 node"来覆盖
///（即永远不覆盖）。现在用 `without_node()` 主动模拟。
///
/// 反证：把任一腿的 `resolve_node()` 判空去掉，本用例会得到 `Applied` 并写出文件。
#[test]
fn every_leg_skips_when_node_is_absent() {
    let tmp = tempfile::tempdir().expect("tempdir");
    write_at(&tmp.path().join("config.toml"), &user_codex_config());
    write_at(&tmp.path().join("settings.json"), &user_settings());
    let _no_node = without_node();

    for t in [notify_target(), structured_target()] {
        let got = install_at(&t, tmp.path());
        assert_eq!(
            got.status,
            HookApplyStatus::Skipped,
            "source={} {got:?}",
            t.source
        );
        assert!(
            got.detail.contains("node"),
            "detail 必须说明缺 node: {got:?}"
        );
    }
    // 三个面都跳过 → 不得写出 shim（否则配置会指向一个不存在的脚本）。
    assert!(
        !tmp.path().join("neeko-status.mjs").exists(),
        "无 node 时不得写 shim"
    );
}
