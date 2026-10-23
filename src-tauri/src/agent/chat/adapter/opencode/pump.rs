use std::collections::{HashMap, HashSet};
use std::time::Duration;

use futures::StreamExt;
use tokio::sync::mpsc;

use crate::agent::chat::events::{DoneReason, StreamEvent};

use super::config_options::ConfigState;
use super::events_v1::{self, ServeEvent};
use super::events_v2::{self, V2State};
use super::eventurl::open_sse;
use super::protocol::ServeProtocol;

/// 泵循环需要的会话定位信息。
///
/// 五个参数（协议 / 地址 / 两个 id / 目录）在这个文件里**总是一起出现** ——
/// 它们共同回答「这条事件属于哪个会话」。合成一个类型有两个好处：
/// 参数列表回到可读范围，且「漏传一个」在类型层面不可能。
#[derive(Clone, Copy)]
pub(super) struct PumpTarget<'a> {
    pub(super) protocol: ServeProtocol,
    pub(super) base_url: &'a str,
    /// serve 侧的会话 id（事件里的 `sessionID` 与它比对）。
    pub(super) serve_sid: &'a str,
    /// Neeko 侧的会话 id（写进 `StreamEvent`）。
    pub(super) session_id: &'a str,
    /// 项目目录（V1 的 SSE 需要 `?directory=`）。
    pub(super) directory: &'a str,
}

/// 按协议分派的事件翻译器，**连带各自需要的跨事件状态**。
///
/// 把状态和分派放在一起，泵循环就只与 `Translator` 对话：
/// - 不需要知道 V1 要 `part_kinds`、V2 要 `tool_names`；
/// - 不需要在每次分派时写 `match protocol` —— 那会在泵里长出两套分支。
///
/// 这也是「高内聚」的落点：一个协议翻译所需的**全部**东西都在它自己那一支里。
pub(super) enum Translator {
    V1 {
        part_kinds: HashMap<String, events_v1::PartKind>,
        tool_started: HashSet<String>,
    },
    V2(V2State),
}

impl Translator {
    pub(super) fn for_protocol(protocol: ServeProtocol) -> Self {
        match protocol {
            ServeProtocol::V1 => Self::V1 {
                part_kinds: HashMap::new(),
                tool_started: HashSet::new(),
            },
            ServeProtocol::V2 => Self::V2(V2State::default()),
        }
    }

    /// 这条事件属于哪个会话。两版的包络不同，故由各协议自己回答。
    ///
    /// 泵只问「是不是我们这个会话的」，不感知 `properties` 与 `data` 的差别。
    fn session_of(&self, event: &ServeEvent) -> Option<String> {
        match self {
            Self::V1 { .. } => event
                .properties
                .get("sessionID")
                .and_then(|v| v.as_str())
                .map(str::to_string),
            Self::V2(_) => events_v2::session_of(event),
        }
    }

    fn translate(&mut self, session_id: &str, event: &ServeEvent) -> Vec<StreamEvent> {
        match self {
            Self::V1 {
                part_kinds,
                tool_started,
            } => events_v1::translate_event(session_id, event, part_kinds, tool_started),
            Self::V2(state) => events_v2::translate(session_id, event, state),
        }
    }
}

/// Maximum SSE reconnect attempts before the session is considered done.
const MAX_SSE_RETRIES: u32 = 5;
/// Delay between SSE reconnect attempts.
const SSE_RETRY_DELAY: Duration = Duration::from_millis(500);

pub(super) async fn run_event_pump(
    client: &reqwest::Client,
    target: PumpTarget<'_>,
    // V2 待答表单登记表（见 `ServeConnection::pending_forms`）。
    // V1 不用它；传同一个引用即可（V1 的 question id 不查表）。
    pending_forms: &std::sync::Mutex<HashMap<String, String>>,
    // 会话配置项状态。pump 是 `session.step.started` 的唯一读者，
    // 而那是「这一轮实际在用什么」的唯一来源 —— 由这里校正。
    config_state: &std::sync::Mutex<ConfigState>,
    event_tx: &mpsc::Sender<StreamEvent>,
) {
    let mut translator = Translator::for_protocol(target.protocol);
    let mut retries = 0u32;
    loop {
        let mut stream =
            match open_sse(client, target.protocol, target.base_url, target.directory).await {
                Ok(resp) => {
                    retries = 0;
                    resp.bytes_stream()
                }
                Err(e) => {
                    log::warn!("[ServeAdapter] SSE connect failed: {e}");
                    retries += 1;
                    if retries >= MAX_SSE_RETRIES {
                        break;
                    }
                    tokio::time::sleep(SSE_RETRY_DELAY).await;
                    continue;
                }
            };
        let mut buf: Vec<u8> = Vec::new();
        let mut stream_failed = false;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buf.extend_from_slice(&bytes);
                    if !process_buffered_lines(
                        &mut buf,
                        &mut translator,
                        target,
                        pending_forms,
                        config_state,
                        event_tx,
                    )
                    .await
                    {
                        // Event channel closed (session cancelled) → stop.
                        return;
                    }
                }
                Err(e) => {
                    log::warn!("[ServeAdapter] SSE stream error: {e}");
                    stream_failed = true;
                    break;
                }
            }
        }
        if stream_failed {
            retries += 1;
            if retries >= MAX_SSE_RETRIES {
                break;
            }
            tokio::time::sleep(SSE_RETRY_DELAY).await;
            continue;
        }
        // Clean EOF from the server → session is over.
        break;
    }
    let _ = event_tx
        .send(StreamEvent::SessionDone {
            session_id: target.session_id.into(),
            reason: DoneReason::Completed,
        })
        .await;
}

/// Process complete `\n`-delimited SSE lines, forwarding events that belong
/// to `serve_sid`. Returns `false` when the event channel is closed.
pub(super) async fn process_buffered_lines(
    buf: &mut Vec<u8>,
    translator: &mut Translator,
    target: PumpTarget<'_>,
    pending_forms: &std::sync::Mutex<HashMap<String, String>>,
    config_state: &std::sync::Mutex<ConfigState>,
    event_tx: &mpsc::Sender<StreamEvent>,
) -> bool {
    loop {
        let Some(pos) = buf.iter().position(|&b| b == b'\n') else {
            return true;
        };
        let line: Vec<u8> = buf.drain(..=pos).collect();
        let line = String::from_utf8_lossy(&line);
        let line = line.trim_end_matches(['\r', '\n']);
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<ServeEvent>(data) else {
            continue;
        };
        // `GET /event` is global — only forward events for this session.
        // 会话 id 的位置两版不同（V1 `properties.sessionID`，V2 `data.sessionID`），
        // 由 translator 自己回答，泵不感知形状差异。
        let Some(ev_session) = translator.session_of(&event) else {
            continue;
        };
        if ev_session != target.serve_sid {
            continue;
        }
        // V2 的 form 事件顺手登记 field key：回执在另一个 task 里需要它。
        if target.protocol == ServeProtocol::V2 && event.event_type == "form.created" {
            if let (Some(form_id), Some(key)) = (
                event
                    .properties
                    .get("form")
                    .and_then(|f| f.get("id"))
                    .and_then(|v| v.as_str()),
                events_v2::form_field_key(&event.properties),
            ) {
                if let Ok(mut map) = pending_forms.lock() {
                    map.insert(form_id.to_string(), key);
                }
            }
        }
        // `session.step.started` 是「这一轮实际在用什么」的唯一来源
        //（2.0 的会话详情不含 agent/model）。学到变化就回推，否则 resume
        // 一个曾切到 plan 的会话会显示 build。
        if target.protocol == ServeProtocol::V2 && event.event_type == "session.step.started" {
            let learned = config_state.lock().ok().map(|mut cfg| {
                if cfg.learn_from_step(&event.properties) {
                    Some(cfg.to_options())
                } else {
                    None
                }
            });
            if let Some(Some(options)) = learned {
                let update = StreamEvent::ConfigOptionUpdate {
                    session_id: target.session_id.into(),
                    config_options: options,
                };
                if event_tx.send(update).await.is_err() {
                    return false;
                }
            }
        }

        for sev in translator.translate(target.session_id, &event) {
            if event_tx.send(sev).await.is_err() {
                return false;
            }
        }
    }
}
