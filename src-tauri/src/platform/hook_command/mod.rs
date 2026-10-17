//! hook shim 启动命令的平台渲染（Platform Adapter，红线 2 / 10）。
//!
//! **为什么需要本模块**：写进 CLI 配置的 `command` 字段由 **CLI 自己的 shell** 执行
//! （POSIX 上通常是 `sh -c`，Windows 上是 `cmd /c`），因此路径分隔符与引号规则是平台差异 ——
//! 属于「换个平台就要重写一遍」的执行细节，按红线 10 必须落在 `platform/`，
//! 不得在 `writers.rs` / `merger.rs` 里平铺 `#[cfg]`。
//!
//! 契约（`render_report_command`）：
//! - 入参 `shim` 是 shim 文件的绝对路径（稳定坐标，配置里写死它）；
//! - 出参是可直接写进 `command` 字段的字符串；
//! - **返回 `Option`**：解析不到 `node` 可执行文件时返回 `None` ——
//!   调用方据此回执 `Skipped` 而不是写入一个必定失败的 hook（父任务 design U2）。
//!
//! 另一形态 `report_argv`（**argv 数组**，不经 shell）供 Codex 的 `notify` 用 ——
//! 它与 `render_report_command` 共用 node 解析与 token 校验，只差「怎么交给 CLI」：
//! shell 字符串 vs argv 数组。**不重复实现**（见下方两函数的文档）。
//!
//! `source` / `event_key` 会被拼进命令行，故本模块对它们做 **token 白名单校验**
//! （只允许 `[A-Za-z0-9_-]`）—— 它们目前全部来自 `targets.rs` 的静态数据，
//! 但「数据表将来加一行」不该成为注入面（纵深防御，成本一行判断）。

mod rules;
pub use rules::is_safe_token;
pub use rules::test_node_override;
#[cfg(test)]
pub use rules::{with_fake_node, without_node, FakeNodeGuard};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

/// 非 Unix / 非 Windows 平台（如 wasm32 或其它嵌入式目标）的兜底。
///
/// **必须有**：`mod.rs` 只声明 `mod` 与 `pub use`（红线 9），而业务代码无条件调用
/// `render_report_command` / `report_argv` / `resolve_node` —— 缺了这层，非目标平台会
/// 「找不到函数」而**编译失败**。与 `platform/private_file`、`platform/path_identity`
/// 的 default 兜底同构（红线 10：非目标平台提供同签名 stub）。
///
/// 语义：没有 shell 约定可依据 → 一律「无法生成命令」（`None`），调用方据此回执 `Skipped`
/// **而不是**写入一个必定失败的 hook（父任务 design U2 的既有契约）。
#[cfg(not(any(unix, windows)))]
mod unsupported;
#[cfg(not(any(unix, windows)))]
pub use unsupported::*;
