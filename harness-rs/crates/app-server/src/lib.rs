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
    let mut lines = BufReader::new(input).lines();
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
    loop {
        let Some(line) = lines.next_line().await.unwrap_or(None) else {
            tracing::info!("input eof, app-server exiting");
            // Complete all requests that were accepted before EOF, then stop
            // the writer after it has drained their responses.
            while request_tasks.join_next().await.is_some() {}
            drop(out_tx);
            let _ = writer_stop_tx.send(());
            let _ = writer_task.await;
            break;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
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
            continue;
        };
        let hub = hub.clone();
        let ctx = ctx.clone();
        let out_tx = out_tx.clone();
        match incoming {
            Incoming::Request(req) => {
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
                request_tasks.spawn(async move {
                    let _ = dispatcher::dispatch(&hub, &ctx, &n.method, n.params.clone()).await;
                });
            }
        }
    }
    Ok(())
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
    use tokio::io::{duplex, AsyncWriteExt};

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
}
