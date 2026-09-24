//! 共享记忆 embedding 管线端到端测试（design §16-P0）。
//!
//! 覆盖：治理字段迁移、embedding_documents/jobs/generations 表、
//! save_workspace_memory 同事务入队、后台队列消费、共享派生向量库上的
//! 语义召回、遗忘后的向量清理。

use std::sync::Arc;
use worldbase_memory::{FakeEmbeddingProvider, MemoryEmbeddingQueue, Store};
use worldbase_protocol::types::{MemoryEmbeddingRuntimeConfig, WorkspaceMemoryEntry};

const FIXED_TIME: &str = "2026-01-01T00:00:00.000Z";

fn temp_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "worldbase-embedding-pipeline-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn workspace_entry(id: &str, title: &str, summary: &str) -> WorkspaceMemoryEntry {
    WorkspaceMemoryEntry {
        id: id.to_string(),
        scope_type: "user".into(),
        scope_id: "local-user".into(),
        memory_type: "knowledge".into(),
        title: title.into(),
        summary: summary.into(),
        details: None,
        tags: vec![],
        source_conversation_id: None,
        source_session_id: None,
        source_message_ids: vec![],
        importance: 0.8,
        confidence: 0.8,
        pinned: false,
        last_used_at: None,
        created_at: FIXED_TIME.into(),
        updated_at: FIXED_TIME.into(),
    }
}

fn fake_config() -> MemoryEmbeddingRuntimeConfig {
    MemoryEmbeddingRuntimeConfig {
        provider_id: "p1".into(),
        base_url: "https://provider.example/v1".into(),
        api_key: "sk-test".into(),
        model_id: "e1".into(),
        dimensions: Some(64),
        distance: Some("cosine".into()),
        normalized: Some(true),
        query_prefix: None,
        document_prefix: None,
    }
}

#[tokio::test]
async fn pipeline_indexes_saves_and_recalls_semantically() {
    std::env::set_var("WORLDBASE_FAKE_EMBEDDING", "1");
    let dir = temp_dir();
    let store = Arc::new(Store::open(&dir.join("app.sqlite")).expect("open store"));

    // Governance columns exist with safe defaults after migration; the save
    // stores the embedding document fact in the same transaction. With no
    // generation configured yet, no job and no vector file appear (§7.3).
    let entry = store
        .save_workspace_memory(&workspace_entry(
            "m_pref",
            "偏好先看结论",
            "用户喜欢先看到结论，再阅读详细解释。",
        ))
        .unwrap();
    assert_eq!(entry.id, "m_pref");
    assert!(store.get_embedding_document("memory", "m_pref").unwrap().is_some());
    assert!(!dir.join("agent-memory").join("memory-vector.sqlite").exists());

    let queue = MemoryEmbeddingQueue::new(store.clone());
    queue.set_config(Some(fake_config())).await;
    let processed = queue.drain_once().await;
    assert!(processed >= 1, "queue should process the queued job");

    // Fully indexed generation is promoted to active.
    let generation = store
        .active_embedding_generation()
        .unwrap()
        .expect("active generation");
    assert_eq!(generation.status, "active");
    assert!(generation.indexed_documents >= 1);
    assert!(dir.join("agent-memory").join("memory-vector.sqlite").exists());

    // Semantic recall surfaces the preference entry through the vector index.
    let scope_keys = vec!["user:local-user".to_string()];
    let provider = FakeEmbeddingProvider::new(64);
    let recalled = store
        .recall_semantic_entries(&provider, &generation.id, "用户喜欢先看到结论", &scope_keys, 5)
        .await
        .unwrap();
    assert!(recalled.iter().any(|item| item.id == "m_pref"));

    // Forgetting removes the main record and its vector projection.
    assert!(store.delete_workspace_memory("m_pref").unwrap());
    assert!(store.get_workspace_memory("m_pref").unwrap().is_none());
    assert!(store.get_embedding_document("memory", "m_pref").unwrap().is_none());
    let recalled = store
        .recall_semantic_entries(&provider, &generation.id, "用户喜欢先看到结论", &scope_keys, 5)
        .await
        .unwrap();
    assert!(recalled.iter().all(|item| item.id != "m_pref"));

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn queue_does_nothing_without_config() {
    let dir = temp_dir();
    let store = Arc::new(Store::open(&dir.join("app.sqlite")).expect("open store"));
    store
        .save_workspace_memory(&workspace_entry("m_x", "标题", "摘要内容需要足够长。"))
        .unwrap();
    let queue = MemoryEmbeddingQueue::new(store);
    // No config set: drain must be a no-op and must not create the vector file.
    assert_eq!(queue.drain_once().await, 0);
    assert!(!dir.join("agent-memory").join("memory-vector.sqlite").exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn governance_migration_adds_columns_to_legacy_database() {
    let dir = temp_dir();
    let memory_dir = dir.join("agent-memory");
    std::fs::create_dir_all(&memory_dir).unwrap();
    {
        let connection = rusqlite_connection(&memory_dir.join("memory.sqlite"));
        connection
            .execute_batch(
                r#"
                CREATE TABLE memory_entries (
                    id TEXT PRIMARY KEY,
                    scope_type TEXT NOT NULL,
                    scope_id TEXT NOT NULL,
                    memory_type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    details TEXT,
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    source_conversation_id TEXT,
                    source_session_id TEXT,
                    source_message_ids_json TEXT NOT NULL DEFAULT '[]',
                    importance REAL NOT NULL DEFAULT 0.5,
                    confidence REAL NOT NULL DEFAULT 0.5,
                    pinned INTEGER NOT NULL DEFAULT 0,
                    last_used_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                INSERT INTO memory_entries (id, scope_type, scope_id, memory_type, title, summary, created_at, updated_at)
                VALUES ('legacy_1', 'user', 'local-user', 'knowledge', '旧记忆', '旧摘要内容', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
                "#,
            )
            .unwrap();
    }
    let store = Store::open(&dir.join("app.sqlite")).unwrap();
    let entry = store.get_workspace_memory("legacy_1").unwrap().expect("entry survives migration");
    assert_eq!(entry.title, "旧记忆");
    let _ = std::fs::remove_dir_all(&dir);
}

fn rusqlite_connection(path: &std::path::Path) -> rusqlite::Connection {
    rusqlite::Connection::open(path).unwrap()
}
