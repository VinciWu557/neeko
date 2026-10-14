//! 私有配置文件的原子写入（Platform Adapter，红线 10）。
//!
//! 统一接口：`write_private_atomic(path, content)` —— 文件内容仅当前用户可读 +
//! 原子替换（读者永远看不到半截文件）。
//!
//! 平台差异：
//! - **Unix**：`0600` 权限 + 同目录临时文件 `rename`（POSIX 原子）。
//! - **Windows**：目标位置（用户 profile）自带 per-user ACL，无需显式设权限；
//!   `MoveFileEx` 语义由「先删后改名」近似（极小窗口内读者可能 FileNotFound，
//!   hook 侧按 fail-open 静默吞掉——与调用方契约一致）。
//!
//! 业务代码只调本门面，不得在函数体内平铺 `#[cfg]`。

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(not(unix))]
mod default;
#[cfg(not(unix))]
pub use default::*;
