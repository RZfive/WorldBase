//! User-visible integration coverage for durable context compression.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;

use serde_json::json;
use tempfile::TempDir;
use worldbase_core::context::budget::{select_recent_window, TokenBudget, TokenEstimator};
use worldbase_core::context::candidate::{
    CandidateManager, OverflowCompactionDecision, VersionMismatch,
};
use worldbase_core::context::checkpoint::CheckpointFallback;
use worldbase_core::context::ledger::{AttemptOutcome, TrackBApplyReason, TrackBUpdate};
use worldbase_core::context::microcompact::{microcompact_messages, MicrocompactionPolicy};
use worldbase_core::context::{
    CompactionCandidate, CompactionCheckpoint, CompactionVersion, MessageProvenance,
    OverflowCompactionGuard, RunStateLedger, UserAnchors,
};
use worldbase_core::{start_chat, Hub};
use worldbase_memory::Store;
use worldbase_protocol::types::{
    Capabilities, ChatContentPart, ChatMessage, ChatRunContext, ConversationMeta, ImageUrl, Role,
    ToolCallRecord, ToolResultRecord,
};
use worldbase_providers::{
    ChatOptions, ChunkStream, ContentBlock, LlmMessage, LlmRole, LlmTool, Provider, StreamChunk,
    TokenUsage,
};

struct StoreFixture {
    _dir: TempDir,
    store: Arc<Store>,
    conversation: ConversationMeta,
}

#[derive(Clone)]
struct CapturedProviderRequest {
    system: Option<String>,
    messages: Vec<LlmMessage>,
}

fn is_compaction_summary_request(system: Option<&str>, messages: &[LlmMessage]) -> bool {
    let system_lower = system.unwrap_or_default().to_ascii_lowercase();
    system_lower.starts_with("you summarize")
        || system_lower.contains("structured compaction checkpoint")
        || system_lower.contains("context checkpoint")
        || messages.iter().any(|message| {
            message
                .text_view()
                .trim_start()
                .starts_with("Conversation history:")
        })
}

fn valid_checkpoint_markdown(marker: &str) -> String {
    format!(
        r#"## Objective
- {marker}

## Requirements
- Keep summary text outside the system prompt.

## Confirmed Facts
- The provider capture records every request.

## Critical Errors
- `manifest_invalid: marker` — source: test

## Decisions
- Render checkpoints as evidence.

## Work State
### Completed
- Prepare checkpoint.
### Active
- Continue the run.
### Blocked
- None.

## Attempts and Outcomes
- Summary request completed.

## Dead Ends
- None.

## Capabilities
- `context.compression` — available

## Relevant Files
- `context_compression_e2e.rs`: coverage

## Next Move
1. Continue with recent raw context.

## Knowledge Gaps
- None.
"#
    )
}

#[derive(Default)]
struct CapturingCompactionProvider {
    requests: Mutex<Vec<CapturedProviderRequest>>,
}

impl CapturingCompactionProvider {
    fn requests(&self) -> Vec<CapturedProviderRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl Provider for CapturingCompactionProvider {
    fn name(&self) -> &str {
        "capturing-compaction-test"
    }

    fn model(&self) -> &str {
        "capturing-compaction-test-model"
    }

    async fn chat_stream(
        &self,
        system: Option<&str>,
        messages: Vec<LlmMessage>,
        _tools: Vec<LlmTool>,
        _max_tokens: u32,
        _options: ChatOptions,
    ) -> anyhow::Result<ChunkStream> {
        let summary_request = is_compaction_summary_request(system, &messages);
        self.requests.lock().unwrap().push(CapturedProviderRequest {
            system: system.map(ToOwned::to_owned),
            messages,
        });
        let text = if summary_request {
            valid_checkpoint_markdown("CHECKPOINT_SENTINEL_SYSTEM_PROMPT_BOUNDARY")
        } else {
            "capture complete".to_string()
        };
        Ok(Box::pin(futures::stream::iter([Ok(
            StreamChunk::Completed {
                stop_reason: "stop".into(),
                assistant: LlmMessage::text(LlmRole::Assistant, text),
                usage: TokenUsage::default(),
            },
        )])))
    }
}

fn store_fixture() -> StoreFixture {
    let dir = tempfile::tempdir().expect("create temp dir");
    let store = Arc::new(Store::open(&dir.path().join("app.sqlite")).expect("open store"));
    let conversation = store
        .create_conversation("context compression", None)
        .expect("create conversation");
    StoreFixture {
        _dir: dir,
        store,
        conversation,
    }
}

fn message(role: Role, content: impl Into<String>) -> ChatMessage {
    ChatMessage {
        id: 0,
        role,
        content: content.into(),
        parts: Vec::new(),
        tool_calls: Vec::new(),
        tool_results: Vec::new(),
        created_at: None,
    }
}

fn assistant_tool_call(call_id: &str, name: &str, args: serde_json::Value) -> ChatMessage {
    ChatMessage {
        id: 0,
        role: Role::Assistant,
        content: String::new(),
        parts: Vec::new(),
        tool_calls: vec![ToolCallRecord {
            id: call_id.into(),
            name: name.into(),
            args,
        }],
        tool_results: Vec::new(),
        created_at: None,
    }
}

fn tool_result(
    call_id: &str,
    name: &str,
    content: impl Into<String>,
    is_error: bool,
) -> ChatMessage {
    ChatMessage {
        id: 0,
        role: Role::User,
        content: String::new(),
        parts: Vec::new(),
        tool_calls: Vec::new(),
        tool_results: vec![ToolResultRecord {
            tool_call_id: call_id.into(),
            name: name.into(),
            content: content.into(),
            is_error,
        }],
        created_at: None,
    }
}

#[tokio::test]
async fn recent_history_is_chronological_and_keeps_the_latest_real_user_message() {
    let fixture = store_fixture();
    for (role, content) in [
        (Role::User, "older request"),
        (Role::Assistant, "older answer"),
        (Role::User, "middle request"),
        (Role::Assistant, "middle answer"),
        (Role::User, "latest request: fix manifest_invalid"),
    ] {
        fixture
            .store
            .append_message(&fixture.conversation.id, &message(role, content))
            .expect("append history");
    }

    let recent = fixture
        .store
        .list_messages(&fixture.conversation.id, 3)
        .expect("list recent history");

    let contents = recent
        .iter()
        .map(|entry| entry.content.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        contents,
        vec![
            "middle request",
            "middle answer",
            "latest request: fix manifest_invalid",
        ]
    );
    assert_eq!(recent.last().expect("latest message").role, Role::User);
    assert_eq!(
        recent.last().expect("latest message").content,
        "latest request: fix manifest_invalid"
    );
}

#[tokio::test]
async fn tool_call_and_result_pair_survives_transcript_range_read() {
    let fixture = store_fixture();
    let call_message = assistant_tool_call(
        "call-manifest",
        "upgrade_project",
        json!({"projectId": "demo", "ai_only": true}),
    );
    let result_message = tool_result(
        "call-manifest",
        "upgrade_project",
        "manifest_invalid: app-capabilities.json is not valid JSON",
        true,
    );
    let call_id = fixture
        .store
        .append_message(&fixture.conversation.id, &call_message)
        .expect("append tool call");
    let result_id = fixture
        .store
        .append_message(&fixture.conversation.id, &result_message)
        .expect("append tool result");

    let llm_messages = worldbase_core::to_llm_messages(&[call_message, result_message]);
    let estimator = TokenEstimator::new();
    let pair_tokens = estimator.estimate_messages(&llm_messages);
    let compacted_window = select_recent_window(&llm_messages, pair_tokens, &estimator);
    assert_eq!(
        compacted_window.selected_indices,
        vec![0, 1],
        "a token-bounded raw window must retain the complete tool exchange"
    );
    assert!(compacted_window.messages[0]
        .tool_uses()
        .iter()
        .any(|(id, _, _)| id == "call-manifest"));
    assert!(matches!(
        &compacted_window.messages[1].content[0],
        worldbase_providers::ContentBlock::ToolResult { tool_use_id, .. }
            if tool_use_id == "call-manifest"
    ));

    let range = fixture
        .store
        .read_message_range(&fixture.conversation.id, call_id, 0, 1)
        .expect("read transcript range");

    assert_eq!(range.len(), 2, "range must include the carrier pair");
    assert_eq!(range[0].id, call_id);
    assert_eq!(range[1].id, result_id);
    assert_eq!(range[0].tool_calls[0].id, "call-manifest");
    assert_eq!(range[1].tool_results[0].tool_call_id, "call-manifest");
    assert!(range[1].tool_results[0].is_error);
}

#[tokio::test]
async fn transcript_search_is_conversation_scoped_and_finds_content_and_tool_results() {
    let fixture = store_fixture();
    let other = fixture
        .store
        .create_conversation("unrelated conversation", None)
        .expect("create other conversation");

    fixture
        .store
        .append_message(
            &fixture.conversation.id,
            &message(
                Role::User,
                "recover MANIFEST-SENTINEL from this conversation",
            ),
        )
        .expect("append matching user message");
    fixture
        .store
        .append_message(
            &fixture.conversation.id,
            &tool_result(
                "call-search",
                "upgrade_project",
                "manifest_invalid: MANIFEST-SENTINEL is malformed",
                true,
            ),
        )
        .expect("append matching tool result");
    fixture
        .store
        .append_message(
            &other.id,
            &message(
                Role::User,
                "MANIFEST-SENTINEL must never leak from another conversation",
            ),
        )
        .expect("append unrelated message");

    let hits = fixture
        .store
        .search_messages(
            &fixture.conversation.id,
            "MANIFEST-SENTINEL",
            None,
            None,
            20,
        )
        .expect("search transcript");
    assert!(!hits.is_empty());
    assert!(hits.iter().any(|hit| {
        hit.content.contains("MANIFEST-SENTINEL") || hit.snippet.contains("MANIFEST-SENTINEL")
    }));
    assert!(
        hits.iter().all(|hit| {
            !hit.content.contains("never leak") && !hit.snippet.contains("never leak")
        }),
        "hits from this conversation must not contain the other conversation's text"
    );

    let tool_hits = fixture
        .store
        .search_messages(
            &fixture.conversation.id,
            "MANIFEST-SENTINEL",
            None,
            Some("upgrade_project"),
            20,
        )
        .expect("search tool result");
    assert!(
        tool_hits.iter().any(|hit| {
            hit.content.contains("manifest_invalid:") || hit.snippet.contains("manifest_invalid:")
        }),
        "tool-result text and tool name must be searchable"
    );

    let other_hits = fixture
        .store
        .search_messages(&other.id, "MANIFEST-SENTINEL", None, None, 20)
        .expect("search unrelated conversation");
    assert_eq!(other_hits.len(), 1);
    assert!(other_hits[0].content.contains("never leak"));
}

#[tokio::test]
async fn transcript_recovery_tools_are_marked_as_untrusted_evidence() {
    let fixture = store_fixture();
    let anchor_id = fixture
        .store
        .append_message(
            &fixture.conversation.id,
            &message(Role::User, "Find the exact manifest_invalid evidence"),
        )
        .expect("append user anchor");
    fixture
        .store
        .append_message(
            &fixture.conversation.id,
            &tool_result(
                "call-recall",
                "upgrade_project",
                "manifest_invalid: app-capabilities.json missing required capability",
                true,
            ),
        )
        .expect("append recoverable tool result");

    let workspace = tempfile::tempdir().expect("create hub workspace");
    let hub = Hub::new(workspace.path().to_path_buf(), fixture.store.clone()).expect("create hub");
    let mut services = hub.services();
    services.conversation_id = Some(fixture.conversation.id.clone());
    let tools = worldbase_tools::builtin_tools();

    for (name, input) in [
        ("recall_context", json!({"query": "manifest_invalid"})),
        (
            "read_transcript_range",
            json!({"messageId": anchor_id, "before": 0, "after": 2}),
        ),
        (
            "search_transcript",
            json!({"query": "manifest_invalid", "toolName": "upgrade_project"}),
        ),
    ] {
        let tool = tools
            .iter()
            .find(|candidate| candidate.name() == name)
            .unwrap_or_else(|| panic!("missing transcript recovery tool: {name}"));
        let output = tool
            .execute(input, &services)
            .await
            .unwrap_or_else(|error| panic!("{name} failed: {error}"));
        assert_eq!(
            output.get("untrustedEvidence"),
            Some(&json!(true)),
            "{name} must label transcript evidence as untrusted"
        );
    }
}

#[tokio::test]
async fn compaction_metrics_record_before_after_tokens_and_latency_per_conversation() {
    let fixture = store_fixture();
    let other = fixture
        .store
        .create_conversation("other metrics", None)
        .expect("create other conversation");

    fixture
        .store
        .record_compaction_metric(
            &fixture.conversation.id,
            "formal_threshold",
            32_000,
            11_000,
            275,
        )
        .expect("record first metric");
    fixture
        .store
        .record_compaction_metric(
            &fixture.conversation.id,
            "provider_overflow",
            30_000,
            9_000,
            390,
        )
        .expect("record second metric");
    fixture
        .store
        .record_compaction_metric(&other.id, "formal_threshold", 20_000, 8_000, 100)
        .expect("record other conversation metric");

    let metrics = fixture
        .store
        .list_compaction_metrics(&fixture.conversation.id, 10)
        .expect("list metrics");
    assert_eq!(metrics.len(), 2);
    assert_eq!(metrics[0].reason, "provider_overflow");
    assert_eq!(metrics[0].before_tokens, 30_000);
    assert_eq!(metrics[0].after_tokens, 9_000);
    assert_eq!(metrics[0].latency_ms, 390);
    assert_eq!(metrics[1].reason, "formal_threshold");
    assert_eq!(metrics[1].before_tokens, 32_000);
    assert_eq!(metrics[1].after_tokens, 11_000);
    assert_eq!(metrics[1].latency_ms, 275);
    assert!(
        metrics
            .iter()
            .all(|metric| metric.conversation_id == fixture.conversation.id),
        "metrics must stay conversation-scoped"
    );
}

fn assert_candidate_discarded(
    base: &CompactionVersion,
    changed: CompactionVersion,
    expected: impl FnOnce(&VersionMismatch) -> bool,
) {
    let mut manager = CandidateManager::new(base.clone());
    manager
        .install_candidate(CompactionCandidate::new(
            1,
            base.clone(),
            "candidate summary",
            None,
            900,
            200,
        ))
        .expect("install candidate");
    assert!(manager.candidate().is_some());

    let mismatch = manager
        .set_current_version(changed)
        .expect("version change must discard the candidate");
    assert!(expected(&mismatch));
    assert!(
        manager.candidate().is_none(),
        "stale candidate must be removed"
    );
}

#[tokio::test]
async fn wake_up_messages_and_tool_images_cannot_overwrite_latest_real_user_request() {
    let original_request = "original request: keep the full manifest repair objective";
    let latest_request = format!(
        "latest real user request: preserve every byte of this anchor — {}",
        "x".repeat(4_000)
    );
    let mut original = message(Role::User, original_request);
    original.id = 10;
    let mut latest = message(Role::User, latest_request.clone());
    latest.id = 20;
    let mut history = vec![original, latest];
    let mut anchors = UserAnchors::from_chat_history(&history);
    assert_eq!(anchors.latest.as_ref().unwrap().message_id, 20);

    let wake_up = LlmMessage::text(
        LlmRole::User,
        "[WAKE_UP] scheduled run resumed; continue without asking the user",
    );
    assert_eq!(
        worldbase_core::context::provenance::classify_llm_message(&wake_up),
        MessageProvenance::RuntimeNudge
    );
    assert!(!anchors.observe_llm_message(&wake_up, Some(30)));

    let continuation = LlmMessage::text(
        LlmRole::User,
        worldbase_core::context::provenance::CONTEXT_CONTINUATION_MESSAGE,
    );
    assert!(!anchors.observe_llm_message(&continuation, Some(31)));

    let mut persisted_tool_image = tool_image_result("call-image", "data:image/png;base64,AAAA");
    persisted_tool_image.id = 32;
    assert_eq!(
        worldbase_core::context::provenance::classify_chat_message(&persisted_tool_image),
        MessageProvenance::ToolResult
    );
    assert!(!anchors.observe_chat_message(&persisted_tool_image));

    let provider_tool_image = LlmMessage {
        role: LlmRole::User,
        content: vec![
            ContentBlock::ToolResult {
                tool_use_id: "call-image".into(),
                content: "image result".into(),
                is_error: false,
            },
            ContentBlock::ImageUrl {
                url: "data:image/png;base64,BBBB".into(),
            },
        ],
    };
    assert!(!anchors.observe_llm_message(&provider_tool_image, Some(33)));

    assert_eq!(anchors.latest.as_ref().unwrap().message_id, 20);
    assert_eq!(anchors.latest.as_ref().unwrap().text, latest_request);

    // A genuinely persisted later user row is the only event that may move the
    // latest anchor. The earlier synthetic history entry must remain ignored.
    let mut real_update = message(Role::User, "next real request");
    real_update.id = 34;
    history.push(real_update.clone());
    assert!(anchors.observe_chat_message(&real_update));
    assert_eq!(anchors.original.as_ref().unwrap().message_id, 10);
    assert_eq!(anchors.latest.as_ref().unwrap().message_id, 34);
    assert_eq!(anchors.latest.as_ref().unwrap().text, "next real request");

    let rendered = anchors.render();
    assert!(rendered.contains("original_message_id: 10"));
    assert!(rendered.contains("latest_message_id: 34"));
    assert!(rendered.contains(original_request));
}

#[tokio::test]
async fn background_candidate_discarded_after_history_model_and_catalog_changes() {
    let base = CompactionVersion::new(
        41,
        "model-a",
        "prompt-hash-a",
        7,
        "provider-entry-a",
        "auth-owner-a",
    );

    assert_candidate_discarded(
        &base,
        CompactionVersion {
            history_version: 42,
            ..base.clone()
        },
        |mismatch| matches!(mismatch, VersionMismatch::HistoryVersion { .. }),
    );
    assert_candidate_discarded(
        &base,
        CompactionVersion {
            model_slug: "model-b".into(),
            ..base.clone()
        },
        |mismatch| matches!(mismatch, VersionMismatch::ModelSlug { .. }),
    );
    assert_candidate_discarded(
        &base,
        CompactionVersion {
            tool_catalog_version: 8,
            ..base.clone()
        },
        |mismatch| matches!(mismatch, VersionMismatch::ToolCatalogVersion { .. }),
    );
}

#[tokio::test]
async fn first_provider_overflow_permits_one_emergency_compaction_then_terminates() {
    assert!(
        worldbase_providers::is_context_overflow_error(
            "This model's maximum context length is 32768 tokens. Please reduce the length of the messages."
        ),
        "the provider overflow classifier must recognize the mock overflow"
    );

    let mut guard = OverflowCompactionGuard::new();
    assert_eq!(
        guard.on_overflow(7),
        OverflowCompactionDecision::EmergencyCompaction
    );
    assert_eq!(
        guard.on_overflow(7),
        OverflowCompactionDecision::Terminate,
        "a second overflow for the same logical step must terminate instead of looping"
    );
    assert_eq!(
        guard.record_overflow(7),
        OverflowCompactionDecision::Terminate
    );
    assert_eq!(
        guard.on_overflow(8),
        OverflowCompactionDecision::EmergencyCompaction,
        "a new logical step receives a fresh emergency allowance"
    );
}

#[tokio::test]
async fn fallback_32k_budget_reserves_8k_output_and_a_safety_margin() {
    let budget = TokenBudget::new(32_000, 8_000);
    assert_eq!(budget.context_window_tokens, 32_000);
    assert_eq!(budget.actual_max_output_tokens, 8_000);
    assert!(
        budget.safety_margin_tokens > 0,
        "a 32k fallback must reserve safety headroom"
    );
    assert_eq!(
        budget.available_input_tokens
            + budget.actual_max_output_tokens
            + budget.safety_margin_tokens,
        32_000
    );
    assert!(
        budget.available_input_tokens <= 24_000 - budget.safety_margin_tokens,
        "input budget must leave room for both output and safety"
    );
    assert!(budget.should_start_background(budget.background_threshold_tokens));
    assert!(!budget.should_compact(budget.background_threshold_tokens));
    assert!(budget.should_compact(budget.compaction_threshold_tokens));

    let fallback = TokenBudget::fallback_32k();
    assert!(fallback.actual_max_output_tokens >= 8_000);
    assert!(fallback.safety_margin_tokens > 0);
    assert!(
        fallback.available_input_tokens
            + fallback.actual_max_output_tokens
            + fallback.safety_margin_tokens
            <= fallback.context_window_tokens
    );
}

#[tokio::test]
async fn exact_manifest_invalid_error_survives_five_checkpoint_rounds() {
    let exact_error = concat!(
        "manifest_invalid: app-capabilities.json: capabilities[0].id is required\n",
        "caused by: expected a non-empty stable capability id"
    );
    let mut fallback = CheckpointFallback {
        objective: "Repair the AI application capability manifest.".into(),
        critical_errors: vec![exact_error.into()],
        ..CheckpointFallback::default()
    };
    let mut ledger = RunStateLedger::from_real_user_request(
        "Repair the AI application capability manifest.",
        1,
        "Fix the manifest and retain exact errors.",
    );

    for round in 0..5 {
        ledger
            .record_tool_error(
                "upgrade_project",
                format!("manifest-call-{round}"),
                &json!({"projectId": "demo", "ai_only": true}),
                exact_error,
                round + 1,
            )
            .expect("record exact Track A error");
        // Simulate persistence and reload at every compaction boundary.
        ledger = serde_json::from_str(&serde_json::to_string(&ledger).expect("serialize ledger"))
            .expect("restore ledger");
        let serialized = serde_json::to_string(&fallback).expect("serialize fallback");
        fallback = serde_json::from_str(&serialized).expect("restore fallback");
        let checkpoint = CompactionCheckpoint::from_fallback(
            format!("checkpoint-{round}"),
            "conversation-manifest",
            &fallback,
        );
        checkpoint
            .validate()
            .expect("fallback checkpoint must satisfy the schema");
        let rendered = checkpoint.tagged_summary();
        assert!(
            rendered.contains(exact_error),
            "round {round} must retain the exact manifest_invalid bytes"
        );
        assert!(rendered.contains("untrusted evidence"));
        assert!(ledger.render_markdown().contains(exact_error));
    }

    assert_eq!(ledger.attempts.len(), 5);
    assert_eq!(ledger.critical_errors.len(), 1);
    assert_eq!(ledger.critical_errors[0].message, exact_error);
    assert_eq!(ledger.critical_errors[0].count, 5);
    assert!(ledger.critical_errors[0].exact);
}

#[tokio::test]
async fn checkpoint_summary_is_rendered_only_as_tagged_user_evidence() {
    let fallback = CheckpointFallback {
        objective: "Keep summaries out of authoritative system instructions.".into(),
        critical_errors: vec!["manifest_invalid: SENTINEL".into()],
        ..CheckpointFallback::default()
    };
    let checkpoint = CompactionCheckpoint::from_fallback(
        "checkpoint-system-boundary",
        "conversation",
        &fallback,
    );
    let evidence = checkpoint.user_message();

    assert_eq!(evidence.role, LlmRole::User);
    let text = evidence.text_view();
    assert!(text.starts_with(worldbase_core::context::checkpoint::CHECKPOINT_EVIDENCE_OPEN));
    assert!(text.contains("manifest_invalid: SENTINEL"));
    assert!(
        checkpoint
            .tagged_summary()
            .contains("[/CONTEXT_CHECKPOINT]"),
        "checkpoint output must be explicitly closed as untrusted evidence"
    );
    // The checkpoint API can only construct user-role evidence. Agent-level
    // coverage additionally captures every provider system prompt to prove the
    // summary is never promoted there.
}

#[tokio::test]
async fn track_a_records_error_and_attempt_facts_synchronously() {
    let exact_error = "manifest_invalid: app-capabilities.json capabilities[0].id is empty";
    let mut ledger = RunStateLedger::from_real_user_request(
        "Repair capability discovery.",
        100,
        "Repair the AI application and prove discovery.",
    );

    let error = ledger
        .record_tool_error(
            "upgrade_project",
            "call-error",
            &json!({"projectId": "demo", "ai_only": true}),
            exact_error,
            3,
        )
        .expect("record Track A error");
    let success = ledger
        .record_tool_success(
            "search_tools",
            "call-success",
            &json!({"query": "demo", "source": "app"}),
            4,
        )
        .expect("record Track A success");

    assert_eq!(error.attempt.outcome, AttemptOutcome::Error);
    assert_eq!(success.attempt.outcome, AttemptOutcome::Success);
    assert_eq!(ledger.attempts.len(), 2);
    assert_eq!(ledger.attempts[0].tool, "upgrade_project");
    assert_eq!(ledger.attempts[0].tool_call_id, "call-error");
    assert_eq!(ledger.attempts[0].turn, 3);
    assert!(ledger.attempts[0].error_signature.is_some());
    assert_eq!(ledger.attempts[1].tool, "search_tools");
    assert_eq!(ledger.attempts[1].tool_call_id, "call-success");
    assert_eq!(ledger.critical_errors.len(), 1);
    assert_eq!(ledger.critical_errors[0].message, exact_error);
    assert_eq!(ledger.critical_errors[0].tool_call_id, "call-error");
    assert_eq!(ledger.critical_errors[0].count, 1);
    assert!(ledger.critical_errors[0].exact);
    assert!(ledger.render_markdown().contains(exact_error));
}

#[tokio::test]
async fn track_b_out_of_order_result_cannot_overwrite_newer_ledger_state() {
    let mut ledger = RunStateLedger::new("Use only the newest Track B state.");
    ledger.observe_real_user_request(10, "Keep the current plan.");
    ledger.add_active("current active work");
    ledger.add_blocked("current blocker");
    ledger.next_actions = vec!["current next action".into()];
    ledger
        .record_tool_success("read_file", "track-a", &json!({"path": "a"}), 4)
        .expect("record Track A turn");

    let newer = TrackBUpdate::new(77, 6)
        .with_fact("newer fact from turn 6")
        .with_evidence("tool result from turn 6");
    let accepted = ledger.apply_track_b_update(newer, 77);
    assert!(accepted.accepted);
    assert_eq!(accepted.reason, TrackBApplyReason::Applied);

    let out_of_order = TrackBUpdate::new(77, 2)
        .with_fact("stale fact that must not overwrite newer state")
        .with_dead_end("stale dead end");
    let rejected = ledger.apply_track_b_update(out_of_order, 77);
    assert!(!rejected.accepted);
    assert!(matches!(
        rejected.reason,
        TrackBApplyReason::OutOfOrderTurn { .. }
    ));
    assert_eq!(ledger.active, vec!["current active work"]);
    assert_eq!(ledger.blocked, vec!["current blocker"]);
    assert_eq!(ledger.next_actions, vec!["current next action"]);
    assert!(ledger
        .confirmed_facts
        .iter()
        .any(|fact| fact.fact == "newer fact from turn 6"));
    assert!(!ledger
        .confirmed_facts
        .iter()
        .any(|fact| fact.fact.contains("stale fact")));
    assert!(!ledger
        .dead_ends
        .iter()
        .any(|dead_end| dead_end.hypothesis.contains("stale dead end")));
}

#[tokio::test]
async fn microcompact_removes_old_success_logs_but_keeps_errors_diffs_and_tests() {
    let old_success = format!(
        "Compiling worldbase-core v0.1.0\nFinished dev [unoptimized + debuginfo] target(s)\n{}",
        "noise ".repeat(400)
    );
    let exact_error = format!(
        "manifest_invalid: app-capabilities.json missing required id\n{}",
        "context ".repeat(200)
    );
    let diff = format!(
        "diff --git a/app-capabilities.json b/app-capabilities.json\n--- a/app-capabilities.json\n+++ b/app-capabilities.json\n@@ -1,2 +1,2 @@\n-{}\n+{}\n",
        "old ".repeat(200),
        "new ".repeat(200)
    );
    let test_output = format!(
        "cargo test\nthread 'manifest' panicked\ntest result: FAILED. 1 passed; 1 failed\n{}",
        "failure detail ".repeat(100)
    );
    let newest_success = format!(
        "Finished dev build succeeded\n{}",
        "newest-noise ".repeat(200)
    );

    let mut messages = Vec::new();
    for (id, tool, content, is_error) in [
        (
            "old-success",
            "workspace_shell_command",
            old_success.clone(),
            false,
        ),
        (
            "old-error",
            "workspace_shell_command",
            exact_error.clone(),
            true,
        ),
        ("old-diff", "workspace_shell_command", diff.clone(), false),
        (
            "old-test",
            "workspace_shell_command",
            test_output.clone(),
            false,
        ),
        (
            "newest-success",
            "workspace_shell_command",
            newest_success.clone(),
            false,
        ),
    ] {
        messages.push(LlmMessage {
            role: LlmRole::Assistant,
            content: vec![ContentBlock::ToolUse {
                id: id.into(),
                name: tool.into(),
                input: json!({"command": "cargo test"}),
                raw_input: None,
                input_error: None,
            }],
        });
        messages.push(LlmMessage {
            role: LlmRole::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: id.into(),
                content: content.into(),
                is_error,
            }],
        });
    }

    let estimator = TokenEstimator::new();
    let policy = MicrocompactionPolicy {
        keep_newest_results: 1,
        max_result_chars: 300,
        head_chars: 80,
        tail_chars: 80,
        deduplicate_exact_reads_and_logs: false,
    };
    let report = microcompact_messages(&mut messages, &policy, &estimator);

    assert_eq!(report.results_compacted, 1);
    assert!(report.results_preserved >= 4);
    assert!(report.bytes_saved > 0);
    let contents = messages
        .iter()
        .flat_map(|message| message.content.iter())
        .filter_map(|block| match block {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                ..
            } => Some((tool_use_id.as_str(), content.as_str())),
            _ => None,
        })
        .collect::<Vec<_>>();
    let content_for = |tool_use_id: &str| {
        contents
            .iter()
            .find(|(id, _)| *id == tool_use_id)
            .map(|(_, content)| *content)
            .unwrap()
    };

    assert!(content_for("old-success").starts_with("[microcompact:"));
    assert_eq!(content_for("old-error"), exact_error);
    assert_eq!(content_for("old-diff"), diff);
    assert_eq!(content_for("old-test"), test_output);
    assert_eq!(content_for("newest-success"), newest_success);
    for id in [
        "old-success",
        "old-error",
        "old-diff",
        "old-test",
        "newest-success",
    ] {
        assert!(
            messages.iter().any(|message| message.content.iter().any(
                |block| matches!(block, ContentBlock::ToolUse { id: call_id, .. } if call_id == id)
            )),
            "tool call {id} must remain paired"
        );
    }
}

#[tokio::test]
async fn compaction_checkpoint_never_appears_in_provider_system_prompt() {
    let fixture = store_fixture();
    let budget = TokenBudget::fallback_32k();
    let estimator = TokenEstimator::new();
    // Leave ample room above the formal threshold even after the static
    // system prompt and runtime tool schemas are accounted for.
    let target_history_tokens = budget.compaction_threshold_tokens.saturating_mul(2);
    let mut estimated_history_tokens = 0;
    let mut index = 0;
    while estimated_history_tokens < target_history_tokens {
        let role = if index % 2 == 0 {
            Role::User
        } else {
            Role::Assistant
        };
        let payload = format!(
            "history-{index}: {}\nmanifest_invalid: historical error {index}",
            "large-context ".repeat(4_000)
        );
        let llm_role = if role == Role::User {
            LlmRole::User
        } else {
            LlmRole::Assistant
        };
        estimated_history_tokens +=
            estimator.estimate_message(&LlmMessage::text(llm_role, payload.clone()));
        fixture
            .store
            .append_message(&fixture.conversation.id, &message(role, payload))
            .expect("append large history");
        index += 1;
    }
    assert!(
        estimated_history_tokens >= target_history_tokens,
        "test fixture must exceed twice the public compaction threshold"
    );

    let workspace = tempfile::tempdir().expect("create hub workspace");
    let hub = Hub::new(workspace.path().to_path_buf(), fixture.store.clone()).expect("create hub");
    let provider = Arc::new(CapturingCompactionProvider::default());
    hub.set_custom_provider(provider.clone());
    let mut events = hub.event_tx.subscribe();
    let run = start_chat(
        hub.clone(),
        fixture.conversation.id.clone(),
        "latest real user request: keep summary evidence out of the system prompt".to_string(),
        Vec::new(),
        Capabilities {
            platform: "cli".into(),
            features: Vec::new(),
            excludes: vec![
                "subprocess".into(),
                "port_binding".into(),
                "webhook_receiver".into(),
            ],
        },
        false,
        None,
        None,
        None,
        ChatRunContext {
            // Keep the static tool catalog small enough that compaction can
            // actually reduce the request; this is not about tool behavior.
            // A non-empty allow list that matches no executable tool leaves
            // only the runtime completion/discovery tools in the request.
            allowed_tool_names: vec!["__no_tools_for_context_compaction_test__".into()],
            ..ChatRunContext::default()
        },
    )
    .expect("start compaction chat");

    let terminal = tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            let frame = events.recv().await.expect("event channel");
            if frame.stream_id != run.stream_id {
                continue;
            }
            if matches!(
                frame.kind,
                worldbase_protocol::event::EventKind::Done { .. }
            ) {
                return Ok::<_, String>(());
            }
            if let worldbase_protocol::event::EventKind::Error { message } = frame.kind {
                return Err(message);
            }
        }
    })
    .await
    .expect("chat should terminate within the test timeout");
    terminal.expect("chat should complete without an error event");

    let requests = provider.requests();
    assert!(
        requests.iter().any(|request| is_compaction_summary_request(
            request.system.as_deref(),
            &request.messages
        )),
        "the oversized history must trigger a compaction summary request"
    );
    for request in &requests {
        assert!(
            !request
                .system
                .as_deref()
                .unwrap_or_default()
                .contains("CHECKPOINT_SENTINEL_SYSTEM_PROMPT_BOUNDARY"),
            "checkpoint text must never be inserted into a system prompt"
        );
    }
    assert!(
        requests
            .iter()
            .any(|request| request.messages.iter().any(|message| {
                message.role == LlmRole::User
                    && message
                        .text_view()
                        .contains("CHECKPOINT_SENTINEL_SYSTEM_PROMPT_BOUNDARY")
            })),
        "checkpoint content should be present only as user-role evidence"
    );
}

// A persisted user-role carrier with both a tool result and an image part.
fn tool_image_result(call_id: &str, url: &str) -> ChatMessage {
    ChatMessage {
        id: 0,
        role: Role::User,
        content: String::new(),
        parts: vec![ChatContentPart::ImageUrl {
            image_url: ImageUrl { url: url.into() },
        }],
        tool_calls: Vec::new(),
        tool_results: vec![ToolResultRecord {
            tool_call_id: call_id.into(),
            name: "computer_observe".into(),
            content: "[image]".into(),
            is_error: false,
        }],
        created_at: None,
    }
}
