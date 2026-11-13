use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;
use worldbase_protocol::types::{
    Capabilities, ChatMessage, ConversationMeta, Role, ToolCallRecord, ToolResultRecord,
};
use worldbase_protocol::ToolVisibility;
use worldbase_tools::{
    builtin_tools, filter_tools, HostBridge, ReadTranscriptRangeTool, RecallContextTool,
    SearchTranscriptTool, Tool, ToolServices,
};

struct Fixture {
    temp: TempDir,
    services: ToolServices,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::Builder::new()
            .prefix("worldbase-context-tools-")
            .tempdir()
            .expect("create context-tools temp root");
        let workspace = temp.path().join("workspace");
        let projects = temp.path().join("projects");
        std::fs::create_dir_all(&workspace).expect("create context-tools workspace");
        std::fs::create_dir_all(&projects).expect("create context-tools projects root");
        let workspace = workspace
            .canonicalize()
            .expect("canonicalize context-tools workspace");

        let store = Arc::new(
            worldbase_memory::Store::open(&temp.path().join("store.sqlite"))
                .expect("open context-tools test store"),
        );
        let scheduler = Arc::new(worldbase_scheduler::Scheduler::new(store.clone()));
        let services = ToolServices {
            host: Arc::new(HostBridge::new()),
            current_stream: Arc::new(Mutex::new(String::new())),
            abort: None,
            workspace: workspace.clone(),
            folder_workspace: Some(workspace.clone()),
            target_project_id: None,
            created_project_id: Arc::new(Mutex::new(None)),
            allowed_mcp_server_ids: None,
            plan_goal: Arc::new(Mutex::new(None)),
            todo_items: Arc::new(Mutex::new(Vec::new())),
            read_files: Arc::new(Mutex::new(HashSet::new())),
            visible_tool_catalog: None,
            catalog_runtime: None,
            conversation_id: None,
            store: store.clone(),
            memory_queue: None,
            memory_scopes: Vec::new(),
            skills: Arc::new(worldbase_skills::SkillRegistry::new(vec![])),
            scheduler,
            mcp: Arc::new(worldbase_mcp_client::McpManager::default()),
            projects: Arc::new(worldbase_project_runtime::ProjectRuntime::new(projects)),
            group_collaboration: None,
            subagent_runtime: None,
        };

        Self { temp, services }
    }

    fn conversation(&self, title: &str) -> ConversationMeta {
        self.services
            .store
            .create_conversation(title, None)
            .expect("create context-tools conversation")
    }

    fn scope_to(&mut self, conversation_id: &str) {
        self.services.conversation_id = Some(conversation_id.to_string());
    }

    fn append(&self, conversation_id: &str, message: &ChatMessage) -> i64 {
        self.services
            .store
            .append_message(conversation_id, message)
            .expect("append context-tools message")
    }
}

fn text_message(role: Role, content: impl Into<String>) -> ChatMessage {
    ChatMessage {
        id: 0,
        role,
        content: content.into(),
        parts: Vec::new(),
        tool_calls: Vec::new(),
        tool_results: Vec::new(),
        created_at: Some("2026-11-13T10:00:00Z".into()),
    }
}

fn tool_call_message(
    content: impl Into<String>,
    call_id: &str,
    name: &str,
    args: Value,
) -> ChatMessage {
    ChatMessage {
        id: 0,
        role: Role::Assistant,
        content: content.into(),
        parts: Vec::new(),
        tool_calls: vec![ToolCallRecord {
            id: call_id.into(),
            name: name.into(),
            args,
        }],
        tool_results: Vec::new(),
        created_at: Some("2026-11-13T10:00:01Z".into()),
    }
}

fn tool_result_message(
    call_id: &str,
    name: &str,
    content: impl Into<String>,
    is_error: bool,
) -> ChatMessage {
    ChatMessage {
        id: 0,
        role: Role::Assistant,
        content: String::new(),
        parts: Vec::new(),
        tool_calls: Vec::new(),
        tool_results: vec![ToolResultRecord {
            tool_call_id: call_id.into(),
            name: name.into(),
            content: content.into(),
            is_error,
        }],
        created_at: Some("2026-11-13T10:00:02Z".into()),
    }
}

async fn execute_ok(tool: &dyn Tool, input: Value, services: &ToolServices) -> Value {
    tool.execute(input, services)
        .await
        .unwrap_or_else(|error| panic!("{} should succeed: {error:#}", tool.name()))
}

async fn execute_err(tool: &dyn Tool, input: Value, services: &ToolServices) -> String {
    match tool.execute(input, services).await {
        Ok(value) => panic!("{} unexpectedly accepted input: {value}", tool.name()),
        Err(error) => format!("{error:#}"),
    }
}

fn message_ids(result: &Value) -> Vec<i64> {
    result["messages"]
        .as_array()
        .expect("read_transcript_range messages should be an array")
        .iter()
        .map(|message| {
            message["messageId"]
                .as_i64()
                .expect("read_transcript_range message should expose an integer messageId")
        })
        .collect()
}

fn hit_ids(result: &Value) -> Vec<i64> {
    result["hits"]
        .as_array()
        .expect("search result hits should be an array")
        .iter()
        .map(|hit| {
            hit["messageId"]
                .as_i64()
                .expect("search hit should expose an integer messageId")
        })
        .collect()
}

fn message_by_id<'a>(result: &'a Value, id: i64) -> &'a Value {
    result["messages"]
        .as_array()
        .expect("read_transcript_range messages should be an array")
        .iter()
        .find(|message| message["messageId"].as_i64() == Some(id))
        .unwrap_or_else(|| panic!("read_transcript_range should include message {id}"))
}

fn schema_property<'a>(schema: &'a Value, name: &str) -> &'a Value {
    schema
        .get("properties")
        .and_then(Value::as_object)
        .and_then(|properties| properties.get(name))
        .unwrap_or_else(|| panic!("schema should define property {name}"))
}

fn assert_object_schema(schema: &Value) {
    assert_eq!(schema["type"], "object", "tool schema must be an object");
    assert_eq!(
        schema["additionalProperties"], false,
        "tool schema must reject unknown properties"
    );
}

#[tokio::test]
async fn all_transcript_tools_require_a_conversation_id() {
    let fixture = Fixture::new();
    let tools: Vec<(Arc<dyn Tool>, Value)> = vec![
        (
            Arc::new(RecallContextTool),
            json!({ "query": "needle", "limit": 5 }),
        ),
        (
            Arc::new(ReadTranscriptRangeTool),
            json!({ "messageId": 1, "before": 1, "after": 1 }),
        ),
        (
            Arc::new(SearchTranscriptTool),
            json!({ "query": "needle", "limit": 5 }),
        ),
    ];

    for conversation_id in [None, Some(String::new()), Some(" \t\n ".to_string())] {
        let mut services = fixture.services.clone();
        services.conversation_id = conversation_id;
        for (tool, input) in &tools {
            let error = execute_err(tool.as_ref(), input.clone(), &services).await;
            assert!(
                error.contains("conversation_id is required"),
                "{} returned the wrong error: {error}",
                tool.name()
            );
        }
    }
}

#[tokio::test]
async fn recall_context_returns_untrusted_conversation_scoped_evidence() {
    let mut fixture = Fixture::new();
    let own = fixture.conversation("own recall conversation");
    let other = fixture.conversation("other recall conversation");
    fixture.scope_to(&own.id);

    let user_id = fixture.append(
        &own.id,
        &text_message(Role::User, "PrimaryUniqueNeedle appears in this request."),
    );
    let call_id = fixture.append(
        &own.id,
        &tool_call_message(
            "PrimaryUniqueNeedle lookup requested",
            "recall-call",
            "lookup_recall",
            json!({ "query": ["PrimaryUniqueNeedle"] }),
        ),
    );
    let other_id = fixture.append(
        &other.id,
        &text_message(
            Role::User,
            "PrimaryUniqueNeedle OTHER_CONVERSATION_ONLY_MARKER",
        ),
    );

    let result = execute_ok(
        &RecallContextTool,
        json!({ "query": "primaryuniqueneedle", "limit": 10 }),
        &fixture.services,
    )
    .await;

    assert_eq!(result["untrustedEvidence"], true);
    assert_eq!(result["conversationId"], own.id);
    assert_eq!(result["query"], "primaryuniqueneedle");
    assert_eq!(result["truncated"], false);

    let hits = result["hits"]
        .as_array()
        .expect("recall_context hits should be an array");
    assert!(!hits.is_empty(), "recall_context should find the query");
    assert_eq!(
        result["hitCount"].as_u64(),
        Some(hits.len() as u64),
        "hitCount should match the returned hits"
    );

    let ids = hit_ids(&result);
    assert!(ids.iter().all(|id| *id > 0), "message IDs must be concrete");
    assert!(ids.contains(&user_id));
    assert!(ids.contains(&call_id));
    assert!(
        !ids.contains(&other_id),
        "recall_context leaked another conversation's message ID"
    );

    for hit in hits {
        assert!(
            hit["snippet"]
                .as_str()
                .is_some_and(|snippet| !snippet.is_empty()),
            "each hit should include a non-empty snippet: {hit}"
        );
        assert!(
            hit["messageId"].as_i64().is_some(),
            "each hit should include a concrete messageId: {hit}"
        );
    }

    let recommended = &result["recommendedRange"];
    assert_eq!(recommended["messageId"].as_i64(), ids.first().copied());
    assert_eq!(recommended["before"], 2);
    assert_eq!(recommended["after"], 2);

    let serialized = result.to_string();
    assert!(
        !serialized.contains("OTHER_CONVERSATION_ONLY_MARKER"),
        "recall_context output crossed conversation boundaries"
    );
    assert!(
        !serialized.contains(
            fixture
                .temp
                .path()
                .to_str()
                .expect("temporary path should be UTF-8")
        ),
        "recall_context output leaked a filesystem path"
    );
}

#[tokio::test]
async fn transcript_recovery_marks_the_latest_compaction_as_recovered() {
    let mut fixture = Fixture::new();
    let conversation = fixture.conversation("recovery metrics");
    fixture.scope_to(&conversation.id);
    fixture
        .services
        .store
        .record_compaction_metric(&conversation.id, "threshold", 12_000, 4_000, 120)
        .expect("record compaction metric");
    fixture.append(
        &conversation.id,
        &text_message(Role::User, "RecoveryMetricNeedle must remain recoverable."),
    );

    let result = execute_ok(
        &RecallContextTool,
        json!({ "query": "RecoveryMetricNeedle" }),
        &fixture.services,
    )
    .await;
    assert_eq!(result["hitCount"].as_u64(), Some(1));

    let metrics = fixture
        .services
        .store
        .list_compaction_metrics(&conversation.id, 1)
        .expect("list recovery metric");
    assert_eq!(metrics.len(), 1);
    assert!(metrics[0].recovery_used);
    assert_eq!(
        fixture
            .services
            .store
            .compaction_recovery_rate(&conversation.id)
            .expect("recovery rate"),
        Some(1.0)
    );
}

#[tokio::test]
async fn read_transcript_range_returns_bounded_pair_preserving_context() {
    let mut fixture = Fixture::new();
    let own = fixture.conversation("own transcript conversation");
    let other = fixture.conversation("other transcript conversation");
    fixture.scope_to(&own.id);

    let before_id = fixture.append(&own.id, &text_message(Role::User, "before target"));
    let call_id = fixture.append(
        &own.id,
        &tool_call_message(
            "calling the lookup tool",
            "call-read-1",
            "lookup_weather",
            json!({ "city": "上海", "units": "metric" }),
        ),
    );
    let target_id = fixture.append(
        &own.id,
        &tool_result_message("call-read-1", "lookup_weather", "sunny, 24C", false),
    );
    let after_id = fixture.append(&own.id, &text_message(Role::Assistant, "after target"));
    let outside_id = fixture.append(&own.id, &text_message(Role::System, "outside window"));
    let other_id = fixture.append(
        &other.id,
        &text_message(Role::User, "OTHER_CONVERSATION_RANGE_SECRET"),
    );

    let result = execute_ok(
        &ReadTranscriptRangeTool,
        json!({ "messageId": target_id, "before": 2, "after": 1 }),
        &fixture.services,
    )
    .await;

    assert_eq!(result["untrustedEvidence"], true);
    assert_eq!(result["conversationId"], own.id);
    assert_eq!(result["messageId"], target_id);
    assert_eq!(result["found"], true);
    assert_eq!(result["before"], 2);
    assert_eq!(result["after"], 1);
    assert_eq!(result["truncated"], false);
    assert_eq!(
        message_ids(&result),
        vec![before_id, call_id, target_id, after_id],
        "range messages should be chronological and bounded"
    );
    assert!(!message_ids(&result).contains(&outside_id));

    let call_message = message_by_id(&result, call_id);
    assert_eq!(call_message["role"], "assistant");
    assert_eq!(call_message["toolCalls"][0]["id"], "call-read-1");
    assert_eq!(call_message["toolCalls"][0]["name"], "lookup_weather");
    assert_eq!(
        call_message["toolCalls"][0]["args"],
        json!({ "city": "上海", "units": "metric" })
    );

    let result_message = message_by_id(&result, target_id);
    assert_eq!(
        result_message["toolResults"][0]["toolCallId"],
        "call-read-1"
    );
    assert_eq!(result_message["toolResults"][0]["name"], "lookup_weather");
    assert_eq!(result_message["toolResults"][0]["content"], "sunny, 24C");
    assert_eq!(result_message["toolResults"][0]["isError"], false);

    let other_result = execute_ok(
        &ReadTranscriptRangeTool,
        json!({ "messageId": other_id, "before": 2, "after": 1 }),
        &fixture.services,
    )
    .await;
    assert_eq!(other_result["untrustedEvidence"], true);
    assert_eq!(other_result["conversationId"], own.id);
    assert_eq!(other_result["found"], false);
    assert_eq!(other_result["messages"].as_array().map(Vec::len), Some(0));
    assert!(
        !other_result
            .to_string()
            .contains("OTHER_CONVERSATION_RANGE_SECRET"),
        "read_transcript_range leaked another conversation's content"
    );

    let missing_id = target_id + 1_000_000;
    let missing_result = execute_ok(
        &ReadTranscriptRangeTool,
        json!({ "messageId": missing_id, "before": 0, "after": 0 }),
        &fixture.services,
    )
    .await;
    assert_eq!(missing_result["found"], false);
    assert_eq!(missing_result["messages"].as_array().map(Vec::len), Some(0));
}

#[tokio::test]
async fn search_transcript_filters_roles_tools_and_conversation() {
    let mut fixture = Fixture::new();
    let own = fixture.conversation("own search conversation");
    let other = fixture.conversation("other search conversation");

    let user_id = fixture.append(
        &own.id,
        &text_message(Role::User, "AlphaNeedle content from the user"),
    );
    let tool_call_id = fixture.append(
        &own.id,
        &tool_call_message(
            "ScopeTool call about AlphaNeedle",
            "scope-call",
            "ScopeTool",
            json!({ "query": "AlphaNeedle" }),
        ),
    );
    let tool_result_id = fixture.append(
        &own.id,
        &tool_result_message(
            "scope-call",
            "ScopeTool",
            "AlphaNeedle result from the tool",
            false,
        ),
    );
    let other_tool_call_id = fixture.append(
        &own.id,
        &tool_call_message(
            "OtherTool call about AlphaNeedle",
            "other-call",
            "OtherTool",
            json!({ "query": "AlphaNeedle" }),
        ),
    );
    let other_conversation_id = fixture.append(
        &other.id,
        &text_message(Role::User, "OtherOnlyNeedle other conversation marker"),
    );
    fixture.scope_to(&own.id);

    let all_hits = execute_ok(
        &SearchTranscriptTool,
        json!({ "query": "alphaneedle", "limit": 50 }),
        &fixture.services,
    )
    .await;
    assert_eq!(all_hits["untrustedEvidence"], true);
    assert_eq!(all_hits["conversationId"], own.id);
    assert_eq!(all_hits["truncated"], false);
    let all_ids = hit_ids(&all_hits);
    assert!(all_ids.contains(&user_id), "content should be searchable");
    assert!(
        all_ids.contains(&tool_result_id),
        "tool-result content should be searchable"
    );
    assert!(all_ids.contains(&tool_call_id));
    assert!(all_ids.contains(&other_tool_call_id));
    assert!(!all_ids.contains(&other_conversation_id));
    assert!(
        !all_hits.to_string().contains("other conversation marker"),
        "search_transcript leaked another conversation's content"
    );

    let user_hit = all_hits["hits"]
        .as_array()
        .expect("search hits should be an array")
        .iter()
        .find(|hit| hit["messageId"].as_i64() == Some(user_id))
        .expect("user content should produce a hit");
    assert_eq!(user_hit["role"], "user");
    assert!(
        user_hit["matchedIn"]
            .as_array()
            .expect("matchedIn should be an array")
            .iter()
            .any(|source| source == "content"),
        "content hit should identify the content carrier: {user_hit}"
    );

    let result_hit = all_hits["hits"]
        .as_array()
        .expect("search hits should be an array")
        .iter()
        .find(|hit| hit["messageId"].as_i64() == Some(tool_result_id))
        .expect("tool-result content should produce a hit");
    assert!(
        result_hit["matchedIn"]
            .as_array()
            .expect("matchedIn should be an array")
            .iter()
            .any(|source| source == "toolResult"),
        "tool-result hit should identify the carrier: {result_hit}"
    );
    assert!(
        result_hit["toolNames"]
            .as_array()
            .expect("toolNames should be an array")
            .iter()
            .any(|name| name == "ScopeTool"),
        "tool-result hit should expose its tool name: {result_hit}"
    );

    let by_tool = execute_ok(
        &SearchTranscriptTool,
        json!({ "query": "AlphaNeedle", "toolName": "scopetool", "limit": 50 }),
        &fixture.services,
    )
    .await;
    assert_eq!(hit_ids(&by_tool), vec![tool_call_id, tool_result_id]);
    assert_eq!(by_tool["hitCount"].as_u64(), Some(2));
    assert_eq!(by_tool["truncated"], false);
    assert!(
        !by_tool.to_string().contains("OtherTool"),
        "toolName filtering returned a different tool"
    );

    let by_user = execute_ok(
        &SearchTranscriptTool,
        json!({ "query": "AlphaNeedle", "role": "user", "limit": 50 }),
        &fixture.services,
    )
    .await;
    assert_eq!(hit_ids(&by_user), vec![user_id]);
    assert_eq!(by_user["hits"][0]["role"], "user");

    let by_tool_role = execute_ok(
        &SearchTranscriptTool,
        json!({ "query": "AlphaNeedle", "role": "tool", "limit": 50 }),
        &fixture.services,
    )
    .await;
    assert_eq!(
        hit_ids(&by_tool_role),
        vec![tool_result_id],
        "role=tool must use memory's tool-result-carrier semantics"
    );
    assert!(by_tool_role["hits"]
        .as_array()
        .expect("tool-role hits should be an array")
        .iter()
        .all(|hit| hit["role"] == "assistant"));

    let scoped_empty = execute_ok(
        &SearchTranscriptTool,
        json!({ "query": "otheronlyneedle", "limit": 50 }),
        &fixture.services,
    )
    .await;
    assert_eq!(scoped_empty["hits"].as_array().map(Vec::len), Some(0));
    assert_eq!(scoped_empty["hitCount"].as_u64(), Some(0));
    assert_eq!(scoped_empty["truncated"], false);

    fixture.scope_to(&other.id);
    let other_hits = execute_ok(
        &SearchTranscriptTool,
        json!({ "query": "otheronlyneedle", "limit": 50 }),
        &fixture.services,
    )
    .await;
    assert_eq!(hit_ids(&other_hits), vec![other_conversation_id]);
    assert_eq!(other_hits["conversationId"], other.id);

    let no_match = execute_ok(
        &SearchTranscriptTool,
        json!({ "query": "definitely-no-such-transcript-text", "limit": 50 }),
        &fixture.services,
    )
    .await;
    assert_eq!(no_match["untrustedEvidence"], true);
    assert_eq!(no_match["hits"].as_array().map(Vec::len), Some(0));
    assert_eq!(no_match["hitCount"].as_u64(), Some(0));
    assert_eq!(no_match["truncated"], false);
}

#[tokio::test]
async fn transcript_search_uses_authoritative_memory_carrier_semantics() {
    let mut fixture = Fixture::new();
    let conversation = fixture.conversation("authoritative memory search");
    fixture.scope_to(&conversation.id);

    let plain_id = fixture.append(
        &conversation.id,
        &text_message(Role::User, "DirectMemoryQuasar in plain content"),
    );
    let call_id = fixture.append(
        &conversation.id,
        &tool_call_message(
            "DirectMemoryQuasar call content",
            "direct-call",
            "lookup_direct",
            json!({ "query": "DirectMemoryQuasar" }),
        ),
    );
    let result_id = fixture.append(
        &conversation.id,
        &tool_result_message(
            "direct-call",
            "lookup_direct",
            "DirectMemoryQuasar in tool-result content",
            false,
        ),
    );
    let args_only_id = fixture.append(
        &conversation.id,
        &tool_call_message(
            "",
            "args-only-call",
            "args_only_tool",
            json!({ "query": "OnlyInArgumentsQuasar" }),
        ),
    );
    let call_only_id = fixture.append(
        &conversation.id,
        &tool_call_message(
            "CallOnlyQuasar appears in a tool-call row",
            "call-only",
            "call_only_tool",
            json!({}),
        ),
    );

    let all_hits = execute_ok(
        &SearchTranscriptTool,
        json!({ "query": "DirectMemoryQuasar", "limit": 50 }),
        &fixture.services,
    )
    .await;
    assert_eq!(hit_ids(&all_hits), vec![plain_id, call_id, result_id]);
    assert!(!hit_ids(&all_hits).contains(&args_only_id));

    let args_only_hits = execute_ok(
        &SearchTranscriptTool,
        json!({ "query": "OnlyInArgumentsQuasar", "limit": 50 }),
        &fixture.services,
    )
    .await;
    assert!(
        hit_ids(&args_only_hits).is_empty(),
        "memory does not index tool-call arguments as authoritative transcript evidence"
    );

    let tool_results = execute_ok(
        &SearchTranscriptTool,
        json!({ "query": "DirectMemoryQuasar", "role": "tool", "limit": 50 }),
        &fixture.services,
    )
    .await;
    assert_eq!(
        hit_ids(&tool_results),
        vec![result_id],
        "role=tool must match tool-result carriers, not tool-call-only rows"
    );

    let call_only_results = execute_ok(
        &SearchTranscriptTool,
        json!({ "query": "CallOnlyQuasar", "role": "tool", "limit": 50 }),
        &fixture.services,
    )
    .await;
    assert!(
        hit_ids(&call_only_results).is_empty(),
        "a tool-call-only row must not match role=tool"
    );
    assert!(!hit_ids(&all_hits).contains(&call_only_id));
}

#[tokio::test]
async fn oversized_results_are_bounded_and_utf8_safe() {
    let mut fixture = Fixture::new();
    let conversation = fixture.conversation("oversized transcript");
    fixture.scope_to(&conversation.id);

    let long_content = format!(
        "{}OVERFLOW_NEEDLE{}",
        "界".repeat(6_000),
        "🙂".repeat(1_000)
    );
    let long_id = fixture.append(&conversation.id, &text_message(Role::User, long_content));
    for index in 0..24 {
        fixture.append(
            &conversation.id,
            &text_message(
                Role::User,
                format!("OVERFLOW_NEEDLE additional match {index}"),
            ),
        );
    }

    let recall = execute_ok(
        &RecallContextTool,
        json!({ "query": "OVERFLOW_NEEDLE", "limit": 3 }),
        &fixture.services,
    )
    .await;
    let hits = recall["hits"]
        .as_array()
        .expect("recall overflow hits should be an array");
    assert_eq!(hits.len(), 3);
    assert_eq!(hit_ids(&recall).first().copied(), Some(long_id));
    assert_eq!(recall["truncated"], true);
    for hit in hits.iter() {
        let snippet = hit["snippet"]
            .as_str()
            .expect("overflow hit should include a snippet");
        assert!(
            snippet.chars().count() <= 400,
            "snippet exceeded 400 Unicode characters: {}",
            snippet.chars().count()
        );
    }
    let first_snippet = hits[0]["snippet"]
        .as_str()
        .expect("the oversized first overflow hit should include a snippet");
    assert!(
        first_snippet.chars().count() <= 400,
        "the oversized first snippet exceeded 400 Unicode characters: {}",
        first_snippet.chars().count()
    );
    assert!(
        first_snippet.contains('…') || first_snippet.contains("..."),
        "the oversized first snippet should indicate truncation: {first_snippet}"
    );

    let huge_tool_result = format!("{}{}", "界".repeat(7_000), "🙂".repeat(7_000));
    let tool_call_id = fixture.append(
        &conversation.id,
        &tool_call_message("", "oversized-call", "HugeTool", json!({})),
    );
    let tool_result_id = fixture.append(
        &conversation.id,
        &tool_result_message("oversized-call", "HugeTool", huge_tool_result, false),
    );
    let range = execute_ok(
        &ReadTranscriptRangeTool,
        json!({ "messageId": tool_result_id, "before": 0, "after": 0 }),
        &fixture.services,
    )
    .await;
    assert_eq!(range["untrustedEvidence"], true);
    assert_eq!(range["truncated"], true);
    assert_eq!(message_ids(&range), vec![tool_result_id]);
    let message = message_by_id(&range, tool_result_id);
    assert_eq!(message["truncated"], true);
    assert_eq!(message["toolResults"][0]["toolCallId"], "oversized-call");
    assert_eq!(message["toolResults"][0]["name"], "HugeTool");
    let bounded_result = message["toolResults"][0]["content"]
        .as_str()
        .expect("oversized tool result should remain a string");
    assert!(
        bounded_result.chars().count() <= 12_000,
        "tool-result content exceeded 12,000 Unicode characters: {}",
        bounded_result.chars().count()
    );
    assert!(
        !bounded_result.contains('\u{FFFD}'),
        "UTF-8 truncation introduced replacement characters"
    );
    assert_eq!(
        message_ids(&range),
        vec![tool_result_id],
        "the huge result should not inflate the range"
    );

    // The call row is still independent evidence even when the surrounding
    // result is rewritten to a bounded preview.
    let call_exists = execute_ok(
        &ReadTranscriptRangeTool,
        json!({ "messageId": tool_call_id, "before": 0, "after": 0 }),
        &fixture.services,
    )
    .await;
    assert_eq!(message_ids(&call_exists), vec![tool_call_id]);
}

#[tokio::test]
async fn transcript_tools_are_registered_once_with_bounded_object_schemas() {
    let builtins = builtin_tools();
    let expected = [
        "recall_context",
        "read_transcript_range",
        "search_transcript",
    ];

    for name in expected {
        let matches: Vec<_> = builtins.iter().filter(|tool| tool.name() == name).collect();
        assert_eq!(matches.len(), 1, "{name} must be registered exactly once");

        let descriptor = matches[0].descriptor();
        assert_eq!(
            descriptor.visibility,
            ToolVisibility::AlwaysOn,
            "{name} must be always-on"
        );
        assert!(
            descriptor.electron_native,
            "{name} must be exposed as an Electron-native tool"
        );
        assert_object_schema(&descriptor.input_schema);

        match name {
            "recall_context" => {
                let schema = &descriptor.input_schema;
                assert_eq!(schema["required"], json!(["query"]));
                assert_eq!(schema_property(schema, "query")["type"], "string");
                assert_eq!(schema_property(schema, "query")["minLength"], 1);
                assert_eq!(schema_property(schema, "query")["maxLength"], 2_048);
                assert_eq!(schema_property(schema, "limit")["type"], "integer");
                assert_eq!(schema_property(schema, "limit")["minimum"], 1);
                assert_eq!(schema_property(schema, "limit")["maximum"], 20);
            }
            "read_transcript_range" => {
                let schema = &descriptor.input_schema;
                assert_eq!(schema["required"], json!(["messageId"]));
                assert_eq!(schema_property(schema, "messageId")["type"], "integer");
                assert_eq!(schema_property(schema, "messageId")["minimum"], 1);
                for field in ["before", "after"] {
                    assert_eq!(schema_property(schema, field)["type"], "integer");
                    assert_eq!(schema_property(schema, field)["minimum"], 0);
                    assert_eq!(schema_property(schema, field)["maximum"], 25);
                }
            }
            "search_transcript" => {
                let schema = &descriptor.input_schema;
                assert_eq!(schema["required"], json!(["query"]));
                assert_eq!(schema_property(schema, "query")["type"], "string");
                assert_eq!(schema_property(schema, "query")["minLength"], 1);
                assert_eq!(schema_property(schema, "query")["maxLength"], 2_048);
                assert_eq!(schema_property(schema, "limit")["type"], "integer");
                assert_eq!(schema_property(schema, "limit")["minimum"], 1);
                assert_eq!(schema_property(schema, "limit")["maximum"], 50);
                assert_eq!(schema_property(schema, "toolName")["type"], "string");
                assert_eq!(schema_property(schema, "toolName")["minLength"], 1);
                assert_eq!(schema_property(schema, "toolName")["maxLength"], 256);
                let roles: HashSet<_> = schema_property(schema, "role")["enum"]
                    .as_array()
                    .expect("role schema should define an enum")
                    .iter()
                    .filter_map(Value::as_str)
                    .collect();
                assert_eq!(
                    roles,
                    HashSet::from(["user", "assistant", "system", "tool"])
                );
                let description = schema_property(schema, "role")["description"]
                    .as_str()
                    .expect("role description should be a string");
                assert!(description.contains("tool-result"));
                assert!(description.contains("carrier"));
                assert!(!description.contains("tool calls"));
            }
            _ => unreachable!(),
        }
    }
}

#[test]
fn mobile_capabilities_advertise_transcript_tools_without_widening_allowlist() {
    let capabilities = Capabilities::mobile("mobile-ios");
    let filtered = filter_tools(&builtin_tools(), &capabilities);
    let names: HashSet<_> = filtered.iter().map(|tool| tool.name()).collect();

    for advertised in [
        "recall_context",
        "read_transcript_range",
        "search_transcript",
        "read_file",
        "memory_search",
        "mcp_call",
    ] {
        assert!(
            names.contains(advertised),
            "mobile must advertise {advertised}"
        );
    }

    for hidden in [
        "run_shell_command",
        "computer_observe",
        "workspace_write_file",
    ] {
        assert!(
            !names.contains(hidden),
            "mobile must not advertise non-allow-listed tool {hidden}"
        );
    }
}

#[tokio::test]
async fn invalid_transcript_tool_inputs_are_rejected_safely() {
    let mut fixture = Fixture::new();
    let conversation = fixture.conversation("invalid input conversation");
    fixture.scope_to(&conversation.id);
    let message_id = fixture.append(
        &conversation.id,
        &text_message(Role::User, "valid fixture message"),
    );

    let recall: Arc<dyn Tool> = Arc::new(RecallContextTool);
    let range: Arc<dyn Tool> = Arc::new(ReadTranscriptRangeTool);
    let search: Arc<dyn Tool> = Arc::new(SearchTranscriptTool);
    let oversized_query = "界".repeat(2_049);
    let oversized_tool_name = "t".repeat(257);
    let mut cases: Vec<(Arc<dyn Tool>, Value)> = Vec::new();

    for input in [
        json!({}),
        json!({ "query": "" }),
        json!({ "query": "   \n\t" }),
        json!({ "query": oversized_query }),
        json!({ "query": "needle", "limit": 0 }),
        json!({ "query": "needle", "limit": -1 }),
        json!({ "query": "needle", "limit": 21 }),
        json!({ "query": "needle", "limit": 1.5 }),
        json!({ "query": "needle", "limit": "3" }),
    ] {
        cases.push((recall.clone(), input));
    }

    for input in [
        json!({}),
        json!({ "messageId": 0 }),
        json!({ "messageId": -1 }),
        json!({ "messageId": "1" }),
        json!({ "messageId": 1.5 }),
        json!({ "messageId": message_id, "before": -1 }),
        json!({ "messageId": message_id, "before": 26 }),
        json!({ "messageId": message_id, "before": "1" }),
        json!({ "messageId": message_id, "after": -1 }),
        json!({ "messageId": message_id, "after": 26 }),
        json!({ "messageId": message_id, "after": true }),
    ] {
        cases.push((range.clone(), input));
    }

    for input in [
        json!({}),
        json!({ "query": "" }),
        json!({ "query": "   " }),
        json!({ "query": oversized_query }),
        json!({ "query": "needle", "role": "tool_call" }),
        json!({ "query": "needle", "role": "USER" }),
        json!({ "query": "needle", "role": 1 }),
        json!({ "query": "needle", "toolName": "" }),
        json!({ "query": "needle", "toolName": "  " }),
        json!({ "query": "needle", "toolName": oversized_tool_name }),
        json!({ "query": "needle", "toolName": true }),
        json!({ "query": "needle", "limit": 0 }),
        json!({ "query": "needle", "limit": -1 }),
        json!({ "query": "needle", "limit": 51 }),
        json!({ "query": "needle", "limit": 1.5 }),
        json!({ "query": "needle", "limit": "10" }),
    ] {
        cases.push((search.clone(), input));
    }

    for (tool, input) in cases {
        let error = execute_err(tool.as_ref(), input.clone(), &fixture.services).await;
        assert!(
            !error.trim().is_empty(),
            "{} should return a useful validation error for {input}",
            tool.name()
        );
    }
}
