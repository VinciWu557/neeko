//! opencode serve adapter — REST + SSE transport, dual-protocol (1.x / 2.x).
//!
//! opencode's native `serve` command exposes a REST API (session create /
//! prompt) plus an SSE `/event` stream. Unlike ACP, both session creation and
//! every prompt accept an explicit model — enabling per-session model
//! switching (upstream ACP does not).
//!
//! # 模块分工
//!
//! | 文件 | 职责 |
//! | --- | --- |
//! | `protocol.rs` | 纯载荷 / URL 构造（模型 slug、建会话体） |
//! | `events_v1.rs` | 1.x SSE 事件 → `StreamEvent`（纯函数） |
//! | `connection.rs` | spawn / 就绪解析 / 共享连接 |
//! | `request.rs` | 建会话 / prompt / 审批 / 中止的 HTTP 写 |
//! | `pump.rs` | SSE 连接、重连、按会话过滤、分派翻译 |
//! | `eventurl.rs` | SSE / 问答复执的 URL 构造 |
//! | `session.rs` | `ServeSession`（`AgentSession` impl） |
//! | `adapter.rs` | `ServeAdapter`（`AgentAdapter` impl） |
//!
//! 这个划分对应红线 9（`mod.rs` 只留声明与 re-export）：搬家前后**零行为变更**，
//! 后续加 2.x 支持时才有地方落代码而不把单文件推到 3000 行。

mod adapter;
mod config_options;
mod connection;
mod events_v1;
mod events_v2;
mod eventurl;
mod protocol;
mod pump;
mod request;
mod session;
mod tool_title;

#[cfg(test)]
mod integ;
#[cfg(test)]
mod tests;

pub use adapter::ServeAdapter;
