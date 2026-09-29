use serde_json::json;
use worldbase_memory::Store;
use worldbase_protocol::types::{
    MemorySearchScopeEntry, WorkspaceMemoryEntry, WorkspaceMemorySearchOptions,
};

struct Fixture {
    store: Store,
    dir: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("worldbase-memory-recall-{}", uuid::Uuid::new_v4()));
        Self {
            store: Store::open(&dir.join("app.sqlite")).unwrap(),
            dir,
        }
    }
    fn save(&self, id: &str, summary: &str, scope: &str) -> WorkspaceMemoryEntry {
        self.store.save_workspace_memory(&serde_json::from_value(json!({
            "id": id, "title": summary, "summary": summary,
            "scopeType": scope, "scopeId": if scope == "user" { "local-user" } else { "agent_default" },
            "importance": if scope == "user" { 0.5 } else { 0.75 }
        })).unwrap()).unwrap()
    }
    fn query(&self, query: &str, limit: u32) -> Vec<WorkspaceMemoryEntry> {
        self.store
            .recall_workspace_memories(&options(query, limit))
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
fn options(query: &str, limit: u32) -> WorkspaceMemorySearchOptions {
    WorkspaceMemorySearchOptions {
        query: Some(query.into()),
        scopes: vec![
            MemorySearchScopeEntry {
                scope_type: "user".into(),
                scope_id: "local-user".into(),
            },
            MemorySearchScopeEntry {
                scope_type: "agent".into(),
                scope_id: "agent_default".into(),
            },
        ],
        memory_types: vec![],
        limit: Some(limit),
    }
}

#[test]
fn chinese_personal_question_recalls_apple_before_higher_importance_agent_summaries() {
    let f = Fixture::new();
    f.save("apple", "用户喜欢吃苹果。", "user");
    for i in 0..140 {
        f.save(
            &format!("noise-{i}"),
            "项目需要使用 SQLite 和 Electron 构建。",
            "agent",
        );
    }
    f.save(
        "failed-recall",
        "已完成我喜欢吃什么的回答：通过 memory_search 确认没有任何饮食喜好记录",
        "agent",
    );
    for query in ["我喜欢吃什么", "你还记得我喜欢吃什么吗？", "喜欢吃", "苹果"]
    {
        let hits = f.query(query, 1);
        assert_eq!(
            hits.first().map(|e| e.id.as_str()),
            Some("apple"),
            "{query}"
        );
    }
}

#[test]
fn terms_match_across_fields_without_requiring_the_entire_query_substring() {
    let f = Fixture::new();
    let mut e = f.save("rust", "Use Rust for backend services", "agent");
    e.details = Some("Prefer PostgreSQL for persistence".into());
    e.source_text = Some("Use Rust.\n\nThe original note mentions SQLx.".into());
    f.store.save_workspace_memory(&e).unwrap();
    assert_eq!(f.query("Rust PostgreSQL", 10)[0].id, "rust");
    assert_eq!(f.query("SQLx", 10)[0].source_text, e.source_text);
    assert!(
        f.query("%", 10).is_empty(),
        "a literal percent must not match every row"
    );
}

#[test]
fn recall_enforces_scopes_and_lifecycle_but_catalog_can_inspect_inactive_entries() {
    let f = Fixture::new();
    let mut foreign = f.save("foreign", "用户喜欢吃苹果", "user");
    foreign.scope_id = "someone-else".into();
    f.store.save_workspace_memory(&foreign).unwrap();
    f.save("superseded", "用户喜欢吃苹果", "user");
    f.save("expired", "用户喜欢吃苹果", "user");
    let conn = rusqlite::Connection::open(f.store.memory_database_file()).unwrap();
    conn.execute(
        "UPDATE memory_entries SET status = 'superseded' WHERE id = 'superseded'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE memory_entries SET expires_at = '2000-01-01T00:00:00Z' WHERE id = 'expired'",
        [],
    )
    .unwrap();
    assert!(f.query("苹果", 10).is_empty());
    assert_eq!(
        f.store
            .search_workspace_memories(&options("苹果", 10))
            .unwrap()
            .len(),
        2
    );
    let mut invalid = options("苹果", 10);
    invalid.scopes[0].scope_id.clear();
    invalid.scopes.truncate(1);
    assert!(f
        .store
        .recall_workspace_memories(&invalid)
        .unwrap()
        .is_empty());
    invalid.scopes.clear();
    assert!(f
        .store
        .recall_workspace_memories(&invalid)
        .unwrap()
        .is_empty());
}

#[test]
fn ingest_preserves_explicit_user_evidence_and_does_not_learn_a_failed_recall() {
    let f = Fixture::new();
    let evidence = "我喜欢吃苹果。\n我不喜欢吃香蕉。";
    let result = f.store.ingest_workspace_memories(&json!({
        "scopes": [{"scopeType":"user", "scopeId":"local-user"}, {"scopeType":"agent", "scopeId":"agent_default"}],
        "userMessages": [evidence], "sourceConversationId": "source-conversation",
        "finalAssistantText": "好的，记住了。"
    })).unwrap();
    assert_eq!(result.len(), 2);
    assert!(result.iter().all(|entry| entry.details.is_none()));
    assert!(result
        .iter()
        .all(|e| e.memory_type == "user_trait" && e.source_text.as_deref() == Some(evidence)));
    assert_eq!(
        f.query("我喜欢吃什么", 1)[0]
            .source_conversation_id
            .as_deref(),
        Some("source-conversation")
    );
    for message in [
        "我喜欢吃什么？",
        "我喜欢吃苹果吗",
        "比如我喜欢吃苹果",
        "假如我喜欢吃苹果",
        "我喜欢吃苹果还是香蕉",
        "他说：我喜欢吃苹果",
        "如果有苹果。\n我喜欢吃苹果吗？",
    ] {
        assert!(f.store.ingest_workspace_memories(&json!({
            "scopes": [{"scopeType":"user", "scopeId":"local-user"}], "userMessages": [message]
        })).unwrap().is_empty(), "not a fact: {message}");
    }
    assert!(f.store.ingest_workspace_memories(&json!({
        "scopes": [{"scopeType":"user", "scopeId":"local-user"}, {"scopeType":"agent", "scopeId":"agent_default"}],
        "userMessages": ["我喜欢吃什么"], "toolNames": ["memory_search"],
        "finalAssistantText": "通过 memory_search 检索记忆，确认没有任何饮食喜好记录。"
    })).unwrap().is_empty());
}

#[test]
fn generated_knowledge_keeps_user_source_but_not_the_full_assistant_transcript_in_details() {
    let f = Fixture::new();
    let result = f.store.ingest_workspace_memories(&json!({
        "scopes": [{"scopeType":"user", "scopeId":"local-user"}, {"scopeType":"agent", "scopeId":"agent_default"}],
        "userMessages": ["请记住这个项目必须使用 SQLite。"],
        "finalAssistantText": "好的。\n\n```mermaid\nflowchart LR\n  A --> B\n```\n另外，项目必须使用 SQLite，部署时还要检查权限。"
    })).unwrap();
    let knowledge = result
        .iter()
        .find(|entry| entry.memory_type == "knowledge")
        .expect("knowledge memory");
    assert!(
        knowledge.details.is_none(),
        "generated knowledge should not copy the assistant transcript into the card details"
    );
    assert_eq!(
        knowledge.source_text.as_deref(),
        Some("请记住这个项目必须使用 SQLite。")
    );
    assert!(!knowledge
        .source_text
        .as_deref()
        .unwrap()
        .contains("mermaid"));
}

#[test]
fn source_text_is_not_truncated_or_rewritten_when_saving_an_existing_memory() {
    let f = Fixture::new();
    let original = format!("  原始提问\n\n    {}\n结尾  ", "记".repeat(5000));
    let mut entry = f.save("original", "fact", "user");
    entry.source_text = Some(original.clone());
    entry.details = Some("原有补充详情".into());
    let saved = f.store.save_workspace_memory(&entry).unwrap();
    assert_eq!(saved.source_text.as_deref(), Some(original.as_str()));
    assert_eq!(saved.details, entry.details);
    let reloaded = f.store.get_workspace_memory(&entry.id).unwrap().unwrap();
    assert_eq!(reloaded.source_text, saved.source_text);
}

#[test]
fn knowledge_sources_use_only_the_current_user_turn_and_never_an_assistant_fallback() {
    let f = Fixture::new();
    let current = "  请解释这个项目的部署约束。\n保留换行。  ";
    let input = json!({
        "scopes": [{"scopeType":"agent", "scopeId":"agent_default"}],
        "userMessages": ["之前讨论的是另外一个项目", current, "   "],
        "finalAssistantText": "项目必须使用 SQLite 并检查文件权限。"
    });
    let entries = f.store.ingest_workspace_memories(&input).unwrap();
    assert!(!entries.is_empty());
    assert!(entries
        .iter()
        .all(|entry| entry.source_text.as_deref() == Some(current) && entry.details.is_none()));

    let without_source = f
        .store
        .ingest_workspace_memories(&json!({
            "scopes": [{"scopeType":"agent", "scopeId":"agent_default"}],
            "userMessages": [],
            "finalAssistantText": "Electron 项目应该进行构建测试。"
        }))
        .unwrap();
    assert!(!without_source.is_empty());
    assert!(without_source
        .iter()
        .all(|entry| entry.source_text.is_none()));
}

#[test]
fn configuration_and_tool_derived_memories_are_not_labeled_as_user_quotes() {
    let f = Fixture::new();
    let entries = f
        .store
        .ingest_workspace_memories(&json!({
            "scopes": [{"scopeType":"agent", "scopeId":"agent_default"}],
            "userMessages": ["请完成这次项目任务"],
            "agent": {"name": "助手", "skillIds": ["project-helper"]},
            "toolNames": ["read_file", "write_file"]
        }))
        .unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().all(|entry| entry.source_text.is_none()));
}
