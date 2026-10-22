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
            reason: settled_reason(ev),
        }]),

        // `turn_end` 可能携带**失败**：上游 API 报错时 `message.stopReason == "error"`
        // 且 `content` 为空 —— pi 不发独立的 error 事件，失败信息只在这里。
        // 静默丢弃它 = 「发消息零输出零提示」（2026-10-22 实测）。
        "turn_end" => match ev
            .get("message")
            .and_then(|m| m.get("stopReason"))
            .and_then(Value::as_str)
        {
            Some("error") => Translation::events(vec![StreamEvent::Error {
                session_id: session_id.into(),
                kind: crate::agent::chat::events::ErrorKind::Agent,
                code: "E_TURN_FAILED".into(),
                // `errorMessage` 是 pi 1.4.0 携带失败详情的字段（实测）：
                // `403: {"type":"FreeTierError","message":"OpenCode's free tier …"}`
                // —— 上游 HTTP 状态 + 错误体原文。没有它用户只看到
                //「model call failed」，还得自己去翻 ~/.pi/free.log。
                // 兜底再拼 provider/model：errorMessage 缺失时（旧版 pi）仍可定位。
                message: {
                    let detail = ev
                        .pointer("/message/errorMessage")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if detail.is_empty() {
                        format!(
                            "model call failed (provider: {}, model: {})",
                            ev.pointer("/message/provider")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown"),
                            ev.pointer("/message/model")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown"),
                        )
                    } else {
                        detail.to_string()
                    }
                },
            }]),
            _ => {
                log::debug!("[pi-rpc] lifecycle event: turn_end");
                Translation::events(Vec::new())
            }
        },

        // 其余生命周期事件不产生输出，但**不是错误** —— 记 debug 便于排查时序。
        "agent_start"
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

/// `agent_settled` 的**结束原因**（与 `turn_end` 的失败判据正交）。
///
/// # 为什么必须区分 `aborted`
///
/// `agent_settled` 是**唯一的**回合终止信号，因此它的 `reason` 会一路决定用户
/// 看到什么：
///
/// | 载荷 | 正确 reason | 不区分的后果 |
/// | --- | --- | --- |
/// | `{aborted: true}`（用户点停止） | `Stopped` | 发「任务完成」通知 —— `notify.rs` 的
///   `TurnEndReason::Stopped => return None` 分支在 pi 上永不可达 |
/// | `{aborted: false}` | `Completed` | 同上 |
/// | 字段缺失（旧版 pi / 我方向 `abort` 后进程未回包） | `Stopped` | 保守取「被叫停」：
///   宁可少一条完成通知，也不要给用户谎报成功 |
///
/// `aborted` 字段实测存在（`{"type":"agent_settled","aborted":false}`）。缺失时
/// 不能假定 `Completed` —— 那是「用缺省值宣布成功」，属最坏的一类默认值。
fn settled_reason(ev: &Value) -> TurnEndReason {
    match ev.get("aborted").and_then(Value::as_bool) {
        Some(false) => TurnEndReason::Completed,
        Some(true) => TurnEndReason::Stopped,
        // 缺失/非布尔：无法证明是正常完成 → 按「非正常完成」处理（不发完成通知）。
        None => TurnEndReason::Stopped,
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
/// `title` 优先取 `args.command`（bash 的实际命令）：只填工具名时，工具执行
/// **中**的卡片是空的 —— 前端 `extractCommand` 的输出回显兜底要等
/// `tool_execution_end` 才有材料（2026-10-22 实测截图：光秃秃的 "$ bash"）。
///
/// 其余工具（read/edit）的 args 字段名不统一（`path` 等）—— 没有可提取的
/// 命令时回落到工具名，具体参数由 `ToolOutput` 的流式输出呈现。
fn translate_tool_start(session_id: &str, ev: &Value) -> Vec<StreamEvent> {
    let Some(call_id) = ev.get("toolCallId").and_then(Value::as_str) else {
        // 没有 id 就无法与后续 update/end 关联 —— 发了也是孤儿事件。
        return Vec::new();
    };
    let name = ev.get("toolName").and_then(Value::as_str).unwrap_or("tool");
    let title = ev
        .pointer("/args/command")
        .and_then(Value::as_str)
        .unwrap_or(name);
    vec![StreamEvent::ToolStart {
        session_id: session_id.into(),
        call_id: call_id.into(),
        name: name.into(),
        title: title.into(),
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

#[cfg(test)]
mod real_protocol_probe {
    use super::*;

    /// pi 1.4.0 实测的真实事件序列（2026-10-22 探针捕获）。
    fn real_pi_1_4_sequence() -> Vec<serde_json::Value> {
        vec![
            serde_json::json!({"type":"agent_start"}),
            serde_json::json!({"type":"turn_start"}),
            serde_json::json!({"type":"message_start","message":{"role":"system"}}),
            serde_json::json!({"type":"message_end","message":{"role":"system"}}),
            serde_json::json!({"type":"message_start","message":{"role":"user"}}),
            serde_json::json!({"type":"message_end","message":{"role":"user"}}),
            serde_json::json!({"type":"message_start","message":{"role":"assistant"}}),
            serde_json::json!({"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":0}}),
            serde_json::json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello,"}}),
            serde_json::json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" world!"}}),
            serde_json::json!({"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello, world!"}}),
            serde_json::json!({"type":"message_end","message":{"role":"assistant"}}),
            serde_json::json!({"type":"entry_appended","entry":{}}),
            serde_json::json!({"type":"turn_end"}),
            serde_json::json!({"type":"agent_end"}),
            serde_json::json!({"type":"agent_settled","aborted":false}),
        ]
    }

    /// **上游失败必须产出 Error 事件，不许静默。**
    ///
    /// 2026-10-22 事故：用户选 `big-pickle`（opencode provider），上游调用失败
    ///（`success:false, tokens:0`），pi 发出的 `turn_end.message.stopReason == "error"`。
    /// 旧实现把 `turn_end` 归为「静默生命周期事件」—— 前端收到回合结束、
    /// 界面却零输出零错误。**失败必须可见**：哪怕是错的输出也要输出。
    #[test]
    fn turn_end_with_error_stop_reason_must_surface() {
        let ev = serde_json::json!({
            "type": "turn_end",
            "message": {
                "role": "assistant",
                "content": [],
                "provider": "opencode",
                "model": "big-pickle",
                "stopReason": "error"
            }
        });
        let t = translate("s1", &ev);
        assert!(
            t.events
                .iter()
                .any(|e| matches!(e, StreamEvent::Error { .. })),
            "turn_end with stopReason=error must produce an Error event, got: {:?}",
            t.events
        );
    }

    /// **失败详情（`errorMessage`）必须原样透传。**
    ///
    /// 实测 pi 1.4.0：`big-pickle` 上游 403 时 `turn_end.message.errorMessage` 是
    /// `403: {"type":"FreeTierError","message":"OpenCode's free tier can only be
    /// used from within OpenCode. …"}`。只报 provider/model 等于让用户自己翻
    /// `~/.pi/free.log` —— 那是 2026-10-22 事故里定位慢的直接原因。
    #[test]
    fn turn_end_error_message_is_passed_through_verbatim() {
        let ev = serde_json::json!({
            "type": "turn_end",
            "message": {
                "role": "assistant",
                "content": [],
                "provider": "opencode",
                "model": "big-pickle",
                "stopReason": "error",
                "errorMessage": "403: {\"type\":\"FreeTierError\",\"message\":\"OpenCode's free tier can only be used from within OpenCode.\"}"
            }
        });
        let t = translate("s1", &ev);
        let msg = t
            .events
            .iter()
            .find_map(|e| match e {
                StreamEvent::Error { message, .. } => Some(message.clone()),
                _ => None,
            })
            .expect("must produce an Error event");
        assert!(msg.starts_with("403:"));
        assert!(msg.contains("FreeTierError"));
        // 原文透传：不是「我们拼的」格式（那会丢掉上游状态码与错误体）
        assert!(!msg.starts_with("model call failed"));
    }

    /// `errorMessage` 缺失（旧版 pi / 网络中断）→ 回落到 provider/model 定位串。
    #[test]
    fn turn_end_error_without_detail_falls_back_to_model_identity() {
        let ev = serde_json::json!({
            "type": "turn_end",
            "message": {
                "role": "assistant",
                "content": [],
                "provider": "opencode",
                "model": "big-pickle",
                "stopReason": "error"
            }
        });
        let t = translate("s1", &ev);
        let msg = t
            .events
            .iter()
            .find_map(|e| match e {
                StreamEvent::Error { message, .. } => Some(message.clone()),
                _ => None,
            })
            .expect("must produce an Error event");
        assert!(msg.contains("opencode"));
        assert!(msg.contains("big-pickle"));
    }

    /// 正常完成的 `turn_end` 不产出 Error（回归保护）。
    #[test]
    fn turn_end_with_normal_stop_reason_produces_no_error() {
        let ev = serde_json::json!({
            "type": "turn_end",
            "message": {"role": "assistant", "content": [], "stopReason": "stop"}
        });
        let t = translate("s1", &ev);
        assert!(!t
            .events
            .iter()
            .any(|e| matches!(e, StreamEvent::Error { .. })));
    }

    /// **用户点停止必须翻译成 `Stopped`，不能是 `Completed`。**
    ///
    /// `agent_settled` 是唯一的回合终止信号，它的 `reason` 直接决定通知类别：
    /// `notify.rs` 对 `TurnEndReason::Stopped` 明确 `return None`（用户自己点的
    /// 停止不该发通知），而对 `Completed` 发「任务完成」。
    ///
    /// 不区分 `aborted` 时：用户点停止 → 「任务完成」通知，且那条
    /// `Stopped => return None` 分支在 pi 传输上**永不可达**。
    ///
    /// 变异验证：把 `settled_reason` 写死成 `Completed` → 本用例变红。
    #[test]
    fn agent_settled_aborted_maps_to_stopped_not_completed() {
        let aborted = serde_json::json!({"type":"agent_settled","aborted":true});
        let t = translate("s1", &aborted);
        match t.events.first() {
            Some(StreamEvent::TurnEnd { reason, .. }) => {
                assert_eq!(
                    *reason,
                    TurnEndReason::Stopped,
                    "用户主动停止不得报成「任务完成」（会发完成通知）"
                );
            }
            other => panic!("expected TurnEnd, got {other:?}"),
        }
    }

    /// `aborted: false` = 正常完成。
    #[test]
    fn agent_settled_not_aborted_maps_to_completed() {
        let ev = serde_json::json!({"type":"agent_settled","aborted":false});
        match translate("s1", &ev).events.first() {
            Some(StreamEvent::TurnEnd { reason, .. }) => {
                assert_eq!(*reason, TurnEndReason::Completed);
            }
            other => panic!("expected TurnEnd, got {other:?}"),
        }
    }

    /// **`aborted` 缺失时不得假定成功。**
    ///
    /// 旧版 pi / 进程被 dispose 后回包不完整时字段可能缺失。默认成 `Completed`
    /// 等于「用缺省值宣布成功」—— 宁可少一条完成通知，也不要给用户谎报。
    #[test]
    fn agent_settled_without_aborted_field_defaults_to_stopped() {
        let ev = serde_json::json!({"type":"agent_settled"});
        match translate("s1", &ev).events.first() {
            Some(StreamEvent::TurnEnd { reason, .. }) => {
                assert_eq!(*reason, TurnEndReason::Stopped);
            }
            other => panic!("expected TurnEnd, got {other:?}"),
        }
    }

    /// **工具开始事件必须带上可读的 title（实际命令），不能只给工具名。**
    ///
    /// 实测 pi 1.4.0：`tool_execution_start.args.command` 是实际要执行的命令
    ///（如 `env | grep -i '^PI_' | sort`）。只填工具名（`bash`）时，工具执行**中**
    /// 卡片是空的 —— 前端 `extractCommand` 的输出回显兜底要等 `tool_execution_end`
    /// 才有材料，运行期间用户看到的就是一个光秃秃的 "$ bash"（2026-10-22 实测截图）。
    #[test]
    fn tool_start_carries_the_command_as_title() {
        let ev = serde_json::json!({
            "type": "tool_execution_start",
            "toolCallId": "call_01",
            "toolName": "bash",
            "args": {"command": "env | grep -i '^PI_' | sort"}
        });
        let t = translate("s1", &ev);
        match t.events.first() {
            Some(StreamEvent::ToolStart { title, .. }) => {
                assert_eq!(title, "env | grep -i '^PI_' | sort");
            }
            other => panic!("expected ToolStart with command title, got {other:?}"),
        }
    }

    /// 非 bash 工具（read/edit）的 args 字段名不同 —— 没有可提取的命令时
    /// 回落到工具名，不 panic。
    #[test]
    fn tool_start_without_command_arg_falls_back_to_tool_name() {
        let ev = serde_json::json!({
            "type": "tool_execution_start",
            "toolCallId": "call_02",
            "toolName": "read",
            "args": {"path": "/tmp/x.rs"}
        });
        let t = translate("s1", &ev);
        match t.events.first() {
            Some(StreamEvent::ToolStart { title, .. }) => {
                assert_eq!(title, "read");
            }
            other => panic!("expected ToolStart fallback title, got {other:?}"),
        }
    }

    /// **实测 pi 1.4.0 的真实事件序列必须产出文本。**
    ///
    /// 2026-10-22 事故：Agent Chat 里发消息后 assistant 完全没有输出，
    /// 连错误都没有。日志显示事件都到了（`message_start` / `message_end` /
    /// `entry_appended` 被记为 unmapped），但界面空白。
    #[test]
    fn real_pi_sequence_produces_text() {
        let events: Vec<StreamEvent> = real_pi_1_4_sequence()
            .iter()
            .flat_map(|ev| translate("s1", ev).events)
            .collect();
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::TextDelta { delta, .. } => Some(delta.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "Hello, world!");
    }
}
