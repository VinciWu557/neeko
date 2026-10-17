//! hook 上报 envelope 契约 + 通知信号投影（源 B 的「投影入口」，design §2.5）。
//!
//! 与源 A 的分工：`agent/chat/notify.rs` 投影 `StreamEvent`；本模块投影外部 CLI hook 上报。
//! 上报模板（writers 生成）已把各 CLI 的原生事件名归一为**语义 event_key**（与源 A 同
//! 命名空间）——服务端不再认识 CLI 原生事件名，新 CLI 接入的翻译成本收敛在其模板内。

use serde::Deserialize;

use crate::agent::chat::notify::event_keys;
use crate::agent::hooks::ingest::attribution::Attribution;
use crate::notification::{NotificationClass, NotificationSignal, SourceRef};

/// ingest server 解析鉴权后的规范化上报（字段白名单；serde 默认忽略未知字段）。
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct HookEnvelope {
    /// agent 侧会话 id（归属 instance 的原料）。
    pub agent_session_id: String,
    /// 语义事件键（模板侧归一）：`turn_completed` / `approval_requested` / `input_requested`。
    pub event: String,
    /// 上报时的工作目录（归属链第 2/3 级原料）。
    #[serde(default)]
    pub cwd: Option<String>,
    /// 人类可读细节（如 permission 标题），可缺省；截断由核心域负责。
    #[serde(default)]
    pub detail: Option<String>,
    /// 会话主题（R7.5）：模板侧解析好的 agent 原生标题，或（pi）原生标题缺失时回退的
    /// 首条用户消息。模板侧做优先级判定，服务端只做噪声过滤（R7.2）。
    #[serde(default)]
    pub title: Option<String>,
    /// 环境提示（Neeko 自有 PTY 注入 env 的回传），缺省视为全 None。
    #[serde(default)]
    pub hints: crate::agent::hooks::ingest::attribution::EnvHints,
}

impl HookEnvelope {
    /// agent_session_id 为空的上报不可用（instance 身份缺失）——server 层 fail-open 吞掉。
    #[must_use]
    pub fn is_usable(&self) -> bool {
        !self.agent_session_id.trim().is_empty()
    }
}

/// 语义事件键 → (class, event_key, label)。与源 A 同命名空间：节流/合并/设置键统一（R6.6）。
/// 未知事件 → `None`（fail-open：模板版本漂移不产生错误噪音）。
fn classify(event: &str) -> Option<(NotificationClass, &'static str, &'static str)> {
    match event {
        event_keys::TURN_COMPLETED => Some((
            NotificationClass::Completed,
            event_keys::TURN_COMPLETED,
            "任务完成",
        )),
        event_keys::APPROVAL_REQUESTED => Some((
            NotificationClass::ActionRequired,
            event_keys::APPROVAL_REQUESTED,
            "Agent 等待审批",
        )),
        event_keys::INPUT_REQUESTED => Some((
            NotificationClass::ActionRequired,
            event_keys::INPUT_REQUESTED,
            "Agent 等待输入",
        )),
        // 2026-10-16 补：Claude 兼容面的 `StopFailure`（以及 Codex 将来的等价事件）
        // 投影到会话异常。此前缺此 arm → 该类上报被 fail-open 静默吞掉（通知缺失）。
        event_keys::SESSION_FAILED => Some((
            NotificationClass::Failed,
            event_keys::SESSION_FAILED,
            "会话异常",
        )),
        _ => None,
    }
}

/// 把 hook 上报投影为核心域信号。
///
/// `source` 是路由段（`/hook/{source}`）—— 白名单**不在此处**，由受管事实表
/// [`crate::agent::hooks::targets::HOOK_TARGETS`] 派生（`server::hook_source` 只认表里的行）。
/// 故新增一个 CLI 无需改本函数。
#[must_use]
pub fn project(
    source: &str,
    envelope: &HookEnvelope,
    attribution: &Attribution,
) -> Option<NotificationSignal> {
    let (class, event_key, event_label) = classify(&envelope.event)?;
    Some(NotificationSignal {
        source: SourceRef {
            domain: "agent",
            instance_id: attribution.instance_id.clone(),
            // 文案区分来源形态（外部终端 CLI），仍是纯数据。
            origin_label: format!("{source} (CLI)"),
            group_label: attribution.group_label.clone(),
        },
        class,
        event_key: event_key.to_string(),
        event_label: event_label.to_string(),
        detail: envelope.detail.clone().filter(|d| !d.trim().is_empty()),
        topic: envelope
            .title
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            // 占位标题不算主题（R7.2）：opencode 未命名会话的 title 形如
            // `New session - 2026-10-13T02:08:07.973Z`（实测 206/621 条），
            // 展示出来等于把时间戳当主题，不如不显示。
            .filter(|t| !is_placeholder_title(t))
            .map(str::to_string),
    })
}

/// 占位标题判定（R7.2）：opencode 自动生成的 `New session - <ISO 时间戳>`。
///
/// 判据放在 agent 域（业务知识），核心域不感知具体文案 —— 新 CLI 若引入别的占位形态，
/// 在此加一条即可，不影响投递链。
fn is_placeholder_title(title: &str) -> bool {
    let Some(rest) = title.strip_prefix("New session") else {
        return false;
    };
    let rest = rest
        .trim_start_matches(|c: char| c == '-' || c.is_whitespace())
        .trim();
    // 前缀命中且余下部分像时间戳（以 4 位年份开头）才算占位：避免误杀正常命名的
    // "New session handling" 这类标题。
    rest.len() >= 4 && rest.as_bytes()[..4].iter().all(u8::is_ascii_digit)
}

// ── TDD：envelope 契约与投影 ───────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(event: &str) -> HookEnvelope {
        HookEnvelope {
            agent_session_id: "agent-1".into(),
            event: event.into(),
            cwd: None,
            detail: None,
            title: None,
            hints: Default::default(),
        }
    }

    fn attribution() -> Attribution {
        Attribution {
            instance_id: "cli:agent-1".into(),
            group_label: "neeko".into(),
            project_id: Some("p1".into()),
        }
    }

    /// 三类语义事件投影到与源 A 相同的 event_key（跨源节流/设置键统一的前提）。
    #[test]
    fn semantic_events_share_namespace_with_pipeline_source() {
        for (event, class) in [
            (event_keys::TURN_COMPLETED, NotificationClass::Completed),
            (
                event_keys::APPROVAL_REQUESTED,
                NotificationClass::ActionRequired,
            ),
            (
                event_keys::INPUT_REQUESTED,
                NotificationClass::ActionRequired,
            ),
            // 2026-10-16 补：会话异常（Claude 兼容面的 StopFailure）。
            (event_keys::SESSION_FAILED, NotificationClass::Failed),
        ] {
            let sig = project("opencode", &envelope(event), &attribution()).expect("mapped");
            assert_eq!(sig.class, class);
            assert_eq!(sig.event_key, event);
            assert_eq!(sig.source.domain, "agent");
            assert_eq!(sig.source.instance_id, "cli:agent-1");
            assert_eq!(sig.source.origin_label, "opencode (CLI)");
        }
    }

    /// 未知事件名 → None（模板与 server 版本错配时 fail-open）。
    #[test]
    fn unknown_event_is_ignored() {
        assert!(project("pi", &envelope("session.idle"), &attribution()).is_none());
    }

    /// 会话异常事件的标签与类别（R5.2）：`session_failed` → Failed 类 + 「会话异常」文案。
    #[test]
    fn session_failed_maps_to_failed_class_with_label() {
        let (class, key, label) =
            classify(event_keys::SESSION_FAILED).expect("session_failed must be mapped");
        assert_eq!(class, NotificationClass::Failed);
        assert_eq!(key, event_keys::SESSION_FAILED);
        assert_eq!(label, "会话异常");
    }

    /// R7.5：上报的 title 成为信号 topic（模板侧已判定优先级，服务端只做透传+过滤）。
    #[test]
    fn reported_title_becomes_topic() {
        let mut e = envelope(event_keys::TURN_COMPLETED);
        e.title = Some("  修复登录竞态  ".into());
        let sig = project("opencode", &e, &attribution()).expect("mapped");
        assert_eq!(sig.topic.as_deref(), Some("修复登录竞态"));
    }

    /// R7.2：opencode 未命名会话的占位标题不算主题（否则展示成时间戳）；
    /// 但形近的正常标题不得被误杀。
    #[test]
    fn placeholder_titles_are_not_topics() {
        for placeholder in [
            "New session - 2026-10-13T02:08:07.973Z",
            "New session - 2026-10-12T14:05:45.381Z",
        ] {
            let mut e = envelope(event_keys::TURN_COMPLETED);
            e.title = Some(placeholder.into());
            let sig = project("opencode", &e, &attribution()).expect("mapped");
            assert_eq!(sig.topic, None, "{placeholder} 是占位标题，不应作为主题");
        }
        // 正常命名（含以 "New session" 开头的真实标题）必须保留。
        for real in ["neeko-probe", "New session handling refactor"] {
            let mut e = envelope(event_keys::TURN_COMPLETED);
            e.title = Some(real.into());
            let sig = project("opencode", &e, &attribution()).expect("mapped");
            assert_eq!(sig.topic.as_deref(), Some(real));
        }
    }

    /// 缺省 / 空白 title → 无主题（不回退成空串占位）。R7.6 降级链不阻塞投递。
    #[test]
    fn missing_or_blank_title_yields_no_topic() {
        let sig =
            project("pi", &envelope(event_keys::TURN_COMPLETED), &attribution()).expect("mapped");
        assert_eq!(sig.topic, None);

        let mut blank = envelope(event_keys::TURN_COMPLETED);
        blank.title = Some("   ".into());
        let sig = project("pi", &blank, &attribution()).expect("mapped");
        assert_eq!(sig.topic, None);
    }

    /// envelope 反序列化：字段白名单 + 未知字段忽略 + 可选项缺省（模板前向兼容）。
    #[test]
    fn envelope_deserializes_whitelisted_fields() {
        let e: HookEnvelope = serde_json::from_str(
            r#"{"agent_session_id":"a1","event":"turn_completed","cwd":"/x","future_field":42}"#,
        )
        .expect("valid envelope");
        assert_eq!(e.agent_session_id, "a1");
        assert_eq!(e.cwd.as_deref(), Some("/x"));
        assert_eq!(e.detail, None);
        assert_eq!(e.hints, Default::default());
    }

    /// 空 agent_session_id 不可用（instance 身份缺失，server 层吞掉）。
    #[test]
    fn blank_session_id_unusable() {
        let mut e = envelope("turn_completed");
        e.agent_session_id = "   ".into();
        assert!(!e.is_usable());
        e.agent_session_id = "a1".into();
        assert!(e.is_usable());
    }

    /// 空白 detail 归一为 None（核心域落类别兜底文案）。
    #[test]
    fn blank_detail_normalized() {
        let mut e = envelope(event_keys::APPROVAL_REQUESTED);
        e.detail = Some("   ".into());
        assert_eq!(project("pi", &e, &attribution()).unwrap().detail, None);
    }
}
