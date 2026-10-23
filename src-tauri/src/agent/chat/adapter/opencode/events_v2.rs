//! opencode ≥ 2.0 的 SSE 事件翻译。
//!
//! # 与 1.x 的两处结构性差异
//!
//! | 方面 | V1 (`events_v1`) | V2（本模块） |
//! | --- | --- | --- |
//! | 载荷位置 | `properties` + `part` 快照 | `data`（形状按事件而变） |
//! | 流式载体 | `message.part.delta` + `part_kinds` 反查类型 | `session.text.delta` / `session.reasoning.delta` **类型在事件名里** |
//! | 工具 | 一个 `part` 的 `state.status` 状态机 | `input.started` → `called` → `success`/`failed` **三个独立事件** |
//! | 回合结束 | `session.idle` | `session.execution.{succeeded,failed,interrupted}` |
//!
//! 因为「类型在事件名里」，V2 不需要 `part_kinds`；但它需要 `tool_names`
//! —— `session.tool.called` 只带 `id` + `input`，名字在前一个事件里。
//!
//! # 两版共享的部分
//!
//! 工具标题的渲染规则（bash 显示命令、read 显示路径、task 显示 `Type Task: desc`）
//! 与协议无关，统一在 [`super::tool_title`]。两版的用户看到同一张卡片，
//! 行为分叉会变成「换个版本工具卡片长得不一样」这种说不清的问题。

use std::collections::{HashMap, HashSet};

use crate::agent::chat::events::{ErrorKind, StreamEvent, TurnEndReason};

use super::events_v1::ServeEvent;
use super::tool_title::tool_title;

/// V2 跨事件状态。
///
/// 与 V1 的 `part_kinds` 不同：V2 的流式类型在事件名里，不需要记；
/// 但工具名只在 `input.started` 出现，`called` 必须靠它。
#[derive(Debug, Default)]
pub(super) struct V2State {
    /// `session.tool.input.started` 的 id → name。
    pub(super) tool_names: HashMap<String, String>,
    /// 已发过 `ToolStart` 的 callID（`called` 可能重复到达）。
    pub(super) tool_started: HashSet<String>,
    /// 上一轮已提示过的错误文本。
    ///
    /// # 为什么需要去重
    ///
    /// 一次失败会发两条事件（实测 2.0.32）：`session.step.failed` 先到、
    /// `session.execution.failed` 后到，**错误内容完全相同**。两条都产出
    /// `Error` 事件会让界面出现两行一模一样的 ⚠。
    ///
    /// # 为什么在成功时清空而不是按 turn 计数
    ///
    /// `V2State` 活在整个 SSE 连接期间（跨回合）。只在 `execution.*` 收尾时
    /// 清空，保证「下一轮的同一条错误」会重新提示 —— 否则连续两轮撞同一个
    /// provider 故障，第二轮会静默。
    pub(super) last_failure: Option<String>,
}

impl V2State {
    /// 一轮结束：清理**只在一轮内有效**的状态。
    ///
    /// 与 `events_v1::end_turn_state` 是**同一个语义**（两版状态形状不同，
    /// 但「一轮结束时这些必须清空」是协议无关的契约）。三条状态各有理由：
    ///
    /// | 状态 | 为什么清 |
    /// | --- | --- |
    /// | `tool_names` | 工具调用已结束，名字不再需要 |
    /// | `tool_started` | **去重集合**，跨轮累积会让复用 callID 的工具静默丢 `ToolStart` |
    /// | `last_failure` | 下一轮的同一条错误必须重新提示，不能被去重吞掉 |
    ///
    /// **单点实现**：`execution_ended`（成功/中断）与 `failure`（失败，
    /// `ends_turn=true`）都调它。分开写会让其中一条路径漏清 —— 那正是
    /// 2026-10-23 实际发生过的（失败路径漏清，测试立刻抓到）。
    pub(super) fn end_turn(&mut self) {
        self.tool_names.clear();
        self.tool_started.clear();
        self.last_failure = None;
    }
}

/// 翻译一条 V2 事件。
pub(super) fn translate(
    session_id: &str,
    event: &ServeEvent,
    state: &mut V2State,
) -> Vec<StreamEvent> {
    let data = &event.properties; // 见 `events_v1::ServeEvent`: 已归一化为「载荷对象」
    match event.event_type.as_str() {
        "session.text.delta" => text_delta(session_id, data),
        "session.reasoning.delta" => reasoning_delta(session_id, data),

        // 工具名字缓存：**只记不发** —— 用户此时还不知道工具在做什么。
        "session.tool.input.started" => {
            remember_tool_name(data, state);
            Vec::new()
        }
        "session.tool.called" => tool_start(session_id, data, state),
        "session.tool.success" => tool_end(session_id, data, "done"),
        "session.tool.failed" => tool_end(session_id, data, "failed"),

        // 单步失败：整轮还没结束，但用户**已经等了很久** —— 必须立刻提示，
        // 不能等到 execution.failed。两者携带同一份 error，去重见 `last_failure`。
        "session.step.failed" => failure(session_id, data, state, false),

        "session.execution.succeeded" => {
            execution_ended(session_id, TurnEndReason::Completed, state)
        }
        "session.execution.failed" => failure(session_id, data, state, true),
        "session.execution.interrupted" => {
            execution_ended(session_id, TurnEndReason::Stopped, state)
        }

        "session.error" => session_error(session_id, data),
        "permission.asked" => permission_asked(session_id, data),
        "form.created" => form_created(session_id, data),

        // 其余（含 V1 专属的 todo.updated / message.part.* / session.idle）一律忽略。
        // **不得伪造 TodoUpdated**：2.0 没有 todo 快照事件，前端自然空着是诚实降级。
        _ => Vec::new(),
    }
}

/// 从 V2 事件取会话 id：`data.sessionID`，`form.created` 在 `data.form.sessionID`。
///
/// 两级查找是必要的：`form.created` 的载荷是 `{form:{...}}`，会话 id 在里层。
/// 放在这里而不是让泵层感知形状差异 —— 泵只问「这条事件属于哪个会话」。
pub(super) fn session_of(event: &ServeEvent) -> Option<String> {
    let data = &event.properties;
    data.get("sessionID")
        .and_then(|v| v.as_str())
        .or_else(|| {
            data.get("form")
                .and_then(|f| f.get("sessionID"))
                .and_then(|v| v.as_str())
        })
        .map(str::to_string)
}

fn text_delta(session_id: &str, data: &serde_json::Value) -> Vec<StreamEvent> {
    match data.get("delta").and_then(|v| v.as_str()) {
        Some(delta) if !delta.is_empty() => vec![StreamEvent::TextDelta {
            session_id: session_id.into(),
            delta: delta.into(),
        }],
        _ => Vec::new(),
    }
}

fn reasoning_delta(session_id: &str, data: &serde_json::Value) -> Vec<StreamEvent> {
    match data.get("delta").and_then(|v| v.as_str()) {
        Some(delta) if !delta.is_empty() => vec![StreamEvent::ReasoningDelta {
            session_id: session_id.into(),
            delta: delta.into(),
        }],
        _ => Vec::new(),
    }
}

/// `session.tool.input.started` → 缓存 `id → name`。不发事件。
fn remember_tool_name(data: &serde_json::Value, state: &mut V2State) {
    let (Some(id), Some(name)) = (
        data.get("id").and_then(|v| v.as_str()),
        data.get("name").and_then(|v| v.as_str()),
    ) else {
        return;
    };
    state.tool_names.insert(id.to_string(), name.to_string());
}

/// `session.tool.called` → `ToolStart`。
///
/// 名字来自缓存的 `input.started`（本事件不带 name），取不到时回退 `"tool"`
/// —— 名字缺失不该让整张卡片消失。
fn tool_start(session_id: &str, data: &serde_json::Value, state: &mut V2State) -> Vec<StreamEvent> {
    let Some(call_id) = data.get("id").and_then(|v| v.as_str()) else {
        return Vec::new();
    };
    if !state.tool_started.insert(call_id.to_string()) {
        return Vec::new();
    }
    let name = state
        .tool_names
        .get(call_id)
        .cloned()
        .unwrap_or_else(|| "tool".to_string());
    let input = data.get("input");
    let title = tool_title(&name, input);
    vec![StreamEvent::ToolStart {
        session_id: session_id.into(),
        call_id: call_id.to_string(),
        name,
        title,
    }]
}

/// `session.tool.success` / `.failed` → `ToolOutput`（有内容时）+ `ToolEnd`。
///
/// V2 的输出在 `content: [{type:"text", text}]` 数组里，可能有多段 —— 拼接。
fn tool_end(session_id: &str, data: &serde_json::Value, status: &str) -> Vec<StreamEvent> {
    let Some(call_id) = data.get("id").and_then(|v| v.as_str()) else {
        return Vec::new();
    };
    let output = collect_text_content(data);
    let mut events = Vec::with_capacity(2);
    if !output.is_empty() {
        events.push(StreamEvent::ToolOutput {
            session_id: session_id.into(),
            call_id: call_id.to_string(),
            output,
        });
    }
    events.push(StreamEvent::ToolEnd {
        session_id: session_id.into(),
        call_id: call_id.to_string(),
        status: status.into(),
    });
    events
}

/// 把 `content: [{type:"text", text}]` 拼成一段文本。
fn collect_text_content(data: &serde_json::Value) -> String {
    data.get("content")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// 失败事件 → （首次）`Error` + （整轮结束时）`TurnEnd{Error}`。
///
/// # 为什么两者都要
///
/// - `Error` 是**用户唯一能看到错误文本的通道**。`TurnEnd` 没有 message 字段，
///   而前端 `useTurnStream` 对 `turn_end` 只做收尾（`closeRunningTools` +
///   worked 卡片），不渲染任何提示。
/// - `TurnEnd{Error}` 负责收尾：清 streaming 态、记 worked 卡片的失败标记。
///
/// 只发后者 = 用户看到「发了消息，什么都没有」（2026-10-23 真实故障）。
///
/// `ends_turn=false`（`step.failed`）：只提示，不收尾 —— 之后可能还有重试。
fn failure(
    session_id: &str,
    data: &serde_json::Value,
    state: &mut V2State,
    ends_turn: bool,
) -> Vec<StreamEvent> {
    let message = error_message(data);
    let mut events = Vec::with_capacity(2);
    // 去重：同一条错误只提示一次（step.failed → execution.failed 是同一份内容）。
    if state.last_failure.as_deref() != Some(message.as_str()) {
        state.last_failure = Some(message.clone());
        events.push(StreamEvent::Error {
            session_id: session_id.into(),
            kind: ErrorKind::Agent,
            code: "E_AGENT".into(),
            message,
        });
    }
    if ends_turn {
        // 与 `execution_ended` 走**同一个**清理入口 —— 分开写时失败路径漏清过。
        state.end_turn();
        events.push(StreamEvent::TurnEnd {
            session_id: session_id.into(),
            turn_id: String::new(),
            reason: TurnEndReason::Error,
        });
    }
    events
}

/// 正常收尾（成功 / 中断）：产出 `TurnEnd`，并清理**只在一轮内有效**的状态。
///
/// # 为什么要清工具状态
///
/// `tool_names` / `tool_started` 的语义是「一个工具调用从开始到结束」——
/// 它们的有效期就是**一轮**。不清的话：
///
/// - 长会话里持续增长（每次工具调用约 130 字节，1000 次 ≈ 127 KB）；
/// - 更要紧的是 `tool_started` 是**去重集合**：跨轮累积后，如果某个 agent
///   复用了 callID（协议没禁止），第二轮的同名工具会被误判成「已发过」
///   而**静默丢掉 ToolStart** —— 前端少一张卡片，且没有任何日志。
///
/// callID 实测是全局唯一的（`766c…` 随机串），所以当前不会真的撞上；
/// 但「靠对端保证唯一性」不该是本地状态无界的理由。
fn execution_ended(
    session_id: &str,
    reason: TurnEndReason,
    state: &mut V2State,
) -> Vec<StreamEvent> {
    state.end_turn();
    turn_end(session_id, reason)
}

/// 从失败事件里取用户可读的错误文本。
///
/// 实测 2.0 的形状：`data.error.{type,message,status}`，部分路径把 message
/// 埋在 `data.error.data.message`。两者都认，都取不到时给可操作的兜底文案
/// （**绝不返回空串** —— 那会让界面出现「⚠ ()」）。
fn error_message(data: &serde_json::Value) -> String {
    data.get("error")
        .and_then(|e| {
            e.get("message").and_then(|v| v.as_str()).or_else(|| {
                e.get("data")
                    .and_then(|d| d.get("message"))
                    .and_then(|v| v.as_str())
            })
        })
        .or_else(|| data.get("message").and_then(|v| v.as_str()))
        .filter(|s| !s.is_empty())
        .unwrap_or("opencode reported a failure without a message")
        .to_string()
}

fn turn_end(session_id: &str, reason: TurnEndReason) -> Vec<StreamEvent> {
    vec![StreamEvent::TurnEnd {
        session_id: session_id.into(),
        turn_id: String::new(),
        reason,
    }]
}

fn session_error(session_id: &str, data: &serde_json::Value) -> Vec<StreamEvent> {
    let message = data
        .get("error")
        .and_then(|e| e.get("data"))
        .and_then(|d| d.get("message"))
        .and_then(|v| v.as_str())
        .or_else(|| data.get("message").and_then(|v| v.as_str()))
        .unwrap_or("opencode serve error");
    vec![StreamEvent::Error {
        session_id: session_id.into(),
        kind: ErrorKind::Agent,
        code: "E_AGENT".into(),
        message: message.into(),
    }]
}

/// `permission.asked` → `RequestApproval`。
///
/// V2 的载荷与 V1 完全不同：
///
/// | 字段 | V1 | V2 |
/// | --- | --- | --- |
/// | 动作 | `permission` | `action` |
/// | 目标 | `patterns[]` | `resources[]` |
/// | diff | 无 | `metadata.files[].patch`（**现成 unified diff**） |
fn permission_asked(session_id: &str, data: &serde_json::Value) -> Vec<StreamEvent> {
    let Some(id) = data.get("id").and_then(|v| v.as_str()) else {
        return Vec::new();
    };
    let tool = data
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let resources: Vec<&str> = data
        .get("resources")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str()).collect())
        .unwrap_or_default();
    let title = if resources.is_empty() {
        tool.clone()
    } else {
        resources.join(" ")
    };
    // `metadata.files[0].patch` 已经是 unified diff，直接可喂给审批卡片。
    let diff = data
        .get("metadata")
        .and_then(|m| m.get("files"))
        .and_then(|f| f.as_array())
        .and_then(|a| a.first())
        .and_then(|f| f.get("patch"))
        .and_then(|v| v.as_str())
        .map(str::to_string);

    vec![StreamEvent::RequestApproval {
        session_id: session_id.into(),
        call_id: id.to_string(),
        tool,
        title,
        prompt: String::new(),
        diff,
        cmd: None,
    }]
}

/// `form.created` → `UserInput`，**仅当 `metadata.kind == "question"`**。
///
/// 其余 kind 是扩展自己的表单（设置面板之类），Neeko 没有对应的回执通道 ——
/// 强行渲染成提问会让用户填了答案却送不回去。
fn form_created(session_id: &str, data: &serde_json::Value) -> Vec<StreamEvent> {
    let Some(form) = data.get("form") else {
        return Vec::new();
    };
    let kind = form
        .get("metadata")
        .and_then(|m| m.get("kind"))
        .and_then(|v| v.as_str());
    if kind != Some("question") {
        return Vec::new();
    }
    let Some(form_id) = form.get("id").and_then(|v| v.as_str()) else {
        return Vec::new();
    };
    let field = form
        .get("fields")
        .and_then(|f| f.as_array())
        .and_then(|a| a.first());
    // 问题文本：description 更完整（是一句话），title 是短标签；两者拼起来最有用。
    let title = field
        .and_then(|f| f.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let description = field
        .and_then(|f| f.get("description"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let prompt = match (title.is_empty(), description.is_empty()) {
        (false, false) => format!("{title}: {description}"),
        (false, true) => title.to_string(),
        (true, false) => description.to_string(),
        (true, true) => form
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Question")
            .to_string(),
    };
    let options: Vec<String> = field
        .and_then(|f| f.get("options"))
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|o| o.get("label").and_then(|v| v.as_str()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    vec![StreamEvent::UserInput {
        session_id: session_id.into(),
        turn_id: form_id.to_string(),
        prompt,
        options,
    }]
}

/// `form.created` 里第一个字段的 key —— V2 提问回执的映射键。
///
/// 与 [`form_created`] 分开：翻译产出的是给前端看的 `UserInput`（不含 key），
/// 而回执需要 key。同一个载荷的两种用途，各自取各自要的部分，
/// 避免为了回执把 key 塞进 `StreamEvent`（那会让前端协议知道一个它用不上的字段）。
pub(super) fn form_field_key(data: &serde_json::Value) -> Option<String> {
    data.get("form")?
        .get("fields")?
        .as_array()?
        .first()?
        .get("key")?
        .as_str()
        .map(str::to_string)
}
