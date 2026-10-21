//! Pi rpc 事件 → [`StreamEvent`] 的翻译。
//!
//! # 纯函数
//!
//! 输入是一条已经解析好的 JSON 值 + session id，输出零或多个事件。不持有状态、
//! 不做 I/O —— 这是本模块能被密集单测覆盖的原因，也是「事件序列」这类时序 bug
//! 唯一可靠的验证手段（见文件末的压缩场景用例）。

use serde_json::Value;

use crate::agent::chat::events::{StreamEvent, TurnEndReason};

/// 一次翻译的完整产出。
///
/// 除了事件，还可能附带「回写一条审批时需要知道什么」。形状与事件**必须同源**
/// —— 分成两个函数各自解析 `extension_ui_request` 的话，一处改了另一处不会报错。
pub struct Translation {
    /// 给前端的事件（可能为空）。
    pub events: Vec<StreamEvent>,
    /// 若是审批请求，记下 `(request_id, 回答形状)` 供 `Approve` 回写时查。
    pub approval: Option<(String, ApprovalKind)>,
}

impl Translation {
    /// 只有事件、没有审批。
    const fn events(events: Vec<StreamEvent>) -> Self {
        Self {
            events,
            approval: None,
        }
    }
}

/// 翻译一条 pi 事件。
///
/// 返回**序列**而不是 `Option`：一条 pi 事件可能产出多个 Neeko 事件，而更重要的
/// 是「某些事件不产出事件但必须被看见」（见 `agent_settled` 的注释）。
#[must_use]
pub fn translate(session_id: &str, ev: &Value) -> Translation {
    let Some(kind) = ev.get("type").and_then(Value::as_str) else {
        return Translation::events(Vec::new());
    };

    match kind {
        // ── 消息流 ────────────────────────────────────────────────────────
        "message_update" => Translation::events(translate_message_update(session_id, ev)),

        // ── 工具调用 ──────────────────────────────────────────────────────
        "tool_execution_start" => Translation::events(translate_tool_start(session_id, ev)),
        "tool_execution_update" => Translation::events(translate_tool_update(session_id, ev)),
        "tool_execution_end" => Translation::events(translate_tool_end(session_id, ev)),

        // ── 生命周期：终止判据在 `agent_settled` ──────────────────────────
        //
        // pi 一次用户 prompt 可能发出**多个** `turn_end` / `agent_end`
        //（自动重试、上下文压缩、队列续跑都会各发一次）。把其中任何一个当作
        // 回合结束，都会让后续输出被当成「回合外」而丢掉。
        //
        // 唯一的终止信号是 `agent_settled`。
        "agent_settled" => Translation::events(vec![StreamEvent::TurnEnd {
            session_id: session_id.into(),
            turn_id: String::new(),
            reason: TurnEndReason::Completed,
        }]),

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
            Translation::events(Vec::new())
        }

        // `extension_ui_request` 承载**两种完全不同的东西**：扩展的 UI 渲染
        //（`notify` / `setWidget` / `setStatus`，启动时就来）与真正的用户交互
        //（`select` / `confirm`，工具要进行危险操作时的审批）。共用一个 `type`，
        // 必须按 `method` 分派 —— 一律当审批会让用户每次开 Chat 都看到一串弹窗。
        "extension_ui_request" => translate_ui_request(session_id, ev),

        // 工具事件与其它未识别事件：原样记日志，二期按需补映射。
        other => {
            log::debug!("[pi-rpc] unmapped event type: {other}");
            Translation::events(Vec::new())
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

/// 工具开始。
///
/// `title` 取 `toolName`：pi 的 `args` 里可能带路径或命令，但字段名不统一
///（`bash` 用 `command`、`read`/`edit` 用 `path`），这里不逐个猜 —— 前端拿
/// `name` 已经能显示「正在用 bash」，具体参数由 `ToolOutput` 的流式输出呈现。
fn translate_tool_start(session_id: &str, ev: &Value) -> Vec<StreamEvent> {
    let Some(call_id) = ev.get("toolCallId").and_then(Value::as_str) else {
        // 没有 id 就无法与后续 update/end 关联 —— 发了也是孤儿事件。
        return Vec::new();
    };
    let name = ev.get("toolName").and_then(Value::as_str).unwrap_or("tool");
    vec![StreamEvent::ToolStart {
        session_id: session_id.into(),
        call_id: call_id.into(),
        name: name.into(),
        title: name.into(),
    }]
}

/// 工具进行中的增量输出。
fn translate_tool_update(session_id: &str, ev: &Value) -> Vec<StreamEvent> {
    let Some(call_id) = ev.get("toolCallId").and_then(Value::as_str) else {
        return Vec::new();
    };
    let chunk = result_to_text(ev.get("partialResult"));
    if chunk.is_empty() {
        return Vec::new();
    }
    vec![StreamEvent::ToolOutput {
        session_id: session_id.into(),
        call_id: call_id.into(),
        output: chunk,
    }]
}

/// 工具结束。`ToolEnd` 只带状态 —— 最终输出在 `tool_execution_end` 的
/// `result` 里，与 update 同样走 `ToolOutput` 交付（前端按 call_id 累积）。
fn translate_tool_end(session_id: &str, ev: &Value) -> Vec<StreamEvent> {
    let Some(call_id) = ev.get("toolCallId").and_then(Value::as_str) else {
        return Vec::new();
    };
    let failed = ev.get("isError").and_then(Value::as_bool).unwrap_or(false);

    let mut out = Vec::with_capacity(2);
    // 结束时的 result 是**最终输出**，不能因为已经有增量就丢掉它 ——
    // `tool_execution_update` 可能一条都没发（快速完成的工具）。
    let final_text = result_to_text(ev.get("result"));
    if !final_text.is_empty() {
        out.push(StreamEvent::ToolOutput {
            session_id: session_id.into(),
            call_id: call_id.into(),
            output: final_text,
        });
    }
    out.push(StreamEvent::ToolEnd {
        session_id: session_id.into(),
        call_id: call_id.into(),
        status: if failed {
            "failed".into()
        } else {
            "done".into()
        },
    });
    out
}

/// 从工具结果里取可读文本。
///
/// pi 的 result 形状不统一（`content[]` / `details.stdout` / `stdout` / `diff`），
/// 这里按**信息量从高到低**取第一个非空的，而不是全都拼起来 —— 拼起来会产生
/// 重复内容（`details.stdout` 往往就是 `stdout`）。
fn result_to_text(value: Option<&Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    if let Some(text) = value.as_str() {
        return text.to_string();
    }

    let details = value.get("details");

    // 结构化 diff 优先：它是工具变更的精确描述。
    for holder in [Some(value), details].into_iter().flatten() {
        if let Some(diff) = holder.get("diff").and_then(Value::as_str) {
            if !diff.trim().is_empty() {
                return diff.to_string();
            }
        }
    }
    // 文本块数组。
    if let Some(items) = value.get("content").and_then(Value::as_array) {
        let joined: String = items
            .iter()
            .filter_map(|c| {
                (c.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| c.get("text").and_then(Value::as_str))
                    .flatten()
            })
            .collect();
        if !joined.is_empty() {
            return joined;
        }
    }
    // 命令类工具的 stdout / stderr。
    for holder in [Some(value), details].into_iter().flatten() {
        for key in ["stdout", "output", "stderr"] {
            if let Some(text) = holder.get(key).and_then(Value::as_str) {
                if !text.is_empty() {
                    return text.to_string();
                }
            }
        }
    }
    String::new()
}

/// 用户交互请求 → 审批。
///
/// 只有 `select` / `confirm` 是真的在等人做决定；其余 `method`
///（`notify` / `setWidget` / `setStatus` / `input` / `editor`）不是审批，
/// 一律不映射。`input` / `editor` 需要文本输入，Neeko 的 `RequestApproval`
/// 表达不了，乱映射会让用户看到「是/否」两个按钮却要输文本。
/// 审批的形状 —— 决定回写时用哪组字段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalKind {
    /// `confirm`：回 `{ confirmed: bool }`。
    Confirm,
    /// `select`：回 `{ value: "<选项>" }`；`first_option` 是「允许」时选中的项。
    Select {
        /// 列表第一项（多选一里最接近「允许」的那个）。
        first_option: String,
    },
}

fn translate_ui_request(session_id: &str, ev: &Value) -> Translation {
    let method = ev.get("method").and_then(Value::as_str).unwrap_or("?");
    let Some(id) = ev.get("id").and_then(Value::as_str) else {
        return Translation::events(Vec::new());
    };

    let (title, prompt, tool, answer_kind) = match method {
        "select" => {
            let options: Vec<String> = ev
                .get("options")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|o| o.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let Some(first) = options.first().cloned() else {
                // 没有选项的选择题无法回答 —— 不产生审批。
                return Translation::events(Vec::new());
            };
            (
                ev.get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Permission required")
                    .to_string(),
                format!("Pi is asking: {}", options.join(" / ")),
                "pi.select".to_string(),
                ApprovalKind::Select {
                    first_option: first,
                },
            )
        }
        "confirm" => {
            let message = ev
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Confirm this action?");
            (
                ev.get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Confirmation required")
                    .to_string(),
                message.to_string(),
                "pi.confirm".to_string(),
                ApprovalKind::Confirm,
            )
        }
        other => {
            log::debug!("[pi-rpc] extension_ui_request method={other} is not an approval");
            return Translation::events(Vec::new());
        }
    };

    let event = StreamEvent::RequestApproval {
        session_id: session_id.into(),
        // pi 的请求 id 直接当作 Neeko 的 call_id —— `Approve { call_id }`
        // 回写时无需额外映射表（`extension_ui_response` 要的就是这个 id）。
        call_id: id.into(),
        tool,
        title,
        prompt,
        diff: None,
        cmd: None,
    };
    Translation {
        events: vec![event],
        approval: Some((id.to_string(), answer_kind)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 只取事件（大多数用例不关心审批形状）。
    fn evs(session_id: &str, v: &Value) -> Vec<StreamEvent> {
        translate(session_id, v).events
    }

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
        let out = evs("s1", &ev);
        assert_eq!(kinds(&out), ["text"]);
        assert!(matches!(&out[0], StreamEvent::TextDelta { delta, .. } if delta == "hello"));
    }

    #[test]
    fn thinking_delta_becomes_reasoning_event() {
        let ev = json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "thinking_delta", "delta": "hmm" }
        });
        assert_eq!(kinds(&evs("s1", &ev)), ["reasoning"]);
    }

    /// 空 delta 不产生事件 —— 否则前端会收到一串空串增量。
    #[test]
    fn empty_delta_is_dropped() {
        let ev = json!({
            "type": "message_update",
            "assistantMessageEvent": { "type": "text_delta", "delta": "" }
        });
        assert!(evs("s1", &ev).is_empty());
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
            emitted.extend(kinds(&evs("s1", ev)));
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
            evs("s1", &ev).is_empty(),
            "扩展的 widget/status 请求不是工具审批"
        );
    }

    // ── 工具调用 ──────────────────────────────────────────────────────

    #[test]
    fn tool_start_carries_call_id_and_name() {
        let ev = json!({"type": "tool_execution_start",
                        "toolCallId": "tc1", "toolName": "bash", "args": {"command": "ls"}});
        let out = evs("s1", &ev);
        assert!(
            matches!(&out[0], StreamEvent::ToolStart { call_id, name, .. }
                     if call_id == "tc1" && name == "bash")
        );
    }

    /// 没有 `toolCallId` 的工具事件无法与后续 update/end 关联 ——
    /// 发出去只会是孤儿，前端无法更新对应那一行。
    #[test]
    fn tool_event_without_call_id_is_dropped() {
        let ev = json!({"type": "tool_execution_start", "toolName": "bash"});
        assert!(evs("s1", &ev).is_empty());
    }

    #[test]
    fn tool_update_emits_incremental_output() {
        let ev = json!({"type": "tool_execution_update", "toolCallId": "tc1",
                        "partialResult": {"stdout": "line1\n"}});
        assert!(
            matches!(&evs("s1", &ev)[0], StreamEvent::ToolOutput { output, .. } if output == "line1\n")
        );
    }

    /// 结束事件必须**先交付最终输出再报状态** —— 顺序反了前端会先关掉
    /// 那一行再收到内容，表现为「输出丢失」。
    #[test]
    fn tool_end_delivers_final_output_before_status() {
        let ev = json!({"type": "tool_execution_end", "toolCallId": "tc1",
                        "result": {"stdout": "done"}, "isError": false});
        let out = evs("s1", &ev);
        assert_eq!(kinds(&out).len(), 2);
        assert!(matches!(&out[0], StreamEvent::ToolOutput { output, .. } if output == "done"));
        assert!(matches!(&out[1], StreamEvent::ToolEnd { status, .. } if status == "done"));
    }

    #[test]
    fn tool_end_reports_failure() {
        let ev = json!({"type": "tool_execution_end", "toolCallId": "tc1",
                        "result": {"stderr": "boom"}, "isError": true});
        let out = evs("s1", &ev);
        assert!(
            matches!(out.last().unwrap(), StreamEvent::ToolEnd { status, .. } if status == "failed")
        );
    }

    /// 结构化 diff 优先于 stdout —— 它是文件变更的精确描述。
    #[test]
    fn structured_diff_wins_over_plain_stdout() {
        let ev = json!({"type": "tool_execution_end", "toolCallId": "tc1",
                        "result": {"details": {"diff": "--- a\n+++ b\n", "stdout": "ok"}}});
        let out = evs("s1", &ev);
        assert!(
            matches!(&out[0], StreamEvent::ToolOutput { output, .. } if output.contains("+++ b"))
        );
    }

    // ── 审批 ──────────────────────────────────────────────────────────

    /// `confirm` 是是/非问句 → 映射成审批，形状为 Confirm。
    #[test]
    fn confirm_request_becomes_approval() {
        let ev = json!({"type": "extension_ui_request", "id": "r1", "method": "confirm",
                        "title": "Run command?", "message": "rm -rf /tmp/x"});
        let t = translate("s1", &ev);
        assert!(
            matches!(&t.events[0], StreamEvent::RequestApproval { call_id, prompt, .. }
                         if call_id == "r1" && prompt == "rm -rf /tmp/x")
        );
        assert_eq!(t.approval, Some(("r1".into(), ApprovalKind::Confirm)));
    }

    /// `select` 的选项列表 → 审批；第一项作为「允许」的回写值。
    #[test]
    fn select_request_becomes_approval_with_first_option() {
        let ev = json!({"type": "extension_ui_request", "id": "r2", "method": "select",
                        "title": "Pick", "options": ["Allow once", "Deny"]});
        let t = translate("s1", &ev);
        assert!(
            matches!(&t.events[0], StreamEvent::RequestApproval { call_id, .. } if call_id == "r2")
        );
        assert_eq!(
            t.approval,
            Some((
                "r2".into(),
                ApprovalKind::Select {
                    first_option: "Allow once".into()
                }
            ))
        );
    }

    /// 没有选项的 `select` 无法回答 —— 不产生审批，否则前端给一个点不动的弹窗。
    #[test]
    fn select_without_options_is_not_an_approval() {
        let ev = json!({"type": "extension_ui_request", "id": "r3",
                        "method": "select", "options": []});
        let t = translate("s1", &ev);
        assert!(t.events.is_empty());
        assert!(t.approval.is_none());
    }

    /// `input` / `editor` 需要文本输入，`RequestApproval` 表达不了 ——
    /// 硬映射会让用户看到「是/否」却要输文本。
    #[test]
    fn text_input_requests_are_not_approvals() {
        for method in ["input", "editor", "notify", "setWidget", "setStatus"] {
            let ev = json!({"type": "extension_ui_request", "id": "r4", "method": method});
            let t = translate("s1", &ev);
            assert!(t.events.is_empty(), "{method} must not become an approval");
            assert!(t.approval.is_none());
        }
    }

    #[test]
    fn unknown_and_malformed_events_do_not_panic() {
        assert!(evs("s1", &json!({"type": "totally-new"})).is_empty());
        assert!(evs("s1", &json!({})).is_empty());
        assert!(evs("s1", &json!("not-an-object")).is_empty());
    }
}
