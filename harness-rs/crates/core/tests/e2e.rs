//! 端到端集成测试：mock provider 驱动完整 agent 循环（含工具调用、能力协商、
//! 持久化、文档、记忆、定时任务）。

use futures::StreamExt;
use std::sync::Arc;
use worldbase_core::dispatcher::ConnectionContext;
use worldbase_core::Hub;
use worldbase_protocol::event::EventKind;
use worldbase_protocol::method;
use worldbase_protocol::rpc::ErrorObject;
use worldbase_protocol::types::Capabilities;
use worldbase_providers::{MockProvider, MockTurn};

async fn test_hub(mock_script: Vec<MockTurn>) -> Arc<Hub> {
    let dir = std::env::temp_dir().join(format!("ws-e2e-{}", uuid::Uuid::new_v4()));
    let store = Arc::new(worldbase_memory::Store::open(&dir.join("app.sqlite")).unwrap());
    // 预置一个可读文件
    std::fs::write(dir.join("notes.txt"), "部署密钥是 WB-123").unwrap();
    let hub = Hub::new(dir, store).unwrap();
    if !mock_script.is_empty() {
        hub.set_custom_provider(Arc::new(MockProvider::new("mock-test", mock_script)));
    }
    hub
}

async fn dispatch(
    hub: &Arc<Hub>,
    ctx: &ConnectionContext,
    method_name: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, ErrorObject> {
    worldbase_core::dispatcher::dispatch(hub, ctx, method_name, params).await
}

#[tokio::test]
async fn chat_flow_with_tool_call_end_to_end() {
    let script = vec![
        // 第一轮：调用 read_file
        MockTurn {
            text: "我来查看笔记文件。".into(),
            tool_calls: vec![("call-1".into(), "read_file".into(), serde_json::json!({"path": "notes.txt"}))],
            stream_in_chunks: true,
        },
        // 第二轮：总结
        MockTurn {
            text: "部署密钥是 WB-123，已确认。".into(),
            tool_calls: vec![],
            stream_in_chunks: true,
        },
    ];
    let hub = test_hub(script).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());

    let mut events = hub.event_tx.subscribe();

    let conv = dispatch(&hub, &ctx, method::CONVERSATION_CREATE, serde_json::json!({"title": "E2E"})).await.unwrap();
    let conv_id = conv["id"].as_str().unwrap().to_string();

    let result = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({ "conversationId": conv_id, "text": "看一下 notes.txt" }),
    )
    .await
    .unwrap();
    let stream_id = result["streamId"].as_str().unwrap().to_string();

    // 收集事件直到 Done
    let mut kinds = Vec::new();
    let mut text = String::new();
    loop {
        let frame = match events.recv().await {
            Ok(f) => f,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(e) => panic!("event recv: {e}"),
        };
        if frame.stream_id != stream_id {
            continue;
        }
        let done = matches!(frame.kind, EventKind::Done { .. } | EventKind::Error { .. });
        match &frame.kind {
            EventKind::Delta { text: t } => text.push_str(t),
            EventKind::ToolCall { name, .. } => kinds.push(format!("tool:{name}")),
            EventKind::ToolResult { is_error, .. } => kinds.push(format!("tool_result_err:{is_error}")),
            _ => {}
        }
        kinds.push(frame.kind.type_name().to_string());
        if done {
            break;
        }
    }

    // 断言：UserMessage → Delta* → ToolCall(read_file) → ToolResult(ok) → Delta* → Done（含 Start）
    assert!(kinds.contains(&"start".to_string()));
    assert!(kinds.contains(&"user_message".to_string()));
    assert!(kinds.contains(&"tool:read_file".to_string()));
    assert!(kinds.contains(&"tool_result_err:false".to_string()));
    assert!(kinds.contains(&"done".to_string()));
    assert!(text.contains("我来查看"), "deltas should stream: {text}");
    assert!(text.contains("部署密钥是 WB-123"), "second turn should include file content via mock: {text}");

    // 会话消息已落库
    let messages = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_MESSAGES,
        serde_json::json!({"id": conv_id}),
    )
    .await
    .unwrap();
    let msgs = messages["messages"].as_array().unwrap();
    assert!(msgs.len() >= 4, "expected persisted messages, got {}", msgs.len());
    assert!(msgs.iter().any(|m| m["toolCalls"].as_array().map(|a| !a.is_empty()).unwrap_or(false)));
}

#[tokio::test]
async fn mock_echo_reply_without_script() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let mut events = hub.event_tx.subscribe();

    let conv = dispatch(&hub, &ctx, method::CONVERSATION_CREATE, serde_json::json!({})).await.unwrap();
    let send = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({ "conversationId": conv["id"], "text": "你好 harness" }),
    )
    .await
    .unwrap();
    let stream_id = send["streamId"].as_str().unwrap().to_string();

    let mut text = String::new();
    loop {
        let frame = events.recv().await.unwrap();
        if frame.stream_id != stream_id {
            continue;
        }
        match &frame.kind {
            EventKind::Delta { text: t } => text.push_str(t),
            EventKind::Done { .. } | EventKind::Error { .. } => break,
            _ => {}
        }
    }
    assert!(text.contains("你好 harness"), "echo mock should reply: {text}");
}

#[tokio::test]
async fn tool_list_respects_capability_filter() {
    let hub = test_hub(vec![]).await;
    let desktop = ConnectionContext::new(Capabilities::desktop());
    let mobile = ConnectionContext::new(Capabilities::mobile("mobile-ios"));

    let all = dispatch(&hub, &desktop, method::TOOL_LIST, serde_json::json!({})).await.unwrap();
    let names: Vec<&str> = all["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"execute_command"));

    let filtered = dispatch(&hub, &mobile, method::TOOL_LIST, serde_json::json!({})).await.unwrap();
    let names: Vec<&str> = filtered["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(!names.contains(&"execute_command"), "mobile must not see desktop tools");
    assert!(names.contains(&"read_file"));
    assert!(!names.contains(&"create_project"), "mobile must not see create_project");
}

#[tokio::test]
async fn desktop_methods_hidden_on_mobile() {
    let hub = test_hub(vec![]).await;
    let mobile = ConnectionContext::new(Capabilities::mobile("mobile-ios"));
    let err = dispatch(&hub, &mobile, method::EXEC_RUN, serde_json::json!({"program": "ls"})).await;
    assert!(err.is_err(), "exec.run must be unavailable on mobile");
}

#[tokio::test]
async fn memory_settings_and_skills_via_dispatcher() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());

    dispatch(
        &hub,
        &ctx,
        method::MEMORY_ADD,
        serde_json::json!({"content": "用户偏好深色主题", "tags": ["ui"]}),
    )
    .await
    .unwrap();
    let hits = dispatch(&hub, &ctx, method::MEMORY_SEARCH, serde_json::json!({"query": "深色"})).await.unwrap();
    assert_eq!(hits["hits"].as_array().unwrap().len(), 1);

    dispatch(
        &hub,
        &ctx,
        method::SETTINGS_SET,
        serde_json::json!({"key": "provider.model", "value": "mock-2"}),
    )
    .await
    .unwrap();
    let got = dispatch(&hub, &ctx, method::SETTINGS_GET, serde_json::json!({"key": "provider.model"})).await.unwrap();
    assert_eq!(got["value"], "mock-2");

    let skills = dispatch(&hub, &ctx, method::SKILL_LIST, serde_json::json!({})).await.unwrap();
    assert!(skills["skills"].is_array());

    let sched = dispatch(
        &hub,
        &ctx,
        method::SCHEDULE_CREATE,
        serde_json::json!({"name": "早报", "cron": "0 9 * * 1-5", "task": "汇总"}),
    )
    .await
    .unwrap();
    assert!(sched["entry"]["id"].as_str().is_some());

    let list = dispatch(&hub, &ctx, method::SCHEDULE_LIST, serde_json::json!({})).await.unwrap();
    assert_eq!(list["schedules"].as_array().unwrap().len(), 1);
    assert!(list["schedules"][0]["nextRunAt"].is_string());
}

#[tokio::test]
async fn doc_roundtrip_via_dispatcher() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());

    dispatch(
        &hub,
        &ctx,
        method::DOC_WRITE,
        serde_json::json!({
            "path": "report.docx",
            "kind": "docx",
            "blocks": [
                {"type": "heading", "text": "周报", "level": 1},
                {"type": "paragraph", "text": "Rust harness 端到端跑通。"}
            ]
        }),
    )
    .await
    .unwrap();

    let parsed = dispatch(&hub, &ctx, method::DOC_PARSE, serde_json::json!({"path": "report.docx"})).await.unwrap();
    assert_eq!(parsed["kind"], "docx");
    assert!(parsed["text"].as_str().unwrap().contains("Rust harness"));
}

#[tokio::test]
async fn initialize_handshake_reports_version_and_tools() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::mobile("mobile-ios"));
    let result = dispatch(
        &hub,
        &ctx,
        method::INITIALIZE,
        serde_json::json!({
            "protocolVersion": "1.0",
            "capabilities": {
                "platform": "mobile-ios",
                "features": [],
                "excludes": ["subprocess", "port_binding"]
            }
        }),
    )
    .await
    .unwrap();
    assert_eq!(result["protocolVersion"], "1.0");
    assert!(result["serverVersion"].is_string());
    let tools = result["availableTools"].as_array().unwrap();
    assert!(!tools.is_empty());
    assert!(tools.iter().all(|t| t["domain"] != "desktop"));
}
