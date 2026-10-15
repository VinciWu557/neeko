//! 冲突三元载荷预算（红线 4 的**唯一实现**）。
//!
//! 冲突是三元载荷：三侧内容叠加极易击穿单次 IPC JSON ≤ 2MB。本模块照抄
//! `parsers::cap_diff_payload` 的**计量纪律** —— 判据是目标度量本身（用真实序列化器
//! `serde_json::to_writer` + 计数 sink 量出 JSON 字节），**禁止**「内容长度 × 近似转义系数」
//! （控制字符 JSON 转义最长 6×，任何近似系数都会被击穿）。
//!
//! 分配序（`design.md` §2.3）：三侧各得保底 → 余量按 ancestor/ours/theirs 顺序填充、先到先得
//! → `merged` 最后分配（派生展示，超预算时优先牺牲）→ 区域列表；任一侧 / merged / regions
//! 被截断即置 `truncated`。

use serde::Serialize;

use super::types::{ConflictSide, ConflictStages};

/// 单次 `get_conflict_stages` IPC 的 **JSON 字节预算**（红线 4：序列化结果 ≤ 2MB）。
///
/// 1.2MB 预算给结构 / `merged` / `regions` / 命令封装留 0.8MB 余量。
pub const CONFLICT_PAYLOAD_MAX_BYTES: usize = 1_200_000;

/// 每侧保底字节：一栏巨大不得饿死其它栏（用户看不到 base 就无法判断）。
const MIN_PER_SIDE_BYTES: usize = 64_000;

/// 顶层结构 + 字段名 + 空数组等固定开销的保守预留。
const STRUCT_JSON_OVERHEAD: usize = 16_384;

/// 只计量字节、不落盘的 `io::Write`：让 `serde_json` 直接给出序列化长度，避免额外分配。
#[derive(Default)]
struct ByteCounter(usize);

impl std::io::Write for ByteCounter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// 任意可序列化值的真实 JSON 字节数（计量失败 fail-closed 返回 `usize::MAX`）。
fn json_len<T: Serialize>(value: &T) -> usize {
    let mut counter = ByteCounter::default();
    match serde_json::to_writer(&mut counter, value) {
        Ok(()) => counter.0,
        Err(_) => usize::MAX,
    }
}

/// 单行内容在 JSON 中的字节数（含数组分隔符 `,`）。
///
/// 逐行计量是**保守**的：真实多行字符串共用一对引号，逐行计量会重复计入引号开销，
/// 只会让我们更早截断，绝不会超出预算。
fn line_json_bytes(line: &str) -> usize {
    let mut counter = ByteCounter::default();
    match serde_json::to_writer(&mut counter, line) {
        Ok(()) => counter.0.saturating_add(1),
        Err(_) => CONFLICT_PAYLOAD_MAX_BYTES.saturating_add(1),
    }
}

/// 内容在 JSON 中的字节需求；超过 `limit` 即提前返回 `limit + 1`（避免对 10MB 内容做全量计量）。
fn needed_bytes(content: &str, limit: usize) -> usize {
    let mut used = 0usize;
    for line in content.lines() {
        let bytes = line_json_bytes(line);
        if used.saturating_add(bytes) > limit {
            return limit.saturating_add(1);
        }
        used += bytes;
    }
    used
}

/// 按行边界把内容截断到 `budget` 字节内；不切多字节字符（`lines()` 天然按字符边界）。
///
/// 返回 `(截断后内容, 已用字节, 是否截断)`。未截断时**原样返回**内容字符串，保证小载荷零改动。
fn cap_text(content: &str, budget: usize) -> (String, usize, bool) {
    let mut used = 0usize;
    let mut keep = 0usize;
    for (idx, line) in content.lines().enumerate() {
        let bytes = line_json_bytes(line);
        if used.saturating_add(bytes) > budget {
            let kept: Vec<&str> = content.lines().take(keep).collect();
            return (kept.join("\n"), used, true);
        }
        used += bytes;
        keep = idx + 1;
    }
    // 预算为 0 且内容非空 → 上面的循环必触发截断；走到这里表示全部装得下。
    let _ = keep;
    (content.to_string(), used, false)
}

/// 分栏共享预算：三侧各得保底，余量按顺序先到先得。返回 `(每侧预算, 剩余预算)`。
fn allocate_side_budgets(needs: [Option<usize>; 3], total: usize) -> ([usize; 3], usize) {
    let mut budgets = [0usize; 3];
    let mut remaining = total;
    for (idx, need) in needs.iter().enumerate() {
        if let Some(need) = need {
            let floor = (*need).min(MIN_PER_SIDE_BYTES);
            budgets[idx] = floor;
            remaining = remaining.saturating_sub(floor);
        }
    }
    for (idx, need) in needs.iter().enumerate() {
        if remaining == 0 {
            break;
        }
        if let Some(need) = need {
            if *need > budgets[idx] {
                let extra = (*need - budgets[idx]).min(remaining);
                budgets[idx] += extra;
                remaining -= extra;
            }
        }
    }
    (budgets, remaining)
}

/// 对单侧施加预算；截断时置该侧 `truncated`。
fn cap_side(side: &mut ConflictSide, budget: usize, truncated: &mut bool) {
    if let Some(content) = side.content.take() {
        let (capped, _used, was_truncated) = cap_text(&content, budget);
        if was_truncated {
            side.truncated = true;
            *truncated = true;
        }
        side.content = Some(capped);
    }
}

/// 把 [`ConflictStages`] 截断到 [`CONFLICT_PAYLOAD_MAX_BYTES`] 内（红线 4 唯一封顶出口）。
///
/// `ConflictStages` 的所有出口都必须过它（唯一构造出口在 `operations::read_conflict_stages`
/// 末尾），新增 transport 自动受约束。
#[must_use]
pub fn cap_conflict_payload(mut stages: ConflictStages) -> ConflictStages {
    let total = CONFLICT_PAYLOAD_MAX_BYTES.saturating_sub(STRUCT_JSON_OVERHEAD);
    let needs = [
        stages
            .ancestor
            .as_ref()
            .and_then(|s| s.content.as_deref())
            .map(|c| needed_bytes(c, total)),
        stages
            .ours
            .as_ref()
            .and_then(|s| s.content.as_deref())
            .map(|c| needed_bytes(c, total)),
        stages
            .theirs
            .as_ref()
            .and_then(|s| s.content.as_deref())
            .map(|c| needed_bytes(c, total)),
    ];
    let (budgets, mut remaining) = allocate_side_budgets(needs, total);

    let mut truncated = false;

    if let Some(side) = stages.ancestor.as_mut() {
        cap_side(side, budgets[0], &mut truncated);
    }
    if let Some(side) = stages.ours.as_mut() {
        cap_side(side, budgets[1], &mut truncated);
    }
    if let Some(side) = stages.theirs.as_mut() {
        cap_side(side, budgets[2], &mut truncated);
    }

    // merged 是派生展示，最后分配；超预算时优先牺牲。
    if let Some(merged) = stages.merged.take() {
        let (capped, used, was_truncated) = cap_text(&merged, remaining);
        if was_truncated {
            truncated = true;
        }
        remaining = remaining.saturating_sub(used);
        stages.merged = Some(capped);
    }

    // 区域列表按剩余预算逐个保留，超出即丢弃尾部队列。
    let mut kept_regions = Vec::with_capacity(stages.regions.len());
    for region in std::mem::take(&mut stages.regions) {
        let bytes = json_len(&region).saturating_add(1);
        if bytes > remaining {
            truncated = true;
            break;
        }
        remaining -= bytes;
        kept_regions.push(region);
    }
    stages.regions = kept_regions;
    stages.truncated = truncated;
    stages
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::git::conflict::types::{ConflictKind, MergeRegion};

    /// 红线 4：单次 Command 返回 JSON ≤ 2MB。
    const IPC_JSON_LIMIT: usize = 2_000_000;

    fn side(content: Option<&str>) -> ConflictSide {
        ConflictSide {
            path: Some("f.txt".to_string()),
            content: content.map(str::to_string),
            size: content.map_or(0, |c| u64::try_from(c.len()).expect("len fits u64")),
            is_binary: false,
            truncated: false,
        }
    }

    fn many_lines(count: usize, line_len: usize) -> String {
        let line = "a".repeat(line_len);
        (0..count)
            .map(|_| line.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn stage_with(sides: [Option<&str>; 3]) -> ConflictStages {
        ConflictStages {
            path: "f.txt".to_string(),
            kind: ConflictKind::BothModified,
            ancestor: Some(side(sides[0])),
            ours: Some(side(sides[1])),
            theirs: Some(side(sides[2])),
            merged: None,
            regions: Vec::new(),
            truncated: false,
            region_mergeable: true,
        }
    }

    fn serialized_len(stages: &ConflictStages) -> usize {
        serde_json::to_vec(stages)
            .expect("serialize conflict stages")
            .len()
    }

    #[test]
    fn three_sides_each_900kb_stay_under_ipc_limit() {
        // 9000 行 × 100B ≈ 900KB / 侧。
        let each = many_lines(9_000, 100);
        let capped = cap_conflict_payload(stage_with([Some(&each), Some(&each), Some(&each)]));
        assert!(capped.truncated, "三侧各 ~900KB 必须触发截断");
        assert!(
            serialized_len(&capped) <= IPC_JSON_LIMIT,
            "实际序列化必须 ≤ 2MB，got {}",
            serialized_len(&capped)
        );
    }

    #[test]
    fn oversized_side_does_not_starve_the_others() {
        // 一侧 10MB，另两侧小 → 另两侧不得被截断（保底不得饿死）。
        let huge = many_lines(100_000, 100); // ~10MB
        let small_ours = "ours small\n";
        let small_theirs = "theirs small\n";
        let capped = cap_conflict_payload(stage_with([
            Some(&huge),
            Some(small_ours),
            Some(small_theirs),
        ]));
        let ancestor = capped.ancestor.as_ref().expect("ancestor present");
        let ours = capped.ours.as_ref().expect("ours present");
        let theirs = capped.theirs.as_ref().expect("theirs present");
        assert!(ancestor.truncated, "超大一侧必须被截断");
        assert!(!ours.truncated, "小侧不得被超大侧饿死");
        assert!(!theirs.truncated, "小侧不得被超大侧饿死");
        assert_eq!(ours.content.as_deref(), Some("ours small\n"));
        assert_eq!(theirs.content.as_deref(), Some("theirs small\n"));
        assert!(
            serialized_len(&capped) <= IPC_JSON_LIMIT,
            "实际序列化必须 ≤ 2MB，got {}",
            serialized_len(&capped)
        );
    }

    #[test]
    fn small_payload_is_untouched() {
        let mut stages = stage_with([Some("base\n"), Some("ours\n"), Some("theirs\n")]);
        stages.merged = Some("merged body\n".to_string());
        stages.regions = vec![MergeRegion {
            id: 0,
            merged_start: 0,
            merged_end: 3,
            base_lines: vec!["base".to_string()],
            our_lines: vec!["ours".to_string()],
            their_lines: vec!["theirs".to_string()],
            base_start: 0,
            our_start: 0,
            their_start: 0,
        }];
        let capped = cap_conflict_payload(stages);
        assert!(!capped.truncated, "小载荷不得被截断");
        assert_eq!(capped.merged.as_deref(), Some("merged body\n"));
        assert_eq!(capped.regions.len(), 1);
        assert_eq!(
            capped.ancestor.expect("ancestor").content.as_deref(),
            Some("base\n")
        );
    }

    #[test]
    fn control_char_escaping_cannot_break_ipc_limit() {
        // \x01 → \u0001（6× 转义）：近似系数会被击穿，真实序列化必须仍 ≤ 2MB。
        let each = many_lines(50_000, 1).replace('a', "\u{1}");
        let capped = cap_conflict_payload(stage_with([Some(&each), Some(&each), Some(&each)]));
        assert!(capped.truncated);
        assert!(
            serialized_len(&capped) <= IPC_JSON_LIMIT,
            "6× 转义内容必须仍 ≤ 2MB，got {}",
            serialized_len(&capped)
        );
    }

    #[test]
    fn missing_stage_is_not_normalized_to_empty_string() {
        // R3：缺失 stage 保持 None，cap 不得把它变成 Some("")。
        let stages = ConflictStages {
            path: "c.txt".to_string(),
            kind: ConflictKind::ModifyDelete,
            ancestor: Some(side(Some("base\n"))),
            ours: None,
            theirs: Some(side(Some("theirs\n"))),
            merged: None,
            regions: Vec::new(),
            truncated: false,
            region_mergeable: false,
        };
        let capped = cap_conflict_payload(stages);
        assert!(capped.ours.is_none(), "缺失 stage 必须保持 None");
        assert_eq!(
            capped.theirs.expect("theirs").content.as_deref(),
            Some("theirs\n")
        );
    }

    #[test]
    fn merged_is_sacrificed_before_sides() {
        // 三侧吃满预算时 merged 被牺牲（截断），但三侧仍在预算内。
        let each = many_lines(9_000, 100);
        let mut stages = stage_with([Some(&each), Some(&each), Some(&each)]);
        stages.merged = Some(many_lines(9_000, 100));
        let capped = cap_conflict_payload(stages);
        assert!(capped.truncated);
        assert!(
            serialized_len(&capped) <= IPC_JSON_LIMIT,
            "实际序列化必须 ≤ 2MB，got {}",
            serialized_len(&capped)
        );
    }
}
