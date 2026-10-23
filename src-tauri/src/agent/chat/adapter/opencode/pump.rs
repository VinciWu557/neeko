use std::collections::{HashMap, HashSet};
use std::time::Duration;

use futures::StreamExt;
use tokio::sync::mpsc;

use crate::agent::chat::events::{DoneReason, StreamEvent};

use super::events_v1::{translate_event, PartKind, ServeEvent};
use super::eventurl::open_sse;

/// Maximum SSE reconnect attempts before the session is considered done.
const MAX_SSE_RETRIES: u32 = 5;
/// Delay between SSE reconnect attempts.
const SSE_RETRY_DELAY: Duration = Duration::from_millis(500);

pub(super) async fn run_event_pump(
    client: &reqwest::Client,
    base_url: &str,
    serve_sid: &str,
    session_id: &str,
    directory: &str,
    event_tx: &mpsc::Sender<StreamEvent>,
) {
    let mut part_kinds: HashMap<String, PartKind> = HashMap::new();
    let mut tool_started: HashSet<String> = HashSet::new();
    let mut retries = 0u32;
    loop {
        let mut stream = match open_sse(client, base_url, directory).await {
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
                        &mut part_kinds,
                        &mut tool_started,
                        session_id,
                        serve_sid,
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
            session_id: session_id.into(),
            reason: DoneReason::Completed,
        })
        .await;
}

/// Process complete `\n`-delimited SSE lines, forwarding events that belong
/// to `serve_sid`. Returns `false` when the event channel is closed.
pub(super) async fn process_buffered_lines(
    buf: &mut Vec<u8>,
    part_kinds: &mut HashMap<String, PartKind>,
    tool_started: &mut HashSet<String>,
    session_id: &str,
    serve_sid: &str,
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
        let Some(ev_session) = event.properties.get("sessionID").and_then(|v| v.as_str()) else {
            continue;
        };
        if ev_session != serve_sid {
            continue;
        }
        for sev in translate_event(session_id, &event, part_kinds, tool_started) {
            if event_tx.send(sev).await.is_err() {
                return false;
            }
        }
    }
}
