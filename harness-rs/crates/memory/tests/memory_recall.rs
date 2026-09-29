use serde_json::json;
use worldbase_memory::{personal_profile_category_terms, Store};
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
fn assistant_replies_no_longer_generate_knowledge_entries() {
    let f = Fixture::new();
    // Design §12 M0: assistant restatements and generic advice must not become
    // durable knowledge, even with signal words and a plausible user turn.
    let result = f.store.ingest_workspace_memories(&json!({
        "scopes": [{"scopeType":"user", "scopeId":"local-user"}, {"scopeType":"agent", "scopeId":"agent_default"}],
        "userMessages": ["请记住这个项目必须使用 SQLite。"],
        "finalAssistantText": "好的。\n\n```mermaid\nflowchart LR\n  A --> B\n```\n另外，项目必须使用 SQLite，部署时还要检查权限。"
    })).unwrap();
    assert!(
        result.is_empty(),
        "assistant replies are not an extraction source: {result:?}"
    );

    let without_source = f
        .store
        .ingest_workspace_memories(&json!({
            "scopes": [{"scopeType":"agent", "scopeId":"agent_default"}],
            "userMessages": [],
            "finalAssistantText": "Electron 项目应该进行构建测试。"
        }))
        .unwrap();
    assert!(without_source.is_empty());

    // A failed retrieval must not feed back as fact either; the whole session
    // stays write-free because assistant text is no longer ingested.
    assert!(f.store.ingest_workspace_memories(&json!({
        "scopes": [{"scopeType":"user", "scopeId":"local-user"}, {"scopeType":"agent", "scopeId":"agent_default"}],
        "userMessages": ["我喜欢吃什么"], "toolNames": ["memory_search"],
        "finalAssistantText": "通过 memory_search 检索记忆，确认没有任何饮食喜好记录。"
    })).unwrap().is_empty());

    // The explicit user-preference path keeps working unchanged, including
    // verbatim evidence; manual saves and memory_add are separate paths.
    let evidence = "我喜欢吃苹果。";
    let traits = f.store.ingest_workspace_memories(&json!({
        "scopes": [{"scopeType":"user", "scopeId":"local-user"}],
        "userMessages": [evidence],
        "finalAssistantText": "好的，已保存你的偏好。"
    })).unwrap();
    assert_eq!(traits.len(), 1);
    assert_eq!(traits[0].memory_type, "user_trait");
    assert_eq!(traits[0].source_text.as_deref(), Some(evidence));
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
fn tool_derived_memories_are_not_labeled_as_user_quotes() {
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
    assert!(entries
        .iter()
        .all(|entry| matches!(entry.memory_type.as_str(), "agent_skill" | "step")));
}

fn user_scope() -> Vec<MemorySearchScopeEntry> {
    vec![MemorySearchScopeEntry {
        scope_type: "user".into(),
        scope_id: "local-user".into(),
    }]
}

#[test]
fn personal_profile_categories_map_personal_questions_to_fact_terms() {
    let diet = personal_profile_category_terms("我喜欢吃什么").expect("diet category");
    assert!(diet.contains(&"喜欢吃"));
    assert!(personal_profile_category_terms("我对花生过敏吗").is_some());
    assert!(personal_profile_category_terms("帮我修复这个构建失败").is_none());
    assert!(personal_profile_category_terms("").is_none());
}

#[test]
fn user_fact_channel_reads_pinned_and_category_facts_for_the_exact_scope() {
    let f = Fixture::new();
    let apple = json!({
        "id": "apple", "title": "用户喜欢吃苹果", "summary": "用户喜欢吃苹果",
        "scopeType": "user", "scopeId": "local-user", "memoryType": "user_trait",
        "sourceText": "我喜欢吃苹果。"
    });
    f.store
        .save_workspace_memory(&serde_json::from_value(apple).unwrap())
        .unwrap();
    let mut routine = f.save("routine", "用户习惯早上九点开始工作", "user");
    routine.memory_type = "user_trait".into();
    routine.pinned = true;
    f.store.save_workspace_memory(&routine).unwrap();
    // Same text but a different user scope: never visible through this run's
    // channel.
    let mut foreign = f.save("foreign", "用户喜欢吃苹果", "user");
    foreign.scope_id = "someone-else".into();
    f.store.save_workspace_memory(&foreign).unwrap();

    let pinned = f
        .store
        .recall_user_scope_facts(&user_scope(), &[], true, 4)
        .unwrap();
    assert_eq!(
        pinned.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        vec!["routine"],
        "only pinned facts occupy the resident slot"
    );

    let diet = personal_profile_category_terms("我喜欢吃什么").unwrap();
    let categorized = f
        .store
        .recall_user_scope_facts(&user_scope(), diet, false, 8)
        .unwrap();
    assert_eq!(categorized.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["apple"]);
    assert_eq!(categorized[0].source_text.as_deref(), Some("我喜欢吃苹果。"));

    // Unrelated query categories must not pull the fact in.
    let schedule = personal_profile_category_terms("我的作息是什么").unwrap();
    let by_schedule = f
        .store
        .recall_user_scope_facts(&user_scope(), schedule, false, 8)
        .unwrap();
    assert_eq!(
        by_schedule.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
        vec!["routine"],
        "category terms must not leak between categories"
    );
}

#[test]
fn user_fact_channel_filters_lifecycle_and_keeps_multiple_preferences() {
    let f = Fixture::new();
    let save = |id: &str, summary: &str| {
        f.store
            .save_workspace_memory(&serde_json::from_value(json!({
                "id": id, "title": summary, "summary": summary,
                "scopeType": "user", "scopeId": "local-user", "memoryType": "user_trait"
            })).unwrap())
            .unwrap()
    };
    save("apple", "用户喜欢吃苹果");
    save("banana", "用户也喜欢吃香蕉");
    let mut superseded = save("superseded", "用户喜欢吃梨");
    let mut expired = save("expired", "用户喜欢吃西瓜");
    f.store.save_workspace_memory(&superseded).unwrap();
    f.store.save_workspace_memory(&expired).unwrap();
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
    superseded.id = "superseded".into();
    expired.id = "expired".into();
    let mut foreign = save("foreign", "用户喜欢吃苹果");
    foreign.scope_id = "someone-else".into();
    f.store.save_workspace_memory(&foreign).unwrap();
    save("deleted", "用户喜欢吃橘子");
    f.store.delete_workspace_memory("deleted").unwrap();

    let diet = personal_profile_category_terms("我喜欢吃什么").unwrap();
    let hits = f
        .store
        .recall_user_scope_facts(&user_scope(), diet, false, 10)
        .unwrap();
    let ids = hits.iter().map(|e| e.id.as_str()).collect::<Vec<_>>();
    assert!(ids.contains(&"apple") && ids.contains(&"banana"), "multiple independent preferences stay: {ids:?}");
    assert_eq!(ids.len(), 2, "wrong scope, inactive, expired and deleted entries are excluded: {ids:?}");
}
