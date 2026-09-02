//! 端到端集成测试：mock provider 驱动完整 agent 循环（含工具调用、能力协商、
//! 持久化、文档、记忆、定时任务）。

use std::sync::Arc;
use worldbase_core::dispatcher::ConnectionContext;
use worldbase_core::Hub;
use worldbase_protocol::event::EventKind;
use worldbase_protocol::method;
use worldbase_protocol::rpc::ErrorObject;
use worldbase_protocol::types::{Capabilities, ChatContentPart, ChatMessage, ImageUrl, Role};
use worldbase_providers::{ContentBlock, MockProvider, MockTurn};

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

#[tokio::test]
async fn mcp_control_plane_returns_electron_compatible_rust_snapshot() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());

    dispatch(
        &hub,
        &ctx,
        method::MCP_RELOAD,
        serde_json::json!({
            "servers": [{
                "name": "settings-mcp",
                "displayName": "Settings MCP",
                "enabled": false,
                "transport": "stdio",
                "target": "not-started",
                "args": [],
                "env": {},
                "headers": {}
            }]
        }),
    )
    .await
    .unwrap();

    let state = dispatch(&hub, &ctx, method::MCP_STATUS, serde_json::json!({}))
        .await
        .unwrap();
    let server = &state["servers"][0];
    assert_eq!(server["id"], "settings-mcp");
    assert_eq!(server["name"], "Settings MCP");
    assert_eq!(server["status"], "disconnected");
    assert_eq!(server["capabilities"]["tools"], false);
    assert!(server["tools"].is_array());
    assert!(server["resources"].is_array());
    assert!(server["prompts"].is_array());

    // Disabled servers are still returned by refresh/disconnect. This lets
    // Electron Settings operate entirely through Rust after switching modes.
    let refreshed = dispatch(
        &hub,
        &ctx,
        method::MCP_REFRESH,
        serde_json::json!({ "serverId": "settings-mcp" }),
    )
    .await
    .unwrap();
    assert_eq!(refreshed["id"], "settings-mcp");
    assert_eq!(refreshed["status"], "disconnected");

    let disconnected = dispatch(
        &hub,
        &ctx,
        method::MCP_DISCONNECT,
        serde_json::json!({ "serverId": "settings-mcp" }),
    )
    .await
    .unwrap();
    assert_eq!(disconnected["id"], "settings-mcp");
    assert_eq!(disconnected["status"], "disconnected");
}

#[tokio::test]
async fn agent_group_catalog_crud_matches_electron_store_shape() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());

    let saved = dispatch(
        &hub,
        &ctx,
        method::AGENT_GROUP_SAVE,
        serde_json::json!({
            "group": {
                "name": "  Rust Review Team  ",
                "description": "  durable catalog  ",
                "coordinatorAgentId": " coordinator ",
                "memberAgentIds": [" coordinator ", "worker", "worker", ""],
                "maxRounds": 99,
                "maxParallelWorkers": 0,
                "sharedMemoryScopes": ["group", "invalid", "group", "project"],
                "visibility": "expandable_internal_transcript"
            },
            "fallbackName": "Untitled group"
        }),
    )
    .await
    .unwrap();
    let group = &saved["group"];
    let group_id = group["id"].as_str().unwrap();
    assert!(group_id.starts_with("group_rust_review_team_"));
    assert_eq!(group["name"], "Rust Review Team");
    assert_eq!(group["description"], "durable catalog");
    assert_eq!(group["coordinatorAgentId"], "coordinator");
    assert_eq!(
        group["memberAgentIds"],
        serde_json::json!(["coordinator", "worker"])
    );
    assert_eq!(group["maxRounds"], 5);
    assert_eq!(group["maxParallelWorkers"], 2);
    assert_eq!(
        group["sharedMemoryScopes"],
        serde_json::json!(["group", "project"])
    );
    assert_eq!(group["visibility"], "expandable_internal_transcript");

    let fetched = dispatch(
        &hub,
        &ctx,
        method::AGENT_GROUP_GET,
        serde_json::json!({ "id": group_id }),
    )
    .await
    .unwrap();
    assert_eq!(fetched["group"]["id"], group_id);

    let listed = dispatch(&hub, &ctx, method::AGENT_GROUP_LIST, serde_json::json!({}))
        .await
        .unwrap();
    assert_eq!(listed["groups"].as_array().unwrap().len(), 1);

    let updated = dispatch(
        &hub,
        &ctx,
        method::AGENT_GROUP_SAVE,
        serde_json::json!({
            "group": { "id": group_id, "name": "Updated team", "maxRounds": 1 }
        }),
    )
    .await
    .unwrap();
    assert_eq!(updated["group"]["id"], group_id);
    assert_eq!(updated["group"]["name"], "Updated team");
    assert_eq!(
        updated["group"]["memberAgentIds"],
        serde_json::json!(["coordinator", "worker"])
    );

    let deleted = dispatch(
        &hub,
        &ctx,
        method::AGENT_GROUP_DELETE,
        serde_json::json!({ "id": group_id }),
    )
    .await
    .unwrap();
    assert_eq!(deleted["deleted"], true);
    let missing = dispatch(
        &hub,
        &ctx,
        method::AGENT_GROUP_GET,
        serde_json::json!({ "id": group_id }),
    )
    .await
    .unwrap();
    assert!(missing["group"].is_null());
}

#[tokio::test]
async fn agent_catalog_crud_preserves_workspace_policy_fields() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let saved = dispatch(
        &hub,
        &ctx,
        method::AGENT_SAVE,
        serde_json::json!({
            "agent": {
                "name": "  Rust Agent  ",
                "description": "  policy-aware  ",
                "systemPrompt": "Use Rust tools.",
                "reasoningStrength": "high",
                "skillIds": ["skill-a", "skill-a", ""],
                "allowedTools": ["read_file", "read_file"],
                "deniedTools": ["delete_file"],
                "memoryScopes": ["user", "invalid", "group"],
                "memoryWritePolicy": {
                    "allowUserTraits": false,
                    "allowAgentSkills": true,
                    "allowSteps": false,
                    "allowKnowledge": true
                },
                "autoReplyPolicy": { "enabled": true, "requireMention": false }
            },
            "fallbackName": "Untitled agent"
        }),
    )
    .await
    .unwrap();
    let agent = &saved["agent"];
    let id = agent["id"].as_str().unwrap();
    assert!(id.starts_with("agent_rust_agent_"));
    assert_eq!(agent["name"], "Rust Agent");
    assert_eq!(agent["description"], "policy-aware");
    assert_eq!(agent["reasoningStrength"], "high");
    assert_eq!(agent["skillIds"], serde_json::json!(["skill-a"]));
    assert_eq!(agent["allowedTools"], serde_json::json!(["read_file"]));
    assert_eq!(agent["memoryScopes"], serde_json::json!(["user", "group"]));
    assert_eq!(agent["memoryWritePolicy"]["allowUserTraits"], false);
    assert_eq!(agent["autoReplyPolicy"]["requireMention"], false);

    let updated = dispatch(
        &hub,
        &ctx,
        method::AGENT_SAVE,
        serde_json::json!({ "agent": { "id": id, "name": "Updated Agent" } }),
    )
    .await
    .unwrap();
    assert_eq!(updated["agent"]["id"], id);
    assert_eq!(updated["agent"]["systemPrompt"], "Use Rust tools.");
    assert_eq!(
        updated["agent"]["memoryWritePolicy"]["allowUserTraits"],
        false
    );

    let listed = dispatch(&hub, &ctx, method::AGENT_LIST, serde_json::json!({}))
        .await
        .unwrap();
    assert_eq!(listed["agents"].as_array().unwrap().len(), 1);
    let deleted = dispatch(
        &hub,
        &ctx,
        method::AGENT_DELETE,
        serde_json::json!({ "id": id }),
    )
    .await
    .unwrap();
    assert_eq!(deleted["deleted"], true);
}

#[tokio::test]
async fn native_mcp_call_waits_for_host_permission_before_any_transport_call() {
    let script = vec![
        MockTurn {
            text: "I will ask the configured MCP server first.".into(),
            tool_calls: vec![(
                "mcp-call-1".into(),
                "mcp_call".into(),
                serde_json::json!({
                    "server": "not-configured",
                    "tool": "would-have-run",
                    "arguments": { "input": "must not reach MCP" }
                }),
            )],
            stream_in_chunks: false,
        },
        MockTurn {
            text: "The MCP request was declined.".into(),
            tool_calls: vec![],
            stream_in_chunks: false,
        },
    ];
    let hub = test_hub(script).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let mut events = hub.event_tx.subscribe();
    let conversation = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({ "title": "Native MCP permission" }),
    )
    .await
    .unwrap();
    let started = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({
            "conversationId": conversation["id"],
            "text": "Try the MCP tool."
        }),
    )
    .await
    .unwrap();
    let stream_id = started["streamId"].as_str().unwrap();

    let mut permission_requested = false;
    let mut rejected_result = false;
    loop {
        let frame = events.recv().await.unwrap();
        if frame.stream_id != stream_id {
            continue;
        }
        match frame.kind {
            EventKind::PermissionRequest {
                request_id,
                tool_name,
                ..
            } if tool_name == "mcp_call" => {
                permission_requested = true;
                let response = dispatch(
                    &hub,
                    &ctx,
                    method::CHAT_RESPOND,
                    serde_json::json!({ "requestId": request_id, "allow": false }),
                )
                .await
                .unwrap();
                assert_eq!(response["delivered"], true);
            }
            EventKind::ToolResult {
                name,
                content,
                is_error,
                ..
            } if name == "mcp_call" => {
                rejected_result = is_error && content.contains("权限被拒绝");
            }
            EventKind::Done { .. } | EventKind::Error { .. } => break,
            _ => {}
        }
    }

    assert!(
        permission_requested,
        "Rust MCP call must ask Electron before execution"
    );
    assert!(
        rejected_result,
        "denied MCP calls must not reach the Rust MCP transport"
    );
}

#[tokio::test]
async fn mobile_generate_image_is_allowed_queued_and_agent_continues() {
    let hub = test_hub(vec![
        MockTurn {
            text: "我来生成图片。".into(),
            tool_calls: vec![(
                "image-call-1".into(),
                "generate_image".into(),
                serde_json::json!({"prompt": "一只戴帽子的猫"}),
            )],
            stream_in_chunks: false,
        },
        MockTurn {
            text: "图片任务已加入队列，我会继续处理。".into(),
            tool_calls: vec![],
            stream_in_chunks: false,
        },
    ])
    .await;
    let ctx = ConnectionContext::new(Capabilities::mobile("mobile-ios"));
    let conversation = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({"title": "mobile image queue"}),
    )
    .await
    .unwrap();
    let started = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({
            "conversationId": conversation["id"],
            "text": "请生成一张戴帽子的猫"
        }),
    )
    .await
    .unwrap();
    let stream_id = started["streamId"].as_str().unwrap().to_string();
    let mut events = hub.event_tx.subscribe();
    let mut saw_queue = false;
    let mut continued = String::new();
    loop {
        let frame = events.recv().await.unwrap();
        if frame.stream_id != stream_id {
            continue;
        }
        match frame.kind {
            EventKind::PermissionRequest { request_id, .. } => {
                let response = dispatch(
                    &hub,
                    &ctx,
                    method::CHAT_RESPOND,
                    serde_json::json!({"requestId": request_id, "allow": true}),
                )
                .await
                .unwrap();
                assert_eq!(response["delivered"], true);
            }
            EventKind::ToolResult { name, content, .. } if name == "generate_image" => {
                saw_queue = content.contains("\"queued\"");
            }
            EventKind::Delta { text } => continued.push_str(&text),
            EventKind::Done { .. } | EventKind::Error { .. } => break,
            _ => {}
        }
    }
    assert!(saw_queue, "generate_image should return a queue receipt");
    assert!(
        continued.contains("继续处理"),
        "agent should continue after tool result"
    );
    let drained = dispatch(
        &hub,
        &ctx,
        method::STUDIO_TASKS_DRAIN,
        serde_json::json!({}),
    )
    .await
    .unwrap();
    assert_eq!(drained["tasks"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn native_group_injection_preserves_directed_recipients() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let created = dispatch(
        &hub,
        &ctx,
        method::GROUP_CREATE,
        serde_json::json!({
            "topic": "Review the native group route",
            "mode": "discussion",
            "members": [
                { "name": "Coordinator", "persona": "Coordinate", "agentId": "coordinator" },
                { "name": "Engineer", "persona": "Implement", "agentId": "engineer" }
            ],
            "coordinator": "Coordinator",
            "maxParallelWorkers": 4
        }),
    )
    .await
    .unwrap();
    let id = created["id"].as_str().unwrap();
    assert_eq!(created["maxParallelWorkers"], 4);

    let injected = dispatch(
        &hub,
        &ctx,
        method::GROUP_INJECT,
        serde_json::json!({
            "id": id,
            "content": "Prioritize the cancellation path.",
            "targetAgentIds": ["engineer"]
        }),
    )
    .await
    .unwrap();
    assert_eq!(injected["queued"], 1);

    let session = dispatch(
        &hub,
        &ctx,
        method::GROUP_GET,
        serde_json::json!({ "id": id }),
    )
    .await
    .unwrap();
    assert_eq!(
        session["pendingInjections"][0]["content"],
        "Prioritize the cancellation path."
    );
    assert_eq!(
        session["pendingInjections"][0]["targetAgentIds"],
        serde_json::json!(["engineer"])
    );

    let invalid_target = dispatch(
        &hub,
        &ctx,
        method::GROUP_INJECT,
        serde_json::json!({
            "id": id,
            "content": "This target does not exist.",
            "targetAgentIds": ["missing"]
        }),
    )
    .await;
    assert!(invalid_target.is_err());

    // During a live native round, an unspecified recipient list must resolve
    // to the currently active Rust members instead of leaking into a future
    // round as an unbounded broadcast.
    {
        let mut sessions = hub.group_sessions.lock().unwrap();
        let live = sessions.get_mut(id).unwrap();
        live.status = "running".into();
        live.active_member_ids = vec!["coordinator".into(), "engineer".into()];
    }
    let live_broadcast = dispatch(
        &hub,
        &ctx,
        method::GROUP_INJECT,
        serde_json::json!({
            "id": id,
            "content": "Keep the cancellation path in scope.",
            "targetAgentIds": []
        }),
    )
    .await
    .unwrap();
    assert_eq!(live_broadcast["queued"], 2);
    let session = dispatch(
        &hub,
        &ctx,
        method::GROUP_GET,
        serde_json::json!({ "id": id }),
    )
    .await
    .unwrap();
    assert_eq!(
        session["pendingInjections"][1]["targetAgentIds"],
        serde_json::json!(["coordinator", "engineer"])
    );
}

#[tokio::test]
async fn native_group_tools_emit_rust_owned_board_peer_and_direct_reply_events() {
    let script = vec![
        MockTurn {
            text: "I will claim the Rust task.".into(),
            tool_calls: vec![(
                "board-1".into(),
                "update_board".into(),
                serde_json::json!({
                    "field": "tasks",
                    "op": "add",
                    "payload": {
                        "id": "native-tools",
                        "title": "Exercise native group tools",
                        "ownerAgentId": "coordinator",
                        "status": "running"
                    },
                    "reason": "The coordinator owns the integration check."
                }),
            )],
            stream_in_chunks: false,
        },
        MockTurn {
            text: "Posting a direct update now.".into(),
            tool_calls: vec![(
                "reply-1".into(),
                "reply_to_user".into(),
                serde_json::json!({ "content": "Rust group tools are executing natively." }),
            )],
            stream_in_chunks: false,
        },
        MockTurn {
            text: "Coordinator working note complete.".into(),
            tool_calls: vec![],
            stream_in_chunks: false,
        },
        MockTurn {
            text: "Reading the shared board first.".into(),
            tool_calls: vec![("read-1".into(), "read_board".into(), serde_json::json!({}))],
            stream_in_chunks: false,
        },
        MockTurn {
            text: "Consulting the coordinator.".into(),
            tool_calls: vec![(
                "peer-1".into(),
                "message_agent".into(),
                serde_json::json!({
                    "target_agent_id": "coordinator",
                    "message": "Confirm the native board task is in progress."
                }),
            )],
            stream_in_chunks: false,
        },
        MockTurn {
            text: "Confirmed: the Rust board task is in progress.".into(),
            tool_calls: vec![],
            stream_in_chunks: false,
        },
        MockTurn {
            text: "Engineer working note complete.".into(),
            tool_calls: vec![],
            stream_in_chunks: false,
        },
    ];
    let hub = test_hub(script).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let mut events = hub.event_tx.subscribe();
    let created = dispatch(
        &hub,
        &ctx,
        method::GROUP_CREATE,
        serde_json::json!({
            "topic": "Native group tool exercise",
            "mode": "discussion",
            "members": [
                { "name": "Coordinator", "persona": "Coordinate", "agentId": "coordinator" },
                { "name": "Engineer", "persona": "Implement", "agentId": "engineer" }
            ],
            "coordinator": "Coordinator"
        }),
    )
    .await
    .unwrap();
    let group_id = created["id"].as_str().unwrap().to_string();

    dispatch(
        &hub,
        &ctx,
        method::GROUP_MESSAGE,
        serde_json::json!({
            "id": group_id,
            "text": "Exercise every native group collaboration tool.",
            "round": 1,
            "memberIds": ["coordinator", "engineer"]
        }),
    )
    .await
    .unwrap();

    let mut saw_structured_board_update = false;
    let mut saw_direct_reply = false;
    let mut saw_peer_pending = false;
    let mut saw_peer_completed = false;
    let mut saw_read_board_tool = false;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), events.recv())
            .await
            .expect("native group event timeout")
            .expect("native group event channel closed");
        match &frame.kind {
            EventKind::BoardUpdate {
                update: Some(update),
                ..
            } if frame.stream_id == group_id => {
                saw_structured_board_update |= update.field == "tasks"
                    && update.agent_id == "coordinator"
                    && update.payload["id"] == "native-tools";
            }
            EventKind::GroupDirectReply { reply } if frame.stream_id == group_id => {
                saw_direct_reply |= reply.agent_id == "coordinator"
                    && reply.content == "Rust group tools are executing natively.";
            }
            EventKind::GroupPeerMessage { message } if frame.stream_id == group_id => {
                saw_peer_pending |= message.status == "pending";
                saw_peer_completed |= message.status == "completed" && !message.response.is_empty();
            }
            EventKind::ToolCall { name, .. } if name == "read_board" => {
                saw_read_board_tool = true;
            }
            EventKind::Done { stop_reason }
                if frame.stream_id == group_id && stop_reason == "group_complete" =>
            {
                break;
            }
            EventKind::Done { .. } | EventKind::Error { .. } => {}
            _ => {}
        }
    }

    assert!(saw_structured_board_update);
    assert!(saw_direct_reply);
    assert!(saw_peer_pending);
    assert!(saw_peer_completed);
    assert!(saw_read_board_tool);

    let persisted = dispatch(
        &hub,
        &ctx,
        method::GROUP_GET,
        serde_json::json!({ "id": group_id }),
    )
    .await
    .unwrap();
    assert_eq!(persisted["board"]["tasks"][0]["id"], "native-tools");
    assert_eq!(persisted["board"]["tasks"][0]["status"], "running");
    assert_eq!(
        persisted["boardUpdates"][0]["reason"],
        "The coordinator owns the integration check."
    );
}

#[tokio::test]
async fn rust_project_control_plane_matches_electron_renderer_shapes() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let root = hub.workspace.join("alpha");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::create_dir_all(root.join("node_modules/hidden")).unwrap();
    std::fs::create_dir_all(root.join(".next")).unwrap();
    std::fs::write(root.join("src/main.ts"), "export const initial = true\n").unwrap();
    std::fs::write(root.join("node_modules/hidden/index.js"), "ignored").unwrap();
    std::fs::write(root.join(".next/internal"), "ignored").unwrap();
    std::fs::write(
        root.join(".world-meta.json"),
        r#"{"name":"Alpha","type":"frontend","icon":"spark"}"#,
    )
    .unwrap();

    let listed = dispatch(&hub, &ctx, method::PROJECT_LIST, serde_json::json!({}))
        .await
        .unwrap();
    assert_eq!(listed["projects"][0]["id"], "alpha");
    assert_eq!(listed["projects"][0]["name"], "Alpha");
    assert_eq!(listed["projects"][0]["icon"], "spark");

    let tree = dispatch(
        &hub,
        &ctx,
        method::PROJECT_TREE,
        serde_json::json!({ "projectId": "alpha" }),
    )
    .await
    .unwrap();
    assert!(tree
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["path"] == "src"));
    assert!(!tree
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["path"] == "node_modules"));
    assert!(!tree
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["path"] == ".next"));

    let read = dispatch(
        &hub,
        &ctx,
        method::PROJECT_FILE_READ,
        serde_json::json!({ "projectId": "alpha", "filePath": "src/main.ts" }),
    )
    .await
    .unwrap();
    assert_eq!(read["content"], "export const initial = true\n");

    dispatch(
        &hub,
        &ctx,
        method::PROJECT_FILE_WRITE,
        serde_json::json!({ "projectId": "alpha", "filePath": "src/new.ts", "content": "export const native = true\n" }),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join("src/new.ts")).unwrap(),
        "export const native = true\n"
    );
    assert!(dispatch(
        &hub,
        &ctx,
        method::PROJECT_FILE_WRITE,
        serde_json::json!({ "projectId": "alpha", "filePath": "../escape.ts", "content": "no" }),
    )
    .await
    .is_err());

    let updated = dispatch(
        &hub,
        &ctx,
        method::PROJECT_META_UPDATE,
        serde_json::json!({ "projectId": "alpha", "updates": { "name": "Native Alpha", "icon": "" } }),
    )
    .await
    .unwrap();
    assert_eq!(updated["name"], "Native Alpha");
    assert!(updated.get("icon").is_none());
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
            tool_calls: vec![(
                "call-1".into(),
                "read_file".into(),
                serde_json::json!({"path": "notes.txt"}),
            )],
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

    let conv = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({"title": "E2E"}),
    )
    .await
    .unwrap();
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
            EventKind::ToolResult { is_error, .. } => {
                kinds.push(format!("tool_result_err:{is_error}"))
            }
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
    assert!(
        text.contains("部署密钥是 WB-123"),
        "second turn should include file content via mock: {text}"
    );

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
    assert!(
        msgs.len() >= 4,
        "expected persisted messages, got {}",
        msgs.len()
    );
    assert!(msgs.iter().any(|m| m["toolCalls"]
        .as_array()
        .map(|a| !a.is_empty())
        .unwrap_or(false)));
}

#[tokio::test]
async fn rust_chat_uses_native_folder_workspace_tools() {
    let folder =
        std::env::temp_dir().join(format!("folder-workspace-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("native.txt"), "native Rust workspace content").unwrap();

    let script = vec![
        MockTurn {
            text: "I will read the selected folder workspace.".into(),
            tool_calls: vec![(
                "workspace-read".into(),
                "read_workspace_file".into(),
                serde_json::json!({ "file_path": "native.txt" }),
            )],
            stream_in_chunks: false,
        },
        MockTurn {
            text: "The native workspace file was read.".into(),
            tool_calls: vec![],
            stream_in_chunks: false,
        },
    ];
    let hub = test_hub(script).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let mut events = hub.event_tx.subscribe();

    let conv = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({ "title": "Rust folder workspace" }),
    )
    .await
    .unwrap();
    let conversation_id = conv["id"].as_str().unwrap();
    let result = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({
            "conversationId": conversation_id,
            "text": "Read native.txt from the selected folder.",
            "workspaceRoot": folder,
        }),
    )
    .await
    .unwrap();
    let stream_id = result["streamId"].as_str().unwrap();

    let mut saw_native_result = false;
    loop {
        let frame = events.recv().await.unwrap();
        if frame.stream_id != stream_id {
            continue;
        }
        match frame.kind {
            EventKind::ToolResult {
                ref name,
                ref content,
                is_error,
                ..
            } if name == "read_workspace_file" => {
                assert!(!is_error, "workspace tool failed: {content}");
                assert!(content.contains("native Rust workspace content"));
                saw_native_result = true;
            }
            EventKind::Done { .. } | EventKind::Error { .. } => break,
            _ => {}
        }
    }
    assert!(
        saw_native_result,
        "Rust chat did not execute read_workspace_file"
    );
    let _ = std::fs::remove_dir_all(folder);
}

#[test]
fn multimodal_parts_reach_rust_llm_messages() {
    let messages = vec![ChatMessage {
        id: 0,
        role: Role::User,
        content: "Please inspect this image.".into(),
        parts: vec![
            ChatContentPart::Text {
                text: "Please inspect this image.".into(),
            },
            ChatContentPart::ImageUrl {
                image_url: ImageUrl {
                    url: "data:image/png;base64,AAAA".into(),
                },
            },
        ],
        tool_calls: vec![],
        tool_results: vec![],
        created_at: None,
    }];

    let llm_messages = worldbase_core::to_llm_messages(&messages);
    assert_eq!(llm_messages.len(), 1);
    assert!(matches!(
        llm_messages[0].content.as_slice(),
        [ContentBlock::Text { text }, ContentBlock::ImageUrl { url }]
            if text == "Please inspect this image." && url == "data:image/png;base64,AAAA"
    ));
}

#[tokio::test]
async fn electron_host_override_replaces_same_named_rust_tool() {
    let script = vec![
        MockTurn {
            text: "Delegate the file read to Electron.".into(),
            tool_calls: vec![(
                "call-host-override".into(),
                "read_file".into(),
                serde_json::json!({"path": "notes.txt"}),
            )],
            stream_in_chunks: false,
        },
        MockTurn {
            text: "Electron supplied the project file result.".into(),
            tool_calls: vec![],
            stream_in_chunks: false,
        },
    ];
    let hub = test_hub(script).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let mut events = hub.event_tx.subscribe();

    let conv = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({"title": "Electron host override"}),
    )
    .await
    .unwrap();
    let conv_id = conv["id"].as_str().unwrap().to_string();

    let result = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({
            "conversationId": conv_id,
            "text": "Read notes.txt using Electron semantics.",
            "customTools": [{
                "name": "read_file",
                "description": "Electron-owned project file reader.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"]
                },
                "domain": "electron_host_override",
                "permission": "allow"
            }]
        }),
    )
    .await
    .unwrap();
    let stream_id = result["streamId"].as_str().unwrap().to_string();

    let mut host_request_received = false;
    let mut host_result_received = false;
    loop {
        let frame = match events.recv().await {
            Ok(frame) => frame,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(error) => panic!("event recv: {error}"),
        };
        if frame.stream_id != stream_id {
            continue;
        }
        match frame.kind {
            EventKind::HostRequest {
                request_id,
                request_kind,
                payload,
            } => {
                assert_eq!(request_kind, "tool.execute");
                assert_eq!(payload["name"], "read_file");
                assert_eq!(payload["args"]["path"], "notes.txt");
                host_request_received = true;
                assert!(hub.host_respond(
                    &request_id,
                    serde_json::json!({"source": "electron", "content": "electron override"}),
                ));
            }
            EventKind::ToolResult {
                name,
                content,
                is_error,
                ..
            } => {
                if name == "read_file" {
                    assert!(!is_error, "host override should succeed: {content}");
                    assert!(
                        content.contains("electron override"),
                        "unexpected host result: {content}"
                    );
                    host_result_received = true;
                }
            }
            EventKind::Done { .. } => break,
            EventKind::Error { message } => panic!("host override stream failed: {message}"),
            _ => {}
        }
    }

    assert!(
        host_request_received,
        "same-name override must call Electron host"
    );
    assert!(
        host_result_received,
        "same-name override result must feed the Rust loop"
    );
}

#[tokio::test]
async fn plan_mode_blocks_mutating_tool_calls_in_the_same_run() {
    let script = vec![
        MockTurn {
            text: "我先制定计划。".into(),
            tool_calls: vec![(
                "plan-1".into(),
                "enter_plan_mode".into(),
                serde_json::json!({ "goal": "先检查再修改" }),
            )],
            stream_in_chunks: true,
        },
        MockTurn {
            text: "现在尝试写入。".into(),
            tool_calls: vec![(
                "write-1".into(),
                "write_project_file".into(),
                serde_json::json!({
                    "project_id": "blocked-project",
                    "file_path": "src/app.ts",
                    "content": "export const changed = true"
                }),
            )],
            stream_in_chunks: true,
        },
        MockTurn {
            text: "规划阶段已完成。".into(),
            tool_calls: vec![],
            stream_in_chunks: true,
        },
    ];
    let hub = test_hub(script).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let mut events = hub.event_tx.subscribe();
    let conv = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({ "title": "Plan mode" }),
    )
    .await
    .unwrap();
    let sent = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({ "conversationId": conv["id"], "text": "先规划后修改" }),
    )
    .await
    .unwrap();
    let stream_id = sent["streamId"].as_str().unwrap().to_string();

    let mut blocked_content = None;
    loop {
        let frame = events.recv().await.unwrap();
        if frame.stream_id != stream_id {
            continue;
        }
        match &frame.kind {
            EventKind::ToolResult {
                name,
                content,
                is_error,
                ..
            } if name == "write_project_file" => {
                assert!(*is_error, "plan-mode write must be rejected");
                blocked_content = Some(content.clone());
            }
            EventKind::Done { .. } | EventKind::Error { .. } => break,
            _ => {}
        }
    }

    assert!(blocked_content
        .as_deref()
        .unwrap_or_default()
        .contains("规划模式"));
    assert!(!hub.workspace.join("blocked-project/src/app.ts").exists());
}

#[tokio::test]
async fn initial_plan_mode_blocks_mutating_tool_calls() {
    let script = vec![
        MockTurn {
            text: "Attempting a write from an already planned run.".into(),
            tool_calls: vec![(
                "write-from-initial-plan".into(),
                "write_project_file".into(),
                serde_json::json!({
                    "project_id": "initial-plan-project",
                    "file_path": "src/app.ts",
                    "content": "export const blocked = true"
                }),
            )],
            stream_in_chunks: false,
        },
        MockTurn {
            text: "The write was correctly rejected while planning.".into(),
            tool_calls: vec![],
            stream_in_chunks: false,
        },
    ];
    let hub = test_hub(script).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let mut events = hub.event_tx.subscribe();
    let conv = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({"title": "Initial plan mode"}),
    )
    .await
    .unwrap();
    let sent = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({
            "conversationId": conv["id"],
            "text": "Do not write yet.",
            "planModeActive": true
        }),
    )
    .await
    .unwrap();
    let stream_id = sent["streamId"].as_str().unwrap().to_string();

    let mut blocked = false;
    loop {
        let frame = events.recv().await.unwrap();
        if frame.stream_id != stream_id {
            continue;
        }
        match &frame.kind {
            EventKind::ToolResult {
                name,
                content,
                is_error,
                ..
            } if name == "write_project_file" => {
                blocked = *is_error && content.contains("规划模式");
            }
            EventKind::Done { .. } | EventKind::Error { .. } => break,
            _ => {}
        }
    }

    assert!(blocked, "initial plan mode must reject writes");
    assert!(!hub
        .workspace
        .join("initial-plan-project/src/app.ts")
        .exists());
}

#[tokio::test]
async fn priced_usage_is_emitted_and_budget_stops_the_next_iteration() {
    let hub = test_hub(vec![]).await;
    hub.store
        .set_setting(
            "providers",
            &serde_json::json!({
                "activeProviderId": "priced-mock",
                "providers": [{
                    "id": "priced-mock",
                    "name": "Priced mock",
                    "baseUrl": "",
                    "apiKey": "",
                    "apiProtocol": "openai",
                    "activeModel": "priced-model",
                    "models": [{
                        "id": "priced-model",
                        "inputPrice": 1_000_000.0,
                        "outputPrice": 1_000_000.0,
                        "cacheReadPrice": 1_000_000.0
                    }]
                }]
            }),
        )
        .unwrap();
    // The mock's first turn asks to create a lightweight app. Use a
    // non-interactive host so its `ask` permission is rejected immediately;
    // the loop can then reach the budget gate instead of waiting for a UI
    // response.
    let ctx = ConnectionContext::new(Capabilities {
        platform: "test".into(),
        features: vec!["subprocess".into(), "port_binding".into()],
        excludes: vec![],
    });
    let mut events = hub.event_tx.subscribe();
    let conv = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({"title": "Usage and budget"}),
    )
    .await
    .unwrap();
    let sent = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({
            "conversationId": conv["id"],
            "text": "请做一个应用，随后继续完善。",
            "budgetLimit": 0.5
        }),
    )
    .await
    .unwrap();
    let stream_id = sent["streamId"].as_str().unwrap().to_string();

    let mut usage_events = 0usize;
    let mut usage_cost = 0.0;
    let stop_reason;
    loop {
        let frame = events.recv().await.unwrap();
        if frame.stream_id != stream_id {
            continue;
        }
        match frame.kind {
            EventKind::Usage {
                provider_id,
                provider_name,
                model,
                input_tokens,
                output_tokens,
                cost,
                total_cost,
                ..
            } => {
                usage_events += 1;
                assert_eq!(provider_id.as_deref(), Some("priced-mock"));
                assert_eq!(provider_name, "Priced mock");
                assert_eq!(model, "priced-model");
                assert!(input_tokens > 0);
                assert!(output_tokens > 0);
                assert!(cost > 0.5);
                assert_eq!(cost, total_cost);
                usage_cost = cost;
            }
            EventKind::Done {
                stop_reason: reason,
            } => {
                stop_reason = reason;
                break;
            }
            EventKind::Error { message } => panic!("priced chat failed: {message}"),
            _ => {}
        }
    }

    assert_eq!(usage_events, 1, "budget must prevent a second model call");
    assert_eq!(stop_reason, "budget_exceeded");
    let summary = hub.store.usage_summary(1).unwrap();
    assert!(summary.total_cost >= usage_cost);
    assert!(summary.total_input_tokens > 0);
    assert!(summary.total_output_tokens > 0);
}

#[tokio::test]
async fn mock_echo_reply_without_script() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let mut events = hub.event_tx.subscribe();

    let conv = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({}),
    )
    .await
    .unwrap();
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
    assert!(
        text.contains("你好 harness"),
        "echo mock should reply: {text}"
    );
}

#[tokio::test]
async fn conversation_sync_replaces_host_history_without_duplicates() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let conv_id = "host-conversation";

    dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_ENSURE,
        serde_json::json!({ "id": conv_id, "title": "Host", "agentId": "agent-1" }),
    )
    .await
    .unwrap();
    let history = serde_json::json!({
        "id": conv_id,
        "messages": [
            { "role": "user", "content": "旧问题" },
            { "role": "assistant", "content": "旧回答" }
        ]
    });
    dispatch(&hub, &ctx, method::CONVERSATION_SYNC, history.clone())
        .await
        .unwrap();
    dispatch(&hub, &ctx, method::CONVERSATION_SYNC, history)
        .await
        .unwrap();

    let messages = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_MESSAGES,
        serde_json::json!({ "id": conv_id }),
    )
    .await
    .unwrap();
    let rows = messages["messages"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["content"], "旧问题");
    assert_eq!(rows[1]["content"], "旧回答");
}

#[tokio::test]
async fn tool_list_respects_capability_filter() {
    let hub = test_hub(vec![]).await;
    let desktop = ConnectionContext::new(Capabilities::desktop());
    let mobile = ConnectionContext::new(Capabilities::mobile("mobile-ios"));

    let all = dispatch(&hub, &desktop, method::TOOL_LIST, serde_json::json!({}))
        .await
        .unwrap();
    let names: Vec<&str> = all["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"execute_command"));

    let filtered = dispatch(&hub, &mobile, method::TOOL_LIST, serde_json::json!({}))
        .await
        .unwrap();
    let names: Vec<&str> = filtered["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(
        !names.contains(&"execute_command"),
        "mobile must not see desktop tools"
    );
    assert!(names.contains(&"read_file"));
    assert!(
        !names.contains(&"create_project"),
        "mobile must not see create_project"
    );
}

#[tokio::test]
async fn desktop_methods_hidden_on_mobile() {
    let hub = test_hub(vec![]).await;
    let mobile = ConnectionContext::new(Capabilities::mobile("mobile-ios"));
    let err = dispatch(
        &hub,
        &mobile,
        method::EXEC_RUN,
        serde_json::json!({"program": "ls"}),
    )
    .await;
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
    let hits = dispatch(
        &hub,
        &ctx,
        method::MEMORY_SEARCH,
        serde_json::json!({"query": "深色"}),
    )
    .await
    .unwrap();
    assert_eq!(hits["hits"].as_array().unwrap().len(), 1);

    dispatch(
        &hub,
        &ctx,
        method::SETTINGS_SET,
        serde_json::json!({"key": "provider.model", "value": "mock-2"}),
    )
    .await
    .unwrap();
    let got = dispatch(
        &hub,
        &ctx,
        method::SETTINGS_GET,
        serde_json::json!({"key": "provider.model"}),
    )
    .await
    .unwrap();
    assert_eq!(got["value"], "mock-2");

    let skills = dispatch(&hub, &ctx, method::SKILL_LIST, serde_json::json!({}))
        .await
        .unwrap();
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

    let list = dispatch(&hub, &ctx, method::SCHEDULE_LIST, serde_json::json!({}))
        .await
        .unwrap();
    assert_eq!(list["schedules"].as_array().unwrap().len(), 1);
    assert!(list["schedules"][0]["nextRunAt"].is_string());
}

#[tokio::test]
async fn workspace_memory_catalog_crud_and_compaction_via_dispatcher() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());

    let saved = dispatch(
        &hub,
        &ctx,
        method::MEMORY_SAVE,
        serde_json::json!({
            "entry": {
                "id": "electron-memory-1",
                "scopeType": "user",
                "scopeId": "local-user",
                "memoryType": "knowledge",
                "title": " Rust preference ",
                "summary": " The user prefers Rust services ",
                "tags": ["rust", "rust"],
                "importance": 0.8,
                "confidence": 0.9,
                "pinned": false
            }
        }),
    )
    .await
    .unwrap();
    assert_eq!(saved["entry"]["id"], "electron-memory-1");
    assert_eq!(saved["entry"]["tags"], serde_json::json!(["rust"]));

    let listed = dispatch(
        &hub,
        &ctx,
        method::MEMORY_LIST,
        serde_json::json!({ "query": "Rust", "limit": 10 }),
    )
    .await
    .unwrap();
    assert_eq!(listed["entries"].as_array().unwrap().len(), 1);

    let pinned = dispatch(
        &hub,
        &ctx,
        method::MEMORY_PIN,
        serde_json::json!({ "id": "electron-memory-1", "pinned": true }),
    )
    .await
    .unwrap();
    assert_eq!(pinned["updated"], true);

    let status_before = dispatch(
        &hub,
        &ctx,
        method::MEMORY_COMPACT_STATUS,
        serde_json::json!({}),
    )
    .await
    .unwrap();
    assert_eq!(status_before["status"], "idle");

    let compacted = dispatch(
        &hub,
        &ctx,
        method::MEMORY_COMPACT,
        serde_json::json!({
            "plan": {
                "deleteIds": ["electron-memory-1"]
            }
        }),
    )
    .await
    .unwrap();
    // Pinned entries are retained, matching Electron's compaction contract.
    assert_eq!(compacted["deleted"], 0);
    assert_eq!(compacted["retained"], 1);

    let deleted = dispatch(
        &hub,
        &ctx,
        method::MEMORY_DELETE,
        serde_json::json!({ "id": "electron-memory-1" }),
    )
    .await
    .unwrap();
    assert_eq!(deleted["deleted"], true);

    let status_after = dispatch(
        &hub,
        &ctx,
        method::MEMORY_COMPACT_STATUS,
        serde_json::json!({}),
    )
    .await
    .unwrap();
    assert_eq!(status_after["status"], "completed");
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

    let parsed = dispatch(
        &hub,
        &ctx,
        method::DOC_PARSE,
        serde_json::json!({"path": "report.docx"}),
    )
    .await
    .unwrap();
    assert_eq!(parsed["kind"], "docx");
    assert!(parsed["text"].as_str().unwrap().contains("Rust harness"));
}

#[tokio::test]
async fn initialize_handshake_reports_version_and_tools() {
    let hub = test_hub(vec![]).await;
    // The transport starts with a bootstrap capability set.  initialize is
    // authoritative and must update all later dispatches on this connection.
    let ctx = ConnectionContext::new(Capabilities::desktop());
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

    let filtered = dispatch(&hub, &ctx, method::TOOL_LIST, serde_json::json!({}))
        .await
        .unwrap();
    assert!(filtered["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|tool| tool["domain"] != "desktop"));
    let err = dispatch(
        &hub,
        &ctx,
        method::EXEC_RUN,
        serde_json::json!({"program": "echo", "args": ["should-be-hidden"]}),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, worldbase_protocol::rpc::METHOD_NOT_FOUND);
}
