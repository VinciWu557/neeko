//! 原型 —— agent 业务域的投影适配（实施落点：`src-tauri/src/agent/chat/notify.rs`）。
//!
//! 依赖方向（design.md §2.2 / D6）：agent 域 → notification 核心域，核心永不反向依赖。
//! 本模块是 agent 域**自己**的知识：如何把 `StreamEvent` 翻译成核心域的 `NotificationSignal`。
//! 未来 git/terminal 等业务接入时，各自域内写同形态的投影文件，核心域与彼此零感知。
//!
//! 唯一改变理由：`StreamEvent` 协议变化，或 agent 侧新增需要通知的事件。

// 实施期真实导入（原型阶段本文件不参与编译）：
// use crate::agent::chat::events::{DoneReason, StreamEvent, TurnEndReason};
// use crate::notification::{NotificationClass, NotificationSignal, SourceRef};

/// agent 域事件稳定标识 —— 设置覆盖表的键（"agent.approval_requested" 等）与节流主键。
/// 常量落在 agent 域（自己的知识自己管），核心域只当不透明字符串。
pub mod event_keys {
    pub const APPROVAL_REQUESTED: &str = "approval_requested";
    pub const INPUT_REQUESTED: &str = "input_requested";
    pub const TURN_COMPLETED: &str = "turn_completed";
    pub const SESSION_FAILED: &str = "session_failed";
}

/// 会话级通知上下文：由 `spawn_session_pipeline` 桥在 SessionStart/ContextInit 时绑定并持有，
/// 数据全部来自既有 `ContextManifest`，零新增采集。
#[derive(Clone, Debug)]
pub struct SessionNotifyContext {
    pub session_id: String,
    pub project_name: String,
    /// agent 标识（"pi" / "opencode" / …），仅作为文案数据（origin_label）。
    pub agent: String,
}

impl SessionNotifyContext {
    fn source(&self) -> SourceRef {
        SourceRef {
            domain: "agent",
            instance_id: self.session_id.clone(),
            origin_label: self.agent.clone(),
            group_label: self.project_name.clone(),
        }
    }
}

/// 把统一事件协议投影为通知信号。返回 None = 该事件与「用户注意」无关（绝大多数事件）。
///
/// 映射表与 prd.md R1 一一对应。注意：投影里**没有** class 之外的裁决逻辑 ——
/// 要不要发、发几条，全部是核心域 policy 的职责（关注点分离）。
pub fn project(event: &StreamEvent, ctx: &SessionNotifyContext) -> Option<NotificationSignal> {
    let (class, event_key, event_label, detail) = match event {
        // 等待审批：优先工具标题（人类可读），退化到 prompt / 工具名。
        StreamEvent::RequestApproval { title, prompt, tool, .. } => (
            NotificationClass::ActionRequired,
            event_keys::APPROVAL_REQUESTED,
            "Agent 等待审批",
            Some(first_non_blank(&[title, prompt, tool]).unwrap_or_default().to_string()),
        ),
        // 等待输入：agent 提出的问题原文（截断交给核心域）。
        StreamEvent::UserInput { prompt, .. } => (
            NotificationClass::ActionRequired,
            event_keys::INPUT_REQUESTED,
            "Agent 等待输入",
            Some(prompt.clone()),
        ),
        // 本轮完成：正常完成才投影；用户主动 stop 不通知；
        // Error 由 Error/SessionDone{error} 事件负责，避免双发。
        StreamEvent::TurnEnd { reason, .. } => match reason {
            TurnEndReason::Completed => (NotificationClass::Completed, event_keys::TURN_COMPLETED, "任务完成", None),
            TurnEndReason::Stopped | TurnEndReason::Error => return None,
        },
        // 会话终止：completed 复用 TURN_COMPLETED 键 → 核心域合并窗口自动去重；
        // cancelled 是用户自己点的，不通知；error 走 Failed。
        StreamEvent::SessionDone { reason, .. } => match reason {
            DoneReason::Completed => (NotificationClass::Completed, event_keys::TURN_COMPLETED, "任务完成", None),
            DoneReason::Error => (NotificationClass::Failed, event_keys::SESSION_FAILED, "会话异常终止", None),
            DoneReason::Cancelled => return None,
        },
        // 流级错误（agent / protocol / transport）：message 作为 detail。
        StreamEvent::Error { message, .. } => (
            NotificationClass::Failed,
            event_keys::SESSION_FAILED,
            "会话异常终止",
            Some(message.clone()),
        ),
        // 其余事件（TextDelta / ToolStart / Meta / …）与用户注意无关。
        _ => return None,
    };

    Some(NotificationSignal {
        source: ctx.source(),
        class,
        event_key: event_key.to_string(),
        event_label: event_label.to_string(),
        detail: detail.filter(|d| !d.trim().is_empty()),
    })
}

fn first_non_blank<'a>(candidates: &[&'a str]) -> Option<&'a str> {
    candidates.iter().copied().find(|c| !c.trim().is_empty())
}

// ── TDD：投影单测（每个 StreamEvent 分支一条 + None 分支抽样）────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(agent: &str) -> SessionNotifyContext {
        SessionNotifyContext { session_id: "s1".into(), project_name: "neeko".into(), agent: agent.into() }
    }

    #[test]
    fn approval_prefers_title_then_prompt_then_tool() {
        let ev = StreamEvent::RequestApproval {
            session_id: "s1".into(), call_id: "c1".into(), tool: "bash".into(),
            title: "  ".into(), prompt: "run rm -rf dist?".into(),
            diff: None, cmd: None,
        };
        let sig = project(&ev, &ctx("pi")).unwrap();
        assert_eq!(sig.class, NotificationClass::ActionRequired);
        assert_eq!(sig.event_key, "approval_requested");
        assert_eq!(sig.detail.as_deref(), Some("run rm -rf dist?"));
        // 来源数据透传（核心域据此节流/回流/文案，但不分支）
        assert_eq!(sig.source.domain, "agent");
        assert_eq!(sig.source.instance_id, "s1");
        assert_eq!(sig.source.origin_label, "pi");
        assert_eq!(sig.source.group_label, "neeko");
    }

    #[test]
    fn user_input_carries_prompt() {
        let ev = StreamEvent::UserInput { session_id: "s1".into(), turn_id: "t1".into(), prompt: "which env?".into() };
        let sig = project(&ev, &ctx("opencode")).unwrap();
        assert_eq!(sig.class, NotificationClass::ActionRequired);
        assert_eq!(sig.event_key, "input_requested");
        assert_eq!(sig.detail.as_deref(), Some("which env?"));
    }

    /// TurnEnd{completed} 与 SessionDone{completed} 投影到同一 event_key —— 核心域合并的前提。
    #[test]
    fn completed_turn_and_done_share_event_key_for_merge() {
        let turn = StreamEvent::TurnEnd { session_id: "s1".into(), turn_id: "t1".into(), reason: TurnEndReason::Completed };
        let done = StreamEvent::SessionDone { session_id: "s1".into(), reason: DoneReason::Completed };
        let a = project(&turn, &ctx("pi")).unwrap();
        let b = project(&done, &ctx("pi")).unwrap();
        assert_eq!(a.event_key, b.event_key);
        assert_eq!(a.class, NotificationClass::Completed);
    }

    #[test]
    fn user_initiated_stop_and_cancel_never_notify() {
        let stopped = StreamEvent::TurnEnd { session_id: "s1".into(), turn_id: "t1".into(), reason: TurnEndReason::Stopped };
        let cancelled = StreamEvent::SessionDone { session_id: "s1".into(), reason: DoneReason::Cancelled };
        assert!(project(&stopped, &ctx("pi")).is_none());
        assert!(project(&cancelled, &ctx("pi")).is_none());
    }

    #[test]
    fn errors_project_to_failed_with_message() {
        let ev = StreamEvent::Error {
            session_id: "s1".into(), kind: ErrorKind::Transport,
            code: "E_IO".into(), message: "connection reset".into(),
        };
        let sig = project(&ev, &ctx("pi")).unwrap();
        assert_eq!(sig.class, NotificationClass::Failed);
        assert_eq!(sig.event_key, "session_failed");
        assert_eq!(sig.detail.as_deref(), Some("connection reset"));

        let done_err = StreamEvent::SessionDone { session_id: "s1".into(), reason: DoneReason::Error };
        let sig2 = project(&done_err, &ctx("pi")).unwrap();
        assert_eq!(sig2.class, NotificationClass::Failed);
        assert_eq!(sig2.detail, None); // 核心域落类别兜底文案
    }

    #[test]
    fn high_frequency_events_are_ignored() {
        let delta = StreamEvent::TextDelta { session_id: "s1".into(), delta: "tok".into() };
        let tool = StreamEvent::ToolStart { session_id: "s1".into(), call_id: "c1".into(), name: "read_file".into(), title: "a.rs".into() };
        assert!(project(&delta, &ctx("pi")).is_none());
        assert!(project(&tool, &ctx("pi")).is_none());
    }

    #[test]
    fn whitespace_detail_normalized_to_none() {
        let ev = StreamEvent::UserInput { session_id: "s1".into(), turn_id: "t1".into(), prompt: "   ".into() };
        assert_eq!(project(&ev, &ctx("pi")).unwrap().detail, None);
    }
}
