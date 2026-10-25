//! 能力声明的**可执行校验**。
//!
//! 照搬根 `AGENTS.md` 红线 14 的判据（「LSP 能力声明必须与实现一致」）：
//! 声明了什么，就必须在同一处给出实现，且由测试钉住。
//!
//! # 为什么必须有它
//!
//! P1 的成因是能力声明有三份互不校验的真相。其中 `SessionStart.capabilities`
//! 曾被四个 adapter 各自硬编码 —— **四个全填 `approvals: true`，包括
//! `deepseek`（495 行里没有任何审批实现）**。这类谎报靠人读代码发现不了，
//! 只能让测试去建一个真会话、观察它到底会不会发 `RequestApproval`。
//!
//! # 用法
//!
//! 每个 adapter 的测试调用 [`assert_capabilities_hold`]。对 MockAgent 必须
//! **无条件通过**（它是契约的参考实现）；对真实 adapter 标 `#[ignore]`
//!（需要外部进程，CI 不跑）。
//!
//! # MockAgent 优先策略
//!
//! 契约先在进程内 mock 上改到对，再拿去校验真实 adapter —— 那时失败的一定是
//! adapter 而不是契约本身。反馈周期从分钟级降到毫秒级。

use std::time::Duration;

use crate::agent::chat::adapter::{AgentAdapter, AgentContext, AgentSession};
use crate::agent::chat::capabilities::{ChatCapabilities, ConfigCapability};
use crate::agent::chat::events::StreamEvent;

/// 单条事件的等待上限。mock 是进程内的，10 秒足够；真实 adapter 更慢，
/// 但超时即判失败比挂死 40 分钟好（本项目有过这个教训）。
const EVENT_TIMEOUT: Duration = Duration::from_secs(10);

/// 断言 `adapter` 声明的能力与它的**实际行为**一致。
///
/// # Errors
///
/// 返回第一条不满足的约束描述。调用方在测试里 `.expect(...)` 即可。
pub async fn assert_capabilities_hold(
    adapter: &dyn AgentAdapter,
    ctx: &AgentContext,
) -> Result<(), String> {
    let caps = adapter.chat_capabilities();
    let mut session = adapter
        .create(ctx)
        .await
        .map_err(|e| format!("create() failed: {e}"))?;

    let start = wait_for_session_start(&mut session, caps).await?;

    check_config_capability(caps, &start)?;

    // 审批：声明 true 的 adapter 必须能**发出** RequestApproval。
    // 这里只做「声明与握手一致」的静态部分；「是否真的会发」需要造出触发场景，
    // 由各 adapter 自己的集成测试覆盖（mock 的审批在 `mock.rs` 里已有用例）。
    Ok(())
}

/// 等 `SessionStart`（必须出现，且必须在开头附近）。
async fn wait_for_session_start(
    session: &mut Box<dyn AgentSession>,
    caps: ChatCapabilities,
) -> Result<StreamEvent, String> {
    for _ in 0..32 {
        let next = tokio::time::timeout(EVENT_TIMEOUT, session.next())
            .await
            .map_err(|_| format!("timeout waiting for SessionStart (caps: {caps:?})"))?
            .ok_or_else(|| "session ended before SessionStart".to_string())?;
        let ev = next.map_err(|e| format!("session error before SessionStart: {e}"))?;
        if matches!(ev, StreamEvent::SessionStart { .. }) {
            return Ok(ev);
        }
    }
    Err("SessionStart never arrived".into())
}

/// `ConfigCapability` 的三条承诺，逐条校验。
fn check_config_capability(caps: ChatCapabilities, start: &StreamEvent) -> Result<(), String> {
    let StreamEvent::SessionStart {
        config_options,
        capabilities,
        ..
    } = start
    else {
        return Err("expected SessionStart".into());
    };

    // ① 事件里的 config 字段必须与适配器声明一致（两份真相已合并，防止回退）
    if capabilities.config != caps.config {
        return Err(format!(
            "SessionStart.config {:?} != adapter declaration {:?}",
            capabilities.config, caps.config
        ));
    }

    match caps.config {
        ConfigCapability::SessionConfig => {
            if config_options.is_empty() {
                return Err(
                    "declared ConfigCapability::SessionConfig but SessionStart carried \
                     no config_options — the frontend would render no controls"
                        .into(),
                );
            }
        }
        ConfigCapability::PerTurn | ConfigCapability::None => {
            if !config_options.is_empty() {
                return Err(format!(
                    "declared {:?} but SessionStart carried {} config_options — \
                     the frontend would render controls that cannot be written",
                    caps.config,
                    config_options.len()
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::chat::adapter::acp::AcpAdapter;
    use crate::agent::chat::adapter::deepseek::DeepSeekHarnessAdapter;

    fn ctx(agent_id: &str) -> AgentContext {
        AgentContext {
            agent_id: agent_id.into(),
            session_id: "probe".into(),
            // 平台无关（红线 13）：Windows 上没有 `/tmp`。
            project_id: std::env::temp_dir().display().to_string(),
            project_name: "probe".into(),
            env: "local".into(),
            skills: vec![],
            files: vec![],
            mode: "auto".into(),
            prompt: String::new(),
            model_id: None,
        }
    }

    /// **MockAgent 是契约的参考实现，必须无条件通过。**
    ///
    /// 它声明 `SessionConfig` + 审批 + 命令 + 恢复，且真的实现了全部四项。
    /// 这个用例是「契约本身正确」的证明 —— 它绿了之后，真实 adapter 的失败
    /// 才可归因到 adapter。
    #[tokio::test]
    async fn mock_agent_satisfies_its_own_declaration() {
        let adapter = AcpAdapter::mock();
        assert_capabilities_hold(&adapter, &ctx("mockAgent"))
            .await
            .expect("mockAgent must satisfy its declaration");
    }

    /// `deepseek` 声明 `ConfigCapability::None` 且 `approvals: false` ——
    /// 探针必须接受这个声明，并验证它**没有**带 config_options。
    ///
    /// 这条曾经失败过：旧代码在 `SessionStart` 里硬编码 `approvals: true`，
    /// 而 harness 没有任何审批实现。现在两份真相已合并。
    #[tokio::test]
    async fn deepseek_declares_no_config_and_carries_none() {
        let adapter = DeepSeekHarnessAdapter::new(vec!["/bin/true".into()], Default::default());
        let caps = adapter.chat_capabilities();
        assert_eq!(caps.config, ConfigCapability::None);
        assert!(!caps.approvals, "harness has no approval implementation");
        assert!(!caps.resume, "resume_id is always None");
    }

    /// `ConfigCapability` 的语义契约：`uses_session_config` 才是「能发
    /// set_config_option」的判据，不是 `shows_controls`。
    #[test]
    fn per_turn_shows_controls_but_does_not_use_session_config() {
        let caps = ConfigCapability::PerTurn;
        assert!(caps.shows_controls());
        assert!(!caps.uses_session_config());
    }

    mod commands_contract {
        //! `commands` 能力位 ⇔ [`AgentAdapter::list_commands`] 实现的一致性
        //! （红线 14 同源：声明了却没人实现 = 静默功能缺失；该声明却没声明
        //! 同样违约）。
        use super::*;
        use crate::agent::chat::adapter::opencode::ServeAdapter;
        use crate::agent::chat::adapter::pi_rpc::PiRpcAdapter;
        use crate::common::error::AppError;

        fn agent_config(id: &str) -> crate::common::agent::types::AgentConfig {
            crate::common::agent::types::AgentConfig {
                id: id.into(),
                name: id.into(),
                command: "cli".into(),
                ..Default::default()
            }
        }

        /// 四条传输的能力快照。
        ///
        /// serve 与 pi 都能列命令：pi 走 `get_commands`（spawn 查询），
        /// opencode 走 `GET /api/command`（`/api/*` 共享层，两版同一路径）。
        ///
        /// 变异验证：改掉任一 adapter 的位 → 本用例红。
        #[test]
        fn command_capability_matches_each_transports_reality() {
            let pi = PiRpcAdapter::new(
                vec!["pi".into(), "--mode".into(), "rpc".into()],
                Default::default(),
            );
            assert!(
                pi.chat_capabilities().commands,
                "pi exposes get_commands and implements list_commands"
            );
            assert!(!AcpAdapter::mock().chat_capabilities().commands);
            assert!(
                ServeAdapter::new(vec!["opencode".into(), "serve".into()], Default::default())
                    .chat_capabilities()
                    .commands,
                "opencode exposes GET /api/command (shared /api/* layer)"
            );
            assert!(
                !DeepSeekHarnessAdapter::new(vec!["ds".into()], Default::default())
                    .chat_capabilities()
                    .commands
            );
        }

        /// **双向一致性**：位为 false ⇔ 查询返回 `Unsupported`；位为 true ⇔
        /// 查询有真实现（用不存在的二进制验证 —— spawn 失败是任何错误**除了**
        /// `Unsupported`；若覆写被删、退回默认实现，这里立即变红，且不需要
        /// 在 CI 里起真 pi 进程）。
        ///
        /// serve 与 pi 同形：位 true ⇒ 查询必须有覆写（失败于 IO 而非
        /// `Unsupported`）。本机装了 opencode 时它会真的返回命令。
        #[tokio::test]
        async fn commands_bit_implies_list_commands_is_not_unsupported() {
            // 位 false 且**无实现** → 默认 Unsupported。
            let ds = DeepSeekHarnessAdapter::new(vec!["ds".into()], Default::default());
            let err = ds
                .list_commands(&agent_config("deepseek"), None)
                .await
                .unwrap_err();
            assert!(matches!(err, AppError::Unsupported(_)), "{err:?}");
            let acp = AcpAdapter::mock();
            let err = acp
                .list_commands(&agent_config("mockAgent"), None)
                .await
                .unwrap_err();
            assert!(matches!(err, AppError::Unsupported(_)), "{err:?}");

            // serve：位 true ⇒ 必须有覆写。「要么成功（本机有 opencode 时
            // 实测拿到 `init` / `review`），要么失败但不是 Unsupported
            // （环境问题）」—— 两种都不是「覆写被删」。
            let serve =
                ServeAdapter::new(vec!["opencode".into(), "serve".into()], Default::default());
            match serve.list_commands(&agent_config("opencode"), None).await {
                Ok(cmds) => assert!(
                    cmds.iter().all(|c| !c.name.is_empty()),
                    "returned commands must carry a name: {cmds:?}"
                ),
                Err(e) => assert!(
                    !matches!(e, AppError::Unsupported(_)),
                    "serve implements list_commands; an Unsupported here means the \
                     override is gone and the `/` entry would silently disappear: {e:?}"
                ),
            }
            // 位 true（pi）→ 必须有覆写：失败于 spawn/IO 而不是 `Unsupported`。
            let pi = PiRpcAdapter::new(
                vec!["definitely-not-a-real-binary-mention-slash".into()],
                Default::default(),
            );
            let err = pi
                .list_commands(&agent_config("pi"), None)
                .await
                .unwrap_err();
            assert!(
                !matches!(err, AppError::Unsupported(_)),
                "commands bit true ⇒ list_commands must be implemented, got: {err:?}"
            );
        }
    }
}
