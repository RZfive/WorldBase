use crate::connectors::{sorted_sha1_hex, wechat_aes_key};
use crate::model::{
    ChannelBinding, ChannelEvent, ConnectorType, InlineResponse, OutboundHttpRequest, OutboundPlan,
};
use aes::Aes256;
use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use cbc::cipher::block_padding::NoPadding;
use cbc::cipher::{BlockEncryptMut, KeyIvInit};
use chrono::Utc;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

impl OutboundHttpRequest {
    fn json(url: String, body: Value) -> Self {
        Self {
            method: "POST".into(),
            url,
            headers: BTreeMap::from([("content-type".into(), "application/json".into())]),
            body,
        }
    }

    fn bearer(mut self, token: &str) -> Self {
        self.headers
            .insert("authorization".into(), format!("Bearer {token}"));
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeliveryOutcome {
    NotConfigured,
    Delivered { success: bool, status: u16 },
    Inline { response: InlineResponse },
}

/// Build the transport action corresponding to Electron's connector delivery
/// order. No network request is made by this function.
pub fn build_outbound_plan(
    connector: ConnectorType,
    binding: &ChannelBinding,
    event: &ChannelEvent,
    reply: &str,
) -> Result<OutboundPlan> {
    if connector != binding.connector_type || connector != event.connector_type {
        bail!("connector, binding, and event types must match");
    }

    if matches!(connector, ConnectorType::Wechat | ConnectorType::Wecom)
        && non_empty(binding.outgoing_webhook_url.as_deref()).is_none()
    {
        let body = if non_empty(binding.encrypt_key.as_deref()).is_some() {
            build_encrypted_wechat_reply(binding, event, reply)?
        } else {
            build_wechat_text_reply(event, reply)
        };
        return Ok(OutboundPlan::Inline {
            response: InlineResponse {
                content_type: "application/xml".into(),
                body,
            },
        });
    }

    if connector == ConnectorType::Feishu {
        if let (Some(app_id), Some(app_secret)) = (
            non_empty(binding.app_id.as_deref()),
            non_empty(binding.app_secret.as_deref()),
        ) {
            if !event.message_id.is_empty() {
                return Ok(OutboundPlan::FeishuAppReply {
                    token_request: build_feishu_token_request(app_id, app_secret),
                    message_id: event.message_id.clone(),
                    text: reply.to_string(),
                });
            }
        }
    }

    if connector == ConnectorType::Telegram {
        if let Some(token) = non_empty(binding.app_secret.as_deref()) {
            if !event.channel_id.is_empty() {
                return Ok(OutboundPlan::Http {
                    request: build_telegram_request(token, &event.channel_id, reply),
                });
            }
        }
    }

    let webhook_url = event
        .reply_webhook_url
        .as_deref()
        .and_then(non_empty_value)
        .or_else(|| {
            binding
                .outgoing_webhook_url
                .as_deref()
                .and_then(non_empty_value)
        });
    let Some(webhook_url) = webhook_url else {
        return Ok(OutboundPlan::None);
    };

    Ok(OutboundPlan::Http {
        request: OutboundHttpRequest::json(
            webhook_url.to_string(),
            webhook_payload(connector, binding, event, reply),
        ),
    })
}

pub fn build_feishu_token_request(app_id: &str, app_secret: &str) -> OutboundHttpRequest {
    OutboundHttpRequest::json(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal".into(),
        json!({ "app_id": app_id, "app_secret": app_secret }),
    )
}

pub fn build_feishu_reply_request(
    tenant_access_token: &str,
    message_id: &str,
    text: &str,
) -> OutboundHttpRequest {
    OutboundHttpRequest::json(
        format!(
            "https://open.feishu.cn/open-apis/im/v1/messages/{}/reply",
            encode_path_segment(message_id)
        ),
        json!({
            "msg_type": "text",
            "content": json!({ "text": text }).to_string(),
        }),
    )
    .bearer(tenant_access_token)
}

pub fn build_feishu_send_text_request(
    domain: &str,
    token: &str,
    open_id: &str,
    text: &str,
) -> OutboundHttpRequest {
    OutboundHttpRequest::json(
        format!(
            "{}/open-apis/im/v1/messages?receive_id_type=open_id",
            domain.trim_end_matches('/')
        ),
        json!({
            "receive_id": open_id,
            "msg_type": "text",
            "content": json!({ "text": text }).to_string(),
        }),
    )
    .bearer(token)
}

pub fn build_telegram_request(token: &str, chat_id: &str, text: &str) -> OutboundHttpRequest {
    OutboundHttpRequest::json(
        format!("https://api.telegram.org/bot{token}/sendMessage"),
        json!({ "chat_id": chat_id, "text": text }),
    )
}

pub fn build_wechat_text_reply(event: &ChannelEvent, text: &str) -> String {
    build_wechat_text_reply_at(event, text, Utc::now().timestamp())
}

pub fn build_wechat_text_reply_at(event: &ChannelEvent, text: &str, timestamp: i64) -> String {
    [
        "<xml>".to_string(),
        format!("<ToUserName><![CDATA[{}]]></ToUserName>", event.sender_id),
        format!(
            "<FromUserName><![CDATA[{}]]></FromUserName>",
            event.channel_id
        ),
        format!("<CreateTime>{timestamp}</CreateTime>"),
        "<MsgType><![CDATA[text]]></MsgType>".into(),
        format!("<Content>{}</Content>", escape_xml(text)),
        "</xml>".into(),
    ]
    .join("")
}

pub fn build_encrypted_wechat_reply(
    binding: &ChannelBinding,
    event: &ChannelEvent,
    text: &str,
) -> Result<String> {
    let mut random_prefix = [0u8; 16];
    OsRng.fill_bytes(&mut random_prefix);
    let mut nonce_bytes = [0u8; 8];
    OsRng.fill_bytes(&mut nonce_bytes);
    build_encrypted_wechat_reply_with(
        binding,
        event,
        text,
        Utc::now().timestamp(),
        &hex(&nonce_bytes),
        random_prefix,
    )
}

/// Deterministic encrypted reply builder for protocol conformance tests.
pub fn build_encrypted_wechat_reply_with(
    binding: &ChannelBinding,
    event: &ChannelEvent,
    text: &str,
    timestamp: i64,
    nonce: &str,
    random_prefix: [u8; 16],
) -> Result<String> {
    let token = non_empty(binding.verification_token.as_deref())
        .ok_or_else(|| anyhow!("encrypted WeChat replies require a verification token"))?;
    let key = non_empty(binding.encrypt_key.as_deref())
        .ok_or_else(|| anyhow!("encrypted WeChat replies require EncodingAESKey"))?;
    let xml = build_wechat_text_reply_at(event, text, timestamp);
    let encrypted = encrypt_wechat_payload(
        key,
        binding.app_id.as_deref().unwrap_or_default(),
        &xml,
        random_prefix,
    )?;
    let timestamp = timestamp.to_string();
    let signature = sorted_sha1_hex(&[token, &timestamp, nonce, &encrypted]);
    Ok([
        "<xml>".to_string(),
        format!("<Encrypt><![CDATA[{encrypted}]]></Encrypt>"),
        format!("<MsgSignature><![CDATA[{signature}]]></MsgSignature>"),
        format!("<TimeStamp>{timestamp}</TimeStamp>"),
        format!("<Nonce><![CDATA[{nonce}]]></Nonce>"),
        "</xml>".into(),
    ]
    .join(""))
}

/// Execute a prepared HTTP request. Callers retain control over inline replies.
pub async fn execute_outbound_request(
    client: &reqwest::Client,
    request: &OutboundHttpRequest,
) -> Result<reqwest::Response> {
    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .context("invalid outbound HTTP method")?;
    let mut builder = client.request(method, &request.url);
    for (name, value) in &request.headers {
        builder = builder.header(name, value);
    }
    builder
        .json(&request.body)
        .send()
        .await
        .with_context(|| format!("IM outbound request failed: {}", request.url))
}

/// Execute direct and two-stage Feishu plans. Inline XML remains a response for
/// the caller to return on the original webhook connection.
pub async fn execute_outbound_plan(
    client: &reqwest::Client,
    plan: &OutboundPlan,
) -> Result<DeliveryOutcome> {
    match plan {
        OutboundPlan::None => Ok(DeliveryOutcome::NotConfigured),
        OutboundPlan::Inline { response } => Ok(DeliveryOutcome::Inline {
            response: response.clone(),
        }),
        OutboundPlan::Http { request } => {
            let response = execute_outbound_request(client, request).await?;
            Ok(DeliveryOutcome::Delivered {
                success: response.status().is_success(),
                status: response.status().as_u16(),
            })
        }
        OutboundPlan::FeishuAppReply {
            token_request,
            message_id,
            text,
        } => {
            let response = execute_outbound_request(client, token_request).await?;
            let status = response.status();
            if !status.is_success() {
                return Ok(DeliveryOutcome::Delivered {
                    success: false,
                    status: status.as_u16(),
                });
            }
            let payload: Value = response
                .json()
                .await
                .context("invalid Feishu tenant token response")?;
            let token = payload
                .get("tenant_access_token")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    anyhow!("Feishu tenant token response omitted tenant_access_token")
                })?;
            let request = build_feishu_reply_request(token, message_id, text);
            let response = execute_outbound_request(client, &request).await?;
            Ok(DeliveryOutcome::Delivered {
                success: response.status().is_success(),
                status: response.status().as_u16(),
            })
        }
    }
}

fn webhook_payload(
    connector: ConnectorType,
    binding: &ChannelBinding,
    event: &ChannelEvent,
    reply: &str,
) -> Value {
    match connector {
        ConnectorType::Wecom => json!({ "msgtype": "text", "text": { "content": reply } }),
        ConnectorType::Slack => json!({ "text": reply }),
        ConnectorType::Discord => json!({ "content": reply }),
        _ => {
            let mut payload = Map::from_iter([
                ("text".into(), Value::String(reply.into())),
                ("reply".into(), Value::String(reply.into())),
                ("channelId".into(), Value::String(event.channel_id.clone())),
                ("bindingId".into(), Value::String(binding.id.clone())),
            ]);
            if let Some(thread_id) = event.thread_id.as_ref() {
                payload.insert("threadId".into(), Value::String(thread_id.clone()));
            }
            Value::Object(payload)
        }
    }
}

fn encrypt_wechat_payload(
    encrypt_key: &str,
    receive_id: &str,
    xml: &str,
    random_prefix: [u8; 16],
) -> Result<String> {
    let key = wechat_aes_key(encrypt_key)?;
    let message = xml.as_bytes();
    let message_len = u32::try_from(message.len()).context("WeChat reply is too large")?;
    let mut plain = Vec::with_capacity(20 + message.len() + receive_id.len() + 32);
    plain.extend_from_slice(&random_prefix);
    plain.extend_from_slice(&message_len.to_be_bytes());
    plain.extend_from_slice(message);
    plain.extend_from_slice(receive_id.as_bytes());
    add_wechat_padding(&mut plain);
    let encryptor = cbc::Encryptor::<Aes256>::new_from_slices(&key, &key[..16])
        .map_err(|_| anyhow!("invalid WeChat AES key"))?;
    let encrypted = encryptor.encrypt_padded_vec_mut::<NoPadding>(&plain);
    Ok(BASE64.encode(encrypted))
}

fn add_wechat_padding(value: &mut Vec<u8>) {
    let remainder = value.len() % 32;
    let pad = if remainder == 0 { 32 } else { 32 - remainder };
    value.extend(std::iter::repeat_n(pad as u8, pad));
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn encode_path_segment(value: &str) -> String {
    let mut output = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
            output.push(*byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.and_then(non_empty_value)
}

fn non_empty_value(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}
