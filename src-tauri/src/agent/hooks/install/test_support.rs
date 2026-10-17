//! `install` 子域的**共享测试夹具**（只在 `#[cfg(test)]` 下编译）。
//!
//! # 为什么单独一个文件
//!
//! 12 个夹具被 `install` 下多个测试主题共用（三条 shape 腿、dispatch、trust、selection）。
//! 若每个主题各建一份，「夹具漂移」会成为新缺陷源 —— 例如 `user_settings()` 造的是
//! 「含他人条目的用户配置」，它一旦在两个文件里漂移，就只有一半用例在验真正的场景。
//!
//! # 为什么不是 `tests/` 集成测试目录
//!
//! 夹具要用 `HookTarget` / `InstallShape` / `HookApplyOutcome` 等**内部类型**，
//! 而 `tests/` 是独立 crate 只能访问 `pub`。故它必须是 `pub(crate)` 的同 crate 模块。
//!
//! # 约定
//!
//! - 路径一律 `temp_dir()` / `tempdir()` 推导（红线 13：不硬编码 POSIX 绝对路径）；
//! - `node` 解析经 thread-local 覆盖（`with_node` / `without_node`），
//!   不依赖宿主 PATH —— 环境依赖测试不是测试，是噪音；
//! - 所有构造函数只返回**数据**，不落盘（落盘由用例显式 `write_at`）。

use std::path::Path;

use crate::agent::hooks::targets::{HookTarget, InstallShape};

/// 假 `node` 的路径（测试专用；内容无关 —— 我们只验证**命令形态**，不执行它）。
///
/// 用 `temp_dir()` 推导（红线 13），不硬编码 POSIX 绝对路径。
fn fake_node_path() -> std::path::PathBuf {
    std::env::temp_dir().join("neeko-test-node")
}

/// 安装腿用例的**确定性前置条件**：把 `node` 解析固定为一个假路径。
///
/// # 为什么必须这样做（第一性原理）
///
/// `resolve_node()` 读的是**宿主 PATH**。若有 9 个用例依赖它，测试的判据就变成
/// 「这台机器碰巧装了什么」而不是「代码行为」—— 2026-10-16 实测剔除 PATH 后
/// 9 个用例直接失败、另 13 个静默通过。**环境依赖测试不是测试，是噪音**。
///
/// 覆盖走 thread-local（见 `platform::hook_command::rules::test_node_override`），
/// 故按测试线程隔离、无并行串扰。
///
/// 返回 RAII 守卫：case 结束（含 panic）自动还原。
#[must_use]
pub(crate) fn with_node() -> crate::platform::hook_command::FakeNodeGuard {
    crate::platform::hook_command::with_fake_node(&fake_node_path())
}

/// 模拟「本机没有 node」—— 专供「无 node 时应回执 Skipped」这类用例。
#[must_use]
pub(crate) fn without_node() -> crate::platform::hook_command::FakeNodeGuard {
    crate::platform::hook_command::without_node()
}

/// 指向临时目录的测试 target（`dir` 字段在 `*_at` 路径上不被调用）。
pub(crate) fn target(file_name: &'static str) -> HookTarget {
    HookTarget {
        source: "demo",
        file_name,
        template: "BODY",
        dir: || None,
        shapes: &[InstallShape::Standalone],
    }
}

/// Structured 测试 target 的形态（`const` 静态：`shapes` 是 `&'static [InstallShape]`，
/// 不能指向函数内临时数组）。
const STRUCTURED_TEST_SHAPE: &[InstallShape] = &[InstallShape::Structured {
    settings_file: "settings.json",
    root_key: "hooks",
    entries: &crate::agent::hooks::targets::CLAUDE_COMPAT_ENTRIES,
    trust: None, // 测试面无需信任门（信任探针另有独立用例）
}];

/// Structured 测试 target（entries 引用静态表；`dir` 同样不被 `*_at` 调用）。
pub(crate) fn structured_target() -> HookTarget {
    HookTarget {
        source: "claude",
        file_name: "neeko-status.mjs",
        template: "SHIM_BODY",
        dir: || None,
        shapes: STRUCTURED_TEST_SHAPE,
    }
}

pub(crate) fn write_at(path: &Path, content: &str) {
    std::fs::write(path, content).expect("write");
}

/// 造一份「用户既有配置」：含他人 command 条目 + 他人 http 条目。
pub(crate) fn user_settings() -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "env": { "ANTHROPIC_BASE_URL": "https://example.invalid" },
        "hooks": {
            "PermissionRequest": [
                { "matcher": "*", "hooks": [
                    { "type": "command", "command": "/Users/x/.orca/agent-hooks/claude-hook.sh" }]},
                { "matcher": "", "hooks": [
                    { "type": "http", "url": "http://127.0.0.1:23333/permission" }]}
            ]
        }
    }))
    .expect("json")
}

/// NotifyArgv 测试 target（`dir` 不被 `*_at` 调用）。
pub(crate) fn notify_target() -> HookTarget {
    HookTarget {
        source: "codex",
        file_name: "neeko-status.mjs",
        template: "SHIM_BODY",
        dir: || None,
        shapes: &[InstallShape::NotifyArgv {
            config_file: "config.toml",
            key: "notify",
            event_key: crate::agent::chat::notify::event_keys::TURN_COMPLETED,
        }],
    }
}

/// 用户既有 config.toml（含 token 与多 section）。
pub(crate) fn user_codex_config() -> String {
    [
        "model_provider = \"magpie\"",
        "[model_providers.magpie]",
        "experimental_bearer_token = \"SECRET\"",
        "",
    ]
    .join("\n")
}

/// 双面 target：`NotifyArgv`（config.toml）+ `Structured`（hooks.json）。
/// 与 `targets.rs` 的 codex 行同构，用于验证面聚合逻辑。
const DUAL_FACE_SHAPE: &[InstallShape] = &[
    InstallShape::NotifyArgv {
        config_file: "config.toml",
        key: "notify",
        event_key: crate::agent::chat::notify::event_keys::TURN_COMPLETED,
    },
    InstallShape::Structured {
        settings_file: "hooks.json",
        root_key: "hooks",
        entries: &crate::agent::hooks::targets::CLAUDE_COMPAT_ENTRIES,
        // 与真实 codex 行同构：hooks.json 面带信任门（探测规格的键格式在
        // `targets::codex_trust_key`，此处给一个等价测试规格）。
        trust: Some(crate::agent::hooks::targets::TrustSpec {
            state_file: "config.toml",
            record: |key| format!("[hooks.state.\"{key}\"]"),
            key: |shim: &str, event: &str, gi: usize, hi: usize| {
                format!("{shim}:{event}:{gi}:{hi}")
            },
        }),
    },
];

pub(crate) fn dual_face_target() -> HookTarget {
    HookTarget {
        source: "codex",
        file_name: "neeko-status.mjs",
        template: "SHIM_BODY",
        dir: || None,
        shapes: DUAL_FACE_SHAPE,
    }
}
