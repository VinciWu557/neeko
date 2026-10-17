//! 私有配置文件的原子写入（Platform Adapter，红线 10）。
//!
//! 统一接口两组：
//! - `write_private_atomic(path, content)` —— 新建**仅当前用户可读**的文件 +
//!   原子替换（读者永远看不到半截文件）。用于承载凭据的坐标文件。
//! - `write_atomic_preserving_mode(path, content)` —— 原子替换**用户既有文件**，
//!   且**保留原权限位**。用于改写用户的 `settings.json` / `config.toml`
//!   （可能是 0600，也可能是 0644；把 0600 的文件写成 0644 = 静默降权）。
//!
//! 平台差异：
//! - **Unix**：`0600` / 原权限 + 同目录临时文件 `rename`（POSIX 原子）。
//! - **Windows**：目标位置（用户 profile）自带 per-user ACL，无需显式设权限；
//!   `MoveFileEx` 语义由「先删后改名」近似（极小窗口内读者可能 FileNotFound，
//!   hook 侧按 fail-open 静默吞掉——与调用方契约一致）。
//!
//! 业务代码只调本门面，不得在函数体内平铺 `#[cfg]`。

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

// 兜底谓词 `not(unix)` 而非 `not(any(unix, windows))`：本 theme 的 Windows 实现
// （profile 自带 per-user ACL）本身就落在 `default.rs` 里，故它不是「非目标平台的 stub」
// 而是**一个真实平台腿 + 其余平台的同签名回落**。`hook_command` 的 `unsupported.rs`
// 不同 —— 那里 Windows 有独立实现，`unsupported` 只是其余平台的 stub（`None`），
// 故用 `not(any(unix, windows))`。两者谓词不同是有意的，差异在此说明。
#[cfg(not(unix))]
mod default;
#[cfg(not(unix))]
pub use default::*;
