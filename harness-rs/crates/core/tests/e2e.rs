//! 端到端集成测试：mock provider 驱动完整 agent 循环（含工具调用、能力协商、
//! 持久化、文档、记忆、定时任务）。

use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use worldbase_core::dispatcher::ConnectionContext;
use worldbase_core::Hub;
use worldbase_protocol::event::EventKind;
use worldbase_protocol::method;
use worldbase_protocol::rpc::{ErrorObject, INVALID_PARAMS};
use worldbase_protocol::types::{Capabilities, ChatContentPart, ChatMessage, ImageUrl, Role};
use worldbase_providers::{
    ChatOptions, ChunkStream, ContentBlock, LlmMessage, LlmTool, MockProvider, MockTurn, Provider,
    StreamChunk, TokenUsage,
};

#[derive(Clone, Copy)]
enum BlockingProviderStage {
    BeforeStream,
    DuringStream,
}

struct BlockingProvider {
    stage: BlockingProviderStage,
    started: Arc<tokio::sync::Notify>,
}

#[derive(Default)]
struct RepairingInvalidToolProvider {
    turn: std::sync::atomic::AtomicUsize,
}

#[derive(Debug, Clone)]
struct CapturedProviderRequest {
    system: Option<String>,
    tools: Vec<String>,
    options: ChatOptions,
}

#[derive(Default)]
struct CapturingProvider {
    requests: std::sync::Mutex<Vec<CapturedProviderRequest>>,
}

impl CapturingProvider {
    fn requests(&self) -> Vec<CapturedProviderRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl Provider for CapturingProvider {
    fn name(&self) -> &str {
        "capturing-test"
    }

    fn model(&self) -> &str {
        "capturing-test-model"
    }

    async fn chat_stream(
        &self,
        system: Option<&str>,
        _messages: Vec<LlmMessage>,
        tools: Vec<LlmTool>,
        _max_tokens: u32,
        options: ChatOptions,
    ) -> anyhow::Result<ChunkStream> {
        self.requests.lock().unwrap().push(CapturedProviderRequest {
            system: system.map(ToOwned::to_owned),
            tools: tools.into_iter().map(|tool| tool.name).collect(),
            options,
        });
        Ok(Box::pin(futures::stream::iter([Ok(
            StreamChunk::Completed {
                stop_reason: "stop".into(),
                assistant: LlmMessage::text(
                    worldbase_providers::LlmRole::Assistant,
                    "Captured policy request.",
                ),
                usage: TokenUsage::default(),
            },
        )])))
    }
}

#[async_trait::async_trait]
impl Provider for RepairingInvalidToolProvider {
    fn name(&self) -> &str {
        "repairing-invalid-tool-test"
    }

    fn model(&self) -> &str {
        "repairing-invalid-tool-model"
    }

    async fn chat_stream(
        &self,
        _system: Option<&str>,
        _messages: Vec<LlmMessage>,
        _tools: Vec<LlmTool>,
        _max_tokens: u32,
        _options: ChatOptions,
    ) -> anyhow::Result<ChunkStream> {
        let turn = self.turn.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let content = if turn == 0 {
            vec![ContentBlock::ToolUse {
                id: "invalid-call".into(),
                name: "read_file".into(),
                input: serde_json::json!({ "_raw": "{broken" }),
                raw_input: Some("{broken".into()),
                input_error: Some(
                    "openai returned invalid JSON arguments for tool `read_file`: {broken".into(),
                ),
            }]
        } else {
            vec![ContentBlock::Text {
                text: "Recovered after the tool error.".into(),
            }]
        };
        Ok(Box::pin(futures::stream::iter([Ok(
            StreamChunk::Completed {
                stop_reason: if turn == 0 { "tool_calls" } else { "stop" }.into(),
                assistant: LlmMessage {
                    role: worldbase_providers::LlmRole::Assistant,
                    content,
                },
                usage: TokenUsage::default(),
            },
        )])))
    }
}

#[async_trait::async_trait]
impl Provider for BlockingProvider {
    fn name(&self) -> &str {
        "blocking-test"
    }

    fn model(&self) -> &str {
        "blocking-test-model"
    }

    async fn chat_stream(
        &self,
        _system: Option<&str>,
        _messages: Vec<LlmMessage>,
        _tools: Vec<LlmTool>,
        _max_tokens: u32,
        _options: ChatOptions,
    ) -> anyhow::Result<ChunkStream> {
        self.started.notify_one();
        match self.stage {
            BlockingProviderStage::BeforeStream => {
                std::future::pending::<anyhow::Result<ChunkStream>>().await
            }
            BlockingProviderStage::DuringStream => Ok(Box::pin(futures::stream::pending())),
        }
    }
}

async fn test_hub(mock_script: Vec<MockTurn>) -> Arc<Hub> {
    // The production registry includes the user-level skills directory. Keep
    // integration tests from reading or writing a developer's real home while
    // still exercising the same default-directory behavior.
    static TEST_WORLDBASE_HOME: std::sync::OnceLock<std::path::PathBuf> =
        std::sync::OnceLock::new();
    TEST_WORLDBASE_HOME.get_or_init(|| {
        let path =
            std::env::temp_dir().join(format!("worldbase-e2e-home-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        std::env::set_var("WORLDBASE_HOME", &path);
        path
    });

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

async fn read_http_json_request(socket: &mut tokio::net::TcpStream) -> serde_json::Value {
    let mut buffer = Vec::new();
    loop {
        let mut chunk = [0u8; 4096];
        let count = socket.read(&mut chunk).await.unwrap();
        assert!(
            count > 0,
            "HTTP client closed before sending a full request"
        );
        buffer.extend_from_slice(&chunk[..count]);

        let Some(header_end) = buffer.windows(4).position(|bytes| bytes == b"\r\n\r\n") else {
            continue;
        };
        let headers = String::from_utf8_lossy(&buffer[..header_end]);
        let content_length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or(0);
        let body_start = header_end + 4;
        if buffer.len() >= body_start + content_length {
            return serde_json::from_slice(&buffer[body_start..body_start + content_length])
                .unwrap();
        }
    }
}

async fn write_http_json_response(
    socket: &mut tokio::net::TcpStream,
    id: serde_json::Value,
    result: serde_json::Value,
) {
    let body = serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string();
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    socket.write_all(response.as_bytes()).await.unwrap();
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
async fn mobile_mcp_reload_drops_process_transports_at_the_rpc_boundary() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::mobile("mobile-ios"));

    let reloaded = dispatch(
        &hub,
        &ctx,
        method::MCP_RELOAD,
        serde_json::json!({
            "servers": [
                {
                    "name": "local-process",
                    "displayName": "Local process",
                    "enabled": true,
                    "transport": "stdio",
                    "target": "must-never-be-spawned",
                    "args": [],
                    "env": {},
                    "headers": {}
                },
                {
                    "name": "remote-docs",
                    "displayName": "Remote docs",
                    "enabled": true,
                    "transport": "streamable-http",
                    "target": "https://mcp.example.test",
                    "args": [],
                    "env": {},
                    "headers": {}
                }
            ]
        }),
    )
    .await
    .unwrap();

    assert_eq!(reloaded["servers"], serde_json::json!(["remote-docs"]));
    assert_eq!(
        reloaded["ignoredUnsupportedServers"],
        serde_json::json!(["local-process"])
    );
}

#[tokio::test]
async fn mobile_initialize_cannot_upgrade_the_transport_capability_ceiling() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::mobile("mobile-ffi"));

    let initialized = dispatch(
        &hub,
        &ctx,
        method::INITIALIZE,
        serde_json::json!({
            "protocolVersion": "1.0",
            "capabilities": {
                "platform": "desktop",
                "features": [
                    "subprocess",
                    "port_binding",
                    "webhook_receiver",
                    "webview_automation",
                    "interactive"
                ],
                "excludes": []
            }
        }),
    )
    .await
    .unwrap();

    assert!(initialized["availableDomains"]
        .as_array()
        .unwrap()
        .iter()
        .all(|domain| domain != "desktop"));
    assert!(initialized["availableTools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|tool| tool["name"] != "execute_command"));

    let listed = dispatch(&hub, &ctx, method::TOOL_LIST, serde_json::json!({}))
        .await
        .unwrap();
    assert!(listed["tools"]
        .as_array()
        .unwrap()
        .iter()
        .all(|tool| tool["name"] != "execute_command"));

    let exec_error = dispatch(
        &hub,
        &ctx,
        method::EXEC_RUN,
        serde_json::json!({ "program": "echo", "args": ["must-not-run"] }),
    )
    .await
    .unwrap_err();
    assert_eq!(exec_error.code, worldbase_protocol::rpc::METHOD_NOT_FOUND);

    let reloaded = dispatch(
        &hub,
        &ctx,
        method::MCP_RELOAD,
        serde_json::json!({
            "servers": [{
                "name": "forged-local-process",
                "displayName": "Forged local process",
                "enabled": true,
                "transport": "stdio",
                "target": "must-never-be-spawned",
                "args": [],
                "env": {},
                "headers": {}
            }]
        }),
    )
    .await
    .unwrap();
    assert_eq!(reloaded["servers"], serde_json::json!([]));
    assert_eq!(
        reloaded["ignoredUnsupportedServers"],
        serde_json::json!(["forged-local-process"])
    );
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
async fn live_ad_hoc_group_uses_member_names_for_hitl_routing() {
    let hub = test_hub(vec![]).await;
    let provider_started = Arc::new(tokio::sync::Notify::new());
    hub.set_custom_provider(Arc::new(BlockingProvider {
        stage: BlockingProviderStage::DuringStream,
        started: provider_started.clone(),
    }));
    let ctx = ConnectionContext::new(Capabilities::mobile("mobile-ios"));
    let mut events = hub.event_tx.subscribe();
    let created = dispatch(
        &hub,
        &ctx,
        method::GROUP_CREATE,
        serde_json::json!({
            "topic": "Ad-hoc mobile group",
            "mode": "discussion",
            "members": [
                { "name": "Coordinator", "persona": "Coordinate" },
                { "name": "Engineer", "persona": "Implement" }
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
        serde_json::json!({ "id": group_id, "text": "Review the mobile flow" }),
    )
    .await
    .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        provider_started.notified(),
    )
    .await
    .expect("ad-hoc member provider did not start");

    let session = dispatch(
        &hub,
        &ctx,
        method::GROUP_GET,
        serde_json::json!({ "id": group_id }),
    )
    .await
    .unwrap();
    assert!(session["activeMemberIds"]
        .as_array()
        .unwrap()
        .iter()
        .any(|id| id == "Engineer"));

    let injected = dispatch(
        &hub,
        &ctx,
        method::GROUP_INJECT,
        serde_json::json!({
            "id": group_id,
            "content": "Check cancellation as well.",
            "targetAgentIds": ["Engineer"]
        }),
    )
    .await
    .unwrap();
    assert_eq!(injected["queued"], 1);

    dispatch(
        &hub,
        &ctx,
        method::CHAT_ABORT,
        serde_json::json!({ "streamId": group_id }),
    )
    .await
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let frame = events.recv().await.unwrap();
            if frame.stream_id == group_id && matches!(frame.kind, EventKind::Done { .. }) {
                break;
            }
        }
    })
    .await
    .expect("aborted ad-hoc group did not finish promptly");
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
            text: "".into(),
            tool_calls: vec![(
                "finish-coordinator".into(),
                "finish_task".into(),
                serde_json::json!({
                    "task_summary": "Coordinator completed the native board and direct reply checks.",
                    "status": "completed"
                }),
            )],
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
            text: "".into(),
            tool_calls: vec![(
                "finish-peer".into(),
                "finish_task".into(),
                serde_json::json!({
                    "task_summary": "Engineer completed the peer consultation.",
                    "status": "completed"
                }),
            )],
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
            "sessionId": "native-group-tools",
            "topic": "Native group tool exercise",
            "mode": "discussion",
            "maxParallelWorkers": 1,
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
    assert_eq!(group_id, "native-group-tools");

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

    let transcript = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_MESSAGES,
        serde_json::json!({ "id": format!("group-{group_id}") }),
    )
    .await
    .unwrap();
    let messages = transcript["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 4);
    assert_eq!(
        messages[0]["content"],
        "Exercise every native group collaboration tool."
    );
    assert!(messages[1..].iter().all(|message| message["content"]
        .as_str()
        .unwrap()
        .starts_with("[[worldbase-group-member]]")));
    assert!(messages[1..]
        .iter()
        .any(|message| message["content"].as_str().unwrap().contains("Coordinator")));
    assert!(messages[1..]
        .iter()
        .any(|message| message["content"].as_str().unwrap().contains("Engineer")));

    let visible_conversations = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_LIST,
        serde_json::json!({ "limit": 100 }),
    )
    .await
    .unwrap();
    let visible_conversations = visible_conversations["conversations"].as_array().unwrap();
    assert_eq!(visible_conversations.len(), 1);
    assert_eq!(visible_conversations[0]["id"], format!("group-{group_id}"));
    assert!(visible_conversations
        .iter()
        .all(|conversation| !conversation["title"]
            .as_str()
            .unwrap()
            .starts_with("Native group: ")));
}

#[tokio::test]
async fn ad_hoc_group_members_use_active_provider_and_keep_internal_text_hidden() {
    let hub = test_hub(vec![
        MockTurn {
            text: "Coordinator result.\n[board] tasks|add|internal task".into(),
            tool_calls: vec![],
            stream_in_chunks: false,
        },
        MockTurn {
            text: "Engineer result.".into(),
            tool_calls: vec![],
            stream_in_chunks: false,
        },
    ])
    .await;
    let ctx = ConnectionContext::new(Capabilities::mobile("mobile-ios"));
    let mut events = hub.event_tx.subscribe();
    let created = dispatch(
        &hub,
        &ctx,
        method::GROUP_CREATE,
        serde_json::json!({
            "sessionId": "mobile-ad-hoc-group",
            "topic": "Mobile ad hoc group",
            "mode": "discussion",
            "members": [
                { "name": "Coordinator", "persona": "Coordinate" },
                { "name": "Engineer", "persona": "Implement" }
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
        serde_json::json!({ "id": group_id, "text": "Review the mobile flow." }),
    )
    .await
    .unwrap();

    let mut replies = Vec::new();
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), events.recv())
            .await
            .expect("ad hoc group event timeout")
            .expect("ad hoc group event channel closed");
        if frame.stream_id != group_id {
            continue;
        }
        match frame.kind {
            EventKind::GroupMessage { content, .. } => replies.push(content),
            EventKind::Done { stop_reason } if stop_reason == "group_complete" => break,
            EventKind::Done { stop_reason } => panic!("unexpected stop reason: {stop_reason}"),
            _ => {}
        }
    }

    assert_eq!(replies.len(), 2);
    assert!(replies.iter().all(|reply| !reply.contains("[board]")));

    let visible_conversations = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_LIST,
        serde_json::json!({ "limit": 100 }),
    )
    .await
    .unwrap();
    let visible_conversations = visible_conversations["conversations"].as_array().unwrap();
    assert_eq!(visible_conversations.len(), 1);
    assert_eq!(visible_conversations[0]["id"], format!("group-{group_id}"));
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
async fn persisted_agent_policy_and_skills_reach_the_actual_model_request() {
    let hub = test_hub(vec![]).await;
    let skill_dir = hub.workspace.join(".worldbase").join("skills");
    std::fs::create_dir_all(&skill_dir).unwrap();
    std::fs::write(
        skill_dir.join("policy-skill.yaml"),
        "name: policy-skill\ndescription: Policy test\ninstructions: Always cite the persisted policy evidence.\n",
    )
    .unwrap();
    let provider = Arc::new(CapturingProvider::default());
    hub.set_custom_provider(provider.clone());
    let ctx = ConnectionContext::new(Capabilities::desktop());

    dispatch(
        &hub,
        &ctx,
        method::AGENT_SAVE,
        serde_json::json!({
            "agent": {
                "id": "persisted-policy-agent",
                "name": "Persisted policy agent",
                "systemPrompt": "Use the persisted agent policy.",
                "skillIds": ["policy-skill"],
                "reasoningStrength": "high",
                "allowedTools": ["read_file", "write_file"],
                "deniedTools": ["write_file"]
            }
        }),
    )
    .await
    .unwrap();
    let conversation = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({"title": "Persisted policy E2E"}),
    )
    .await
    .unwrap();
    let conversation_id = conversation["id"].as_str().unwrap();
    let mut events = hub.event_tx.subscribe();
    let result = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({
            "conversationId": conversation_id,
            "text": "Inspect policy.",
            "agentId": "persisted-policy-agent",
            "allowedToolNames": ["read_file", "memory_search"],
            "deniedToolNames": ["memory_search"]
        }),
    )
    .await
    .unwrap();
    let stream_id = result["streamId"].as_str().unwrap();
    loop {
        let frame = events.recv().await.unwrap();
        if frame.stream_id == stream_id
            && matches!(frame.kind, EventKind::Done { .. } | EventKind::Error { .. })
        {
            break;
        }
    }

    let requests = provider.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].tools, vec!["read_file", "finish_task"]);
    assert_eq!(
        requests[0].options.reasoning_effort.as_deref(),
        Some("high")
    );
    let system = requests[0].system.as_deref().unwrap_or_default();
    assert!(system.contains("Use the persisted agent policy."));
    assert!(system.contains("Always cite the persisted policy evidence."));
}

#[tokio::test]
async fn agent_workspace_catalog_stays_platform_wide_inside_a_restricted_agent_run() {
    let hub = test_hub(vec![
        MockTurn {
            text: "Inspect the platform catalog.".into(),
            tool_calls: vec![(
                "catalog-call".into(),
                "list_agent_workspace_catalog".into(),
                serde_json::json!({}),
            )],
            stream_in_chunks: false,
        },
        MockTurn {
            text: "Catalog inspected.".into(),
            tool_calls: vec![],
            stream_in_chunks: false,
        },
    ])
    .await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    dispatch(
        &hub,
        &ctx,
        method::AGENT_SAVE,
        serde_json::json!({
            "agent": {
                "id": "catalog-only-agent",
                "name": "Catalog only",
                "systemPrompt": "Inspect available Agent Workspace choices.",
                "allowedTools": ["list_agent_workspace_catalog"]
            }
        }),
    )
    .await
    .unwrap();
    let conversation = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({
            "title": "Catalog policy E2E",
            "agentId": "catalog-only-agent"
        }),
    )
    .await
    .unwrap();
    let mut events = hub.event_tx.subscribe();
    let result = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({
            "conversationId": conversation["id"],
            "text": "List choices."
        }),
    )
    .await
    .unwrap();
    let stream_id = result["streamId"].as_str().unwrap();
    let mut catalog = None;
    loop {
        let frame = events.recv().await.unwrap();
        if frame.stream_id != stream_id {
            continue;
        }
        if let EventKind::ToolResult { name, content, .. } = &frame.kind {
            if name == "list_agent_workspace_catalog" {
                catalog = Some(serde_json::from_str::<serde_json::Value>(content).unwrap());
            }
        }
        if matches!(frame.kind, EventKind::Done { .. } | EventKind::Error { .. }) {
            break;
        }
    }

    let catalog = catalog.expect("catalog tool should complete");
    let names = catalog["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();
    assert!(names.contains(&"list_agent_workspace_catalog"));
    assert!(names.contains(&"read_file"));
    assert!(names.contains(&"execute_command"));
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
async fn abort_interrupts_provider_setup_and_stalled_stream_reads() {
    for stage in [
        BlockingProviderStage::BeforeStream,
        BlockingProviderStage::DuringStream,
    ] {
        let hub = test_hub(vec![]).await;
        let started = Arc::new(tokio::sync::Notify::new());
        hub.set_custom_provider(Arc::new(BlockingProvider {
            stage,
            started: started.clone(),
        }));
        let ctx = ConnectionContext::new(Capabilities::desktop());
        let mut events = hub.event_tx.subscribe();
        let conv = dispatch(
            &hub,
            &ctx,
            method::CONVERSATION_CREATE,
            serde_json::json!({"title": "Abort provider wait"}),
        )
        .await
        .unwrap();
        let run = dispatch(
            &hub,
            &ctx,
            method::CHAT_SEND,
            serde_json::json!({
                "conversationId": conv["id"],
                "text": "Wait indefinitely."
            }),
        )
        .await
        .unwrap();
        let stream_id = run["streamId"].as_str().unwrap().to_string();

        tokio::time::timeout(std::time::Duration::from_secs(2), started.notified())
            .await
            .expect("provider did not enter the blocking stage");
        let aborted = dispatch(
            &hub,
            &ctx,
            method::CHAT_ABORT,
            serde_json::json!({"streamId": stream_id}),
        )
        .await
        .unwrap();
        assert_eq!(aborted["aborted"], 1);

        let stop_reason = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let frame = events.recv().await.unwrap();
                if frame.stream_id != stream_id {
                    continue;
                }
                if let EventKind::Done { stop_reason } = frame.kind {
                    break stop_reason;
                }
            }
        })
        .await
        .expect("provider wait did not terminate promptly after abort");
        assert_eq!(stop_reason, "aborted");
    }
}

#[tokio::test]
async fn abort_during_permission_wait_prevents_a_late_allow_from_executing() {
    let marker = "must-not-be-written-after-abort.txt";
    let script = vec![MockTurn {
        text: "Request a protected write.".into(),
        tool_calls: vec![(
            "protected-write".into(),
            "write_file".into(),
            serde_json::json!({ "path": marker, "content": "too late" }),
        )],
        stream_in_chunks: false,
    }];
    let hub = test_hub(script).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let mut events = hub.event_tx.subscribe();
    let conv = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({"title": "Abort permission request"}),
    )
    .await
    .unwrap();
    let started = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({
            "conversationId": conv["id"],
            "text": "Write the marker file."
        }),
    )
    .await
    .unwrap();
    let stream_id = started["streamId"].as_str().unwrap().to_string();

    let request_id = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let frame = events.recv().await.unwrap();
            if frame.stream_id != stream_id {
                continue;
            }
            if let EventKind::PermissionRequest {
                request_id,
                tool_name,
                ..
            } = frame.kind
            {
                assert_eq!(tool_name, "write_file");
                break request_id;
            }
        }
    })
    .await
    .expect("permission request was not emitted");

    let aborted = dispatch(
        &hub,
        &ctx,
        method::CHAT_ABORT,
        serde_json::json!({"streamId": stream_id}),
    )
    .await
    .unwrap();
    assert_eq!(aborted["aborted"], 1);

    // Race a stale UI callback against cancellation. Whether the callback
    // reaches the oneshot or observes its removal, it must never authorize
    // execution once the run's token has been cancelled.
    let _ = dispatch(
        &hub,
        &ctx,
        method::CHAT_RESPOND,
        serde_json::json!({ "requestId": request_id, "allow": true }),
    )
    .await
    .unwrap();

    let stop_reason = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let frame = events.recv().await.unwrap();
            if frame.stream_id != stream_id {
                continue;
            }
            if let EventKind::Done { stop_reason } = frame.kind {
                break stop_reason;
            }
        }
    })
    .await
    .expect("permission wait did not terminate promptly after abort");
    assert_eq!(stop_reason, "aborted");
    assert!(!hub.workspace.join(marker).exists());
    assert!(hub.pending_permissions.lock().unwrap().is_empty());

    let stale = dispatch(
        &hub,
        &ctx,
        method::CHAT_RESPOND,
        serde_json::json!({ "requestId": request_id, "allow": true }),
    )
    .await
    .unwrap();
    assert_eq!(stale["delivered"], false);
}

#[tokio::test]
async fn malformed_provider_tool_arguments_return_an_error_to_the_model() {
    let hub = test_hub(vec![]).await;
    hub.set_custom_provider(Arc::new(RepairingInvalidToolProvider::default()));
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let mut events = hub.event_tx.subscribe();
    let conv = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({"title": "Repair malformed arguments"}),
    )
    .await
    .unwrap();
    let started = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({
            "conversationId": conv["id"],
            "text": "Read a file."
        }),
    )
    .await
    .unwrap();
    let stream_id = started["streamId"].as_str().unwrap().to_string();

    let mut saw_tool_error = false;
    let mut recovered = false;
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let frame = events.recv().await.unwrap();
            if frame.stream_id != stream_id {
                continue;
            }
            match frame.kind {
                EventKind::ToolResult {
                    name,
                    content,
                    is_error,
                    ..
                } if name == "read_file" => {
                    saw_tool_error = is_error && content.contains("invalid JSON arguments");
                }
                EventKind::AssistantMessage { content, .. } => {
                    recovered |= content.contains("Recovered after the tool error");
                }
                EventKind::Done { .. } => break,
                EventKind::Error { message } => {
                    panic!("run terminated instead of repairing: {message}")
                }
                _ => {}
            }
        }
    })
    .await
    .expect("repairing provider run did not finish");

    assert!(saw_tool_error);
    assert!(recovered);
}

#[tokio::test]
async fn aborting_electron_host_override_releases_the_pending_request() {
    let script = vec![MockTurn {
        text: "Wait for Electron.".into(),
        tool_calls: vec![(
            "call-host-abort".into(),
            "slow_host_tool".into(),
            serde_json::json!({"delay": "long"}),
        )],
        stream_in_chunks: false,
    }];
    let hub = test_hub(script).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let mut events = hub.event_tx.subscribe();
    let conv = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_CREATE,
        serde_json::json!({"title": "Abort Electron host override"}),
    )
    .await
    .unwrap();

    let started = dispatch(
        &hub,
        &ctx,
        method::CHAT_SEND,
        serde_json::json!({
            "conversationId": conv["id"],
            "text": "Call the slow host tool.",
            "customTools": [{
                "name": "slow_host_tool",
                "description": "Waits in the Electron host.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"delay": {"type": "string"}}
                },
                "domain": "electron_host_override",
                "permission": "allow"
            }]
        }),
    )
    .await
    .unwrap();
    let stream_id = started["streamId"].as_str().unwrap().to_string();

    let request_id = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let frame = events.recv().await.unwrap();
            if frame.stream_id != stream_id {
                continue;
            }
            if let EventKind::HostRequest {
                request_id,
                request_kind,
                ..
            } = frame.kind
            {
                assert_eq!(request_kind, "tool.execute");
                break request_id;
            }
        }
    })
    .await
    .expect("host request was not emitted");
    assert!(hub
        .pending_host_requests
        .lock()
        .unwrap()
        .contains_key(&request_id));

    let aborted = dispatch(
        &hub,
        &ctx,
        method::CHAT_ABORT,
        serde_json::json!({"streamId": stream_id}),
    )
    .await
    .unwrap();
    assert_eq!(aborted["aborted"], 1);

    let stop_reason = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        loop {
            let frame = events.recv().await.unwrap();
            if frame.stream_id != stream_id {
                continue;
            }
            if let EventKind::Done { stop_reason } = frame.kind {
                break stop_reason;
            }
        }
    })
    .await
    .expect("aborted host request did not terminate promptly");
    assert_eq!(stop_reason, "aborted");
    assert!(hub.pending_host_requests.lock().unwrap().is_empty());
    assert!(!hub.host_respond(&request_id, serde_json::json!({"late": true})));
}

#[tokio::test]
async fn aborting_builtin_host_tools_releases_ask_user_and_page_requests() {
    let cases = vec![
        (
            "ask_user",
            serde_json::json!({
                "questions": [{ "question": "Continue?", "options": ["Yes", "No"] }]
            }),
            "ask_user",
        ),
        (
            "read_current_page",
            serde_json::json!({ "max_chars": 400 }),
            "page_automation",
        ),
    ];

    for (tool_name, input, expected_request_kind) in cases {
        let hub = test_hub(vec![MockTurn {
            text: format!("Wait for built-in host tool {tool_name}."),
            tool_calls: vec![(format!("call-{tool_name}"), tool_name.into(), input)],
            stream_in_chunks: false,
        }])
        .await;
        let ctx = ConnectionContext::new(Capabilities::desktop());
        let mut events = hub.event_tx.subscribe();
        let conv = dispatch(
            &hub,
            &ctx,
            method::CONVERSATION_CREATE,
            serde_json::json!({"title": format!("Abort {tool_name}")}),
        )
        .await
        .unwrap();
        let started = dispatch(
            &hub,
            &ctx,
            method::CHAT_SEND,
            serde_json::json!({
                "conversationId": conv["id"],
                "text": format!("Call {tool_name} and wait.")
            }),
        )
        .await
        .unwrap();
        let stream_id = started["streamId"].as_str().unwrap().to_string();

        let request_id = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let frame = events.recv().await.unwrap();
                if frame.stream_id != stream_id {
                    continue;
                }
                if let EventKind::HostRequest {
                    request_id,
                    request_kind,
                    ..
                } = frame.kind
                {
                    assert_eq!(request_kind, expected_request_kind);
                    break request_id;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{tool_name} host request was not emitted"));

        let aborted = dispatch(
            &hub,
            &ctx,
            method::CHAT_ABORT,
            serde_json::json!({"streamId": stream_id}),
        )
        .await
        .unwrap();
        assert_eq!(aborted["aborted"], 1);

        let stop_reason = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let frame = events.recv().await.unwrap();
                if frame.stream_id != stream_id {
                    continue;
                }
                if let EventKind::Done { stop_reason } = frame.kind {
                    break stop_reason;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{tool_name} did not terminate promptly after abort"));
        assert_eq!(stop_reason, "aborted");
        assert!(hub.pending_host_requests.lock().unwrap().is_empty());
        assert!(!hub.host_respond(&request_id, serde_json::json!({"late": true})));
    }
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
async fn authoritative_conversation_sync_replaces_branches_and_allows_empty_reset() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let conv_id = "authoritative-host-conversation";

    let first = serde_json::json!({
        "id": conv_id,
        "authoritative": true,
        "messages": [
            { "role": "user", "content": "original question" },
            {
                "role": "assistant",
                "content": "using a tool",
                "toolCalls": [{
                    "id": "call-1",
                    "name": "read_file",
                    "args": { "path": "old.txt" }
                }]
            },
            {
                "role": "user",
                "content": "",
                "toolResults": [{
                    "toolCallId": "call-1",
                    "name": "read_file",
                    "content": "old contents",
                    "isError": false
                }]
            }
        ]
    });
    let result = dispatch(&hub, &ctx, method::CONVERSATION_SYNC, first)
        .await
        .unwrap();
    assert_eq!(result["synced"], true);
    assert_eq!(result["authoritative"], true);
    assert_eq!(result["messageCount"], 3);

    let branch = serde_json::json!({
        "id": conv_id,
        "authoritative": true,
        "messages": [
            { "role": "user", "content": "edited question" },
            { "role": "assistant", "content": "edited answer" }
        ]
    });
    dispatch(&hub, &ctx, method::CONVERSATION_SYNC, branch)
        .await
        .unwrap();
    let messages = hub.store.list_messages(conv_id, 100).unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].content, "edited question");
    assert_eq!(messages[1].content, "edited answer");
    assert!(messages
        .iter()
        .all(|message| { message.tool_calls.is_empty() && message.tool_results.is_empty() }));

    let reset = dispatch(
        &hub,
        &ctx,
        method::CONVERSATION_SYNC,
        serde_json::json!({
            "id": conv_id,
            "authoritative": true,
            "messages": []
        }),
    )
    .await
    .unwrap();
    assert_eq!(reset["messageCount"], 0);
    assert!(hub.store.list_messages(conv_id, 100).unwrap().is_empty());
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
async fn direct_agent_workspace_catalog_uses_the_connections_mobile_tool_surface() {
    let hub = test_hub(vec![]).await;
    let mobile = ConnectionContext::new(Capabilities::mobile("mobile-ios"));

    let catalog = dispatch(
        &hub,
        &mobile,
        method::TOOL_CALL,
        serde_json::json!({
            "name": "list_agent_workspace_catalog",
            "args": {}
        }),
    )
    .await
    .unwrap();
    let tool_names = catalog["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();
    assert!(tool_names.contains(&"read_file"));
    assert!(tool_names.contains(&"ask_user"));
    assert!(!tool_names.contains(&"read_project_file"));
    assert!(!tool_names.contains(&"execute_command"));
}

#[tokio::test]
async fn direct_tool_call_accepts_legacy_argument_aliases() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let root = hub.workspace.join("alias-test.txt");
    std::fs::write(&root, "alias works").unwrap();

    for params in [
        serde_json::json!({
            "toolName": "read_file",
            "arguments": {"path": "alias-test.txt"}
        }),
        serde_json::json!({
            "tool_name": "read_file",
            "input": {"path": "alias-test.txt"}
        }),
        serde_json::json!({
            "tool": "read_file",
            "arguments": "{\"path\":\"alias-test.txt\"}"
        }),
        serde_json::json!({
            "name": "  ",
            "toolName": " read_file ",
            "parameters": {"path": "alias-test.txt"}
        }),
    ] {
        let result = dispatch(&hub, &ctx, method::TOOL_CALL, params)
            .await
            .unwrap();
        assert_eq!(result["path"], "alias-test.txt");
        assert_eq!(result["content"], "alias works");
    }
}

#[tokio::test]
async fn direct_tool_call_rejects_non_object_arguments() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let error = dispatch(
        &hub,
        &ctx,
        method::TOOL_CALL,
        serde_json::json!({"name": "read_file", "arguments": ["bad"]}),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("tool arguments must be an object"));
}

#[tokio::test]
async fn direct_mcp_call_accepts_aliases_trims_names_and_forwards_arguments() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let observed_calls = Arc::new(std::sync::Mutex::new(Vec::new()));
    let server_calls = observed_calls.clone();
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_json_request(&mut socket).await;
            let method = request["method"].as_str().unwrap();
            let (result, all_calls_observed) = match method {
                "initialize" => (
                    serde_json::json!({
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "serverInfo": { "name": "alias-test", "version": "1" }
                    }),
                    false,
                ),
                "notifications/initialized" => (serde_json::json!({}), false),
                "tools/call" => {
                    let params = request["params"].clone();
                    let all_calls_observed = {
                        let mut calls = server_calls.lock().unwrap();
                        calls.push(params.clone());
                        calls.len() == 4
                    };
                    (
                        serde_json::json!({ "received": params }),
                        all_calls_observed,
                    )
                }
                other => panic!("unexpected MCP method: {other}"),
            };
            write_http_json_response(
                &mut socket,
                request
                    .get("id")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                result,
            )
            .await;
            if all_calls_observed {
                break;
            }
        }
    });

    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    dispatch(
        &hub,
        &ctx,
        method::MCP_RELOAD,
        serde_json::json!({
            "servers": [{
                "name": "alias-server",
                "displayName": "Alias server",
                "enabled": true,
                "transport": "http",
                "target": format!("http://{address}"),
                "args": [],
                "env": {},
                "headers": {}
            }]
        }),
    )
    .await
    .unwrap();

    let cases = [
        (
            serde_json::json!({
                "server": "   ",
                "serverId": " alias-server ",
                "tool": "\t",
                "toolName": " camel-tool ",
                "args": { "source": "args" }
            }),
            "camel-tool",
            serde_json::json!({ "source": "args" }),
        ),
        (
            serde_json::json!({
                "server_id": " alias-server ",
                "tool_name": " snake-tool ",
                "arguments": { "source": "arguments" }
            }),
            "snake-tool",
            serde_json::json!({ "source": "arguments" }),
        ),
        (
            serde_json::json!({
                "server": " alias-server ",
                "name": " named-tool ",
                "input": { "source": "input" }
            }),
            "named-tool",
            serde_json::json!({ "source": "input" }),
        ),
        (
            serde_json::json!({
                "server": " alias-server ",
                "tool": " canonical-tool ",
                "parameters": { "source": "parameters" }
            }),
            "canonical-tool",
            serde_json::json!({ "source": "parameters" }),
        ),
    ];

    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        for (params, expected_tool, expected_arguments) in cases {
            let result = dispatch(&hub, &ctx, method::MCP_CALL, params)
                .await
                .unwrap();
            assert_eq!(result["received"]["name"], expected_tool);
            assert_eq!(result["received"]["arguments"], expected_arguments);
        }
    })
    .await
    .expect("direct MCP alias calls did not finish promptly");

    tokio::time::timeout(std::time::Duration::from_secs(5), server)
        .await
        .expect("mock MCP server did not receive every request")
        .unwrap();
    assert_eq!(observed_calls.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn direct_mcp_call_rejects_every_non_object_argument_alias() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());

    for alias in ["args", "arguments", "input", "parameters"] {
        let mut params = serde_json::json!({
            "server": "unconfigured",
            "tool": "remote-tool"
        });
        params.as_object_mut().unwrap().insert(
            alias.to_string(),
            serde_json::json!(["not", "an", "object"]),
        );

        let error = dispatch(&hub, &ctx, method::MCP_CALL, params)
            .await
            .unwrap_err();
        assert_eq!(error.code, INVALID_PARAMS, "argument alias: {alias}");
        assert!(
            error.message.contains("MCP arguments must be an object"),
            "argument alias: {alias}; error: {}",
            error.message
        );
    }
}

#[tokio::test]
async fn repeated_direct_tool_permissions_keep_monotonic_event_sequences() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    dispatch(
        &hub,
        &ctx,
        method::SETTINGS_SET,
        serde_json::json!({
            "key": "permissions",
            "value": {"read_file": "ask"}
        }),
    )
    .await
    .unwrap();
    let mut events = hub.event_tx.subscribe();
    let mut sequences = Vec::new();

    for _ in 0..2 {
        let call = dispatch(
            &hub,
            &ctx,
            method::TOOL_CALL,
            serde_json::json!({
                "name": "read_file",
                "args": {"path": "notes.txt"}
            }),
        );
        tokio::pin!(call);
        let (request_id, seq, stream_id) = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            async {
                loop {
                    tokio::select! {
                        result = &mut call => panic!("tool.call completed before permission response: {result:?}"),
                        event = events.recv() => {
                            let frame = event.unwrap();
                            if let EventKind::PermissionRequest { request_id, .. } = frame.kind {
                                break (request_id, frame.seq, frame.stream_id);
                            }
                        }
                    }
                }
            },
        )
        .await
        .expect("permission event should arrive");
        sequences.push(seq);
        assert_eq!(stream_id, "tool-call");
        dispatch(
            &hub,
            &ctx,
            method::CHAT_RESPOND,
            serde_json::json!({"requestId": request_id, "allow": true}),
        )
        .await
        .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), &mut call)
            .await
            .expect("allowed direct tool call should finish")
            .unwrap();
    }

    assert!(sequences[1] > sequences[0], "sequences: {sequences:?}");
}

#[tokio::test]
async fn repeated_direct_ask_user_requests_keep_monotonic_event_sequences() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let mut events = hub.event_tx.subscribe();
    let mut sequences = Vec::new();

    for index in 0..2 {
        let call = dispatch(
            &hub,
            &ctx,
            method::TOOL_CALL,
            serde_json::json!({
                "name": "ask_user",
                "args": {
                    "questions": [{
                        "question": format!("Continue {index}?"),
                        "options": ["Yes", "No"]
                    }]
                }
            }),
        );
        tokio::pin!(call);
        let (request_id, seq, stream_id) = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            async {
                loop {
                    tokio::select! {
                        result = &mut call => panic!("ask_user completed before host response: {result:?}"),
                        event = events.recv() => {
                            let frame = event.unwrap();
                            if let EventKind::HostRequest { request_id, request_kind, .. } = frame.kind {
                                if request_kind == "ask_user" {
                                    break (request_id, frame.seq, frame.stream_id);
                                }
                            }
                        }
                    }
                }
            },
        )
        .await
        .expect("host request should arrive");
        sequences.push(seq);
        assert_eq!(stream_id, "tool-call");
        dispatch(
            &hub,
            &ctx,
            method::HOST_RESPOND,
            serde_json::json!({
                "requestId": request_id,
                "result": {"answers": [{"answer": "Yes"}]}
            }),
        )
        .await
        .unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), &mut call)
            .await
            .expect("answered ask_user should finish")
            .unwrap();
        assert_eq!(result["answers"][0]["answer"], "Yes");
    }

    assert!(sequences[1] > sequences[0], "sequences: {sequences:?}");
}

#[tokio::test]
async fn host_respond_accepts_snake_case_request_id_alias() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let mut events = hub.event_tx.subscribe();
    let host_call = tokio::spawn({
        let hub = hub.clone();
        async move {
            hub.host_request(
                "tool-call",
                "ask_user",
                serde_json::json!({
                    "questions": [{
                        "id": "q_1",
                        "question": "Continue?",
                        "options": ["Yes", "No"]
                    }]
                }),
                std::time::Duration::from_secs(2),
            )
            .await
        }
    });

    let request_id = loop {
        let frame = events.recv().await.unwrap();
        if let EventKind::HostRequest {
            request_id,
            request_kind,
            ..
        } = frame.kind
        {
            if request_kind == "ask_user" {
                break request_id;
            }
        }
    };

    let response = dispatch(
        &hub,
        &ctx,
        method::HOST_RESPOND,
        serde_json::json!({
            "request_id": request_id,
            "result": {"answers": [{"id": "q_1", "answer": "Yes"}]}
        }),
    )
    .await
    .expect("snake_case host response should be accepted");
    assert_eq!(response["delivered"], true);
    assert_eq!(
        host_call.await.unwrap().unwrap()["answers"][0]["answer"],
        "Yes"
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

    let saved_skill = dispatch(
        &hub,
        &ctx,
        method::SKILL_SAVE,
        serde_json::json!({
            "name": "release / helper",
            "description": "Prepare releases",
            "instructions": "Ship ${channel}.",
            "whenToUse": "When publishing",
            "arguments": [{
                "name": "channel",
                "description": "Release channel",
                "required": true
            }],
            "allowedTools": ["read_file", "read_file"],
            "context": "fork"
        }),
    )
    .await
    .unwrap();
    assert_eq!(saved_skill["name"], "release-helper");
    assert_eq!(saved_skill["skill"]["whenToUse"], "When publishing");
    assert_eq!(
        saved_skill["skill"]["allowedTools"],
        serde_json::json!(["read_file"])
    );
    let listed_skill = dispatch(&hub, &ctx, method::SKILL_LIST, serde_json::json!({}))
        .await
        .unwrap();
    assert!(listed_skill["skills"]
        .as_array()
        .unwrap()
        .iter()
        .any(|skill| skill["name"] == "release-helper"));
    let rendered_skill = dispatch(
        &hub,
        &ctx,
        method::SKILL_RUN,
        serde_json::json!({
            "name": "release-helper",
            "arguments": {"channel": "stable"}
        }),
    )
    .await
    .unwrap();
    assert_eq!(rendered_skill["context"], "fork");
    assert_eq!(rendered_skill["instructions"], "Ship stable.");
    dispatch(
        &hub,
        &ctx,
        method::SKILL_DELETE,
        serde_json::json!({"name": "release-helper"}),
    )
    .await
    .unwrap();

    let sched = dispatch(
        &hub,
        &ctx,
        method::SCHEDULE_CREATE,
        serde_json::json!({"name": "早报", "cron": "0 9 * * 1-5", "task": "汇总"}),
    )
    .await
    .unwrap();
    assert!(sched["entry"]["id"].as_str().is_some());

    let structured = dispatch(
        &hub,
        &ctx,
        method::SCHEDULE_CREATE,
        serde_json::json!({
            "title": "结构化早报",
            "prompt": "汇总项目风险",
            "enabled": false,
            "schedule": {"kind": "interval", "everyMinutes": 30},
            "selectedSkillIds": ["research"],
            "selectedMcpServerIds": ["notion"],
            "retryPolicy": {"maxRetries": 2, "retryDelayMinutes": 7},
            "createdBy": "ai"
        }),
    )
    .await
    .unwrap();
    assert_eq!(structured["entry"]["name"], "结构化早报");
    assert_eq!(structured["entry"]["schedule"]["kind"], "interval");
    assert_eq!(structured["entry"]["retryPolicy"]["maxRetries"], 2);
    assert_eq!(structured["task"]["title"], "结构化早报");
    assert_eq!(structured["task"]["prompt"], "汇总项目风险");

    let list = dispatch(&hub, &ctx, method::SCHEDULE_LIST, serde_json::json!({}))
        .await
        .unwrap();
    assert_eq!(list["schedules"].as_array().unwrap().len(), 2);
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
async fn document_open_original_delegates_to_host_bridge() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());

    dispatch(
        &hub,
        &ctx,
        method::DOC_WRITE,
        serde_json::json!({
            "path": "open-original.docx",
            "kind": "docx",
            "blocks": [{"type": "paragraph", "text": "Open me"}]
        }),
    )
    .await
    .unwrap();
    let imported = dispatch(
        &hub,
        &ctx,
        method::DOC_IMPORT,
        serde_json::json!({"path": "open-original.docx"}),
    )
    .await
    .unwrap();
    let artifact_id = imported["artifact"]["id"].as_str().unwrap().to_string();
    let mut events = hub.event_tx.subscribe();
    let open_hub = hub.clone();
    let open = tokio::spawn(async move {
        let open_ctx = ConnectionContext::new(Capabilities::desktop());
        dispatch(
            &open_hub,
            &open_ctx,
            method::DOC_OPEN_ORIGINAL,
            serde_json::json!({"artifactId": artifact_id}),
        )
        .await
        .unwrap()
    });

    let request_id = loop {
        let frame = events.recv().await.unwrap();
        if let EventKind::HostRequest {
            request_id,
            request_kind,
            payload,
        } = frame.kind
        {
            assert_eq!(request_kind, "document.openOriginal");
            assert!(payload["filePath"]
                .as_str()
                .unwrap()
                .ends_with("/open-original.docx"));
            break request_id;
        }
    };
    assert!(hub.host_respond(
        &request_id,
        serde_json::json!({"success": true, "supported": true}),
    ));
    assert_eq!(open.await.unwrap()["success"], true);
    // Direct RPCs use an ephemeral stream only to publish the host callback;
    // it must not accumulate in the resume registry after the request ends.
    assert!(hub.streams.lock().unwrap().is_empty());
}

#[tokio::test]
async fn document_preview_ensure_persists_host_render_bytes_for_docx() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    dispatch(
        &hub,
        &ctx,
        method::DOC_WRITE,
        serde_json::json!({
            "path": "host-preview.docx",
            "kind": "docx",
            "blocks": [{"type": "paragraph", "text": "Preview me"}]
        }),
    )
    .await
    .unwrap();
    let imported = dispatch(
        &hub,
        &ctx,
        method::DOC_IMPORT,
        serde_json::json!({"path": "host-preview.docx"}),
    )
    .await
    .unwrap();
    let artifact_id = imported["artifact"]["id"].as_str().unwrap().to_string();
    let mut events = hub.event_tx.subscribe();
    let preview_hub = hub.clone();
    let preview_id = artifact_id.clone();
    let preview = tokio::spawn(async move {
        let preview_ctx = ConnectionContext::new(Capabilities::desktop());
        dispatch(
            &preview_hub,
            &preview_ctx,
            method::DOC_PREVIEW_ENSURE,
            serde_json::json!({"artifactId": preview_id}),
        )
        .await
        .unwrap()
    });

    let request_id = loop {
        let frame = events.recv().await.unwrap();
        if let EventKind::HostRequest {
            request_id,
            request_kind,
            payload,
        } = frame.kind
        {
            assert_eq!(request_kind, "document.preview.ensure");
            assert_eq!(payload["fileType"], "docx");
            break request_id;
        }
    };
    let html = b"<!doctype html><p>host preview</p>";
    assert!(hub.host_respond(
        &request_id,
        serde_json::json!({
            "render": {
                "kind": "html",
                "source": "generated",
                "status": "ready",
                "mimeType": "text/html; charset=utf-8"
            },
            "bytes": html.to_vec()
        }),
    ));
    let artifact = preview.await.unwrap();
    assert_eq!(artifact["render"]["kind"], "html");
    let data = dispatch(
        &hub,
        &ctx,
        method::DOC_PREVIEW_READ,
        serde_json::json!({"artifactId": artifact_id}),
    )
    .await
    .unwrap();
    assert_eq!(data["mimeType"], "text/html; charset=utf-8");
    assert_eq!(data["bytes"].as_array().unwrap().len(), html.len());

    // A ready DOCX render is durable. A subsequent workbench refresh should
    // return the cached artifact without emitting another host request.
    let mut cached_events = hub.event_tx.subscribe();
    let cached = dispatch(
        &hub,
        &ctx,
        method::DOC_PREVIEW_ENSURE,
        serde_json::json!({"artifactId": artifact_id}),
    )
    .await
    .unwrap();
    assert_eq!(cached["render"]["kind"], "html");
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(100), cached_events.recv(),)
            .await
            .is_err()
    );

    // A copied workspace or manual cache cleanup can leave a ready descriptor
    // without its bytes. The next ensure must regenerate through the host
    // instead of returning a stale ready artifact.
    let public_asset_path = cached["render"]["assetPath"].as_str().unwrap();
    assert!(!std::path::Path::new(public_asset_path).is_absolute());
    assert!(!cached
        .to_string()
        .contains(&hub.workspace.to_string_lossy().to_string()));
    let internal = worldbase_tools::document_artifacts::get_document(&hub.workspace, &artifact_id)
        .unwrap()
        .expect("persisted preview artifact");
    let internal_asset_path = internal.render.as_ref().unwrap()["assetPath"]
        .as_str()
        .unwrap();
    assert!(std::path::Path::new(internal_asset_path).is_absolute());
    assert_eq!(
        hub.workspace.join(public_asset_path),
        std::path::PathBuf::from(internal_asset_path)
    );
    std::fs::remove_file(internal_asset_path).unwrap();
    let mut stale_events = hub.event_tx.subscribe();
    let stale_hub = hub.clone();
    let stale_id = artifact_id.clone();
    let stale = tokio::spawn(async move {
        let stale_ctx = ConnectionContext::new(Capabilities::desktop());
        dispatch(
            &stale_hub,
            &stale_ctx,
            method::DOC_PREVIEW_ENSURE,
            serde_json::json!({"artifactId": stale_id}),
        )
        .await
        .unwrap()
    });
    let request_id = loop {
        let frame = stale_events.recv().await.unwrap();
        if let EventKind::HostRequest {
            request_id,
            request_kind,
            ..
        } = frame.kind
        {
            assert_eq!(request_kind, "document.preview.ensure");
            break request_id;
        }
    };
    assert!(hub.host_respond(
        &request_id,
        serde_json::json!({
            "render": {
                "kind": "html",
                "source": "generated",
                "status": "ready",
                "mimeType": "text/html; charset=utf-8"
            },
            "bytes": html.to_vec()
        }),
    ));
    assert_eq!(stale.await.unwrap()["render"]["status"], "ready");
    assert!(hub.streams.lock().unwrap().is_empty());
}

#[tokio::test]
async fn document_import_enforces_relative_workspace_boundary_and_input_limits() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let workspace = hub.workspace.clone();
    let outside = workspace
        .parent()
        .unwrap()
        .join(format!("outside-{}.md", uuid::Uuid::new_v4()));
    std::fs::write(&outside, "outside document").unwrap();

    // Relative paths are scoped to the selected workspace, so traversal must
    // not turn doc.import into an arbitrary local file reader.
    let traversal = dispatch(
        &hub,
        &ctx,
        method::DOC_IMPORT,
        serde_json::json!({ "path": format!("../{}", outside.file_name().unwrap().to_string_lossy()) }),
    )
    .await
    .unwrap_err();
    assert_eq!(traversal.code, INVALID_PARAMS);
    assert!(traversal.message.contains("escapes workspace"));

    // An explicit absolute path remains supported, matching Electron's file
    // picker, which can select documents outside the active workspace.
    let imported = dispatch(
        &hub,
        &ctx,
        method::DOC_IMPORT,
        serde_json::json!({ "path": outside }),
    )
    .await
    .unwrap();
    assert_eq!(
        imported["artifact"]["fileName"],
        outside.file_name().unwrap().to_string_lossy().to_string()
    );
    let artifact_id = imported["artifact"]["id"].as_str().unwrap();
    let public_file_path = imported["artifact"]["filePath"].as_str().unwrap();
    assert_eq!(
        public_file_path,
        outside.file_name().unwrap().to_string_lossy().to_string()
    );
    assert!(!std::path::Path::new(public_file_path).is_absolute());
    assert!(!imported
        .to_string()
        .contains(&workspace.to_string_lossy().to_string()));

    let fetched = dispatch(
        &hub,
        &ctx,
        method::DOC_GET,
        serde_json::json!({ "artifactId": artifact_id }),
    )
    .await
    .unwrap();
    assert_eq!(fetched["filePath"], public_file_path);
    let listed = dispatch(&hub, &ctx, method::DOC_LIST, serde_json::json!({}))
        .await
        .unwrap();
    let listed_artifact = listed["documents"]
        .as_array()
        .unwrap()
        .iter()
        .find(|artifact| artifact["id"] == artifact_id)
        .expect("imported artifact in doc.list");
    assert_eq!(listed_artifact["filePath"], public_file_path);

    let internal = worldbase_tools::document_artifacts::get_document(&workspace, artifact_id)
        .unwrap()
        .expect("persisted external artifact");
    assert_eq!(
        std::path::Path::new(&internal.file_path),
        &outside.canonicalize().unwrap()
    );

    let directory = workspace.join("document-directory.md");
    std::fs::create_dir_all(&directory).unwrap();
    let directory_error = dispatch(
        &hub,
        &ctx,
        method::DOC_IMPORT,
        serde_json::json!({ "path": "document-directory.md" }),
    )
    .await
    .unwrap_err();
    assert_eq!(directory_error.code, INVALID_PARAMS);
    assert!(directory_error.message.contains("not a file"));

    let unsupported = workspace.join("unsupported.bin");
    std::fs::write(&unsupported, b"binary").unwrap();
    let unsupported_error = dispatch(
        &hub,
        &ctx,
        method::DOC_IMPORT,
        serde_json::json!({ "path": "unsupported.bin" }),
    )
    .await
    .unwrap_err();
    assert_eq!(unsupported_error.code, INVALID_PARAMS);
    assert!(unsupported_error
        .message
        .contains("unsupported document extension"));

    let oversized = workspace.join("oversized.txt");
    let file = std::fs::File::create(&oversized).unwrap();
    file.set_len(worldbase_tools::document_artifacts::MAX_DOCUMENT_BYTES + 1)
        .unwrap();
    let oversized_error = dispatch(
        &hub,
        &ctx,
        method::DOC_IMPORT,
        serde_json::json!({ "path": "oversized.txt" }),
    )
    .await
    .unwrap_err();
    assert_eq!(oversized_error.code, INVALID_PARAMS);
    assert!(oversized_error.message.contains("too large"));

    let _ = std::fs::remove_file(outside);
}

#[cfg(unix)]
#[tokio::test]
async fn document_import_rejects_symlink_parent_escape() {
    use std::os::unix::fs::symlink;

    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::desktop());
    let outside_dir = std::env::temp_dir().join(format!("doc-escape-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&outside_dir).unwrap();
    let outside_file = outside_dir.join("escaped.md");
    std::fs::write(&outside_file, "escaped").unwrap();
    let link = hub.workspace.join("linked-documents");
    symlink(&outside_dir, &link).unwrap();

    let error = dispatch(
        &hub,
        &ctx,
        method::DOC_IMPORT,
        serde_json::json!({ "path": "linked-documents/escaped.md" }),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, INVALID_PARAMS);
    assert!(error.message.contains("escapes workspace"));
    let _ = std::fs::remove_dir_all(outside_dir);
}

#[tokio::test]
async fn document_selection_lifecycle_is_reachable_via_dispatcher() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::mobile("mobile-ios"));

    dispatch(
        &hub,
        &ctx,
        method::DOC_WRITE,
        serde_json::json!({
            "path": "selection.md",
            "kind": "markdown",
            "content": "第一段\n第二段"
        }),
    )
    .await
    .unwrap();
    let parsed = dispatch(
        &hub,
        &ctx,
        method::DOC_PARSE,
        serde_json::json!({"path": "selection.md"}),
    )
    .await
    .unwrap();
    let artifact_id = parsed["artifact_id"].as_str().unwrap();

    let created = dispatch(
        &hub,
        &ctx,
        method::DOC_SELECTION_CREATE,
        serde_json::json!({
            "artifact_id": artifact_id,
            "node_ids": [],
            "label": "重点",
            "color": "#ef4444",
            "excerpt": "第二段"
        }),
    )
    .await
    .unwrap();
    assert_eq!(created["artifactId"], artifact_id);
    assert_eq!(created["label"], "重点");
    let selection_id = created["id"].as_str().unwrap();

    let listed = dispatch(
        &hub,
        &ctx,
        method::DOC_SELECTION_LIST,
        serde_json::json!({"artifactId": artifact_id}),
    )
    .await
    .unwrap();
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], selection_id);

    let selected = dispatch(
        &hub,
        &ctx,
        method::TOOL_CALL,
        serde_json::json!({
            "name": "read_document",
            "args": {"artifact_id": artifact_id, "region_ids": [selection_id]}
        }),
    )
    .await
    .unwrap();
    assert_eq!(selected["selections"][0]["regionId"], selection_id);
    assert_eq!(selected["selections"][0]["text"], "第二段");

    let prompt = dispatch(
        &hub,
        &ctx,
        method::DOC_SELECTION_PROMPT,
        serde_json::json!({"region_ids": [selection_id]}),
    )
    .await
    .unwrap();
    assert_eq!(
        prompt,
        "【文档选区：selection.md — 重点】\n第二段\n【选区结束】"
    );
    let default_prompt = dispatch(
        &hub,
        &ctx,
        method::DOC_SELECTION_PROMPT,
        serde_json::json!({}),
    )
    .await
    .unwrap();
    assert_eq!(default_prompt, prompt);
    let empty_prompt = dispatch(
        &hub,
        &ctx,
        method::DOC_SELECTION_PROMPT,
        serde_json::json!({"regionIds": []}),
    )
    .await
    .unwrap();
    assert_eq!(empty_prompt, "");
    let unknown_prompt = dispatch(
        &hub,
        &ctx,
        method::DOC_SELECTION_PROMPT,
        serde_json::json!({"regionIds": ["missing-region"]}),
    )
    .await
    .unwrap();
    assert_eq!(unknown_prompt, "");
    let invalid_prompt = dispatch(
        &hub,
        &ctx,
        method::DOC_SELECTION_PROMPT,
        serde_json::json!({"regionIds": "not-an-array"}),
    )
    .await
    .unwrap_err();
    assert_eq!(invalid_prompt.code, -32602);

    let updated = dispatch(
        &hub,
        &ctx,
        method::DOC_SELECTION_UPDATE,
        serde_json::json!({"region_id": selection_id, "label": "已确认"}),
    )
    .await
    .unwrap();
    assert_eq!(updated["label"], "已确认");

    let removed = dispatch(
        &hub,
        &ctx,
        method::DOC_SELECTION_REMOVE,
        serde_json::json!({"id": selection_id}),
    )
    .await
    .unwrap();
    assert_eq!(removed, true);
    let listed_after_remove = dispatch(
        &hub,
        &ctx,
        method::DOC_SELECTION_LIST,
        serde_json::json!({"artifact_id": artifact_id}),
    )
    .await
    .unwrap();
    assert!(listed_after_remove.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn document_selection_rejects_wrong_types_without_alias_fallback() {
    let hub = test_hub(vec![]).await;
    let ctx = ConnectionContext::new(Capabilities::mobile("mobile-ios"));

    dispatch(
        &hub,
        &ctx,
        method::DOC_WRITE,
        serde_json::json!({
            "path": "selection-contract.md",
            "kind": "markdown",
            "content": "选区契约"
        }),
    )
    .await
    .unwrap();
    let parsed = dispatch(
        &hub,
        &ctx,
        method::DOC_PARSE,
        serde_json::json!({"path": "selection-contract.md"}),
    )
    .await
    .unwrap();
    let artifact_id = parsed["artifactId"].as_str().unwrap().to_string();

    let cases = [
        (
            method::DOC_SELECTION_LIST,
            serde_json::json!({
                "artifactId": 42,
                "artifact_id": artifact_id
            }),
        ),
        (
            method::DOC_SELECTION_CREATE,
            serde_json::json!({
                "artifactId": artifact_id,
                "nodeIds": ["node-1", 42],
                "excerpt": "选区契约"
            }),
        ),
        (
            method::DOC_SELECTION_CREATE,
            serde_json::json!({
                "artifactId": artifact_id,
                "nodeIds": [],
                "label": 42,
                "excerpt": "选区契约"
            }),
        ),
        (
            method::DOC_SELECTION_UPDATE,
            serde_json::json!({
                "id": 42,
                "region_id": "valid-fallback-id",
                "label": "新标签"
            }),
        ),
        (
            method::DOC_SELECTION_UPDATE,
            serde_json::json!({
                "id": "valid-id",
                "label": 42
            }),
        ),
        (
            method::DOC_SELECTION_REMOVE,
            serde_json::json!({
                "id": 42,
                "region_id": "valid-fallback-id"
            }),
        ),
        (
            method::DOC_SELECTION_PROMPT,
            serde_json::json!({"regionIds": ["valid-id", 42]}),
        ),
        (
            method::DOC_SELECTION_PROMPT,
            serde_json::json!({
                "regionIds": "not-an-array",
                "region_ids": []
            }),
        ),
    ];

    for (method_name, params) in cases {
        let error = dispatch(&hub, &ctx, method_name, params).await.unwrap_err();
        assert_eq!(
            error.code, INVALID_PARAMS,
            "{method_name} must reject malformed selection parameters"
        );
    }
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
