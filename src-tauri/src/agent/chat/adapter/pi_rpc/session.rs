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
use super::translate;
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
        let current = {
            let data = proc.request(json!({"type": "get_state"}), None).await?;
            CurrentSelection::from_state(&data)
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
                // 一期未接 `extension_ui_request` → 审批；声明 false 才不骗前端。
                approvals: false,
                command_echo: false,
                diff: false,
                resume: false,
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
            self.pending
                .extend(translate::translate(&self.session_id, &raw));
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
            // 其余请求在 Pi rpc 里没有对应动作。静默忽略而非报错 —— 调用方是通用
            // UI，它不知道各传输的能力差异，报错会变成「点了没用还弹错」。
            _ => Ok(()),
        }
    }

    async fn cancel(&mut self) {
        let _ = self.proc.send(json!({"type": "abort"})).await;
        self.proc.dispose();
    }

    fn resume_id(&self) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::chat::adapter::session_config::{
        find_by_category, CATEGORY_MODEL, CATEGORY_THOUGHT_LEVEL,
    };
    use serde_json::json;

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
        // 两条单向管道：session → pi（命令）与 pi → session（响应）。
        let (session_in, pi_in) = tokio::io::duplex(64 * 1024);
        let (pi_out, session_out) = tokio::io::duplex(64 * 1024);

        let handle = tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
            let mut write_half = pi_out;
            let mut lines = BufReader::new(pi_in).lines();
            let mut handshakes = 0usize;
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(cmd) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
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
                        "thinkingLevel": "high"
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
        (proc, handle)
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
