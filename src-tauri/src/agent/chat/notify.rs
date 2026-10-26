//! Agent Chat → 通知信号投影（源 A，design.md §2.1 / prd R1）。
//!
//! 这是 **agent 域自己的知识**：如何把统一事件协议 [`StreamEvent`] 翻译成核心域的
//! [`NotificationSignal`]。未来 git/terminal 等业务接入时在各自域内写同形态投影文件，
//! 通知核心域与彼此零感知（依赖方向：agent → notification）。
//!
//! 唯一改变理由：`StreamEvent` 协议变化，或 agent 侧新增需要通知的事件。

use crate::agent::chat::events::{DoneReason, StreamEvent, TurnEndReason};
use crate::notification::{NotificationClass, NotificationSignal, SourceRef};

/// agent 域事件稳定标识 —— 设置覆盖表的键（`"agent.approval_requested"` 等）与节流主键。
/// 常量落在 agent 域（自己的知识自己管），核心域只当不透明字符串。
/// 前端设置页事件清单（`src/features/notification`）与本表一一对应。
pub mod event_keys {
    /// `StreamEvent::RequestApproval`。
    pub const APPROVAL_REQUESTED: &str = "approval_requested";
    /// `StreamEvent::UserInput`。
    pub const INPUT_REQUESTED: &str = "input_requested";
    /// `StreamEvent::TurnEnd{completed}` 与 `StreamEvent::SessionDone{completed}` 共用
    /// （design D3：同键投影 + Completed 合并窗口自动去重）。
    pub const TURN_COMPLETED: &str = "turn_completed";
    /// `StreamEvent::SessionDone{error}` 与 `StreamEvent::Error` 共用。
    pub const SESSION_FAILED: &str = "session_failed";
}

/// 会话级通知上下文：由 `spawn_session_pipeline` 在启动时绑定并持有，
/// 每个事件投影时随取。数据全部来自既有请求参数，零新增采集。
#[derive(Clone, Debug)]
pub struct SessionNotifyContext {
    /// Neeko 会话 id（通知 instance_id）。
    pub session_id: String,
    /// agent 标识（"pi" / "opencode" / …），仅作为文案数据（origin_label，R2.5）。
    pub agent_id: String,
    /// 项目展示名（进标题，group_label）。
    pub project_name: String,
    /// 会话主题（R7.4）：**会话启动时绑定的首轮 prompt**，多轮续写不会重建本上下文
    /// （续轮走 `SessionRequest::Turn`，不经 `spawn_session_pipeline`），故天然稳定。
    pub topic: Option<String>,
}

impl SessionNotifyContext {
    /// 构造投影上下文（主题优先级 R7.1：原生标题 → 首轮 prompt 首个非空行 → 无主题）。
    ///
    /// `native_topic` 由前端传入（恢复既有会话时来自 conversation 扫描的 `userTitle`/`title`，
    /// 即 agent 原生标题）；新会话没有原生标题，回退首次用户输入。取**首个非空行**而非整段：
    /// 副标题是单行展示位，prompt 里的换行会把它撑成多行（截断由核心域统一负责）。
    #[must_use]
    pub fn new(
        session_id: String,
        agent_id: String,
        project_name: String,
        native_topic: Option<String>,
        prompt: &str,
    ) -> Self {
        Self {
            session_id,
            agent_id,
            project_name,
            topic: native_topic
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .or_else(|| first_non_blank_line(prompt)),
        }
    }

    fn source(&self) -> SourceRef {
        SourceRef {
            domain: "agent",
            instance_id: self.session_id.clone(),
            origin_label: self.agent_id.clone(),
            group_label: self.project_name.clone(),
        }
    }
}

/// 首个非空行并 trim（全空白 → `None`）。
fn first_non_blank_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

/// 把统一事件协议投影为通知信号。返回 `None` = 该事件与「用户注意」无关（绝大多数事件）。
///
/// 映射表与 prd.md R1 一一对应。注意：投影里**没有**「要不要发」的判断 ——
/// 节流/合并/焦点抑制全部是核心域 policy 的职责（关注点分离）。
#[must_use]
pub fn project(event: &StreamEvent, ctx: &SessionNotifyContext) -> Option<NotificationSignal> {
    let (class, event_key, event_label, detail) = match event {
        // 等待审批：优先工具标题（人类可读），退化到 prompt / 工具名。
        StreamEvent::RequestApproval {
            title,
            prompt,
            tool,
            ..
        } => (
            NotificationClass::ActionRequired,
            event_keys::APPROVAL_REQUESTED,
            "Agent needs approval",
            first_non_blank(&[title, prompt, tool]).map(str::to_string),
        ),
        // 等待输入：agent 提出的问题原文（截断交给核心域，R2.4）。
        StreamEvent::UserInput { prompt, .. } => (
            NotificationClass::ActionRequired,
            event_keys::INPUT_REQUESTED,
            "Agent needs input",
            Some(prompt.clone()),
        ),
        // 本轮完成：正常完成才投影；用户主动 stop 不通知（R1）；
        // TurnEnd{error} 留给 Error / SessionDone{error} 事件，避免双发（design D3）。
        StreamEvent::TurnEnd { reason, .. } => match reason {
            TurnEndReason::Completed => (
                NotificationClass::Completed,
                event_keys::TURN_COMPLETED,
                "Agent turn completed",
                None,
            ),
            TurnEndReason::Stopped | TurnEndReason::Error => return None,
        },
        // 会话终止：completed 复用 TURN_COMPLETED 键 → 核心域合并窗口自动去重；
        // cancelled 是用户自己点的，不通知；error 走 Failed。
        StreamEvent::SessionDone { reason, .. } => match reason {
            DoneReason::Completed => (
                NotificationClass::Completed,
                event_keys::TURN_COMPLETED,
                "Agent turn completed",
                None,
            ),
            DoneReason::Error => (
                NotificationClass::Failed,
                event_keys::SESSION_FAILED,
                "Agent session failed",
                None,
            ),
            DoneReason::Cancelled => return None,
        },
        // 流级错误（agent / protocol / transport）：message 作为 detail。
        StreamEvent::Error { message, .. } => (
            NotificationClass::Failed,
            event_keys::SESSION_FAILED,
            "Agent session failed",
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
        // 主题是会话级常量，逐事件克隆（仅通知类事件才走到这里，量级可忽略）。
        topic: ctx.topic.clone().filter(|t| !t.trim().is_empty()),
    })
}

/// 会话终止（任意原因）时回收该实例的节流记忆 —— 由桥接层判定后调用，
/// 保持「实例关闭 → 记忆释放」的生命周期闭环（防长跑进程内存增长）。
#[must_use]
pub const fn is_session_terminal(event: &StreamEvent) -> bool {
    matches!(event, StreamEvent::SessionDone { .. })
}

fn first_non_blank<'a>(candidates: &[&'a str]) -> Option<&'a str> {
    candidates.iter().copied().find(|c| !c.trim().is_empty())
}

// ── TDD：投影单测（每个 StreamEvent 分支一条 + None 分支抽样）────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(agent: &str) -> SessionNotifyContext {
        SessionNotifyContext {
            session_id: "s1".into(),
            agent_id: agent.into(),
            project_name: "neeko".into(),
            topic: None,
        }
    }

    /// R7.1 优先级：原生标题 > 首轮 prompt 首个非空行 > 无主题；prompt 取首个非空行
    /// （副标题是单行位，多行 prompt 不能撑成多行）。
    #[test]
    fn topic_prefers_native_title_then_first_prompt_line() {
        let with_native = SessionNotifyContext::new(
            "s1".into(),
            "pi".into(),
            "neeko".into(),
            Some("修复登录竞态".into()),
            "无关的 prompt",
        );
        assert_eq!(with_native.topic.as_deref(), Some("修复登录竞态"));

        // 原生标题为空白 = 无标题 → 回退 prompt 首个非空行（前导空行/缩进都跳过）。
        let fallback = SessionNotifyContext::new(
            "s1".into(),
            "pi".into(),
            "neeko".into(),
            Some("   ".into()),
            "\n\n   实现会话主题   \n第二行不该出现",
        );
        assert_eq!(fallback.topic.as_deref(), Some("实现会话主题"));

        // 两者都无 → None（核心域落空副标题，不回退成占位）。
        let none =
            SessionNotifyContext::new("s1".into(), "pi".into(), "neeko".into(), None, " \n ");
        assert_eq!(none.topic, None);
    }

    #[test]
    fn approval_prefers_title_then_prompt_then_tool() {
        let ev = StreamEvent::RequestApproval {
            session_id: "s1".into(),
            call_id: "c1".into(),
            tool: "bash".into(),
            title: "  ".into(),
            prompt: "run rm -rf dist?".into(),
            diff: None,
            cmd: None,
        };
        let sig = project(&ev, &ctx("pi")).unwrap();
        assert_eq!(sig.class, NotificationClass::ActionRequired);
        assert_eq!(sig.event_key, event_keys::APPROVAL_REQUESTED);
        assert_eq!(sig.detail.as_deref(), Some("run rm -rf dist?"));
        // 来源数据透传（核心域据此节流/回流/文案，但不分支）
        assert_eq!(sig.source.domain, "agent");
        assert_eq!(sig.source.instance_id, "s1");
        assert_eq!(sig.source.origin_label, "pi");
        assert_eq!(sig.source.group_label, "neeko");
    }

    #[test]
    fn user_input_carries_prompt() {
        let ev = StreamEvent::UserInput {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            prompt: "which env?".into(),
            options: vec![],
        };
        let sig = project(&ev, &ctx("opencode")).unwrap();
        assert_eq!(sig.class, NotificationClass::ActionRequired);
        assert_eq!(sig.event_key, event_keys::INPUT_REQUESTED);
        assert_eq!(sig.detail.as_deref(), Some("which env?"));
    }

    /// TurnEnd{completed} 与 SessionDone{completed} 投影到同一 event_key —— 核心域合并的前提。
    #[test]
    fn completed_turn_and_done_share_event_key_for_merge() {
        let turn = StreamEvent::TurnEnd {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            reason: TurnEndReason::Completed,
        };
        let done = StreamEvent::SessionDone {
            session_id: "s1".into(),
            reason: DoneReason::Completed,
        };
        let a = project(&turn, &ctx("pi")).unwrap();
        let b = project(&done, &ctx("pi")).unwrap();
        assert_eq!(a.event_key, b.event_key);
        assert_eq!(a.class, NotificationClass::Completed);
    }

    #[test]
    fn user_initiated_stop_and_cancel_never_notify() {
        let stopped = StreamEvent::TurnEnd {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            reason: TurnEndReason::Stopped,
        };
        let cancelled = StreamEvent::SessionDone {
            session_id: "s1".into(),
            reason: DoneReason::Cancelled,
        };
        assert!(project(&stopped, &ctx("pi")).is_none());
        assert!(project(&cancelled, &ctx("pi")).is_none());
    }

    #[test]
    fn errors_project_to_failed_with_message() {
        let ev = StreamEvent::Error {
            session_id: "s1".into(),
            kind: crate::agent::chat::events::ErrorKind::Transport,
            code: "E_IO".into(),
            message: "connection reset".into(),
        };
        let sig = project(&ev, &ctx("pi")).unwrap();
        assert_eq!(sig.class, NotificationClass::Failed);
        assert_eq!(sig.event_key, event_keys::SESSION_FAILED);
        assert_eq!(sig.detail.as_deref(), Some("connection reset"));

        let done_err = StreamEvent::SessionDone {
            session_id: "s1".into(),
            reason: DoneReason::Error,
        };
        let sig2 = project(&done_err, &ctx("pi")).unwrap();
        assert_eq!(sig2.class, NotificationClass::Failed);
        assert_eq!(sig2.detail, None); // 核心域落类别兜底文案
    }

    #[test]
    fn high_frequency_events_are_ignored() {
        let delta = StreamEvent::TextDelta {
            session_id: "s1".into(),
            delta: "tok".into(),
        };
        let tool = StreamEvent::ToolStart {
            session_id: "s1".into(),
            call_id: "c1".into(),
            name: "read_file".into(),
            title: "a.rs".into(),
        };
        assert!(project(&delta, &ctx("pi")).is_none());
        assert!(project(&tool, &ctx("pi")).is_none());
    }

    #[test]
    fn whitespace_detail_normalized_to_none() {
        let ev = StreamEvent::UserInput {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            prompt: "   ".into(),
            options: vec![],
        };
        assert_eq!(project(&ev, &ctx("pi")).unwrap().detail, None);
    }

    /// 生命周期闭环：SessionDone（含 cancelled，不通知但仍需回收）= terminal。
    #[test]
    fn session_done_is_terminal_for_memory_release() {
        assert!(is_session_terminal(&StreamEvent::SessionDone {
            session_id: "s1".into(),
            reason: DoneReason::Cancelled
        }));
        assert!(!is_session_terminal(&StreamEvent::TurnEnd {
            session_id: "s1".into(),
            turn_id: "t1".into(),
            reason: TurnEndReason::Completed,
        }));
    }

    /// `event_keys` ↔ 前端设置清单（`src/shared/types/notification.ts` `NOTIFIABLE_EVENTS`）
    /// 双端同源：后端改名必须同改前端行，否则设置覆盖键与节流键静默漂移（红线 5 精神）。
    #[test]
    fn event_keys_match_frontend_notifiable_events_mirror() {
        const FRONTEND: &str = include_str!("../../../../src/shared/types/notification.ts");
        for key in [
            event_keys::APPROVAL_REQUESTED,
            event_keys::INPUT_REQUESTED,
            event_keys::TURN_COMPLETED,
            event_keys::SESSION_FAILED,
        ] {
            let needle = format!("agent.{key}");
            assert!(
                FRONTEND.contains(&needle),
                "前端 NOTIFIABLE_EVENTS 缺少事件键 {needle}（双端必须同步）"
            );
        }
        // `NotificationDraft` 字段镜像：Rust 侧加字段而前端漏镜像 = 该字段静默丢失
        // （serde 反序列化只取 TS 声明里有的键；subtitle 缺失曾让主题整条链断在 IPC 边界）。
        for field in ["title", "subtitle", "body", "class", "deep_link"] {
            assert!(
                FRONTEND.contains(&format!("{field}:")),
                "前端 NotificationDraft 镜像缺少字段 {field}"
            );
        }
    }
}
