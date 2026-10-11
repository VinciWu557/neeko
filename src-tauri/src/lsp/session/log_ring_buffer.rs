//! Byte-bounded ring buffer of recent stderr lines for View Logs.

use std::collections::VecDeque;

use crate::lsp::types::LspServerLogEntry;

/// Max total size (bytes) of retained stderr logs per session for View Logs.
pub(crate) const LOG_RING_MAX_BYTES: usize = 10 * 1024 * 1024; // 10 MB

/// 单条消息的 UTF-8 字节上限：无换行的超长倾倒（大 JSON / 二进制）不得让**一条**
/// 吃掉整个环预算。截断在**唯一写入口** [`LogRingBuffer::push`] 收口，读路径因此
/// 有确定的可行域 —— 「条目有界」是环的数据不变量，不是读侧或泵侧各自的策略。
pub(crate) const LOG_LINE_MAX_BYTES: usize = 4 * 1024; // 4 KB

/// 截断标记的最坏字节数：`"... [truncated " + usize 十进制(≤20 位) + " bytes]"`。
const LOG_LINE_MARKER_RESERVE: usize = 48;

/// 单条最坏形态的 **JSON** 长度上界（红线 4 的绝对下界）：
/// 内容上限 × 控制字符最长转义 6×（`\x01` → `\u0001`）+ 截断标记预留 + 字段包装
/// （时间戳 / level / 键名，实测 ≈65 字节，取 128 留量）。
///
/// [`LogRingBuffer::snapshot`] 对最新一条**无条件纳入**，故任何预算下的返回载荷都
/// 满足 `≤ max(预算, LOG_ENTRY_JSON_MAX_BYTES)` —— 「空数组」与「无界载荷」同时不可达。
pub(crate) const LOG_ENTRY_JSON_MAX_BYTES: usize =
    LOG_LINE_MAX_BYTES * 6 + LOG_LINE_MARKER_RESERVE + 128;

/// Size of one log entry's heap content (the three `String` fields).
const fn entry_size(e: &LspServerLogEntry) -> usize {
    e.timestamp.len() + e.level.len() + e.message.len()
}

/// 环内条目：证据本体 + **写入时一次算定**的 JSON 字节数。
///
/// 读路径（[`LogRingBuffer::snapshot`]）因此是纯算术：序列化只在写入侧发生一次，
/// 被读取次数摊薄（写入侧同线程已有 `log::warn!` 落盘，本计量同阶且不做近似）。
#[derive(Debug)]
struct StoredEntry {
    entry: LspServerLogEntry,
    /// 该条序列化后的 JSON 字节数（含尾随 `,` 的保守计量）。
    json_bytes: usize,
}

/// Evicts the oldest entries once the total stored size exceeds [`LOG_RING_MAX_BYTES`] (10 MB).
#[derive(Debug)]
pub(crate) struct LogRingBuffer {
    entries: VecDeque<StoredEntry>,
    total_bytes: usize,
}

impl LogRingBuffer {
    pub(crate) const fn new() -> Self {
        Self {
            entries: VecDeque::new(),
            total_bytes: 0,
        }
    }

    /// 追加一条：消息先按 [`LOG_LINE_MAX_BYTES`] 封顶，JSON 字节数在此算定。
    pub(crate) fn push(&mut self, mut entry: LspServerLogEntry) {
        entry.message = clamp_line(entry.message);
        self.total_bytes += entry_size(&entry);
        let json_bytes = entry_json_bytes(&entry);
        self.entries.push_back(StoredEntry { entry, json_bytes });
        while self.total_bytes > LOG_RING_MAX_BYTES {
            if let Some(front) = self.entries.pop_front() {
                self.total_bytes -= entry_size(&front.entry);
            } else {
                break;
            }
        }
    }

    /// 最近条目（newest last）：先受 `limit`（0 = 不限条数）再受 `max_bytes`
    /// （0 = 不限字节，**软预算**）约束。
    ///
    /// **最新一条无条件纳入** —— 「至少给出一点证据」的下界（与 [`Self::tail_text`]
    /// 对首行同规则）；此后从新到旧累加，装不下的更旧条目丢弃。故返回载荷
    /// `≤ max(max_bytes, LOG_ENTRY_JSON_MAX_BYTES)`：极小预算不会退化为空数组，
    /// 超预算上冲也被单条封顶（红线 4 仍有绝对上界）。
    ///
    /// 字节按**真实序列化长度**（`push` 时算定，见 [`StoredEntry`]）：控制字符 JSON
    /// 转义最长 6×，按内容字节近似会被击穿。
    pub(crate) fn snapshot(&self, limit: usize, max_bytes: usize) -> Vec<LspServerLogEntry> {
        let mut taken: Vec<&StoredEntry> = Vec::new();
        let mut used = 0usize;
        for stored in self.entries.iter().rev() {
            if limit != 0 && taken.len() >= limit {
                break;
            }
            let fits = max_bytes == 0 || used.saturating_add(stored.json_bytes) <= max_bytes;
            if !taken.is_empty() && !fits {
                break;
            }
            used = used.saturating_add(stored.json_bytes);
            taken.push(stored);
        }
        taken.into_iter().rev().map(|s| s.entry.clone()).collect()
    }

    /// 最近行的尾部窗口（≤ `max_bytes` 字节，从最新往回累加）：失败消息内联证据的
    /// 唯一读取点。单行超上限时按**字符边界**截尾，绝不撕裂多字节字符。
    pub(crate) fn tail_text(&self, max_bytes: usize) -> String {
        let mut lines: Vec<&str> = Vec::new();
        let mut total = 0usize;
        for stored in self.entries.iter().rev() {
            let len = stored.entry.message.len() + 1; // + 换行符
            if total + len > max_bytes && !lines.is_empty() {
                break;
            }
            lines.push(stored.entry.message.as_str());
            total += len;
            if total >= max_bytes {
                break;
            }
        }
        lines.reverse();
        let mut text = lines.join("\n");
        if text.len() > max_bytes {
            let mut start = text.len() - max_bytes;
            while start < text.len() && !text.is_char_boundary(start) {
                start += 1;
            }
            text = text[start..].to_string();
        }
        text
    }
}

/// 超长消息按**字符边界**截头并附截断标记（被截字节数可见 —— 证据自描述，
/// 「这里丢过东西」不靠外部上下文推断）。
fn clamp_line(message: String) -> String {
    if message.len() <= LOG_LINE_MAX_BYTES {
        return message;
    }
    let mut end = LOG_LINE_MAX_BYTES - LOG_LINE_MARKER_RESERVE;
    while end > 0 && !message.is_char_boundary(end) {
        end -= 1;
    }
    let omitted = message.len() - end;
    format!("{}... [truncated {omitted} bytes]", &message[..end])
}

/// 只计量字节、不分配 / 不落盘的 `io::Write`：让 `serde_json` 直接给出序列化长度
/// （同 `common/git/parsers/diff.rs` 的 `ByteCounter`，那是本口径的第一实现；
/// 出现第三个消费点时按同一口径提升到 `common/`）。
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

/// 一条日志的 JSON 字节数（真实序列化器计量 + 尾随 `,`）。计量失败 fail-closed：
/// 记为超预算值 —— 最新一条仍会返回（下界优先），更旧的不再纳入。
fn entry_json_bytes(entry: &LspServerLogEntry) -> usize {
    let mut counter = ByteCounter::default();
    match serde_json::to_writer(&mut counter, entry) {
        Ok(()) => counter.0 + 1,
        Err(_) => usize::MAX,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(message: &str) -> LspServerLogEntry {
        LspServerLogEntry {
            timestamp: "2026-10-11T00:00:00Z".to_string(),
            level: "info".to_string(),
            message: message.to_string(),
        }
    }

    fn serialized_bytes(entries: &[LspServerLogEntry]) -> usize {
        entries
            .iter()
            .map(|e| serde_json::to_string(e).expect("serialize").len() + 1)
            .sum()
    }

    /// 超长单行按字符边界截头并附标记：不撕裂多字节字符、总长受上限约束、
    /// 被截字节数可见（证据自描述）。
    #[test]
    fn oversized_line_is_clamped_at_char_boundary_with_marker() {
        let mut buffer = LogRingBuffer::new();
        buffer.push(entry(&"宽".repeat(LOG_LINE_MAX_BYTES))); // 3 字节/字符

        let stored = &buffer.entries[0].entry.message;
        assert!(
            stored.len() <= LOG_LINE_MAX_BYTES,
            "单条必须受上限约束: {}",
            stored.len()
        );
        assert!(stored.ends_with(" bytes]"), "必须带截断标记: {stored}");
        let (head, _) = stored.split_once("... [truncated ").expect("标记");
        assert!(head.chars().all(|c| c == '宽'), "不得撕裂多字节字符");
        assert!(!head.is_empty(), "截头必须保留信息前缀");
    }

    /// 写入时算定的字节数必须与**真实序列化长度**逐一相等 ——
    /// 读路径的纯算术不得与 IPC 序列化产生第二本账。
    #[test]
    fn stored_byte_accounting_matches_real_serialization() {
        let mut buffer = LogRingBuffer::new();
        buffer.push(entry("plain ascii line"));
        buffer.push(entry("quote \" backslash \\ control \u{1}\u{7f} 宽 ✨"));

        let all = buffer.snapshot(0, 0);
        let stored: usize = buffer.entries.iter().map(|s| s.json_bytes).sum();
        assert_eq!(
            stored,
            serialized_bytes(&all),
            "逐条账目之和必须等于真实序列化长度"
        );
        for (stored, real) in buffer.entries.iter().zip(all.iter()) {
            assert_eq!(
                stored.json_bytes,
                serde_json::to_string(real).expect("serialize").len() + 1,
                "单条账目必须精确"
            );
        }
    }

    /// 读预算：按字节从新到旧取，装不下的更旧条目被丢弃；`0` = 不限。
    #[test]
    fn snapshot_honors_count_and_byte_budgets() {
        let mut buffer = LogRingBuffer::new();
        for i in 0..10 {
            buffer.push(entry(&format!("line {i} {}", "x".repeat(256))));
        }
        let all = buffer.snapshot(0, 0);
        assert_eq!(all.len(), 10);

        let per_entry = serialized_bytes(&all[..1]);
        let limited = buffer.snapshot(0, per_entry * 3 + 3);
        assert_eq!(limited.len(), 3, "预算只够三条时必须只返回三条");
        assert!(
            serialized_bytes(&limited) <= per_entry * 3 + 3,
            "返回载荷必须落在预算内"
        );
        assert_eq!(
            limited.last().expect("newest").message,
            all.last().expect("newest").message,
            "保留的必须是最近的条目"
        );

        assert_eq!(buffer.snapshot(2, 0).len(), 2, "条数上限独立生效");
    }

    /// 最新一条是**无条件下界**：即使预算远小于单条最坏形态也返回它（不退化空数组），
    /// 且其 JSON 长度受 [`LOG_ENTRY_JSON_MAX_BYTES`] 封顶（红线 4 的绝对上界）。
    #[test]
    fn snapshot_always_includes_newest_within_absolute_bound() {
        let mut buffer = LogRingBuffer::new();
        buffer.push(entry("older line"));
        buffer.push(entry(&"\u{1}".repeat(LOG_LINE_MAX_BYTES)));

        let worst = buffer.entries.back().expect("newest").json_bytes;
        assert!(
            worst > LOG_LINE_MAX_BYTES * 6,
            "转义必须真实放大（>6×），否则本口径失去意义: {worst}"
        );
        assert!(
            worst <= LOG_ENTRY_JSON_MAX_BYTES,
            "单条最坏 JSON 必须受绝对上界约束: {worst} > {LOG_ENTRY_JSON_MAX_BYTES}"
        );

        let tiny = buffer.snapshot(0, 1);
        assert_eq!(tiny.len(), 1, "极小预算必须返回最新一条，不得退化为空");
        assert_eq!(
            tiny[0].message,
            buffer.entries.back().expect("newest").entry.message
        );

        let bounded = buffer.snapshot(0, worst + LOG_LINE_MAX_BYTES);
        assert_eq!(bounded.len(), 2, "预算覆盖最坏单条后应继续纳入更旧条目");
    }
}
