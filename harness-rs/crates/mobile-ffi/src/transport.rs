//! 进程内 loopback 传输（mobile-ffi 私有实现，非独立部署层）：
//! Dart UI ↔ 同进程 harness 的 WS/HTTP 桥。
//! - `GET /health`：存活检查
//! - `POST /rpc`：无状态单请求单响应（每次使用 transport bootstrap capabilities）
//! - `GET /ws`：WS 全双工（事件帧下行 + 请求上行），`initialize` 能力在连接内持久
//! - `GET /studio/{id}`：图库图片
//! - `GET /lightapp/{id}`：Agent 生成的单页应用

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, Request, State};
use axum::http::{StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response as AxumResponse};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use worldbase_core::dispatcher::ConnectionContext;
use worldbase_core::{dispatcher, Hub};
use worldbase_protocol::event::EVENT_METHOD;
use worldbase_protocol::rpc::{Incoming, RequestId, Response};
use worldbase_protocol::types::Capabilities;

#[derive(Clone)]
struct TransportState {
    hub: Arc<Hub>,
    capabilities: Arc<Capabilities>,
    auth_token: Arc<str>,
}

/// 启动 loopback 传输（阻塞）。
pub async fn run(
    hub: Arc<Hub>,
    listener: tokio::net::TcpListener,
    capabilities: Capabilities,
    auth_token: String,
    ready: std::sync::mpsc::SyncSender<()>,
) -> anyhow::Result<()> {
    let state = TransportState {
        hub,
        capabilities: Arc::new(capabilities),
        auth_token: auth_token.into(),
    };
    let image_hub = state.hub.clone();
    let app = Router::new()
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({ "ok": true })) }),
        )
        .route("/rpc", post(rpc_handler))
        .route("/ws", get(ws_handler))
        .route(
            "/studio/{id}",
            get(move |Path(id): Path<String>| {
                let hub = image_hub.clone();
                async move {
                    match worldbase_core::studio::StudioService::read_image_bytes(&hub, &id) {
                        Ok((bytes, mime)) => {
                            ([(axum::http::header::CONTENT_TYPE, mime)], bytes).into_response()
                        }
                        Err(e) => (StatusCode::NOT_FOUND, format!("{{ \"error\": \"{e}\" }}"))
                            .into_response(),
                    }
                }
            }),
        )
        .route(
            "/lightapp/{id}",
            get(move |Path(id): Path<String>| async move {
                match worldbase_core::studio::StudioService::read_lightapp(&id) {
                    Ok(html) => (
                        [(
                            axum::http::header::CONTENT_TYPE,
                            "text/html; charset=utf-8".to_string(),
                        )],
                        html,
                    )
                        .into_response(),
                    Err(e) => {
                        (StatusCode::NOT_FOUND, format!("{{ \"error\": \"{e}\" }}")).into_response()
                    }
                }
            }),
        )
        .layer(middleware::from_fn_with_state(state.clone(), require_auth))
        .with_state(state);

    let addr = listener.local_addr()?;
    tracing::info!(%addr, "embedded harness transport listening");
    let _ = ready.send(());
    axum::serve(listener, app).await?;
    Ok(())
}

fn has_valid_auth(uri: &Uri, expected: &str) -> bool {
    let Ok(Query(params)) = Query::<HashMap<String, String>>::try_from_uri(uri) else {
        return false;
    };
    params
        .get("token")
        .is_some_and(|supplied| supplied == expected)
}

async fn require_auth(
    State(state): State<TransportState>,
    request: Request,
    next: Next,
) -> AxumResponse {
    if !has_valid_auth(request.uri(), &state.auth_token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(request).await
}

async fn rpc_handler(
    State(state): State<TransportState>,
    Json(incoming): Json<Incoming>,
) -> (StatusCode, Json<Response>) {
    // HTTP has no connection-scoped negotiation state and is intentionally
    // stateless. Capability-sensitive request sequences must use /ws, where
    // one ConnectionContext lives for the socket lifetime.
    let ctx = ConnectionContext::new((*state.capabilities).clone());
    match incoming {
        Incoming::Request(req) => {
            let id = req.id.clone();
            let result = dispatcher::dispatch(&state.hub, &ctx, &req.method, req.params).await;
            let resp = match result {
                Ok(value) => Response::success(id, value),
                Err(err) => Response::error(id, err),
            };
            (StatusCode::OK, Json(resp))
        }
        Incoming::Notification(n) => {
            let _ = dispatcher::dispatch(&state.hub, &ctx, &n.method, n.params).await;
            (
                StatusCode::OK,
                Json(Response::success(
                    RequestId::Null,
                    serde_json::json!({"ok": true}),
                )),
            )
        }
    }
}

async fn ws_handler(
    State(state): State<TransportState>,
    upgrade: WebSocketUpgrade,
) -> axum::response::Response {
    upgrade.on_upgrade(move |socket| ws_connection(state, socket))
}

async fn ws_connection(state: TransportState, socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    // Capability negotiation belongs to the WebSocket connection, not an
    // individual request. `initialize` mutates this context and every later
    // request on the same socket must observe the negotiated capabilities.
    let ctx = Arc::new(ConnectionContext::new((*state.capabilities).clone()));
    // 派发任务可能长时间等待（权限询问/宿主反向请求），响应经 mpsc 回单一写者
    let (resp_tx, mut resp_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut event_rx = state.hub.event_tx.subscribe();
    let writer = tokio::spawn(async move {
        while let Some(text) = resp_rx.recv().await {
            if ws_tx.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });
    let resp_tx_event = resp_tx.clone();

    loop {
        tokio::select! {
            Ok(frame) = event_rx.recv() => {
                let params = serde_json::to_value(&frame).unwrap_or(serde_json::Value::Null);
                let text = worldbase_protocol::rpc::notification(EVENT_METHOD, params);
                if resp_tx_event.send(text).is_err() {
                    break;
                }
            }
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(incoming) = serde_json::from_str::<Incoming>(&text) else {
                            let resp = Response::error(
                                RequestId::Null,
                                worldbase_protocol::rpc::ErrorObject::new(
                                    worldbase_protocol::rpc::PARSE_ERROR,
                                    "invalid json",
                                ),
                            );
                            let _ = resp_tx.send(resp.to_message());
                            continue;
                        };
                        match incoming {
                            Incoming::Request(req) => {
                                let hub = state.hub.clone();
                                let ctx = ctx.clone();
                                let id = req.id.clone();
                                let resp_tx_task = resp_tx.clone();
                                tokio::spawn(async move {
                                    let result = dispatcher::dispatch(&hub, &ctx, &req.method, req.params).await;
                                    let resp = match result {
                                        Ok(value) => Response::success(id, value),
                                        Err(err) => Response::error(id, err),
                                    };
                                    let _ = resp_tx_task.send(resp.to_message());
                                });
                            }
                            Incoming::Notification(n) => {
                                let hub = state.hub.clone();
                                let ctx = ctx.clone();
                                tokio::spawn(async move {
                                    let _ = dispatcher::dispatch(&hub, &ctx, &n.method, n.params).await;
                                });
                            }
                        }
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Binary(_))) => {}
                    _ => break,
                }
            }
            else => break,
        }
    }
    writer.abort();
}

#[cfg(test)]
mod tests {
    use super::has_valid_auth;

    #[test]
    fn auth_query_requires_an_exact_token() {
        let expected = "token+with/special=value";
        assert!(has_valid_auth(
            &"/health?token=token%2Bwith%2Fspecial%3Dvalue"
                .parse()
                .unwrap(),
            expected
        ));
        assert!(!has_valid_auth(&"/health".parse().unwrap(), expected));
        assert!(!has_valid_auth(
            &"/health?token=wrong".parse().unwrap(),
            expected
        ));
    }
}
