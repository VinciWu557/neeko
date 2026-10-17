//! **入站**：接收外部 Agent CLI 的上报（源 B）。
//!
//! # 不变式：fail-open
//!
//! 这一侧的任何失败都**不得影响用户终端里的 agent**：
//! - 监听只绑 loopback + 随机端口（`server`），失败只记 warning、不阻断启动；
//! - 每条连接有 inflight 上限与短超时，超限**丢弃**而非排队；
//! - 上报解析失败/未知 source 只记日志并回 204（`report`），**永不**返回非 2xx
//!   让 CLI 侧把我们的故障当成它的故障。
//!
//! 与 [`super::install`] 的 fail-safe 是**两条互斥的失败策略**：那边失败必须拒绝写盘
//!（用户配置神圣），这边失败必须静默放手（不能拖累 agent）。故它们是两个目录。

pub mod attribution;
pub mod endpoint;
pub mod report;
pub mod server;

// 与 `hooks/mod.rs` 同一规则：**不 re-export 没人消费的符号**。
// 实测（2026-10-16）`ingest::attribute` / `ingest::project` / `Attribution` / `HookEnvelope`
// 在 `ingest/` 之外零命中 —— 域外一律写全路径 `ingest::<mod>::<sym>`。
// 一个没人 import 的门面只是把内部实现暴露成公共 API（封装为零），却让「域边界」不可读。
