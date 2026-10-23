use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use crate::agent::chat::events::{ErrorKind, StreamEvent, TodoItem, TurnEndReason};

// ── SSE event translation (pure, testable) ──────────────────────────────────

/// One SSE `data:` payload from `GET /event`.
#[derive(Debug, Deserialize)]
pub(super) struct ServeEvent {
    #[serde(rename = "type")]
    pub(super) event_type: String,
    #[serde(default)]
    pub(super) properties: serde_json::Value,
}

/// The kind of a streamed part, learned from `message.part.updated`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PartKind {
    Text,
    Reasoning,
    Tool,
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
        "session.idle" => vec![StreamEvent::TurnEnd {
            session_id: session_id.into(),
            turn_id: String::new(),
            reason: TurnEndReason::Completed,
        }],
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
    let title = tool_title(part);
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

/// Human-readable tool title derived from the tool input (bash command / file
/// path / pattern / task description / todo count). Falls back to the tool name.
pub(super) fn tool_title(part: &serde_json::Value) -> String {
    let tool = part
        .get("tool")
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let input = part.get("state").and_then(|s| s.get("input"));
    // task (subagent spawn) → "Type Task" + description（对齐 opencode TUI 的 `{type} Task`）。
    if tool == "task" {
        let sub_type = input
            .and_then(|i| i.get("subagent_type"))
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .unwrap_or("general");
        let desc = input
            .and_then(|i| i.get("description"))
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty());
        return match desc {
            Some(d) => format!("{sub_type} Task: {d}"),
            None => format!("{sub_type} Task"),
        };
    }
    // todowrite → "N todos"（对齐 opencode 完成态 title）。
    if tool == "todowrite" {
        if let Some(count) = input
            .and_then(|i| i.get("todos"))
            .and_then(|v| v.as_array())
            .map(|arr| arr.len())
        {
            return format!("{count} todos");
        }
        return "todo".to_string();
    }
    // bash / run_command → 完整命令（`command` 支持 string 或数组；另兼容
    // `script` / `cmd` 字段），确保命令卡片能展示「执行了什么」而非工具名。
    if tool == "bash" || tool == "run_command" {
        if let Some(cmd) = command_from_input(input) {
            return cmd;
        }
    }
    // read_file / read → filePath / path / file（read 操作折叠标题 `read <路径>`）。
    for key in ["command", "filePath", "path", "file", "pattern"] {
        if let Some(v) = input
            .and_then(|i| i.get(key))
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
        {
            return v.to_string();
        }
    }
    tool
}

/// 从 bash 工具的 input 提取命令字符串：`command`（string 或数组）、
/// `script`、`cmd`。均缺省时返回 `None`（调用方回退到工具名）。
pub(super) fn command_from_input(input: Option<&serde_json::Value>) -> Option<String> {
    let i = input?;
    if let Some(v) = i.get("command") {
        match v {
            serde_json::Value::String(s) if !s.is_empty() => return Some(s.clone()),
            serde_json::Value::Array(arr) => {
                let parts: Vec<&str> = arr.iter().filter_map(|x| x.as_str()).collect();
                if !parts.is_empty() {
                    return Some(parts.join(" "));
                }
            }
            _ => {}
        }
    }
    for key in ["script", "cmd"] {
        if let Some(s) = i
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            return Some(s.to_string());
        }
    }
    None
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
