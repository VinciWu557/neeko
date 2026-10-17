//! **出站**：把 Neeko 的 shim 投放进用户 CLI 的配置面。
//!
//! # 不变式：fail-safe
//!
//! 这一侧的失败必须**拒绝执行**，绝不"大概写一下"：
//! - 用户配置文件解析不了 → `Skipped`，一个字节都不动；
//! - 同名文件不是 Neeko 装的 → `Skipped`，绝不覆盖（客人义务）；
//! - 任何写入走原子替换 + 保留原权限位（读者永不见半截文件，权限不被静默放宽）。
//!
//! 与 [`super::ingest`] 的 fail-open 是**两条互斥的失败策略** —— 同一个模块不可能同时
//! 「失败时静默放手」与「失败时拒绝执行」，故目录上必须分开。
//!
//! # 分层（单向，无环）
//!
//! ```text
//! selection → dispatch → shape/*            （写侧：按形态执行）
//! status    → shape/*                       （读侧：按形态判定；另有 trust/json_file）
//! shape/*   → shim/*  config/*  outcome
//! shim/*    → ownership / outcome
//! trust     → config::json  json_file       （信任探针只读合并判据）
//! json_file → （仅 std/serde_json，是最干净的叶子）
//!
//! 注：「无环」只在**生产段**成立。`shape/*.rs` 的 `#[cfg(test)] mod tests` 会
//! import `dispatch` / `status`（测试要驱动整条腿），构成测试期环 —— 这是可接受且必要的。
//! ```

pub mod config;
pub mod shape;
pub mod shim;

pub mod dispatch;
pub mod json_file;
pub mod outcome;
pub mod selection;
pub mod status;
pub mod trust;

/// 回执/状态类型（命令层与前端契约）。
pub use outcome::{HookApplyOutcome, HookApplyStatus, HookInstallStatus};
/// 设置页与开机收敛的**唯一入口**（两条路径共用，防止语义不对称）。
pub use selection::apply_selection;
/// 状态查询（设置页数据行）。
pub use status::status_all;

#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
