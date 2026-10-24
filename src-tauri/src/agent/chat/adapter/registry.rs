//! 传输构造表 —— 「每种传输用哪个 adapter 解读字节流」的唯一来源。
//!
//! # 为什么与 `common/agent/chat_launch.rs::rules` 分成两张表
//!
//! 两张表的键都是 [`ChatTransport`]，但关注点不同：
//!
//! | 表 | 位置 | 关注点 | 能否依赖 adapter |
//! | --- | --- | --- | --- |
//! | `rules::TRANSPORT_RULES` | `common/agent/` | **怎么识别**（argv token 规则） | 不能 —— 它是 `ChatLaunch` 自身的释义 |
//! | `PROTOCOL_BUILDS` | 本文件 | **怎么构造**（哪个 adapter） | 能 —— 它就是 adapter 层的东西 |
//!
//! 合成一张放进 `common/` 会让 `common` 反向依赖 `agent::chat::adapter`，
//! 与既有的 `adapter → common` 构成**环**（`common` 目前对 `agent/chat` 的
//! 生产依赖为零，见任务 design §1.5「分层裁决」）。分成两张后两边都单向。
//!
//! 新增一种传输的代价是**三行**：识别规则一行、构造一行、前端 `TRANSPORTS` 一行。

use crate::agent::chat::adapter::deepseek::DeepSeekHarnessAdapter;
use crate::agent::chat::adapter::opencode::ServeAdapter;
use crate::agent::chat::adapter::pi_rpc;
use crate::agent::chat::adapter::{AcpAdapter, AgentAdapter, LaunchMode, LaunchSpec};
use crate::common::agent::chat_launch::ChatLaunch;
use crate::common::agent::chat_launch::ChatTransport;
use crate::common::agent::types::AgentConfig;

/// 一条构造规则。
pub struct BuildDef {
    /// 这条構造规则属于哪种传输（与 `rules::TRANSPORT_RULES` 同键）。
    pub transport: ChatTransport,
    /// 构造 adapter。收 [`LaunchSpec`] —— adapter 层因此不需要知道
    /// `AgentConfig` 与 `ChatLaunch` 的存在。
    pub build: fn(LaunchSpec) -> Box<dyn AgentAdapter>,
}

const fn build(transport: ChatTransport, f: fn(LaunchSpec) -> Box<dyn AgentAdapter>) -> BuildDef {
    BuildDef {
        transport,
        build: f,
    }
}

/// 构造表。顺序只影响查找耗时，**不表达优先级**（识别的优先级在 `rules` 表里）。
pub static PROTOCOL_BUILDS: &[BuildDef] = &[
    build(ChatTransport::Acp, |spec| {
        // 进程内实现走 `AcpIo::Mock` —— 「进程内」是**怎么跑**，不是另一种传输，
        // 所以它属于 spec（`LaunchMode::InProcess`）而不属于 `ChatTransport`。
        let LaunchSpec {
            mode,
            env,
            wire_format,
        } = spec;
        match mode {
            LaunchMode::InProcess => Box::new(AcpAdapter::mock()),
            LaunchMode::Process { cmd } => Box::new(AcpAdapter::new(cmd, env, wire_format)),
        }
    }),
    build(ChatTransport::Serve, |spec| {
        let LaunchSpec { mode, env, .. } = spec;
        Box::new(ServeAdapter::new(mode.into_command(), env))
    }),
    build(ChatTransport::Jsonl, |spec| {
        let LaunchSpec { mode, env, .. } = spec;
        Box::new(DeepSeekHarnessAdapter::new(mode.into_command(), env))
    }),
    build(ChatTransport::PiRpc, |spec| {
        let LaunchSpec { mode, env, .. } = spec;
        Box::new(pi_rpc::PiRpcAdapter::new(mode.into_command(), env))
    }),
];

/// 查不到即程序 bug —— 两张表不同步时**响亮失败**，不给静默兜底。
///
/// # 为什么不把 infallible 的编译期保障搬回来
///
/// 原先用 `match launch.transport() { … }` 时，漏一个变体会编译报错。遍历表
/// 不会有这个报错 —— 这是表化的已知代价。用两道防线抵消：本函数的 panic +
/// `every_transport_variant_has_a_build` 测试（`common/agent/chat_launch.rs`
/// 的同类防线管另一张表，两边都在同一次 `cargo test` 里跑）。
#[must_use]
pub fn build_for(transport: ChatTransport) -> &'static BuildDef {
    PROTOCOL_BUILDS
        .iter()
        .find(|d| d.transport == transport)
        .unwrap_or_else(|| {
            panic!(
                "PROTOCOL_BUILDS 缺少 {transport:?} 的表项；新增 ChatTransport \
                 变体时必须同时加一条 BuildDef（agent/chat/registry.rs）"
            )
        })
}

/// 把 `AgentConfig` + `ChatLaunch` 组装成 adapter 层唯一输入。
///
/// 放在 domain 侧而不是 `AgentConfig` 的方法：`LaunchSpec` 依赖 `WireFormat` 尚可，
/// 但它概念上是「adapter 要的东西」。若挂成 `AgentConfig::chat_launch_spec()`，
/// `common` 就得 `use crate::agent::chat::…` —— 那是分层反向（见 §顶端说明）。
///
/// # 失败条件
///
/// env 里有解析不了的 `!VAR` 引用（变量未设置）。**必须上抛**：静默传空串会让
/// agent 收到一个「已设置但无效」的 key，表现是 401 —— 而 401 的根因从 UI 上
/// 完全看不出来。
pub fn launch_spec_for(
    config: &AgentConfig,
    launch: &ChatLaunch,
) -> Result<LaunchSpec, crate::common::error::AppError> {
    let mode = if launch.inprocess {
        LaunchMode::InProcess
    } else {
        LaunchMode::Process {
            cmd: config.chat_cmd_vec(),
        }
    };
    let env = config
        .resolved_chat_env()
        .map_err(crate::common::error::AppError::InvalidInput)?;
    Ok(LaunchSpec {
        mode,
        env,
        wire_format: launch.wire_format,
    })
}

#[cfg(test)]
mod tests {
    use super::{build_for, PROTOCOL_BUILDS};
    use crate::agent::chat::adapter::{LaunchMode, LaunchSpec};
    use crate::common::agent::chat_launch::{rules, ChatTransport};

    fn spec_cmd(cmd: &[&str]) -> LaunchSpec {
        LaunchSpec {
            mode: LaunchMode::Process {
                cmd: cmd.iter().map(|s| s.to_string()).collect(),
            },
            env: Default::default(),
            wire_format: None,
        }
    }

    /// **穷举防线**：每个传输变体都要有构造表项，且与另一张表**同一个** transport 集合。
    ///
    /// 这条同时兜住「忘加项」与「两张表漂移」：前者 panic，后者数量不等。
    /// 变异验证：删掉任一表项 → 红。
    #[test]
    fn every_transport_variant_has_a_build() {
        for &t in ChatTransport::ALL {
            assert_eq!(build_for(t).transport, t);
        }
        assert_eq!(PROTOCOL_BUILDS.len(), ChatTransport::ALL.len());
        assert_eq!(PROTOCOL_BUILDS.len(), rules::TRANSPORT_RULES.len());
    }

    /// 两张表的 transport 必须**逐项同序** —— 它们都按 `ChatTransport` 声明序排列，
    /// 顺序漂移说明有人手工调整过其一。
    #[test]
    fn both_tables_list_transports_in_the_same_order() {
        let builds: Vec<ChatTransport> = PROTOCOL_BUILDS.iter().map(|d| d.transport).collect();
        let rules_vec: Vec<ChatTransport> =
            rules::TRANSPORT_RULES.iter().map(|r| r.transport).collect();
        assert_eq!(builds, rules_vec);
    }

    /// 四个构造分支都产出可用 adapter（含进程内那条，它走 `spec.is_inprocess()`）。
    #[test]
    fn every_build_produces_an_adapter() {
        for &t in ChatTransport::ALL {
            let _ = (build_for(t).build)(spec_cmd(&["whatever"]));
        }
        let _inprocess = (build_for(ChatTransport::Acp).build)(LaunchSpec {
            mode: LaunchMode::InProcess,
            env: Default::default(),
            wire_format: None,
        });
    }

    /// id 只有一处来源：这里是 `rules` 的引用，不重复一份字符串。
    #[test]
    fn ids_come_from_the_recogniser_table() {
        for &t in ChatTransport::ALL {
            assert_eq!(t.as_str(), rules::rule_for(t).id);
        }
    }
}
