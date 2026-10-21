//! mockAgent — in-process mock ACP agent (dev/test tool).
//!
//! Speaks the Agent Client Protocol (ACP) over JSON-RPC stdio framing,
//! exactly like the real DeepSeek Harness ACP bridge, but runs **in-process**:
//! `run_mock_loop` drives any `AsyncRead`/`AsyncWrite` pair, so `AcpAdapter`
//! can feed it a `tokio::io::duplex()` pipe instead of spawning a child
//! process. Simulates the full lifecycle: text stream, a permission request
//! (Gate), the approval reply, turn end, and cancel handling.
//!
//! Frame format (LSP-style): `Content-Length: <n>\r\n\r\n<json body>`.
//!
//! # 也模拟 ACP 的会话配置项（模型选择）
//!
//! `session/new` 返回一个 `category: "model"` 的 `configOptions` 项，`session/set_config_option`
//! 会更新当前模型并回全量配置。这让「模型列表 → 用户选择 → 真正下发」这条链路能在
//! **进程内**端到端跑通，无需任何外部 agent —— 见 `adapter/acp.rs` 的
//! `mock_agent_switches_model_end_to_end`。
//!
//! 刻意保留了真实 agent 的几处特性，避免 mock 比现实宽松：
//! - 模型项的 `id` **不叫** `"model"`（规范说 `category` 才是判据，`id` 无约束）；
//! - 响应返回**全量** `configOptions`（协议强制）；
//! - 同时提供一个 `model_config` 项与一个 `thought_level` 项。

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

const SESSION_ID: &str = "mock-s1";

/// 模型配置项的 `id`。**故意不叫 `"model"`** —— 规范只说 `category` 是语义判据，
/// `id` 没有命名约束。用它当 mock 的标识，可以钉住「按 category 定位」这条契约：
/// 若实现退回按 `id == "model"` 查找，这里立刻失败。
const MODEL_CONFIG_ID: &str = "mock-primary-model";

/// mock 提供的可选模型。
const MOCK_MODELS: &[(&str, &str)] = &[
    ("mock-fast", "Mock Fast"),
    ("mock-thorough", "Mock Thorough"),
];

/// 初始模型。
const DEFAULT_MODEL: &str = "mock-fast";

/// 构造 `configOptions` 全量数组（`session/new` 与 `set_config_option` 共用）。
///
/// 真实 agent 的响应是**全量**状态，不是增量 —— mock 保持同样语义，否则客户端
/// 「整体替换」的实现会被测成「局部合并也能过」。
fn config_options(current_model: &str, fast_mode: bool) -> Value {
    let model_options: Vec<Value> = MOCK_MODELS
        .iter()
        .map(|(value, name)| json!({ "value": value, "name": name }))
        .collect();

    json!([
        {
            "id": MODEL_CONFIG_ID,
            "name": "Model",
            "description": "Model used for this session",
            "category": "model",
            "type": "select",
            "currentValue": current_model,
            "options": model_options
        },
        {
            "id": "context-size",
            "name": "Context size",
            "category": "model_config",
            "type": "select",
            "currentValue": "200k",
            "options": [
                { "value": "100k", "name": "100k" },
                { "value": "200k", "name": "200k" }
            ]
        },
        {
            "id": "reasoning-effort",
            "name": "Reasoning effort",
            "category": "thought_level",
            "type": "select",
            "currentValue": "medium",
            "options": [
                { "value": "low", "name": "Low" },
                { "value": "medium", "name": "Medium" }
            ]
        },
        {
            "id": "fast-mode",
            "name": "Fast mode",
            "category": "model_config",
            "type": "boolean",
            "currentValue": fast_mode
        }
    ])
}

/// Drive the mock ACP server over `reader` / `writer` until EOF or cancel.
pub async fn run_mock_loop<R, W>(reader: R, writer: W)
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(reader);
    let mut writer = writer;
    let mut state = MockState::default();
    while let Some(body) = read_frame(&mut reader).await {
        let Ok(msg) = serde_json::from_str::<Value>(&body) else {
            continue;
        };
        if !handle_request(&msg, &mut reader, &mut writer, &mut state).await {
            break;
        }
    }
}

/// Read one Content-Length framed message. `None` on EOF.
async fn read_frame<R: AsyncRead + Unpin>(reader: &mut BufReader<R>) -> Option<String> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await.ok()?;
        if n == 0 {
            return None; // EOF
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break; // end of headers
        }
        if let Some(v) = trimmed.strip_prefix("Content-Length:") {
            content_length = v.trim().parse().ok();
        }
    }
    let len = content_length?;
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await.ok()?;
    String::from_utf8(body).ok()
}

async fn send<W: AsyncWrite + Unpin>(writer: &mut W, v: &Value) {
    let body = v.to_string();
    let frame = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
    let _ = writer.write_all(frame.as_bytes()).await;
    let _ = writer.flush().await;
}

/// mock 会话的可变状态。
///
/// 真实 agent 的配置项是**会话级**的：`set_config_option` 改变它，后续 `session/new`
/// 之外的读取都反映新值。mock 保持同样语义，否则「切换后状态是否更新」测不出来。
#[derive(Debug)]
struct MockState {
    current_model: String,
    fast_mode: bool,
    /// 收到过的模型切换请求（按顺序）。端到端测试据此断言「客户端确实下发了」。
    model_switches: Vec<String>,
}

impl Default for MockState {
    fn default() -> Self {
        Self {
            current_model: DEFAULT_MODEL.to_string(),
            fast_mode: false,
            model_switches: Vec::new(),
        }
    }
}

/// Handle one client request. Returns `false` when the session should exit.
async fn handle_request<R, W>(
    msg: &Value,
    reader: &mut BufReader<R>,
    writer: &mut W,
    state: &mut MockState,
) -> bool
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = msg.get("id").and_then(|i| i.as_i64()).unwrap_or(0);
    match method {
        "initialize" => {
            send(
                writer,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": 1,
                        "agentInfo": { "name": "mockAgent", "version": "0.1.0" },
                        "agentCapabilities": {
                            "promptCapabilities": { "image": false, "audio": false, "embeddedContext": false }
                        },
                        "authMethods": []
                    }
                }),
            )
            .await;
        }
        "session/new" => {
            send(
                writer,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "sessionId": SESSION_ID,
                        "configOptions": config_options(&state.current_model, state.fast_mode)
                    }
                }),
            )
            .await;
        }
        // 模型切换与其它配置项走同一个协议方法。响应必须回**全量** configOptions
        // （协议强制），客户端据此整体替换本地状态。
        "session/set_config_option" => {
            let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
            let config_id = params
                .get("configId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let value = params.get("value").cloned().unwrap_or(Value::Null);

            if config_id == MODEL_CONFIG_ID {
                if let Some(model) = value.as_str() {
                    state.current_model = model.to_string();
                    state.model_switches.push(model.to_string());
                }
            } else if config_id == "fast-mode" {
                if let Some(flag) = value.as_bool() {
                    state.fast_mode = flag;
                }
            }
            // 其余 select 项（context-size / reasoning-effort）mock 只回显，不改行为。

            send(
                writer,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "configOptions": config_options(&state.current_model, state.fast_mode)
                    }
                }),
            )
            .await;
        }
        "session/prompt" => {
            // ── Simulated turn: 先输出意图 → 再执行工具 → 工具完成后输出文本 ──
            // 真实 agent 的流式语义：文本与工具调用按到达顺序穿插，每次工具调用
            // 前先输出意图（text_delta），工具执行完后再输出结果文本。

            // 1. Opening: announce the plan（先输出总体意图）
            update_chunk(
                writer,
                "Hi! Let me read a few key files and then make some changes.\n\n",
            )
            .await;

            // 2. 先输出意图：声明要读取 adapter.rs
            update_chunk(writer, "Let me read adapter.rs first.\n\n").await;

            // 3. 再执行工具：read_file
            tool_call(
                writer,
                "tc_1",
                "read_file",
                "src-tauri/src/agent/chat/adapter.rs",
                "running",
            )
            .await;
            tool_output(
                writer,
                "tc_1",
                "use async_trait::async_trait;\nuse tokio::sync::mpsc;\n\nuse crate::agent::chat::events::{SessionRequest, StreamEvent};\n// ... adapter implementation ...",
            )
            .await;
            tool_end(writer, "tc_1", "done").await;

            // 4. 工具完成后输出文本
            update_chunk(writer, "Read adapter.rs. Now I'll modify it.\n\n").await;

            // 5. 再执行下一个工具：edit_file（触发审批门）
            tool_call(
                writer,
                "tc_2",
                "edit_file",
                "src-tauri/src/agent/chat/adapter.rs",
                "running",
            )
            .await;

            // 5b. 审批门：请求修改权限（带 diff 预览）
            let diff_content = r#"@@ -15,7 +15,9 @@ use crate::agent::chat::events::{SessionRequest, StreamEvent};
 pub trait AgentAdapter: Send + Sync {
     /// Returns the agent kind this adapter handles.
     fn kind(&self) -> AgentKind;
-    /// Create a session bound to `ctx`.
+    /// Create a session bound to `ctx`. Spawns or connects internally.
+    /// Returns a boxed session that can be driven by the bridge.
     async fn create(&self, ctx: &AgentContext) -> Result<Box<dyn AgentSession>, AppError>;
+    /// Returns the capabilities declared by this agent.
+    fn capabilities(&self) -> Capabilities;
 }"#;

            send(
                writer,
                &json!({
                    "jsonrpc": "2.0",
                    "id": 100,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": SESSION_ID,
                        "toolCall": { "toolCallId": "tc_2", "toolName": "edit_file" },
                        "title": "src-tauri/src/agent/chat/adapter.rs",
                        "explanation": "mockAgent wants to edit adapter.rs: add a capabilities method to the AgentAdapter trait",
                        "diff": diff_content,
                        "options": [
                            { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
                            { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
                        ]
                    }
                }),
            )
            .await;

            let mut approved = false;
            if let Some(resp) = read_frame(reader).await {
                if let Ok(v) = serde_json::from_str::<Value>(&resp) {
                    let outcome = v
                        .get("result")
                        .and_then(|r| r.get("outcome"))
                        .and_then(|o| o.as_str())
                        .unwrap_or("");
                    approved = outcome == "allow-once";
                }
            }

            if approved {
                tool_output(
                    writer,
                    "tc_2",
                    &format!(
                        "Successfully applied edit to src-tauri/src/agent/chat/adapter.rs\n\n{}",
                        diff_content
                    ),
                )
                .await;
                tool_end(writer, "tc_2", "done").await;
                // 6. 工具完成后输出文本：审批结果 + 下一条意图合并为一条 text_delta
                update_chunk(
                    writer,
                    "✅ Approved. The edit is applied to adapter.rs. Now let me run a command to verify the change.\n\n",
                )
                .await;
            } else {
                tool_output(writer, "tc_2", "Edit rejected by user").await;
                tool_end(writer, "tc_2", "failed").await;
                update_chunk(writer, "❌ Edit rejected, skipping this step.\n\n").await;
            }

            // 7. Command execution
            command_run(
                writer,
                "cmd_1",
                "/Users/tomgs/RustroverProjects/neeko",
                "cargo check --message-format=json",
            )
            .await;

            // 7b. 审批门：请求运行命令权限
            send(
                writer,
                &json!({
                    "jsonrpc": "2.0",
                    "id": 101,
                    "method": "session/request_permission",
                    "params": {
                        "sessionId": SESSION_ID,
                        "toolCall": { "toolCallId": "tc_3", "toolName": "run_command" },
                        "title": "cargo check",
                        "explanation": "mockAgent wants to run cargo check to verify compilation",
                        "options": [
                            { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
                            { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
                        ]
                    }
                }),
            )
            .await;

            let mut cmd_approved = false;
            if let Some(resp) = read_frame(reader).await {
                if let Ok(v) = serde_json::from_str::<Value>(&resp) {
                    let outcome = v
                        .get("result")
                        .and_then(|r| r.get("outcome"))
                        .and_then(|o| o.as_str())
                        .unwrap_or("");
                    cmd_approved = outcome == "allow-once";
                }
            }

            if cmd_approved {
                // 命令执行结果走 tool_output/tool_end —— 前端以 Codex 风格终端块展示
                tool_output(
                    writer,
                    "cmd_1",
                    "Compiling neeko v1.0.6 (debug)\n   Finished `dev` profile [optimized] target(s) in 8.99s",
                )
                .await;
                tool_end(writer, "cmd_1", "done").await;
                // 8. 最终总结：编译结果 + 流程回顾合并为一条 text_delta
                update_chunk(
                    writer,
                    "✅ Compilation passed. This turn is complete! That was mockAgent's full simulated flow: file read, file edit (with diff approval), and command execution. Send another message to continue the conversation.\n\n",
                )
                .await;
            } else {
                tool_end(writer, "cmd_1", "failed").await;
                update_chunk(writer, "❌ Command execution rejected.\n\n").await;
            }

            // 9. Turn end
            send(
                writer,
                &json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": SESSION_ID,
                        "update": {
                            "sessionUpdate": "turn_end",
                            "turnId": "t1",
                            "reason": { "kind": "completed" }
                        }
                    }
                }),
            )
            .await;
        }
        "session/cancel" => {
            send(writer, &json!({ "jsonrpc": "2.0", "id": id, "result": {} })).await;
            return false;
        }
        _ => {
            // Unknown method: respond with a JSON-RPC error so the client
            // does not hang waiting.
            send(
                writer,
                &json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "error": { "code": -32601, "message": format!("method not found: {method}") } }
                }),
            )
            .await;
        }
    }
    true
}

async fn update_chunk<W: AsyncWrite + Unpin>(writer: &mut W, text: &str) {
    // 追加换行：真实 Agent（opencode / claude-code 等）的文本流按行/段落分隔，
    // mock 必须保持一致，否则前端把整段粘成一行，命令执行内容无法单独成行。
    let mut chunk = text.to_string();
    if !chunk.ends_with('\n') {
        chunk.push('\n');
    }
    send(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": SESSION_ID,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": chunk }
                }
            }
        }),
    )
    .await;
}

/// Emit a `tool_call` notification (tool start).
async fn tool_call<W: AsyncWrite + Unpin>(
    writer: &mut W,
    call_id: &str,
    name: &str,
    title: &str,
    status: &str,
) {
    send(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": SESSION_ID,
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": call_id,
                    "toolName": name,
                    "title": title,
                    "status": status
                }
            }
        }),
    )
    .await;
}

/// Emit a `tool_output` notification (incremental tool output).
async fn tool_output<W: AsyncWrite + Unpin>(writer: &mut W, call_id: &str, output: &str) {
    send(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": SESSION_ID,
                "update": {
                    "sessionUpdate": "tool_output",
                    "toolCallId": call_id,
                    "output": output
                }
            }
        }),
    )
    .await;
}

/// Emit a `tool_end` notification (tool call finished).
async fn tool_end<W: AsyncWrite + Unpin>(writer: &mut W, call_id: &str, status: &str) {
    send(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": SESSION_ID,
                "update": {
                    "sessionUpdate": "tool_end",
                    "toolCallId": call_id,
                    "status": status
                }
            }
        }),
    )
    .await;
}

/// Emit a `command_run` notification (agent wants to run a command).
async fn command_run<W: AsyncWrite + Unpin>(writer: &mut W, call_id: &str, cwd: &str, cmd: &str) {
    send(
        writer,
        &json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": SESSION_ID,
                "update": {
                    "sessionUpdate": "command_run",
                    "toolCallId": call_id,
                    "cwd": cwd,
                    "command": cmd
                }
            }
        }),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tokio::io::{AsyncWriteExt, BufReader};

    /// Send one Content-Length framed JSON-RPC message from the client side.
    async fn client_send<W: AsyncWrite + Unpin>(writer: &mut W, v: &Value) {
        let body = v.to_string();
        let frame = format!("Content-Length: {}\r\n\r\n{}", body.len(), body);
        writer
            .write_all(frame.as_bytes())
            .await
            .expect("write frame");
        writer.flush().await.expect("flush frame");
    }

    /// Normalize one `session/update` into a compact comparable string.
    fn normalize(kind: &str, update: &Value) -> String {
        match kind {
            "agent_message_chunk" => {
                let text = update["content"]["text"]
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                format!("text:{text}")
            }
            "tool_call" => format!(
                "tool_call:{}:{}",
                update["toolName"].as_str().unwrap_or(""),
                update["toolCallId"].as_str().unwrap_or("")
            ),
            "tool_output" => format!(
                "tool_output:{}",
                update["toolCallId"].as_str().unwrap_or("")
            ),
            "tool_end" => format!(
                "tool_end:{}:{}",
                update["toolCallId"].as_str().unwrap_or(""),
                update["status"].as_str().unwrap_or("")
            ),
            "command_run" => {
                format!(
                    "command_run:{}",
                    update["toolCallId"].as_str().unwrap_or("")
                )
            }
            "turn_end" => format!(
                "turn_end:{}",
                update["reason"]["kind"].as_str().unwrap_or("")
            ),
            other => format!("{other}:{update}"),
        }
    }

    /// Drive the mock ACP server for one `session/prompt` turn, auto-approving
    /// every `request_permission` request, and return the ordered normalized
    /// `session/update` sequence.
    async fn drive_mock_turn() -> Vec<String> {
        let (client, mock) = tokio::io::duplex(65536);
        let (mock_reader, mock_writer) = tokio::io::split(mock);
        tokio::spawn(run_mock_loop(mock_reader, mock_writer));
        let (client_reader, mut client_writer) = tokio::io::split(client);
        let mut reader = BufReader::new(client_reader);

        // Handshake: initialize → session/new → session/prompt.
        client_send(
            &mut client_writer,
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize"}),
        )
        .await;
        assert!(read_frame(&mut reader).await.is_some(), "initialize resp");
        client_send(
            &mut client_writer,
            &json!({"jsonrpc":"2.0","id":2,"method":"session/new"}),
        )
        .await;
        assert!(read_frame(&mut reader).await.is_some(), "session/new resp");
        client_send(
            &mut client_writer,
            &json!({
                "jsonrpc":"2.0","id":3,"method":"session/prompt",
                "params":{"sessionId":SESSION_ID,"prompt":[{"type":"text","text":"hi"}]}
            }),
        )
        .await;

        let mut updates = Vec::new();
        while let Some(body) = read_frame(&mut reader).await {
            let v: Value = serde_json::from_str(&body).expect("json frame");
            if let Some(method) = v.get("method").and_then(|m| m.as_str()) {
                match method {
                    "session/request_permission" => {
                        let id = v.get("id").and_then(|i| i.as_i64()).unwrap_or(0);
                        let call_id = v["params"]["toolCall"]["toolCallId"]
                            .as_str()
                            .unwrap_or("")
                            .to_string();
                        client_send(
                            &mut client_writer,
                            &json!({"jsonrpc":"2.0","id":id,"result":{"outcome":"allow-once"}}),
                        )
                        .await;
                        updates.push(format!("permission:{call_id}"));
                    }
                    "session/update" => {
                        let update = &v["params"]["update"];
                        let kind = update["sessionUpdate"].as_str().unwrap_or("").to_string();
                        let normalized = normalize(&kind, update);
                        let is_turn_end = kind == "turn_end";
                        updates.push(normalized);
                        if is_turn_end {
                            break;
                        }
                    }
                    _ => {}
                }
            }
        }
        updates
    }

    /// 回归测试：mockAgent 的输出流程必须遵循「先输出意图 → 再执行工具 → 工具
    /// 完成后输出文本 → 执行命令 → 最终总结」的流式顺序（对齐前端 mock 参考实现）。
    ///
    /// 期望序列（每条会话更新一条，审批门省略在 tool_output 之前的 request_permission）：
    /// 1. text: Hi! Let me read a few key files...
    /// 2. text: Let me read adapter.rs first.        ← 先输出意图
    /// 3. tool_call → tool_output → tool_end (read_file)
    /// 4. text: Read adapter.rs. Now I'll modify it.  ← 工具完成后输出文本
    /// 5. tool_call → tool_output → tool_end (edit_file)
    /// 6. text: ✅ Approved. The edit is applied to adapter.rs...
    /// 7. command_run → tool_output → tool_end
    /// 8. text: ✅ Compilation passed...
    #[tokio::test]
    async fn mock_output_flow_matches_expected_sequence() {
        let updates = drive_mock_turn().await;
        let expected = vec![
            "text:Hi! Let me read a few key files and then make some changes.".to_string(),
            "text:Let me read adapter.rs first.".to_string(),
            "tool_call:read_file:tc_1".to_string(),
            "tool_output:tc_1".to_string(),
            "tool_end:tc_1:done".to_string(),
            "text:Read adapter.rs. Now I'll modify it.".to_string(),
            "tool_call:edit_file:tc_2".to_string(),
            "permission:tc_2".to_string(),
            "tool_output:tc_2".to_string(),
            "tool_end:tc_2:done".to_string(),
            "text:✅ Approved. The edit is applied to adapter.rs. Now let me run a command to verify the change."
                .to_string(),
            "command_run:cmd_1".to_string(),
            "permission:tc_3".to_string(),
            "tool_output:cmd_1".to_string(),
            "tool_end:cmd_1:done".to_string(),
            "text:✅ Compilation passed. This turn is complete! That was mockAgent's full simulated flow: file read, file edit (with diff approval), and command execution. Send another message to continue the conversation."
                .to_string(),
            "turn_end:completed".to_string(),
        ];
        assert_eq!(updates, expected);
    }
}
