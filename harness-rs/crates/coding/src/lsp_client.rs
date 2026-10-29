//! Live Language Server Protocol client transport and lifecycle.
//!
//! The data-only parser lives in [`crate::lsp`]; this module only moves bytes
//! and manages a server process. [`LspClient::start`] wires the protocol to a
//! child process's stdio, while [`LspClient::with_transport`] accepts arbitrary
//! [`tokio::io::AsyncRead`]/[`tokio::io::AsyncWrite`] streams for embedding and
//! tests.
//!
//! A background reader task decodes every incoming frame, resolves JSON-RPC
//! responses, stores `textDocument/publishDiagnostics` notifications, and
//! answers server-initiated requests with `null` or `MethodNotFound`. Response
//! and diagnostics waits are bounded, so a dead or malformed server cannot
//! hang those waits even though the transport itself is read without per-read
//! timeouts. Writes rely on the transport backpressure and have no timeout.

use crate::lsp::{
    merge_lsp_diagnostics, parse_publish_diagnostics, path_to_file_uri, PublishDiagnosticsParams,
};
use crate::model::Diagnostic;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, PoisonError};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, watch, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Instant};

const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_EXIT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Connection settings for a language server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LspServerConfig {
    /// Executable spawned by [`LspClient::start`]. Ignored by
    /// [`LspClient::with_transport`].
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Workspace root as a `file://` URI.
    pub root_uri: String,
    #[serde(default)]
    pub initialization_options: Option<Value>,
}

type RpcResult = std::result::Result<Value, String>;
type SharedWriter = Arc<Mutex<Box<dyn AsyncWrite + Unpin + Send>>>;

struct Shared {
    pending: HashMap<u64, oneshot::Sender<RpcResult>>,
    diagnostics: HashMap<String, PublishDiagnosticsParams>,
    versions: HashMap<String, i64>,
    transport_error: Option<String>,
    closed: bool,
}

/// A live LSP client with a background frame reader.
pub struct LspClient {
    config: LspServerConfig,
    shared: Arc<Mutex<Shared>>,
    updates: watch::Sender<u64>,
    writer: SharedWriter,
    next_id: AtomicU64,
    tasks: StdMutex<Vec<JoinHandle<()>>>,
    child: StdMutex<Option<Child>>,
    shutdown_started: AtomicBool,
}

impl LspClient {
    /// Spawn a language server and connect to its stdio.
    ///
    /// The child is configured with `kill_on_drop`, so dropping the client
    /// eventually terminates a server that does not exit on its own.
    pub async fn start(config: LspServerConfig) -> Result<Self> {
        let mut command = Command::new(&config.program);
        command
            .args(&config.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);

        let mut child = command
            .spawn()
            .with_context(|| format!("spawn language server {:?}", config.program))?;
        let stdin = child
            .stdin
            .take()
            .context("language server stdin is unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("language server stdout is unavailable")?;
        let stderr = child
            .stderr
            .take()
            .context("language server stderr is unavailable")?;

        let client = Self::with_transport(stdout, stdin, config)?;
        {
            let mut slot = client.child.lock().unwrap_or_else(PoisonError::into_inner);
            *slot = Some(child);
        }

        let stderr_task = tokio::runtime::Handle::current().spawn(drain_stderr(stderr));
        client
            .tasks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(stderr_task);
        Ok(client)
    }

    /// Connect to an existing transport.
    ///
    /// `reader` and `writer` may be the two halves of one stream (as in
    /// `tokio::io::split`) or independent streams. A Tokio runtime must be
    /// active because the frame reader is spawned immediately.
    pub fn with_transport<R, W>(reader: R, writer: W, config: LspServerConfig) -> Result<Self>
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let handle = tokio::runtime::Handle::try_current()
            .context("LspClient::with_transport requires an active Tokio runtime")?;

        let shared = Arc::new(Mutex::new(Shared {
            pending: HashMap::new(),
            diagnostics: HashMap::new(),
            versions: HashMap::new(),
            transport_error: None,
            closed: false,
        }));
        let (updates, _) = watch::channel(0_u64);
        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(writer)));
        let reader_task = handle.spawn(read_loop(
            reader,
            shared.clone(),
            updates.clone(),
            writer.clone(),
        ));

        Ok(Self {
            config,
            shared,
            updates,
            writer,
            next_id: AtomicU64::new(0),
            tasks: StdMutex::new(vec![reader_task]),
            child: StdMutex::new(None),
            shutdown_started: AtomicBool::new(false),
        })
    }

    /// The connection settings used to build this client.
    pub fn config(&self) -> &LspServerConfig {
        &self.config
    }

    /// Perform the `initialize` handshake and send `initialized`.
    pub async fn initialize(&self) -> Result<Value> {
        let mut params = json!({
            "processId": std::process::id(),
            "clientInfo": {
                "name": "worldbase-coding",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "rootUri": self.config.root_uri,
            "capabilities": {
                "workspace": {
                    "configuration": true,
                    "workspaceFolders": true,
                },
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": false,
                        "didSave": false,
                    },
                    "publishDiagnostics": {
                        "relatedInformation": true,
                        "versionSupport": true,
                    },
                    "definition": { "linkSupport": true },
                    "documentSymbol": { "hierarchicalDocumentSymbolSupport": true },
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                },
            },
        });
        if let Some(options) = &self.config.initialization_options {
            params["initializationOptions"] = options.clone();
        }

        let result = self
            .request("initialize", params, DEFAULT_REQUEST_TIMEOUT)
            .await
            .context("LSP initialize failed")?;
        self.send_notification("initialized", json!({})).await?;
        Ok(result)
    }

    /// Announce a newly opened document using full-text synchronization.
    pub async fn open_document(&self, path: &Path, language_id: &str, text: &str) -> Result<()> {
        let uri = path_to_file_uri(path);
        let version = {
            let mut state = self.shared.lock().await;
            ensure_available(&state)?;
            let version = state
                .versions
                .get(&uri)
                .map_or(1, |version| version.saturating_add(1));
            state.versions.insert(uri.clone(), version);
            state.diagnostics.remove(&uri);
            version
        };
        self.updates
            .send_modify(|value| *value = value.wrapping_add(1));

        self.send_notification(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": uri,
                    "languageId": language_id,
                    "version": version,
                    "text": text,
                },
            }),
        )
        .await
    }

    /// Replace an open document's full text.
    pub async fn change_document(&self, path: &Path, text: &str) -> Result<()> {
        let uri = path_to_file_uri(path);
        let version = {
            let mut state = self.shared.lock().await;
            ensure_available(&state)?;
            let Some(version) = state.versions.get_mut(&uri) else {
                bail!("cannot change unopened document: {}", path.display());
            };
            *version = version.saturating_add(1);
            let version = *version;
            // A local edit invalidates the previous publish until the server
            // produces diagnostics for the new version.
            state.diagnostics.remove(&uri);
            version
        };
        self.updates
            .send_modify(|value| *value = value.wrapping_add(1));

        self.send_notification(
            "textDocument/didChange",
            json!({
                "textDocument": { "uri": uri, "version": version },
                "contentChanges": [{ "text": text }],
            }),
        )
        .await
    }

    /// Announce that a document was closed and discard its diagnostics.
    pub async fn close_document(&self, path: &Path) -> Result<()> {
        let uri = path_to_file_uri(path);
        {
            let mut state = self.shared.lock().await;
            ensure_available(&state)?;
            if state.versions.remove(&uri).is_none() {
                bail!("cannot close unopened document: {}", path.display());
            }
            state.diagnostics.remove(&uri);
        }
        self.updates
            .send_modify(|value| *value = value.wrapping_add(1));

        self.send_notification(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": uri } }),
        )
        .await
    }

    /// Wait for the most recent `publishDiagnostics` notification for `path`.
    ///
    /// The timeout covers both waits for the first publish and waits for a
    /// replacement publish. A prior publish remains visible until the document
    /// is changed or closed. Transport failures wake the wait immediately.
    pub async fn diagnostics_for(
        &self,
        path: &Path,
        wait: Duration,
    ) -> Result<PublishDiagnosticsParams> {
        let uri = path_to_file_uri(path);
        let deadline = Instant::now() + wait;
        let mut updates = self.updates.subscribe();

        loop {
            {
                let state = self.shared.lock().await;
                if state.closed {
                    bail!("LSP client is shut down");
                }
                // A publish that already arrived remains valid for the
                // document even if the transport failed afterwards.
                if let Some(params) = state.diagnostics.get(&uri) {
                    return Ok(params.clone());
                }
                if let Some(error) = &state.transport_error {
                    bail!("LSP transport failed while waiting for diagnostics for {uri}: {error}");
                }
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                bail!("timed out waiting for diagnostics for {uri}");
            }
            match timeout(remaining, updates.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => bail!("LSP diagnostics update channel closed"),
                Err(_) => bail!("timed out waiting for diagnostics for {uri}"),
            }
        }
    }

    /// Like [`Self::diagnostics_for`], but normalize through [`crate::lsp`].
    ///
    /// Duplicate diagnostics within one publish are removed by the existing
    /// [`merge_lsp_diagnostics`] helper.
    pub async fn normalized_diagnostics_for(
        &self,
        path: &Path,
        wait: Duration,
    ) -> Result<Vec<Diagnostic>> {
        let params = self.diagnostics_for(path, wait).await?;
        let value =
            serde_json::to_value(&params).context("serialize publishDiagnostics parameters")?;
        let diagnostics = parse_publish_diagnostics(&value)?;
        Ok(merge_lsp_diagnostics(&[], &diagnostics))
    }

    /// Request a graceful shutdown and release the transport.
    ///
    /// Cleanup always runs. An error from the `shutdown` request is returned
    /// after the child is reaped and background tasks are aborted.
    pub async fn shutdown(&mut self) -> Result<()> {
        if self.shutdown_started.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        let request_result = self
            .request("shutdown", Value::Null, SHUTDOWN_REQUEST_TIMEOUT)
            .await;
        let _ = self.send_notification("exit", Value::Null).await;

        {
            let mut writer = self.writer.lock().await;
            let _ = writer.shutdown().await;
        }

        {
            let mut state = self.shared.lock().await;
            state.closed = true;
            let pending = std::mem::take(&mut state.pending);
            drop(state);
            for (_, sender) in pending {
                let _ = sender.send(Err("LSP client shut down".to_string()));
            }
        }
        self.updates
            .send_modify(|value| *value = value.wrapping_add(1));

        let child = self
            .child
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let mut wait_error = None;
        if let Some(mut child) = child {
            match timeout(CHILD_EXIT_TIMEOUT, child.wait()).await {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => wait_error = Some(error),
                Err(_) => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                }
            }
        }

        self.abort_tasks();

        request_result?;
        if let Some(error) = wait_error {
            return Err(error).context("wait for language server exit");
        }
        Ok(())
    }

    async fn request(&self, method: &str, params: Value, wait: Duration) -> Result<Value> {
        let id = self
            .next_id
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        let (sender, receiver) = oneshot::channel();
        {
            let mut state = self.shared.lock().await;
            ensure_available(&state)?;
            state.pending.insert(id, sender);
        }

        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(error) = write_frame(&self.writer, &message).await {
            self.shared.lock().await.pending.remove(&id);
            record_failure(
                &self.shared,
                &self.updates,
                format!("failed to write {method} request: {error:#}"),
            )
            .await;
            return Err(error);
        }

        match timeout(wait, receiver).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(anyhow!(error)),
            Ok(Err(_)) => {
                self.shared.lock().await.pending.remove(&id);
                bail!("LSP connection closed while waiting for {method} response")
            }
            Err(_) => {
                self.shared.lock().await.pending.remove(&id);
                bail!("timed out waiting for LSP response to {method}")
            }
        }
    }

    async fn send_notification(&self, method: &str, params: Value) -> Result<()> {
        {
            let state = self.shared.lock().await;
            ensure_available(&state)?;
        }

        let message = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        if let Err(error) = write_frame(&self.writer, &message).await {
            record_failure(
                &self.shared,
                &self.updates,
                format!("failed to write {method} notification: {error:#}"),
            )
            .await;
            return Err(error);
        }
        Ok(())
    }

    fn abort_tasks(&self) {
        let mut tasks = self.tasks.lock().unwrap_or_else(PoisonError::into_inner);
        for task in tasks.drain(..) {
            task.abort();
        }
    }
}

impl Drop for LspClient {
    fn drop(&mut self) {
        self.abort_tasks();
    }
}

fn ensure_available(state: &Shared) -> Result<()> {
    if state.closed {
        bail!("LSP client is shut down");
    }
    if let Some(error) = &state.transport_error {
        bail!("LSP transport failed: {error}");
    }
    Ok(())
}

async fn drain_stderr<R>(mut stderr: R)
where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }
}

async fn read_loop<R>(
    reader: R,
    shared: Arc<Mutex<Shared>>,
    updates: watch::Sender<u64>,
    writer: SharedWriter,
) where
    R: AsyncRead + Unpin,
{
    let mut reader = BufReader::new(reader);
    loop {
        let frame = match read_frame(&mut reader).await {
            Ok(Some(frame)) => frame,
            Ok(None) => {
                record_failure(
                    &shared,
                    &updates,
                    "language server closed the connection".to_string(),
                )
                .await;
                return;
            }
            Err(error) => {
                record_failure(&shared, &updates, format!("{error:#}")).await;
                return;
            }
        };

        if let Err(error) = dispatch(frame, &shared, &updates, &writer).await {
            record_failure(&shared, &updates, format!("{error:#}")).await;
            return;
        }
    }
}

async fn dispatch(
    message: Value,
    shared: &Arc<Mutex<Shared>>,
    updates: &watch::Sender<u64>,
    writer: &SharedWriter,
) -> Result<()> {
    let Value::Object(object) = message else {
        bail!("malformed LSP message: expected a JSON object");
    };

    if let Some(method) = object.get("method").and_then(Value::as_str) {
        if object.contains_key("id") {
            let id = object.get("id").cloned().unwrap_or(Value::Null);
            let response = server_request_response(method, &id);
            write_frame(writer, &response)
                .await
                .context("respond to language server request")?;
        } else if method == "textDocument/publishDiagnostics" {
            let params: PublishDiagnosticsParams =
                serde_json::from_value(object.get("params").cloned().unwrap_or(Value::Null))
                    .context("invalid publishDiagnostics notification")?;
            let uri = params.uri.clone();
            let inserted = {
                let mut state = shared.lock().await;
                let stale = matches!(
                    (params.version, state.versions.get(&uri)),
                    (Some(published), Some(current)) if published < *current
                );
                if stale {
                    false
                } else {
                    state.diagnostics.insert(uri, params);
                    true
                }
            };
            if inserted {
                updates.send_modify(|value| *value = value.wrapping_add(1));
            }
        }
        return Ok(());
    }

    let Some(id) = object.get("id").and_then(Value::as_u64) else {
        return Ok(());
    };
    let sender = shared.lock().await.pending.remove(&id);
    let Some(sender) = sender else {
        return Ok(());
    };
    let outcome = if let Some(error) = object.get("error") {
        Err(jsonrpc_error_message(error))
    } else {
        Ok(object.get("result").cloned().unwrap_or(Value::Null))
    };
    let _ = sender.send(outcome);
    Ok(())
}

fn server_request_response(method: &str, id: &Value) -> Value {
    match method {
        "workspace/configuration"
        | "window/workDoneProgress/create"
        | "client/registerCapability"
        | "client/unregisterCapability"
        | "window/showMessageRequest"
        | "workspace/workspaceFolders"
        | "workspace/applyEdit" => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": Value::Null,
        }),
        _ => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": -32601,
                "message": format!("Method not found: {method}"),
            },
        }),
    }
}

fn jsonrpc_error_message(error: &Value) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("unknown JSON-RPC error");
    match error.get("code").and_then(Value::as_i64) {
        Some(code) => format!("LSP error {code}: {message}"),
        None => format!("LSP error: {message}"),
    }
}

async fn record_failure(
    shared: &Arc<Mutex<Shared>>,
    updates: &watch::Sender<u64>,
    message: String,
) {
    let pending = {
        let mut state = shared.lock().await;
        if state.transport_error.is_none() {
            state.transport_error = Some(message.clone());
        }
        std::mem::take(&mut state.pending)
    };
    for (_, sender) in pending {
        let _ = sender.send(Err(message.clone()));
    }
    updates.send_modify(|value| *value = value.wrapping_add(1));
}

async fn write_frame(writer: &SharedWriter, message: &Value) -> Result<()> {
    let body = serde_json::to_vec(message).context("serialize JSON-RPC message")?;
    let mut frame = Vec::with_capacity(body.len() + 32);
    frame.extend_from_slice(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
    frame.extend_from_slice(&body);

    let mut writer = writer.lock().await;
    writer.write_all(&frame).await.context("write LSP frame")?;
    writer.flush().await.context("flush LSP frame")
}

async fn read_frame<R>(reader: &mut R) -> Result<Option<Value>>
where
    R: AsyncRead + Unpin,
{
    let mut content_length = None;
    let mut header_bytes = 0_usize;

    loop {
        let remaining = MAX_HEADER_BYTES.saturating_sub(header_bytes);
        let Some(line) = read_header_line(reader, remaining).await? else {
            if header_bytes == 0 {
                return Ok(None);
            }
            bail!("unexpected EOF while reading LSP headers");
        };
        header_bytes += line.len();
        anyhow::ensure!(
            header_bytes <= MAX_HEADER_BYTES,
            "LSP headers exceed {MAX_HEADER_BYTES} bytes"
        );

        if line == b"\r\n" || line == b"\n" {
            break;
        }
        let line = std::str::from_utf8(&line).context("LSP header is not valid UTF-8")?;
        let (name, value) = line
            .split_once(':')
            .with_context(|| format!("malformed LSP header: {line:?}"))?;
        if name.trim().eq_ignore_ascii_case("content-length") {
            let value = value.trim();
            let length = value
                .parse::<usize>()
                .with_context(|| format!("invalid LSP Content-Length: {value}"))?;
            content_length = Some(length);
        }
    }

    let length = content_length.context("missing LSP Content-Length header")?;
    anyhow::ensure!(
        length <= MAX_FRAME_BYTES,
        "LSP frame of {length} bytes exceeds the {MAX_FRAME_BYTES}-byte limit"
    );
    let mut body = vec![0_u8; length];
    reader
        .read_exact(&mut body)
        .await
        .context("read LSP frame body")?;
    let value = serde_json::from_slice(&body).context("invalid JSON in LSP frame")?;
    Ok(Some(value))
}

async fn read_header_line<R>(reader: &mut R, limit: usize) -> Result<Option<Vec<u8>>>
where
    R: AsyncRead + Unpin,
{
    let mut line = Vec::new();
    loop {
        let mut byte = [0_u8; 1];
        let read = reader.read(&mut byte).await.context("read LSP header")?;
        if read == 0 {
            if line.is_empty() {
                return Ok(None);
            }
            bail!("unexpected EOF while reading LSP header");
        }
        line.push(byte[0]);
        if byte[0] == b'\n' {
            return Ok(Some(line));
        }
        anyhow::ensure!(line.len() <= limit, "LSP header line exceeds {limit} bytes");
    }
}
