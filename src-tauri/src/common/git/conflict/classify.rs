//! 冲突类型判定（**纯函数，无 I/O，唯一语义判定点**）。
//!
//! 判据严格来自实测（`design.md` §0 表），不猜：
//! - DD 不产生 unmerged 条目 → 不在此处（`has_base=true, ours=false, theirs=false` 组合在真实
//!   index 中不可达；给显式分支会造出假的可达路径）；
//! - binary 优先级最高：即使三侧齐备也不做区域合并；
//! - 路径分歧 + 两侧齐备 → `RenameRename`（只看存在性会误判为 `BothAdded`）。

use super::types::ConflictKind;

/// stage 存在性 + 路径分歧 + binary → [`ConflictKind`]。**无 I/O。**
///
/// `paths_differ` 由调用方（`local.rs` / `shell.rs`）比较三侧 path 得出，不在本函数内做 I/O。
///
/// 判据（`design.md` §2.2）：
/// - `any_binary` → `Binary`（最高优先级）；
/// - `paths_differ` → `RenameRename`；
/// - `(true, true, *)` 且 `has_base` → `BothModified`（UU）；
/// - `(false, true, true)` → `BothAdded`（AA，无 base）；
/// - 其余（含 UD / DU 与真实 index 不可达的组合）→ `ModifyDelete`（最保守：整文件二选一）。
#[must_use]
pub const fn classify(
    has_base: bool,
    has_ours: bool,
    has_theirs: bool,
    any_binary: bool,
    paths_differ: bool,
) -> ConflictKind {
    if any_binary {
        return ConflictKind::Binary;
    }
    if paths_differ {
        return ConflictKind::RenameRename;
    }
    match (has_base, has_ours, has_theirs) {
        (true, true, true) => ConflictKind::BothModified, // UU：1+2+3
        (false, true, true) => ConflictKind::BothAdded,   // AA：2+3（无 base）
        // UD (1+2) / DU (1+3) 及真实 index 不可达的组合：整文件二选一。
        _ => ConflictKind::ModifyDelete,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uu_is_both_modified() {
        assert_eq!(
            classify(true, true, true, false, false),
            ConflictKind::BothModified
        );
    }

    #[test]
    fn aa_is_both_added() {
        assert_eq!(
            classify(false, true, true, false, false),
            ConflictKind::BothAdded
        );
    }

    #[test]
    fn du_is_modify_delete() {
        // 我方删 / 对方改：1+3，无 ours。
        assert_eq!(
            classify(true, false, true, false, false),
            ConflictKind::ModifyDelete
        );
    }

    #[test]
    fn ud_is_modify_delete() {
        // 我方改 / 对方删：1+2，无 theirs。
        assert_eq!(
            classify(true, true, false, false, false),
            ConflictKind::ModifyDelete
        );
    }

    #[test]
    fn rename_delete_is_modify_delete() {
        // rename/delete：1+3，同路径。
        assert_eq!(
            classify(true, false, true, false, false),
            ConflictKind::ModifyDelete
        );
    }

    #[test]
    fn rename_rename_when_paths_differ() {
        assert_eq!(
            classify(true, true, true, false, true),
            ConflictKind::RenameRename
        );
        // 只看存在性会误判为 BothAdded —— 这正是 paths_differ 必须优先的原因。
        assert_eq!(
            classify(false, true, true, false, true),
            ConflictKind::RenameRename
        );
    }

    #[test]
    fn binary_takes_priority_over_everything() {
        for base in [false, true] {
            for ours in [false, true] {
                for theirs in [false, true] {
                    for paths_differ in [false, true] {
                        assert_eq!(
                            classify(base, ours, theirs, true, paths_differ),
                            ConflictKind::Binary,
                            "any_binary 必须优先：base={base} ours={ours} theirs={theirs} paths_differ={paths_differ}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn unreachable_combos_fall_back_to_modify_delete() {
        // 真实 index 不可达，但显式归 ModifyDelete（最保守）。
        assert_eq!(
            classify(false, false, false, false, false),
            ConflictKind::ModifyDelete
        );
        assert_eq!(
            classify(true, false, false, false, false),
            ConflictKind::ModifyDelete
        );
        assert_eq!(
            classify(false, true, false, false, false),
            ConflictKind::ModifyDelete
        );
        assert_eq!(
            classify(false, false, true, false, false),
            ConflictKind::ModifyDelete
        );
    }

    #[test]
    fn only_uu_and_aa_are_region_mergeable() {
        // 防 T9：把 ModifyDelete 算进来会让「选我方删除」写出空文件。
        assert!(ConflictKind::BothModified.is_region_mergeable());
        assert!(ConflictKind::BothAdded.is_region_mergeable());
        assert!(!ConflictKind::ModifyDelete.is_region_mergeable());
        assert!(!ConflictKind::RenameRename.is_region_mergeable());
        assert!(!ConflictKind::Binary.is_region_mergeable());
    }
}
