//! Keyed diagnostics for LSP start attempts（P1：证据的宿主必须是身份键，不是进程对象）。
//!
//! 一次尝试 = 一个条目（**生代**）：`begin` 铸造新条目并把句柄交给该次尝试的全部参与者
//! （instance / stderr 泵 / reader / manager 的 Err 分支）。**写只走句柄、读才走 key** ——
//! 由此三条不变量由结构保证，不靠调用方守规矩：
//!
//! 1. 生代隔离：旧代的迟到写入落进孤儿 `Arc`，不混进新一次尝试，也不复活被驱逐的键；
//! 2. 驱逐无前缀歧义：`evict_project` 按条目自持的 `project_path` 精确匹配；
//! 3. 锁分层：map 锁只覆盖查 / 插 / 摘，10MB 环路快照在条目锁下进行。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::lsp::session::{iso_timestamp_now, LogRingBuffer};
use crate::lsp::types::{LspAttemptOutcome, LspServerLogEntry};

/// 内联进失败消息的证据尾部上限（红线 4：单次命令 / 事件载荷 ≤ 2MB 的保守预算）。
pub(crate) const TAIL_INLINE_MAX_BYTES: usize = 2 * 1024;

/// 一次「启动尝试」的诊断记录（= 一个生代）。与进程生命周期**无关**：锚定会话身份键。
#[derive(Debug)]
pub(crate) struct AttemptDiagnostics {
    /// 本条目所属的项目路径：驱逐按它**精确匹配**（不做键字符串前缀 —— 路径含 `:` 也不误伤）。
    project_path: String,
    /// 有界 stderr 环（复用 `LogRingBuffer`，10MB 上限）。
    log: Mutex<LogRingBuffer>,
    /// 本次尝试的终态（`None` = 仍在进行中 / 从未落账）。
    outcome: Mutex<Option<LspAttemptOutcome>>,
}

impl AttemptDiagnostics {
    fn new(project_path: &str) -> Self {
        Self {
            project_path: project_path.to_string(),
            log: Mutex::new(LogRingBuffer::new()),
            outcome: Mutex::new(None),
        }
    }

    pub(crate) fn project_path(&self) -> &str {
        &self.project_path
    }

    /// 追加一行**证据**（stderr 泵 / 探测判据 / 记账路径共用）。不写终态。
    pub(crate) fn push_line(&self, level: &str, message: &str) {
        if let Ok(mut log) = self.log.lock() {
            log.push(LspServerLogEntry {
                timestamp: iso_timestamp_now(),
                level: level.to_string(),
                message: message.to_string(),
            });
        }
    }

    /// 写终态失败。**同时把 message 追加进 log**（消息与日志同源，避免两处文案漂移）。
    pub(crate) fn record_failure(&self, message: &str) {
        self.push_line("error", message);
        if let Ok(mut outcome) = self.outcome.lock() {
            *outcome = Some(LspAttemptOutcome {
                status: "error".to_string(),
                message: Some(message.to_string()),
                finished_at: iso_timestamp_now(),
            });
        }
    }

    /// 写终态成功（元数据与日志保留）。
    pub(crate) fn record_success(&self) {
        if let Ok(mut outcome) = self.outcome.lock() {
            *outcome = Some(LspAttemptOutcome {
                status: "ready".to_string(),
                message: None,
                finished_at: iso_timestamp_now(),
            });
        }
    }

    /// 本次尝试的终态快照（`None` = 从未尝试 / 仍在进行中）。
    pub(crate) fn outcome(&self) -> Option<LspAttemptOutcome> {
        self.outcome.lock().ok().and_then(|o| o.clone())
    }

    /// 最近日志（newest last）：`limit == 0` = 不限条数，`max_bytes == 0` = 不限字节。
    /// 字节预算按真实序列化长度计（红线 4 在 IPC 边界的落点由调用方给出）。
    pub(crate) fn snapshot_logs(&self, limit: usize, max_bytes: usize) -> Vec<LspServerLogEntry> {
        self.log
            .lock()
            .map(|log| log.snapshot(limit, max_bytes))
            .unwrap_or_default()
    }

    /// 内联证据的唯一读取点：最近 stderr 行的尾部窗口（上限必填；空 → `None`）。
    pub(crate) fn tail_inline(&self, max_bytes: usize) -> Option<String> {
        let text = self.log.lock().ok()?.tail_text(max_bytes);
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    }
}

/// 按身份键承载诊断证据的注册表。**语义上与 `session_store` 正交**：
/// `session_store` 管「活着的进程」，本 store 管「发生过什么」。
#[derive(Default)]
pub(crate) struct AttemptDiagnosticsStore {
    entries: Mutex<HashMap<String, Arc<AttemptDiagnostics>>>,
}

impl AttemptDiagnosticsStore {
    #[must_use]
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// **新一次尝试**：铸造新条目（新 `Arc`，不是原地清空）并装入 map，返回句柄。
    ///
    /// 这是**唯一**创建键的入口，只允许在 `get_or_create_session` 慢路径调用 ——
    /// fast path / 并发输家切换生代会清空活会话日志（见 design §2.1「单写者与 `begin` 落点」）。
    pub(crate) fn begin(&self, key: &str, project_path: &str) -> Arc<AttemptDiagnostics> {
        let entry = Arc::new(AttemptDiagnostics::new(project_path));
        if let Ok(mut map) = self.entries.lock() {
            map.insert(key.to_string(), Arc::clone(&entry));
        }
        entry
    }

    /// 读路径唯一入口：取句柄快照后**松开 map 锁**再执行 `f`（大对象快照不占 map 锁）。
    /// 键不存在 → `None`，不创建。
    pub(crate) fn with<R>(&self, key: &str, f: impl FnOnce(&AttemptDiagnostics) -> R) -> Option<R> {
        let entry = {
            let map = self.entries.lock().ok()?;
            Arc::clone(map.get(key)?)
        };
        Some(f(&entry))
    }

    /// 确定性驱逐：按条目自持的 `project_path` **精确相等**匹配（不做键字符串前缀）。
    pub(crate) fn evict_project(&self, project_path: &str) {
        if let Ok(mut map) = self.entries.lock() {
            map.retain(|_, entry| entry.project_path() != project_path);
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.lock().map(|m| m.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "/tmp/proj:go";
    const PROJECT: &str = "/tmp/proj";

    /// AC7 重置语义：新一次尝试（新条目）不得混入上一次的输出与终态。
    #[test]
    fn begin_resets_previous_attempt_evidence() {
        let store = AttemptDiagnosticsStore::new();
        let first = store.begin(KEY, PROJECT);
        first.record_failure("attempt 1 boom");
        assert!(first.outcome().is_some());

        let second = store.begin(KEY, PROJECT);

        assert!(
            store
                .with(KEY, |d| d.snapshot_logs(0, 0))
                .unwrap()
                .is_empty(),
            "新一次尝试不得混入上一次的日志条目（AC7）"
        );
        assert!(
            second.outcome().is_none(),
            "新一次尝试的终态必须为空（AC7）"
        );
    }

    /// 生代隔离：旧代句柄在 `begin` 之后的迟到写入，不得出现在新条目里。
    ///
    /// 这是重启 / 驱逐竞态的结构保障：旧会话的 stderr 泵与 reader 可能晚于
    /// `begin` 才写入，按键写表会让它们污染新一次尝试。
    #[test]
    fn stale_handle_writes_stay_in_their_generation() {
        let store = AttemptDiagnosticsStore::new();
        let stale = store.begin(KEY, PROJECT);
        store.begin(KEY, PROJECT);

        stale.push_line("warn", "old generation line");
        stale.record_failure("old generation failure");

        let logs = store.with(KEY, |d| d.snapshot_logs(0, 0)).unwrap();
        assert!(
            logs.is_empty(),
            "旧代句柄的迟到写入不得进入新条目: {logs:?}"
        );
        assert!(
            store.with(KEY, |d| d.outcome()).unwrap().is_none(),
            "旧代句柄不得写新条目的终态"
        );
    }

    /// 记账：`record_failure` 同时写终态与日志（消息与日志同源，供 AC1a 断言）。
    #[test]
    fn record_failure_writes_terminal_outcome_and_log() {
        let store = AttemptDiagnosticsStore::new();
        let diag = store.begin(KEY, PROJECT);
        diag.record_failure("LSP error: Failed to spawn gopls");

        let outcome = store
            .with(KEY, |d| d.outcome())
            .flatten()
            .expect("record_failure 必须写终态");
        assert_eq!(outcome.status, "error");
        assert_eq!(
            outcome.message.as_deref(),
            Some("LSP error: Failed to spawn gopls")
        );
        let logs = store.with(KEY, |d| d.snapshot_logs(0, 0)).unwrap();
        assert_eq!(logs.len(), 1, "失败消息必须同源进日志: {logs:?}");
        assert!(logs[0].message.contains("Failed to spawn gopls"));

        diag.record_success();
        assert_eq!(
            store.with(KEY, |d| d.outcome()).flatten().unwrap().status,
            "ready"
        );
    }

    /// AC6：项目级驱逐清掉该项目的全部键，不影响其他项目。
    #[test]
    fn evict_project_removes_all_keys_for_project() {
        let store = AttemptDiagnosticsStore::new();
        store.begin("/tmp/proj:go", PROJECT);
        store.begin("/tmp/proj:rust", PROJECT);
        store.begin("/tmp/other:go", "/tmp/other");
        assert_eq!(store.len(), 3);

        store.evict_project(PROJECT);

        assert_eq!(store.len(), 1, "只应保留其他项目的键");
        assert!(store.with("/tmp/other:go", |_| ()).is_some());
    }

    /// AC8：驱逐后旧句柄的迟到写入不得复活键（写不经 store，孤儿 `Arc` 不可见）。
    #[test]
    fn late_write_after_evict_does_not_resurrect_key() {
        let store = AttemptDiagnosticsStore::new();
        let handle = store.begin(KEY, PROJECT);
        store.evict_project(PROJECT);

        handle.record_failure("late failure after evict");

        assert!(store.with(KEY, |_| ()).is_none(), "被驱逐的键不得复活");
        assert_eq!(store.len(), 0);
    }

    /// 驱逐按项目身份**精确**匹配：键是 `{project}:{language}` 拼接，项目路径本身
    /// 含 `:` 时（POSIX 合法）不得被前缀匹配误伤。
    #[test]
    fn evict_project_matches_project_identity_exactly() {
        let store = AttemptDiagnosticsStore::new();
        store.begin("/tmp/a:go", "/tmp/a");
        store.begin("/tmp/a:rust:go", "/tmp/a:rust");

        store.evict_project("/tmp/a");

        assert_eq!(store.len(), 1, "前缀相同的另一项目不得被误驱逐");
        assert!(
            store.with("/tmp/a:rust:go", |_| ()).is_some(),
            "只应删掉 project_path 精确相等的条目"
        );
    }

    /// AC8：单键占用受既有 `LOG_RING_MAX_BYTES` 约束；内联证据受独立上限约束
    /// （含多字节字符边界）。
    #[test]
    fn diagnostics_stay_bounded_by_ring_cap_and_inline_limit() {
        use crate::lsp::session::LOG_RING_MAX_BYTES;

        let store = AttemptDiagnosticsStore::new();
        let diag = store.begin(KEY, PROJECT);

        let line = "x".repeat(1024);
        // 写入量刻意超过环上限（10MB）：旧条目必须被驱逐。
        for _ in 0..(LOG_RING_MAX_BYTES / 1024 + 64) {
            diag.push_line("info", &line);
        }
        let total: usize = diag
            .snapshot_logs(0, 0)
            .iter()
            .map(|e| e.message.len())
            .sum();
        assert!(
            total <= LOG_RING_MAX_BYTES,
            "单键日志必须被环上限约束（{total} > {LOG_RING_MAX_BYTES}）"
        );

        // 内联上限：多字节字符不得被撕裂，且长度不超过上限。
        let mb = store.begin("/tmp/proj:mb", PROJECT);
        mb.push_line("error", &"宽".repeat(512)); // 3 字节/字符
        let tail = mb.tail_inline(64).expect("non-empty tail");
        assert!(tail.len() <= 64, "内联 tail 必须受上限约束: {}", tail.len());
        assert!(tail.chars().all(|c| c == '宽'), "不得撕裂多字节字符");
    }
}
