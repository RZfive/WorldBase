//! Opt-in end-to-end coding run against a real model provider.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use worldbase_core::dispatcher::ConnectionContext;
use worldbase_core::Hub;
use worldbase_memory::Store;
use worldbase_protocol::event::EventKind;
use worldbase_protocol::method;
use worldbase_protocol::rpc::ErrorObject;
use worldbase_protocol::types::{Capabilities, ModelInfo, ProviderEntry};
use worldbase_providers::create_provider_from_entry;

const DEFAULT_TIMEOUT_SECS: u64 = 300;
const DEFAULT_OPENAI_MODEL: &str = "gpt-4.1-mini";
const DEFAULT_ANTHROPIC_MODEL: &str = "claude-sonnet-4-5";
const PROJECT_ID: &str = "project";
const ORIGINAL_MAIN_JS: &str =
    "function add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n";

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[tokio::test]
#[ignore = "requires WORLDBASE_E2E_API_KEY and live network access"]
async fn real_model_coding_e2e() {
    let Some(api_key) = env_value("WORLDBASE_E2E_API_KEY") else {
        eprintln!("real-model E2E skipped: WORLDBASE_E2E_API_KEY is not set");
        return;
    };

    let protocol = env_value("WORLDBASE_E2E_PROTOCOL")
        .unwrap_or_else(|| "openai-chat".to_string())
        .to_ascii_lowercase();
    assert!(
        matches!(
            protocol.as_str(),
            "openai-chat" | "openai-responses" | "anthropic"
        ),
        "unsupported WORLDBASE_E2E_PROTOCOL `{protocol}`; expected openai-chat, openai-responses, or anthropic"
    );
    let model = env_value("WORLDBASE_E2E_MODEL").unwrap_or_else(|| {
        if protocol == "anthropic" {
            DEFAULT_ANTHROPIC_MODEL.to_string()
        } else {
            DEFAULT_OPENAI_MODEL.to_string()
        }
    });
    let base_url = env_value("WORLDBASE_E2E_BASE_URL").unwrap_or_default();
    let timeout_secs = env_value("WORLDBASE_E2E_TIMEOUT_SECS")
        .map(|value| {
            value
                .parse::<u64>()
                .expect("WORLDBASE_E2E_TIMEOUT_SECS must be a positive integer")
        })
        .unwrap_or(DEFAULT_TIMEOUT_SECS);
    assert!(
        timeout_secs > 0,
        "WORLDBASE_E2E_TIMEOUT_SECS must be positive"
    );
    let max_tokens = env_value("WORLDBASE_E2E_MAX_TOKENS").map(|value| {
        value
            .parse::<u32>()
            .expect("WORLDBASE_E2E_MAX_TOKENS must be an integer")
    });

    let base = std::env::temp_dir().join(format!("worldbase-real-e2e-{}", uuid::Uuid::new_v4()));
    let workspace = base.join(PROJECT_ID);
    let source_path = workspace.join("src/main.js");
    std::fs::create_dir_all(source_path.parent().unwrap()).unwrap();
    std::fs::write(
        workspace.join("package.json"),
        serde_json::json!({
            "name": "worldbase-real-e2e",
            "private": true,
            "scripts": {
                "typecheck": "node --check src/main.js"
            }
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(&source_path, ORIGINAL_MAIN_JS).unwrap();

    let home = base.join("home");
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("WORLDBASE_HOME", &home);

    let store = Arc::new(Store::open(&base.join("app.sqlite")).unwrap());
    let hub = Hub::new(base.clone(), store).unwrap();

    let entry = ProviderEntry {
        id: "worldbase-real-e2e".into(),
        name: "WorldBase real E2E".into(),
        base_url: base_url.clone(),
        api_key,
        api_protocol: protocol.clone(),
        models: vec![ModelInfo {
            id: model.clone(),
            context_window_k: 128,
            input_price: 0.0,
            output_price: 0.0,
            cache_read_price: 0.0,
            image_generation: false,
            image_editing: false,
        }],
        active_model: model.clone(),
        temperature: None,
        enable_thinking: false,
        image_generation: false,
    };
    hub.set_custom_provider(create_provider_from_entry(&entry).expect("create provider"));

    let ctx = ConnectionContext::new(Capabilities::desktop());
    let conversation = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({ "title": "Real model coding E2E" }),
    )
    .await
    .expect("create conversation");
    let conversation_id = conversation["id"].as_str().unwrap().to_string();

    let prompt = format!(
        "You are editing a tiny JavaScript project in coding mode.\n\
         - The selected folder workspace is: {}\n\
         - The managed project id is `{}`.\n\
         - Read `src/main.js` with `read_workspace_file`.\n\
         - Make the smallest change so `add(a, b)` returns `a + b` instead of subtracting.\n\
         - Write the updated file with `write_workspace_file` or `edit_workspace_file`.\n\
         - Run the native `coding_verify` tool with project_id `{}` and confirm it passes.\n\
         - Finally call `finish_task` with status \"completed\" and a short summary that mentions the verification.",
        workspace.display(),
        PROJECT_ID,
        PROJECT_ID
    );

    let mut events = hub.event_tx.subscribe();
    let started = Instant::now();
    let sent = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({
            "conversationId": conversation_id,
            "text": prompt,
            "codingMode": true,
            "workspaceRoot": workspace.to_string_lossy(),
        }),
    )
    .await
    .expect("chat.send");
    let stream_id = sent["streamId"].as_str().unwrap().to_string();

    let mut event_counts: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut tool_names: BTreeSet<String> = BTreeSet::new();
    let mut verify_attempts: Vec<(bool, String)> = Vec::new();
    let mut error_message: Option<String> = None;
    let mut done_reason: Option<String> = None;

    let finished = tokio::time::timeout(Duration::from_secs(timeout_secs), async {
        loop {
            let frame = match events.recv().await {
                Ok(frame) => frame,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(error) => panic!("event recv failed: {error}"),
            };
            if frame.stream_id != stream_id {
                continue;
            }
            *event_counts.entry(frame.kind.type_name()).or_default() += 1;
            match frame.kind {
                EventKind::PermissionRequest { request_id, .. } => {
                    let response = dispatch(
                        &hub,
                        &ctx,
                        method::CHAT_RESPOND,
                        serde_json::json!({
                            "requestId": request_id,
                            "allow": true
                        }),
                    )
                    .await
                    .expect("chat.respond");
                    assert_eq!(
                        response["delivered"], true,
                        "permission response was not delivered"
                    );
                }
                EventKind::ToolCall { name, .. } => {
                    tool_names.insert(name);
                }
                EventKind::ToolResult {
                    name,
                    content,
                    is_error,
                    ..
                } if name == "coding_verify" => {
                    let passed = serde_json::from_str::<serde_json::Value>(&content)
                        .ok()
                        .and_then(|value| value["passed"].as_bool())
                        .unwrap_or(false);
                    verify_attempts.push((!is_error && passed, content));
                }
                EventKind::Done { stop_reason } => {
                    done_reason = Some(stop_reason);
                    break;
                }
                EventKind::Error { message } => {
                    error_message = Some(message);
                    break;
                }
                _ => {}
            }
        }
    })
    .await;
    let elapsed = started.elapsed();

    if finished.is_err() {
        let _ = dispatch(
            &hub,
            &ctx,
            method::CHAT_ABORT,
            serde_json::json!({ "streamId": stream_id }),
        )
        .await;
    }

    let final_content = std::fs::read_to_string(&source_path).unwrap_or_default();
    let normalized: String = final_content
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();

    println!("--- real-model coding E2E transcript ---");
    println!("protocol: {protocol}");
    println!("model: {model}");
    println!(
        "base_url: {}",
        if base_url.is_empty() {
            "<provider default>"
        } else {
            base_url.as_str()
        }
    );
    println!(
        "max_tokens_env: {}",
        max_tokens
            .map(|value| value.to_string())
            .unwrap_or_else(|| "<unset>".to_string())
    );
    println!("duration: {:.2}s", elapsed.as_secs_f64());
    println!("event_counts: {event_counts:?}");
    println!("tool_names: {:?}", tool_names.iter().collect::<Vec<_>>());
    println!(
        "coding_verify_results: {:?}",
        verify_attempts
            .iter()
            .map(|(passed, _)| *passed)
            .collect::<Vec<_>>()
    );
    println!("done_reason: {done_reason:?}");
    println!("error: {error_message:?}");
    println!("final src/main.js:\n{final_content}");

    assert!(
        finished.is_ok(),
        "real-model E2E timed out after {timeout_secs}s; events: {event_counts:?}"
    );
    assert!(
        error_message.is_none(),
        "real-model E2E failed: {}",
        error_message.unwrap_or_default()
    );
    assert!(
        done_reason.is_some(),
        "run ended without a Done event; events: {event_counts:?}"
    );
    assert!(
        verify_attempts.iter().any(|(passed, _)| *passed),
        "coding_verify never succeeded: {:?}",
        verify_attempts
            .iter()
            .map(|(_, content)| content)
            .collect::<Vec<_>>()
    );
    assert_ne!(
        final_content, ORIGINAL_MAIN_JS,
        "the model did not modify src/main.js"
    );
    assert!(
        normalized.contains("returna+b") || normalized.contains("returnb+a"),
        "src/main.js does not return a + b:\n{final_content}"
    );

    drop(hub);
    let _ = std::fs::remove_dir_all(&base);
}

async fn dispatch(
    hub: &Arc<Hub>,
    ctx: &ConnectionContext,
    method_name: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, ErrorObject> {
    worldbase_core::dispatcher::dispatch(hub, ctx, method_name, params).await
}
