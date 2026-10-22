use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::agent::chat::adapter::AgentSession;
use crate::agent::chat::events::{SessionRequest, StreamEvent};
use crate::common::error::AppError;

pub(super) struct ServeSession {
    pub(super) event_rx: mpsc::Receiver<StreamEvent>,
    pub(super) request_tx: mpsc::Sender<SessionRequest>,
    pub(super) resume: Option<String>,
}

#[async_trait]
impl AgentSession for ServeSession {
    async fn next(&mut self) -> Option<Result<StreamEvent, AppError>> {
        self.event_rx.recv().await.map(Ok)
    }

    async fn send(&mut self, req: SessionRequest) -> Result<(), AppError> {
        self.request_tx
            .send(req)
            .await
            .map_err(|e| AppError::Io(format!("serve request channel closed: {e}")))
    }

    async fn cancel(&mut self) {
        let _ = self.send(SessionRequest::Cancel).await;
        self.event_rx.close();
    }

    fn resume_id(&self) -> Option<String> {
        self.resume.clone()
    }

    fn request_channel(&self) -> Option<mpsc::Sender<SessionRequest>> {
        Some(self.request_tx.clone())
    }
}
