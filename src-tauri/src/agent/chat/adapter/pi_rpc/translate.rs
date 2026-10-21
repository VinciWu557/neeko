//! Pi rpc 事件 → [`StreamEvent`] 的翻译。
//!
//! # 纯函数
//!
//! 输入是一条已经解析好的 JSON 值 + session id，输出零或多个事件。不持有状态、
//! 不做 I/O —— 这是本模块能被密集单测覆盖的原因，也是「事件序列」这类时序 bug
//! 唯一可靠的验证手段（见文件末的压缩场景用例）。

use serde_json::Value;

use crate::agent::chat::events::{StreamEvent, TurnEndReason};

/// 翻译一条 pi 事件。
///
/// 返回**序列**而不是 `Option`：一条 pi 事件可能产出多个 Neeko 事件，而更重要的
/// 是「某些事件不产出事件但必须被看见」（见 `agent_settled` 的注释）。
#[must_use]
pub fn translate(session_id: &str, ev: &Value) -> Vec<StreamEvent> {
    let Some(kind) = ev.get("type").and_then(Value::as_str) else {
        return Vec::new();
    };

    match kind {
        // ── 消息流 ────────────────────────────────────────────────────────
        "message_update" => translate_message_update(session_id, ev),

        // ── 生命周期：终止判据在 `agent_settled` ──────────────────────────
        //
        // pi 一次用户 prompt 可能发出**多个** `turn_end` / `agent_end`
        //（自动重试、上下文压缩、队列续跑都会各发一次）。把其中任何一个当作
        // 回合结束，都会让后续输出被当成「回合外」而丢掉。
        //
        // 唯一的终止信号是 `agent_settled`。
        "agent_settled" => vec![StreamEvent::TurnEnd {
            session_id: session_id.into(),
            turn_id: String::new(),
            reason: TurnEndReason::Completed,
        }],

        // 其余生命周期事件不产生输出，但**不是错误** —— 记 debug 便于排查时序。
        "agent_start"
        | "turn_end"
        | "agent_end"
        | "session_info_changed"
        | "auto_retry_start"
        | "auto_retry_end"
        | "auto_compaction_start"
        | "auto_compaction_end"
        | "compaction" => {
            log::debug!("[pi-rpc] lifecycle event: {kind}");
            Vec::new()
        }

        // `extension_ui_request` 在**启动时**就会来（扩展的 widget / status 渲染），
        // 与工具审批共用同一个 `type`。一期不映射，二期按 `method` 分派 ——
        // 一律当审批会让用户看到一串莫名其妙的弹窗。
        "extension_ui_request" => {
            let method = ev.get("method").and_then(Value::as_str).unwrap_or("?");
            log::debug!("[pi-rpc] extension_ui_request method={method} (not mapped yet)");
            Vec::new()
        }

        // 工具事件与其它未识别事件：原样记日志，二期按需补映射。
        other => {
            log::debug!("[pi-rpc] unmapped event type: {other}");
            Vec::new()
        }
    }
}

/// `message_update` 的 `assistantMessageEvent` 判别。
fn translate_message_update(session_id: &str, ev: &Value) -> Vec<StreamEvent> {
    let Some(ame) = ev.get("assistantMessageEvent") else {
        return Vec::new();
    };
    let Some(kind) = ame.get("type").and_then(Value::as_str) else {
        return Vec::new();
    };
    let delta = ame.get("delta").and_then(Value::as_str).unwrap_or("");

    match kind {
        "text_delta" if !delta.is_empty() => vec![StreamEvent::TextDelta {
            session_id: session_id.into(),
            delta: delta.into(),
        }],
        "thinking_delta" if !delta.is_empty() => vec![StreamEvent::ReasoningDelta {
            session_id: session_id.into(),
            delta: delta.into(),
        }],
        // `toolcall_*` 一期不映射（二期接 ToolStart/Output/End）。
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn kinds(events: &[StreamEvent]) -> Vec<&'static str> {
        events
            .iter()
            .map(|e| match e {
                StreamEvent::TextDelta { .. } => "text",
                StreamEvent::ReasoningDelta { .. } => "reasoning",
                StreamEvent::TurnEnd { .. } => "turn_end",
                _ => "other",
            })
            .collect()
    }

    #[test]
    fn text_delta_becomes_text_event() {
        let ev = json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "text_delta", "delta": "hello" }
        });
        let out = translate("s1", &ev);
        assert_eq!(kinds(&out), ["text"]);
        assert!(matches!(&out[0], StreamEvent::TextDelta { delta, .. } if delta == "hello"));
    }

    #[test]
    fn thinking_delta_becomes_reasoning_event() {
        let ev = json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "thinking_delta", "delta": "hmm" }
        });
        assert_eq!(kinds(&translate("s1", &ev)), ["reasoning"]);
    }

    /// 空 delta 不产生事件 —— 否则前端会收到一串空串增量。
    #[test]
    fn empty_delta_is_dropped() {
        let ev = json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "text_delta", "delta": "" }
        });
        assert!(translate("s1", &ev).is_empty());
    }

    /// **本任务最重要的一条**：压缩/重试场景下 `agent_end` 会发多次，
    /// 只有 `agent_settled` 才是回合结束。
    ///
    /// 变异验证：把 translate 里的终止判据改成 `agent_end` → 本用例必须红。
    #[test]
    fn only_agent_settled_ends_the_turn() {
        let sequence = [
            json!({"type": "agent_start"}),
            json!({"type": "message_update",
                   "assistantMessageEvent": {"type": "text_delta", "delta": "a"}}),
            json!({"type": "agent_end"}), // ← 重试/压缩前的一次
            json!({"type": "auto_compaction_start"}),
            json!({"type": "auto_compaction_end"}),
            json!({"type": "message_update",
                   "assistantMessageEvent": {"type": "text_delta", "delta": "b"}}),
            json!({"type": "agent_end"}),     // ← 又一次，仍不是结束
            json!({"type": "agent_settled"}), // ← 真正的结束
        ];

        let mut emitted = Vec::new();
        for ev in &sequence {
            emitted.extend(kinds(&translate("s1", ev)));
        }

        // 两条文本增量必须在 TurnEnd **之前**全部产出
        assert_eq!(emitted, ["text", "text", "turn_end"]);
    }

    /// 启动时的 `extension_ui_request` 不得变成审批弹窗。
    #[test]
    fn extension_ui_request_is_not_an_approval() {
        let ev = json!({
            "type": "extension_ui_request",
            "id": "x",
            "method": "setWidget",
            "widgetKey": "btw"
        });
        assert!(
            translate("s1", &ev).is_empty(),
            "扩展的 widget/status 请求不是工具审批"
        );
    }

    #[test]
    fn unknown_and_malformed_events_do_not_panic() {
        assert!(translate("s1", &json!({"type": "totally-new"})).is_empty());
        assert!(translate("s1", &json!({})).is_empty());
        assert!(translate("s1", &json!("not-an-object")).is_empty());
    }
}
