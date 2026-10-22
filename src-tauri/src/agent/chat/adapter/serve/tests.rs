use std::collections::{HashMap, HashSet};

use crate::agent::chat::adapter::AgentContext;
use crate::agent::chat::events::{ErrorKind, StreamEvent, TodoItem, TurnEndReason};

use super::{
    connection::extract_listening_url,
    events_v1::{tool_title, translate_event, PartKind, ServeEvent},
    eventurl::{event_stream_url, question_reply_url},
    protocol::{model_body, model_slug_split, session_create_url},
};

fn sse_event(json: &str) -> ServeEvent {
    serde_json::from_str(json).expect("valid sse event")
}

/// 从事件列表中取唯一事件（测试断言用）；为空或多余一个则 panic。
fn single(events: Vec<StreamEvent>) -> StreamEvent {
    let mut it = events.into_iter();
    let first = it.next().expect("expected exactly one event, got none");
    assert!(it.next().is_none(), "expected exactly one event, got more");
    first
}

fn serve_ctx(project_id: &str) -> AgentContext {
    AgentContext {
        agent_id: "opencode".into(),
        session_id: "ac_test".into(),
        project_id: project_id.into(),
        project_name: "demo".into(),
        env: "local".into(),
        skills: vec![],
        files: vec![],
        mode: "auto".into(),
        prompt: String::new(),
        model_id: None,
    }
}

#[test]
fn session_create_url_carries_project_directory() {
    let url = session_create_url("http://127.0.0.1:4096", &serve_ctx("/tmp/demo proj"));
    assert_eq!(
        url, "http://127.0.0.1:4096/session?directory=%2Ftmp%2Fdemo%20proj",
        "POST /session 必须显式传 directory（会话工作目录），否则继承 serve 进程 cwd"
    );
}

#[test]
fn session_create_url_encodes_absolute_path() {
    let url = session_create_url(
        "http://127.0.0.1:4096",
        &serve_ctx("/Users/demo/RustroverProjects/neeko"),
    );
    assert!(url.ends_with("?directory=%2FUsers%2Fdemo%2FRustroverProjects%2Fneeko"));
}

/// opencode 1.18.x 起按目录过滤事件广播：裸 `/event` 只推 server 级事件
///（connected/heartbeat），会话与消息事件必须带 `directory` 查询参数才会
/// 下发。回归实证（2026-08-22）：不带参数时模型回复已落盘但 SSE 零推送，
/// 前端表现为发送后一直 thinking 无任何响应数据。
#[test]
fn event_stream_url_encodes_directory_filter() {
    assert_eq!(
        event_stream_url("http://127.0.0.1:55652", "/Users/demo/my proj"),
        "http://127.0.0.1:55652/event?directory=%2FUsers%2Fdemo%2Fmy%20proj"
    );
}

/// 提问回执路由（实测钉死，2026-10-14）：serve 的公开面是
/// `POST /question/{requestID}/reply?directory=…`（`200 application/json` + `true`）。
///
/// 曾经写错的形态 `POST /api/session/{sid}/question/{rid}/reply` 实测返回
/// `404 QuestionNotFoundError` —— 那一族是内部 SDK 面。写错时用户点「回答」后
/// agent 永久挂起，故连 URL 形状一起钉住。
#[test]
fn question_reply_url_uses_public_route_with_directory() {
    assert_eq!(
        question_reply_url("http://127.0.0.1:55652", "/Users/demo/my proj", "que_abc"),
        "http://127.0.0.1:55652/question/que_abc/reply?directory=%2FUsers%2Fdemo%2Fmy%20proj"
    );
}

/// 回执路由**不得**带 `/api` 前缀，也**不得**漏 `directory`（两者实测都是 404）。
#[test]
fn question_reply_url_shape_guards() {
    let url = question_reply_url("http://h:1", "/tmp/p", "que_1");
    assert!(!url.contains("/api/"), "serve 公开面无 /api 前缀：{url}");
    assert!(url.contains("directory="), "directory 必填：{url}");
    assert!(url.starts_with("http://h:1/question/que_1/reply?"), "{url}");
}

#[test]
fn text_delta_translates_from_part_delta() {
    let event = sse_event(
        r#"{"type":"message.part.delta","properties":{"sessionID":"ses_1","messageID":"msg_1","partID":"prt_text","field":"text","delta":"hello"}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    kinds.insert("prt_text".to_string(), PartKind::Text);
    let ev = single(translate_event("ac_1", &event, &mut kinds, &mut started));
    assert_eq!(
        ev,
        StreamEvent::TextDelta {
            session_id: "ac_1".into(),
            delta: "hello".into()
        }
    );
}

#[test]
fn reasoning_delta_translates_when_part_is_reasoning() {
    let event = sse_event(
        r#"{"type":"message.part.delta","properties":{"sessionID":"ses_1","messageID":"msg_1","partID":"prt_reason","field":"text","delta":"想想"}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    kinds.insert("prt_reason".to_string(), PartKind::Reasoning);
    let ev = single(translate_event("ac_1", &event, &mut kinds, &mut started));
    assert_eq!(
        ev,
        StreamEvent::ReasoningDelta {
            session_id: "ac_1".into(),
            delta: "想想".into()
        }
    );
}

#[test]
fn part_updated_registers_kind_for_later_deltas() {
    let updated = sse_event(
        r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_reason","type":"reasoning","text":""}}}"#,
    );
    let delta = sse_event(
        r#"{"type":"message.part.delta","properties":{"sessionID":"ses_1","partID":"prt_reason","field":"text","delta":"ok"}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    assert!(translate_event("ac_1", &updated, &mut kinds, &mut started).is_empty());
    let ev = single(translate_event("ac_1", &delta, &mut kinds, &mut started));
    assert_eq!(
        ev,
        StreamEvent::ReasoningDelta {
            session_id: "ac_1".into(),
            delta: "ok".into()
        }
    );
}

#[test]
fn tool_running_translates_to_tool_start() {
    let event = sse_event(
        r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_0","state":{"status":"running","input":{"command":"echo hi"},"metadata":{"output":""}}}}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    let ev = single(translate_event("ac_1", &event, &mut kinds, &mut started));
    assert_eq!(
        ev,
        StreamEvent::ToolStart {
            session_id: "ac_1".into(),
            call_id: "bash_0".into(),
            name: "bash".into(),
            title: "echo hi".into(),
        }
    );
}

#[test]
fn tool_completed_translates_to_tool_output_then_end() {
    let event = sse_event(
        r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_1","state":{"status":"completed","input":{"command":"echo hi"},"output":"hi\n","title":"echo hi","metadata":{}}}}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    let evs = translate_event("ac_1", &event, &mut kinds, &mut started);
    assert_eq!(
        evs,
        vec![
            StreamEvent::ToolOutput {
                session_id: "ac_1".into(),
                call_id: "bash_1".into(),
                output: "hi\n".into(),
            },
            StreamEvent::ToolEnd {
                session_id: "ac_1".into(),
                call_id: "bash_1".into(),
                status: "done".into(),
            },
        ]
    );
}

#[test]
fn tool_completed_without_output_only_ends() {
    let event = sse_event(
        r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_3","state":{"status":"completed","input":{},"output":"","title":"echo","metadata":{}}}}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    let evs = translate_event("ac_1", &event, &mut kinds, &mut started);
    assert_eq!(
        evs,
        vec![StreamEvent::ToolEnd {
            session_id: "ac_1".into(),
            call_id: "bash_3".into(),
            status: "done".into(),
        }]
    );
}

#[test]
fn tool_error_translates_to_tool_end_failed() {
    let event = sse_event(
        r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_2","state":{"status":"error","input":{},"error":"boom"}}}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    let evs = translate_event("ac_1", &event, &mut kinds, &mut started);
    assert_eq!(
        evs,
        vec![
            StreamEvent::ToolOutput {
                session_id: "ac_1".into(),
                call_id: "bash_2".into(),
                output: "boom".into(),
            },
            StreamEvent::ToolEnd {
                session_id: "ac_1".into(),
                call_id: "bash_2".into(),
                status: "failed".into(),
            },
        ]
    );
}

/// `question.asked`（ask 类工具阻塞）→ `UserInput`。
///
/// 载荷是 **2026-10-14 从真 `opencode serve` 的 `GET /event` SSE 流抓下来的逐字样本**
/// （`question.asked` 1 条，见 `/tmp/sse3.txt`），不是照二进制猜的形状 —— 实测差异：
/// `options[]` 元素带 `description`，且**没有** `multiple` 字段。
/// 缺这条路由时自有会话的提问既不显示内联面板、也不产生「等待用户行动」通知。
#[test]
fn question_asked_translates_to_user_input() {
    let event = sse_event(
        r#"{"id":"evt_138828573001lOkACjg0X0LELX","type":"question.asked","properties":{"id":"que_138828572001SACyo0ucRUWNvM","sessionID":"ses_ec77e6947ffegOTypRWn4THThq","questions":[{"question":"Which file should I edit?","header":"File to edit","options":[{"label":"Option A","description":"First file option"},{"label":"Option B","description":"Second file option"},{"label":"Option C","description":"Third file option"}]}],"tool":{"messageID":"msg_138827c2e001ytw2Xf8cJY8lNo","callID":"call_01a1388282d77360a7315548c045d7e5"}}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    let ev = single(translate_event("ac_1", &event, &mut kinds, &mut started));
    match ev {
        StreamEvent::UserInput {
            session_id,
            turn_id,
            prompt,
            options,
        } => {
            assert_eq!(session_id, "ac_1");
            // 提问 id 承载在 turn_id：回执路由键（`que_` 前缀判定 question 端点）。
            assert_eq!(turn_id, "que_138828572001SACyo0ucRUWNvM");
            // header 优先（短标签），与 hook 模板同一口径。
            assert_eq!(prompt, "File to edit");
            // 候选项必须透传且**只取 label**：前端 UserInputPanel 据此渲染可点选项，
            // 丢了就只能让用户手打 agent 已经给了的答案；description 是面板不消费的噪声。
            assert_eq!(
                options,
                vec![
                    "Option A".to_string(),
                    "Option B".to_string(),
                    "Option C".to_string()
                ]
            );
        }
        other => panic!("expected UserInput, got {other:?}"),
    }
    // 无 options（纯开放问题）→ 空 vec，前端落自由文本输入而非空选项列表。
    let plain = sse_event(
        r#"{"type":"question.asked","properties":{"id":"que_9","sessionID":"ses_1","questions":[{"header":"分支名","question":"用哪个分支？"}]}}"#,
    );
    match single(translate_event("ac_1", &plain, &mut kinds, &mut started)) {
        StreamEvent::UserInput { options, .. } => assert!(options.is_empty()),
        other => panic!("expected UserInput, got {other:?}"),
    }
}

/// header 缺失时回落 question 正文；两者都缺 → 类别兜底（不产出空 prompt）。
#[test]
fn question_asked_falls_back_to_question_text_then_default() {
    let with_text = sse_event(
        r#"{"type":"question.asked","properties":{"id":"que_2","sessionID":"ses_1","questions":[{"question":"分支名是什么？"}]}}"#,
    );
    let defaulted = sse_event(
        r#"{"type":"question.asked","properties":{"id":"que_3","sessionID":"ses_1","questions":[{"header":"  "}]}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    let prompts: Vec<String> = [with_text, defaulted]
        .iter()
        .map(
            |e| match single(translate_event("ac_1", e, &mut kinds, &mut started)) {
                StreamEvent::UserInput { prompt, .. } => prompt,
                other => panic!("expected UserInput, got {other:?}"),
            },
        )
        .collect();
    assert_eq!(prompts[0], "分支名是什么？");
    assert_eq!(prompts[1], "Agent 需要你的输入");
}

/// 缺 id → 无可回执的路由键，静默丢弃（不产生无法回答的面板）。
#[test]
fn question_asked_without_id_is_ignored() {
    let event = sse_event(
        r#"{"type":"question.asked","properties":{"sessionID":"ses_1","questions":[{"header":"x"}]}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    assert!(translate_event("ac_1", &event, &mut kinds, &mut started).is_empty());
}

#[test]
fn session_idle_translates_to_turn_end() {
    let event = sse_event(r#"{"type":"session.idle","properties":{"sessionID":"ses_1"}}"#);
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    let ev = single(translate_event("ac_1", &event, &mut kinds, &mut started));
    assert_eq!(
        ev,
        StreamEvent::TurnEnd {
            session_id: "ac_1".into(),
            turn_id: String::new(),
            reason: TurnEndReason::Completed,
        }
    );
}

#[test]
fn session_error_translates_to_error() {
    let event = sse_event(
        r#"{"type":"session.error","properties":{"sessionID":"ses_1","error":{"name":"UnknownError","data":{"message":"Model not found"}}}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    let ev = single(translate_event("ac_1", &event, &mut kinds, &mut started));
    match ev {
        StreamEvent::Error { kind, message, .. } => {
            assert_eq!(kind, ErrorKind::Agent);
            assert_eq!(message, "Model not found");
        }
        other => panic!("expected Error, got {other:?}"),
    }
}

#[test]
fn todo_updated_translates_to_todo_list() {
    let event = sse_event(
        r#"{"type":"todo.updated","properties":{"sessionID":"ses_1","todos":[{"content":"读第一章","status":"pending","priority":"high"},{"content":"写笔记","status":"in_progress","priority":"medium"}]}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    let evs = translate_event("ac_1", &event, &mut kinds, &mut started);
    assert_eq!(
        evs,
        vec![StreamEvent::TodoUpdated {
            session_id: "ac_1".into(),
            todos: vec![
                TodoItem {
                    content: "读第一章".into(),
                    status: "pending".into(),
                    priority: "high".into(),
                },
                TodoItem {
                    content: "写笔记".into(),
                    status: "in_progress".into(),
                    priority: "medium".into(),
                },
            ],
        }]
    );
}

#[test]
fn todo_updated_without_todos_ignored() {
    let event = sse_event(r#"{"type":"todo.updated","properties":{"sessionID":"ses_1"}}"#);
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    assert!(translate_event("ac_1", &event, &mut kinds, &mut started).is_empty());
}

#[test]
fn task_tool_title_includes_subagent_and_description() {
    let part = serde_json::json!({
        "type": "tool",
        "tool": "task",
        "callID": "task_0",
        "state": {
            "status": "running",
            "input": { "subagent_type": "general", "description": "扫描代码库并总结模块边界" }
        }
    });
    assert_eq!(tool_title(&part), "general Task: 扫描代码库并总结模块边界");
}

#[test]
fn todowrite_tool_title_counts_todos() {
    let part = serde_json::json!({
        "type": "tool",
        "tool": "todowrite",
        "callID": "todo_0",
        "state": {
            "status": "running",
            "input": {
                "todos": [
                    { "content": "a", "status": "pending", "priority": "high" },
                    { "content": "b", "status": "pending", "priority": "low" },
                    { "content": "c", "status": "completed", "priority": "medium" }
                ]
            }
        }
    });
    assert_eq!(tool_title(&part), "3 todos");
}

#[test]
fn unknown_event_ignored() {
    let event = sse_event(r#"{"type":"server.heartbeat","properties":{}}"#);
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    assert!(translate_event("ac_1", &event, &mut kinds, &mut started).is_empty());
}

#[test]
fn non_text_part_delta_ignored() {
    let event = sse_event(
        r#"{"type":"message.part.delta","properties":{"sessionID":"ses_1","partID":"prt_t","field":"tool_input","delta":"x"}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    assert!(translate_event("ac_1", &event, &mut kinds, &mut started).is_empty());
}

#[test]
fn model_slug_split_handles_slash_and_bare() {
    assert_eq!(
        model_slug_split("anthropic/claude-sonnet-4-5"),
        ("anthropic".to_string(), "claude-sonnet-4-5".to_string())
    );
    assert_eq!(
        model_slug_split("kimi-k2.7-code"),
        (String::new(), "kimi-k2.7-code".to_string())
    );
}

#[test]
fn model_body_omitted_when_absent_or_bare_id() {
    assert!(model_body(None).is_none());
    assert!(model_body(Some("kimi-k2.7-code")).is_none());
}

#[test]
fn model_body_builds_provider_model_object() {
    let body = model_body(Some("anthropic/claude-sonnet-4-5")).expect("body");
    assert_eq!(body["providerID"], "anthropic");
    assert_eq!(body["modelID"], "claude-sonnet-4-5");
}

#[test]
fn extract_listening_url_parses_startup_line() {
    assert_eq!(
        extract_listening_url("opencode server listening on http://127.0.0.1:57775"),
        Some("http://127.0.0.1:57775".to_string())
    );
    assert!(extract_listening_url("loading config...").is_none());
}

/// 同一 callID 的 `pending` → `running` 只应发出一次 `ToolStart`。
/// opencode serve 会就同一工具多次推送 `message.part.updated`，若不加
/// 去重，前端会把同一任务渲染成两行（用户反馈的 bug）。
#[test]
fn bash_title_supports_command_array_and_script_fields() {
    // command 为数组 → join 成完整命令
    let arr = sse_event(
        r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_0","state":{"status":"running","input":{"command":["wc","-l","src/a.rs"]},"metadata":{}}}}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    let evs = translate_event("ac_1", &arr, &mut kinds, &mut started);
    assert!(matches!(
        &evs[0],
        StreamEvent::ToolStart { title, .. } if title == "wc -l src/a.rs"
    ));

    // script 字段兜底
    let script = sse_event(
        r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_1","state":{"status":"running","input":{"script":"cargo check"},"metadata":{}}}}}"#,
    );
    let evs = translate_event("ac_1", &script, &mut kinds, &mut started);
    assert!(matches!(
        &evs[0],
        StreamEvent::ToolStart { title, .. } if title == "cargo check"
    ));
}

#[test]
fn bash_title_falls_back_to_tool_name_when_no_command() {
    let ev = sse_event(
        r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_0","state":{"status":"running","input":{},"metadata":{}}}}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    let evs = translate_event("ac_1", &ev, &mut kinds, &mut started);
    assert!(matches!(
        &evs[0],
        StreamEvent::ToolStart { title, .. } if title == "bash"
    ));
}

#[test]
fn read_title_extracts_path_from_filepath_or_file() {
    let file_path = sse_event(
        r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"read","callID":"read_0","state":{"status":"running","input":{"filePath":"src/a.rs"},"metadata":{}}}}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    let evs = translate_event("ac_1", &file_path, &mut kinds, &mut started);
    assert!(matches!(
        &evs[0],
        StreamEvent::ToolStart { title, .. } if title == "src/a.rs"
    ));

    let file = sse_event(
        r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"read","callID":"read_1","state":{"status":"running","input":{"file":"src/b.rs"},"metadata":{}}}}}"#,
    );
    let evs = translate_event("ac_1", &file, &mut kinds, &mut started);
    assert!(matches!(
        &evs[0],
        StreamEvent::ToolStart { title, .. } if title == "src/b.rs"
    ));
}

#[test]
fn same_tool_callid_pending_then_running_only_starts_once() {
    let pending = sse_event(
        r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_0","state":{"status":"pending","input":{"command":"echo hi"},"metadata":{}}}}}"#,
    );
    let running = sse_event(
        r#"{"type":"message.part.updated","properties":{"sessionID":"ses_1","part":{"id":"prt_t","type":"tool","tool":"bash","callID":"bash_0","state":{"status":"running","input":{"command":"echo hi"},"metadata":{}}}}}"#,
    );
    let mut kinds = HashMap::new();
    let mut started = HashSet::new();
    let evs1 = translate_event("ac_1", &pending, &mut kinds, &mut started);
    assert_eq!(
        evs1,
        vec![StreamEvent::ToolStart {
            session_id: "ac_1".into(),
            call_id: "bash_0".into(),
            name: "bash".into(),
            title: "echo hi".into()
        }]
    );
    let evs2 = translate_event("ac_1", &running, &mut kinds, &mut started);
    assert!(
        evs2.is_empty(),
        "running 阶段不应重复发 ToolStart: {evs2:?}"
    );
}
