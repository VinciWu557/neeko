//! [`LaunchSpec`] —— adapter 层的唯一输入。
//!
//! # 为什么存在
//!
//! 四个 adapter 的 `new` 签名原本都是 `(cmd: Vec<String>, env: BTreeMap)`，
//! 「怎么启动」这件事被 `adapter_for` 一趟搬运过去 —— 于是每加一个启动维度
//! （进程内、帧格式）就要改四处签名加一处分派。
//!
//! `LaunchSpec` 把「怎么启动」打包成一个值：它由 `AgentConfig` **派生一次**，
//! adapter 层因此既不需要 `AgentConfig`，也不需要 `ChatLaunch`。
//! 新增启动维度只改本文件 + 各自的 `new`。

use crate::common::agent::chat_launch::WireFormat;

/// 「怎么跑」这个维度的取值。
///
/// 用枚举而不是「`cmd` + `inprocess: bool`」的组合：**进程内实现不该有 argv**。
/// 布尔组合允许 `InProcess` 同时携带一串永远用不上的 argv，那串 argv 会让人误以为
/// 它可以被编辑。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchMode {
    /// spawn 子进程。
    Process {
        /// 完整 argv，`cmd[0]` 是 `argv[0]`。
        cmd: Vec<String>,
    },
    /// 进程内实现（不 spawn）。
    InProcess,
}

/// 启动一个 chat 进程所需的**全部**信息。
///
/// 唯一构造入口是 [`crate::common::agent::types::AgentConfig::chat_launch_spec`]。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    /// 怎么跑（spawn 还是进程内）。
    pub mode: LaunchMode,
    /// 注入给子进程的环境变量（追加/覆盖，不替换继承）。
    pub env: std::collections::BTreeMap<String, String>,
    /// ACP 帧格式。`None` = 协议默认（`ContentLength`）。
    ///
    /// 来自 `ChatLaunch::wire_format` —— 它是**配置项**，不是推断结果。曾由
    /// `AcpAdapter::new` 按 `cmd[0].contains("opencode")` 猜，用户把二进制改名
    /// 或包一层 wrapper 就会静默换错帧。
    pub wire_format: Option<WireFormat>,
}

impl LaunchSpec {
    /// 展开后的 argv。`InProcess` 时为空 —— 调用方不必区分，没有就没有。
    #[must_use]
    pub fn cmd(&self) -> &[String] {
        match &self.mode {
            LaunchMode::Process { cmd } => cmd,
            LaunchMode::InProcess => &[],
        }
    }

    /// 是否由进程内实现提供（不 spawn 子进程）。
    #[must_use]
    pub const fn is_inprocess(&self) -> bool {
        matches!(self.mode, LaunchMode::InProcess)
    }
}

impl LaunchMode {
    /// 取出 argv 的所有权（adapter 的 `new` 收 `Vec<String>`）。
    ///
    /// 放在 `LaunchMode` 上而不是 `LaunchSpec`：调用方往往只需要 argv 与 env
    /// 两个独立部分，整体消耗 `spec` 会迫使写/styles 「先解构再传」的样板。
    #[must_use]
    pub fn into_command(self) -> Vec<String> {
        match self {
            Self::Process { cmd } => cmd,
            Self::InProcess => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{LaunchMode, LaunchSpec};

    fn process(cmd: &[&str]) -> LaunchSpec {
        LaunchSpec {
            mode: LaunchMode::Process {
                cmd: cmd.iter().map(|s| s.to_string()).collect(),
            },
            env: Default::default(),
            wire_format: None,
        }
    }

    /// 进程内实现**没有** argv —— 这是防止「对着进程内桩编辑命令行」的形状保证。
    #[test]
    fn inprocess_carries_no_argv() {
        let spec = LaunchSpec {
            mode: LaunchMode::InProcess,
            env: Default::default(),
            wire_format: None,
        };
        assert!(spec.cmd().is_empty());
        assert!(spec.is_inprocess());
        assert!(spec.mode.into_command().is_empty());
    }

    #[test]
    fn process_mode_exposes_its_argv() {
        let spec = process(&["opencode", "acp"]);
        assert_eq!(spec.cmd(), ["opencode", "acp"]);
        assert!(!spec.is_inprocess());
    }

    /// `into_command` 移交所有权后不留残余（`cmd()` 与它一致）。
    #[test]
    fn into_command_matches_cmd() {
        let spec = process(&["pi", "--mode", "rpc"]);
        let owned = spec.mode.clone().into_command();
        assert_eq!(owned, spec.cmd());
    }
}
