//! Git 冲突读路径的纯语义层与载荷预算。
//!
//! 真值来源是 index 的 unmerged stages（1/2/3），不是工作区 marker 字节
//! （四类冲突无 marker，`design.md` §0）。本模块只含纯函数与纯数据，I/O 在后续批次的
//! `local.rs` / `shell.rs` / `operations/conflict.rs`。
//!
//! 红线 9：本文件只做 `pub mod` + `pub use`，无 `fn` / `impl`。

pub mod cap;
pub mod classify;
pub mod local;
pub mod probe;
pub mod regions;
pub mod shell;
pub mod types;

pub use cap::{cap_conflict_payload, CONFLICT_PAYLOAD_MAX_BYTES};
pub use classify::classify;
pub use probe::{probe_bytes, ConflictGroup, RawConflictEntry, RenameMap};
pub use regions::{
    build_regions, has_conflict_markers, scan_merge_markers, splice_regions,
    validate_region_decisions, RawRegion,
};
pub use types::{
    ConflictKind, ConflictResolution, ConflictSide, ConflictStages, MergeRegion, RegionTake,
    TakeSide,
};

#[cfg(test)]
mod tests;
