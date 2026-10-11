//! macOS 实现：菜单事件与 `CloseRequested` 双通道下的「关闭标签页」判别。

use std::sync::atomic::{AtomicBool, Ordering};

/// Cmd+W「关闭标签页」标志。
///
/// 时序契约：菜单处理器在转发 `close-tab` 事件前 [`Self::mark`]；窗口关闭路径
/// [`Self::take`] 消费并清位 —— `true` 表示本次 `CloseRequested` 由关闭标签页引起，
/// 应**静默阻止**（标签页已由前端关闭）；`false` 表示原生关闭，应弹确认退出。
/// 清位是必须的：否则下一次原生关闭会被上一次 Cmd+W 误判。
#[derive(Debug, Default)]
pub struct CloseTabFlag {
    set: AtomicBool,
}

impl CloseTabFlag {
    /// 未置位的初始状态（应用启动各构造一次，菜单与窗口两条路径共享）。
    #[must_use]
    pub const fn new() -> Self {
        Self {
            set: AtomicBool::new(false),
        }
    }

    /// 菜单处理器置位（关闭标签页请求已发出）。
    pub fn mark(&self) {
        self.set.store(true, Ordering::SeqCst);
    }

    /// 消费并清位：本次关闭请求是否来自「关闭标签页」。
    #[must_use]
    pub fn take(&self) -> bool {
        self.set.swap(false, Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_close_tab_exactly_once() {
        let flag = CloseTabFlag::new();
        assert!(!flag.take(), "未置位时必须是原生关闭");

        flag.mark();
        assert!(flag.take(), "置位后的第一次消费必须报告关闭标签页");
        assert!(
            !flag.take(),
            "消费即清位 —— 下一次原生关闭不得被上次 Cmd+W 污染"
        );
    }
}
