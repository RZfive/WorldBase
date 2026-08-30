//! MCP (Model Context Protocol) 客户端：stdio / HTTP 传输，tools 与 resources 发现。
//!
//! 对齐 MCP 规范的 JSON-RPC 2.0 子集：initialize / tools/list / tools/call。
//! stdio 传输 spawn 子进程（桌面/server）；HTTP 传输 POST JSON-RPC（全端）。

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub name: String,
    /// "stdio" 或 "http"。
    pub transport: String,
    /// stdio: 可执行命令；http: endpoint URL。
    pub target: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub server: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub input_schema: Value,
}

/// 一个已连接的 MCP server。
pub enum McpConnection {
    Stdio {
        name: String,
        #[allow(dead_code)]
        child: Mutex<Child>,
        stdin: Mutex<tokio::process::ChildStdin>,
        reader: Mutex<BufReader<tokio::process::ChildStdout>>,
        next_id: AtomicI64,
    },
    Http {
        name: String,
        endpoint: String,
        client: reqwest::Client,
        next_id: AtomicI64,
    },
}

impl McpConnection {
    pub fn name(&self) -> &str {
        match self {
            McpConnection::Stdio { name, .. } | McpConnection::Http { name, .. } => name,
        }
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        match self {
            McpConnection::Stdio { stdin, reader, next_id, .. } => {
                let mut stdin = stdin.lock().await;
                let id = next_id.fetch_add(1, Ordering::SeqCst);
                let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
                let mut line = serde_json::to_string(&req)?;
                line.push('\n');
                stdin.write_all(line.as_bytes()).await?;
                stdin.flush().await?;

                // 读取到匹配 id 的响应（跳过通知）
                let deadline = tokio::time::Duration::from_secs(30);
                let mut reader = reader.lock().await;
                loop {
                    let fut = reader.read_line_result();
                    let raw: String = tokio::time::timeout(deadline, fut)
                        .await
                        .map_err(|_| anyhow::anyhow!("mcp stdio timeout"))??;
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let value: Value = serde_json::from_str(trimmed).context("mcp stdio parse")?;
                    if value.get("id").and_then(|v| v.as_i64()) == Some(id) {
                        if let Some(err) = value.get("error") {
                            bail!("mcp error: {err}");
                        }
                        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
                    }
                    // 通知 / 其他 id 响应：忽略
                }
            }
            McpConnection::Http { endpoint, client, next_id, .. } => {
                let id = next_id.fetch_add(1, Ordering::SeqCst);
                let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
                let client: reqwest::Client = client.clone();
                let endpoint: String = endpoint.clone();
                let resp = client
                    .post(endpoint)
                    .json(&req)
                    .timeout(std::time::Duration::from_secs(30))
                    .send()
                    .await
                    .context("mcp http request")?;
                let value: Value = resp.json().await.context("mcp http parse")?;
                if let Some(err) = value.get("error") {
                    bail!("mcp error: {err}");
                }
                Ok(value.get("result").cloned().unwrap_or(Value::Null))
            }
        }
    }

    pub async fn initialize(&self) -> Result<Value> {
        self.request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "worldbase-harness", "version": env!("CARGO_PKG_VERSION") },
            }),
        )
        .await
    }

    pub async fn list_tools(&self) -> Result<Vec<McpTool>> {
        let result = self.request("tools/list", json!({})).await?;
        let mut out = Vec::new();
        if let Some(tools) = result.get("tools").and_then(|t| t.as_array()) {
            for t in tools {
                out.push(McpTool {
                    server: self.name().to_string(),
                    name: t.get("name").and_then(|n| n.as_str()).unwrap_or("").into(),
                    description: t.get("description").and_then(|d| d.as_str()).unwrap_or("").into(),
                    input_schema: t.get("inputSchema").cloned().unwrap_or(json!({ "type": "object" })),
                });
            }
        }
        Ok(out)
    }

    pub async fn call_tool(&self, tool: &str, args: Value) -> Result<Value> {
        self.request("tools/call", json!({ "name": tool, "arguments": args })).await
    }
}

impl Drop for McpConnection {
    fn drop(&mut self) {
        // child 由 tokio 运行时回收；kill_on_drop 不适用（Mutex 包装）。
    }
}

pub async fn connect(config: &McpServerConfig) -> Result<Arc<McpConnection>> {
    match config.transport.as_str() {
        "stdio" => {
            let mut child = Command::new(&config.target)
                .args(&config.args)
                .envs(&config.env)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .with_context(|| format!("spawn mcp server {}", config.target))?;
            let stdin = child.stdin.take().context("mcp stdin")?;
            let stdout = child.stdout.take().context("mcp stdout")?;
            Ok(Arc::new(McpConnection::Stdio {
                name: config.name.clone(),
                child: Mutex::new(child),
                stdin: Mutex::new(stdin),
                reader: Mutex::new(BufReader::new(stdout)),
                next_id: AtomicI64::new(1),
            }))
        }
        "http" | "sse" => Ok(Arc::new(McpConnection::Http {
            name: config.name.clone(),
            endpoint: config.target.clone(),
            client: reqwest::Client::new(),
            next_id: AtomicI64::new(1),
        })),
        other => bail!("unknown mcp transport: {other}"),
    }
}

/// 管理多个 MCP server 连接。
#[derive(Default)]
pub struct McpManager {
    servers: Mutex<Vec<Arc<McpConnection>>>,
    configs: Mutex<Vec<McpServerConfig>>,
}

impl McpManager {
    pub async fn configure(&self, configs: Vec<McpServerConfig>) {
        let mut servers = Vec::new();
        for cfg in configs.iter().filter(|c| c.enabled) {
            match connect(cfg).await {
                Ok(conn) => {
                    if let Err(e) = conn.initialize().await {
                        tracing::warn!(server = %cfg.name, error = %e, "mcp initialize failed");
                        continue;
                    }
                    servers.push(conn);
                }
                Err(e) => {
                    tracing::warn!(server = %cfg.name, error = %e, "mcp connect failed");
                }
            }
        }
        *self.servers.lock().await = servers;
        *self.configs.lock().await = configs;
    }

    pub async fn list_tools(&self) -> Vec<McpTool> {
        let servers = self.servers.lock().await;
        let mut out = Vec::new();
        for s in servers.iter() {
            if let Ok(tools) = s.list_tools().await {
                out.extend(tools);
            }
        }
        out
    }

    pub async fn call_tool(&self, server: &str, tool: &str, args: Value) -> Result<Value> {
        let servers = self.servers.lock().await;
        let conn = servers
            .iter()
            .find(|s| s.name() == server)
            .context("mcp server not connected")?;
        conn.call_tool(tool, args).await
    }

    pub async fn server_names(&self) -> Vec<String> {
        self.servers.lock().await.iter().map(|s| s.name().to_string()).collect()
    }
}

trait ReadLineResult {
    async fn read_line_result(&mut self) -> Result<String>;
}

impl ReadLineResult for BufReader<tokio::process::ChildStdout> {
    async fn read_line_result(&mut self) -> Result<String> {
        let mut line = String::new();
        let n = self.read_line(&mut line).await?;
        if n == 0 {
            bail!("mcp stdio closed");
        }
        Ok(line)
    }
}
