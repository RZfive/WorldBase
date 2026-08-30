//! IM 网关：webhook 接收（桌面/server）+ 连接器适配。
//!
//! v1 支持通用 JSON webhook、飞书（自建应用事件订阅）、Slack（URL 验证 +
//! event 回调）。收到消息后交给回调（core 注入 agent 处理），回复走
//! 各连接器的发送 API。

use anyhow::{bail, Context, Result};
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use worldbase_protocol::DEFAULT_SERVE_PORT;

/// 收到 IM 消息的回调：(channel, sender, text) → 回复文本。
pub type OnImMessage = Arc<dyn Fn(&str, &str, &str) -> futures::future::BoxFuture<'static, String> + Send + Sync>;

pub struct ImGateway {
    #[allow(dead_code)]
    channel: String,
    #[allow(dead_code)]
    verify_token: String,
    on_message: OnImMessage,
    shutdown: tokio::sync::watch::Sender<bool>,
}

#[derive(Clone)]
#[allow(dead_code)]
struct GatewayState {
    channel: String,
    verify_token: String,
    on_message: OnImMessage,
}

impl ImGateway {
    /// 启动 webhook 监听（绑定 127.0.0.1:port）。
    pub async fn start(channel: &str, verify_token: &str, port: Option<u16>, on_message: OnImMessage) -> Result<Arc<Self>> {
        let (tx, _rx) = tokio::sync::watch::channel(false);
        let gateway = Arc::new(Self {
            channel: channel.into(),
            verify_token: verify_token.into(),
            on_message,
            shutdown: tx,
        });
        let state = GatewayState {
            channel: channel.into(),
            verify_token: verify_token.into(),
            on_message: gateway.on_message.clone(),
        };
        let app = Router::new()
            .route("/health", get(|| async { "ok" }))
            .route("/webhook/{channel}", post(webhook_handler))
            .with_state(state);

        let port = port.unwrap_or(DEFAULT_SERVE_PORT + 1);
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let (bind_tx, bind_rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let listener = match tokio::net::TcpListener::bind(addr).await {
                Ok(l) => l,
                Err(e) => {
                    let _ = bind_tx.send(Err(e));
                    return;
                }
            };
            let _ = bind_tx.send(Ok(()));
            if let Err(e) = axum::serve(listener, app).await {
                tracing::error!(error = %e, "im gateway serve failed");
            }
        });
        // 等待绑定结果
        match tokio::time::timeout(std::time::Duration::from_secs(3), bind_rx).await {
            Ok(Ok(Ok(()))) => tracing::info!(%addr, "im gateway listening"),
            _ => tracing::warn!(%addr, "im gateway bind pending/failed"),
        }
        Ok(gateway)
    }

    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }
}

async fn webhook_handler(
    State(state): State<GatewayState>,
    Json(payload): Json<Value>,
) -> (StatusCode, Json<Value>) {
    // Slack URL 验证
    if payload["type"] == "url_verification" {
        let challenge = payload["challenge"].as_str().unwrap_or_default();
        return (StatusCode::OK, Json(json!({ "challenge": challenge })));
    }

    let (sender, text) = extract_message(&payload);
    if text.is_empty() {
        return (StatusCode::OK, Json(json!({ "ok": true })));
    }

    let reply = (state.on_message)(&state.channel, &sender, &text).await;
    (StatusCode::OK, Json(json!({ "ok": true, "reply": reply })))
}

/// 从各连接器 payload 中提取 (sender, text)。
fn extract_message(payload: &Value) -> (String, String) {
    // 飞书事件订阅 v2（header.event_type 判别优先于通用 event 键）
    if payload["header"]["event_type"] == "im.message.receive_v1" {
        let sender = payload["event"]["sender"]["sender_id"]["open_id"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        let text = payload["event"]["message"]["content"]["text"]
            .as_str()
            .unwrap_or("")
            .to_string();
        return (sender, text);
    }
    // Slack event 回调
    if let Some(event) = payload.get("event") {
        let sender = event["user"].as_str().unwrap_or("unknown").to_string();
        let text = event["text"].as_str().unwrap_or("").to_string();
        return (sender, text);
    }
    // 通用 JSON：{sender, text}
    let sender = payload["sender"].as_str().unwrap_or("unknown").to_string();
    let text = payload["text"].as_str().unwrap_or("").to_string();
    (sender, text)
}

/// 通过飞书 open API 发送文本消息（需要 tenant_access_token）。
pub async fn send_feishu_text(domain: &str, token: &str, open_id: &str, text: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{domain}/open-apis/im/v1/messages?receive_id_type=open_id"))
        .bearer_auth(token)
        .json(&json!({
            "receive_id": open_id,
            "msg_type": "text",
            "content": json!({ "text": text }).to_string(),
        }))
        .send()
        .await
        .context("feishu send")?;
    if !resp.status().is_success() {
        bail!("feishu send failed: {}", resp.status());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_slack_and_generic() {
        let slack = json!({ "event": { "user": "U1", "text": "hi" } });
        assert_eq!(extract_message(&slack), ("U1".into(), "hi".into()));

        let feishu = json!({
            "header": { "event_type": "im.message.receive_v1" },
            "event": { "sender": { "sender_id": { "open_id": "ou1" } },
                        "message": { "content": { "text": "帮我查天气" } } }
        });
        assert_eq!(extract_message(&feishu), ("ou1".into(), "帮我查天气".into()));

        let generic = json!({ "sender": "alice", "text": "hello" });
        assert_eq!(extract_message(&generic), ("alice".into(), "hello".into()));
    }

    #[tokio::test]
    async fn webhook_end_to_end() {
        let on_msg: OnImMessage = Arc::new(|_ch: &str, sender: &str, text: &str| {
            let sender = sender.to_string();
            let text = text.to_string();
            Box::pin(async move { format!("ack {sender}: {text}") })
        });
        let gw = ImGateway::start("test", "token", Some(19999), on_msg).await.unwrap();
        let client = reqwest::Client::new();
        // 等 listener 起来
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let resp = client
            .post("http://127.0.0.1:19999/webhook/test")
            .json(&json!({ "sender": "alice", "text": "你好" }))
            .send()
            .await
            .unwrap();
        let body: Value = resp.json().await.unwrap();
        assert_eq!(body["reply"], "ack alice: 你好");
        gw.stop();
    }
}
