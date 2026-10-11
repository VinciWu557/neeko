//! Session lifecycle: the single source of truth for "what state is this session in".

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;

use super::status::LspSessionStatus;

// 相位常量：非终态按"推进顺序"取值，终态值域高于所有非终态（`current < CLOSED`
// 即"仍在可推进区间"，这是 set / 崩溃判定共用的一条判据）。
const STARTING: u8 = 0;
const INITIALIZING: u8 = 1;
const READY: u8 = 2;
const CLOSED: u8 = 3;
const CRASHED: u8 = 4;

/// 会话生命周期的唯一真相（相位 + 终态文案）。
///
/// 第一性原理（既有）：一个会话是否还能用，只能有**一个**事实来源。此前表示有三份且
/// 互相补偿——构造期写入后永不更新的 `Ready` 字段、并行的 `closing: AtomicBool`、
/// 靠轮询 `JoinHandle::is_finished()` 反推——无法区分「优雅关闭」与「进程崩溃」，
/// 于是"关闭后闪错误"只能靠人工保证顺序。收敛后：reader 线程与关闭路径是**写者**，
/// 快照 / 存活判定 / 事件发射是**读者**。
///
/// 终态文案采用 **capture-at-transition**：进入终态的**写者**（reader 线程 / 关闭
/// 路径）用 [`crash_message`] 一次合成并存入；`status()` 与事件只投影**同一份字符串**。
/// 让每个读者各自从句柄重建，会在 stderr 泵的竞态窗口内拼出不同文案（事件与快照
/// 互相矛盾），这正是本字段存在的理由。
#[derive(Debug)]
pub(crate) struct Lifecycle {
    phase: AtomicU8,
    /// 终态文案（仅 Error/崩溃路径写入；`None` = 尚未有写者合成过）。
    message: Mutex<Option<String>>,
}

impl Lifecycle {
    pub(crate) const fn new() -> Self {
        Self {
            phase: AtomicU8::new(STARTING),
            message: Mutex::new(None),
        }
    }

    /// 推进到给定状态对应的相位。终态是吸收态（关闭 / 崩溃后不再复活）。
    ///
    /// `LspSessionStatus::Indexing` 是**前端派生**的展示态（由 work-done 进度 token
    /// 合成），服务端不存在该相位，故归一为 `Ready`（会话确实可用）。
    ///
    /// `Error` 变体携带的文案由**写者**提供（本函数只落账，不重建）—— 唯一构造点
    /// 是 [`crash_message`]。
    pub(crate) fn set(&self, status: &LspSessionStatus) {
        if let LspSessionStatus::Error(message) = status {
            if let Ok(mut stored) = self.message.lock() {
                *stored = Some(message.clone());
            }
        }
        let target = phase_of(status);
        let mut current = self.phase.load(Ordering::SeqCst);
        while current < CLOSED {
            match self
                .phase
                .compare_exchange(current, target, Ordering::SeqCst, Ordering::SeqCst)
            {
                Ok(_) => return,
                Err(actual) => current = actual,
            }
        }
    }

    /// Neeko 主动关闭。返回是否为**首次**进入关闭态——调用方据此保证 `stopped`
    /// 只发一次（幂等由状态机给出，而不是靠调用方记住）。
    pub(crate) fn close(&self) -> bool {
        self.phase.swap(CLOSED, Ordering::SeqCst) != CLOSED
    }

    /// reader 线程退出。返回是否为**首次**判定为崩溃。
    ///
    /// `message` 是**写者一次合成**的终态文案（含证据尾部，见 [`crash_message`]）；
    /// 文案与相位在同一临界区内落账，读者不会读到「已崩溃但文案未落」的中间态。
    ///
    /// 非优雅关闭（子进程提前退出）才算崩溃；已关闭会话静默退出，且绝不会被
    /// 覆盖成崩溃态。已判定过崩溃时返回 `false` —— 重复退出不得重复发 `error`
    /// （否则前端会收到重复的重试提示），也不得覆盖首份文案。
    pub(crate) fn on_reader_exit(&self, message: &str) -> bool {
        let Ok(mut stored) = self.message.lock() else {
            return false;
        };
        if !self.mark_crashed_if_running() {
            return false;
        }
        *stored = Some(message.to_string());
        true
    }

    /// 相位 CAS：非终态 → CRASHED，返回是否本次完成切换。
    fn mark_crashed_if_running(&self) -> bool {
        let mut current = self.phase.load(Ordering::SeqCst);
        loop {
            match current {
                CLOSED | CRASHED => return false,
                _ => match self.phase.compare_exchange(
                    current,
                    CRASHED,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                ) {
                    Ok(_) => return true,
                    Err(actual) => current = actual,
                },
            }
        }
    }

    /// 是否已进入终态（关闭或崩溃）——会话不再可能提供任何能力。
    pub(crate) fn is_terminal(&self) -> bool {
        self.phase.load(Ordering::SeqCst) >= CLOSED
    }

    /// 快照用的状态视图。
    ///
    /// 崩溃态的 message 投影写者落账的文案（capture-at-transition）；尚无写者
    /// 文案时（防御路径）退回 [`crash_message`] 的无证据形态。
    pub(crate) fn status(&self, server_name: &str) -> LspSessionStatus {
        match self.phase.load(Ordering::SeqCst) {
            CLOSED => LspSessionStatus::Stopped,
            CRASHED => LspSessionStatus::Error(self.terminal_message(server_name)),
            INITIALIZING => LspSessionStatus::Initializing,
            READY => LspSessionStatus::Ready,
            _ => LspSessionStatus::Starting,
        }
    }

    fn terminal_message(&self, server_name: &str) -> String {
        self.message
            .lock()
            .ok()
            .and_then(|stored| stored.clone())
            .unwrap_or_else(|| crash_message(server_name, None))
    }
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self::new()
    }
}

const fn phase_of(status: &LspSessionStatus) -> u8 {
    match status {
        LspSessionStatus::Starting => STARTING,
        LspSessionStatus::Initializing => INITIALIZING,
        LspSessionStatus::Indexing | LspSessionStatus::Ready => READY,
        LspSessionStatus::Error(_) => CRASHED,
        LspSessionStatus::Stopped => CLOSED,
    }
}

/// 服务器意外退出的统一文案（**唯一构造函数**）。`tail` 是内联的证据尾部
/// （stderr 最近行，受调用方上限约束）——对齐 `dap/session.rs` 的
/// `"{base} | adapter stderr: {detail}"` 惯例：失败原因必须随错误内联。
#[must_use]
pub(crate) fn crash_message(server_name: &str, tail: Option<&str>) -> String {
    match tail.map(str::trim).filter(|tail| !tail.is_empty()) {
        Some(tail) => format!("{server_name} exited unexpectedly | stderr: {tail}"),
        None => format!("{server_name} exited unexpectedly"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAME: &str = "gopls";

    /// 相位推进：starting → initializing → ready 各阶段如实映射。
    #[test]
    fn phases_advance_from_starting_to_ready() {
        let lifecycle = Lifecycle::new();
        assert_eq!(lifecycle.status(NAME), LspSessionStatus::Starting);
        assert!(!lifecycle.is_terminal());

        lifecycle.set(&LspSessionStatus::Initializing);
        assert_eq!(lifecycle.status(NAME), LspSessionStatus::Initializing);

        lifecycle.set(&LspSessionStatus::Ready);
        assert_eq!(lifecycle.status(NAME), LspSessionStatus::Ready);
        assert!(!lifecycle.is_terminal());
    }

    /// close 幂等：只有首次进入关闭态返回 true（调用方据此保证 stopped 只发一次）。
    #[test]
    fn close_reports_first_entry_only() {
        let lifecycle = Lifecycle::new();
        lifecycle.set(&LspSessionStatus::Ready);

        assert!(lifecycle.close(), "首次关闭必须返回 true");
        assert!(
            !lifecycle.close(),
            "重复关闭不得再返回 true（否则重复发 stopped）"
        );
        assert!(lifecycle.is_terminal());
        assert_eq!(lifecycle.status(NAME), LspSessionStatus::Stopped);
    }

    /// 优雅关闭后 reader 退出必须静默：不得把 Stopped 覆盖成 Error。
    #[test]
    fn reader_exit_after_close_is_silent() {
        let lifecycle = Lifecycle::new();
        lifecycle.set(&LspSessionStatus::Ready);
        lifecycle.close();

        assert!(
            !lifecycle.on_reader_exit("jdtls exited unexpectedly"),
            "已关闭会话的 reader 退出不算崩溃"
        );
        assert_eq!(
            lifecycle.status(NAME),
            LspSessionStatus::Stopped,
            "崩溃判定不得覆盖优雅关闭的终态"
        );
    }

    /// 运行中 reader 退出 = 崩溃，且只报一次（重复退出不得重复发 error）。
    #[test]
    fn reader_exit_while_running_reports_crash_once() {
        let lifecycle = Lifecycle::new();
        lifecycle.set(&LspSessionStatus::Ready);

        assert!(
            lifecycle.on_reader_exit(&crash_message(NAME, None)),
            "非优雅关闭的 reader 退出必须判为崩溃"
        );
        assert!(
            !lifecycle.on_reader_exit(&crash_message(NAME, None)),
            "崩溃判定必须幂等（否则重复发 error + 重复触发前端重试提示）"
        );
        assert_eq!(
            lifecycle.status(NAME),
            LspSessionStatus::Error(crash_message(NAME, None))
        );
        assert!(lifecycle.is_terminal());
        assert!(
            !matches!(lifecycle.status(NAME), LspSessionStatus::Stopped),
            "崩溃不等于 Neeko 主动关闭"
        );
    }

    /// capture-at-transition：终态文案由写者一次合成并落账，读者逐字投影；
    /// 重复退出不得覆盖首份文案。
    #[test]
    fn reader_exit_stores_writer_message_verbatim() {
        let lifecycle = Lifecycle::new();
        lifecycle.set(&LspSessionStatus::Ready);

        let message = crash_message("gopls", Some("boom: unknown binary"));
        assert!(lifecycle.on_reader_exit(&message));
        assert_eq!(
            lifecycle.status(NAME),
            LspSessionStatus::Error(message.clone()),
            "快照必须逐字投影写者落账的文案"
        );

        assert!(
            !lifecycle.on_reader_exit("second message"),
            "重复退出不得改写终态"
        );
        assert_eq!(
            lifecycle.status(NAME),
            LspSessionStatus::Error(message),
            "首份文案不得被后者覆盖"
        );
    }

    /// `Error` 写者文案同样落账并投影（唯一构造点仍是 `crash_message`，本函数只存）。
    #[test]
    fn set_error_stores_writer_message() {
        let lifecycle = Lifecycle::new();
        lifecycle.set(&LspSessionStatus::Error("composed by writer".into()));
        assert_eq!(
            lifecycle.status(NAME),
            LspSessionStatus::Error("composed by writer".into())
        );
        assert!(lifecycle.is_terminal());
    }

    /// 崩溃后用户主动关闭（重试 / 停止）：必须接受关闭并转为 Stopped（前端据此清诊断）。
    #[test]
    fn close_after_crash_enters_closed_state() {
        let lifecycle = Lifecycle::new();
        lifecycle.set(&LspSessionStatus::Ready);
        lifecycle.on_reader_exit(&crash_message(NAME, None));

        assert!(lifecycle.close(), "崩溃后的主动关闭仍是首次进入关闭态");
        assert_eq!(lifecycle.status(NAME), LspSessionStatus::Stopped);
    }

    /// 终态是吸收态：关闭后任何相位推进都不得让会话"复活"。
    #[test]
    fn terminal_state_is_absorbing() {
        let lifecycle = Lifecycle::new();
        lifecycle.close();
        lifecycle.set(&LspSessionStatus::Ready);
        assert_eq!(
            lifecycle.status(NAME),
            LspSessionStatus::Stopped,
            "关闭后推进 ready 不得复活会话"
        );

        let crashed = Lifecycle::new();
        crashed.on_reader_exit(&crash_message(NAME, None));
        crashed.set(&LspSessionStatus::Ready);
        assert_eq!(
            crashed.status(NAME),
            LspSessionStatus::Error(crash_message(NAME, None)),
            "崩溃后推进 ready 不得复活会话"
        );
    }

    /// `Indexing` 是前端派生态（work-done token 合成），服务端不存在该相位 →
    /// 归一为 Ready：会话确实可用，不得因展示态而降级成错误或空闲。
    #[test]
    fn set_indexing_normalizes_to_ready() {
        let lifecycle = Lifecycle::new();
        lifecycle.set(&LspSessionStatus::Indexing);
        assert_eq!(lifecycle.status(NAME), LspSessionStatus::Ready);
        assert!(!lifecycle.is_terminal());
    }

    /// 崩溃文案单点（reader 事件与快照派生共用）；带证据尾部时内联
    /// （对齐 `dap/session.rs` 的 `"{base} | … stderr: {detail}"` 惯例）。
    #[test]
    fn crash_message_names_the_server_and_inlines_evidence() {
        assert_eq!(crash_message("jdtls", None), "jdtls exited unexpectedly");
        assert_eq!(
            crash_message("jdtls", Some("  ")),
            "jdtls exited unexpectedly",
            "空白尾部不得拼出空的证据段"
        );
        assert_eq!(
            crash_message(
                "rust-analyzer",
                Some("error: Unknown binary 'rust-analyzer'")
            ),
            "rust-analyzer exited unexpectedly | stderr: error: Unknown binary 'rust-analyzer'"
        );
    }
}
