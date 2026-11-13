use super::{now_ts, CompactionMetricRecord, Store};
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

/// Durable summary boundary and version metadata for one compaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredCompactionCheckpoint {
    pub id: String,
    pub conversation_id: String,
    pub summary: String,
    pub knowledge_gaps_json: String,
    pub ledger_json: String,
    pub first_kept_message_id: i64,
    pub last_summarized_message_id: i64,
    pub history_version: u64,
    pub model_slug: String,
    pub prompt_hash: String,
    pub tool_catalog_version: u64,
    pub created_at: String,
}

pub(crate) fn migrate_context_store(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS compaction_checkpoints (
            id TEXT PRIMARY KEY NOT NULL,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            summary TEXT NOT NULL,
            knowledge_gaps_json TEXT NOT NULL,
            ledger_json TEXT NOT NULL,
            first_kept_message_id INTEGER NOT NULL,
            last_summarized_message_id INTEGER NOT NULL,
            history_version INTEGER NOT NULL,
            model_slug TEXT NOT NULL,
            prompt_hash TEXT NOT NULL,
            tool_catalog_version INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_compaction_checkpoints_conversation_created
            ON compaction_checkpoints(conversation_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS compaction_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            reason TEXT NOT NULL,
            before_tokens INTEGER NOT NULL,
            after_tokens INTEGER NOT NULL,
            latency_ms INTEGER NOT NULL,
            recovery_used INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_compaction_metrics_conversation_created
            ON compaction_metrics(conversation_id, created_at DESC, id DESC);
        "#,
    )
    .context("migrate context store schema")?;
    let has_recovery_used = conn
        .prepare("PRAGMA table_info(compaction_metrics)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(std::result::Result::ok)
        .any(|column| column == "recovery_used");
    if !has_recovery_used {
        conn.execute(
            "ALTER TABLE compaction_metrics
             ADD COLUMN recovery_used INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    Ok(())
}

impl Store {
    /// Persist a checkpoint, replacing the stored row with the same id.
    pub fn save_compaction_checkpoint(
        &self,
        checkpoint: &StoredCompactionCheckpoint,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO compaction_checkpoints (
                id, conversation_id, summary, knowledge_gaps_json, ledger_json,
                first_kept_message_id, last_summarized_message_id, history_version,
                model_slug, prompt_hash, tool_catalog_version, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                conversation_id = excluded.conversation_id,
                summary = excluded.summary,
                knowledge_gaps_json = excluded.knowledge_gaps_json,
                ledger_json = excluded.ledger_json,
                first_kept_message_id = excluded.first_kept_message_id,
                last_summarized_message_id = excluded.last_summarized_message_id,
                history_version = excluded.history_version,
                model_slug = excluded.model_slug,
                prompt_hash = excluded.prompt_hash,
                tool_catalog_version = excluded.tool_catalog_version,
                created_at = excluded.created_at",
            params![
                checkpoint.id,
                checkpoint.conversation_id,
                checkpoint.summary,
                checkpoint.knowledge_gaps_json,
                checkpoint.ledger_json,
                checkpoint.first_kept_message_id,
                checkpoint.last_summarized_message_id,
                checkpoint.history_version,
                checkpoint.model_slug,
                checkpoint.prompt_hash,
                checkpoint.tool_catalog_version,
                checkpoint.created_at,
            ],
        )?;
        Ok(())
    }

    /// Load the newest checkpoint for one conversation.
    pub fn latest_compaction_checkpoint(
        &self,
        conversation_id: &str,
    ) -> Result<Option<StoredCompactionCheckpoint>> {
        let conn = self.conn.lock().unwrap();
        let checkpoint = conn
            .query_row(
                "SELECT id, conversation_id, summary, knowledge_gaps_json, ledger_json,
                        first_kept_message_id, last_summarized_message_id, history_version,
                        model_slug, prompt_hash, tool_catalog_version, created_at
                 FROM compaction_checkpoints
                 WHERE conversation_id = ?1
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT 1",
                params![conversation_id],
                Self::row_to_compaction_checkpoint,
            )
            .optional()?;
        Ok(checkpoint)
    }

    /// Record one completed compaction attempt and return its row id.
    pub fn record_compaction_metric(
        &self,
        conversation_id: &str,
        reason: &str,
        before_tokens: u64,
        after_tokens: u64,
        latency_ms: u64,
    ) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO compaction_metrics (
                conversation_id, reason, before_tokens, after_tokens, latency_ms,
                recovery_used, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
            params![
                conversation_id,
                reason,
                before_tokens,
                after_tokens,
                latency_ms,
                now_ts(),
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// List recent compaction metrics for one conversation, newest first.
    pub fn list_compaction_metrics(
        &self,
        conversation_id: &str,
        limit: u32,
    ) -> Result<Vec<CompactionMetricRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, reason, before_tokens, after_tokens, latency_ms,
                    recovery_used, created_at
             FROM compaction_metrics
             WHERE conversation_id = ?1
             ORDER BY created_at DESC, id DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(
            params![conversation_id, limit],
            Self::row_to_compaction_metric,
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    /// Mark the newest compaction for one conversation as recovered. Returns
    /// false when the conversation has no compaction metric yet.
    pub fn mark_latest_compaction_recovered(&self, conversation_id: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let changed = conn.execute(
            "UPDATE compaction_metrics
             SET recovery_used = 1
             WHERE id = (
                 SELECT id FROM compaction_metrics
                 WHERE conversation_id = ?1
                 ORDER BY created_at DESC, id DESC
                 LIMIT 1
             )",
            params![conversation_id],
        )?;
        Ok(changed > 0)
    }

    /// Fraction of recorded compactions after which transcript recovery was
    /// used. Returns None until the conversation records its first compaction.
    pub fn compaction_recovery_rate(&self, conversation_id: &str) -> Result<Option<f64>> {
        let conn = self.conn.lock().unwrap();
        let (total, recovered): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(recovery_used), 0)
             FROM compaction_metrics
             WHERE conversation_id = ?1",
            params![conversation_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        if total == 0 {
            return Ok(None);
        }
        Ok(Some(recovered as f64 / total as f64))
    }

    fn row_to_compaction_checkpoint(row: &Row<'_>) -> rusqlite::Result<StoredCompactionCheckpoint> {
        Ok(StoredCompactionCheckpoint {
            id: row.get("id")?,
            conversation_id: row.get("conversation_id")?,
            summary: row.get("summary")?,
            knowledge_gaps_json: row.get("knowledge_gaps_json")?,
            ledger_json: row.get("ledger_json")?,
            first_kept_message_id: row.get("first_kept_message_id")?,
            last_summarized_message_id: row.get("last_summarized_message_id")?,
            history_version: row.get("history_version")?,
            model_slug: row.get("model_slug")?,
            prompt_hash: row.get("prompt_hash")?,
            tool_catalog_version: row.get("tool_catalog_version")?,
            created_at: row.get("created_at")?,
        })
    }

    fn row_to_compaction_metric(row: &Row<'_>) -> rusqlite::Result<CompactionMetricRecord> {
        Ok(CompactionMetricRecord {
            id: row.get("id")?,
            conversation_id: row.get("conversation_id")?,
            reason: row.get("reason")?,
            before_tokens: row.get("before_tokens")?,
            after_tokens: row.get("after_tokens")?,
            latency_ms: row.get("latency_ms")?,
            recovery_used: row.get::<_, i64>("recovery_used")? != 0,
            created_at: row.get("created_at")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> Store {
        let dir = std::env::temp_dir().join(format!(
            "worldbase-context-store-test-{}",
            uuid::Uuid::new_v4()
        ));
        Store::open(&dir.join("app.sqlite")).unwrap()
    }

    fn checkpoint(id: &str, conversation_id: &str, created_at: &str) -> StoredCompactionCheckpoint {
        StoredCompactionCheckpoint {
            id: id.into(),
            conversation_id: conversation_id.into(),
            summary: "summary".into(),
            knowledge_gaps_json: r#"["gap"]"#.into(),
            ledger_json: r#"{"nextAction":"continue"}"#.into(),
            first_kept_message_id: 4,
            last_summarized_message_id: 3,
            history_version: 2,
            model_slug: "model".into(),
            prompt_hash: "hash".into(),
            tool_catalog_version: 5,
            created_at: created_at.into(),
        }
    }

    #[test]
    fn context_store_migration_is_idempotent() {
        let store = temp_store();
        let conn = store.conn.lock().unwrap();

        migrate_context_store(&conn).unwrap();
        migrate_context_store(&conn).unwrap();

        let table_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'table'
                   AND name IN ('compaction_checkpoints', 'compaction_metrics')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let index_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index'
                   AND name IN (
                       'idx_compaction_checkpoints_conversation_created',
                       'idx_compaction_metrics_conversation_created'
                   )",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(table_count, 2);
        assert_eq!(index_count, 2);
    }

    #[test]
    fn checkpoint_round_trips_every_field_and_upserts_by_id() {
        let store = temp_store();
        let conversation = store.create_conversation("checkpoint", None).unwrap();
        let mut expected = checkpoint("checkpoint-1", &conversation.id, "2026-11-13T08:00:00Z");
        expected.summary = "Exact unicode summary: 压缩前状态\nsecond line".into();
        expected.knowledge_gaps_json = r#"["missing \"quoted\" evidence","第二项"]"#.into();
        expected.ledger_json =
            r#"{"criticalErrors":["manifest_invalid: exact"],"historyVersion":9}"#.into();
        expected.first_kept_message_id = 42;
        expected.last_summarized_message_id = 41;
        expected.history_version = 9_007_199_254_740_993;
        expected.model_slug = "provider/model-v2".into();
        expected.prompt_hash = "sha256:abcdef".into();
        expected.tool_catalog_version = i64::MAX as u64;

        store.save_compaction_checkpoint(&expected).unwrap();
        assert_eq!(
            store
                .latest_compaction_checkpoint(&conversation.id)
                .unwrap(),
            Some(expected.clone())
        );

        expected.summary = "replacement summary".into();
        expected.knowledge_gaps_json = "[]".into();
        expected.ledger_json = r#"{"nextAction":"verify"}"#.into();
        expected.first_kept_message_id = 44;
        expected.last_summarized_message_id = 43;
        expected.history_version = 10;
        expected.model_slug = "provider/model-v3".into();
        expected.prompt_hash = "sha256:replacement".into();
        expected.tool_catalog_version = 6;

        store.save_compaction_checkpoint(&expected).unwrap();

        assert_eq!(
            store
                .latest_compaction_checkpoint(&conversation.id)
                .unwrap(),
            Some(expected)
        );
        let conn = store.conn.lock().unwrap();
        let row_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM compaction_checkpoints", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(row_count, 1);
    }

    #[test]
    fn latest_checkpoint_orders_by_created_at_then_insertion_order() {
        let store = temp_store();
        let conversation = store.create_conversation("latest", None).unwrap();

        let mut tied_first = checkpoint("tied-first", &conversation.id, "2026-11-13T09:00:00Z");
        tied_first.summary = "first at tied timestamp".into();
        store.save_compaction_checkpoint(&tied_first).unwrap();

        let mut tied_second = checkpoint("tied-second", &conversation.id, "2026-11-13T09:00:00Z");
        tied_second.summary = "second at tied timestamp".into();
        store.save_compaction_checkpoint(&tied_second).unwrap();

        let older = checkpoint(
            "older-inserted-later",
            &conversation.id,
            "2026-11-13T08:59:59Z",
        );
        store.save_compaction_checkpoint(&older).unwrap();

        assert_eq!(
            store
                .latest_compaction_checkpoint(&conversation.id)
                .unwrap(),
            Some(tied_second)
        );
    }

    #[test]
    fn metrics_round_trip_list_limit_and_reject_u64_overflow() {
        let store = temp_store();
        let conversation = store.create_conversation("metrics", None).unwrap();

        let first_id = store
            .record_compaction_metric(&conversation.id, "threshold", 10_000, 4_000, 125)
            .unwrap();
        let second_id = store
            .record_compaction_metric(&conversation.id, "overflow", 20_000, 8_000, 250)
            .unwrap();

        let metrics = store.list_compaction_metrics(&conversation.id, 10).unwrap();
        assert_eq!(metrics.len(), 2);
        assert_eq!(metrics[0].id, second_id);
        assert_eq!(metrics[0].conversation_id, conversation.id);
        assert_eq!(metrics[0].reason, "overflow");
        assert_eq!(metrics[0].before_tokens, 20_000);
        assert_eq!(metrics[0].after_tokens, 8_000);
        assert_eq!(metrics[0].latency_ms, 250);
        assert!(!metrics[0].recovery_used);
        assert!(metrics[0].created_at.ends_with('Z'));
        assert!(metrics[0].created_at.contains('T'));
        assert_eq!(metrics[1].id, first_id);
        assert_eq!(metrics[1].reason, "threshold");
        assert_eq!(
            store.compaction_recovery_rate(&conversation.id).unwrap(),
            Some(0.0)
        );

        assert!(store
            .mark_latest_compaction_recovered(&conversation.id)
            .unwrap());
        let recovered = store.list_compaction_metrics(&conversation.id, 10).unwrap();
        assert!(recovered[0].recovery_used);
        assert!(!recovered[1].recovery_used);
        assert_eq!(
            store.compaction_recovery_rate(&conversation.id).unwrap(),
            Some(0.5)
        );

        let limited = store.list_compaction_metrics(&conversation.id, 1).unwrap();
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].id, second_id);

        let overflow = store
            .record_compaction_metric(&conversation.id, "invalid", u64::MAX, 0, 0)
            .unwrap_err();
        assert!(overflow.to_string().contains("out of range"));
        assert_eq!(
            store
                .list_compaction_metrics(&conversation.id, 10)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            store
                .compaction_recovery_rate("missing-conversation")
                .unwrap(),
            None
        );
        assert!(!store
            .mark_latest_compaction_recovered("missing-conversation")
            .unwrap());
    }

    #[test]
    fn checkpoints_and_metrics_are_conversation_scoped() {
        let store = temp_store();
        let first_conversation = store.create_conversation("first", None).unwrap();
        let second_conversation = store.create_conversation("second", None).unwrap();

        let first_checkpoint = checkpoint(
            "first-checkpoint",
            &first_conversation.id,
            "2026-11-13T10:00:00Z",
        );
        let second_checkpoint = checkpoint(
            "second-checkpoint",
            &second_conversation.id,
            "2026-11-13T11:00:00Z",
        );
        store.save_compaction_checkpoint(&first_checkpoint).unwrap();
        store
            .save_compaction_checkpoint(&second_checkpoint)
            .unwrap();

        assert_eq!(
            store
                .latest_compaction_checkpoint(&first_conversation.id)
                .unwrap(),
            Some(first_checkpoint)
        );
        assert_eq!(
            store
                .latest_compaction_checkpoint(&second_conversation.id)
                .unwrap(),
            Some(second_checkpoint)
        );

        store
            .record_compaction_metric(&first_conversation.id, "first-metric", 100, 50, 10)
            .unwrap();
        store
            .record_compaction_metric(&second_conversation.id, "second-metric", 200, 100, 20)
            .unwrap();

        let first_metrics = store
            .list_compaction_metrics(&first_conversation.id, 10)
            .unwrap();
        let second_metrics = store
            .list_compaction_metrics(&second_conversation.id, 10)
            .unwrap();
        assert_eq!(first_metrics.len(), 1);
        assert_eq!(first_metrics[0].reason, "first-metric");
        assert_eq!(second_metrics.len(), 1);
        assert_eq!(second_metrics[0].reason, "second-metric");
    }
}
