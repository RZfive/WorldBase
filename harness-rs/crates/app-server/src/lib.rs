//! app-server：stdio 上的 NDJSON JSON-RPC，供 Electron spawn 接入（codex app-server 同款）。
//!
//! - 宿主 → harness：请求与通知（每行一个 JSON）
//! - harness → 宿主：响应、事件通知（method="event"）、日志一律走 stderr

use anyhow::Result;
use futures::StreamExt;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::task::JoinSet;
use worldbase_core::{dispatcher, ConnectionContext, Hub};
use worldbase_protocol::event::EVENT_METHOD;
use worldbase_protocol::rpc::{Incoming, RequestId, Response};
use worldbase_protocol::types::Capabilities;

/// stdio transport 入口。
pub async fn run_stdio(hub: Arc<Hub>, capabilities: Capabilities) -> Result<()> {
    run_with(hub, capabilities, tokio::io::stdin(), tokio::io::stdout()).await
}

/// 可注入 IO 的 NDJSON 服务循环（测试用 duplex 驱动）。
pub async fn run_with<R, W>(
    hub: Arc<Hub>,
    capabilities: Capabilities,
    input: R,
    output: W,
) -> Result<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let ctx = Arc::new(ConnectionContext::new(capabilities));
    let output = Arc::new(tokio::sync::Mutex::new(output));

    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (writer_stop_tx, mut writer_stop_rx) = tokio::sync::oneshot::channel::<()>();
    let mut event_rx = hub.event_tx.subscribe();
    let writer = output.clone();
    let writer_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(line) = out_rx.recv() => {
                    let mut out = writer.lock().await;
                    if out.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = out.flush().await;
                }
                Ok(frame) = event_rx.recv() => {
                    let params = serde_json::to_value(&frame).unwrap_or(serde_json::Value::Null);
                    let line = worldbase_protocol::rpc::notification(EVENT_METHOD, params);
                    let mut out = writer.lock().await;
                    let _ = out.write_all(line.as_bytes()).await;
                    let _ = out.write_all(b"\n").await;
                    let _ = out.flush().await;
                }
                _ = &mut writer_stop_rx => {
                    // Requests are joined before this signal is sent.  Drain
                    // every already-queued response so short-lived clients
                    // (including piped smoke tests) never lose the final frame.
                    while let Ok(line) = out_rx.try_recv() {
                        let mut out = writer.lock().await;
                        if out.write_all(line.as_bytes()).await.is_err() {
                            break;
                        }
                        let _ = out.flush().await;
                    }
                    break;
                }
                else => break,
            }
        }
    });

    let mut request_tasks = JoinSet::new();
    // NDJSON control frames are not bounded by the BufReader capacity: image
    // attachments serialize into multi-megabyte base64 lines that span
    // thousands of reads. Lines must therefore be assembled manually. A
    // `Lines::next_line()` retry cannot survive a mid-line error — tokio
    // discards the bytes read before the failure, silently truncating the
    // request into an uncorrelated -32700 parse error — so transient read
    // errors must resume into a persistent line buffer instead.
    let mut reader = BufReader::new(input);
    let mut line_buf: Vec<u8> = Vec::new();
    loop {
        match reader.fill_buf().await {
            // Ok(empty) reports EOF on the control pipe.
            Ok(available) if available.is_empty() => {}
            Ok(available) => {
                let mut consumed = 0;
                while let Some(newline) = available[consumed..]
                    .iter()
                    .position(|&byte| byte == b'\n')
                {
                    line_buf.extend_from_slice(&available[consumed..consumed + newline]);
                    consumed += newline + 1;
                    let line = String::from_utf8_lossy(&line_buf).into_owned();
                    line_buf.clear();
                    dispatch_line(&hub, &ctx, &out_tx, &mut request_tasks, &line);
                }
                line_buf.extend_from_slice(&available[consumed..]);
                let chunk_len = available.len();
                reader.consume(chunk_len);
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                // A child process sharing the stdin open-file description
                // (spawned with inherited stdio) can flip the descriptor
                // to non-blocking mode; a momentarily empty pipe then reads
                // as EAGAIN instead of blocking. That must never shut the
                // harness down: back off and retry so the host's NDJSON
                // control pipe stays alive.
                tracing::warn!(error = %error, "app-server stdin would-block; retrying");
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                continue;
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                continue;
            }
            Err(error) => {
                tracing::error!(error = %error, "app-server stdin read failed; shutting down");
            }
        }
        if !line_buf.is_empty() {
            // The host closed its write end after a final line without a
            // trailing newline; treat the remainder as one last frame.
            let line = String::from_utf8_lossy(&line_buf).into_owned();
            line_buf.clear();
            dispatch_line(&hub, &ctx, &out_tx, &mut request_tasks, &line);
        }
        tracing::info!("input eof, app-server exiting");
        // Complete all requests that were accepted before EOF, then stop
        // the writer after it has drained their responses.
        while request_tasks.join_next().await.is_some() {}
        drop(out_tx);
        let _ = writer_stop_tx.send(());
        let _ = writer_task.await;
        break;
    }
    Ok(())
}

/// Parse one NDJSON frame and dispatch it. A malformed line answers with an
/// uncorrelated -32700 response and must never take the control loop down.
fn dispatch_line(
    hub: &Arc<Hub>,
    ctx: &Arc<ConnectionContext>,
    out_tx: &tokio::sync::mpsc::UnboundedSender<String>,
    request_tasks: &mut JoinSet<()>,
    line: &str,
) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let Ok(incoming) = serde_json::from_str::<Incoming>(trimmed) else {
        let resp = Response::error(
            RequestId::Null,
            worldbase_protocol::rpc::ErrorObject::new(
                worldbase_protocol::rpc::PARSE_ERROR,
                "invalid json",
            ),
        );
        let _ = out_tx.send(resp.to_message() + "\n");
        return;
    };
    match incoming {
        Incoming::Request(req) => {
            let hub = hub.clone();
            let ctx = ctx.clone();
            let out_tx = out_tx.clone();
            request_tasks.spawn(async move {
                let id = req.id.clone();
                let result =
                    dispatcher::dispatch(&hub, &ctx, &req.method, req.params.clone()).await;
                let resp = match result {
                    Ok(value) => Response::success(id, value),
                    Err(err) => Response::error(id, err),
                };
                let _ = out_tx.send(resp.to_message() + "\n");
            });
        }
        Incoming::Notification(n) => {
            let hub = hub.clone();
            let ctx = ctx.clone();
            request_tasks.spawn(async move {
                let _ = dispatcher::dispatch(&hub, &ctx, &n.method, n.params.clone()).await;
            });
        }
    }
}

/// 把 hub 事件流转换为 chunk 流（测试/CLI 可用）。
pub fn event_stream(
    hub: &Arc<Hub>,
) -> impl futures::Stream<Item = worldbase_protocol::event::EventFrame> {
    let rx = hub.event_tx.subscribe();
    tokio_stream::wrappers::BroadcastStream::new(rx).filter_map(|f| futures::future::ready(f.ok()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{duplex, AsyncWriteExt, ReadBuf};

    async fn run_requests(hub: Arc<Hub>, requests: Vec<Value>) -> BTreeMap<i64, Value> {
        let (mut client_input, server_input) = duplex(32 * 1024);
        let (server_output, client_output) = duplex(32 * 1024);
        let server = tokio::spawn(run_with(
            hub,
            Capabilities::desktop(),
            server_input,
            server_output,
        ));

        let mut responses = BTreeMap::new();
        let mut lines = BufReader::new(client_output).lines();
        for request in requests {
            let request_id = request["id"].as_i64().expect("test request id");
            let line = serde_json::to_string(&request).unwrap();
            client_input.write_all(line.as_bytes()).await.unwrap();
            client_input.write_all(b"\n").await.unwrap();
            loop {
                let line = lines
                    .next_line()
                    .await
                    .unwrap()
                    .expect("response before app-server closes");
                let response: Value = serde_json::from_str(&line).unwrap();
                if response.get("id").and_then(Value::as_i64) != Some(request_id) {
                    continue;
                }
                assert!(
                    response.get("error").is_none(),
                    "request {request_id} failed: {}",
                    response
                );
                responses.insert(request_id, response["result"].clone());
                break;
            }
        }
        client_input.shutdown().await.unwrap();

        while lines.next_line().await.unwrap().is_some() {}
        server.await.unwrap().unwrap();
        responses
    }

    #[tokio::test]
    async fn stdio_routes_project_data_and_workspace_control_to_rust() {
        let temporary = tempfile::tempdir().unwrap();
        let projects = temporary.path().join("projects");
        let project = projects.join("native-project");
        std::fs::create_dir_all(project.join("src")).unwrap();
        std::fs::write(project.join("src/main.ts"), "export const native = true\n").unwrap();
        std::fs::write(
            project.join(".world-meta.json"),
            r#"{
                "name":"Native project",
                "dataSchema":{
                    "database":"sqlite",
                    "dbPath":"data/native.db",
                    "tables":[{
                        "name":"tasks",
                        "columns":[
                            {"name":"id","type":"INTEGER","primaryKey":true},
                            {"name":"title","type":"TEXT","notNull":true}
                        ]
                    }]
                }
            }"#,
        )
        .unwrap();
        let workspace = temporary.path().join("folder-workspace");
        std::fs::create_dir_all(workspace.join("src")).unwrap();
        std::fs::write(
            workspace.join("src/preview.ts"),
            "export const preview = 'rust'\n",
        )
        .unwrap();

        let store = Arc::new(
            worldbase_memory::Store::open(&temporary.path().join("harness.sqlite")).unwrap(),
        );
        let hub = Hub::new(projects, store).unwrap();
        let responses = run_requests(
            hub,
            vec![
                json!({
                    "jsonrpc":"2.0", "id": 0, "method":"initialize",
                    "params":{"protocolVersion":"1.0","capabilities":{"platform":"desktop","features":["subprocess","port_binding","webhook_receiver","webview_automation","interactive"],"excludes":[]}}
                }),
                json!({
                    "jsonrpc":"2.0", "id": 1, "method":"project.data.records.save",
                    "params":{"projectId":"native-project","table":"tasks","records":[{"id":1,"title":"native row"}],"mode":"upsert"}
                }),
                json!({
                    "jsonrpc":"2.0", "id": 2, "method":"project.data.records.query",
                    "params":{"projectId":"native-project","table":"tasks","filters":{"id":1}}
                }),
                json!({
                    "jsonrpc":"2.0", "id": 3, "method":"project.data.tables",
                    "params":{"projectId":"native-project"}
                }),
                json!({
                    "jsonrpc":"2.0", "id": 4, "method":"project.analyze",
                    "params":{"projectId":"native-project"}
                }),
                json!({
                    "jsonrpc":"2.0", "id": 5, "method":"project.logs",
                    "params":{"projectId":"native-project","lines":10}
                }),
                json!({
                    "jsonrpc":"2.0", "id": 6, "method":"workspace.list",
                    "params":{"rootPath":workspace}
                }),
                json!({
                    "jsonrpc":"2.0", "id": 7, "method":"workspace.read",
                    "params":{"rootPath":workspace,"filePath":"src/preview.ts"}
                }),
                json!({
                    "jsonrpc":"2.0", "id": 8, "method":"project.logs.append",
                    "params":{"port":43123,"type":"stdout","text":"browser console"}
                }),
            ],
        )
        .await;

        assert_eq!(responses[&0]["protocolVersion"], "1.0");
        assert!(responses[&0]["availableDomains"]
            .as_array()
            .unwrap()
            .iter()
            .any(|domain| domain == "desktop"));
        let advertised_tools = responses[&0]["availableTools"].as_array().unwrap();
        for name in [
            "create_project",
            "write_project_file",
            "write_workspace_file",
            "generate_image",
            "mcp_call",
        ] {
            assert!(
                advertised_tools
                    .iter()
                    .any(|tool| tool["name"].as_str() == Some(name)),
                "Rust app-server did not advertise {name}"
            );
        }
        assert_eq!(responses[&1]["count"], 1);
        assert_eq!(responses[&2], json!([{ "id": 1, "title": "native row" }]));
        assert_eq!(responses[&3]["tables"], json!(["tasks"]));
        assert_eq!(responses[&4]["type"], "frontend");
        assert!(responses[&5]["logs"].is_array());
        assert!(responses[&6]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["path"] == "src"));
        assert_eq!(responses[&7]["kind"], "code");
        assert_eq!(responses[&7]["language"], "typescript");
        assert_eq!(responses[&7]["content"], "export const preview = 'rust'\n");
        assert_eq!(responses[&8]["appended"], false);
    }

    /// Simulates a stdin open-file description flipped to non-blocking mode by
    /// an inherited-stdio child: reads succeed while data is available and fail
    /// with `WouldBlock` at the configured byte offsets (the pipe ran empty,
    /// more data arrives later).
    struct WouldBlockReader {
        data: Vec<u8>,
        offset: usize,
        /// Total-byte offsets at which the next read returns EAGAIN once.
        block_points: std::collections::VecDeque<usize>,
    }

    impl tokio::io::AsyncRead for WouldBlockReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if self.offset >= self.data.len() {
                return Poll::Ready(Ok(()));
            }
            let Some(&block_at) = self.block_points.front() else {
                let end = (self.offset + buf.remaining()).min(self.data.len());
                buf.put_slice(&self.data[self.offset..end]);
                self.offset = end;
                return Poll::Ready(Ok(()));
            };
            if block_at == self.offset {
                self.block_points.pop_front();
                return Poll::Ready(Err(std::io::Error::from(std::io::ErrorKind::WouldBlock)));
            }
            let end = block_at.min(self.offset + buf.remaining()).min(self.data.len());
            buf.put_slice(&self.data[self.offset..end]);
            self.offset = end;
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn would_block_mid_line_preserves_large_requests() {
        use std::collections::VecDeque;

        let temporary = tempfile::tempdir().unwrap();
        let projects = temporary.path().join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        let store = Arc::new(
            worldbase_memory::Store::open(&temporary.path().join("harness.sqlite")).unwrap(),
        );
        let hub = Hub::new(projects, store).unwrap();

        // A small request first (like the Electron handshake), then one line
        // padded well past the BufReader capacity (8 KiB) with WouldBlock
        // injected mid-line three times — the read pattern of a
        // multi-megabyte image attachment on a non-blocking stdin.
        let initialize = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1.0","capabilities":{"platform":"desktop","features":["subprocess"],"excludes":[]}}}"#;
        let padding = "p".repeat(20 * 1024);
        let large_append = format!(
            r#"{{"jsonrpc":"2.0","id":2,"method":"project.logs.append","params":{{"port":43123,"type":"stdout","text":"{padding}"}}}}"#
        );
        let mut data = Vec::new();
        data.extend_from_slice(initialize.as_bytes());
        data.push(b'\n');
        data.extend_from_slice(large_append.as_bytes());
        data.push(b'\n');
        let reader = WouldBlockReader {
            data,
            offset: 0,
            block_points: VecDeque::from(vec![5_000, 12_000, 19_000]),
        };

        let (client_input, _server_input) = duplex(32 * 1024);
        let (server_output, client_output) = duplex(32 * 1024);
        drop(client_input);
        let server = tokio::spawn(run_with(
            hub,
            Capabilities::desktop(),
            reader,
            server_output,
        ));

        let mut lines = BufReader::new(client_output).lines();
        let mut response = None;
        while let Some(line) = lines.next_line().await.unwrap() {
            let parsed: Value = serde_json::from_str(&line).unwrap();
            if parsed.get("id").and_then(Value::as_i64) == Some(2) {
                response = Some(parsed);
                break;
            }
            if parsed.get("id").and_then(Value::as_i64) == Some(1) {
                assert!(
                    parsed.get("error").is_none(),
                    "initialize failed: {parsed}"
                );
                continue;
            }
            panic!("unexpected frame before the correlated response: {parsed}");
        }
        let response = response.expect("truncated request lost the large-append response");
        assert_eq!(response["result"]["appended"], false);

        lines.get_mut().shutdown().await.unwrap();
        server.await.unwrap().unwrap();
    }
}
