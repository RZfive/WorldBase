//! app-server：stdio 上的 NDJSON JSON-RPC，供 Electron spawn 接入（codex app-server 同款）。
//!
//! - 宿主 → harness：请求与通知（每行一个 JSON）
//! - harness → 宿主：响应、事件通知（method="event"）、日志一律走 stderr

use anyhow::Result;
use futures::StreamExt;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use worldbase_core::{dispatcher, ConnectionContext, Hub};
use worldbase_protocol::event::EVENT_METHOD;
use worldbase_protocol::rpc::{Incoming, RequestId, Response};
use worldbase_protocol::types::Capabilities;

/// stdio transport 入口。
pub async fn run_stdio(hub: Arc<Hub>, capabilities: Capabilities) -> Result<()> {
    run_with(hub, capabilities, tokio::io::stdin(), tokio::io::stdout()).await
}

/// 可注入 IO 的 NDJSON 服务循环（测试用 duplex 驱动）。
pub async fn run_with<R, W>(hub: Arc<Hub>, capabilities: Capabilities, input: R, output: W) -> Result<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let ctx = Arc::new(ConnectionContext::new(capabilities));
    let mut lines = BufReader::new(input).lines();
    let output = Arc::new(tokio::sync::Mutex::new(output));

    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut event_rx = hub.event_tx.subscribe();
    let writer = output.clone();
    tokio::spawn(async move {
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
                else => break,
            }
        }
    });

    loop {
        let Some(line) = lines.next_line().await.unwrap_or(None) else {
            tracing::info!("input eof, app-server exiting");
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
                tokio::spawn(async move {
                    let id = req.id.clone();
                    let result = dispatcher::dispatch(&hub, &ctx, &req.method, req.params.clone()).await;
                    let resp = match result {
                        Ok(value) => Response::success(id, value),
                        Err(err) => Response::error(id, err),
                    };
                    let _ = out_tx.send(resp.to_message() + "\n");
                });
            }
            Incoming::Notification(n) => {
                tokio::spawn(async move {
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
