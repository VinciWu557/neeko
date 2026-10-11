#![allow(unused_imports, missing_docs)]
use crate::common::git::types::{DiffHunk, DiffLine, DiffResult};

/// 全量 diff 的上下文行数（git2 `context_lines` 使用，u32 与 git2 API 对齐）。
pub const DIFF_FULL_CONTEXT_LINES: u32 = 100_000;
/// 全量 diff 允许的单文件字节上限：超过该值后上下文被限制，
/// 防止 `-U100000` 对超大文件产生超过 IPC 2MB 红线的 JSON 输出。
pub const DIFF_FULL_MAX_FILE_BYTES: u64 = 400_000;
/// 超大文件全量模式回退的上下文行数（仍远大于折叠模式的 3 行）。
pub const DIFF_FULL_FALLBACK_CONTEXT_LINES: u32 = 500;

/// 编译期契约：回退上下文必须仍远大于折叠模式的 3 行 —— 原来这条判据写在单测里
/// （对常量做运行期断言），常量改了却没人跑测试时挡不住；提到编译期后改错即编译失败。
const _: () = assert!(DIFF_FULL_FALLBACK_CONTEXT_LINES > 3);

/// 根据单文件字节数决定全量上下文行数：小文件完整上下文，超大文件受限上下文。
#[must_use]
pub const fn full_diff_context_lines(file_bytes: u64) -> u32 {
    if file_bytes <= DIFF_FULL_MAX_FILE_BYTES {
        DIFF_FULL_CONTEXT_LINES
    } else {
        DIFF_FULL_FALLBACK_CONTEXT_LINES
    }
}

/// 根据单文件字节数生成全量 diff 的 `-U` 参数（shell 路径使用）。
#[must_use]
pub fn full_diff_context_arg(file_bytes: u64) -> String {
    format!("-U{}", full_diff_context_lines(file_bytes))
}

/// 单次 `get_file_diff` IPC 的 **JSON 字节预算**（红线 4：序列化结果 ≤ 2MB）。
///
/// 预算按**目标度量本身**计算：每行用真实序列化器（计数 sink，不分配）量出 JSON 字节数，
/// 不引入「转义 ≈ 1×」这类近似系数 —— 控制字符 JSON 转义最长 6×（`\x01` → `\u0001`），
/// 任何近似系数都会被击穿。1.5MB 预算给 hunk 结构开销与命令封装留 0.5MB 余量。
pub const DIFF_PAYLOAD_MAX_BYTES: usize = 1_500_000;

/// 单个 hunk 的 JSON 结构开销近似（`old_start`/`old_lines`/`new_start`/`new_lines`/`lines` 包装）。
const DIFF_HUNK_JSON_OVERHEAD: usize = 96;

/// `DiffResult` 顶层包装开销近似（`{"hunks":[…],"truncated":…}`）。
const DIFF_RESULT_JSON_OVERHEAD: usize = 32;

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

/// 一条 `DiffLine` 的 JSON 字节数（含尾随 `,` 分隔符），按真实序列化器计量。
fn diff_line_json_bytes(line: &DiffLine) -> usize {
    let mut counter = ByteCounter::default();
    match serde_json::to_writer(&mut counter, line) {
        Ok(()) => counter.0 + 1,
        // 计量失败必须 fail-closed：返回超预算值强制截断，绝不把无法计量的行当 0 字节放行。
        Err(_) => DIFF_PAYLOAD_MAX_BYTES + 1,
    }
}

/// 把 `DiffResult` 截断到 [`DIFF_PAYLOAD_MAX_BYTES`] 内（红线 4）：丢弃尾部行并置 `truncated`。
///
/// `full_diff_context_lines` 护栏只约束 **context** 行；`Added`/`Removed` 不受其约束，
/// 超大改动（尤其未跟踪新文件）仍可把 JSON 推过 2MB。本函数是载荷封顶的**唯一实现**，
/// 在派发缝 `operations::get_file_diff` 统一应用，新增 transport 自动受约束。
/// 计账覆盖行内容（真实转义后字节）+ hunk / 顶层结构开销。
#[must_use]
pub fn cap_diff_payload(mut result: DiffResult) -> DiffResult {
    let mut used = DIFF_RESULT_JSON_OVERHEAD;
    let mut capped = false;
    let mut cut_at = result.hunks.len();
    for (hunk_idx, hunk) in result.hunks.iter_mut().enumerate() {
        let mut running = used.saturating_add(DIFF_HUNK_JSON_OVERHEAD);
        let mut keep = 0usize;
        let mut hunk_capped = false;
        for (line_idx, line) in hunk.lines.iter().enumerate() {
            let bytes = diff_line_json_bytes(line);
            if running.saturating_add(bytes) > DIFF_PAYLOAD_MAX_BYTES {
                hunk_capped = true;
                break;
            }
            running += bytes;
            keep = line_idx + 1;
        }
        used = running;
        if hunk_capped {
            capped = true;
            hunk.lines.truncate(keep);
            cut_at = hunk_idx + 1;
            break;
        }
    }
    if capped {
        // 截断点之后的 hunk 一律丢弃；被截断的 hunk 自身可能为空。
        result.hunks.truncate(cut_at);
        result.hunks.retain(|h| !h.lines.is_empty());
        result.truncated = true;
    }
    result
}

/// Parse git diff --unified=3 text output into DiffResult
#[must_use]
pub fn parse_unified_diff(output: &str) -> DiffResult {
    let mut hunks: Vec<DiffHunk> = Vec::new();

    for line in output.lines() {
        if line.starts_with("@@") {
            if let Some((hunk_header, _)) = parse_hunk_header(line) {
                hunks.push(hunk_header);
            }
        } else if let Some(last) = hunks.last_mut() {
            if line.starts_with('+') && !line.starts_with("+++") {
                last.lines.push(DiffLine::Added(line[1..].to_string()));
            } else if line.starts_with('-') && !line.starts_with("---") {
                last.lines.push(DiffLine::Removed(line[1..].to_string()));
            } else if let Some(stripped) = line.strip_prefix(' ') {
                last.lines.push(DiffLine::Context(stripped.to_string()));
            }
        }
    }

    DiffResult {
        hunks,
        truncated: false,
    }
}

fn parse_hunk_header(line: &str) -> Option<(DiffHunk, &str)> {
    let rest = line.strip_prefix("@@ ")?;
    let rest = rest.strip_prefix('-')?;

    let (old_part, rest) = rest.split_once(' ')?;
    let (old_start, old_lines) = if let Some((s, l)) = old_part.split_once(',') {
        (s.parse::<u32>().ok()?, l.parse::<u32>().ok()?)
    } else {
        (old_part.parse::<u32>().ok()?, 1)
    };

    let rest = rest.strip_prefix('+')?;

    let pos = rest.find(" @@")?;
    let (new_part, _rest) = (&rest[..pos], &rest[pos..]);

    let (new_start, new_lines) = if let Some((s, l)) = new_part.split_once(',') {
        (s.parse::<u32>().ok()?, l.parse::<u32>().ok()?)
    } else {
        (new_part.parse::<u32>().ok()?, 1)
    };

    Some((
        DiffHunk {
            old_start,
            old_lines,
            new_start,
            new_lines,
            lines: Vec::new(),
        },
        _rest,
    ))
}

fn flush_context_buffer(
    collapsed_lines: &mut Vec<DiffLine>,
    buffer: &mut Vec<DiffLine>,
    threshold: usize,
    keep_edges: usize,
) {
    let count = buffer.len();
    let min_keep = keep_edges * 2;
    if count > threshold && count > min_keep {
        let middle = count - min_keep;
        collapsed_lines.extend(buffer.drain(..keep_edges));
        collapsed_lines.push(DiffLine::Collapsed(format!("{} unmodified lines", middle)));
        buffer.drain(..middle);
        collapsed_lines.append(buffer);
    } else {
        collapsed_lines.append(buffer);
    }
}

/// Collapse consecutive context lines, keeping <keep_edges> lines before/after
pub fn collapse_diff_context(hunks: &mut [DiffHunk], threshold: usize) {
    for hunk in hunks.iter_mut() {
        let mut collapsed_lines: Vec<DiffLine> = Vec::new();
        let mut context_buffer: Vec<DiffLine> = Vec::new();
        for line in hunk.lines.drain(..) {
            match &line {
                DiffLine::Context(_) => context_buffer.push(line),
                _ => {
                    flush_context_buffer(&mut collapsed_lines, &mut context_buffer, threshold, 3);
                    collapsed_lines.push(line);
                }
            }
        }
        flush_context_buffer(&mut collapsed_lines, &mut context_buffer, threshold, 3);
        hunk.lines = collapsed_lines;
    }
}

#[cfg(test)]
mod unified_diff_tests {
    use super::*;

    #[test]
    fn should_parse_empty_diff() {
        let result = parse_unified_diff("");
        assert!(result.hunks.is_empty());
    }

    #[test]
    fn should_parse_single_hunk() {
        let diff = r#"@@ -1,3 +1,4 @@
 line1
+added line
 line2
 line3"#;
        let result = parse_unified_diff(diff);
        assert_eq!(result.hunks.len(), 1);
        let hunk = &result.hunks[0];
        assert_eq!(hunk.old_start, 1);
        assert_eq!(hunk.old_lines, 3);
        assert_eq!(hunk.new_start, 1);
        assert_eq!(hunk.new_lines, 4);
        assert_eq!(hunk.lines.len(), 4);
    }

    #[test]
    fn should_parse_added_lines() {
        let diff = r#"@@ -1,1 +1,2 @@
 existing
+new line"#;
        let result = parse_unified_diff(diff);
        let hunk = &result.hunks[0];
        assert!(matches!(hunk.lines[0], DiffLine::Context(_)));
        assert!(matches!(hunk.lines[1], DiffLine::Added(_)));
    }

    #[test]
    fn should_parse_removed_lines() {
        let diff = r#"@@ -1,2 +1,1 @@
-removed line
-removed line2"#;
        let result = parse_unified_diff(diff);
        let hunk = &result.hunks[0];
        assert_eq!(hunk.lines.len(), 2);
        assert!(matches!(hunk.lines[0], DiffLine::Removed(_)));
        assert!(matches!(hunk.lines[1], DiffLine::Removed(_)));
    }

    #[test]
    fn should_parse_multiple_hunks() {
        let diff = r#"@@ -1,3 +1,3 @@
 context1
-old1
+new1
 context2
@@ -10,2 +10,3 @@
 context10
+added
 context11"#;
        let result = parse_unified_diff(diff);
        assert_eq!(result.hunks.len(), 2);
        assert_eq!(result.hunks[0].old_start, 1);
        assert_eq!(result.hunks[1].old_start, 10);
    }

    #[test]
    fn should_skip_diff_headers() {
        let diff = r#"--- a/file.rs
+++ b/file.rs
@@ -1,1 +1,2 @@
 line1
+added"#;
        let result = parse_unified_diff(diff);
        let hunk = &result.hunks[0];
        assert_eq!(hunk.lines.len(), 2);
        assert!(matches!(hunk.lines[0], DiffLine::Context(_)));
        assert!(matches!(hunk.lines[1], DiffLine::Added(_)));
    }

    #[test]
    fn should_parse_hunk_without_line_counts() {
        let diff = "@@ -1 +1 @@\n-old\n+new";
        let result = parse_unified_diff(diff);
        let hunk = &result.hunks[0];
        assert_eq!(hunk.old_start, 1);
        assert_eq!(hunk.old_lines, 1);
        assert_eq!(hunk.new_start, 1);
        assert_eq!(hunk.new_lines, 1);
    }

    #[test]
    fn should_strip_prefix_from_lines() {
        let diff = r#"@@ -1,3 +1,3 @@
 unchanged
-removed
+added"#;
        let result = parse_unified_diff(diff);
        let hunk = &result.hunks[0];

        match &hunk.lines[0] {
            DiffLine::Context(s) => assert_eq!(s, "unchanged"),
            _ => panic!("Expected Context"),
        }
        match &hunk.lines[1] {
            DiffLine::Removed(s) => assert_eq!(s, "removed"),
            _ => panic!("Expected Removed"),
        }
        match &hunk.lines[2] {
            DiffLine::Added(s) => assert_eq!(s, "added"),
            _ => panic!("Expected Added"),
        }
    }
}

#[cfg(test)]
mod diff_context_guard_tests {
    use super::*;

    #[test]
    fn small_file_gets_full_context() {
        assert_eq!(full_diff_context_lines(0), DIFF_FULL_CONTEXT_LINES);
        assert_eq!(
            full_diff_context_lines(DIFF_FULL_MAX_FILE_BYTES),
            DIFF_FULL_CONTEXT_LINES
        );
        assert_eq!(full_diff_context_arg(100_000), "-U100000");
    }

    #[test]
    fn oversized_file_gets_fallback_context() {
        assert_eq!(
            full_diff_context_lines(DIFF_FULL_MAX_FILE_BYTES + 1),
            DIFF_FULL_FALLBACK_CONTEXT_LINES
        );
        assert_eq!(
            full_diff_context_arg(DIFF_FULL_MAX_FILE_BYTES + 1),
            format!("-U{DIFF_FULL_FALLBACK_CONTEXT_LINES}")
        );
        // 「回退上下文 > 3 行」已提升为编译期契约（见文件头 `const _: ()`）。
    }
}

#[cfg(test)]
mod diff_payload_cap_tests {
    use super::*;
    use crate::common::git::types::DiffHunk;

    /// 红线 4：单次 Command 返回 JSON ≤ 2MB。
    const IPC_JSON_LIMIT: usize = 2_000_000;

    fn added_hunk_of(count: usize, content: &str) -> DiffHunk {
        DiffHunk {
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: u32::try_from(count).expect("hunk line count fits u32"),
            lines: (0..count)
                .map(|_| DiffLine::Added(content.to_string()))
                .collect(),
        }
    }

    fn added_hunk(count: usize, line_len: usize) -> DiffHunk {
        added_hunk_of(count, &"x".repeat(line_len))
    }

    fn serialized_len(result: &DiffResult) -> usize {
        serde_json::to_vec(result)
            .expect("serialize diff result")
            .len()
    }

    /// 计量必须与真实序列化一致（防序列化器行为漂移导致护栏失真）。
    #[test]
    fn measured_json_bytes_match_serializer() {
        let line = DiffLine::Added("a\"b\\c\u{1}中文".to_string());
        assert_eq!(
            diff_line_json_bytes(&line),
            serde_json::to_string(&line).expect("serialize").len() + 1
        );
    }

    #[test]
    fn small_payload_is_untouched() {
        let capped = cap_diff_payload(DiffResult {
            hunks: vec![added_hunk(10, 10)],
            truncated: false,
        });
        assert!(!capped.truncated);
        assert_eq!(capped.hunks[0].lines.len(), 10);
    }

    #[test]
    fn oversized_payload_is_capped_and_flagged() {
        // 20_000 行 × 100B ≈ 2MB 内容 > 1.5MB 预算。
        let capped = cap_diff_payload(DiffResult {
            hunks: vec![added_hunk(20_000, 100)],
            truncated: false,
        });
        assert!(capped.truncated, "超预算 payload 必须标记 truncated");
        assert!(!capped.hunks.is_empty(), "应保留预算内的前缀行");
        assert!(
            serialized_len(&capped) <= IPC_JSON_LIMIT,
            "实际序列化必须 ≤ 2MB，got {}",
            serialized_len(&capped)
        );
    }

    /// 回归（关键）：控制字符 JSON 转义 6×（`\x01` → `\u0001`），
    /// 近似预算会被击穿，实测序列化必须仍 ≤ 2MB。
    #[test]
    fn control_char_escaping_cannot_break_ipc_limit() {
        let capped = cap_diff_payload(DiffResult {
            hunks: vec![added_hunk_of(5_000, &"\u{1}".repeat(100))],
            truncated: false,
        });
        assert!(capped.truncated, "6× 转义内容必须触发截断");
        assert!(
            serialized_len(&capped) <= IPC_JSON_LIMIT,
            "序列化结果必须 ≤ 2MB 红线，got {}",
            serialized_len(&capped)
        );
    }

    #[test]
    fn drops_tail_hunks_beyond_budget() {
        let capped = cap_diff_payload(DiffResult {
            hunks: vec![added_hunk(20_000, 100), added_hunk(5, 100)],
            truncated: false,
        });
        assert!(capped.truncated);
        assert!(
            capped.hunks.iter().all(|h| !h.lines.is_empty()),
            "不得留空 hunk"
        );
        assert_eq!(capped.hunks.len(), 1, "截断点之后的 hunk 必须丢弃");
    }
}
