//! 外部 Agent CLI hook 接入（源 B，design.md §2.5，Phase B）。
//!
//! 依赖方向与源 A 一致：本模块属 agent 业务域，向应用级 `crate::notification` 门面投喂信号；
//! 通知核心域对 hook 的存在零感知。
//!
//! # 为什么按「方向」分两个子域
//!
//! 本域有两个方向相反、**失败策略互斥**的半边：
//!
//! | 子域 | 做什么 | 失败时 |
//! | --- | --- | --- |
//! | [`ingest`] | 接收 CLI 上报（HTTP + 坐标系 + 投影） | **fail-open**：静默放手，绝不拖累 agent |
//! | [`install`] | 把 shim 投放进用户配置面 | **fail-safe**：拒绝执行，绝不破坏用户数据 |
//!
//! 这两条策略无法共存于一个模块（一个函数不能既「失败就放手」又「失败就拒绝」），
//! 所以它们必须是两个目录 —— 否则改 `server` 的人会把 fail-open 的宽容带进 `install`，
//! 而「装了但没通知」这类事故正是那么来的。实测两簇互不 import。
//!
//! # 其余组成
//!
//! - [`boot`]：本域唯一启动入口（发布坐标 + 开机收敛）
//! - [`commands`]：薄命令（apply/status）
//! - [`targets`]：事实与契约（唯一事实表 + 形态词汇表 + 目录解析）
//! - [`templates`]：模板的 `include_str!` 门面（多源共用同一份 shim 的可见事实）

pub mod boot;
pub mod commands;
pub mod ingest;
pub mod install;
pub mod targets;
pub mod templates;

// ── 域门面 ──────────────────────────────────────────────────────────────────
//
// 只导出**本域之外**真正消费的入口。唯一的外部调用方（`app/boot.rs`）本就写全路径
// `crate::agent::hooks::boot::boot`，故这里**刻意不 re-export 任何符号**。
//
// 一个没人 import 的门面只是把内部实现暴露成公共 API（封装为零、约束为零），
// 却让「哪些是域边界」不可读。新增对外入口时再在这里显式声明，并同时确认有真实调用方。
