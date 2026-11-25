//! Focused Manager-level integration tests for the reusable context engine.

use std::sync::Arc;
use std::time::Duration;

use worldbase_core::context::candidate::CandidateManager;
use worldbase_core::context::engine::{
    assemble_request_with_evidence_tail, assemble_request_with_evidence_tail_counted,
    assemble_request_without_ledger_tail_counted,
};
use worldbase_core::context::{
    apply_tool_result_capability_snapshot, assemble_request, microcompact, AttemptOutcome,
    CompactionCandidate, CompactionCheckpoint, CompactionNoteState, CompactionVersion,
    KnowledgeGap, MicrocompactOptions, OverflowCompactionGuard, OverflowDecision, RunStateLedger,
    TokenBudget, TokenEstimator, TrackBExtractionInput, TrackBExtractionSource, TrackBExtractor,
    TrackBUpdate, UserAnchors,
};
use worldbase_protocol::types::{ChatContentPart, ChatMessage, ImageUrl, Role, ToolResultRecord};
use worldbase_providers::{
    ChatOptions, ChunkStream, ContentBlock, LlmMessage, LlmRole, LlmTool, Provider, StreamChunk,
    TokenUsage,
};

fn checkpoint_for(ledger: &RunStateLedger) -> CompactionCheckpoint {
    let fallback = worldbase_core::context::engine::checkpoint_fallback_from_ledger(ledger);
    CompactionCheckpoint::from_fallback("checkpoint-1", "conversation-1", &fallback)
}

#[test]
fn fallback_32k_budget_reserves_output_and_stays_within_window() {
    let budget = TokenBudget::fallback_32k();
    assert_eq!(budget.actual_max_output_tokens, 8_192);
    assert!(budget.safety_margin_tokens > 0);
    assert!(
        budget.available_input_tokens
            + budget.actual_max_output_tokens
            + budget.safety_margin_tokens
            <= budget.context_window_tokens
    );
    assert!(budget.background_threshold_tokens * 100 >= budget.available_input_tokens * 60);
    assert!(budget.background_threshold_tokens * 100 <= budget.available_input_tokens * 65);
    assert!(budget.compaction_threshold_tokens * 100 >= budget.available_input_tokens * 80);
    assert!(budget.compaction_threshold_tokens * 100 <= budget.available_input_tokens * 85);
}

#[test]
fn synthetic_and_tool_image_messages_cannot_move_real_user_anchors() {
    let history = vec![
        ChatMessage {
            id: 11,
            role: Role::User,
            content: "original request".into(),
            parts: vec![],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        },
        ChatMessage {
            id: 12,
            role: Role::User,
            content: "latest real request".into(),
            parts: vec![],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        },
        ChatMessage {
            id: 13,
            role: Role::User,
            content: String::new(),
            parts: vec![ChatContentPart::ImageUrl {
                image_url: ImageUrl {
                    url: "data:image/png;base64,AAAA".into(),
                },
            }],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        },
        ChatMessage {
            id: 0,
            role: Role::User,
            content: "[WAKE_UP] synthetic".into(),
            parts: vec![],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        },
        ChatMessage {
            id: 14,
            role: Role::User,
            content: String::new(),
            parts: vec![],
            tool_calls: vec![],
            tool_results: vec![ToolResultRecord {
                tool_call_id: "call-1".into(),
                name: "read_file".into(),
                content: "tool output".into(),
                is_error: false,
            }],
            created_at: None,
        },
    ];

    let anchors = UserAnchors::from_chat_history(&history);
    assert_eq!(anchors.original.unwrap().message_id, 11);
    assert_eq!(anchors.latest.unwrap().text, "latest real request");
}

#[test]
fn exact_errors_and_track_b_versions_are_deterministic() {
    let mut ledger = RunStateLedger::from_real_user_request("objective", 1, "objective");
    let args = serde_json::json!({ "manifest": ".worldbase/app-capabilities.json" });
    let exact = "manifest_invalid: risk must be one of read|write|destructive";
    for turn in 1..=5 {
        let _ = ledger.record_tool_attempt(
            "upgrade_project",
            format!("call-{turn}"),
            &args,
            AttemptOutcome::Error,
            exact,
            turn,
        );
    }
    let rendered = ledger.render_markdown();
    assert_eq!(rendered.matches(exact).count(), 1);
    assert!(rendered.contains("count: 5"));

    let accepted = TrackBUpdate::new(9, 6)
        .with_fact("capability is discoverable")
        .with_evidence("call-6");
    assert!(ledger.apply_track_b_update(accepted, 9).accepted);
    let stale = TrackBUpdate::new(8, 7)
        .with_fact("stale fact")
        .with_evidence("call-7");
    assert!(!ledger.apply_track_b_update(stale, 9).accepted);
    assert!(!ledger.render_markdown().contains("stale fact"));
}

#[test]
fn checkpoint_and_ledger_are_user_evidence_not_system_context() {
    let mut ledger = RunStateLedger::from_real_user_request("objective", 7, "full objective");
    ledger.add_requirement("preserve exact evidence");
    let mut checkpoint = checkpoint_for(&ledger);
    checkpoint.knowledge_gaps = vec![KnowledgeGap::new(
        "old shell output",
        "manifest_invalid upgrade_project",
    )];
    let recent = vec![LlmMessage::text(LlmRole::User, "latest request")];
    let request = assemble_request("conversation-1", Some(&checkpoint), &ledger, &recent);

    assert!(request
        .iter()
        .any(|message| message.text_view().contains("CONTEXT_CHECKPOINT")));
    assert!(request
        .iter()
        .any(|message| message.text_view().contains("TRANSCRIPT_REFERENCE")));
    assert!(request
        .iter()
        .any(|message| message.text_view().contains("Run State Ledger")));
    assert!(request
        .iter()
        .all(|message| message.role == LlmRole::User || message.role == LlmRole::Assistant));
    let system = "base system prompt only";
    assert!(!system.contains(&checkpoint.summary));
}

#[test]
fn changing_run_evidence_keeps_the_checkpoint_and_history_prefix() {
    let mut ledger = RunStateLedger::from_real_user_request("objective", 7, "full objective");
    let checkpoint = checkpoint_for(&ledger);
    let mut history = vec![LlmMessage::text(LlmRole::User, "Review the project")];
    let mut compaction_note = CompactionNoteState::new();
    compaction_note.arm(&checkpoint);
    let before = assemble_request_with_evidence_tail(
        "conversation-1",
        Some(&checkpoint),
        &ledger,
        &history,
        compaction_note.drain_for_provider_request(),
    );
    ledger
        .record_tool_attempt(
            "read_file",
            "read-1",
            &serde_json::json!({ "path": "src/main.rs" }),
            AttemptOutcome::Success,
            "file content",
            1,
        )
        .unwrap();
    history.extend([
        LlmMessage {
            role: LlmRole::Assistant,
            content: vec![ContentBlock::ToolUse {
                id: "read-1".into(),
                name: "read_file".into(),
                input: serde_json::json!({ "path": "src/main.rs" }),
                raw_input: None,
                input_error: None,
            }],
        },
        LlmMessage {
            role: LlmRole::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "read-1".into(),
                content: "file content".into(),
                is_error: false,
            }],
        },
    ]);
    let after = assemble_request_with_evidence_tail(
        "conversation-1",
        Some(&checkpoint),
        &ledger,
        &history,
        compaction_note.drain_for_provider_request(),
    );

    assert_eq!(
        serde_json::to_value(&before[..3]).unwrap(),
        serde_json::to_value(&after[..3]).unwrap()
    );
    assert_ne!(before[3].text_view(), after[5].text_view());
    assert_eq!(after[5].role, LlmRole::User);
    assert!(after[5].text_view().contains("read_file"));
    assert_eq!(
        serde_json::to_value(&after[3..5]).unwrap(),
        serde_json::to_value(&history[1..]).unwrap()
    );
    assert!(before
        .last()
        .unwrap()
        .text_view()
        .contains("COMPACTION_NOTE"));
    assert!(after
        .iter()
        .all(|message| !message.text_view().contains("COMPACTION_NOTE")));
}

#[test]
fn tail_evidence_reports_the_stable_cache_prefix() {
    let ledger = RunStateLedger::from_real_user_request("objective", 7, "full objective");
    let checkpoint = checkpoint_for(&ledger);
    let history = vec![
        LlmMessage::text(LlmRole::User, "Review the project"),
        LlmMessage {
            role: LlmRole::Assistant,
            content: vec![ContentBlock::ToolUse {
                id: "read-1".into(),
                name: "read_file".into(),
                input: serde_json::json!({ "path": "src/main.rs" }),
                raw_input: None,
                input_error: None,
            }],
        },
        LlmMessage {
            role: LlmRole::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "read-1".into(),
                content: "file content".into(),
                is_error: false,
            }],
        },
    ];
    let (request, prefix) = assemble_request_with_evidence_tail_counted(
        "conversation-1",
        Some(&checkpoint),
        &ledger,
        &history,
        None,
    );

    assert_eq!(prefix, 2 + history.len());
    assert_eq!(request[prefix - 1].role, LlmRole::User);
    assert_eq!(request[prefix].role, LlmRole::User);
    assert!(request[prefix].text_view().contains("Run State Ledger"));
    assert_eq!(
        serde_json::to_value(&request[..prefix]).unwrap(),
        serde_json::to_value(
            [
                checkpoint.user_message(),
                worldbase_core::context::engine::transcript_reference_message(
                    "conversation-1",
                    &checkpoint,
                ),
            ]
            .into_iter()
            .chain(history.clone())
            .collect::<Vec<_>>()
        )
        .unwrap()
    );
}

#[test]
fn tail_note_without_ledger_keeps_the_prefix_free_of_ledger_text() {
    let ledger = RunStateLedger::from_real_user_request("objective", 7, "full objective");
    let checkpoint = checkpoint_for(&ledger);
    let history = vec![
        LlmMessage::text(LlmRole::User, "Review the project"),
        LlmMessage {
            role: LlmRole::Assistant,
            content: vec![ContentBlock::ToolUse {
                id: "read-1".into(),
                name: "read_file".into(),
                input: serde_json::json!({ "path": "src/main.rs" }),
                raw_input: None,
                input_error: None,
            }],
        },
        LlmMessage {
            role: LlmRole::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "read-1".into(),
                content: "file content".into(),
                is_error: false,
            }],
        },
    ];
    let note = LlmMessage::text(LlmRole::User, "COMPACTION_NOTE");
    let (request, prefix) = assemble_request_without_ledger_tail_counted(
        "conversation-1",
        Some(&checkpoint),
        &history,
        Some(note),
    );

    assert_eq!(prefix, 2 + history.len());
    assert_eq!(request.len(), prefix + 1);
    assert!(request[..prefix]
        .iter()
        .all(|message| !message.text_view().contains("Run State Ledger")));
    assert!(request[prefix].text_view().contains("COMPACTION_NOTE"));
}

#[test]
fn background_candidate_requires_every_version_component() {
    let version = CompactionVersion::new(1, "model-a", "prompt-a", 2, "provider-a", "owner-a");
    let mut manager = CandidateManager::new(version.clone());
    let candidate = CompactionCandidate::new(1, version, "summary", None, 10_000, 4_000);
    manager.install_candidate(candidate).unwrap();
    let changed = CompactionVersion::new(2, "model-a", "prompt-a", 2, "provider-a", "owner-a");
    assert!(manager.set_current_version(changed).is_some());
    assert!(manager.adopt_candidate().is_err());
}

#[test]
fn overflow_guard_allows_exactly_one_emergency_compaction_per_step() {
    let mut guard = OverflowCompactionGuard::new();
    assert_eq!(guard.on_overflow(4), OverflowDecision::EmergencyCompaction);
    assert_eq!(guard.on_overflow(4), OverflowDecision::Terminate);
    assert_eq!(guard.on_overflow(5), OverflowDecision::EmergencyCompaction);
}

#[test]
fn microcompact_keeps_errors_and_diffs_and_bounds_success_logs() {
    let estimator = TokenEstimator::new();
    let mut messages = Vec::new();
    for (id, name, content, is_error) in [
        (
            "build-1",
            "run_command",
            "Compiling old\n".repeat(400),
            false,
        ),
        (
            "error-1",
            "run_command",
            "manifest_invalid: exact error".repeat(80),
            true,
        ),
        (
            "diff-1",
            "apply_patch",
            "diff --git a/x b/x\n+fixed\n".repeat(80),
            false,
        ),
    ] {
        messages.push(LlmMessage {
            role: LlmRole::Assistant,
            content: vec![ContentBlock::ToolUse {
                id: id.into(),
                name: name.into(),
                input: serde_json::json!({ "path": "x" }),
                raw_input: None,
                input_error: None,
            }],
        });
        messages.push(LlmMessage {
            role: LlmRole::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: id.into(),
                content: content.clone(),
                is_error,
            }],
        });
    }
    let report = microcompact(
        &mut messages,
        &MicrocompactOptions {
            keep_newest_results: 0,
            ..MicrocompactOptions::default()
        },
        &estimator,
    );
    let text = serde_json::to_string(&messages).unwrap();
    assert!(report.results_compacted > 0);
    assert!(text.contains("manifest_invalid: exact error"));
    assert!(text.contains("diff --git"));
}

struct SemanticTestProvider {
    response: String,
}

#[async_trait::async_trait]
impl Provider for SemanticTestProvider {
    fn name(&self) -> &str {
        "semantic-track-b-test"
    }

    fn model(&self) -> &str {
        "semantic-track-b-test-model"
    }

    async fn chat_stream(
        &self,
        _system: Option<&str>,
        _messages: Vec<LlmMessage>,
        _tools: Vec<LlmTool>,
        _max_tokens: u32,
        _options: ChatOptions,
    ) -> anyhow::Result<ChunkStream> {
        Ok(Box::pin(futures::stream::iter([Ok(
            StreamChunk::Completed {
                stop_reason: "end_turn".into(),
                assistant: LlmMessage::text(LlmRole::Assistant, self.response.clone()),
                usage: TokenUsage::default(),
            },
        )])))
    }
}

#[tokio::test]
async fn track_b_semantic_provider_uses_strict_json_and_falls_back_on_invalid_schema() {
    let input = || {
        TrackBExtractionInput::new(
            41,
            7,
            "read_file",
            "call-7",
            serde_json::json!({ "path": "src/lib.rs" }),
            r#"{"status":"ok","path":"src/lib.rs"}"#,
            false,
        )
    };
    let extractor = TrackBExtractor::new(
        Arc::new(SemanticTestProvider {
            response: r#"{"facts":["src/lib.rs exists","status is ok"],"deadEnd":null}"#.into(),
        }),
        Some("session-41".into()),
        Duration::from_secs(1),
        1,
    );
    let valid = extractor
        .extract(input(), &tokio_util::sync::CancellationToken::new())
        .await;
    assert_eq!(valid.source, TrackBExtractionSource::Provider);
    assert_eq!(valid.update.history_version, 41);
    assert_eq!(valid.update.turn, 7);
    assert_eq!(valid.update.facts.len(), 2);

    let invalid_extractor = TrackBExtractor::new(
        Arc::new(SemanticTestProvider {
            response: r#"{"facts":["one"],"deadEnd":null,"extra":true}"#.into(),
        }),
        Some("session-41".into()),
        Duration::from_secs(1),
        1,
    );
    let fallback = invalid_extractor
        .extract(input(), &tokio_util::sync::CancellationToken::new())
        .await;
    assert_eq!(fallback.source, TrackBExtractionSource::HeuristicFallback);
    assert_eq!(fallback.update.history_version, 41);
    assert_eq!(fallback.update.turn, 7);
    assert!(!fallback.update.facts.is_empty());
}

#[test]
fn compaction_note_is_one_turn_user_evidence_with_gaps_and_recall_hint() {
    let mut checkpoint = checkpoint_for(&RunStateLedger::from_real_user_request(
        "objective",
        1,
        "objective",
    ));
    checkpoint.knowledge_gaps = vec![KnowledgeGap::new(
        "turn 3 shell output",
        "manifest_invalid upgrade_project",
    )];
    let mut state = CompactionNoteState::new();
    state.arm(&checkpoint);

    let note = state.drain_for_provider_request().expect("one note");
    assert_eq!(note.role, LlmRole::User);
    let text = note.text_view();
    assert!(text.contains("COMPACTION_NOTE"));
    assert!(text.contains("turn 3 shell output"));
    assert!(text.contains("manifest_invalid upgrade_project"));
    assert!(text.contains("recall_context"));
    assert!(text.contains("read_transcript_range"));
    assert!(text.contains("search_transcript"));
    assert!(state.drain_for_provider_request().is_none());
}

#[test]
fn capability_results_populate_the_ledger_snapshot_deterministically() {
    let mut ledger = RunStateLedger::new("inspect capabilities");
    let status = serde_json::json!({
        "aiApplication": {
            "status": "ready",
            "capabilityDetails": [
                {"id": "z.cap", "title": "Z", "risk": "read"},
                {"id": "a.cap", "title": "A", "risk": "write"}
            ]
        }
    });
    assert!(apply_tool_result_capability_snapshot(
        &mut ledger,
        "get_project_status",
        &status
    ));
    assert_eq!(
        ledger
            .capabilities
            .iter()
            .map(|capability| capability.id.as_str())
            .collect::<Vec<_>>(),
        vec!["a.cap", "z.cap"]
    );
    assert!(ledger
        .capabilities
        .iter()
        .all(|capability| capability.availability == "ready"));

    let search = serde_json::json!({
        "candidates": [
            {"capabilityId": "docs.read", "title": "Read document", "risk": "read", "toolName": "app__docs__read"}
        ],
        "activated": ["app__docs__read"]
    });
    assert!(apply_tool_result_capability_snapshot(
        &mut ledger,
        "search_tools",
        &search
    ));
    assert_eq!(ledger.capabilities.len(), 1);
    assert_eq!(ledger.capabilities[0].id, "docs.read");
    assert_eq!(ledger.capabilities[0].availability, "active");
}
