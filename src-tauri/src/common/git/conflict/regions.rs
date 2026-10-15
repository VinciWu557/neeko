//! 冲突区域解析（**纯函数**）：把 merge 引擎产出的 diff3 文本切成 [`MergeRegion`]。
//!
//! 本模块是**唯一**允许出现 `<<<<<<<` / `|||||||` / `=======` / `>>>>>>>` 字面量的地方
//! （护栏 `check_conflict_read_contract` 判据 A1）：marker 不是真值，只是我们自己调 merge
//! 引擎（`style_diff3(true)` / `--diff3`）后可控的渲染产物，扫描它得到区域，而不是从工作区
//! 反解冲突。
//!
//! 区间一律做**夹取**（越界不 panic）：内部错误用 `debug_assert` 暴露。

use super::types::MergeRegion;

/// 冲突标记行首（**唯一出现处**：护栏 A1 要求全部 marker 字面量只在本文件）。
///
/// 这些是**我们自己调 merge 引擎**（`style_diff3(true)` / `--diff3`）产出的可控渲染产物，
/// 不是从工作区反解冲突的真值来源。
const MARKER_OURS: &str = "<<<<<<<";
const MARKER_BASE: &str = "|||||||";
const MARKER_SPLIT: &str = "=======";
const MARKER_THEIRS: &str = ">>>>>>>";

/// 文本是否含冲突标记（供 `shell.rs` 区分「merge-file 的 exit code = 冲突数」与真错误）。
///
/// 放在此处而不是调用方：marker 知识只允许有一个 owner（护栏 A1）。
#[must_use]
pub fn has_conflict_markers(text: &str) -> bool {
    text.contains(MARKER_OURS)
}

/// 合并文本中扫描出的原始冲突区域（尚未夹取、未分配 id）。
///
/// 只记录**位置与行数**：三侧候选行由调用方提供的完整侧内容按 `start/count` 切片得到，
/// 因此夹取天然落在切片上，越界不 panic。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawRegion {
    /// 合并输出中的起始行（0-based，指向 `<<<<<<<`）。
    pub merged_start: usize,
    /// 合并输出中的结束行（0-based 半开，指向 `>>>>>>>` 之后）。
    pub merged_end: usize,
    /// base 侧原文起始行（0-based）。
    pub base_start: usize,
    /// base 侧候选行数（无 base 段时为 0）。
    pub base_count: usize,
    /// ours 侧原文起始行（0-based）。
    pub our_start: usize,
    /// ours 侧候选行数。
    pub our_count: usize,
    /// theirs 侧原文起始行（0-based）。
    pub their_start: usize,
    /// theirs 侧候选行数。
    pub their_count: usize,
}

/// 扫描我们自己产出的 diff3 合并文本，提取原始冲突区域。
///
/// 三侧原文起始行通过**游标推进**得到：区域外的上下文行同时推进三侧，区域内的候选行只推进
/// 对应侧。这样即便 base 段缺失（AA），各侧起始位置仍然正确。
///
/// 输入必须是本模块可控格式（每侧标签由我们施加）：marker 行以固定前缀开始。不依赖用户的
/// `merge.conflictStyle` 配置。
#[must_use]
pub fn scan_merge_markers(merged: &str) -> Vec<RawRegion> {
    let lines: Vec<&str> = merged.lines().collect();
    let mut regions = Vec::new();
    let (mut base_cursor, mut our_cursor, mut their_cursor) = (0usize, 0usize, 0usize);
    let mut i = 0usize;

    while i < lines.len() {
        if !lines[i].starts_with(MARKER_OURS) {
            base_cursor += 1;
            our_cursor += 1;
            their_cursor += 1;
            i += 1;
            continue;
        }

        let merged_start = i;
        i += 1; // 跳过 <<<<<<<
        let our_start = our_cursor;
        while i < lines.len()
            && !lines[i].starts_with(MARKER_BASE)
            && !lines[i].starts_with(MARKER_SPLIT)
        {
            our_cursor += 1;
            i += 1;
        }
        let our_count = our_cursor - our_start;

        let base_start = base_cursor;
        if i < lines.len() && lines[i].starts_with(MARKER_BASE) {
            i += 1; // 跳过 |||||||
            while i < lines.len() && !lines[i].starts_with(MARKER_SPLIT) {
                base_cursor += 1;
                i += 1;
            }
        }
        let base_count = base_cursor - base_start;

        if i < lines.len() && lines[i].starts_with(MARKER_SPLIT) {
            i += 1; // 跳过 =======
        }
        let their_start = their_cursor;
        while i < lines.len() && !lines[i].starts_with(MARKER_THEIRS) {
            their_cursor += 1;
            i += 1;
        }
        let their_count = their_cursor - their_start;

        if i < lines.len() && lines[i].starts_with(MARKER_THEIRS) {
            i += 1; // 跳过 >>>>>>>
        }

        regions.push(RawRegion {
            merged_start,
            merged_end: i,
            base_start,
            base_count,
            our_start,
            our_count,
            their_start,
            their_count,
        });
    }

    regions
}

/// 把原始区域组装为 [`MergeRegion`]：分配 id、从三侧完整内容切片、并对所有区间做夹取。
///
/// 越界（`merged_start` 超出 `merged_line_count`、侧 `start + count` 超出侧内容长度）一律
/// **夹取**而非 panic —— 表现层拿到的是「尽可能正确」的区域，内部不一致由 `debug_assert` 暴露。
#[must_use]
pub fn build_regions(
    merged_line_count: usize,
    raw: Vec<RawRegion>,
    base_lines: &[String],
    our_lines: &[String],
    their_lines: &[String],
) -> Vec<MergeRegion> {
    raw.into_iter()
        .enumerate()
        .map(|(idx, region)| {
            debug_assert!(
                region.merged_start <= region.merged_end,
                "raw region merged_start 不得大于 merged_end"
            );
            let merged_start = region.merged_start.min(merged_line_count);
            let end = region.merged_end.max(region.merged_start);
            let merged_end = end.min(merged_line_count);
            let (base_start, base_lines) =
                slice_side(base_lines, region.base_start, region.base_count);
            let (our_start, our_lines) = slice_side(our_lines, region.our_start, region.our_count);
            let (their_start, their_lines) =
                slice_side(their_lines, region.their_start, region.their_count);
            MergeRegion {
                id: to_u32(idx),
                merged_start: to_u32(merged_start),
                merged_end: to_u32(merged_end),
                base_lines,
                our_lines,
                their_lines,
                base_start: to_u32(base_start),
                our_start: to_u32(our_start),
                their_start: to_u32(their_start),
            }
        })
        .collect()
}

/// 从一侧完整内容中切出 `[start, start + count)` 区间，并把两端夹取到内容长度内。
fn slice_side(lines: &[String], start: usize, count: usize) -> (usize, Vec<String>) {
    let begin = start.min(lines.len());
    let end = start.saturating_add(count).min(lines.len());
    (begin, lines[begin..end].to_vec())
}

/// `usize` 行号 → wire `u32`；溢出按 `u32::MAX` 饱和（不 panic、不截断错误值）。
fn to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// 按区域决议拼接合并文本：已决议区域替换为所选候选行，未决议区域**保留原 marker 行**。
///
/// 纯函数（无 I/O），是决议写回的文本侧唯一实现。契约：
/// - 输入 `merged` 必须是**服务端重读**的完整合并文本（不信前端行号）；
/// - `regions` 的行区间（`merged_start..merged_end`，0-based 半开）按**逆序**处理 ——
///   前面的区域被替换后行数会变，逆序保证后续下标不受影响；
/// - 未出现在 `decisions` 里的区域原样保留（分批决议）；
/// - `Ours`/`Theirs` 取对应候选行，`Both` = 我方行 + 对方行按序拼接；
/// - 结尾换行：`merged` 以 `\n` 结尾则结果也以 `\n` 结尾（否则不补）。
///
/// 越界区间一律**夹取**（与 [`build_regions`] 同纪律，不 panic）。
#[must_use]
pub fn splice_regions(
    merged: &str,
    regions: &[MergeRegion],
    decisions: &[(u32, super::types::RegionTake)],
) -> String {
    use super::types::RegionTake;

    let trailing_newline = merged.ends_with('\n');
    let mut lines: Vec<String> = merged.lines().map(str::to_string).collect();

    // 逆序：先改靠后的区域，前面的区间下标不因行数变化而漂移。
    let mut ordered: Vec<&MergeRegion> = regions.iter().collect();
    ordered.sort_by_key(|r| std::cmp::Reverse(r.merged_start));

    for region in ordered {
        let Some((_, take)) = decisions.iter().find(|(id, _)| *id == region.id) else {
            continue; // 未决议 → 保留原 marker 行
        };
        let replacement: Vec<String> = match take {
            RegionTake::Ours => region.our_lines.clone(),
            RegionTake::Theirs => region.their_lines.clone(),
            RegionTake::Both => {
                let mut both = region.our_lines.clone();
                both.extend(region.their_lines.iter().cloned());
                both
            }
        };
        let start = (region.merged_start as usize).min(lines.len());
        let end = (region.merged_end as usize)
            .max(region.merged_start as usize)
            .min(lines.len());
        if start > end {
            continue;
        }
        lines.splice(start..end, replacement);
    }

    let mut out = lines.join("\n");
    if trailing_newline && !out.is_empty() {
        out.push('\n');
    }
    out
}

/// 校验区域决议**覆盖全部区域**（无未知 / 无缺失 / 无重复 id）。
///
/// 第一性原理：`git add` 的语义是「该 path 已解决」，而含冲突 marker 的文件不是已解决 ——
/// 一旦放行并 `git add`，就会把带 marker 的文件标成已解决（可被提交）。区域决议是**全函数**：
/// 部分覆盖产出的文本既非「已解决」也非原文，没有明确定义的消费方（要留半截请走编辑器逃生门）。
/// 因此要求 `decisions` 的 id 集合与 `regions` 的 id 集合**恰好相等**。
///
/// 未知 id = 前端视图陈旧（读 → apply 之间仓库变了）⇒ **显式拒绝**，绝不静默拼出半截文件。
/// 本函数是**纯函数**（无 I/O），与 [`splice_regions`] 同住区域语义 owner。
pub fn validate_region_decisions(
    regions: &[MergeRegion],
    decisions: &[(u32, super::types::RegionTake)],
) -> anyhow::Result<()> {
    use std::collections::HashSet;

    let expected: HashSet<u32> = regions.iter().map(|r| r.id).collect();
    let mut seen: HashSet<u32> = HashSet::with_capacity(decisions.len());
    for (id, _) in decisions {
        if !seen.insert(*id) {
            anyhow::bail!("duplicate region id {id} in conflict resolution");
        }
        if !expected.contains(id) {
            anyhow::bail!("unknown region id {id} in conflict resolution (stale view?)");
        }
    }
    if seen.len() != expected.len() {
        anyhow::bail!(
            "region resolution must decide every region ({} decided, {} total)",
            seen.len(),
            expected.len()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn scans_diff3_region_with_base() {
        let merged = "\
context1
<<<<<<< HEAD
our1
our2
||||||| BASE
base1
=======
their1
>>>>>>> THEIRS
context2
";
        let raw = scan_merge_markers(merged);
        assert_eq!(raw.len(), 1, "应解析出一个冲突区域");
        let r = &raw[0];
        assert_eq!(r.merged_start, 1);
        assert_eq!(r.merged_end, 9);
        assert_eq!((r.our_start, r.our_count), (1, 2));
        assert_eq!((r.base_start, r.base_count), (1, 1));
        assert_eq!((r.their_start, r.their_count), (1, 1));
    }

    #[test]
    fn scans_region_without_base() {
        // AA：无 ||||||| 段。
        let merged = "\
<<<<<<< HEAD
our1
=======
their1
>>>>>>> THEIRS
";
        let raw = scan_merge_markers(merged);
        assert_eq!(raw.len(), 1);
        let r = &raw[0];
        assert_eq!(r.base_count, 0, "无 base 段时 base_count 必须为 0");
        assert_eq!((r.our_start, r.our_count), (0, 1));
        assert_eq!((r.their_start, r.their_count), (0, 1));
    }

    #[test]
    fn no_markers_yields_empty() {
        assert!(scan_merge_markers("plain\ntext\n").is_empty());
        assert!(scan_merge_markers("").is_empty());
    }

    #[test]
    fn builds_region_from_scan() {
        let merged = "\
context1
<<<<<<< HEAD
our1
our2
||||||| BASE
base1
=======
their1
>>>>>>> THEIRS
context2
";
        let raw = scan_merge_markers(merged);
        // 三侧都含区域外的上下文行（真实 merge 输出形态）。
        let regions = build_regions(
            merged.lines().count(),
            raw,
            &lines(&["context1", "base1", "context2"]),
            &lines(&["context1", "our1", "our2", "context2"]),
            &lines(&["context1", "their1", "context2"]),
        );
        assert_eq!(regions.len(), 1);
        let region = &regions[0];
        assert_eq!(region.id, 0);
        assert_eq!((region.merged_start, region.merged_end), (1, 9));
        assert_eq!(region.base_lines, lines(&["base1"]));
        assert_eq!(region.our_lines, lines(&["our1", "our2"]));
        assert_eq!(region.their_lines, lines(&["their1"]));
        assert_eq!(
            (region.base_start, region.our_start, region.their_start),
            (1, 1, 1)
        );
    }

    #[test]
    fn out_of_bounds_ranges_are_clamped_without_panic() {
        let raw = vec![RawRegion {
            merged_start: 50,
            merged_end: 80,
            base_start: 100,
            base_count: 5,
            our_start: 0,
            our_count: 1_000_000,
            their_start: 3,
            their_count: 2,
        }];
        let regions = build_regions(
            3,
            raw,
            &lines(&["b0"]),
            &lines(&["o0", "o1"]),
            &lines(&["t0", "t1", "t2", "t3"]),
        );
        assert_eq!(regions.len(), 1);
        let region = &regions[0];
        assert!(region.merged_start <= 3 && region.merged_end <= 3);
        assert!(region.base_start <= 1 && region.base_lines.len() <= 1);
        assert!(region.our_start <= 2 && region.our_lines.len() <= 2);
        assert!(region.their_start <= 4 && region.their_lines.len() <= 4);
    }

    #[test]
    fn empty_raw_yields_empty() {
        let regions = build_regions(10, Vec::new(), &[], &[], &[]);
        assert!(regions.is_empty());
    }

    // ── splice_regions（决议写回的文本侧）────────────────────────────────────

    /// 构造一个含两个区域的 diff3 合并文本，返回 `(merged, regions)`。
    fn two_region_merged() -> (String, Vec<MergeRegion>) {
        let merged = "\
context1
<<<<<<< HEAD
ourA
||||||| BASE
baseA
=======
theirA
>>>>>>> THEIRS
middle
<<<<<<< HEAD
ourB
||||||| BASE
baseB
=======
theirB
>>>>>>> THEIRS
context2
";
        let regions = build_regions(
            merged.lines().count(),
            scan_merge_markers(merged),
            &lines(&["context1", "baseA", "middle", "baseB", "context2"]),
            &lines(&["context1", "ourA", "middle", "ourB", "context2"]),
            &lines(&["context1", "theirA", "middle", "theirB", "context2"]),
        );
        (merged.to_string(), regions)
    }

    #[test]
    fn splice_empty_decisions_returns_merged_unchanged() {
        let (merged, regions) = two_region_merged();
        assert_eq!(splice_regions(&merged, &regions, &[]), merged);
    }

    #[test]
    fn splice_partial_decision_keeps_undecided_marker() {
        use super::super::types::RegionTake;
        let (merged, regions) = two_region_merged();
        // 只决议第一个区域取我方：第二个区域保留 marker。
        let out = splice_regions(&merged, &regions, &[(0, RegionTake::Ours)]);
        assert!(out.contains("ourA"), "已决议区域应替换为我方行");
        assert!(!out.contains("theirA"), "第一个区域的 marker 块应消失");
        // 第二个区域未决议 → marker 仍在。
        assert!(out.contains(MARKER_OURS), "未决议区域必须保留 marker");
        assert!(out.contains("ourB") && out.contains("theirB"));
    }

    #[test]
    fn splice_all_decisions_replaces_both_regions_in_order() {
        use super::super::types::RegionTake;
        let (merged, regions) = two_region_merged();
        let out = splice_regions(
            &merged,
            &regions,
            &[(0, RegionTake::Theirs), (1, RegionTake::Ours)],
        );
        assert!(!out.contains(MARKER_OURS), "全部决议后不应再有 marker");
        let expected = "context1\ntheirA\nmiddle\nourB\ncontext2\n";
        assert_eq!(out, expected, "逆序替换不得串位");
    }

    #[test]
    fn splice_both_concatenates_our_then_their_lines() {
        use super::super::types::RegionTake;
        let (merged, regions) = two_region_merged();
        let out = splice_regions(&merged, &regions, &[(0, RegionTake::Both)]);
        let expected = "context1\nourA\ntheirA\nmiddle\n<<<<<<< HEAD\nourB\n||||||| BASE\nbaseB\n=======\ntheirB\n>>>>>>> THEIRS\ncontext2\n";
        assert_eq!(out, expected);
    }

    #[test]
    fn splice_out_of_range_is_clamped_without_panic() {
        use super::super::types::RegionTake;
        let regions = vec![MergeRegion {
            id: 7,
            merged_start: 100,
            merged_end: 200,
            base_lines: vec![],
            our_lines: lines(&["x"]),
            their_lines: vec![],
            base_start: 0,
            our_start: 0,
            their_start: 0,
        }];
        let out = splice_regions("a\nb\n", &regions, &[(7, RegionTake::Ours)]);
        assert_eq!(out, "a\nb\nx\n", "越界区间夹取到末尾，不 panic");
    }

    #[test]
    fn splice_preserves_absence_of_trailing_newline() {
        use super::super::types::RegionTake;
        let merged = "<<<<<<< HEAD\nour\n=======\ntheir\n>>>>>>> THEIRS";
        let regions = build_regions(
            merged.lines().count(),
            scan_merge_markers(merged),
            &[],
            &lines(&["our"]),
            &lines(&["their"]),
        );
        let out = splice_regions(merged, &regions, &[(0, RegionTake::Theirs)]);
        assert_eq!(out, "their", "merged 无尾换行 → 结果也不补");
    }

    #[test]
    fn multiple_regions_get_sequential_ids() {
        let merged = "\
<<<<<<< HEAD
a
=======
b
>>>>>>> THEIRS
middle
<<<<<<< HEAD
c
=======
d
>>>>>>> THEIRS
";
        let raw = scan_merge_markers(merged);
        let regions = build_regions(
            merged.lines().count(),
            raw,
            &lines(&["a", "middle", "c"]),
            &lines(&["a", "middle", "c"]),
            &lines(&["b", "middle", "d"]),
        );
        assert_eq!(regions.len(), 2);
        assert_eq!(regions[0].id, 0);
        assert_eq!(regions[1].id, 1);
        assert_eq!(regions[1].our_start, 2, "第二个区域的 ours 起始行应已推进");
        assert_eq!(regions[1].their_start, 2);
    }

    // ── validate_region_decisions（全函数契约）──────────────────────────────

    #[test]
    fn validate_accepts_full_coverage() {
        use super::super::types::RegionTake;
        let (_, regions) = two_region_merged();
        assert!(validate_region_decisions(
            &regions,
            &[(0, RegionTake::Ours), (1, RegionTake::Both)]
        )
        .is_ok());
    }

    #[test]
    fn validate_rejects_unknown_region_id() {
        use super::super::types::RegionTake;
        let (_, regions) = two_region_merged();
        let err =
            validate_region_decisions(&regions, &[(0, RegionTake::Ours), (99, RegionTake::Ours)])
                .expect_err("未知 id 必须被拒");
        assert!(err.to_string().contains("unknown region id 99"), "{err}");
    }

    #[test]
    fn validate_rejects_incomplete_coverage() {
        use super::super::types::RegionTake;
        let (_, regions) = two_region_merged();
        let err = validate_region_decisions(&regions, &[(0, RegionTake::Ours)])
            .expect_err("未覆盖全部区域必须被拒");
        assert!(err.to_string().contains("every region"), "{err}");
        assert!(
            validate_region_decisions(&regions, &[]).is_err(),
            "空决议必须被拒"
        );
    }

    #[test]
    fn validate_rejects_duplicate_region_id() {
        use super::super::types::RegionTake;
        let (_, regions) = two_region_merged();
        let err = validate_region_decisions(
            &regions,
            &[
                (0, RegionTake::Ours),
                (0, RegionTake::Theirs),
                (1, RegionTake::Ours),
            ],
        )
        .expect_err("重复 id 必须被拒");
        assert!(err.to_string().contains("duplicate region id 0"), "{err}");
    }

    #[test]
    fn validate_empty_regions_requires_empty_decisions() {
        use super::super::types::RegionTake;
        assert!(validate_region_decisions(&[], &[]).is_ok());
        assert!(validate_region_decisions(&[], &[(0, RegionTake::Ours)]).is_err());
    }
}
