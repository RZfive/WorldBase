//! Transport-independent IM connector parsing plus an optional Axum webhook
//! server. Electron and other hosts can use the pure request/event APIs without
//! starting a second HTTP listener.

mod connectors;
mod model;
mod outbound;

pub use connectors::{
    decrypt_feishu_payload, decrypt_wechat_payload, parse_channel_event, process_inbound,
    verify_connector_request, verify_feishu_signature, verify_slack_signature,
    verify_wechat_encrypted_signature, verify_wechat_plain_signature,
};
pub use model::{
    ChannelBinding, ChannelEvent, ChannelEventAttachment, ConnectorType, InboundError,
    InboundOutcome, InboundRequest, InlineResponse, OutboundHttpRequest, OutboundPlan,
    UnknownConnector,
};
pub use outbound::{
    build_encrypted_wechat_reply, build_encrypted_wechat_reply_with, build_feishu_reply_request,
    build_feishu_send_text_request, build_feishu_token_request, build_outbound_plan,
    build_telegram_request, build_wechat_text_reply, build_wechat_text_reply_at,
    execute_outbound_plan, execute_outbound_request, DeliveryOutcome,
};

use anyhow::{bail, Context, Result};
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::str::FromStr;
use std::sync::Arc;
use worldbase_protocol::DEFAULT_SERVE_PORT;

/// Received message callback: `(channel, sender, text) -> reply text`.
pub type OnImMessage =
    Arc<dyn Fn(&str, &str, &str) -> futures::future::BoxFuture<'static, String> + Send + Sync>;

pub struct ImGateway {
    channel: String,
    binding: ChannelBinding,
    on_message: OnImMessage,
    shutdown: tokio::sync::watch::Sender<bool>,
    local_addr: SocketAddr,
}

#[derive(Clone)]
struct GatewayState {
    route_channel: String,
    binding: ChannelBinding,
    on_message: OnImMessage,
    http: reqwest::Client,
}

impl ImGateway {
    /// Start the compatibility single-binding server. Known connector names use
    /// their native parser; any historical custom channel uses the generic
    /// connector while preserving its route and callback name.
    pub async fn start(
        channel: &str,
        verify_token: &str,
        port: Option<u16>,
        on_message: OnImMessage,
    ) -> Result<Arc<Self>> {
        let connector = ConnectorType::from_str(channel).unwrap_or(ConnectorType::Custom);
        let binding = ChannelBinding::legacy(connector, verify_token);
        Self::start_inner(channel, binding, port, on_message).await
    }

    /// Start a server using a complete Electron-compatible connector binding.
    pub async fn start_with_binding(
        binding: ChannelBinding,
        port: Option<u16>,
        on_message: OnImMessage,
    ) -> Result<Arc<Self>> {
        let route_channel = binding.connector_type.as_str().to_string();
        Self::start_inner(&route_channel, binding, port, on_message).await
    }

    async fn start_inner(
        route_channel: &str,
        binding: ChannelBinding,
        port: Option<u16>,
        on_message: OnImMessage,
    ) -> Result<Arc<Self>> {
        let port = port.unwrap_or(DEFAULT_SERVE_PORT + 1);
        let requested_addr = SocketAddr::from(([127, 0, 0, 1], port));
        let listener = tokio::net::TcpListener::bind(requested_addr)
            .await
            .with_context(|| format!("failed to bind IM gateway at {requested_addr}"))?;
        let local_addr = listener
            .local_addr()
            .context("failed to read IM gateway listener address")?;
        let (shutdown, mut shutdown_rx) = tokio::sync::watch::channel(false);
        let gateway = Arc::new(Self {
            channel: route_channel.to_string(),
            binding: binding.clone(),
            on_message: on_message.clone(),
            shutdown,
            local_addr,
        });
        let state = GatewayState {
            route_channel: route_channel.to_string(),
            binding,
            on_message,
            http: reqwest::Client::new(),
        };
        let app = Router::new()
            .route("/health", get(health_handler))
            .route(
                "/webhook/{channel}",
                get(webhook_handler).post(webhook_handler),
            )
            .with_state(state);

        tokio::spawn(async move {
            let shutdown_signal = async move {
                loop {
                    if *shutdown_rx.borrow() {
                        break;
                    }
                    if shutdown_rx.changed().await.is_err() {
                        break;
                    }
                }
            };
            if let Err(error) = axum::serve(listener, app)
                .with_graceful_shutdown(shutdown_signal)
                .await
            {
                tracing::error!(%error, "IM gateway server failed");
            }
        });
        tracing::info!(address = %local_addr, connector = %gateway.binding.connector_type, "IM gateway listening");
        Ok(gateway)
    }

    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn channel(&self) -> &str {
        &self.channel
    }

    pub fn binding(&self) -> &ChannelBinding {
        &self.binding
    }

    pub fn callback(&self) -> &OnImMessage {
        &self.on_message
    }
}

async fn health_handler() -> Json<Value> {
    Json(json!({ "ok": true, "service": "im-gateway" }))
}

async fn webhook_handler(
    State(state): State<GatewayState>,
    Path(channel): Path<String>,
    method: Method,
    headers: HeaderMap,
    Query(query): Query<BTreeMap<String, String>>,
    body: Bytes,
) -> Response {
    if channel != state.route_channel {
        return json_response(
            StatusCode::NOT_FOUND,
            json!({ "error": "Unknown IM connector" }),
        );
    }
    let raw_body = String::from_utf8_lossy(&body).into_owned();
    let body = decode_request_body(&headers, &raw_body);
    let request = InboundRequest {
        method: method.as_str().to_string(),
        headers: header_map(&headers),
        query,
        body,
        raw_body,
        received_at: Some(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)),
    };

    match process_inbound(state.binding.connector_type, &request, &state.binding) {
        Ok(InboundOutcome::Ignored) => {
            json_response(StatusCode::OK, json!({ "ok": true, "ignored": true }))
        }
        Ok(InboundOutcome::JsonChallenge { body }) => json_response(StatusCode::OK, body),
        Ok(InboundOutcome::TextChallenge { body }) => {
            text_response(StatusCode::OK, "text/plain; charset=utf-8", body)
        }
        Ok(InboundOutcome::Message { event }) => {
            if !state.binding.auto_reply {
                return if matches!(
                    state.binding.connector_type,
                    ConnectorType::Wechat | ConnectorType::Wecom
                ) {
                    text_response(
                        StatusCode::OK,
                        "text/plain; charset=utf-8",
                        "success".into(),
                    )
                } else {
                    json_response(
                        StatusCode::OK,
                        json!({ "ok": true, "accepted": true, "autoReply": false }),
                    )
                };
            }
            let reply =
                (state.on_message)(&state.route_channel, &event.sender_id, &event.text).await;
            if reply.is_empty() {
                return if matches!(
                    state.binding.connector_type,
                    ConnectorType::Wechat | ConnectorType::Wecom
                ) {
                    text_response(
                        StatusCode::OK,
                        "text/plain; charset=utf-8",
                        "success".into(),
                    )
                } else {
                    json_response(
                        StatusCode::OK,
                        json!({ "ok": true, "accepted": true, "reply": Value::Null }),
                    )
                };
            }
            match build_outbound_plan(state.binding.connector_type, &state.binding, &event, &reply)
            {
                Ok(OutboundPlan::Inline { response }) => {
                    text_response(StatusCode::OK, &response.content_type, response.body)
                }
                Ok(plan @ (OutboundPlan::Http { .. } | OutboundPlan::FeishuAppReply { .. })) => {
                    match execute_outbound_plan(&state.http, &plan).await {
                        Ok(DeliveryOutcome::Delivered { success, .. }) => {
                            if state.binding.connector_type == ConnectorType::Wechat {
                                text_response(
                                    StatusCode::OK,
                                    "text/plain; charset=utf-8",
                                    "success".into(),
                                )
                            } else {
                                json_response(
                                    StatusCode::OK,
                                    json!({ "ok": true, "accepted": true, "delivered": success, "reply": reply }),
                                )
                            }
                        }
                        Ok(_) => json_response(
                            StatusCode::OK,
                            json!({ "ok": true, "accepted": true, "delivered": false, "reply": reply }),
                        ),
                        Err(error) => json_response(
                            StatusCode::BAD_GATEWAY,
                            json!({ "error": error.to_string() }),
                        ),
                    }
                }
                Ok(OutboundPlan::None) => {
                    json_response(StatusCode::OK, json!({ "ok": true, "reply": reply }))
                }
                Err(error) => json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": error.to_string() }),
                ),
            }
        }
        Err(InboundError::Unauthorized) => json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Invalid IM webhook signature or secret" }),
        ),
        Err(InboundError::InvalidPayload(message)) => {
            json_response(StatusCode::BAD_REQUEST, json!({ "error": message }))
        }
    }
}

fn decode_request_body(headers: &HeaderMap, raw: &str) -> Value {
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if content_type.contains("application/x-www-form-urlencoded") {
        if let Ok(values) = serde_urlencoded::from_str::<BTreeMap<String, String>>(raw) {
            return Value::Object(
                values
                    .into_iter()
                    .map(|(key, value)| (key, Value::String(value)))
                    .collect::<Map<_, _>>(),
            );
        }
    }
    serde_json::from_str(raw).unwrap_or(Value::Null)
}

fn header_map(headers: &HeaderMap) -> BTreeMap<String, String> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_ascii_lowercase(), value.to_string()))
        })
        .collect()
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn text_response(status: StatusCode, content_type: &str, body: String) -> Response {
    let content_type = HeaderValue::from_str(content_type)
        .unwrap_or_else(|_| HeaderValue::from_static("text/plain; charset=utf-8"));
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .expect("valid IM response")
}

/// Compatibility API for sending a Feishu text message by open ID.
pub async fn send_feishu_text(domain: &str, token: &str, open_id: &str, text: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let request = build_feishu_send_text_request(domain, token, open_id, text);
    let response = execute_outbound_request(&client, &request)
        .await
        .context("feishu send")?;
    if !response.status().is_success() {
        bail!("feishu send failed: {}", response.status());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn compatibility_webhook_end_to_end() {
        let on_message: OnImMessage = Arc::new(|channel: &str, sender: &str, text: &str| {
            let channel = channel.to_string();
            let sender = sender.to_string();
            let text = text.to_string();
            Box::pin(async move { format!("ack {channel}/{sender}: {text}") })
        });
        let gateway = ImGateway::start("test", "", Some(0), on_message)
            .await
            .unwrap();
        let response = reqwest::Client::new()
            .post(format!("http://{}/webhook/test", gateway.local_addr()))
            .json(&json!({ "sender": "alice", "text": "hello" }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["reply"], "ack test/alice: hello");
        gateway.stop();
    }
}
