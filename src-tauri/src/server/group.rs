//! 路由组契约（设计 §3.1 / §3.5）。
//!
//! # 为什么是值对象而不是 trait
//!
//! [`RouteGroup`] 的全部成员都是数据，没有任何行为需要多态；引擎只做「遍历 + mount + 套层」。
//! 改成 `trait RouteGroup` 会引入 `dyn` 与对象安全税，换不来任何扩展性 —— 新增组仍然是
//! 「加一个文件 + 一行注册」，两者的扩展成本相同，而 trait 版本多一份间接。
//!
//! 策略是枚举而非 trait 同理：策略集合已知且固定（fail-open / fail-closed 覆盖了全部物理
//! 约束形态），`Enum + match` 让新变体强制被处理（开闭原则的编译期形态）。

use axum::http::StatusCode;
use axum::Router;

/// 失败策略：由该路由组调用方的物理约束决定，编译期常量（`Copy`，零运行时分支）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailurePolicy {
    /// 调用方不能被错误信号干扰（hooks：CLI 子进程，800ms 预算，B1）。
    ///
    /// 框架级异常（panic / 超时 / body 超限）一律归一化为 204 —— 调用方看到「无信息量的成功」。
    FailOpen,
    /// 调用方必须收到真实错误信号（未来的交互式客户端，B3）。
    ///
    /// 框架级异常统一归一为 500：不伪装成功，但也不暴露内部状态码细节
    /// （交互式客户端需要状态保真时，再新增一个变体 —— 引擎零改动）。
    FailClosed,
}

impl FailurePolicy {
    /// 兜底状态码 —— 策略的**唯一**消费点（design §2.2）。
    ///
    /// 删掉它，panic/超时/body 超限三条路径全部退化为 4xx/5xx；保留它，B1 才成立。
    /// 这就是「真承重」的判据。
    #[must_use]
    pub const fn fallback_status(self) -> StatusCode {
        match self {
            Self::FailOpen => StatusCode::NO_CONTENT,
            Self::FailClosed => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

/// 一个路由组 = 一组路由 + 该组自己的失败策略。
pub struct RouteGroup {
    /// 稳定的组名（日志/测试用，不参与路由）。
    pub name: &'static str,
    /// 该组的失败策略（design §2.2）。
    pub policy: FailurePolicy,
    /// 已配好自身 State 的路由表（`Router<()>`）。
    pub router: Router,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fail_open_maps_to_no_content() {
        assert_eq!(
            FailurePolicy::FailOpen.fallback_status(),
            StatusCode::NO_CONTENT
        );
    }

    #[test]
    fn fail_closed_maps_to_server_error() {
        assert_eq!(
            FailurePolicy::FailClosed.fallback_status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
