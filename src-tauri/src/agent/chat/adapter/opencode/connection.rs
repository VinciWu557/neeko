use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::OnceCell;
use tokio::time::timeout;

use crate::common::error::AppError;
use crate::common::executor::factory::ExecTarget;
use crate::common::executor::BoxAsyncRead;
use crate::core::exec;

/// How long to wait for `opencode serve` to print its listening URL.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) struct ServeConnection {
    pub(super) base_url: String,
    pub(super) client: reqwest::Client,
}

pub(super) static SERVE_CONNECTION: OnceCell<Arc<ServeConnection>> = OnceCell::const_new();

/// Lazily start `opencode serve` once per process and return the shared
/// connection. Subsequent sessions reuse the same server (no kill on zero
/// sessions — the server lives as long as the app).
pub(super) async fn serve_connection() -> Result<&'static Arc<ServeConnection>, AppError> {
    SERVE_CONNECTION.get_or_try_init(start_serve).await
}

/// Spawn `opencode serve` via the unified exec facade (AGENTS.md red line 1),
/// wait for its listening URL, and keep the child alive + drained.
pub(super) async fn start_serve() -> Result<Arc<ServeConnection>, AppError> {
    log::info!("[ServeAdapter] starting `opencode serve`");
    let mut child = exec::spawn(
        &ExecTarget::Local,
        "opencode",
        &["serve", "--hostname", "127.0.0.1", "--port", "0"],
    )
    .await
    .map_err(|e| AppError::Io(format!("failed to spawn `opencode serve`: {e}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Io("`opencode serve` has no stdout".into()))?;
    let (base_url, stdout) = timeout(STARTUP_TIMEOUT, read_listening_url(stdout))
        .await
        .map_err(|_| AppError::Io("timed out waiting for `opencode serve` to start".into()))?
        .map_err(|e| AppError::Io(format!("failed to read serve startup: {e}")))?;
    log::info!("[ServeAdapter] `opencode serve` listening at {base_url}");

    // Keep the child alive and drain its stdio so the pipes never fill and
    // the process is reaped on app exit.
    let stderr = child.stderr.take();
    tokio::spawn(async move {
        let _ = drain_forever(stdout).await;
        if let Some(err) = stderr {
            let _ = drain_forever(err).await;
        }
        let _ = child.wait.await;
    });

    Ok(Arc::new(ServeConnection {
        base_url,
        client: reqwest::Client::new(),
    }))
}

/// Read `opencode serve` stdout lines until the listening URL appears.
/// Returns the URL plus the (still open) stream for the caller to drain.
pub(super) async fn read_listening_url(
    stdout: BoxAsyncRead,
) -> Result<(String, BoxAsyncRead), std::io::Error> {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "`opencode serve` exited before printing its URL",
            ));
        }
        let trimmed = line.trim();
        log::debug!("[ServeAdapter] serve stdout: {trimmed}");
        if let Some(url) = extract_listening_url(trimmed) {
            return Ok((url, reader.into_inner()));
        }
    }
}

/// Extract the listening URL from a serve startup line.
pub(super) fn extract_listening_url(line: &str) -> Option<String> {
    const MARKER: &str = "opencode server listening on ";
    let url = line.get(line.find(MARKER)? + MARKER.len()..)?.trim();
    if url.is_empty() {
        None
    } else {
        Some(url.to_string())
    }
}

/// Read a stream to EOF, discarding bytes (keeps the pipe open).
pub(super) async fn drain_forever(mut stream: BoxAsyncRead) {
    let mut buf = [0u8; 4096];
    loop {
        match stream.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

// ── Adapter + session ───────────────────────────────────────────────────────
