use aes::Aes256;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockEncryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use sha2::Sha256;
use std::collections::BTreeMap;
use std::sync::Arc;
use worldbase_im_gateway::{
    build_encrypted_wechat_reply_with, build_feishu_reply_request, build_outbound_plan,
    decrypt_feishu_payload, decrypt_wechat_payload, parse_channel_event, process_inbound,
    verify_connector_request, verify_feishu_signature, verify_slack_signature, ChannelBinding,
    ChannelEvent, ConnectorType, ImGateway, InboundError, InboundOutcome, InboundRequest,
    OnImMessage, OutboundPlan,
};

fn make_binding(connector_type: ConnectorType) -> ChannelBinding {
    ChannelBinding {
        id: "binding-1".into(),
        connector_type,
        auto_reply: true,
        require_approval_for_risky_tools: true,
        ..ChannelBinding::default()
    }
}

fn json_request(body: Value) -> InboundRequest {
    InboundRequest {
        received_at: Some("2030-01-02T03:04:05Z".into()),
        ..InboundRequest::json(body)
    }
}

fn message(outcome: InboundOutcome) -> ChannelEvent {
    match outcome {
        InboundOutcome::Message { event } => *event,
        other => panic!("expected message, got {other:?}"),
    }
}

fn sample_event(connector_type: ConnectorType) -> ChannelEvent {
    ChannelEvent {
        connector_type,
        channel_id: "channel/one".into(),
        thread_id: Some("thread-1".into()),
        message_id: "message/one".into(),
        sender_id: "sender-1".into(),
        sender_name: Some("Alice".into()),
        text: "hello".into(),
        attachments: Vec::new(),
        mentions: Vec::new(),
        created_at: "2030-01-02T03:04:05.000Z".into(),
        reply_webhook_url: None,
        raw_payload: None,
    }
}

#[test]
fn connector_catalog_round_trips_all_node_names() {
    let actual = ConnectorType::ALL
        .into_iter()
        .map(|connector| {
            let name = connector.as_str();
            assert_eq!(name.parse::<ConnectorType>().unwrap(), connector);
            name
        })
        .collect::<Vec<_>>();
    assert_eq!(
        actual,
        ["feishu", "wechat", "wecom", "slack", "discord", "telegram", "custom"]
    );
}

#[test]
fn feishu_v2_event_normalizes_json_content_mentions_and_timestamp() {
    let body = json!({
        "header": { "event_id": "event-1" },
        "event": {
            "sender": {
                "sender_id": { "open_id": "ou-1" },
                "sender_type": "user"
            },
            "message": {
                "chat_id": "oc-1",
                "thread_id": "thread-1",
                "message_id": "om-1",
                "create_time": "1700000000000",
                "content": "{\"text\":\"hello Feishu\"}",
                "mentions": [
                    { "name": "WorldBase" },
                    { "id": { "open_id": "ou-2" } }
                ]
            }
        }
    });
    let event = message(
        process_inbound(
            ConnectorType::Feishu,
            &json_request(body),
            &make_binding(ConnectorType::Feishu),
        )
        .unwrap(),
    );
    assert_eq!(event.channel_id, "oc-1");
    assert_eq!(event.thread_id.as_deref(), Some("thread-1"));
    assert_eq!(event.message_id, "om-1");
    assert_eq!(event.sender_id, "ou-1");
    assert_eq!(event.sender_name.as_deref(), Some("user"));
    assert_eq!(event.text, "hello Feishu");
    assert_eq!(event.mentions, ["WorldBase", "ou-2"]);
    assert_eq!(event.created_at, "2023-11-14T22:13:20.000Z");

    // Preserve compatibility with the old Rust harness payload shape too.
    let object_content = json!({
        "event": {
            "message": { "content": { "text": "object content" } },
            "sender": { "sender_id": { "open_id": "ou-legacy" } }
        }
    });
    let event = parse_channel_event(ConnectorType::Feishu, &json_request(object_content), None)
        .unwrap()
        .unwrap();
    assert_eq!(event.text, "object content");
}

#[test]
fn feishu_url_verification_enforces_verification_token() {
    let mut binding = make_binding(ConnectorType::Feishu);
    binding.verification_token = Some("verify-me".into());
    let accepted = process_inbound(
        ConnectorType::Feishu,
        &json_request(json!({
            "type": "url_verification",
            "token": "verify-me",
            "challenge": "challenge-1"
        })),
        &binding,
    )
    .unwrap();
    assert_eq!(
        accepted,
        InboundOutcome::JsonChallenge {
            body: json!({ "challenge": "challenge-1" })
        }
    );

    let rejected = process_inbound(
        ConnectorType::Feishu,
        &json_request(json!({
            "type": "url_verification",
            "token": "wrong",
            "challenge": "challenge-1"
        })),
        &binding,
    );
    assert_eq!(rejected, Err(InboundError::Unauthorized));
}

#[test]
fn feishu_signature_and_encrypted_payload_match_node_algorithms() {
    let plaintext = json!({
        "event": {
            "sender": { "sender_id": { "open_id": "ou-encrypted" } },
            "message": { "chat_id": "oc-encrypted", "content": "{\"text\":\"secret\"}" }
        }
    });
    let encrypt_key = "feishu-encryption-key";
    let key = Sha256::digest(encrypt_key.as_bytes());
    let cipher = cbc::Encryptor::<Aes256>::new_from_slices(&key, &key[..16]).unwrap();
    let encrypted = BASE64
        .encode(cipher.encrypt_padded_vec_mut::<Pkcs7>(
            serde_json::to_string(&plaintext).unwrap().as_bytes(),
        ));
    assert_eq!(
        decrypt_feishu_payload(encrypt_key, &encrypted).unwrap(),
        plaintext
    );

    let envelope = json!({ "encrypt": encrypted });
    let raw_body = serde_json::to_string(&envelope).unwrap();
    let timestamp = "1700000000";
    let nonce = "nonce-1";
    let signature_base = format!("{timestamp}{nonce}{encrypt_key}{raw_body}");
    let signature = lower_hex(&Sha256::digest(signature_base.as_bytes()));
    let request = InboundRequest {
        body: envelope,
        raw_body,
        received_at: Some("2030-01-02T03:04:05Z".into()),
        headers: BTreeMap::from([
            ("x-lark-request-timestamp".into(), timestamp.into()),
            ("x-lark-request-nonce".into(), nonce.into()),
            ("x-lark-signature".into(), signature),
            ("content-type".into(), "application/json".into()),
        ]),
        ..InboundRequest::default()
    };
    let mut binding = make_binding(ConnectorType::Feishu);
    binding.encrypt_key = Some(encrypt_key.into());
    assert!(verify_feishu_signature(&request, &binding));
    let event = message(process_inbound(ConnectorType::Feishu, &request, &binding).unwrap());
    assert_eq!(event.sender_id, "ou-encrypted");
    assert_eq!(event.text, "secret");

    let mut tampered = request;
    tampered.raw_body.push(' ');
    assert!(!verify_feishu_signature(&tampered, &binding));
}

#[test]
fn wechat_plain_and_wecom_json_events_are_normalized() {
    let token = "wechat-token";
    let timestamp = "1700000000";
    let nonce = "nonce";
    let signature = sorted_sha1(&[token, timestamp, nonce]);
    let xml = "<xml><ToUserName><![CDATA[official]]></ToUserName><FromUserName><![CDATA[user-1]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[hello & world]]></Content><MsgId>42</MsgId></xml>";
    let mut request = InboundRequest {
        raw_body: xml.into(),
        received_at: Some("2030-01-02T03:04:05Z".into()),
        ..InboundRequest::default()
    }
    .with_query("timestamp", timestamp)
    .with_query("nonce", nonce)
    .with_query("signature", signature);
    request
        .headers
        .insert("content-type".into(), "application/xml".into());
    let mut binding = make_binding(ConnectorType::Wechat);
    binding.verification_token = Some(token.into());
    let event = message(process_inbound(ConnectorType::Wechat, &request, &binding).unwrap());
    assert_eq!(event.channel_id, "official");
    assert_eq!(event.sender_id, "user-1");
    assert_eq!(event.message_id, "42");
    assert_eq!(event.text, "hello & world");
    assert_eq!(event.created_at, "2023-11-14T22:13:20.000Z");

    let json_request = json_request(json!({
        "channel_id": "wecom-room",
        "sender_id": "wecom-user",
        "message_id": "wecom-message",
        "text": "JSON callback"
    }));
    let event = message(
        process_inbound(
            ConnectorType::Wecom,
            &json_request,
            &make_binding(ConnectorType::Wecom),
        )
        .unwrap(),
    );
    assert_eq!(event.channel_id, "wecom-room");
    assert_eq!(event.text, "JSON callback");
}

#[test]
fn encrypted_wechat_reply_round_trips_and_authenticates() {
    let key = BASE64.encode([7u8; 32]);
    let encoding_aes_key = key.trim_end_matches('=').to_string();
    let mut binding = make_binding(ConnectorType::Wechat);
    binding.verification_token = Some("token-1".into());
    binding.encrypt_key = Some(encoding_aes_key.clone());
    binding.app_id = Some("wx-app".into());
    let event = sample_event(ConnectorType::Wechat);
    let encrypted_reply = build_encrypted_wechat_reply_with(
        &binding,
        &event,
        "reply <ok>",
        1_700_000_000,
        "nonce-1",
        [9u8; 16],
    )
    .unwrap();
    let encrypted = xml_text(&encrypted_reply, "Encrypt");
    let signature = xml_text(&encrypted_reply, "MsgSignature");
    let decrypted = decrypt_wechat_payload(&encoding_aes_key, &encrypted).unwrap();
    assert!(decrypted.contains("<Content>reply &lt;ok&gt;</Content>"));

    let incoming = InboundRequest {
        raw_body: format!("<xml><Encrypt><![CDATA[{encrypted}]]></Encrypt></xml>"),
        received_at: Some("2030-01-02T03:04:05Z".into()),
        ..InboundRequest::default()
    }
    .with_query("timestamp", "1700000000")
    .with_query("nonce", "nonce-1")
    .with_query("msg_signature", signature);
    assert!(verify_connector_request(
        ConnectorType::Wechat,
        &incoming,
        &binding
    ));
    let event = message(process_inbound(ConnectorType::Wechat, &incoming, &binding).unwrap());
    assert_eq!(event.text, "reply <ok>");
}

#[test]
fn slack_signature_payload_and_interaction_shapes_are_supported() {
    let secret = "slack-signing-secret";
    let timestamp = "1700000000";
    let raw_body =
        json!({ "event": { "user": "U1", "channel": "C1", "text": "hi", "ts": "1700000000.25" } })
            .to_string();
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(format!("v0:{timestamp}:{raw_body}").as_bytes());
    let signature = format!("v0={}", lower_hex(&mac.finalize().into_bytes()));
    let request = InboundRequest {
        body: serde_json::from_str(&raw_body).unwrap(),
        raw_body,
        headers: BTreeMap::from([
            ("x-slack-request-timestamp".into(), timestamp.into()),
            ("x-slack-signature".into(), signature),
        ]),
        received_at: Some("2030-01-02T03:04:05Z".into()),
        ..InboundRequest::default()
    };
    let mut binding = make_binding(ConnectorType::Slack);
    binding.incoming_secret = Some(secret.into());
    assert!(verify_slack_signature(&request, &binding));
    let event = message(process_inbound(ConnectorType::Slack, &request, &binding).unwrap());
    assert_eq!(event.sender_id, "U1");
    assert_eq!(event.channel_id, "C1");
    assert_eq!(event.created_at, "2023-11-14T22:13:20.250Z");

    let interaction = json_request(json!({
        "payload": json!({
            "channel": { "id": "C2" },
            "user": { "id": "U2", "name": "Alice" },
            "actions": [{ "value": "approve" }],
            "response_url": "https://hooks.slack.test/reply",
            "trigger_id": "trigger-1"
        }).to_string()
    }));
    let event = parse_channel_event(ConnectorType::Slack, &interaction, None)
        .unwrap()
        .unwrap();
    assert_eq!(event.text, "approve");
    assert_eq!(
        event.reply_webhook_url.as_deref(),
        Some("https://hooks.slack.test/reply")
    );
}

#[test]
fn telegram_discord_custom_auth_and_bot_filter_are_enforced() {
    let telegram = json_request(json!({
        "edited_message": {
            "message_id": 7,
            "date": 1700000000,
            "chat": { "id": -1001 },
            "from": { "id": 9, "first_name": "Ada", "last_name": "Lovelace" },
            "text": "edited"
        }
    }))
    .with_header("x-telegram-bot-api-secret-token", "telegram-secret");
    let mut telegram_binding = make_binding(ConnectorType::Telegram);
    telegram_binding.incoming_secret = Some("telegram-secret".into());
    let event =
        message(process_inbound(ConnectorType::Telegram, &telegram, &telegram_binding).unwrap());
    assert_eq!(event.channel_id, "-1001");
    assert_eq!(event.sender_name.as_deref(), Some("Ada Lovelace"));

    let discord = json_request(json!({
        "id": "discord-message",
        "channel_id": "discord-room",
        "author": { "id": "discord-user", "username": "Grace" },
        "content": "hello Discord"
    }))
    .with_header("x-im-secret", "shared");
    let mut discord_binding = make_binding(ConnectorType::Discord);
    discord_binding.incoming_secret = Some("shared".into());
    let event =
        message(process_inbound(ConnectorType::Discord, &discord, &discord_binding).unwrap());
    assert_eq!(event.sender_id, "discord-user");
    assert_eq!(event.sender_name.as_deref(), Some("Grace"));

    let mut bot_binding = make_binding(ConnectorType::Custom);
    bot_binding.bot_user_id = Some("bot-1".into());
    let bot = json_request(json!({ "senderId": "bot-1", "text": "loop" }));
    assert_eq!(
        process_inbound(ConnectorType::Custom, &bot, &bot_binding).unwrap(),
        InboundOutcome::Ignored
    );

    let mut protected = make_binding(ConnectorType::Custom);
    protected.incoming_secret = Some("shared".into());
    assert_eq!(
        process_inbound(
            ConnectorType::Custom,
            &json_request(json!({ "sender": "user", "text": "no secret" })),
            &protected,
        ),
        Err(InboundError::Unauthorized)
    );
}

#[test]
fn outbound_plans_cover_every_connector_payload() {
    let cases = [
        (ConnectorType::Slack, json!({ "text": "reply" })),
        (ConnectorType::Discord, json!({ "content": "reply" })),
        (
            ConnectorType::Wecom,
            json!({ "msgtype": "text", "text": { "content": "reply" } }),
        ),
    ];
    for (connector, expected) in cases {
        let mut binding = make_binding(connector);
        binding.outgoing_webhook_url = Some("https://example.test/hook".into());
        let plan =
            build_outbound_plan(connector, &binding, &sample_event(connector), "reply").unwrap();
        let OutboundPlan::Http { request } = plan else {
            panic!("expected direct webhook plan");
        };
        assert_eq!(request.url, "https://example.test/hook");
        assert_eq!(request.body, expected);
    }

    let mut telegram = make_binding(ConnectorType::Telegram);
    telegram.app_secret = Some("bot-token".into());
    let plan = build_outbound_plan(
        ConnectorType::Telegram,
        &telegram,
        &sample_event(ConnectorType::Telegram),
        "reply",
    )
    .unwrap();
    let OutboundPlan::Http { request } = plan else {
        panic!("expected Telegram request");
    };
    assert_eq!(
        request.url,
        "https://api.telegram.org/botbot-token/sendMessage"
    );
    assert_eq!(
        request.body,
        json!({ "chat_id": "channel/one", "text": "reply" })
    );

    let mut feishu = make_binding(ConnectorType::Feishu);
    feishu.app_id = Some("app-id".into());
    feishu.app_secret = Some("app-secret".into());
    let plan = build_outbound_plan(
        ConnectorType::Feishu,
        &feishu,
        &sample_event(ConnectorType::Feishu),
        "reply",
    )
    .unwrap();
    let OutboundPlan::FeishuAppReply {
        token_request,
        message_id,
        ..
    } = plan
    else {
        panic!("expected two-stage Feishu plan");
    };
    assert_eq!(
        token_request.body,
        json!({ "app_id": "app-id", "app_secret": "app-secret" })
    );
    assert_eq!(message_id, "message/one");
    let reply_request = build_feishu_reply_request("tenant-token", &message_id, "reply");
    assert!(reply_request.url.ends_with("message%2Fone/reply"));
    assert_eq!(
        reply_request.headers["authorization"],
        "Bearer tenant-token"
    );

    let wechat = make_binding(ConnectorType::Wechat);
    assert!(matches!(
        build_outbound_plan(
            ConnectorType::Wechat,
            &wechat,
            &sample_event(ConnectorType::Wechat),
            "reply"
        )
        .unwrap(),
        OutboundPlan::Inline { .. }
    ));
    assert_eq!(
        build_outbound_plan(
            ConnectorType::Custom,
            &make_binding(ConnectorType::Custom),
            &sample_event(ConnectorType::Custom),
            "reply"
        )
        .unwrap(),
        OutboundPlan::None
    );
}

#[tokio::test]
async fn bound_gateway_enforces_shared_secret_before_callback() {
    let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
    let callback_calls = calls.clone();
    let on_message: OnImMessage = Arc::new(move |_channel, sender, text| {
        callback_calls
            .lock()
            .unwrap()
            .push((sender.to_string(), text.to_string()));
        Box::pin(async { "accepted".into() })
    });
    let mut binding = make_binding(ConnectorType::Custom);
    binding.incoming_secret = Some("shared".into());
    let gateway = ImGateway::start_with_binding(binding, Some(0), on_message)
        .await
        .unwrap();
    let client = reqwest::Client::new();
    let url = format!("http://{}/webhook/custom", gateway.local_addr());

    let rejected = client
        .post(&url)
        .json(&json!({ "sender": "alice", "text": "first" }))
        .send()
        .await
        .unwrap();
    assert_eq!(rejected.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert!(calls.lock().unwrap().is_empty());

    let accepted = client
        .post(&url)
        .header("x-the-world-im-secret", "shared")
        .json(&json!({ "sender": "alice", "text": "second" }))
        .send()
        .await
        .unwrap();
    assert!(accepted.status().is_success());
    assert_eq!(
        calls.lock().unwrap().as_slice(),
        &[("alice".into(), "second".into())]
    );
    gateway.stop();
}

fn sorted_sha1(parts: &[&str]) -> String {
    let mut parts = parts.to_vec();
    parts.sort_unstable();
    let mut hasher = Sha1::new();
    for part in parts {
        hasher.update(part.as_bytes());
    }
    lower_hex(&hasher.finalize())
}

fn lower_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn xml_text(xml: &str, tag: &str) -> String {
    let document = roxmltree::Document::parse(xml).unwrap();
    document
        .descendants()
        .find(|node| node.is_element() && node.tag_name().name() == tag)
        .and_then(|node| node.text())
        .unwrap()
        .to_string()
}
