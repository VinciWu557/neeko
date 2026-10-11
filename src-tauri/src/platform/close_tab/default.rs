//! 非 macOS 默认实现（Windows / Linux 无「关闭标签页 + `CloseRequested`」双通道）。

/// 「关闭标签页」标志的降级实现：无内部状态。
///
/// Windows / Linux 上关闭标签页的加速键不产生 `CloseRequested`，窗口关闭请求一律
/// 来自原生关闭 —— 本类型恒回答「不是关闭标签页」，[`Self::mark`] 为 no-op。
#[derive(Debug, Default)]
pub struct CloseTabFlag;

impl CloseTabFlag {
    /// 零尺寸实例（与 macOS 实现同签名，便于门面无条件调用）。
    #[must_use]
    pub const fn new() -> Self {
        Self
    }

    /// no-op：非 macOS 无人消费该标志。
    pub const fn mark(&self) {}

    /// 恒为 `false`：本次关闭请求不是「关闭标签页」。
    #[must_use]
    pub const fn take(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_reports_close_tab() {
        let flag = CloseTabFlag::new();
        assert!(!flag.take(), "非 macOS 的关闭请求一律是原生关闭");

        flag.mark();
        assert!(!flag.take(), "置位是 no-op：非 macOS 没有可观测的双通道");
    }
}
