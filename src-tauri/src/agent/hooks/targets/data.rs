//! 受管外部 Agent CLI 的**唯一事实表** ——「本机支持接入哪几个 CLI」这一个问题的唯一答案。
//!
//! # 第一性原理
//!
//! 接入一个新 CLI 应该只改**一行数据**。此前 `(source, 目录, 文件名, 模板)` 四元组被手抄在
//! `install_all` / `status_all` / `uninstall_all` 三处，外加 ingest 的路由白名单与一个计数
//! 常量 —— 一致性只剩注释级约定（根 `AGENTS.md`：重复 3 次必须抽象；开闭原则：新能力靠
//! 加数据而非改核心）。
//!
//! 本表是那些副本的唯一来源：`writers` 按行安装/卸载/查询，`server` 按行校验路由。
//! 形态（`InstallShape`）是第二个数据维度，决定 `writers` 走哪条腿；
//! `HookEntry` 表是「CLI 原生事件名 → 语义 event_key」的纯映射 ——
//! shim 通过 argv 收到 event_key，因此 **shim 零 per-CLI 事件名知识**（父任务 design T9）。
//!
//! # 新增一个 CLI 需要改什么
//!
//! 1. 若其接入形态已被 `InstallShape` 覆盖 → **只加一行** `HookTarget`；
//! 2. 若是新形态 → 加 `InstallShape` 变体 + `writers/` 三条腿各补一个 arm
//!    （编译期穷尽会强制你处理，这是 `enum + match` 的预期代价）。

use std::path::PathBuf;

use super::dirs::{
    claude_config_dir, codebuddy_config_dir, codex_config_dir, omp_extensions_dir,
    opencode_plugins_dir, pi_extensions_dir, qoder_config_dir,
};
use super::entries::CLAUDE_COMPAT_ENTRIES;
use super::shape::{InstallShape, TrustSpec};
use crate::agent::chat::notify::event_keys;
use crate::agent::hooks::templates::{OMP_TEMPLATE, OPENCODE_TEMPLATE, PI_TEMPLATE};

/// 一个受管 CLI 的接入数据。
pub struct HookTarget {
    /// CLI 标识：既是 ingest 路由段 `/hook/{source}`，也是设置页与回执里的展示名
    /// （同一个事实只有一个名字，不再另设 `cli` 字段）。
    pub source: &'static str,
    /// 受管文件名（落在 [`HookTarget::dir`] 下）。
    pub file_name: &'static str,
    /// 模板正文（不含归属标记头 —— 由 writers 统一前置，保证标记格式单点）。
    pub template: &'static str,
    /// 该 CLI 在本机的扩展/配置目录定位器（`None` = 无法确定用户目录）。
    pub dir: fn() -> Option<PathBuf>,
    /// 该 CLI 的**全部接入面**（一个 CLI 可以有多个配置面）。
    ///
    /// 为什么是数组而非单值：**「一个 CLI 一条通知通道」是错的**。
    /// 实测（实测表见 `.trellis/spec/backend/agent-hooks-domain.md`「为什么不能代写信任哈希」）
    /// Codex 有两条：
    /// - `notify`（`config.toml` 数组键）→ 轮次完成，**零交互即装即用**；
    /// - `hooks.json` 的 `PermissionRequest` → 审批/失败，**需用户一次性确认信任**。
    ///   两者事件面、信任门、投递形态都不同，故各自是一个 `InstallShape`。
    ///
    /// 状态/安装/卸载都在面上聚合（`writers` 的 `combine_*`）：
    /// `installed` = **所有面都在位**；任一面的失败都会体现为整体失败。
    pub shapes: &'static [InstallShape],
}

/// Codex 的信任键格式：`<hooks.json 绝对路径>:<event_snake>:<group_idx>:<hook_idx>`。
///
/// 实测（2026-10-16）：`[hooks.state."<path>:session_start:0:0"]` /
/// `...:user_prompt_submit:0:0`。**只读探测，绝不代写**（hash 不可反推，且是内部契约）。
fn codex_trust_key(shim: &str, event_snake: &str, group_idx: usize, hook_idx: usize) -> String {
    format!("{shim}:{event_snake}:{group_idx}:{hook_idx}")
}

/// Codex 的信任记录形态：`[hooks.state."<key>"]`（TOML 表头）。
fn codex_trust_record(key: &str) -> String {
    format!("[hooks.state.\"{key}\"]")
}

/// 全部受管 CLI：**新增一行即完成接入**（前提是该 CLI 的接入形态已被 `InstallShape` 覆盖），
/// writers / server / 设置页零改动。
pub const HOOK_TARGETS: &[HookTarget] = &[
    HookTarget {
        source: "opencode",
        file_name: "neeko-status.js",
        template: OPENCODE_TEMPLATE,
        dir: opencode_plugins_dir,
        shapes: &[InstallShape::Standalone],
    },
    HookTarget {
        source: "pi",
        file_name: "neeko-status.ts",
        template: PI_TEMPLATE,
        dir: pi_extensions_dir,
        shapes: &[InstallShape::Standalone],
    },
    // ── 2026-10-16 扩展：OMP + Claude 兼容三源 ──────────────────────────────────
    HookTarget {
        source: "omp",
        // 与 pi 同名不同目录 —— 这正是 `hook_targets_are_unique` 断言必须只查 source 的原因。
        file_name: "neeko-status.ts",
        template: OMP_TEMPLATE,
        dir: omp_extensions_dir,
        shapes: &[InstallShape::Standalone],
    },
    HookTarget {
        source: "claude",
        file_name: "neeko-status.mjs",
        template: crate::agent::hooks::templates::REPORT_SHIM,
        dir: claude_config_dir,
        shapes: &[InstallShape::Structured {
            settings_file: "settings.json",
            root_key: "hooks",
            entries: &CLAUDE_COMPAT_ENTRIES,
            trust: None,
        }],
    },
    HookTarget {
        source: "codebuddy",
        file_name: "neeko-status.mjs",
        template: crate::agent::hooks::templates::REPORT_SHIM,
        dir: codebuddy_config_dir,
        shapes: &[InstallShape::Structured {
            settings_file: "settings.json",
            root_key: "hooks",
            entries: &CLAUDE_COMPAT_ENTRIES,
            trust: None,
        }],
    },
    HookTarget {
        source: "qoder",
        file_name: "neeko-status.mjs",
        template: crate::agent::hooks::templates::REPORT_SHIM,
        dir: qoder_config_dir,
        shapes: &[InstallShape::Structured {
            settings_file: "settings.json",
            root_key: "hooks",
            entries: &CLAUDE_COMPAT_ENTRIES,
            trust: None,
        }],
    },
    // ── DSH（2026-10-27：**自供源**，Neeko 不装任何东西）────────────────────────
    //
    // 为什么 `shapes` 是空的：DSH 的上报由 `packages/dsh-neeko`（DSH 自己的 cordis
    // 插件）完成 —— 它已经在用户的 profile 里跑着，且已经能拿到全部 host 事件
    // （`approval/asked` / ``tool/call`` / `agent/status` / `agent/error`）。
    // Neeko 既不该也不需要往用户的 `~/.dsh/profiles/<p>/**` 写文件：
    // 那个目录由 `dsh plugin` 管理，且有 pnpm store 依赖（实测
    // `ERR_PNPM_UNEXPECTED_STORE`，且会把 `node_modules` 重建为真实目录抹掉软链）。
    //
    // 但 DSH **必须在**这张表里：否则 `/hook/dsh` 会被 `validation::hook_source()`
    // 的白名单静默丢弃（返回 204，事件不见）—— 正是 2026-10-16 记录的那个
    // 可观测性缺口，也是 Step 0 P6b 实测复现的形态。
    //
    // 空 `shapes` 的语义（见 `targets/tests.rs::self_supplied_sources_are_not_installable`）：
    // **自供源** —— 接收上报，但不提供安装腿，也不出现在设置页的开关列表里。
    HookTarget {
        source: "dsh",
        // 自供源不落任何文件；这两个字段保持与其它行同形，但不被使用。
        file_name: "neeko-dsh-status",
        template: "",
        // 恒 None：Neeko 不去 `~/.dsh` 写任何东西（见上方理由）。
        dir: || None,
        shapes: &[],
    },
    // ── Codex（2026-10-16 spike 后定案：走 `notify`，不走 `hooks.json`）──────────
    //
    // **为什么不是 `Structured { settings_file: "hooks.json" }`**（实测表与判据见
    // `.trellis/spec/backend/agent-hooks-domain.md`「为什么不能代写信任哈希」/「InstallShape::NotifyArgv」）：
    // `hooks.json` 的每条 hook 需要 `[hooks.state]` 里的 `trusted_hash` 才算生效
    // （信任门是**执行级**硬门：未信任的 hook 静默不跑）；而该 hash 的输入是 Codex 内部的
    // 「normalized hook identity 的 TOML 序列化」—— 45 个候选全不匹配，**不可反推**，
    // 且是未公开契约（Codex 改序列化 = 我们静默失效）。
    // `notify` 则**完全绕过信任门**（实测零信任配置即触发），且是公开配置键。
    // 代价：`notify` 只有 `agent-turn-complete` 一个事件（无审批/失败），
    // 故 Codex 只能覆盖「轮次完成」—— 已如实登记在子任务 prd.md R4/AC2。
    HookTarget {
        source: "codex",
        // `notify` 指向 shim 文件本身（argv 数组的第 1 项）。
        file_name: "neeko-status.mjs",
        template: crate::agent::hooks::templates::REPORT_SHIM,
        dir: codex_config_dir,
        shapes: &[
            InstallShape::NotifyArgv {
                config_file: "config.toml",
                key: "notify",
                // Codex `notify` 的唯一事件是 `agent-turn-complete`（实测）。
                event_key: event_keys::TURN_COMPLETED,
            },
            // 审批/失败面：`hooks.json`（与 Claude 同形，故复用同一份 entries）。
            // **不写 `[hooks.state]` 的 `trusted_hash`** —— 它不可反推，且是 Codex 内部契约
            // （见 spike 附 3）。未信任的条目 Codex **静默跳过、不报错**（spike 附 4 实测），
            // 用户需在 Codex TUI 里确认一次（文案 `New hook - review required` → `Trust`）。
            InstallShape::Structured {
                settings_file: "hooks.json",
                root_key: "hooks",
                entries: &CLAUDE_COMPAT_ENTRIES,
                // 信任记录落在 `config.toml` 的 `[hooks.state."<path>:<event>:<gi>:<hi>"]`。
                trust: Some(TrustSpec {
                    state_file: "config.toml",
                    key: codex_trust_key,
                    record: codex_trust_record,
                }),
            },
        ],
    },
];
