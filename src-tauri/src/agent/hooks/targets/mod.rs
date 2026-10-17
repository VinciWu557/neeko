//! 受管外部 Agent CLI 的**事实与契约**（唯一事实表 + 形态词汇表 + 目录解析）。
//!
//! # 为什么是目录而不是单个 `targets.rs`
//!
//! 原 757 行的 `targets.rs` 承担三类变化频率完全不同的知识，混在一起时「改一样东西」
//! 必须越过另外两样的 300+ 行：
//!
//! | 单元 | 变化触发 | 是否读环境 |
//! | --- | --- | --- |
//! | `shape` | 新增一种接入形态（罕见） | 否 |
//! | `entries` | Claude 规范事件面变化（罕见） | 否 |
//! | `data` | **新增一个受管 CLI（常见）** | 否 |
//! | `dirs` | 某 CLI 改配置目录约定（偶发） | **是** |
//!
//! 拆分后「加一行数据接一个新 CLI」只需动 `data.rs`，「`CODEX_HOME` 解析错了」只看
//! `dirs.rs` —— 两条最高频的改动路径各自一屏可见。
//!
//! # 分层
//!
//! ```text
//! data → {shape, entries, dirs}
//! entries → shape
//! dirs  → (std/dirs 仅)
//! ```
//!
//! 单向，无环。

pub mod data;
pub mod dirs;
pub mod entries;
pub mod shape;

/// 形态词汇表（`writers` 三条腿按它分派）。
pub use data::HookTarget;
/// 域内外消费的**唯一事实表**（`writers` 按行安装，`server` 按行校验路由）。
pub use data::HOOK_TARGETS;
/// Claude 兼容面共用的事件表（三个 `HookTarget` 行按**指针**共享同一份）。
pub use entries::CLAUDE_COMPAT_ENTRIES;
pub use shape::{HookEntry, InstallShape, TrustSpec};

#[cfg(test)]
mod tests;
