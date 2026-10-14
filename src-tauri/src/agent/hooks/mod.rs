//! 外部 Agent CLI hook 摄入（源 B，design.md §2.5，Phase B）。
//!
//! 依赖方向与源 A 一致：本模块属 agent 业务域，向应用级 `crate::notification` 门面投喂信号；
//! 通知核心域对 hook 的存在零感知。
//!
//! 组成（每单元单一职责）：
//! - `boot`：本域唯一启动入口（发布坐标 + 开机收敛）
//! - `targets`：受管 CLI 事实表（source / 目录 / 文件名 / 模板的唯一来源）
//! - `endpoint`：`~/.neeko/agent-hooks/endpoint.env` 坐标发布（跨 Neeko 重启存活，R6.1）
//! - `attribution`：归属降级链纯函数（env → cwd 反查 → basename 兜底，D8）
//! - `notify`：hook 上报 → `NotificationSignal` 投影（与源 A 同 event_key 命名空间，R6.6）
//! - `server`：loopback HTTP ingest（127.0.0.1 随机端口 + token + fail-open，R6.2/R6.3）
//! - `writers`：用户级 hook 文件的安装/卸载/状态（客人义务，R6.5）

/// 归属降级链（纯函数，D8）。
pub mod attribution;
/// 域启动入口（与 session/agent/library/lsp 四域对称）。
pub mod boot;
/// CLI hook 薄命令（apply/status；agent 域归属，见文件头）。
pub mod commands;
/// endpoint 文件坐标发布（R6.1）。
pub mod endpoint;
/// hook 上报 envelope 契约 + 通知信号投影。
pub mod notify;
/// loopback HTTP ingest server（fail-open，绝不阻塞 agent）。
pub mod server;
/// 受管 CLI 事实表（新增 CLI 只加一行数据）。
pub mod targets;
/// pi / opencode hook 文件的安装/卸载/状态（R6.5）。
pub mod writers;

pub use attribution::{attribute, Attribution, EnvHints, ProjectRef};
pub use endpoint::EndpointPublication;
pub use notify::{project, HookEnvelope};
pub use targets::HOOK_TARGETS;
pub use writers::{
    install_all, reconcile_action, status_all, uninstall_all, HookApplyOutcome, HookApplyStatus,
    HookInstallStatus, ReconcileAction,
};
