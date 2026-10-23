use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use crate::agent::chat::events::{ErrorKind, StreamEvent, TodoItem, TurnEndReason};

// ── SSE event translation (pure, testable) ──────────────────────────────────

/// One SSE `data:` payload from `GET /event`.
///
/// # 两个协议的包络不同，这里统一成一个形状
///
/// | 版本 | 包络 |
/// | --- | --- |
/// | V1 | `{id, type, properties}` |
/// | V2 | `{id, created, type, location, data, durable}` |
///
/// `properties` 用 `#[serde(alias = "data")]` 承接：两者是「事件载荷」的同一个
/// 概念，只是名字不同。归一化放在反序列化这一层，翻译器与泵循环就**不需要**
/// 知道自己在读哪个版本的包络 —— 它们只消费「载荷对象」。
///
/// 注意 `alias` 在同时出现两个字段时以主名为准；两个协议不会同时发，所以无歧义。
#[derive(Debug, Deserialize)]
pub(super) struct ServeEvent {
    #[serde(rename = "type")]
    pub(super) event_type: String,
    #[serde(default, alias = "data")]
    pub(super) properties: serde_json::Value,
}

/// The kind of a streamed part, learned from `message.part.updated`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PartKind {
    Text,
    Reasoning,
    Tool,
}

/// 一轮结束时清理翻译状态。
///
/// # 为什么两版都需要（且必须是同一个语义）
///
/// `part_kinds`（V1）与 `tool_names` / `tool_started`（V2）都只描述**一轮内**
/// 的流式/工具生命周期。它们的有效期就是一轮：
///
/// | 状态 | 失效时机 |
/// | --- | --- |
/// | `part_kinds` | 该 part 的消息结束（= 回合结束） |
/// | `tool_names` / `tool_started` | 该工具调用结束（≤ 回合结束） |
///
/// 不清的后果两版相同：长会话里持续增长，且 `tool_started` 的**去重语义**
/// 会被跨轮污染（agent 若复用 callID，第二轮的同名工具静默丢 `ToolStart`）。
///
/// V1 实测：连续两轮的 `partID` 无重叠 —— 清空安全。
fn end_turn_state(part_kinds: &mut HashMap<String, PartKind>, tool_started: &mut HashSet<String>) {
    part_kinds.clear();
    tool_started.clear();
}

/// Translate one opencode serve SSE event into a [`StreamEvent`].
///
/// Pure (no IO): the caller owns the pump loop and the `part_kinds` /
/// `tool_started` state maps. `part_kinds` learns the type of a streamed
/// part; `tool_started` records callIDs that already emitted `ToolStart`
/// (opencode serve may emit `pending` *and* `running` for the same callID —
/// see `translate_tool`). Part type is learned from `message.part.updated`;
/// `message.part.delta` then uses it to distinguish text vs reasoning deltas
/// (both carry `field: "text"`). Unknown event types / foreign fields → `None`.
pub(super) fn translate_event(
    session_id: &str,
    event: &ServeEvent,
    part_kinds: &mut HashMap<String, PartKind>,
    tool_started: &mut HashSet<String>,
) -> Vec<StreamEvent> {
    let properties = &event.properties;
    match event.event_type.as_str() {
        "message.part.delta" => translate_part_delta(session_id, properties, part_kinds),
        "message.part.updated" => {
            translate_part_updated(session_id, properties, part_kinds, tool_started)
        }
        "permission.asked" => translate_permission_asked(session_id, properties),
        // opencode 的「等待用户行动」是**两个独立事件族**：permission（权限门）与
        // question（ask 类工具阻塞，`que_` id）。serve 侧同样会发 question.asked ——
        // 实测：serve 会话里模型调 question 工具后 `/question` 挂起待答。
        // 缺这一条 = 自有会话的提问既不显示内联面板、也不会产生任何通知。
        "question.asked" => translate_question_asked(session_id, properties),
        "todo.updated" => translate_todo_updated(session_id, properties),
        // 回合结束：清理**只在一轮内有效**的翻译状态。
        //
        // 实测（1.19.0，连续两轮）：`partID` / `callID` 跨轮**无重叠**，
        // 所以清空安全。不清的后果与 V2 相同：
        // - 长会话里持续增长；
        // - `tool_started` 是去重集合，跨轮累积后若 agent 复用 callID，
        //   第二轮的同名工具会被误判成「已发过」而静默丢掉 `ToolStart`。
        //
        // V1 的 `session.idle` 是唯一的正常收尾事件（`session.error` 之后
        // 仍会来一条 idle，见 `v1_session_error_uses_real_error_shape`）。
        "session.idle" => {
            end_turn_state(part_kinds, tool_started);
            vec![StreamEvent::TurnEnd {
                session_id: session_id.into(),
                turn_id: String::new(),
                reason: TurnEndReason::Completed,
            }]
        }
        "session.error" => {
            let message = properties
                .get("error")
                .and_then(|e| e.get("data"))
                .and_then(|d| d.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("opencode serve error");
            vec![StreamEvent::Error {
                session_id: session_id.into(),
                kind: ErrorKind::Agent,
                code: "E_AGENT".into(),
                message: message.into(),
            }]
        }
        // `session.updated` carries metadata only; session lifecycle events
        // (SessionStart/ContextInit) are emitted by the adapter itself.
        _ => Vec::new(),
    }
}

/// `message.part.delta` — the incremental streaming carrier. `field: "text"`
/// covers both text and reasoning parts; the part kind resolves which.
pub(super) fn translate_part_delta(
    session_id: &str,
    properties: &serde_json::Value,
    part_kinds: &HashMap<String, PartKind>,
) -> Vec<StreamEvent> {
    if properties.get("field").and_then(|v| v.as_str()) != Some("text") {
        return Vec::new();
    }
    let part_id = match properties.get("partID").and_then(|v| v.as_str()) {
        Some(id) => id,
        None => return Vec::new(),
    };
    let delta = match properties.get("delta").and_then(|v| v.as_str()) {
        Some(d) => d,
        None => return Vec::new(),
    };
    match part_kinds.get(part_id) {
        Some(PartKind::Reasoning) => vec![StreamEvent::ReasoningDelta {
            session_id: session_id.into(),
            delta: delta.into(),
        }],
        // Unknown parts default to text (safe for the rare delta-before-update race).
        _ => vec![StreamEvent::TextDelta {
            session_id: session_id.into(),
            delta: delta.into(),
        }],
    }
}

/// `message.part.updated` — part lifecycle / snapshots. Text and reasoning
/// parts only register their kind (deltas arrive separately); tool parts map
/// to `ToolStart` / `ToolEnd` from their state machine. `tool_started` is
/// threaded into `translate_tool` so it can suppress duplicate `ToolStart`
/// events for the same callID.
pub(super) fn translate_part_updated(
    session_id: &str,
    properties: &serde_json::Value,
    part_kinds: &mut HashMap<String, PartKind>,
    tool_started: &mut HashSet<String>,
) -> Vec<StreamEvent> {
    let part = match properties.get("part") {
        Some(p) => p,
        None => return Vec::new(),
    };
    let kind = match part.get("type").and_then(|v| v.as_str()) {
        Some("text") => PartKind::Text,
        Some("reasoning") => PartKind::Reasoning,
        Some("tool") => PartKind::Tool,
        _ => return Vec::new(),
    };
    if let Some(part_id) = part.get("id").and_then(|v| v.as_str()) {
        part_kinds.insert(part_id.to_string(), kind);
    }
    match kind {
        PartKind::Tool => translate_tool(session_id, part, tool_started),
        _ => Vec::new(),
    }
}

/// Tool part lifecycle: `pending`/`running` → `ToolStart`, `completed` →
/// `ToolOutput(output)` + `ToolEnd(done)`, `error` → `ToolOutput(error)` +
/// `ToolEnd(failed)`. `tool_started` records callIDs that already emitted a
/// `ToolStart`; opencode serve may emit both `pending` and `running` for the
/// same callID, so the second one must be suppressed to avoid duplicate rows.
pub(super) fn translate_tool(
    session_id: &str,
    part: &serde_json::Value,
    tool_started: &mut HashSet<String>,
) -> Vec<StreamEvent> {
    let call_id = match part.get("callID").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return Vec::new(),
    };
    let name = part
        .get("tool")
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let title =
        super::tool_title::tool_title(&name, part.get("state").and_then(|s| s.get("input")));
    match part
        .get("state")
        .and_then(|s| s.get("status"))
        .and_then(|v| v.as_str())
    {
        Some("pending") | Some("running") => {
            // 同一 callID 在 opencode serve 下可能同时收到 pending 与 running
            // 两次 `message.part.updated`；仅在首次发出 ToolStart，避免前端重复渲染。
            if tool_started.contains(&call_id) {
                return Vec::new();
            }
            tool_started.insert(call_id.clone());
            vec![StreamEvent::ToolStart {
                session_id: session_id.into(),
                call_id,
                name,
                title,
            }]
        }
        Some("completed") => {
            // 完成态快照携带完整 output → 先发输出（前端累积到 ToolCard.output），
            // 再发结束（前端将状态置为 done）。
            let output = part
                .get("state")
                .and_then(|s| s.get("output"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let mut events = Vec::with_capacity(2);
            if !output.is_empty() {
                events.push(StreamEvent::ToolOutput {
                    session_id: session_id.into(),
                    call_id: call_id.clone(),
                    output,
                });
            }
            events.push(StreamEvent::ToolEnd {
                session_id: session_id.into(),
                call_id,
                status: "done".into(),
            });
            events
        }
        Some("error") => {
            let error = part
                .get("state")
                .and_then(|s| s.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let mut events = Vec::with_capacity(2);
            if !error.is_empty() {
                events.push(StreamEvent::ToolOutput {
                    session_id: session_id.into(),
                    call_id: call_id.clone(),
                    output: error,
                });
            }
            events.push(StreamEvent::ToolEnd {
                session_id: session_id.into(),
                call_id,
                status: "failed".into(),
            });
            events
        }
        _ => Vec::new(),
    }
}

/// `todo.updated` — agent's live plan. Global event filtered by `sessionID`
/// in the pump; the `todos` array drives a Codex-style task list on the page.
pub(super) fn translate_todo_updated(
    session_id: &str,
    properties: &serde_json::Value,
) -> Vec<StreamEvent> {
    let todos = match properties.get("todos").and_then(|v| v.as_array()) {
        Some(arr) => arr
            .iter()
            .filter_map(|t| serde_json::from_value::<TodoItem>(t.clone()).ok())
            .collect(),
        None => return Vec::new(),
    };
    vec![StreamEvent::TodoUpdated {
        session_id: session_id.into(),
        todos,
    }]
}

/// `permission.asked` — the approval Gate. `properties.id` is the permission
/// request id used to reply via `/permissions/{id}`.
pub(super) fn translate_permission_asked(
    session_id: &str,
    properties: &serde_json::Value,
) -> Vec<StreamEvent> {
    let call_id = match properties.get("id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return Vec::new(),
    };
    let tool = properties
        .get("permission")
        .and_then(|v| v.as_str())
        .unwrap_or("tool");
    let patterns: Vec<String> = properties
        .get("patterns")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| p.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let prompt = if patterns.is_empty() {
        "Allow this action?".to_string()
    } else {
        patterns.join(" ")
    };
    let command = properties
        .get("metadata")
        .and_then(|m| m.get("command"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let title = command.clone().unwrap_or_else(|| prompt.clone());
    vec![StreamEvent::RequestApproval {
        session_id: session_id.into(),
        call_id,
        tool: tool.into(),
        title,
        prompt,
        diff: None,
        cmd: command,
    }]
}

/// `question.asked` — ask 类工具的阻塞等待。与 `permission.asked` 是**两个独立事件族**：
/// 权限门回答 allow/deny，提问要的是**答案文本**，故投影为 [`StreamEvent::UserInput`]
/// （前端内联面板 → `agent_input` → 本适配器的 [`SessionRequest::Input`] →
/// [`question_reply_url`]），而不是审批 Gate。
///
/// 实测（2026-10-13 发现缺口；2026-10-14 修正路由 —— 曾误写 `/api/session/...`，
/// 该形态实测 404）：serve 会话里模型调 question 工具后 `/question` 挂起待答；
/// 缺这一条 = 自有会话的提问既不显示面板、也不产生「等待用户行动」通知。
pub(super) fn translate_question_asked(
    session_id: &str,
    properties: &serde_json::Value,
) -> Vec<StreamEvent> {
    // 提问 id（`que_…`）即回执路由键 —— 复用 `turn_id` 槽位承载（Input 只带 prompt/turn_id）。
    let call_id = match properties.get("id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => return Vec::new(),
    };
    // 首问：header（短标签）优先，回落 question 正文 —— 与 hook 模板同一取值口径。
    let first = properties
        .get("questions")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first());
    let pick = |key: &str| {
        first
            .and_then(|q| q.get(key))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
    };
    let prompt = match pick("header").or_else(|| pick("question")) {
        Some(text) => text.to_string(),
        None => "Agent 需要你的输入".to_string(),
    };
    // 候选项：`questions[0].options[].label` —— 前端面板据此渲染可点选项（无则自由文本）。
    let options: Vec<String> = first
        .and_then(|q| q.get("options"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|o| o.get("label").and_then(|v| v.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    vec![StreamEvent::UserInput {
        session_id: session_id.into(),
        turn_id: call_id,
        prompt,
        options,
    }]
}

// ── Process-level serve connection (lazy, shared) ───────────────────────────
