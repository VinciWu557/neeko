//! 「关闭标签页」与「关闭窗口」的判别标志（Platform Adapter）。
//!
//! 平台差异：macOS 上关闭标签页的加速键（Cmd+W）会**同时**经菜单事件与
//! `CloseRequested` 到达窗口，需要一条通道把两者关联（菜单置位、关闭路径消费）；
//! Windows / Linux 的 Ctrl+W 不产生 `CloseRequested`（关闭请求只来自原生关闭 /
//! Alt+F4），判别恒为「不是关闭标签页」。
//!
//! 门面契约（红线 10）：业务代码只调用 [`CloseTabFlag`] 的 `new` / `mark` / `take`，
//! 不再出现 `#[cfg(target_os)]`；非目标平台由 `default.rs` 提供同签名 no-op 桩，
//! 遗漏实现时编译期即报错。

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(not(target_os = "macos"))]
mod default;
#[cfg(not(target_os = "macos"))]
pub use default::*;
