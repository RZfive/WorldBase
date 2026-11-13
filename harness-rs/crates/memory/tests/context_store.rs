use std::collections::HashSet;
use std::path::PathBuf;

use serde_json::json;
use worldbase_memory::{Store, StoredCompactionCheckpoint};
use worldbase_protocol::types::{ChatMessage, Role, ToolCallRecord, ToolResultRecord};

struct TestDb {
    root: PathBuf,
}

impl TestDb {
    fn new() -> Self {
        Self {
            root: std::env::temp_dir().join(format!(
                "worldbase-memory-context-store-{}",
                uuid::Uuid::new_v4()
            )),
        }
    }

    fn path(&self) -> PathBuf {
        self.root.join("app.sqlite")
    }
}

impl Drop for TestDb {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn message(role: Role, content: impl Into<String>) -> ChatMessage {
    ChatMessage {
        id: 0,
        role,
        content: content.into(),
        parts: vec![],
        tool_calls: vec![],
        tool_results: vec![],
        created_at: None,
    }
}

fn checkpoint(id: &str, conversation_id: &str, created_at: &str) -> StoredCompactionCheckpoint {
    StoredCompactionCheckpoint {
        id: id.into(),
        conversation_id: conversation_id.into(),
        summary: "The transcript boundary is durable.".into(),
        knowledge_gaps_json:
            r#"{"gaps":["manifest_invalid: expected \"name\""],"confidence":0.42}"#.into(),
        ledger_json:
            r#"{"requirements":["keep exact evidence"],"active":["inspect"],"deadEnds":[]}"#.into(),
        first_kept_message_id: 103,
        last_summarized_message_id: 99,
        history_version: 41,
        model_slug: "gpt-5.1-codex".into(),
        prompt_hash: "sha256:prompt-contract-v7".into(),
        tool_catalog_version: 23,
        created_at: created_at.into(),
    }
}

#[test]
fn opening_an_existing_database_twice_is_migration_safe_and_tables_work_after_reopen() {
    let db = TestDb::new();
    let path = db.path();

    let conversation_id = {
        let store = Store::open(&path).unwrap();
        let conversation = store.create_conversation("reopen", None).unwrap();
        store
            .append_message(
                &conversation.id,
                &message(Role::User, "persist across reopen"),
            )
            .unwrap();
        conversation.id
    };

    let store = Store::open(&path).unwrap();
    let messages = store.list_messages(&conversation_id, 10).unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].content, "persist across reopen");

    let saved = checkpoint(
        "checkpoint-after-reopen",
        &conversation_id,
        "2026-11-13T01:02:03Z",
    );
    store.save_compaction_checkpoint(&saved).unwrap();
    assert_eq!(
        store
            .latest_compaction_checkpoint(&conversation_id)
            .unwrap(),
        Some(saved)
    );

    let metric_id = store
        .record_compaction_metric(&conversation_id, "reopen", 1_000, 250, 37)
        .unwrap();
    assert!(metric_id > 0);
    let metrics = store.list_compaction_metrics(&conversation_id, 10).unwrap();
    assert_eq!(metrics.len(), 1);
    assert_eq!(metrics[0].id, metric_id);
    assert_eq!(metrics[0].before_tokens, 1_000);
    assert_eq!(metrics[0].after_tokens, 250);
    assert_eq!(metrics[0].latency_ms, 37);
}

#[test]
fn english_fts_search_returns_ids_and_snippets_and_is_conversation_scoped() {
    let db = TestDb::new();
    let store = Store::open(&db.path()).unwrap();
    let first = store.create_conversation("first", None).unwrap();
    let second = store.create_conversation("second", None).unwrap();

    let first_id = store
        .append_message(
            &first.id,
            &message(
                Role::User,
                "The velvetorbit deployment finished with a warning.",
            ),
        )
        .unwrap();
    let second_id = store
        .append_message(
            &second.id,
            &message(
                Role::Assistant,
                "A separate velvetorbit note belongs to another conversation.",
            ),
        )
        .unwrap();

    let hits = store
        .search_messages(&first.id, "velvetorbit", None, None, 10)
        .unwrap();
    assert!(hits.iter().any(|hit| {
        hit.id == first_id
            && hit.role == "user"
            && hit.content.contains("deployment finished")
            && hit.snippet.to_lowercase().contains("velvetorbit")
            && !hit.created_at.is_empty()
    }));
    assert!(hits.iter().all(|hit| hit.id != second_id));

    let second_hits = store
        .search_messages(&second.id, "velvetorbit", None, None, 10)
        .unwrap();
    assert!(second_hits.iter().any(|hit| hit.id == second_id));
    assert!(second_hits.iter().all(|hit| hit.id != first_id));
}

#[test]
fn contiguous_cjk_search_uses_the_like_fallback() {
    let db = TestDb::new();
    let store = Store::open(&db.path()).unwrap();
    let conversation = store.create_conversation("cjk", None).unwrap();
    let message_id = store
        .append_message(
            &conversation.id,
            &message(Role::User, "发布前必须检查缓存配置避免覆盖"),
        )
        .unwrap();

    let hits = store
        .search_messages(&conversation.id, "缓存配置", None, None, 10)
        .unwrap();
    assert!(hits.iter().any(|hit| {
        hit.id == message_id
            && hit.content.contains("发布前必须检查")
            && hit.snippet.contains("缓存配置")
    }));
}

#[test]
fn mixed_cjk_unspaced_search_keeps_later_authoritative_like_hit_under_limit() {
    let db = TestDb::new();
    let store = Store::open(&db.path()).unwrap();
    let first = store.create_conversation("mixed cjk", None).unwrap();
    let second = store
        .create_conversation("foreign mixed cjk", None)
        .unwrap();

    let unspaced_id = store
        .append_message(
            &first.id,
            &message(
                Role::User,
                "Before the failure: 缓存配置manifest_invalid remains in the exact unspaced row.",
            ),
        )
        .unwrap();
    let spaced_id = store
        .append_message(
            &first.id,
            &message(
                Role::Assistant,
                "Authoritative evidence: 缓存配置 manifest_invalid appears with a separator.",
            ),
        )
        .unwrap();
    let foreign_id = store
        .append_message(
            &second.id,
            &message(
                Role::User,
                "Foreign duplicate: 缓存配置manifest_invalid must never leak.",
            ),
        )
        .unwrap();
    assert!(unspaced_id < spaced_id);

    let hits = store
        .search_messages(&first.id, "缓存配置manifest_invalid", None, None, 2)
        .unwrap();
    assert_eq!(
        hits.iter().map(|hit| hit.id).collect::<Vec<_>>(),
        vec![unspaced_id, spaced_id]
    );
    assert!(hits.iter().all(|hit| !hit.snippet.trim().is_empty()));
    assert!(hits
        .iter()
        .find(|hit| hit.id == unspaced_id)
        .unwrap()
        .snippet
        .contains("缓存配置manifest_invalid"));
    assert!(hits
        .iter()
        .find(|hit| hit.id == spaced_id)
        .unwrap()
        .snippet
        .contains("缓存配置 manifest_invalid"));
    assert!(hits.iter().all(|hit| hit.id != foreign_id));
}

#[test]
fn role_tool_matches_only_tool_result_carriers() {
    let db = TestDb::new();
    let store = Store::open(&db.path()).unwrap();
    let first = store.create_conversation("tool role", None).unwrap();
    let second = store
        .create_conversation("foreign tool role", None)
        .unwrap();

    let plain_id = store
        .append_message(
            &first.id,
            &message(Role::User, "toolrolequasar appears as ordinary plain text."),
        )
        .unwrap();
    let call_only_id = store
        .append_message(
            &first.id,
            &ChatMessage {
                id: 0,
                role: Role::Assistant,
                content: "toolrolequasar mentions a call but carries no result.".into(),
                parts: vec![],
                tool_calls: vec![ToolCallRecord {
                    id: "call-tool-role".into(),
                    name: "write_file".into(),
                    args: json!({"path": "notes.txt"}),
                }],
                tool_results: vec![],
                created_at: None,
            },
        )
        .unwrap();
    let carrier_id = store
        .append_message(
            &first.id,
            &ChatMessage {
                id: 0,
                role: Role::User,
                content: String::new(),
                parts: vec![],
                tool_calls: vec![],
                tool_results: vec![ToolResultRecord {
                    tool_call_id: "call-tool-role".into(),
                    name: "lookup_inventory".into(),
                    content: "toolrolequasar: distinctive amber-42 evidence".into(),
                    is_error: false,
                }],
                created_at: None,
            },
        )
        .unwrap();
    let foreign_id = store
        .append_message(
            &second.id,
            &ChatMessage {
                id: 0,
                role: Role::User,
                content: String::new(),
                parts: vec![],
                tool_calls: vec![],
                tool_results: vec![ToolResultRecord {
                    tool_call_id: "call-tool-role-foreign".into(),
                    name: "lookup_inventory".into(),
                    content: "toolrolequasar: foreign amber-42 evidence".into(),
                    is_error: false,
                }],
                created_at: None,
            },
        )
        .unwrap();

    let hits = store
        .search_messages(&first.id, "toolrolequasar", Some("tool"), None, 10)
        .unwrap();
    assert_eq!(
        hits.iter().map(|hit| hit.id).collect::<Vec<_>>(),
        vec![carrier_id]
    );
    assert_eq!(hits[0].role, "user");
    assert!(hits[0].snippet.contains("distinctive amber-42 evidence"));
    assert!(hits
        .iter()
        .all(|hit| hit.id != plain_id && hit.id != call_only_id && hit.id != foreign_id));

    let filtered = store
        .search_messages(
            &first.id,
            "toolrolequasar",
            Some("tool"),
            Some("lookup_inventory"),
            10,
        )
        .unwrap();
    assert_eq!(
        filtered.iter().map(|hit| hit.id).collect::<Vec<_>>(),
        vec![carrier_id]
    );

    let call_only_filtered = store
        .search_messages(
            &first.id,
            "toolrolequasar",
            Some("tool"),
            Some("write_file"),
            10,
        )
        .unwrap();
    assert!(call_only_filtered.is_empty());
}

#[test]
fn tool_result_text_and_tool_names_are_searchable_and_filterable() {
    let db = TestDb::new();
    let store = Store::open(&db.path()).unwrap();
    let conversation = store.create_conversation("tools", None).unwrap();

    let assistant_id = store
        .append_message(
            &conversation.id,
            &ChatMessage {
                id: 0,
                role: Role::Assistant,
                content: "Dispatching an inventory lookup.".into(),
                parts: vec![],
                tool_calls: vec![ToolCallRecord {
                    id: "call-inventory-1".into(),
                    name: "lookup_inventory".into(),
                    args: json!({"sku": "SKU-991"}),
                }],
                tool_results: vec![],
                created_at: None,
            },
        )
        .unwrap();
    let result_id = store
        .append_message(
            &conversation.id,
            &ChatMessage {
                id: 0,
                role: Role::User,
                content: String::new(),
                parts: vec![],
                tool_calls: vec![],
                tool_results: vec![ToolResultRecord {
                    tool_call_id: "call-inventory-1".into(),
                    name: "lookup_inventory".into(),
                    content: "The amber reserve contains SKU-991.".into(),
                    is_error: false,
                }],
                created_at: None,
            },
        )
        .unwrap();

    let result_hits = store
        .search_messages(&conversation.id, "amber", None, None, 10)
        .unwrap();
    assert!(result_hits.iter().any(|hit| hit.id == result_id));

    let tool_name_hits = store
        .search_messages(&conversation.id, "lookup_inventory", None, None, 10)
        .unwrap();
    assert!(tool_name_hits
        .iter()
        .any(|hit| hit.id == result_id || hit.id == assistant_id));

    let filtered = store
        .search_messages(
            &conversation.id,
            "amber",
            None,
            Some("lookup_inventory"),
            10,
        )
        .unwrap();
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].id, result_id);

    let wrong_tool = store
        .search_messages(&conversation.id, "amber", None, Some("write_file"), 10)
        .unwrap();
    assert!(wrong_tool.is_empty());
}

#[test]
fn role_filtering_works_and_other_conversations_never_leak() {
    let db = TestDb::new();
    let store = Store::open(&db.path()).unwrap();
    let first = store.create_conversation("first", None).unwrap();
    let second = store.create_conversation("second", None).unwrap();

    let user_id = store
        .append_message(
            &first.id,
            &message(Role::User, "rolefilterquasar from the user"),
        )
        .unwrap();
    let assistant_id = store
        .append_message(
            &first.id,
            &message(Role::Assistant, "rolefilterquasar from the assistant"),
        )
        .unwrap();
    let foreign_id = store
        .append_message(
            &second.id,
            &message(Role::User, "rolefilterquasar from another conversation"),
        )
        .unwrap();

    let user_hits = store
        .search_messages(&first.id, "rolefilterquasar", Some("user"), None, 10)
        .unwrap();
    assert_eq!(user_hits.len(), 1);
    assert_eq!(user_hits[0].id, user_id);

    let assistant_hits = store
        .search_messages(&first.id, "rolefilterquasar", Some("assistant"), None, 10)
        .unwrap();
    assert_eq!(assistant_hits.len(), 1);
    assert_eq!(assistant_hits[0].id, assistant_id);

    let all_hits = store
        .search_messages(&first.id, "rolefilterquasar", None, None, 10)
        .unwrap();
    let ids: HashSet<_> = all_hits.iter().map(|hit| hit.id).collect();
    assert_eq!(ids, HashSet::from([user_id, assistant_id]));
    assert!(!ids.contains(&foreign_id));
}

#[test]
fn read_message_range_is_chronological_owned_and_preserves_tool_carriers() {
    let db = TestDb::new();
    let store = Store::open(&db.path()).unwrap();
    let conversation = store.create_conversation("range", None).unwrap();
    let other = store.create_conversation("other", None).unwrap();

    let before_id = store
        .append_message(
            &conversation.id,
            &message(Role::User, "message before carrier"),
        )
        .unwrap();
    let call_id = store
        .append_message(
            &conversation.id,
            &ChatMessage {
                id: 0,
                role: Role::Assistant,
                content: "assistant tool-call carrier".into(),
                parts: vec![],
                tool_calls: vec![ToolCallRecord {
                    id: "call-range-1".into(),
                    name: "read_file".into(),
                    args: json!({"path": "notes.txt"}),
                }],
                tool_results: vec![],
                created_at: None,
            },
        )
        .unwrap();
    let result_id = store
        .append_message(
            &conversation.id,
            &ChatMessage {
                id: 0,
                role: Role::User,
                content: String::new(),
                parts: vec![],
                tool_calls: vec![],
                tool_results: vec![ToolResultRecord {
                    tool_call_id: "call-range-1".into(),
                    name: "read_file".into(),
                    content: "line alpha\nline beta".into(),
                    is_error: false,
                }],
                created_at: None,
            },
        )
        .unwrap();
    let after_id = store
        .append_message(
            &conversation.id,
            &message(Role::Assistant, "message after carrier"),
        )
        .unwrap();
    store
        .append_message(&conversation.id, &message(Role::User, "outside range"))
        .unwrap();
    let foreign_id = store
        .append_message(&other.id, &message(Role::User, "foreign anchor"))
        .unwrap();

    let range = store
        .read_message_range(&conversation.id, result_id, 1, 1)
        .unwrap();
    assert_eq!(
        range.iter().map(|entry| entry.id).collect::<Vec<_>>(),
        vec![call_id, result_id, after_id]
    );
    assert_eq!(range[0].role, Role::Assistant);
    assert_eq!(range[0].tool_calls.len(), 1);
    assert_eq!(range[0].tool_calls[0].id, "call-range-1");
    assert_eq!(range[0].tool_calls[0].name, "read_file");
    assert_eq!(range[0].tool_calls[0].args, json!({"path": "notes.txt"}));
    assert_eq!(range[1].role, Role::User);
    assert!(range[1].content.is_empty());
    assert_eq!(range[1].tool_results.len(), 1);
    assert_eq!(range[1].tool_results[0].tool_call_id, "call-range-1");
    assert_eq!(range[1].tool_results[0].name, "read_file");
    assert_eq!(range[1].tool_results[0].content, "line alpha\nline beta");
    assert!(!range[1].tool_results[0].is_error);
    assert!(range.iter().all(|entry| entry.id != before_id));

    assert!(store
        .read_message_range(&conversation.id, foreign_id, 1, 1)
        .is_err());
}

#[test]
fn checkpoint_round_trips_every_field_and_latest_wins() {
    let db = TestDb::new();
    let store = Store::open(&db.path()).unwrap();
    let conversation = store.create_conversation("checkpoints", None).unwrap();
    let other = store
        .create_conversation("other checkpoints", None)
        .unwrap();

    let first = checkpoint("checkpoint-first", &conversation.id, "2026-11-13T01:00:00Z");
    store.save_compaction_checkpoint(&first).unwrap();
    assert_eq!(
        store
            .latest_compaction_checkpoint(&conversation.id)
            .unwrap(),
        Some(first.clone())
    );
    assert_eq!(store.latest_compaction_checkpoint(&other.id).unwrap(), None);

    let second = StoredCompactionCheckpoint {
        id: "checkpoint-second".into(),
        conversation_id: conversation.id.clone(),
        summary: "A newer summary replaces the first without losing fields.".into(),
        knowledge_gaps_json:
            r#"{"gaps":["missing deployment output"],"confidence":0.875}"#.into(),
        ledger_json:
            r#"{"requirements":["preserve exact text"],"attempts":[{"id":2}],"deadEnds":["old parser"]}"#
                .into(),
        first_kept_message_id: 1_234,
        last_summarized_message_id: 1_200,
        history_version: 4_294_967_296,
        model_slug: "claude-sonnet-contract".into(),
        prompt_hash: "sha256:compaction-contract-v9".into(),
        tool_catalog_version: 9_007_199_254_740_993,
        created_at: "2026-11-13T02:00:00Z".into(),
    };
    store.save_compaction_checkpoint(&second).unwrap();

    assert_eq!(
        store
            .latest_compaction_checkpoint(&conversation.id)
            .unwrap(),
        Some(second)
    );
}

#[test]
fn metrics_round_trip_are_conversation_scoped_and_newest_first() {
    let db = TestDb::new();
    let store = Store::open(&db.path()).unwrap();
    let conversation = store.create_conversation("metrics", None).unwrap();
    let other = store.create_conversation("other metrics", None).unwrap();

    let first_id = store
        .record_compaction_metric(&conversation.id, "threshold", 10_000, 2_500, 120)
        .unwrap();
    let foreign_id = store
        .record_compaction_metric(&other.id, "overflow", 8_000, 1_100, 90)
        .unwrap();
    let second_id = store
        .record_compaction_metric(&conversation.id, "emergency", 12_345, 3_210, 456)
        .unwrap();

    let metrics = store.list_compaction_metrics(&conversation.id, 10).unwrap();
    assert_eq!(metrics.len(), 2);
    assert_eq!(
        metrics.iter().map(|metric| metric.id).collect::<Vec<_>>(),
        vec![second_id, first_id]
    );
    assert!(metrics.iter().all(|metric| metric.id != foreign_id));
    assert_eq!(metrics[0].conversation_id, conversation.id);
    assert_eq!(metrics[0].reason, "emergency");
    assert_eq!(metrics[0].before_tokens, 12_345);
    assert_eq!(metrics[0].after_tokens, 3_210);
    assert_eq!(metrics[0].latency_ms, 456);
    assert!(!metrics[0].created_at.is_empty());
    assert_eq!(metrics[1].conversation_id, conversation.id);
    assert_eq!(metrics[1].reason, "threshold");
    assert_eq!(metrics[1].before_tokens, 10_000);
    assert_eq!(metrics[1].after_tokens, 2_500);
    assert_eq!(metrics[1].latency_ms, 120);
    assert!(!metrics[1].created_at.is_empty());

    let limited = store.list_compaction_metrics(&conversation.id, 1).unwrap();
    assert_eq!(limited.len(), 1);
    assert_eq!(limited[0].id, second_id);
}

#[test]
fn list_messages_recent_three_remains_chronological() {
    let db = TestDb::new();
    let store = Store::open(&db.path()).unwrap();
    let conversation = store.create_conversation("recent", None).unwrap();

    let mut ids = Vec::new();
    for index in 1..=5 {
        ids.push(
            store
                .append_message(
                    &conversation.id,
                    &message(Role::User, format!("recent-message-{index}")),
                )
                .unwrap(),
        );
    }

    let messages = store.list_messages(&conversation.id, 3).unwrap();
    assert_eq!(
        messages.iter().map(|entry| entry.id).collect::<Vec<_>>(),
        ids[2..].to_vec()
    );
    assert_eq!(
        messages
            .iter()
            .map(|entry| entry.content.as_str())
            .collect::<Vec<_>>(),
        vec!["recent-message-3", "recent-message-4", "recent-message-5"]
    );
}
