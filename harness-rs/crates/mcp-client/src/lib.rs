//! MCP (Model Context Protocol) client used by the Rust harness.
//!
//! Electron owns configuration UI, but the selected Rust harness owns MCP
//! connections, discovery and execution. Configurations intentionally carry
//! Electron's server ID, working directory, headers and timeout unchanged so
//! a Rust-selected run does not silently fall back to the TypeScript client.

use anyhow::{bail, Context, Result};
use futures::StreamExt;
use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{oneshot, watch, Mutex, Notify};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    /// Electron's durable server ID. This is the value carried in tool calls.
    pub name: String,
    /// Human-facing server name, retained for model descriptions and results.
    #[serde(default)]
    pub display_name: String,
    /// "stdio", "http"/"streamable-http", or "sse".
    pub transport: String,
    /// stdio executable command or remote endpoint URL.
    pub target: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub enabled: bool,
}

impl McpServerConfig {
    fn timeout(&self) -> Duration {
        Duration::from_millis(
            self.timeout_ms
                .unwrap_or(DEFAULT_TIMEOUT_MS)
                .clamp(1_000, 300_000),
        )
    }

    fn display_name_or_id(&self) -> String {
        let display_name = self.display_name.trim();
        if display_name.is_empty() {
            self.name.clone()
        } else {
            display_name.to_string()
        }
    }
}

impl<'de> Deserialize<'de> for McpServerConfig {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        // Electron sends a compact bridge shape (`name` + `target`), while
        // Flutter persists the settings shape (`id` + `command`/`url`).
        // Parse both here so direct mobile `mcp.reload` calls cannot silently
        // discard every configured server before `mcp_call` runs.
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct RawMcpServerConfig {
            #[serde(default)]
            id: Option<String>,
            #[serde(default)]
            name: Option<String>,
            #[serde(default)]
            #[serde(alias = "display_name")]
            display_name: Option<String>,
            #[serde(default)]
            transport: String,
            #[serde(default)]
            target: Option<String>,
            #[serde(default)]
            command: Option<String>,
            #[serde(default)]
            url: Option<String>,
            #[serde(default)]
            args: Vec<String>,
            #[serde(default)]
            cwd: Option<String>,
            #[serde(default)]
            env: BTreeMap<String, String>,
            #[serde(default)]
            headers: BTreeMap<String, String>,
            #[serde(default)]
            #[serde(alias = "timeout_ms")]
            timeout_ms: Option<u64>,
            #[serde(default)]
            enabled: bool,
        }

        let raw = RawMcpServerConfig::deserialize(deserializer)?;
        let durable_name = raw
            .id
            .clone()
            .or_else(|| raw.name.clone())
            .unwrap_or_default();
        let name = durable_name.trim().to_string();
        if name.is_empty() {
            return Err(de::Error::custom("MCP server requires id or name"));
        }

        let display_name = raw
            .display_name
            .filter(|value| !value.trim().is_empty())
            // Flutter's persisted shape uses `name` for the human-facing
            // label and `id` for the durable identifier.
            .or_else(|| {
                raw.id
                    .is_some()
                    .then(|| raw.name.clone().unwrap_or_default())
            })
            .unwrap_or_default();
        let target = raw
            .target
            .or_else(|| raw.command.clone())
            .or_else(|| raw.url.clone())
            .unwrap_or_default();
        let transport = raw.transport.trim().to_string();
        if transport.is_empty() {
            return Err(de::Error::custom("MCP server requires transport"));
        }
        Ok(Self {
            name,
            display_name,
            transport,
            target,
            args: raw.args,
            cwd: raw.cwd,
            env: raw.env,
            headers: raw.headers,
            timeout_ms: raw.timeout_ms,
            enabled: raw.enabled,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    /// Durable MCP server ID.
    pub server: String,
    pub server_name: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub transport: String,
    pub status: String,
}

/// MCP tool metadata in the same shape Electron Settings renders. The local
/// name is deliberately stable across Rust and TypeScript so saved agent tool
/// policies continue to apply after changing harnesses.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolSummary {
    pub name: String,
    pub local_name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceSummary {
    pub uri: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPromptArgumentSummary {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPromptSummary {
    pub name: String,
    pub description: String,
    pub arguments: Vec<McpPromptArgumentSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCapabilities {
    pub tools: bool,
    pub resources: bool,
    pub prompts: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerSnapshot {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub transport: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub updated_at: Option<String>,
    pub tools: Vec<McpToolSummary>,
    pub resources: Vec<McpResourceSummary>,
    pub prompts: Vec<McpPromptSummary>,
    pub capabilities: McpCapabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStateSnapshot {
    pub servers: Vec<McpServerSnapshot>,
    pub updated_at: String,
}

#[derive(Clone)]
struct McpServerMetadata {
    status: String,
    error: Option<String>,
    updated_at: Option<String>,
    tools: Vec<McpToolSummary>,
    resources: Vec<McpResourceSummary>,
    prompts: Vec<McpPromptSummary>,
    capabilities: McpCapabilities,
}

impl Default for McpServerMetadata {
    fn default() -> Self {
        Self {
            status: "disconnected".into(),
            error: None,
            updated_at: None,
            tools: Vec::new(),
            resources: Vec::new(),
            prompts: Vec::new(),
            capabilities: McpCapabilities {
                tools: false,
                resources: false,
                prompts: false,
            },
        }
    }
}

/// Shared state for a legacy MCP SSE stream. The server publishes an
/// `endpoint` event asynchronously; JSON-RPC POSTs wait for it and receive
/// their responses back through the same long-lived event stream.
#[doc(hidden)]
pub struct LegacySseState {
    endpoint: Mutex<Option<String>>,
    endpoint_ready: Notify,
    pending: Mutex<BTreeMap<i64, oneshot::Sender<std::result::Result<Value, String>>>>,
}

impl LegacySseState {
    fn new() -> Self {
        Self {
            endpoint: Mutex::new(None),
            endpoint_ready: Notify::new(),
            pending: Mutex::new(BTreeMap::new()),
        }
    }
}

/// A connected MCP server. Stdio and streamable HTTP use request/response
/// JSON-RPC, while legacy SSE keeps a server event stream open and posts to
/// the endpoint the server advertises from that stream.
pub enum McpConnection {
    Stdio {
        name: String,
        display_name: String,
        #[allow(dead_code)]
        child: Mutex<Child>,
        stdin: Mutex<tokio::process::ChildStdin>,
        reader: Mutex<BufReader<tokio::process::ChildStdout>>,
        next_id: AtomicI64,
        timeout: Duration,
    },
    Http {
        name: String,
        display_name: String,
        endpoint: String,
        client: reqwest::Client,
        next_id: AtomicI64,
        session_id: Mutex<Option<String>>,
    },
    Sse {
        name: String,
        display_name: String,
        client: reqwest::Client,
        next_id: AtomicI64,
        timeout: Duration,
        state: Arc<LegacySseState>,
        cancel: watch::Sender<bool>,
    },
}

impl McpConnection {
    pub fn name(&self) -> &str {
        match self {
            McpConnection::Stdio { name, .. }
            | McpConnection::Http { name, .. }
            | McpConnection::Sse { name, .. } => name,
        }
    }

    pub fn display_name(&self) -> &str {
        match self {
            McpConnection::Stdio { display_name, .. }
            | McpConnection::Http { display_name, .. }
            | McpConnection::Sse { display_name, .. } => display_name,
        }
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        match self {
            McpConnection::Stdio {
                stdin,
                reader,
                next_id,
                timeout,
                ..
            } => {
                let mut stdin = stdin.lock().await;
                let id = next_id.fetch_add(1, Ordering::SeqCst);
                let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
                let mut line = serde_json::to_string(&req)?;
                line.push('\n');
                stdin.write_all(line.as_bytes()).await?;
                stdin.flush().await?;

                let mut reader = reader.lock().await;
                loop {
                    let raw = tokio::time::timeout(*timeout, reader.read_line_result())
                        .await
                        .map_err(|_| anyhow::anyhow!("mcp stdio timeout"))??;
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let value: Value = serde_json::from_str(trimmed).context("mcp stdio parse")?;
                    if value.get("id").and_then(Value::as_i64) == Some(id) {
                        if let Some(error) = value.get("error") {
                            bail!("mcp error: {error}");
                        }
                        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                    }
                }
            }
            McpConnection::Http {
                endpoint,
                client,
                next_id,
                session_id,
                ..
            } => {
                let id = next_id.fetch_add(1, Ordering::SeqCst);
                let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
                let session = session_id.lock().await.clone();
                let mut request = client
                    .post(endpoint)
                    .header(
                        reqwest::header::ACCEPT,
                        "application/json, text/event-stream",
                    )
                    .json(&req);
                if let Some(session) = session {
                    request = request.header("mcp-session-id", session);
                }
                let response = request
                    .send()
                    .await
                    .context("mcp http request")?
                    .error_for_status()
                    .context("mcp http response")?;
                if let Some(session) = response
                    .headers()
                    .get("mcp-session-id")
                    .and_then(|value| value.to_str().ok())
                    .filter(|value| !value.trim().is_empty())
                {
                    *session_id.lock().await = Some(session.to_string());
                }
                let is_sse = response
                    .headers()
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .map(|value| value.to_ascii_lowercase().starts_with("text/event-stream"))
                    .unwrap_or(false);
                let value = if is_sse {
                    read_sse_response(response, id).await?
                } else {
                    response.json().await.context("mcp http parse")?
                };
                if let Some(error) = value.get("error") {
                    bail!("mcp error: {error}");
                }
                Ok(value.get("result").cloned().unwrap_or(Value::Null))
            }
            McpConnection::Sse {
                client,
                next_id,
                timeout,
                state,
                ..
            } => request_over_legacy_sse(client, next_id, *timeout, state, method, params).await,
        }
    }

    /// MCP requires the client to acknowledge a successful `initialize`
    /// response before it sends ordinary requests. Keep notifications separate
    /// from `request`: JSON-RPC notifications intentionally have no id and no
    /// response body to parse.
    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        match self {
            McpConnection::Stdio { stdin, .. } => {
                let mut stdin = stdin.lock().await;
                let notification = json!({
                    "jsonrpc": "2.0",
                    "method": method,
                    "params": params,
                });
                let mut line = serde_json::to_string(&notification)?;
                line.push('\n');
                stdin.write_all(line.as_bytes()).await?;
                stdin.flush().await?;
            }
            McpConnection::Http {
                endpoint,
                client,
                session_id,
                ..
            } => {
                let notification = json!({
                    "jsonrpc": "2.0",
                    "method": method,
                    "params": params,
                });
                let session = session_id.lock().await.clone();
                let mut request = client
                    .post(endpoint)
                    .header(
                        reqwest::header::ACCEPT,
                        "application/json, text/event-stream",
                    )
                    .json(&notification);
                if let Some(session) = session {
                    request = request.header("mcp-session-id", session);
                }
                let response = request
                    .send()
                    .await
                    .context("mcp http notification")?
                    .error_for_status()
                    .context("mcp http notification response")?;
                if let Some(session) = response
                    .headers()
                    .get("mcp-session-id")
                    .and_then(|value| value.to_str().ok())
                    .filter(|value| !value.trim().is_empty())
                {
                    *session_id.lock().await = Some(session.to_string());
                }
            }
            McpConnection::Sse {
                client,
                timeout,
                state,
                ..
            } => notify_over_legacy_sse(client, *timeout, state, method, params).await?,
        }
        Ok(())
    }

    pub async fn initialize(&self) -> Result<Value> {
        let result = self
            .request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "worldbase-harness", "version": env!("CARGO_PKG_VERSION") },
            }),
        )
        .await?;
        self.notify("notifications/initialized", json!({})).await?;
        Ok(result)
    }

    pub async fn list_tools(&self) -> Result<Vec<McpTool>> {
        let result = self.request("tools/list", json!({})).await?;
        let mut out = Vec::new();
        if let Some(tools) = result.get("tools").and_then(Value::as_array) {
            for tool in tools {
                out.push(McpTool {
                    server: self.name().to_string(),
                    server_name: self.display_name().to_string(),
                    name: tool
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    description: tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    input_schema: tool
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({ "type": "object" })),
                });
            }
        }
        Ok(out)
    }

    pub async fn call_tool(&self, tool: &str, args: Value) -> Result<Value> {
        self.request("tools/call", json!({ "name": tool, "arguments": args }))
            .await
    }

    pub async fn list_resources(&self) -> Result<Vec<Value>> {
        let result = self.request("resources/list", json!({})).await?;
        Ok(result
            .get("resources")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    pub async fn read_resource(&self, uri: &str) -> Result<Value> {
        self.request("resources/read", json!({ "uri": uri })).await
    }

    pub async fn list_prompts(&self) -> Result<Vec<Value>> {
        let result = self.request("prompts/list", json!({})).await?;
        Ok(result
            .get("prompts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    pub async fn get_prompt(&self, name: &str, arguments: Value) -> Result<Value> {
        self.request(
            "prompts/get",
            json!({ "name": name, "arguments": arguments }),
        )
        .await
    }
}

impl Drop for McpConnection {
    fn drop(&mut self) {
        if let McpConnection::Sse { cancel, .. } = self {
            let _ = cancel.send(true);
        }
    }
}

async fn legacy_sse_endpoint(state: &LegacySseState, timeout: Duration) -> Result<String> {
    loop {
        // Register before inspecting state so an endpoint event cannot race
        // between the check and the wait.
        let notified = state.endpoint_ready.notified();
        if let Some(endpoint) = state.endpoint.lock().await.clone() {
            return Ok(endpoint);
        }
        tokio::time::timeout(timeout, notified)
            .await
            .map_err(|_| anyhow::anyhow!("mcp legacy SSE endpoint timeout"))?;
    }
}

async fn remove_legacy_pending(state: &LegacySseState, id: i64) {
    state.pending.lock().await.remove(&id);
}

fn rpc_result(value: Value) -> Result<Value> {
    if let Some(error) = value.get("error") {
        bail!("mcp error: {error}");
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

async fn request_over_legacy_sse(
    client: &reqwest::Client,
    next_id: &AtomicI64,
    timeout: Duration,
    state: &LegacySseState,
    method: &str,
    params: Value,
) -> Result<Value> {
    let id = next_id.fetch_add(1, Ordering::SeqCst);
    let (sender, receiver) = oneshot::channel();
    state.pending.lock().await.insert(id, sender);

    let endpoint = match legacy_sse_endpoint(state, timeout).await {
        Ok(endpoint) => endpoint,
        Err(error) => {
            remove_legacy_pending(state, id).await;
            return Err(error);
        }
    };
    let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
    let response = match tokio::time::timeout(
        timeout,
        client
            .post(&endpoint)
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .json(&request)
            .send(),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            remove_legacy_pending(state, id).await;
            return Err(error).context("mcp legacy SSE request");
        }
        Err(_) => {
            remove_legacy_pending(state, id).await;
            bail!("mcp legacy SSE request timeout");
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        remove_legacy_pending(state, id).await;
        bail!("mcp legacy SSE response ({status}): {body}");
    }

    // Some compatible servers reply directly to POST even when configured as
    // legacy SSE. Honor that response first; normative legacy servers return
    // 202/empty and deliver this JSON-RPC response through the GET stream.
    let direct_json = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase().starts_with("application/json"))
        .unwrap_or(false);
    if direct_json {
        let direct_body = tokio::time::timeout(timeout, response.bytes())
            .await
            .map_err(|_| anyhow::anyhow!("mcp legacy SSE direct response timeout"))?
            .context("read mcp SSE POST response")?;
        if let Ok(value) = serde_json::from_slice::<Value>(&direct_body) {
            if value.get("id").and_then(Value::as_i64) == Some(id) {
                remove_legacy_pending(state, id).await;
                return rpc_result(value);
            }
        }
    }

    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(Ok(value))) => rpc_result(value),
        Ok(Ok(Err(error))) => bail!("mcp legacy SSE: {error}"),
        Ok(Err(_)) => bail!("mcp legacy SSE response channel closed"),
        Err(_) => {
            remove_legacy_pending(state, id).await;
            bail!("mcp legacy SSE response timeout");
        }
    }
}

async fn notify_over_legacy_sse(
    client: &reqwest::Client,
    timeout: Duration,
    state: &LegacySseState,
    method: &str,
    params: Value,
) -> Result<()> {
    let endpoint = legacy_sse_endpoint(state, timeout).await?;
    let notification = json!({ "jsonrpc": "2.0", "method": method, "params": params });
    let response = tokio::time::timeout(
        timeout,
        client
            .post(&endpoint)
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .json(&notification)
            .send(),
    )
    .await
    .map_err(|_| anyhow::anyhow!("mcp legacy SSE notification timeout"))?
    .context("mcp legacy SSE notification")?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        bail!("mcp legacy SSE notification response ({status}): {body}");
    }
    Ok(())
}

fn legacy_sse_event_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    for index in 0..buffer.len().saturating_sub(1) {
        if buffer[index..].starts_with(b"\n\n") {
            return Some((index, 2));
        }
        if buffer[index..].starts_with(b"\r\n\r\n") {
            return Some((index, 4));
        }
    }
    None
}

fn resolve_legacy_sse_endpoint(stream_url: &str, endpoint: &str) -> Result<String> {
    let endpoint = endpoint.trim();
    anyhow::ensure!(!endpoint.is_empty(), "mcp legacy SSE endpoint is empty");
    if reqwest::Url::parse(endpoint).is_ok() {
        return Ok(endpoint.to_string());
    }
    reqwest::Url::parse(stream_url)
        .context("parse mcp legacy SSE stream URL")?
        .join(endpoint)
        .context("resolve mcp legacy SSE endpoint")
        .map(|url| url.to_string())
}

async fn dispatch_legacy_sse_event(
    event: &[u8],
    stream_url: &str,
    state: &LegacySseState,
) -> Result<()> {
    let event = std::str::from_utf8(event).context("decode mcp legacy SSE event")?;
    let normalized = event.replace("\r\n", "\n");
    let mut event_name = "message";
    let mut data = Vec::new();
    for line in normalized.lines() {
        if line.starts_with(':') {
            continue;
        }
        if let Some(value) = line.strip_prefix("event:") {
            event_name = value.trim();
        } else if let Some(value) = line.strip_prefix("data:") {
            data.push(value.trim_start());
        }
    }
    let data = data.join("\n");
    if data.is_empty() || data == "[DONE]" {
        return Ok(());
    }
    if event_name == "endpoint" {
        let endpoint = resolve_legacy_sse_endpoint(stream_url, &data)?;
        *state.endpoint.lock().await = Some(endpoint);
        state.endpoint_ready.notify_waiters();
        return Ok(());
    }

    let value: Value = serde_json::from_str(&data).context("parse mcp legacy SSE JSON-RPC")?;
    let Some(id) = value.get("id").and_then(Value::as_i64) else {
        return Ok(());
    };
    if let Some(sender) = state.pending.lock().await.remove(&id) {
        let _ = sender.send(Ok(value));
    }
    Ok(())
}

async fn fail_legacy_sse_pending(state: &LegacySseState, message: String) {
    let pending = std::mem::take(&mut *state.pending.lock().await);
    for (_, sender) in pending {
        let _ = sender.send(Err(message.clone()));
    }
}

async fn read_legacy_sse_stream(
    response: reqwest::Response,
    stream_url: String,
    state: Arc<LegacySseState>,
    mut cancel: watch::Receiver<bool>,
) {
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut failure = "mcp legacy SSE stream closed".to_string();
    loop {
        tokio::select! {
            changed = cancel.changed() => {
                if changed.is_ok() && *cancel.borrow() {
                    return;
                }
                if changed.is_err() {
                    return;
                }
            }
            chunk = stream.next() => match chunk {
                Some(Ok(chunk)) => {
                    buffer.extend_from_slice(&chunk);
                    while let Some((index, boundary_length)) = legacy_sse_event_boundary(&buffer) {
                        let event: Vec<u8> = buffer.drain(..index).collect();
                        buffer.drain(..boundary_length);
                        if let Err(error) = dispatch_legacy_sse_event(&event, &stream_url, &state).await {
                            tracing::warn!(error = %error, "mcp legacy SSE event ignored");
                        }
                    }
                }
                Some(Err(error)) => {
                    failure = format!("mcp legacy SSE stream error: {error}");
                    break;
                }
                None => break,
            }
        }
    }
    fail_legacy_sse_pending(&state, failure).await;
}

pub async fn connect(config: &McpServerConfig) -> Result<Arc<McpConnection>> {
    let display_name = config.display_name_or_id();
    match config.transport.as_str() {
        "stdio" => {
            let mut command = Command::new(&config.target);
            // Electron's StdioClientTransport inherits process.env and then
            // overlays the server-specific environment. Preserve that
            // contract so npx/node/path-based MCP servers behave identically
            // after switching to Rust.
            let mut environment: BTreeMap<String, String> = std::env::vars().collect();
            environment.extend(config.env.clone());
            command
                .args(&config.args)
                .envs(environment)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            if let Some(cwd) = config.cwd.as_deref().filter(|cwd| !cwd.trim().is_empty()) {
                command.current_dir(cwd);
            }
            let mut child = command
                .spawn()
                .with_context(|| format!("spawn mcp server {}", config.target))?;
            let stdin = child.stdin.take().context("mcp stdin")?;
            let stdout = child.stdout.take().context("mcp stdout")?;
            Ok(Arc::new(McpConnection::Stdio {
                name: config.name.clone(),
                display_name,
                child: Mutex::new(child),
                stdin: Mutex::new(stdin),
                reader: Mutex::new(BufReader::new(stdout)),
                next_id: AtomicI64::new(1),
                timeout: config.timeout(),
            }))
        }
        // Streamable HTTP servers accept direct POST JSON-RPC and may return
        // either JSON or an SSE response body for an individual request.
        "http" | "streamable-http" => {
            let mut headers = reqwest::header::HeaderMap::new();
            for (name, value) in &config.headers {
                let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .with_context(|| format!("invalid MCP header name: {name}"))?;
                let value = reqwest::header::HeaderValue::from_str(value)
                    .with_context(|| format!("invalid MCP header value for {name}"))?;
                headers.insert(name, value);
            }
            let client = reqwest::Client::builder()
                .default_headers(headers)
                .timeout(config.timeout())
                .build()
                .context("build mcp http client")?;
            Ok(Arc::new(McpConnection::Http {
                name: config.name.clone(),
                display_name,
                endpoint: config.target.clone(),
                client,
                next_id: AtomicI64::new(1),
                session_id: Mutex::new(None),
            }))
        }
        "sse" => {
            let mut headers = reqwest::header::HeaderMap::new();
            for (name, value) in &config.headers {
                let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .with_context(|| format!("invalid MCP header name: {name}"))?;
                let value = reqwest::header::HeaderValue::from_str(value)
                    .with_context(|| format!("invalid MCP header value for {name}"))?;
                headers.insert(name, value);
            }
            // Do not set a Client-wide timeout here: reqwest applies it until
            // the response body closes, while a legacy SSE body is expected
            // to stay open for the entire MCP connection. The initial GET
            // handshake and every POST are bounded separately below.
            let client = reqwest::Client::builder()
                .default_headers(headers)
                .connect_timeout(config.timeout())
                .build()
                .context("build mcp legacy SSE client")?;
            let response = tokio::time::timeout(
                config.timeout(),
                client
                    .get(&config.target)
                    .header(reqwest::header::ACCEPT, "text/event-stream")
                    .send(),
            )
            .await
            .map_err(|_| anyhow::anyhow!("open mcp legacy SSE stream timeout"))?
            .context("open mcp legacy SSE stream")?
            .error_for_status()
            .context("mcp legacy SSE stream response")?;
            let is_sse = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .map(|value| value.to_ascii_lowercase().starts_with("text/event-stream"))
                .unwrap_or(false);
            anyhow::ensure!(
                is_sse,
                "mcp legacy SSE endpoint did not return text/event-stream"
            );

            let state = Arc::new(LegacySseState::new());
            let (cancel, receiver) = watch::channel(false);
            tokio::spawn(read_legacy_sse_stream(
                response,
                config.target.clone(),
                state.clone(),
                receiver,
            ));
            Ok(Arc::new(McpConnection::Sse {
                name: config.name.clone(),
                display_name,
                client,
                next_id: AtomicI64::new(1),
                timeout: config.timeout(),
                state,
                cancel,
            }))
        }
        other => bail!("unknown mcp transport: {other}"),
    }
}

/// Streamable HTTP may send a JSON-RPC response as one or more SSE events
/// instead of a standalone JSON response. Extract the matching response ID
/// while intentionally ignoring notifications and keep-alive comments.
async fn read_sse_response(response: reqwest::Response, request_id: i64) -> Result<Value> {
    let mut stream = response.bytes_stream();
    let mut pending = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("mcp sse response")?;
        pending.push_str(&String::from_utf8_lossy(&chunk));
        // MCP SSE uses LF; accept CRLF as emitted by some proxies too.
        pending = pending.replace("\r\n", "\n");
        while let Some(boundary) = pending.find("\n\n") {
            let event = pending[..boundary].to_string();
            pending.drain(..boundary + 2);
            let data = event
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim_start)
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let value: Value = serde_json::from_str(&data).context("mcp sse JSON-RPC parse")?;
            if value.get("id").and_then(Value::as_i64) == Some(request_id) {
                return Ok(value);
            }
        }
    }
    bail!("mcp SSE stream ended before response {request_id}")
}

/// Lazily manages configured MCP connections. Reloading settings never blocks
/// an Electron chat preparation on every configured server; only the servers
/// needed by Rust discovery/execution are connected.
#[derive(Default)]
pub struct McpManager {
    servers: Mutex<BTreeMap<String, Arc<McpConnection>>>,
    configs: Mutex<Vec<McpServerConfig>>,
    metadata: Mutex<BTreeMap<String, McpServerMetadata>>,
}

impl McpManager {
    pub async fn configure(&self, configs: Vec<McpServerConfig>) {
        // Publish the new catalog before clearing connections. A concurrent
        // connection attempt can then only recreate a connection from the new
        // config (which this reload may conservatively drop), never an old
        // credential/cwd that survives the reload.
        *self.configs.lock().await = configs;
        // Config changes must not leave an old auth header, cwd, or process
        // alive. Stdio children use kill_on_drop above.
        let previous_connections = {
            let mut servers = self.servers.lock().await;
            std::mem::take(&mut *servers)
        };
        drop(previous_connections);
        self.metadata.lock().await.clear();
    }

    async fn configured_server(&self, server: &str) -> Result<McpServerConfig> {
        self.configs
            .lock()
            .await
            .iter()
            .find(|config| config.name == server)
            .cloned()
            .context("mcp server not configured")
    }

    async fn config_for(&self, server: &str) -> Result<McpServerConfig> {
        let config = self.configured_server(server).await?;
        anyhow::ensure!(config.enabled, "mcp server is disabled");
        Ok(config)
    }

    async fn connection_for(&self, server: &str) -> Result<Arc<McpConnection>> {
        if let Some(connection) = self.servers.lock().await.get(server).cloned() {
            return Ok(connection);
        }
        let config = self.config_for(server).await?;
        let connection = match connect(&config).await {
            Ok(connection) => connection,
            Err(error) => {
                self.record_error(server, error.to_string()).await;
                return Err(error);
            }
        };
        if let Err(error) = connection.initialize().await {
            self.record_error(server, error.to_string()).await;
            return Err(error);
        }

        let mut servers = self.servers.lock().await;
        let connection = servers
            .entry(server.to_string())
            .or_insert_with(|| connection.clone())
            .clone();
        drop(servers);
        self.record_connected(server).await;
        Ok(connection)
    }

    async fn selected_configs(&self, allowed: Option<&BTreeSet<String>>) -> Vec<McpServerConfig> {
        self.configs
            .lock()
            .await
            .iter()
            .filter(|config| {
                config.enabled
                    && allowed
                        .map(|allowed| allowed.contains(&config.name))
                        .unwrap_or(true)
            })
            .cloned()
            .collect()
    }

    pub async fn list_server_info(&self, allowed: Option<&BTreeSet<String>>) -> Vec<McpServerInfo> {
        self.state_snapshot()
            .await
            .servers
            .into_iter()
            .filter(|server| {
                allowed
                    .map(|allowed| allowed.contains(&server.id))
                    .unwrap_or(true)
            })
            .map(|server| McpServerInfo {
                id: server.id,
                name: server.name,
                enabled: server.enabled,
                transport: server.transport,
                status: server.status,
            })
            .collect()
    }

    pub async fn list_tools(&self) -> Vec<McpTool> {
        self.list_tools_for(None).await
    }

    pub async fn list_tools_for(&self, allowed: Option<&BTreeSet<String>>) -> Vec<McpTool> {
        let configs = self.selected_configs(allowed).await;
        let mut tools = Vec::new();
        for config in configs {
            match self.connection_for(&config.name).await {
                Ok(connection) => match connection.list_tools().await {
                    Ok(discovered) => {
                        self.record_tools(&config.name, &discovered).await;
                        tools.extend(discovered);
                    }
                    Err(error) => {
                        // `tools/list` is an optional MCP capability. Match
                        // Electron's MCPService: a server that exposes only
                        // resources/prompts stays connected rather than being
                        // marked as a failed transport.
                        self.record_tools_unavailable(&config.name).await;
                        tracing::debug!(server = %config.name, error = %error, "mcp tools/list unsupported or unavailable")
                    }
                },
                Err(error) => {
                    tracing::warn!(server = %config.name, error = %error, "mcp connect failed")
                }
            }
        }
        tools
    }

    pub async fn call_tool(&self, server: &str, tool: &str, args: Value) -> Result<Value> {
        self.connection_for(server)
            .await?
            .call_tool(tool, args)
            .await
    }

    pub async fn list_resources(&self, server: &str) -> Result<Vec<Value>> {
        self.connection_for(server).await?.list_resources().await
    }

    pub async fn read_resource(&self, server: &str, uri: &str) -> Result<Value> {
        self.connection_for(server).await?.read_resource(uri).await
    }

    pub async fn list_prompts(&self, server: &str) -> Result<Vec<Value>> {
        self.connection_for(server).await?.list_prompts().await
    }

    pub async fn get_prompt(&self, server: &str, name: &str, arguments: Value) -> Result<Value> {
        self.connection_for(server)
            .await?
            .get_prompt(name, arguments)
            .await
    }

    /// Reconnect one configured server and refresh its tools/resources/prompts.
    /// Errors are retained in its snapshot instead of making a bulk Settings
    /// refresh fail because another server is unavailable.
    pub async fn refresh_server(&self, server: &str) -> Result<McpServerSnapshot> {
        let config = self.configured_server(server).await?;
        if !config.enabled {
            self.disconnect_server(server).await?;
            return Ok(self.snapshot_for_config(&config).await);
        }

        match self.refresh_metadata(server).await {
            Ok(metadata) => self.store_metadata(server, metadata).await,
            Err(error) => {
                let message = error.to_string();
                self.remove_connection(server).await;
                self.record_error(server, message).await;
            }
        }
        Ok(self.snapshot_for_config(&config).await)
    }

    /// Refresh all enabled servers while preserving a per-server error state.
    pub async fn refresh_enabled(&self) -> McpStateSnapshot {
        let server_ids: Vec<String> = self
            .configs
            .lock()
            .await
            .iter()
            .filter(|config| config.enabled)
            .map(|config| config.name.clone())
            .collect();
        // Match Electron's settings service: one unavailable MCP server must
        // not serialize discovery for every other configured server.
        futures::future::join_all(
            server_ids
                .iter()
                .map(|server_id| self.refresh_server(server_id)),
        )
        .await;
        self.state_snapshot().await
    }

    /// Disconnect without discarding already-discovered metadata, matching the
    /// Electron MCP service's disconnect action.
    pub async fn disconnect_server(&self, server: &str) -> Result<McpServerSnapshot> {
        let config = self.configured_server(server).await?;
        self.remove_connection(server).await;
        let mut metadata = self.metadata_for(server).await;
        metadata.status = "disconnected".into();
        metadata.error = None;
        self.store_metadata(server, metadata).await;
        Ok(self.snapshot_for_config(&config).await)
    }

    /// Electron Settings reads this directly in Rust mode. It intentionally
    /// includes disabled/unconnected configs so the UI remains a durable
    /// catalog rather than a view of only live sockets.
    pub async fn state_snapshot(&self) -> McpStateSnapshot {
        let configs = self.configs.lock().await.clone();
        let mut servers = Vec::with_capacity(configs.len());
        for config in configs {
            servers.push(self.snapshot_for_config(&config).await);
        }
        servers.sort_by(|left, right| left.name.cmp(&right.name));
        McpStateSnapshot {
            servers,
            updated_at: worldbase_protocol::event::now_rfc3339(),
        }
    }

    async fn refresh_metadata(&self, server: &str) -> Result<McpServerMetadata> {
        let connection = self.connection_for(server).await?;
        let tools = connection.list_tools().await;
        let resources = connection.list_resources().await;
        let prompts = connection.list_prompts().await;

        let tools_supported = tools.is_ok();
        let resources_supported = resources.is_ok();
        let prompts_supported = prompts.is_ok();
        Ok(McpServerMetadata {
            status: "connected".into(),
            error: None,
            updated_at: Some(worldbase_protocol::event::now_rfc3339()),
            tools: tools.unwrap_or_default().iter().map(tool_summary).collect(),
            resources: resources
                .unwrap_or_default()
                .iter()
                .filter_map(resource_summary)
                .collect(),
            prompts: prompts
                .unwrap_or_default()
                .iter()
                .filter_map(prompt_summary)
                .collect(),
            capabilities: McpCapabilities {
                tools: tools_supported,
                resources: resources_supported,
                prompts: prompts_supported,
            },
        })
    }

    async fn remove_connection(&self, server: &str) {
        let connection = self.servers.lock().await.remove(server);
        drop(connection);
    }

    async fn metadata_for(&self, server: &str) -> McpServerMetadata {
        self.metadata
            .lock()
            .await
            .get(server)
            .cloned()
            .unwrap_or_default()
    }

    async fn store_metadata(&self, server: &str, metadata: McpServerMetadata) {
        self.metadata
            .lock()
            .await
            .insert(server.to_string(), metadata);
    }

    async fn record_connected(&self, server: &str) {
        let mut metadata = self.metadata_for(server).await;
        metadata.status = "connected".into();
        metadata.error = None;
        metadata.updated_at = Some(worldbase_protocol::event::now_rfc3339());
        self.store_metadata(server, metadata).await;
    }

    async fn record_error(&self, server: &str, error: String) {
        let mut metadata = self.metadata_for(server).await;
        metadata.status = "error".into();
        metadata.error = Some(error);
        metadata.updated_at = Some(worldbase_protocol::event::now_rfc3339());
        self.store_metadata(server, metadata).await;
    }

    async fn record_tools(&self, server: &str, tools: &[McpTool]) {
        let mut metadata = self.metadata_for(server).await;
        metadata.status = "connected".into();
        metadata.error = None;
        metadata.updated_at = Some(worldbase_protocol::event::now_rfc3339());
        metadata.tools = tools.iter().map(tool_summary).collect();
        metadata.capabilities.tools = true;
        self.store_metadata(server, metadata).await;
    }

    async fn record_tools_unavailable(&self, server: &str) {
        let mut metadata = self.metadata_for(server).await;
        metadata.status = "connected".into();
        metadata.error = None;
        metadata.updated_at = Some(worldbase_protocol::event::now_rfc3339());
        metadata.tools.clear();
        metadata.capabilities.tools = false;
        self.store_metadata(server, metadata).await;
    }

    async fn snapshot_for_config(&self, config: &McpServerConfig) -> McpServerSnapshot {
        let connected = self.servers.lock().await.contains_key(&config.name);
        let mut metadata = self.metadata_for(&config.name).await;
        if !config.enabled {
            metadata.status = "disconnected".into();
            metadata.error = None;
        } else if connected && metadata.status != "error" {
            metadata.status = "connected".into();
        }
        McpServerSnapshot {
            id: config.name.clone(),
            name: config.display_name_or_id(),
            enabled: config.enabled,
            transport: config.transport.clone(),
            status: metadata.status,
            error: metadata.error,
            updated_at: metadata.updated_at,
            tools: metadata.tools,
            resources: metadata.resources,
            prompts: metadata.prompts,
            capabilities: metadata.capabilities,
        }
    }

    pub async fn server_names(&self) -> Vec<String> {
        self.configs
            .lock()
            .await
            .iter()
            .filter(|config| config.enabled)
            .map(|config| config.name.clone())
            .collect()
    }
}

fn tool_summary(tool: &McpTool) -> McpToolSummary {
    let schema = if tool.input_schema.is_object() {
        tool.input_schema.clone()
    } else {
        json!({ "type": "object", "properties": {}, "additionalProperties": true })
    };
    let description = if tool.description.trim().is_empty() {
        tool.name.clone()
    } else {
        tool.description.clone()
    };
    McpToolSummary {
        name: tool.name.clone(),
        local_name: build_local_tool_name(&tool.server, &tool.name),
        description: format!("[MCP:{}] {description}", tool.server_name),
        input_schema: schema,
    }
}

fn resource_summary(value: &Value) -> Option<McpResourceSummary> {
    let uri = value.get("uri")?.as_str()?.trim();
    if uri.is_empty() {
        return None;
    }
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(uri)
        .to_string();
    Some(McpResourceSummary {
        uri: uri.to_string(),
        name,
        description: optional_nonempty_string(value, "description"),
        mime_type: optional_nonempty_string(value, "mimeType"),
    })
}

fn prompt_summary(value: &Value) -> Option<McpPromptSummary> {
    let name = value.get("name")?.as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    let arguments = value
        .get("arguments")
        .and_then(Value::as_array)
        .map(|arguments| {
            arguments
                .iter()
                .filter_map(|argument| {
                    let name = argument.get("name")?.as_str()?.trim();
                    if name.is_empty() {
                        return None;
                    }
                    Some(McpPromptArgumentSummary {
                        name: name.to_string(),
                        description: optional_nonempty_string(argument, "description"),
                        required: argument.get("required").and_then(Value::as_bool),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(McpPromptSummary {
        name: name.to_string(),
        description: optional_nonempty_string(value, "description").unwrap_or_default(),
        arguments,
    })
}

fn optional_nonempty_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

/// Match Electron's `mcp__...` dynamic tool name exactly. This is public so
/// the Rust tool registry and the Settings snapshot cannot drift apart.
pub fn build_local_tool_name(server: &str, remote_name: &str) -> String {
    let server_segment = sanitize_tool_segment(server, 14);
    let tool_segment = sanitize_tool_segment(remote_name, 28);
    let hash = simple_tool_hash(&format!("{server}:{remote_name}"));
    format!(
        "mcp__{server_segment}__{tool_segment}__{}",
        &hash[..hash.len().min(6)]
    )
    .chars()
    .take(64)
    .collect()
}

fn sanitize_tool_segment(value: &str, max_len: usize) -> String {
    let mut output = String::new();
    let mut in_invalid_run = false;
    for ch in value.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            output.push(ch);
            in_invalid_run = false;
        } else if !in_invalid_run {
            output.push('_');
            in_invalid_run = true;
        }
    }
    let output = output.trim_matches('_');
    let output: String = output.chars().take(max_len).collect();
    if output.is_empty() {
        "tool".into()
    } else {
        output
    }
}

fn simple_tool_hash(value: &str) -> String {
    let mut hash = 0i32;
    for code_unit in value.encode_utf16() {
        hash = hash
            .wrapping_shl(5)
            .wrapping_sub(hash)
            .wrapping_add(code_unit as i32);
    }
    let mut value = (hash as i64).abs();
    if value == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        out.push(if digit < 10 {
            (b'0' + digit) as char
        } else {
            (b'a' + digit - 10) as char
        });
        value /= 36;
    }
    out.iter().rev().collect()
}

trait ReadLineResult {
    async fn read_line_result(&mut self) -> Result<String>;
}

impl ReadLineResult for BufReader<tokio::process::ChildStdout> {
    async fn read_line_result(&mut self) -> Result<String> {
        let mut line = String::new();
        let count = self.read_line(&mut line).await?;
        if count == 0 {
            bail!("mcp stdio closed");
        }
        Ok(line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn read_http_request(socket: &mut tokio::net::TcpStream) -> String {
        let mut buffer = Vec::new();
        let mut body_length = None;
        loop {
            let mut chunk = [0u8; 4096];
            let count = socket.read(&mut chunk).await.unwrap();
            assert!(
                count > 0,
                "HTTP client closed request before headers completed"
            );
            buffer.extend_from_slice(&chunk[..count]);
            if let Some(header_end) = buffer.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                if body_length.is_none() {
                    let headers = String::from_utf8_lossy(&buffer[..header_end]);
                    body_length = headers
                        .lines()
                        .find_map(|line| {
                            line.strip_prefix("content-length:")
                                .or_else(|| line.strip_prefix("Content-Length:"))
                        })
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .or(Some(0));
                }
                let expected = header_end + 4 + body_length.unwrap_or(0);
                if buffer.len() >= expected {
                    return String::from_utf8(buffer).unwrap();
                }
            }
        }
    }

    #[test]
    fn electron_config_fields_deserialize_without_loss() {
        let config: McpServerConfig = serde_json::from_value(json!({
            "name": "server-id",
            "displayName": "My MCP",
            "enabled": true,
            "transport": "stdio",
            "target": "node",
            "args": ["server.js"],
            "cwd": "/tmp/project",
            "env": { "TOKEN": "secret" },
            "headers": { "Authorization": "Bearer token" },
            "timeoutMs": 12345
        }))
        .unwrap();

        assert_eq!(config.display_name, "My MCP");
        assert_eq!(config.cwd.as_deref(), Some("/tmp/project"));
        assert_eq!(config.headers["Authorization"], "Bearer token");
        assert_eq!(config.timeout(), Duration::from_millis(12345));
    }

    #[test]
    fn flutter_settings_fields_deserialize_without_loss() {
        let config: McpServerConfig = serde_json::from_value(json!({
            "id": "server-id",
            "name": "My MCP",
            "enabled": true,
            "transport": "stdio",
            "command": "node",
            "args": ["server.js"],
            "cwd": "/tmp/project",
            "env": { "TOKEN": "secret" },
            "headers": { "Authorization": "Bearer token" },
            "timeoutMs": 12345
        }))
        .unwrap();

        assert_eq!(config.name, "server-id");
        assert_eq!(config.display_name, "My MCP");
        assert_eq!(config.target, "node");
        assert_eq!(config.args, vec!["server.js"]);
        assert_eq!(config.timeout(), Duration::from_millis(12345));
    }

    #[test]
    fn flutter_http_settings_use_url_as_target() {
        let config: McpServerConfig = serde_json::from_value(json!({
            "id": "remote",
            "name": "Remote MCP",
            "enabled": true,
            "transport": "streamable-http",
            "url": "https://example.test/mcp",
        }))
        .unwrap();

        assert_eq!(config.name, "remote");
        assert_eq!(config.display_name, "Remote MCP");
        assert_eq!(config.target, "https://example.test/mcp");
    }

    #[tokio::test]
    async fn http_transport_uses_electron_headers() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let saw_header = Arc::new(AtomicBool::new(false));
        let saw_initialized = Arc::new(AtomicBool::new(false));
        let observed = saw_header.clone();
        let observed_initialized = saw_initialized.clone();
        let server = tokio::spawn(async move {
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0u8; 8192];
                let count = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                if request.contains("x-mcp-token: test-token") {
                    observed.store(true, Ordering::SeqCst);
                }
                if request.contains("\"method\":\"notifications/initialized\"") {
                    observed_initialized.store(true, Ordering::SeqCst);
                }
                let id = request
                    .split("\r\n\r\n")
                    .nth(1)
                    .and_then(|body| serde_json::from_str::<Value>(body).ok())
                    .and_then(|body| body.get("id").cloned())
                    .unwrap_or_else(|| json!(1));
                let result = if request.contains("\"method\":\"tools/list\"") {
                    json!({ "tools": [] })
                } else {
                    json!({})
                };
                let body = json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let config = McpServerConfig {
            name: "server".into(),
            display_name: "Server".into(),
            transport: "http".into(),
            target: format!("http://{address}"),
            args: vec![],
            cwd: None,
            env: BTreeMap::new(),
            headers: BTreeMap::from([("x-mcp-token".into(), "test-token".into())]),
            timeout_ms: Some(5_000),
            enabled: true,
        };
        let connection = connect(&config).await.unwrap();
        connection.initialize().await.unwrap();
        assert!(connection.list_tools().await.unwrap().is_empty());
        server.await.unwrap();
        assert!(saw_header.load(Ordering::SeqCst));
        assert!(saw_initialized.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn streamable_http_reuses_session_and_parses_sse_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let saw_session = Arc::new(AtomicBool::new(false));
        let observed_session = saw_session.clone();
        let server = tokio::spawn(async move {
            for request_index in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0u8; 8192];
                let count = socket.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..count]);
                let lower_request = request.to_ascii_lowercase();
                if request_index > 0 && lower_request.contains("mcp-session-id: session-123") {
                    observed_session.store(true, Ordering::SeqCst);
                }
                let id = request
                    .split("\r\n\r\n")
                    .nth(1)
                    .and_then(|body| serde_json::from_str::<Value>(body).ok())
                    .and_then(|body| body.get("id").cloned())
                    .unwrap_or_else(|| json!(1));
                let response = match request_index {
                    0 => {
                        let body = json!({ "jsonrpc": "2.0", "id": id, "result": {} }).to_string();
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nmcp-session-id: session-123\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                    }
                    1 => "HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                        .to_string(),
                    _ => {
                        let body = format!(
                            "event: message\ndata: {{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":{{\"tools\":[{{\"name\":\"lookup\",\"description\":\"Lookup\",\"inputSchema\":{{\"type\":\"object\"}}}}]}}}}\n\n",
                            id
                        );
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            body.len(),
                            body
                        )
                    }
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });

        let config = McpServerConfig {
            name: "streamable".into(),
            display_name: "Streamable".into(),
            transport: "streamable-http".into(),
            target: format!("http://{address}"),
            args: vec![],
            cwd: None,
            env: BTreeMap::new(),
            headers: BTreeMap::new(),
            timeout_ms: Some(5_000),
            enabled: true,
        };
        let connection = connect(&config).await.unwrap();
        connection.initialize().await.unwrap();
        let tools = connection.list_tools().await.unwrap();
        server.await.unwrap();

        assert!(saw_session.load(Ordering::SeqCst));
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "lookup");
    }

    #[tokio::test]
    async fn legacy_sse_uses_advertised_post_endpoint_and_event_responses() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let saw_header = Arc::new(AtomicBool::new(false));
        let observed_header = saw_header.clone();
        let server = tokio::spawn(async move {
            let (mut events, _) = listener.accept().await.unwrap();
            let event_request = read_http_request(&mut events).await;
            assert!(event_request.starts_with("GET /events HTTP/1.1"));
            if event_request
                .to_ascii_lowercase()
                .contains("x-mcp-token: sse-token")
            {
                observed_header.store(true, Ordering::SeqCst);
            }
            let event_headers = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: keep-alive\r\n\r\n";
            events.write_all(event_headers.as_bytes()).await.unwrap();
            events
                .write_all(b"event: endpoint\ndata: /messages\n\n")
                .await
                .unwrap();

            for index in 0..3 {
                let (mut request_socket, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut request_socket).await;
                assert!(request.starts_with("POST /messages HTTP/1.1"));
                if request
                    .to_ascii_lowercase()
                    .contains("x-mcp-token: sse-token")
                {
                    observed_header.store(true, Ordering::SeqCst);
                }
                let body = request.split("\r\n\r\n").nth(1).unwrap_or_default();
                let request_value: Value = serde_json::from_str(body).unwrap();
                let notification = request_value.get("id").is_none();
                request_socket
                    .write_all(
                        b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                    )
                    .await
                    .unwrap();
                if notification {
                    continue;
                }
                let id = request_value["id"].as_i64().unwrap();
                let result = if index == 2 {
                    json!({ "tools": [{ "name": "legacy_lookup", "description": "Legacy lookup", "inputSchema": { "type": "object" } }] })
                } else {
                    json!({})
                };
                let event = format!(
                    "event: message\ndata: {}\n\n",
                    json!({ "jsonrpc": "2.0", "id": id, "result": result })
                );
                events.write_all(event.as_bytes()).await.unwrap();
            }
        });

        let config = McpServerConfig {
            name: "legacy".into(),
            display_name: "Legacy SSE".into(),
            transport: "sse".into(),
            target: format!("http://{address}/events"),
            args: vec![],
            cwd: None,
            env: BTreeMap::new(),
            headers: BTreeMap::from([("x-mcp-token".into(), "sse-token".into())]),
            timeout_ms: Some(5_000),
            enabled: true,
        };
        let connection = connect(&config).await.unwrap();
        connection.initialize().await.unwrap();
        let tools = connection.list_tools().await.unwrap();
        server.await.unwrap();

        assert!(saw_header.load(Ordering::SeqCst));
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "legacy_lookup");
    }
}
