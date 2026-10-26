//! 应用级通知域 —— 业务无关的通知裁决与投递（design.md v2/v3 核心架构）。
//!
//! 依赖方向（T4/D6）：本域不 import 任何业务域；业务域（agent，未来 git/terminal/import…）
//! 单向依赖 [`NotificationCenter`] 门面。语义类别是闭集 enum，业务来源是开集数据 ——
//! 新业务接入本域零改动（AC10 测试钉住）。
//!
//! 防腐护栏：`tools/guards/checks/check_notification_core_direction.py` —— 本目录任何文件
//! 出现业务模块的 crate 引用即 CI 违规（判据源在该脚本，勿在注释复述字面量）。
//!
//! **门面宽度**：`pub use` 只列业务域真实消费的名字（`NotificationCenter` + 信号三件套）——
//! 其余类型走各自模块路径（`types::` / `policy::` / `dispatch::`），核心域内部调用不受影响。
//! 2026-10-13 审查：此前 re-export 了 11 个名字，其中 7 个全仓零外部消费者（YAGNI）。

/// 启动接线：点击回流通道注册（一次）+ 待处理深链暂存。
pub mod boot;
/// 应用级门面：业务域唯一入口。
pub mod center;
/// 通知设置薄命令（红线 6）。
pub mod commands;
/// Draft → 系统通知投递（平台后端经 `platform/system_notify` 选择，其余回退官方插件）。
pub mod dispatch;
/// 纯函数决策核心（不 import tauri / 不 async / 不碰 IO）。
pub mod policy;
/// 通知值类型契约（语义闭集 + 来源开集）。
pub mod types;

pub use center::NotificationCenter;
pub use types::{NotificationClass, NotificationSignal, SourceRef};
