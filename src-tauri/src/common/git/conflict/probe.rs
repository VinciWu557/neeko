//! 两侧 transport 共用的**纯逻辑**（无 git 进程 / 无 I/O）：blob 探测、index 分组、三侧组装。
//!
//! **为什么组装也住在这里**：`any_binary` / `paths_differ` / `classify` / `ConflictStages` 构造 /
//! 区域构建这套语义**与传输方式无关**，只与「三侧现状」有关。此前 `local.rs` 与 `shell.rs`
//! 各持一份（`distinct_paths` / `side_lines` md5 逐字相同），而跨实现重复就是分叉温床 ——
//! `other_commit` 的 `.ok()?` 语义漂移曾让 cherry-pick 的 rename/rename 只在 shell 侧退化
//! （`git-domain.md` §5c）。收敛后两侧只剩「怎么取到三侧字节」的差异。
//!
//! **binary 判据**与 `common/file/reader.rs::is_binary_file` 同源：前 8KB 含 `0x00` 即视为
//! 二进制（该函数是 private，故此处自持一份同判据实现）。二进制侧不解码内容
//! （`design.md` §2.4 契约 ③）。
//!
//! **分组**是必须的：libgit2（以及 `git ls-files -u`）把 rename/rename 冲突存成**三条互不
//! 相关的 unmerged 条目**（stage1 在原路径、stage2 在我方重命名目标、stage3 在对方重命名目标），
//! index 本身不保留「这三条属于同一次冲突」的关联。`conflict_get(path)` 因此只能取到单侧
//! （实测：`ancestor=Some("a.txt"), our=None, their=None`）。要让 `ConflictStages` 报出
//! 「三侧 path 各不相同」的 rename/rename，必须用 **merge-base 两侧的重命名映射**把条目重新
//! 归组（与 git 自身判定 rename 的方式一致）。

use std::collections::{BTreeMap, HashMap};

use super::classify::classify;
use super::regions::{build_regions, scan_merge_markers};
use super::types::{ConflictSide, ConflictStages};

/// index unmerged 中的一条原始条目（从 git2 `IndexEntry` 或 `git ls-files -u` 解析）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawConflictEntry {
    /// stage：1 = base（ancestor），2 = ours，3 = theirs。
    pub stage: u8,
    /// 该侧路径（rename/rename 下三侧可不同）。
    pub path: String,
    /// blob oid（hex）。
    pub oid: String,
    /// 文件 mode。
    pub mode: u32,
}

/// 单侧重命名映射：`base path -> renamed path`（来自 `diff -M <base> <side>`）。
#[derive(Debug, Default, Clone)]
pub struct RenameMap {
    base_to_renamed: HashMap<String, String>,
}

impl RenameMap {
    /// 记录一次重命名。
    pub fn insert(&mut self, base: String, renamed: String) {
        self.base_to_renamed.insert(base, renamed);
    }

    /// 反查：某路径若是一次重命名的**目标**，返回其源（base）路径。
    #[must_use]
    pub fn base_of(&self, path: &str) -> Option<&str> {
        self.base_to_renamed
            .iter()
            .find(|(_, renamed)| renamed.as_str() == path)
            .map(|(base, _)| base.as_str())
    }
}

/// 一次逻辑冲突的三侧原始条目（按逻辑祖先路径归组）。
#[derive(Debug, Default, Clone)]
pub struct ConflictGroup {
    /// 逻辑祖先路径（归组键）。
    pub base_path: String,
    /// stage 1。
    pub ancestor: Option<RawConflictEntry>,
    /// stage 2。
    pub ours: Option<RawConflictEntry>,
    /// stage 3。
    pub theirs: Option<RawConflictEntry>,
}

impl ConflictGroup {
    /// 调用方给定的文件路径是否落在本组（逻辑祖先路径或任一侧路径）。
    #[must_use]
    pub fn contains_path(&self, path: &str) -> bool {
        self.base_path == path
            || [&self.ancestor, &self.ours, &self.theirs]
                .into_iter()
                .any(|side| side.as_ref().is_some_and(|e| e.path == path))
    }
}

/// 把原始 unmerged 条目按**逻辑祖先路径**归组。
///
/// 归组键：先把条目路径经两侧重命名映射反查回源路径（`our.base_of` 优先，其次
/// `their.base_of`），取不到则用自身。UU / AA / DU / UD 的重命名映射为空 ⇒ 键 = 路径本身，
/// 与既有语义一致；rename/rename 的三条因此收敛到同一键。
#[must_use]
pub fn group_conflicts(
    entries: Vec<RawConflictEntry>,
    our_rename: &RenameMap,
    their_rename: &RenameMap,
) -> Vec<ConflictGroup> {
    let mut map: BTreeMap<String, ConflictGroup> = BTreeMap::new();
    for entry in entries {
        let key = logical_base_path(&entry.path, our_rename, their_rename);
        let group = map.entry(key.clone()).or_insert_with(|| ConflictGroup {
            base_path: key,
            ..ConflictGroup::default()
        });
        match entry.stage {
            1 => group.ancestor = Some(entry),
            2 => group.ours = Some(entry),
            3 => group.theirs = Some(entry),
            _ => {}
        }
    }
    map.into_values().collect()
}

/// 条目路径 → 逻辑祖先路径。
fn logical_base_path(path: &str, our: &RenameMap, their: &RenameMap) -> String {
    our.base_of(path)
        .or_else(|| their.base_of(path))
        .unwrap_or(path)
        .to_string()
}

/// 二进制判定：前 8KB 含 `0x00`（与 `common/file/reader.rs::is_binary_file` 同源）。
#[must_use]
pub fn is_binary_bytes(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|&b| b == 0)
}

/// 探测 blob 字节：返回 `(是否二进制, 文本内容)`。
///
/// 二进制返回 `(true, None)`（**不解码**，`design.md` §2.4 契约 ③）；否则返回
/// `(false, Some(text))`（非 UTF-8 字节以 lossy 方式替换，不因此判为二进制）。
#[must_use]
pub fn probe_bytes(bytes: &[u8]) -> (bool, Option<String>) {
    if is_binary_bytes(bytes) {
        (true, None)
    } else {
        (false, Some(String::from_utf8_lossy(bytes).to_string()))
    }
}

// ── 三侧组装（两 transport 共用）─────────────────────────────────────────────

/// 三侧已探测的现状 —— 传输差异到此为止，往后的组装与传输方式无关。
#[derive(Debug, Default)]
pub struct ConflictSides {
    /// stage 1（缺失 = `None`，**绝不归一为空串**）。
    pub ancestor: Option<ConflictSide>,
    /// stage 2。
    pub ours: Option<ConflictSide>,
    /// stage 3。
    pub theirs: Option<ConflictSide>,
}

/// 组内互异路径数（`> 1` ⇒ rename/rename 的路径分歧判据）。
#[must_use]
pub fn distinct_paths(group: &ConflictGroup) -> usize {
    let mut paths: Vec<&str> = [&group.ancestor, &group.ours, &group.theirs]
        .into_iter()
        .flatten()
        .map(|e| e.path.as_str())
        .collect();
    paths.sort_unstable();
    paths.dedup();
    paths.len()
}

/// 侧内容 → 行向量（区域切片用；`None` / binary 侧为空向量）。
#[must_use]
pub fn side_lines(side: Option<&ConflictSide>) -> Vec<String> {
    match side.and_then(|s| s.content.as_deref()) {
        Some(content) => content.lines().map(str::to_string).collect(),
        None => Vec::new(),
    }
}

/// 分类 + 组装骨架（`merged` / `regions` 留空，由 [`attach_regions`] 填）。
///
/// **`ConflictStages` 的唯一构造点**：`region_mergeable` 在此由 `kind` 派生一次并上 wire，
/// 前端因此不需要（也不允许）持有第二份「哪些 kind 可区域合并」的判据。
#[must_use]
pub fn assemble_stages(
    file_path: &str,
    group: &ConflictGroup,
    sides: ConflictSides,
) -> ConflictStages {
    let any_binary = [&sides.ancestor, &sides.ours, &sides.theirs]
        .into_iter()
        .flatten()
        .any(|side| side.is_binary);
    let kind = classify(
        group.ancestor.is_some(),
        group.ours.is_some(),
        group.theirs.is_some(),
        any_binary,
        distinct_paths(group) > 1,
    );
    ConflictStages {
        path: file_path.to_string(),
        kind,
        ancestor: sides.ancestor,
        ours: sides.ours,
        theirs: sides.theirs,
        merged: None,
        regions: Vec::new(),
        truncated: false,
        region_mergeable: kind.is_region_mergeable(),
    }
}

/// merge 引擎产出的 diff3 文本 → 区域列表 + `merged`，一并挂到 stages。
///
/// 两者一起赋值是**一个语义动作**（「这次合并的产物」）：分开写会让调用方可能只填一个，
/// 于是出现「有区域无合并文本」的半残状态。marker 知识仍只在 `regions.rs`（护栏 A1），
/// 这里只调它的解析入口。
pub fn attach_regions(stages: &mut ConflictStages, merged_text: String) {
    let regions = build_regions(
        merged_text.lines().count(),
        scan_merge_markers(&merged_text),
        &side_lines(stages.ancestor.as_ref()),
        &side_lines(stages.ours.as_ref()),
        &side_lines(stages.theirs.as_ref()),
    );
    stages.regions = regions;
    stages.merged = Some(merged_text);
}

/// 该路径是否**需要**重命名映射才能正确归组。
///
/// 重命名映射来自 `diff -M <merge-base> <side>` 的**全仓 tree diff**，代价不小；而它只对
/// rename 系冲突有意义。可跳过的判据很窄：**stage 1/2/3 全部落在同一路径** —— 祖先与两侧
/// 同路径即证明两侧都没重命名（重命名会把 stage2/stage3 挪到别的路径）。这正是最常见的 UU。
///
/// 任一侧缺失或 stage1 不在该路径 ⇒ **必须**算映射，否则静默失真：
/// - rename/rename（含双方重命名到**同一**目标：stage2+3 同路径、stage1 在源路径）会被误判成
///   `both_added`（裸路径下看不到 stage1）；
/// - rename/delete 会丢掉祖先侧，退化成普通 modify_delete。
///
/// 判错的方向是「多跑一次 tree diff」而不是「分类错误」—— 保守侧是有意的。
#[must_use]
pub fn needs_rename_maps(entries: &[RawConflictEntry], path: &str) -> bool {
    let mut at_path = [false; 4];
    for entry in entries.iter().filter(|e| e.path == path) {
        // 只计 stage 1..=3：stage 0（已解决）不算齐备，否则会把「已收敛」当成 UU 而跳过映射。
        if let stage @ 1..=3 = entry.stage {
            at_path[usize::from(stage)] = true;
        }
    }
    !(at_path[1] && at_path[2] && at_path[3])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::git::conflict::types::{ConflictKind, ConflictSide};

    fn entry(stage: u8, path: &str) -> RawConflictEntry {
        RawConflictEntry {
            stage,
            path: path.to_string(),
            oid: format!("oid-{stage}-{path}"),
            mode: 0o100_644,
        }
    }

    #[test]
    fn binary_detection_matches_nul_probe() {
        assert!(is_binary_bytes(b"\x00\x01BIN"));
        assert!(!is_binary_bytes(b"plain text\n"));
        assert!(!is_binary_bytes("中文内容".as_bytes()));
    }

    #[test]
    fn probe_binary_yields_no_content() {
        assert_eq!(probe_bytes(b"a\x00b"), (true, None));
        assert_eq!(probe_bytes(b"a\nb\n"), (false, Some("a\nb\n".to_string())));
    }

    #[test]
    fn uu_groups_by_path() {
        let our = RenameMap::default();
        let their = RenameMap::default();
        let groups = group_conflicts(
            vec![entry(1, "f.txt"), entry(2, "f.txt"), entry(3, "f.txt")],
            &our,
            &their,
        );
        assert_eq!(groups.len(), 1);
        assert!(groups[0].ancestor.is_some());
        assert!(groups[0].ours.is_some());
        assert!(groups[0].theirs.is_some());
    }

    #[test]
    fn rename_rename_groups_three_distinct_paths() {
        // a.txt 在 HEAD 重命名为 c.txt、在对方重命名为 z.txt。
        let mut our = RenameMap::default();
        our.insert("a.txt".to_string(), "c.txt".to_string());
        let mut their = RenameMap::default();
        their.insert("a.txt".to_string(), "z.txt".to_string());
        let groups = group_conflicts(
            vec![entry(1, "a.txt"), entry(2, "c.txt"), entry(3, "z.txt")],
            &our,
            &their,
        );
        assert_eq!(groups.len(), 1, "三条必须归为同一逻辑冲突");
        let group = &groups[0];
        assert_eq!(group.base_path, "a.txt");
        assert_eq!(
            (
                group.ancestor.as_ref().map(|e| e.path.as_str()),
                group.ours.as_ref().map(|e| e.path.as_str()),
                group.theirs.as_ref().map(|e| e.path.as_str()),
            ),
            (Some("a.txt"), Some("c.txt"), Some("z.txt"))
        );
        assert!(group.contains_path("a.txt"));
        assert!(group.contains_path("c.txt"));
        assert!(group.contains_path("z.txt"));
    }

    #[test]
    fn rename_delete_same_target_groups_by_source() {
        // 我方 a.txt -> b.txt，对方删除：stage1/stage2 都在 b.txt。
        let mut our = RenameMap::default();
        our.insert("a.txt".to_string(), "b.txt".to_string());
        let their = RenameMap::default();
        let groups = group_conflicts(vec![entry(1, "b.txt"), entry(2, "b.txt")], &our, &their);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].base_path, "a.txt");
        assert!(groups[0].theirs.is_none());
    }

    #[test]
    fn aa_groups_by_shared_path() {
        let our = RenameMap::default();
        let their = RenameMap::default();
        let groups = group_conflicts(
            vec![entry(2, "newf.txt"), entry(3, "newf.txt")],
            &our,
            &their,
        );
        assert_eq!(groups.len(), 1);
        assert!(groups[0].ancestor.is_none());
    }

    // ── needs_rename_maps：惰性判据（跳错方向 = 多跑一次 tree diff，不是分类错）──

    fn with_oid(stage: u8, path: &str, oid: &str) -> RawConflictEntry {
        RawConflictEntry {
            stage,
            path: path.to_string(),
            oid: oid.to_string(),
            mode: 0o100_644,
        }
    }

    #[test]
    fn uu_three_stages_same_path_needs_no_rename_maps() {
        let entries = vec![entry(1, "f.txt"), entry(2, "f.txt"), entry(3, "f.txt")];
        assert!(!needs_rename_maps(&entries, "f.txt"));
    }

    #[test]
    fn aa_without_base_still_needs_rename_maps() {
        // 无 stage1 无法排除「双方重命名到同一目标」，保守侧 = 算映射。
        let entries = vec![entry(2, "newf.txt"), entry(3, "newf.txt")];
        assert!(needs_rename_maps(&entries, "newf.txt"));
    }

    #[test]
    fn rename_rename_to_same_target_is_not_skipped() {
        // `git mv a b` 两侧：stage1 在 a.txt、stage2+3 都在 b.txt。
        // 裸路径下 b.txt 看起来像 AA（无 stage1）—— 正是惰性判据最易误伤的用例。
        let entries = vec![entry(1, "a.txt"), entry(2, "b.txt"), entry(3, "b.txt")];
        assert!(needs_rename_maps(&entries, "b.txt"));
        assert!(needs_rename_maps(&entries, "a.txt"));
    }

    #[test]
    fn modify_delete_and_unknown_path_need_rename_maps() {
        let du = vec![entry(1, "c.txt"), entry(3, "c.txt")];
        assert!(needs_rename_maps(&du, "c.txt"), "DU：ours 缺失");
        let ud = vec![entry(1, "c.txt"), entry(2, "c.txt")];
        assert!(needs_rename_maps(&ud, "c.txt"), "UD：theirs 缺失");
        assert!(needs_rename_maps(&du, "nope.txt"), "未知路径不得静默跳过");
    }

    #[test]
    fn unrelated_stage_numbers_do_not_fake_completeness() {
        // stage 0（已解决）不计入三侧齐备，否则会把「已收敛」当成 UU 而跳过映射。
        let entries = vec![
            with_oid(0, "f.txt", "resolved"),
            entry(2, "f.txt"),
            entry(3, "f.txt"),
        ];
        assert!(needs_rename_maps(&entries, "f.txt"));
    }

    // ── assemble_stages / attach_regions：两 transport 共用的语义组装 ──

    fn side(content: Option<&str>) -> ConflictSide {
        ConflictSide {
            path: Some("f.txt".to_string()),
            content: content.map(str::to_string),
            size: u64::try_from(content.map_or(0, str::len)).unwrap_or(u64::MAX),
            is_binary: false,
            truncated: false,
        }
    }

    #[test]
    fn assemble_sets_region_mergeable_once_from_kind() {
        let groups = group_conflicts(
            vec![entry(1, "f.txt"), entry(2, "f.txt"), entry(3, "f.txt")],
            &RenameMap::default(),
            &RenameMap::default(),
        );
        let sides = ConflictSides {
            ancestor: Some(side(Some("base\n"))),
            ours: Some(side(Some("ours\n"))),
            theirs: Some(side(Some("theirs\n"))),
        };
        let stages = assemble_stages("f.txt", &groups[0], sides);
        assert_eq!(stages.kind, ConflictKind::BothModified);
        assert!(
            stages.region_mergeable,
            "region_mergeable 必须与 kind.is_region_mergeable() 一致"
        );
        assert_eq!(stages.region_mergeable, stages.kind.is_region_mergeable());
        assert!(stages.merged.is_none() && stages.regions.is_empty());
    }

    #[test]
    fn assemble_marks_modify_delete_as_not_region_mergeable() {
        // T9：删除不是内容，对它区域合并后选「我方」只会写出空文件。
        let groups = group_conflicts(
            vec![entry(1, "c.txt"), entry(3, "c.txt")],
            &RenameMap::default(),
            &RenameMap::default(),
        );
        let sides = ConflictSides {
            ancestor: Some(side(Some("base\n"))),
            ours: None,
            theirs: Some(side(Some("theirs\n"))),
        };
        let stages = assemble_stages("c.txt", &groups[0], sides);
        assert_eq!(stages.kind, ConflictKind::ModifyDelete);
        assert!(!stages.region_mergeable);
        assert!(stages.ours.is_none(), "缺失 stage 必须以 None 上浮");
    }

    #[test]
    fn assemble_classifies_rename_rename_by_path_divergence() {
        let mut our = RenameMap::default();
        our.insert("a.txt".to_string(), "c.txt".to_string());
        let mut their = RenameMap::default();
        their.insert("a.txt".to_string(), "z.txt".to_string());
        let groups = group_conflicts(
            vec![entry(1, "a.txt"), entry(2, "c.txt"), entry(3, "z.txt")],
            &our,
            &their,
        );
        let sides = ConflictSides {
            ancestor: Some(side(Some("base\n"))),
            ours: Some(side(Some("ours\n"))),
            theirs: Some(side(Some("theirs\n"))),
        };
        let stages = assemble_stages("a.txt", &groups[0], sides);
        assert_eq!(stages.kind, ConflictKind::RenameRename);
        assert!(!stages.region_mergeable, "三侧路径不同 ⇒ 行区间无意义");
    }

    #[test]
    fn region_mergeable_is_only_true_for_uu_and_aa() {
        // 三侧齐备同路径（UU）vs 无 base 同路径（AA）vs binary：前两者可区域合并。
        let uu = group_conflicts(
            vec![entry(1, "f.txt"), entry(2, "f.txt"), entry(3, "f.txt")],
            &RenameMap::default(),
            &RenameMap::default(),
        );
        let aa = group_conflicts(
            vec![entry(2, "n.txt"), entry(3, "n.txt")],
            &RenameMap::default(),
            &RenameMap::default(),
        );
        let sides3 = || ConflictSides {
            ancestor: Some(side(Some("base\n"))),
            ours: Some(side(Some("ours\n"))),
            theirs: Some(side(Some("theirs\n"))),
        };
        let sides2 = || ConflictSides {
            ancestor: None,
            ours: Some(side(Some("ours\n"))),
            theirs: Some(side(Some("theirs\n"))),
        };

        let uu_stages = assemble_stages("f.txt", &uu[0], sides3());
        let aa_stages = assemble_stages("n.txt", &aa[0], sides2());
        assert_eq!(uu_stages.kind, ConflictKind::BothModified);
        assert_eq!(aa_stages.kind, ConflictKind::BothAdded);
        assert!(uu_stages.region_mergeable && aa_stages.region_mergeable);

        // binary 优先：三侧齐备也不可区域合并（不解码内容，行区间无意义）。
        let mut binary_sides = sides3();
        binary_sides.ours.as_mut().expect("ours").is_binary = true;
        binary_sides.ours.as_mut().expect("ours").content = None;
        let binary = assemble_stages("f.txt", &uu[0], binary_sides);
        assert_eq!(binary.kind, ConflictKind::Binary);
        assert!(!binary.region_mergeable);

        // 不变量：wire 上的布尔永远等于 kind 的语义判定（单一派生点）。
        for stages in [&uu_stages, &aa_stages, &binary] {
            assert_eq!(stages.region_mergeable, stages.kind.is_region_mergeable());
        }
    }

    #[test]
    fn region_mergeable_serializes_with_the_frontend_field_name() {
        // 前端按 `region_mergeable` 读（`shared/types/git.ts`）—— 字段名是 wire 契约，
        // 改名会让前端恒读到 undefined ⇒ 所有冲突都退化成不透明卡（且不报错）。
        let groups = group_conflicts(
            vec![entry(1, "f.txt"), entry(2, "f.txt"), entry(3, "f.txt")],
            &RenameMap::default(),
            &RenameMap::default(),
        );
        let stages = assemble_stages(
            "f.txt",
            &groups[0],
            ConflictSides {
                ancestor: Some(side(Some("base\n"))),
                ours: Some(side(Some("ours\n"))),
                theirs: Some(side(Some("theirs\n"))),
            },
        );
        let json = serde_json::to_value(&stages).expect("serialize stages");
        assert_eq!(json.get("region_mergeable"), Some(&serde_json::json!(true)));
        assert_eq!(json.get("kind"), Some(&serde_json::json!("both_modified")));
    }

    #[test]
    fn attach_regions_always_assigns_merged_even_without_regions() {
        let groups = group_conflicts(
            vec![entry(1, "f.txt"), entry(2, "f.txt"), entry(3, "f.txt")],
            &RenameMap::default(),
            &RenameMap::default(),
        );
        let sides = ConflictSides {
            ancestor: Some(side(Some("base\n"))),
            ours: Some(side(Some("ours\n"))),
            theirs: Some(side(Some("theirs\n"))),
        };
        let mut stages = assemble_stages("f.txt", &groups[0], sides);
        // 无 marker 的合并输出（已自动合并）：`merged` 仍必须落地 —— 两者是同一个
        // 语义动作，不得出现「有 merged 无区域 ⇒ 前端当成不可合并」的半残态。
        // （marker 形态的用例不写在这里：marker 字面量只允许活在 `regions.rs` 与
        // 豁免的测试文件（护栏 A1）；区域填充路径由 `tests.rs` 的 UU 夹具端到端覆盖。）
        attach_regions(&mut stages, "ours\nbase\ntheirs\n".to_string());
        assert_eq!(stages.merged.as_deref(), Some("ours\nbase\ntheirs\n"));
        assert!(stages.regions.is_empty());
    }
}
