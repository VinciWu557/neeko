//! 一个 `(agent, 传输)` 组合的**全部**能力声明。
//!
//! # 为什么是值对象，而不是 trait 上的散装 `supports_*`
//!
//! 散装方法有三个实际危害（都在 `10-21-pi-rpc-adapter` 里发生过）：
//!
//! 1. **新增能力时旧 adapter 不报错** —— trait 有默认实现，于是新能力对所有
//!    既有 adapter 静默降级。
//! 2. **前端拿不到完整图景** —— 只能靠「`configOptions` 是否非空」推断能力，
//!    而「不支持」与「会话还没建立」在数据上长得一样。
//! 3. **无法一次性校验「声明 == 行为」** —— 每个能力要单独造场景验证。
//!
//! 收成一个值对象后，新增字段会让**所有 adapter 的构造点编译失败**，强制表态。
//!
//! # 与 `StreamEvent::Capabilities` 的关系
//!
//! `Capabilities`（`events.rs`）是**会话建立后**下发给前端的快照，字段偏「事件
//! 语义」（`command_echo` / `diff`）。本类型是**适配器级**的静态声明，字段偏
//! 「机制语义」（走哪条写入通道）。两者不能合并 —— 但必须由后者**派生**前者，
//! 否则又会出现两份互不校验的真相（见 `design.md` P1）。

use serde::{Deserialize, Serialize};

/// 会话配置项（模型 / 推理档位 / 模式 / 模型参数）的读写机制。
///
/// **用枚举而非 bool 组合**：`SessionConfig` 与 `PerTurn` 是互斥的两种实现，
/// bool 会允许 `{config: true, per_turn: true}` 这种无意义状态。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigCapability {
    /// 通过 `SetConfigOption` 读写；变更是 `ConfigOptionUpdate` **全量**回推；
    /// 握手时配置项在 `SessionStart.config_options` 里。
    ///
    /// 声明本变体即承诺三件事（缺一条即违约）：
    /// ① 握手带 `config_options` ② `SetConfigOption` 真的下发
    /// ③ 变更后产生 `ConfigOptionUpdate`
    SessionConfig,
    /// 通过每轮请求的参数传递（如 serve 的 `Turn { model_id }`）。
    /// **不产生** `ConfigOptionUpdate`。
    PerTurn,
    /// 不支持会话内配置。
    #[default]
    None,
}

impl ConfigCapability {
    /// 该传输是否**能选模型**（会话内配置项或每轮请求参数）。
    ///
    /// 这是「能不能选模型」的**唯一**判据。前端据此决定是否显示控件；
    /// 后端 `list_agent_models` 据此区分 `SessionScoped` 与 `Unsupported`。
    ///
    /// `PerTurn` 也为真（模型选择器有意义），但它的写入走请求参数而非配置项 ——
    /// 「能不能选」与「怎么写」是两个问题，分别由本方法与
    /// [`Self::uses_session_config`] 回答。
    #[must_use]
    pub const fn shows_controls(self) -> bool {
        !matches!(self, Self::None)
    }

    /// 是否通过 `SetConfigOption` 写入。
    ///
    /// 这是**唯一**该用来判断「能不能发 set_config_option」的判据 ——
    /// 旧实现靠 `configOptions` 非空推断，对 serve 恒为假但无显式声明。
    #[must_use]
    pub const fn uses_session_config(self) -> bool {
        matches!(self, Self::SessionConfig)
    }
}

/// 一个 `(agent, 传输)` 组合的完整能力快照。
///
/// 默认全关 = 最安全：新 adapter 忘填会被契约测试抓住，
/// 而不是悄悄得到一个「看起来能用」的组合。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatCapabilities {
    /// 会话配置项的读写机制。
    pub config: ConfigCapability,
    /// 是否支持审批 Gate（`RequestApproval` 会被真的发出）。
    pub approvals: bool,
    /// 是否能列出 slash 命令（有独立命令列表的查询途径）。
    pub commands: bool,
    /// 是否能恢复历史会话（`resume_id` 有真实值且 `resume` 可用）。
    pub resume: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 默认必须全关 —— 新 adapter 忘填时不能"恰好"得到能力。
    #[test]
    fn default_declares_nothing() {
        let caps = ChatCapabilities::default();
        assert_eq!(caps.config, ConfigCapability::None);
        assert!(!caps.approvals);
        assert!(!caps.commands);
        assert!(!caps.resume);
    }

    /// 两种写入机制互斥，且 `shows_controls` 对它们都为真。
    #[test]
    fn config_capability_mechanisms_are_exclusive() {
        assert!(ConfigCapability::SessionConfig.uses_session_config());
        assert!(!ConfigCapability::PerTurn.uses_session_config());
        assert!(!ConfigCapability::None.uses_session_config());

        assert!(ConfigCapability::SessionConfig.shows_controls());
        assert!(ConfigCapability::PerTurn.shows_controls());
        assert!(!ConfigCapability::None.shows_controls());
    }

    /// **`shows_controls` 就是 `supports_model_selection` 的判据**。
    ///
    /// 两者曾经是两份独立声明（`supports_model_selection()` 可被 adapter 单独
    /// override，与能力快照互不校验）—— 那正是 P1 的形态。现在后者由前者派生，
    /// 这条用例钉住派生关系：一旦有人重新给 `supports_model_selection` 加 override
    /// 并写回 `false`，所有声明可配配置项的 adapter 会立刻在此报红。
    #[test]
    fn model_selection_is_derived_from_the_snapshot() {
        use crate::agent::chat::adapter::{AgentAdapter, AgentContext, AgentKind};
        use async_trait::async_trait;

        struct Probe(ConfigCapability);

        #[async_trait]
        impl AgentAdapter for Probe {
            fn kind(&self) -> AgentKind {
                AgentKind::Custom
            }
            async fn create(
                &self,
                _ctx: &AgentContext,
            ) -> Result<
                Box<dyn crate::agent::chat::adapter::AgentSession>,
                crate::common::error::AppError,
            > {
                Err(crate::common::error::AppError::Unsupported("probe".into()))
            }
            // 只填能力快照 —— **不**覆写 `supports_model_selection`。
            fn chat_capabilities(&self) -> ChatCapabilities {
                ChatCapabilities {
                    config: self.0,
                    ..ChatCapabilities::default()
                }
            }
        }

        for (config, expected) in [
            (ConfigCapability::SessionConfig, true),
            (ConfigCapability::PerTurn, true),
            (ConfigCapability::None, false),
        ] {
            assert_eq!(
                Probe(config).supports_model_selection(),
                expected,
                "{config:?} must derive model selection from the snapshot"
            );
        }
    }

    /// 线上形状：snake_case，前端据此判断。
    #[test]
    fn serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&ConfigCapability::SessionConfig).unwrap(),
            r#""session_config""#
        );
        assert_eq!(
            serde_json::to_string(&ConfigCapability::PerTurn).unwrap(),
            r#""per_turn""#
        );
        assert_eq!(
            serde_json::to_string(&ConfigCapability::None).unwrap(),
            r#""none""#
        );
    }

    /// 往返：前后端共用同一份字段名。
    #[test]
    fn round_trips() {
        let caps = ChatCapabilities {
            config: ConfigCapability::SessionConfig,
            approvals: true,
            commands: true,
            resume: true,
        };
        let json = serde_json::to_string(&caps).unwrap();
        assert_eq!(
            serde_json::from_str::<ChatCapabilities>(&json).unwrap(),
            caps
        );
    }
}
