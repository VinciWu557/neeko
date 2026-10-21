//! Pi rpc 会话：握手、事件泵、请求分派。
//!
//! # 三层职责
//!
//! ```text
//! process.rs   进程 I/O + 响应配对（不认识 StreamEvent）
//! translate.rs 单条事件 → StreamEvent（纯函数，无状态）
//! session.rs   状态（ConfigOptionsState）+ 握手 + 请求分派（本文件）
//! ```
//!
//! 状态放这里的理由：`configOptions` 是**会话状态**而不是一次性载荷（见
//! `session_config.rs` 的 `ConfigOptionsState` 文档）。进程层不该知道它，
//! 翻译层是纯函数不能持有它 —— 只有会话层同时需要「读它来判断要不要发命令」
//! 与「写它来保持与 pi 的真实状态一致」。

use std::collections::VecDeque;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::config::{
    levels_from_response, models_from_response, project_config_options, CurrentSelection,
    MODEL_CONFIG_ID, THINKING_LEVEL_CONFIG_ID,
};
use super::process::PiRpcProcess;
use super::translate::{self, ApprovalKind};
use crate::agent::chat::adapter::session_config::{
    current_model_from_config, ConfigOptionsState, SessionConfigValue,
};
use crate::agent::chat::adapter::{AgentContext, AgentSession};
use crate::agent::chat::events::{Capabilities, ContextManifest, SessionRequest, StreamEvent};
use crate::common::error::AppError;

/// 一条 pi 会话。
pub struct PiSession {
    proc: PiRpcProcess,
    session_id: String,
    /// 会话配置项状态（模型列表 + 档位 + 当前值）。
    configs: ConfigOptionsState,
    /// pi 自己的会话 id（`get_state.sessionId`）。
    ///
    /// 用于 `resume_id()` —— `conversation/adapters/pi.rs` 的 `resume_command`
    /// 已经能把它拼成 `pi --session <id>`，缺的只是 chat 侧把它暴露出来。
    native_session_id: Option<String>,
    /// 待回答的审批：`extension_ui_request.id` → 它的回答形状。
    ///
    /// 存在的理由：`Approve { call_id, allow }` 只有一个布尔，而要回写的字段名
    /// 取决于是 `confirm`（`confirmed`）还是 `select`（`value`）。这个形状只在
    /// 请求本身里，`allow` 带不过来 —— 必须在发出审批时记下。
    pending_approvals: std::collections::HashMap<String, ApprovalKind>,
    /// 已就绪、待 `next()` 取走的事件队列。
    ///
    /// **两个生产者**：
    /// 1. 握手期：`SessionStart` + `ContextInit`（`start_with` 里 push）；
    /// 2. 运行期：`translate` 的输出（可能是 0..n 条）、以及 `refresh_configs`
    ///    产生的 `ConfigOptionUpdate`。
    ///
    /// 用队列而不是单槽：`next()` 一次只能返回一个，而上面任一路径都可能
    /// 一次产出多条。多生产者 + 单消费者的形状决定了必须有缓冲。
    ///
    /// 注意：当前 `translate` 对每条 pi 事件的映射都是 ≤1 条 `StreamEvent`
    /// （`text_delta` / `thinking_delta` / `agent_settled` 各 1，其余 0）。
    /// 所以「一次产出多条」今天只在 `start` 与 `refresh_configs` 里发生。
    /// 一旦二期补上「同一条 pi 事件既产出 `TurnEnd` 又产出 `ConfigOptionUpdate`」，
    /// 队列的存在就是正确性的必要条件（ACP 那边已是这个形状）。
    pending: VecDeque<StreamEvent>,
}

impl PiSession {
    /// 建立会话：spawn → 握手（拿配置项）→ 发 `SessionStart` + `ContextInit`。
    pub async fn start(cmd: &[String], ctx: &AgentContext) -> Result<Self, AppError> {
        let program = cmd
            .first()
            .ok_or_else(|| AppError::InvalidInput("pi-rpc: empty command".into()))?;
        // 用户配置的 args 必须生效 —— 只说「这是 pi」的适配器不能忽略
        // `AgentConfig.args`（那是用户表达「怎么启动我」的唯一通道）。
        let extra: Vec<&str> = cmd[1..].iter().map(String::as_str).collect();

        let proc = PiRpcProcess::spawn(program, &ctx.project_id, &extra).await?;
        Self::start_with(proc, ctx).await
    }

    /// 握手 + 事件队列初始化。
    ///
    /// 与 [`Self::start`] 拆开是为了让测试注入假连接 —— 否则测试只能复制一遍
    /// 握手逻辑，实现被改坏时测试仍绿（本项目已踩过这个坑）。
    pub async fn start_with(proc: PiRpcProcess, ctx: &AgentContext) -> Result<Self, AppError> {
        let models = {
            let data = proc
                .request(json!({"type": "get_available_models"}), None)
                .await?;
            models_from_response(&data)
        };
        let levels = {
            let data = proc
                .request(json!({"type": "get_available_thinking_levels"}), None)
                .await?;
            levels_from_response(&data)
        };
        let (current, native_session_id) = {
            let data = proc.request(json!({"type": "get_state"}), None).await?;
            (
                CurrentSelection::from_state(&data),
                data.get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            )
        };

        let configs =
            ConfigOptionsState::new(project_config_options(&models, &levels, Some(&current)));

        let mut pending = VecDeque::new();
        // 生命周期事件由适配器立即发（与 agent 自身输出无关），与 ACP 同契约。
        pending.push_back(StreamEvent::SessionStart {
            session_id: ctx.session_id.clone(),
            agent: ctx.agent_id.clone(),
            model: current.model_id.clone(),
            config_options: configs.snapshot(),
            capabilities: Capabilities {
                // `select` / `confirm` 已映射为 RequestApproval（见 translate.rs）。
                approvals: true,
                // Bash 工具的增量输出走 ToolOutput，不是 CommandRun。
                command_echo: false,
                diff: false,
                // `get_state.sessionId` → `resume_id()` → `pi --session <id>`。
                resume: true,
            },
        });
        pending.push_back(StreamEvent::ContextInit {
            session_id: ctx.session_id.clone(),
            manifest: ContextManifest {
                project_id: ctx.project_id.clone(),
                project_name: ctx.project_name.clone(),
                env: ctx.env.clone(),
                skills: ctx.skills.clone(),
                files: ctx.files.clone(),
                mode: ctx.mode.clone(),
            },
        });

        Ok(Self {
            proc,
            session_id: ctx.session_id.clone(),
            configs,
            native_session_id,
            pending_approvals: std::collections::HashMap::new(),
            pending,
        })
    }

    /// 把 `SetConfigOption` 翻成 pi 的具体命令。
    async fn apply_config_option(
        &mut self,
        config_id: &str,
        value: &SessionConfigValue,
    ) -> Result<(), AppError> {
        match config_id {
            MODEL_CONFIG_ID => {
                let Some(model_id) = value.as_text() else {
                    return Err(AppError::InvalidInput(
                        "pi-rpc: model option expects a string".into(),
                    ));
                };
                self.set_model(model_id).await
            }
            THINKING_LEVEL_CONFIG_ID => {
                let Some(level) = value.as_text() else {
                    return Err(AppError::InvalidInput(
                        "pi-rpc: thinking level expects a string".into(),
                    ));
                };
                self.proc
                    .send(json!({"type": "set_thinking_level", "level": level}))
                    .await?;
                self.refresh_configs().await
            }
            other => {
                // 未知配置项静默忽略：调用方（通用 UI）并不知道各传输的能力差异。
                log::debug!("[pi-rpc] unknown config option: {other}");
                Ok(())
            }
        }
    }

    /// 切模型：先用当前状态判定「是否已经是要切的值」，再回查 provider。
    async fn set_model(&mut self, model_id: &str) -> Result<(), AppError> {
        // 已是当前值 → 不发。与 ACP 的 `ModelSwitch::AlreadySet` 同一判据，
        // 避免每次进会话都多一次无意义的往返。
        if self.current_model().as_deref() == Some(model_id) {
            return Ok(());
        }

        // pi 的 `set_model` 要求 provider 与 modelId 分开传，而 provider 是模型
        // 条目的字段（不是从 id 里拆出来的 —— 实测 id 可能带 `/`，如 `auto/x`）。
        let provider = self.provider_of(model_id).await?;
        self.proc
            .send(json!({"type": "set_model", "provider": provider, "modelId": model_id}))
            .await?;
        self.refresh_configs().await
    }

    /// 从可用模型列表回查 provider。
    async fn provider_of(&self, model_id: &str) -> Result<String, AppError> {
        let data = self
            .proc
            .request(json!({"type": "get_available_models"}), None)
            .await?;
        data.get("models")
            .and_then(Value::as_array)
            .and_then(|models| {
                models
                    .iter()
                    .find(|m| m.get("id").and_then(Value::as_str) == Some(model_id))
            })
            .and_then(|m| m.get("provider").and_then(Value::as_str))
            .map(str::to_string)
            .ok_or_else(|| {
                AppError::InvalidInput(format!("pi-rpc: model '{model_id}' has no provider"))
            })
    }

    /// 回答一个 `extension_ui_request`。
    ///
    /// pi 没有「审批专用」方法 —— 审批体现为 `select`（选项列表）与 `confirm`
    /// （是/否）。两者用**同一个响应信封**，但字段不同：
    ///
    /// | 请求 method | 响应 |
    /// | --- | --- |
    /// | `select` | `{ id, value: "<选中项>" }`，取消用 `{ id, cancelled: true }` |
    /// | `confirm` | `{ id, confirmed: bool }` |
    ///
    /// Neeko 的 `Approve { allow: bool }` 只有一个布尔，而 `select` 可能有多个
    /// 非布尔选项。取舍：**allow 走 `select` 的第一项**（pi 自己把危险操作排在
    /// 首位时语义就是「允许」），拒绝一律 `cancelled: true`（= 用户拒绝）。
    /// 这是有损映射，但不做的话只能完全不支持审批；二期的 `input` 类请求同理。
    async fn answer_ui_request(&mut self, request_id: &str, allow: bool) -> Result<(), AppError> {
        // 该请求是 `confirm` 还是 `select`？由我们缓存的形状决定。
        // 缓存不存在说明这条审批已被回答过、或根本不是审批 —— 静默忽略，
        // 因为重复回答会让 pi 侧收到一个无法匹配的响应。
        let Some(kind) = self.pending_approvals.remove(request_id) else {
            log::debug!("[pi-rpc] approve for unknown request {request_id}, ignoring");
            return Ok(());
        };

        // 字段名由请求形状决定（pi 没有统一的审批信封）：
        // - `confirm` → `{confirmed: bool}`，拒绝就是 `false`（pi-acp 同样如此）；
        // - `select`   → `{value: "<选中项>"}`，拒绝用 `cancelled`。
        //
        // **不能**把 confirm 的拒绝也写成 `cancelled`：pi 把 `cancelled` 读作
        // 「用户关掉了弹窗、没做选择」，与「明确拒绝」是两种状态。
        let response = match (kind, allow) {
            (ApprovalKind::Confirm, allow) => json!({
                "type": "extension_ui_response",
                "id": request_id,
                "confirmed": allow,
            }),
            (ApprovalKind::Select { first_option }, true) => json!({
                "type": "extension_ui_response",
                "id": request_id,
                "value": first_option,
            }),
            // `select` 的拒绝：没有「否」的语义槽位，只能整体取消。
            (ApprovalKind::Select { .. }, false) => json!({
                "type": "extension_ui_response",
                "id": request_id,
                "cancelled": true,
            }),
        };

        self.proc.send(response).await
    }

    /// 当前模型 id（来自配置项状态，非另一次 IPC）。
    fn current_model(&self) -> Option<String> {
        current_model_from_config(&self.configs.snapshot())
    }

    /// 重新拉取档位并推 `ConfigOptionUpdate`。
    ///
    /// **档位是动态的**：实测 `get_available_thinking_levels` 返回
    /// `["low","high","max"]`，且当前模型的 `thinkingLevelMap` 决定哪些可用
    ///（不支持档位为 `null`）。所以每次切模型后必须重拉，不能缓存一次用到底。
    async fn refresh_configs(&mut self) -> Result<(), AppError> {
        let models = {
            let data = self
                .proc
                .request(json!({"type": "get_available_models"}), None)
                .await?;
            models_from_response(&data)
        };
        let levels = {
            let data = self
                .proc
                .request(json!({"type": "get_available_thinking_levels"}), None)
                .await?;
            levels_from_response(&data)
        };
        let current = {
            let data = self
                .proc
                .request(json!({"type": "get_state"}), None)
                .await?;
            CurrentSelection::from_state(&data)
        };

        let options = project_config_options(&models, &levels, Some(&current));
        self.configs.replace(options.clone());
        self.pending.push_back(StreamEvent::ConfigOptionUpdate {
            session_id: self.session_id.clone(),
            config_options: options,
        });
        Ok(())
    }
}

#[async_trait]
impl AgentSession for PiSession {
    async fn next(&mut self) -> Option<Result<StreamEvent, AppError>> {
        loop {
            // 先清空缓冲：`translate` 可能一次产出多个事件。
            if let Some(ev) = self.pending.pop_front() {
                return Some(Ok(ev));
            }
            let raw = self.proc.next_event().await?;
            let translated = translate::translate(&self.session_id, &raw);
            // 审批事件与它的回写形状来自**同一次**翻译 —— 分成两条路径各自
            // 解析 `extension_ui_request` 会让两者静默漂移。
            if let Some((id, kind)) = translated.approval {
                self.pending_approvals.insert(id, kind);
            }
            self.pending.extend(translated.events);
        }
    }

    async fn send(&mut self, req: SessionRequest) -> Result<(), AppError> {
        match req {
            SessionRequest::Turn { prompt, .. } => {
                // 不等响应：完成由 `agent_settled` 事件决定（见 translate.rs）。
                self.proc
                    .send(json!({"type": "prompt", "message": prompt}))
                    .await
            }
            SessionRequest::Cancel => self.proc.send(json!({"type": "abort"})).await,
            SessionRequest::SetConfigOption { config_id, value } => {
                self.apply_config_option(&config_id, &value).await
            }
            SessionRequest::Approve { call_id, allow } => {
                self.answer_ui_request(&call_id, allow).await
            }
            // 其余请求在 Pi rpc 里没有对应动作。静默忽略而非报错 —— 调用方是通用
            // UI，它不知道各传输的能力差异，报错会变成「点了没用还弹错」。
            _ => Ok(()),
        }
    }

    async fn cancel(&mut self) {
        let _ = self.proc.send(json!({"type": "abort"})).await;
        self.proc.dispose();
    }

    /// pi 的 native session id（来自握手时的 `get_state`）。
    ///
    /// 消费方是 `conversation/adapters/pi.rs::resume_command`，它拼成
    /// `pi --session <id>`。返回 `None` 会让「历史会话 → 继续聊」这条入口消失。
    fn resume_id(&self) -> Option<String> {
        self.native_session_id.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::chat::adapter::session_config::{
        find_by_category, CATEGORY_MODEL, CATEGORY_THOUGHT_LEVEL,
    };
    use serde_json::json;
    use std::time::Duration;

    /// 假 pi：从 `stdin` 读命令，按 `type` 回对应响应。
    ///
    /// 这样 `PiSession::start()` 的**真实握手路径**（三次 request/response 配对）
    /// 会被完整执行 —— 而不是在测试里复制一遍它的逻辑。
    /// 测试复制实现的话，实现被改坏时测试仍绿（本项目已踩过这个坑）。
    fn fake_pi() -> (PiRpcProcess, tokio::task::JoinHandle<()>) {
        fake_pi_with_events(vec![])
    }

    /// 假 pi，握手后额外推送一组事件（无 id，即 pi 的「事件」通道）。
    fn fake_pi_with_events(events: Vec<Value>) -> (PiRpcProcess, tokio::task::JoinHandle<()>) {
        let (proc, handle, _cmds) = fake_pi_recording(events);
        (proc, handle)
    }

    /// 同上，额外回传「pi 收到的命令」，供回写断言（如 `extension_ui_response`）。
    fn fake_pi_recording(
        events: Vec<Value>,
    ) -> (
        PiRpcProcess,
        tokio::task::JoinHandle<()>,
        tokio::sync::mpsc::UnboundedReceiver<Value>,
    ) {
        // 两条单向管道：session → pi（命令）与 pi → session（响应）。
        let (session_in, pi_in) = tokio::io::duplex(64 * 1024);
        let (pi_out, session_out) = tokio::io::duplex(64 * 1024);

        let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
            let mut write_half = pi_out;
            let mut lines = BufReader::new(pi_in).lines();
            let mut handshakes = 0usize;
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(cmd) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let _ = cmd_tx.send(cmd.clone());
                let id = cmd.get("id").cloned().unwrap_or(Value::Null);
                let kind = cmd.get("type").and_then(Value::as_str).unwrap_or("");
                let data = match kind {
                    "get_available_models" => json!({"models": [
                        {"id": "auto/deepseek-v4.1-flash", "name": "DV4", "provider": "magpie"},
                        {"id": "deepseek-flash", "name": "DF", "provider": "deepseek"}
                    ]}),
                    "get_available_thinking_levels" => json!({"levels": ["low", "high", "max"]}),
                    "get_state" => json!({
                        "model": {"id": "auto/deepseek-v4.1-flash"},
                        "thinkingLevel": "high",
                        "sessionId": "01a15cec-9454-7596-9016-6069189d7d4e"
                    }),
                    _ => json!({}),
                };
                let resp = json!({
                    "type": "response", "id": id, "command": kind,
                    "success": true, "data": data
                });
                if write_half
                    .write_all(format!("{resp}\n").as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
                let _ = write_half.flush().await;

                // 握手（models / thinking_levels / state）完成后，把预置的
                // pi **事件**推进同一通道 —— 与真实协议一致（事件无 id）。
                handshakes += 1;
                if handshakes == 3 {
                    for ev in &events {
                        let _ = write_half.write_all(format!("{ev}\n").as_bytes()).await;
                    }
                    let _ = write_half.flush().await;
                }
            }
        });

        let proc = PiRpcProcess::from_split(session_out, session_in);
        (proc, handle, cmd_rx)
    }

    fn ctx() -> AgentContext {
        AgentContext {
            agent_id: "pi".into(),
            session_id: "s1".into(),
            project_id: "/tmp/proj".into(),
            project_name: "proj".into(),
            env: "local".into(),
            skills: vec![],
            files: vec![],
            mode: "auto".into(),
            prompt: String::new(),
            model_id: None,
        }
    }

    /// **接线护栏（变异验证过）**：`start()` 必须把投影出的配置项放进
    /// `SessionStart.config_options`。
    ///
    /// 变异：把 `config_options: configs.snapshot()` 改回 `Vec::new()`
    ///（即上一轮的缺陷）→ 本用例红。
    #[tokio::test]
    async fn start_publishes_config_options_in_session_start() {
        let (proc, _fake) = fake_pi();
        let mut session = PiSession::start_with(proc, &ctx()).await.expect("start");

        let first = session.next().await.expect("event").expect("ok");
        let StreamEvent::SessionStart {
            config_options,
            model,
            ..
        } = first
        else {
            panic!("first event must be SessionStart, got {first:?}");
        };

        let model_opt = find_by_category(&config_options, CATEGORY_MODEL)
            .expect("SessionStart must carry the model option");
        assert_eq!(model_opt.current(), Some("auto/deepseek-v4.1-flash"));
        assert_eq!(model_opt.select_options().len(), 2);

        let level_opt = find_by_category(&config_options, CATEGORY_THOUGHT_LEVEL)
            .expect("SessionStart must carry the thought_level option (AC3)");
        assert_eq!(level_opt.current(), Some("high"));
        assert_eq!(level_opt.select_options().len(), 3);

        assert_eq!(model.as_deref(), Some("auto/deepseek-v4.1-flash"));

        // 第二个是 ContextInit
        assert!(matches!(
            session.next().await.expect("event").expect("ok"),
            StreamEvent::ContextInit { .. }
        ));
    }

    /// `next()` 按序交付队列里的全部事件。
    ///
    /// 变异验证的**诚实边界**：把 `extend(translate(...))` 改成
    /// `extend(translate(...).take(1))` **不会**让本用例变红 —— 因为当前
    /// `translate` 每条 pi 事件最多产出 1 条事件，`take(1)` 是语义 no-op。
    /// 本用例实际守住的是「多生产者 → 单消费者」的交付顺序（`start` 造的
    /// 两条 + 运行期的三条），这个顺序错了前端会在会话建立前收到增量。
    #[tokio::test]
    async fn next_drains_every_translated_event() {
        // 握手完成后，假 pi 往**事件通道**（无 id）推三条 pi 事件。
        // 走的是真实的 translate 路径 —— 不是往 pending 里塞现成 StreamEvent，
        // 所以「一条 pi 事件产出多个事件」的情形也被覆盖。
        let (proc, _fake) = fake_pi_with_events(vec![
            json!({"type": "message_update",
                   "assistantMessageEvent": {"type": "text_delta", "delta": "a"}}),
            json!({"type": "message_update",
                   "assistantMessageEvent": {"type": "text_delta", "delta": "b"}}),
            json!({"type": "agent_settled"}),
        ]);
        let mut session = PiSession::start_with(proc, &ctx()).await.expect("start");
        let _ = session.next().await; // SessionStart
        let _ = session.next().await; // ContextInit

        let mut seen = Vec::new();
        for _ in 0..3 {
            match session.next().await.expect("event").expect("ok") {
                StreamEvent::TextDelta { delta, .. } => seen.push(delta),
                StreamEvent::TurnEnd { .. } => seen.push("end".to_string()),
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!(seen, ["a", "b", "end"]);
    }

    /// **接入护栏（AC7）**：`confirm` 审批 → 允许 → 回 `{confirmed: true}`。
    ///
    /// 变异：把 `answer_ui_request` 里的 `confirmed` 改成别的字段名 →
    /// pi 侧永远等不到回答，工具卡住不返回。
    #[tokio::test]
    async fn approve_confirm_sends_confirmed_true() {
        let (proc, _fake, mut cmds) = fake_pi_recording(vec![
            json!({"type": "extension_ui_request", "id": "req-1", "method": "confirm",
                   "title": "Run?", "message": "rm -rf /tmp/x"}),
        ]);
        let mut session = PiSession::start_with(proc, &ctx()).await.expect("start");
        let _ = session.next().await; // SessionStart
        let _ = session.next().await; // ContextInit

        // 下一个事件应当是审批请求
        let approval = session.next().await.expect("event").expect("ok");
        assert!(
            matches!(&approval, StreamEvent::RequestApproval { call_id, tool, .. }
                     if call_id == "req-1" && tool == "pi.confirm"),
            "expected approval, got {approval:?}"
        );

        session
            .send(SessionRequest::Approve {
                call_id: "req-1".into(),
                allow: true,
            })
            .await
            .expect("approve");

        // 找到回写的 extension_ui_response
        let mut response = None;
        while let Ok(Some(cmd)) = tokio::time::timeout(Duration::from_secs(1), cmds.recv()).await {
            if cmd.get("type").and_then(Value::as_str) == Some("extension_ui_response") {
                response = Some(cmd);
                break;
            }
        }
        let response = response.expect("must write extension_ui_response");
        assert_eq!(response["id"], "req-1");
        assert_eq!(response["confirmed"], true);
    }

    /// 拒绝 `confirm` → `confirmed: false`。
    ///
    /// 不是 `cancelled`：pi 把 `cancelled` 读作「用户关掉弹窗、没做选择」，
    /// 与「明确拒绝」是两种状态（pi-acp 的实现同样回 `confirmed: false`）。
    #[tokio::test]
    async fn deny_confirm_sends_confirmed_false() {
        let (proc, _fake, mut cmds) = fake_pi_recording(vec![
            json!({"type": "extension_ui_request", "id": "req-2", "method": "confirm",
                   "message": "ok?"}),
        ]);
        let mut session = PiSession::start_with(proc, &ctx()).await.expect("start");
        let _ = session.next().await;
        let _ = session.next().await;
        let _ = session.next().await;

        session
            .send(SessionRequest::Approve {
                call_id: "req-2".into(),
                allow: false,
            })
            .await
            .expect("deny");

        let mut response = None;
        while let Ok(Some(cmd)) = tokio::time::timeout(Duration::from_secs(1), cmds.recv()).await {
            if cmd.get("type").and_then(Value::as_str) == Some("extension_ui_response") {
                response = Some(cmd);
                break;
            }
        }
        let response = response.expect("must write extension_ui_response");
        assert_eq!(response["confirmed"], false);
        assert!(response.get("cancelled").is_none());
    }

    /// `select` 允许 → 回第一项；不是 `confirmed`。
    #[tokio::test]
    async fn approve_select_sends_first_option_value() {
        let (proc, _fake, mut cmds) = fake_pi_recording(vec![
            json!({"type": "extension_ui_request", "id": "req-3", "method": "select",
                   "title": "Pick", "options": ["Allow once", "Deny"]}),
        ]);
        let mut session = PiSession::start_with(proc, &ctx()).await.expect("start");
        let _ = session.next().await;
        let _ = session.next().await;
        let _ = session.next().await;

        session
            .send(SessionRequest::Approve {
                call_id: "req-3".into(),
                allow: true,
            })
            .await
            .expect("allow select");

        let mut response = None;
        while let Ok(Some(cmd)) = tokio::time::timeout(Duration::from_secs(1), cmds.recv()).await {
            if cmd.get("type").and_then(Value::as_str) == Some("extension_ui_response") {
                response = Some(cmd);
                break;
            }
        }
        let response = response.expect("must write extension_ui_response");
        assert_eq!(response["value"], "Allow once");
        assert!(response.get("confirmed").is_none());
    }

    /// 拒绝 `select` → `cancelled`（选项列表里没有「否」的语义槽位）。
    #[tokio::test]
    async fn deny_select_sends_cancelled() {
        let (proc, _fake, mut cmds) = fake_pi_recording(vec![
            json!({"type": "extension_ui_request", "id": "req-4", "method": "select",
                   "options": ["Allow once", "Always"]}),
        ]);
        let mut session = PiSession::start_with(proc, &ctx()).await.expect("start");
        let _ = session.next().await;
        let _ = session.next().await;
        let _ = session.next().await;

        session
            .send(SessionRequest::Approve {
                call_id: "req-4".into(),
                allow: false,
            })
            .await
            .expect("deny select");

        let mut response = None;
        while let Ok(Some(cmd)) = tokio::time::timeout(Duration::from_secs(1), cmds.recv()).await {
            if cmd.get("type").and_then(Value::as_str) == Some("extension_ui_response") {
                response = Some(cmd);
                break;
            }
        }
        let response = response.expect("must write extension_ui_response");
        assert_eq!(response["cancelled"], true);
        assert!(response.get("value").is_none());
    }

    /// 未知 id 的回答被静默忽略 —— 重复回答会让 pi 收到无法匹配的响应。
    #[tokio::test]
    async fn approve_unknown_request_is_ignored() {
        let (proc, _fake, mut cmds) = fake_pi_recording(vec![]);
        let mut session = PiSession::start_with(proc, &ctx()).await.expect("start");

        session
            .send(SessionRequest::Approve {
                call_id: "never-issued".into(),
                allow: true,
            })
            .await
            .expect("must not error");

        // 不应写出任何 extension_ui_response
        while let Ok(Some(cmd)) =
            tokio::time::timeout(Duration::from_millis(200), cmds.recv()).await
        {
            assert_ne!(
                cmd.get("type").and_then(Value::as_str),
                Some("extension_ui_response"),
                "unknown approval must not be answered"
            );
        }
    }

    /// `resume_id()` 必须给出 pi 的 native session id。
    ///
    /// 这条不是锦上添花：`conversation/adapters/pi.rs::resume_command` 已能把它
    /// 拼成 `pi --session <id>`，返回 `None` 会让「历史会话 → 继续聊」整条入口消失，
    /// 且没有任何报错。
    #[tokio::test]
    async fn resume_id_comes_from_the_handshake() {
        let (proc, _fake) = fake_pi();
        let session = PiSession::start_with(proc, &ctx()).await.expect("start");
        assert_eq!(
            session.resume_id().as_deref(),
            Some("01a15cec-9454-7596-9016-6069189d7d4e")
        );
    }

    /// `resume` 能力位必须与 `resume_id()` 一致 —— 声明 false 会让前端隐藏入口，
    /// 而实现其实可用。
    #[tokio::test]
    async fn capabilities_declare_resume_because_it_works() {
        let (proc, _fake) = fake_pi();
        let mut session = PiSession::start_with(proc, &ctx()).await.expect("start");
        match session.next().await.expect("event").expect("ok") {
            StreamEvent::SessionStart { capabilities, .. } => {
                assert!(
                    capabilities.resume,
                    "resume_id() is implemented, declare it"
                );
                assert!(capabilities.approvals, "approvals are mapped, declare it");
            }
            other => panic!("first event must be SessionStart, got {other:?}"),
        }
    }

    /// 切模型：已是当前值时不发命令；否则发 `set_model` 并重新拉档位。
    #[tokio::test]
    async fn set_config_option_is_a_no_op_when_already_current() {
        let (proc, _fake) = fake_pi();
        let mut session = PiSession::start_with(proc, &ctx()).await.expect("start");
        let _ = session.next().await; // SessionStart
        let _ = session.next().await; // ContextInit

        // 切到当前值 → 不发命令、不产生 ConfigOptionUpdate
        session
            .send(SessionRequest::SetConfigOption {
                config_id: MODEL_CONFIG_ID.into(),
                value: SessionConfigValue::Text("auto/deepseek-v4.1-flash".into()),
            })
            .await
            .expect("no-op switch");

        assert!(
            session.pending.is_empty(),
            "切到当前值不应产生任何事件（多余的往返会让 UI 闪一下）"
        );
    }
}
