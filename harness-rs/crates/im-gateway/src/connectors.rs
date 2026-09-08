use crate::model::{
    ChannelBinding, ChannelEvent, ChannelEventAttachment, ConnectorType, InboundError,
    InboundOutcome, InboundRequest,
};
use aes::Aes256;
use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use cbc::cipher::block_padding::{NoPadding, Pkcs7};
use cbc::cipher::{BlockDecryptMut, KeyIvInit};
use chrono::{DateTime, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use sha2::Sha256;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

/// Authenticate, decode, and normalize one connector request.
pub fn process_inbound(
    connector: ConnectorType,
    request: &InboundRequest,
    binding: &ChannelBinding,
) -> std::result::Result<InboundOutcome, InboundError> {
    if binding.connector_type != connector {
        return Err(InboundError::InvalidPayload(format!(
            "binding connector {} does not match request connector {connector}",
            binding.connector_type
        )));
    }

    if let Some(challenge) = parse_challenge(connector, request, binding)? {
        return Ok(challenge);
    }
    if !verify_connector_request(connector, request, binding) {
        return Err(InboundError::Unauthorized);
    }

    let event = parse_channel_event(connector, request, Some(binding))
        .map_err(|error| InboundError::InvalidPayload(error.to_string()))?;
    let Some(event) = event else {
        return Ok(InboundOutcome::Ignored);
    };

    // Feishu's verification token is inside the decrypted event envelope.
    if connector == ConnectorType::Feishu
        && !verify_optional_feishu_token(event.raw_payload.as_ref(), binding, false)
    {
        return Err(InboundError::Unauthorized);
    }
    if binding
        .bot_user_id
        .as_deref()
        .is_some_and(|bot| !bot.is_empty() && bot == event.sender_id)
    {
        return Ok(InboundOutcome::Ignored);
    }

    Ok(InboundOutcome::Message {
        event: Box::new(event),
    })
}

/// Verify a request without parsing its message content. Secrets are optional;
/// once configured, missing credentials fail closed.
pub fn verify_connector_request(
    connector: ConnectorType,
    request: &InboundRequest,
    binding: &ChannelBinding,
) -> bool {
    match connector {
        ConnectorType::Feishu => {
            verify_optional_feishu_token(Some(&request.body), binding, false)
                && verify_feishu_signature(request, binding)
        }
        ConnectorType::Wechat => {
            let encrypted = xml_tag(&request.raw_body(), "Encrypt");
            if encrypted.is_empty() {
                verify_wechat_plain_signature(
                    binding,
                    request.query("timestamp"),
                    request.query("nonce"),
                    request.query("signature"),
                )
            } else {
                verify_wechat_encrypted_signature(
                    binding,
                    request.query("timestamp"),
                    request.query("nonce"),
                    &encrypted,
                    request.query("msg_signature"),
                )
            }
        }
        ConnectorType::Wecom => {
            let encrypted = xml_tag(&request.raw_body(), "Encrypt");
            if encrypted.is_empty() {
                verify_wechat_plain_signature(
                    binding,
                    request.query("timestamp"),
                    request.query("nonce"),
                    request.query("signature"),
                )
            } else {
                verify_wechat_encrypted_signature(
                    binding,
                    request.query("timestamp"),
                    request.query("nonce"),
                    &encrypted,
                    request.query("msg_signature"),
                )
            }
        }
        ConnectorType::Slack => match non_empty(binding.incoming_secret.as_deref()) {
            None => true,
            Some(_) if !request.header("x-slack-signature").is_empty() => {
                verify_slack_signature(request, binding)
            }
            Some(_) => verify_shared_secret(request, binding),
        },
        ConnectorType::Telegram => {
            non_empty(binding.incoming_secret.as_deref()).is_none_or(|secret| {
                safe_compare(
                    secret.as_bytes(),
                    request.header("x-telegram-bot-api-secret-token").as_bytes(),
                )
            })
        }
        ConnectorType::Discord | ConnectorType::Custom => verify_shared_secret(request, binding),
    }
}

pub fn verify_slack_signature(request: &InboundRequest, binding: &ChannelBinding) -> bool {
    let Some(secret) = non_empty(binding.incoming_secret.as_deref()) else {
        return true;
    };
    let timestamp = request.header("x-slack-request-timestamp");
    let signature = request.header("x-slack-signature");
    if timestamp.is_empty() || signature.is_empty() {
        return false;
    }
    let payload = format!("v0:{timestamp}:{}", request.raw_body());
    let Ok(digest) = hmac_sha256(secret.as_bytes(), payload.as_bytes()) else {
        return false;
    };
    safe_compare(
        format!("v0={}", hex(&digest)).as_bytes(),
        signature.as_bytes(),
    )
}

pub fn verify_feishu_signature(request: &InboundRequest, binding: &ChannelBinding) -> bool {
    let Some(encrypt_key) = non_empty(binding.encrypt_key.as_deref()) else {
        return true;
    };
    let timestamp = first_header(
        request,
        &["x-lark-request-timestamp", "x-feishu-request-timestamp"],
    );
    let nonce = first_header(request, &["x-lark-request-nonce", "x-feishu-request-nonce"]);
    let signature = first_header(request, &["x-lark-signature", "x-feishu-signature"]);
    if timestamp.is_empty() || nonce.is_empty() || signature.is_empty() {
        return false;
    }

    let raw_body = request.raw_body();
    let signature_base = format!("{timestamp}{nonce}{encrypt_key}{raw_body}");
    let sha = Sha256::digest(signature_base.as_bytes());
    let mut candidates = vec![hex(&sha), BASE64.encode(sha)];
    if let Ok(value) = hmac_sha256(
        format!("{timestamp}{nonce}{encrypt_key}").as_bytes(),
        raw_body.as_bytes(),
    ) {
        candidates.push(BASE64.encode(value));
    }
    if let Ok(value) = hmac_sha256(
        encrypt_key.as_bytes(),
        format!("{timestamp}{nonce}{raw_body}").as_bytes(),
    ) {
        candidates.push(hex(&value));
        candidates.push(BASE64.encode(value));
    }
    candidates
        .iter()
        .any(|candidate| safe_compare(candidate.as_bytes(), signature.as_bytes()))
}

pub fn verify_wechat_plain_signature(
    binding: &ChannelBinding,
    timestamp: &str,
    nonce: &str,
    signature: &str,
) -> bool {
    let Some(token) = non_empty(binding.verification_token.as_deref()) else {
        return true;
    };
    if timestamp.is_empty() || nonce.is_empty() || signature.is_empty() {
        return false;
    }
    let expected = sorted_sha1_hex(&[token, timestamp, nonce]);
    safe_compare(expected.as_bytes(), signature.as_bytes())
}

pub fn verify_wechat_encrypted_signature(
    binding: &ChannelBinding,
    timestamp: &str,
    nonce: &str,
    encrypted: &str,
    signature: &str,
) -> bool {
    let Some(token) = non_empty(binding.verification_token.as_deref()) else {
        return true;
    };
    if timestamp.is_empty() || nonce.is_empty() || encrypted.is_empty() || signature.is_empty() {
        return false;
    }
    let expected = sorted_sha1_hex(&[token, timestamp, nonce, encrypted]);
    safe_compare(expected.as_bytes(), signature.as_bytes())
}

pub fn decrypt_feishu_payload(encrypt_key: &str, encrypted: &str) -> Result<Value> {
    let key = Sha256::digest(encrypt_key.as_bytes());
    let mut bytes = BASE64
        .decode(encrypted)
        .context("Feishu encrypted payload is not valid base64")?;
    let decryptor = cbc::Decryptor::<Aes256>::new_from_slices(&key, &key[..16])
        .map_err(|_| anyhow!("invalid Feishu AES key"))?;
    let decrypted = decryptor
        .decrypt_padded_mut::<Pkcs7>(&mut bytes)
        .map_err(|_| anyhow!("invalid Feishu encrypted payload"))?;
    serde_json::from_slice(decrypted).context("Feishu decrypted payload is not a JSON object")
}

pub fn decrypt_wechat_payload(encrypt_key: &str, encrypted: &str) -> Result<String> {
    let key = wechat_aes_key(encrypt_key)?;
    let mut bytes = BASE64
        .decode(encrypted)
        .context("WeChat encrypted payload is not valid base64")?;
    if bytes.is_empty() || bytes.len() % 16 != 0 {
        bail!("invalid WeChat encrypted payload length");
    }
    let decryptor = cbc::Decryptor::<Aes256>::new_from_slices(&key, &key[..16])
        .map_err(|_| anyhow!("invalid WeChat AES key"))?;
    let decrypted = decryptor
        .decrypt_padded_mut::<NoPadding>(&mut bytes)
        .map_err(|_| anyhow!("invalid WeChat encrypted payload"))?;
    let unpadded = remove_wechat_padding(decrypted)?;
    if unpadded.len() < 20 {
        bail!("decrypted WeChat payload is too short");
    }
    let message_len = u32::from_be_bytes(
        unpadded[16..20]
            .try_into()
            .expect("four-byte message length"),
    ) as usize;
    let end = 20usize
        .checked_add(message_len)
        .filter(|end| *end <= unpadded.len())
        .ok_or_else(|| anyhow!("invalid WeChat decrypted message length"))?;
    String::from_utf8(unpadded[20..end].to_vec()).context("WeChat message is not UTF-8")
}

pub(crate) fn wechat_aes_key(encrypt_key: &str) -> Result<[u8; 32]> {
    let normalized = if encrypt_key.len() == 43 {
        format!("{encrypt_key}=")
    } else {
        encrypt_key.to_string()
    };
    let decoded = BASE64
        .decode(normalized)
        .context("EncodingAESKey is not valid base64")?;
    decoded
        .try_into()
        .map_err(|_| anyhow!("EncodingAESKey must decode to exactly 32 bytes"))
}

pub fn parse_channel_event(
    connector: ConnectorType,
    request: &InboundRequest,
    binding: Option<&ChannelBinding>,
) -> Result<Option<ChannelEvent>> {
    match connector {
        ConnectorType::Feishu => parse_feishu_event(request, binding),
        ConnectorType::Wechat => parse_wechat_event(request, binding, ConnectorType::Wechat),
        ConnectorType::Wecom if request.header("content-type").contains("json") => {
            parse_generic_event(ConnectorType::Wecom, request)
        }
        ConnectorType::Wecom => parse_wechat_event(request, binding, ConnectorType::Wecom),
        ConnectorType::Telegram => parse_telegram_event(request),
        ConnectorType::Slack => parse_slack_event(request),
        ConnectorType::Discord | ConnectorType::Custom => parse_generic_event(connector, request),
    }
}

fn parse_challenge(
    connector: ConnectorType,
    request: &InboundRequest,
    binding: &ChannelBinding,
) -> std::result::Result<Option<InboundOutcome>, InboundError> {
    if connector == ConnectorType::Slack
        && string_at(&request.body, &["type"]) == "url_verification"
    {
        if !verify_connector_request(connector, request, binding) {
            return Err(InboundError::Unauthorized);
        }
        return Ok(Some(InboundOutcome::JsonChallenge {
            body: json!({ "challenge": string_at(&request.body, &["challenge"]) }),
        }));
    }

    if connector == ConnectorType::Feishu {
        if !verify_connector_request(connector, request, binding) {
            return Err(InboundError::Unauthorized);
        }
        let body = feishu_body(request, Some(binding))
            .map_err(|error| InboundError::InvalidPayload(error.to_string()))?;
        if string_at(&body, &["type"]) == "url_verification" {
            if !verify_optional_feishu_token(Some(&body), binding, true) {
                return Err(InboundError::Unauthorized);
            }
            return Ok(Some(InboundOutcome::JsonChallenge {
                body: json!({ "challenge": string_at(&body, &["challenge"]) }),
            }));
        }
    }

    if matches!(connector, ConnectorType::Wechat | ConnectorType::Wecom)
        && request.method.eq_ignore_ascii_case("GET")
    {
        let echo = request.query("echostr");
        let message_signature = request.query("msg_signature");
        let valid = if message_signature.is_empty() {
            verify_wechat_plain_signature(
                binding,
                request.query("timestamp"),
                request.query("nonce"),
                request.query("signature"),
            )
        } else {
            verify_wechat_encrypted_signature(
                binding,
                request.query("timestamp"),
                request.query("nonce"),
                echo,
                message_signature,
            )
        };
        if !valid {
            return Err(InboundError::Unauthorized);
        }
        let body = if message_signature.is_empty() {
            echo.to_string()
        } else {
            decrypt_wechat_payload(binding.encrypt_key.as_deref().unwrap_or_default(), echo)
                .map_err(|error| InboundError::InvalidPayload(error.to_string()))?
        };
        return Ok(Some(InboundOutcome::TextChallenge { body }));
    }

    Ok(None)
}

fn parse_feishu_event(
    request: &InboundRequest,
    binding: Option<&ChannelBinding>,
) -> Result<Option<ChannelEvent>> {
    let body = feishu_body(request, binding)?;
    let event = value_at(&body, &["event"]);
    let message = value_at(event, &["message"]);
    let raw_content = value_at(message, &["content"]);
    let content_string = string_value(raw_content);
    let content = if raw_content.is_object() {
        raw_content.clone()
    } else {
        parse_json_value(&content_string)
    };
    let text = first_non_empty(&[
        string_at(&content, &["text"]),
        content_string,
        string_at(event, &["text_without_at_bot"]),
        string_at(event, &["text"]),
    ]);
    if text.is_empty() {
        return Ok(None);
    }
    let mentions = value_at(message, &["mentions"])
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    first_non_empty(&[
                        string_at(item, &["name"]),
                        string_at(item, &["id", "open_id"]),
                    ])
                })
                .filter(|value| !value.is_empty())
                .collect()
        })
        .unwrap_or_default();

    Ok(Some(ChannelEvent {
        connector_type: ConnectorType::Feishu,
        channel_id: first_non_empty(&[
            string_at(message, &["chat_id"]),
            string_at(message, &["open_chat_id"]),
            string_at(event, &["open_chat_id"]),
            string_at(event, &["chat_id"]),
        ]),
        thread_id: optional(first_non_empty(&[string_at(message, &["thread_id"])])),
        message_id: first_non_empty(&[
            string_at(message, &["message_id"]),
            string_at(event, &["message_id"]),
            string_at(&body, &["header", "event_id"]),
            generated_id("feishu", request),
        ]),
        sender_id: first_non_empty(&[
            string_at(event, &["sender", "sender_id", "open_id"]),
            string_at(event, &["sender", "sender_id", "user_id"]),
            string_at(event, &["open_id"]),
            "feishu-user".into(),
        ]),
        sender_name: optional(first_non_empty(&[
            string_at(event, &["sender", "sender_type"]),
            string_at(event, &["user_name"]),
        ])),
        text,
        attachments: Vec::new(),
        mentions,
        created_at: timestamp_value(
            first_value(&[
                value_at(message, &["create_time"]),
                value_at(event, &["create_time"]),
            ]),
            request,
        ),
        reply_webhook_url: None,
        raw_payload: Some(body),
    }))
}

fn parse_wechat_event(
    request: &InboundRequest,
    binding: Option<&ChannelBinding>,
    connector: ConnectorType,
) -> Result<Option<ChannelEvent>> {
    let raw_xml = request.raw_body();
    let encrypted = xml_tag(&raw_xml, "Encrypt");
    let xml = if encrypted.is_empty() {
        raw_xml
    } else {
        let binding =
            binding.ok_or_else(|| anyhow!("encrypted {connector} event requires a binding"))?;
        let encrypt_key = non_empty(binding.encrypt_key.as_deref())
            .ok_or_else(|| anyhow!("encrypted {connector} event requires EncodingAESKey"))?;
        decrypt_wechat_payload(encrypt_key, &encrypted)?
    };
    let text = xml_tag(&xml, "Content");
    if text.is_empty() {
        return Ok(None);
    }
    let fallback = match connector {
        ConnectorType::Wechat => "wechat",
        _ => "wecom",
    };
    let default_sender = format!("{fallback}-user");
    Ok(Some(ChannelEvent {
        connector_type: connector,
        channel_id: first_non_empty(&[xml_tag(&xml, "ToUserName"), fallback.into()]),
        thread_id: None,
        message_id: first_non_empty(&[xml_tag(&xml, "MsgId"), generated_id(fallback, request)]),
        sender_id: first_non_empty(&[xml_tag(&xml, "FromUserName"), default_sender]),
        sender_name: None,
        text,
        attachments: Vec::new(),
        mentions: Vec::new(),
        created_at: timestamp_text(&xml_tag(&xml, "CreateTime"), request),
        reply_webhook_url: None,
        raw_payload: Some(Value::String(xml)),
    }))
}

fn parse_telegram_event(request: &InboundRequest) -> Result<Option<ChannelEvent>> {
    let body = &request.body;
    let message = if value_at(body, &["message"]).is_object() {
        value_at(body, &["message"])
    } else {
        value_at(body, &["edited_message"])
    };
    let text = string_at(message, &["text"]);
    if text.is_empty() {
        return Ok(None);
    }
    let sender_name = [
        string_at(message, &["from", "first_name"]),
        string_at(message, &["from", "last_name"]),
    ]
    .into_iter()
    .filter(|value| !value.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    Ok(Some(ChannelEvent {
        connector_type: ConnectorType::Telegram,
        channel_id: string_at(message, &["chat", "id"]),
        thread_id: None,
        message_id: first_non_empty(&[
            string_at(message, &["message_id"]),
            generated_id("telegram", request),
        ]),
        sender_id: first_non_empty(&[string_at(message, &["from", "id"]), "telegram-user".into()]),
        sender_name: optional(sender_name),
        text,
        attachments: Vec::new(),
        mentions: Vec::new(),
        created_at: timestamp_value(value_at(message, &["date"]), request),
        reply_webhook_url: None,
        raw_payload: Some(body.clone()),
    }))
}

fn parse_slack_event(request: &InboundRequest) -> Result<Option<ChannelEvent>> {
    let body = &request.body;
    let payload = match value_at(body, &["payload"]) {
        Value::String(value) => parse_json_value(value),
        value if value.is_object() => value.clone(),
        _ => Value::Null,
    };
    let source = if payload.as_object().is_some_and(|value| !value.is_empty()) {
        &payload
    } else {
        body
    };
    let text = first_non_empty(&[
        string_at(source, &["text"]),
        string_at(source, &["event", "text"]),
        string_at(source, &["message", "text"]),
        string_at(source, &["actions", "0", "value"]),
    ]);
    if text.is_empty() {
        return Ok(None);
    }
    let timestamp = first_non_empty(&[
        string_at(source, &["event", "ts"]),
        string_at(source, &["message", "ts"]),
        string_at(source, &["event_time"]),
    ]);
    Ok(Some(ChannelEvent {
        connector_type: ConnectorType::Slack,
        channel_id: first_non_empty(&[
            string_at(source, &["channel_id"]),
            string_at(source, &["channel", "id"]),
            string_at(source, &["event", "channel"]),
            string_at(source, &["message", "channel"]),
            "slack".into(),
        ]),
        thread_id: optional(first_non_empty(&[
            string_at(source, &["thread_ts"]),
            string_at(source, &["event", "thread_ts"]),
            string_at(source, &["message", "thread_ts"]),
        ])),
        message_id: first_non_empty(&[
            string_at(source, &["message_id"]),
            string_at(source, &["event_id"]),
            string_at(source, &["event", "client_msg_id"]),
            string_at(source, &["event", "ts"]),
            string_at(source, &["message", "ts"]),
            string_at(source, &["trigger_id"]),
            generated_id("slack", request),
        ]),
        sender_id: first_non_empty(&[
            string_at(source, &["user_id"]),
            string_at(source, &["user", "id"]),
            string_at(source, &["event", "user"]),
            string_at(source, &["message", "user"]),
            "slack-user".into(),
        ]),
        sender_name: optional(first_non_empty(&[
            string_at(source, &["user_name"]),
            string_at(source, &["user", "name"]),
        ])),
        text,
        attachments: Vec::new(),
        mentions: Vec::new(),
        created_at: timestamp_text(&timestamp, request),
        reply_webhook_url: optional(string_at(source, &["response_url"])),
        raw_payload: Some(source.clone()),
    }))
}

fn parse_generic_event(
    connector: ConnectorType,
    request: &InboundRequest,
) -> Result<Option<ChannelEvent>> {
    let body = &request.body;
    let text = first_non_empty(&[
        string_at(body, &["text"]),
        string_at(body, &["content"]),
        string_at(body, &["message"]),
        string_at(body, &["message", "text"]),
        string_at(body, &["event", "text"]),
        string_at(body, &["event", "message", "text"]),
        string_at(body, &["payload", "text"]),
    ]);
    if text.is_empty() {
        return Ok(None);
    }

    Ok(Some(ChannelEvent {
        connector_type: connector,
        channel_id: first_non_empty(&[
            string_at(body, &["channelId"]),
            string_at(body, &["channel_id"]),
            string_at(body, &["chat_id"]),
            string_at(body, &["conversation_id"]),
            string_at(body, &["room_id"]),
            string_at(body, &["channel", "id"]),
            string_at(body, &["event", "channel"]),
            "default".into(),
        ]),
        thread_id: optional(first_non_empty(&[
            string_at(body, &["threadId"]),
            string_at(body, &["thread_id"]),
            string_at(body, &["topic_id"]),
            string_at(body, &["event", "thread_ts"]),
        ])),
        message_id: first_non_empty(&[
            string_at(body, &["messageId"]),
            string_at(body, &["message_id"]),
            string_at(body, &["id"]),
            string_at(body, &["message", "id"]),
            string_at(body, &["event", "client_msg_id"]),
            string_at(body, &["event", "ts"]),
            generated_id(connector.as_str(), request),
        ]),
        sender_id: first_non_empty(&[
            string_at(body, &["senderId"]),
            string_at(body, &["sender"]),
            string_at(body, &["user_id"]),
            string_at(body, &["sender_id"]),
            string_at(body, &["sender", "id"]),
            string_at(body, &["user", "id"]),
            string_at(body, &["author", "id"]),
            string_at(body, &["event", "user"]),
            "external-user".into(),
        ]),
        sender_name: optional(first_non_empty(&[
            string_at(body, &["senderName"]),
            string_at(body, &["user_name"]),
            string_at(body, &["sender_name"]),
            string_at(body, &["sender", "name"]),
            string_at(body, &["user", "name"]),
            string_at(body, &["author", "username"]),
        ])),
        text,
        attachments: parse_attachments(body),
        mentions: string_array(value_at(body, &["mentions"])),
        created_at: received_at(request),
        reply_webhook_url: optional(string_at(body, &["response_url"])),
        raw_payload: Some(body.clone()),
    }))
}

fn feishu_body(request: &InboundRequest, binding: Option<&ChannelBinding>) -> Result<Value> {
    let encrypted = string_at(&request.body, &["encrypt"]);
    if encrypted.is_empty() {
        return Ok(request.body.clone());
    }
    let binding = binding.ok_or_else(|| anyhow!("encrypted Feishu event requires a binding"))?;
    let key = non_empty(binding.encrypt_key.as_deref())
        .ok_or_else(|| anyhow!("encrypted Feishu event requires an encrypt key"))?;
    decrypt_feishu_payload(key, &encrypted)
}

fn verify_optional_feishu_token(
    body: Option<&Value>,
    binding: &ChannelBinding,
    required: bool,
) -> bool {
    let Some(expected) = non_empty(binding.verification_token.as_deref()) else {
        return true;
    };
    let provided = body
        .map(|value| string_at(value, &["token"]))
        .unwrap_or_default();
    if provided.is_empty() {
        return !required;
    }
    safe_compare(expected.as_bytes(), provided.as_bytes())
}

fn verify_shared_secret(request: &InboundRequest, binding: &ChannelBinding) -> bool {
    let Some(expected) = non_empty(binding.incoming_secret.as_deref()) else {
        return true;
    };
    let provided = first_non_empty(&[
        request.header("x-the-world-im-secret").into(),
        request.header("x-im-secret").into(),
        request.query("secret").into(),
        string_at(&request.body, &["secret"]),
    ]);
    !provided.is_empty() && safe_compare(expected.as_bytes(), provided.as_bytes())
}

fn first_header<'a>(request: &'a InboundRequest, names: &[&str]) -> &'a str {
    names
        .iter()
        .map(|name| request.header(name))
        .find(|value| !value.is_empty())
        .unwrap_or_default()
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> Result<Vec<u8>> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|_| anyhow!("invalid HMAC key"))?;
    mac.update(message);
    Ok(mac.finalize().into_bytes().to_vec())
}

pub(crate) fn sorted_sha1_hex(parts: &[&str]) -> String {
    let mut sorted = parts.to_vec();
    sorted.sort_unstable();
    let mut hasher = Sha1::new();
    for part in sorted {
        hasher.update(part.as_bytes());
    }
    hex(&hasher.finalize())
}

fn safe_compare(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && bool::from(left.ct_eq(right))
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

fn remove_wechat_padding(value: &[u8]) -> Result<&[u8]> {
    let pad = value.last().copied().unwrap_or_default() as usize;
    if pad == 0 || pad > 32 || pad > value.len() {
        bail!("invalid WeChat PKCS#7 padding");
    }
    if !value[value.len() - pad..]
        .iter()
        .all(|byte| *byte as usize == pad)
    {
        bail!("invalid WeChat PKCS#7 padding bytes");
    }
    Ok(&value[..value.len() - pad])
}

fn xml_tag(xml: &str, tag: &str) -> String {
    let Ok(document) = roxmltree::Document::parse(xml) else {
        return String::new();
    };
    document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name().eq_ignore_ascii_case(tag))
        .and_then(|node| node.text())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn parse_json_value(value: &str) -> Value {
    serde_json::from_str::<Value>(value)
        .ok()
        .filter(Value::is_object)
        .unwrap_or(Value::Null)
}

fn value_at<'a>(value: &'a Value, path: &[&str]) -> &'a Value {
    let mut current = value;
    for key in path {
        current = match current {
            Value::Object(object) => object.get(*key).unwrap_or(&Value::Null),
            Value::Array(items) => key
                .parse::<usize>()
                .ok()
                .and_then(|index| items.get(index))
                .unwrap_or(&Value::Null),
            _ => &Value::Null,
        };
    }
    current
}

fn string_at(value: &Value, path: &[&str]) -> String {
    string_value(value_at(value, path))
}

fn string_value(value: &Value) -> String {
    match value {
        Value::String(value) => value.trim().to_string(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        _ => String::new(),
    }
}

fn first_non_empty(values: &[String]) -> String {
    values
        .iter()
        .find(|value| !value.is_empty())
        .cloned()
        .unwrap_or_default()
}

fn first_value<'a>(values: &[&'a Value]) -> &'a Value {
    values
        .iter()
        .copied()
        .find(|value| !value.is_null())
        .unwrap_or(&Value::Null)
}

fn optional(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn received_at(request: &InboundRequest) -> String {
    request
        .received_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn received_millis(request: &InboundRequest) -> i64 {
    request
        .received_at
        .as_deref()
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
        .unwrap_or_else(|| Utc::now().timestamp_millis())
}

fn generated_id(prefix: &str, request: &InboundRequest) -> String {
    format!("{prefix}_{}", received_millis(request))
}

fn timestamp_value(value: &Value, request: &InboundRequest) -> String {
    timestamp_text(&string_value(value), request)
}

fn timestamp_text(value: &str, request: &InboundRequest) -> String {
    let Some(number) = value.parse::<f64>().ok().filter(|value| *value > 0.0) else {
        return received_at(request);
    };
    let milliseconds = if number < 1_000_000_000_000.0 {
        (number * 1000.0).round() as i64
    } else {
        number.round() as i64
    };
    DateTime::<Utc>::from_timestamp_millis(milliseconds)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|| received_at(request))
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(string_value)
                .filter(|value| !value.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn parse_attachments(body: &Value) -> Vec<ChannelEventAttachment> {
    value_at(body, &["attachments"])
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = first_non_empty(&[
                        string_at(item, &["name"]),
                        string_at(item, &["filename"]),
                    ]);
                    if name.is_empty() {
                        return None;
                    }
                    Some(ChannelEventAttachment {
                        name,
                        mime_type: first_non_empty(&[
                            string_at(item, &["mimeType"]),
                            string_at(item, &["mime_type"]),
                            string_at(item, &["content_type"]),
                            "application/octet-stream".into(),
                        ]),
                        local_path: optional(first_non_empty(&[
                            string_at(item, &["localPath"]),
                            string_at(item, &["local_path"]),
                            string_at(item, &["path"]),
                        ])),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}
