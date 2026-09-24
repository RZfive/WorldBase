//! Store 上的 embedding 管线数据访问（design §6.3–§6.5、§10）。
//!
//! Electron 与 Rust 打开同一个 `agent-memory/memory.sqlite`，因此本模块
//! 的表结构与状态机必须与 TypeScript 侧 `MemoryStore` 保持一致：
//! 事实写入与任务入队同一事务，`embedding_jobs` 通过即时事务认领实现
//! 跨进程安全的多消费者队列。

use super::vector::now_iso;
use super::Store;
use anyhow::{anyhow, Result};
use rusqlite::{params, params_from_iter, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};

pub const EMBEDDING_SOURCE_MEMORY: &str = "memory";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingDocumentRow {
    pub id: String,
    pub source_type: String,
    pub source_id: String,
    pub scope_type: String,
    pub scope_id: String,
    pub embedding_text: String,
    pub content_hash: String,
    pub active_generation_id: Option<String>,
    pub status: String,
    pub retry_count: i64,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingJobRow {
    pub id: i64,
    pub document_id: String,
    pub generation_id: String,
    pub status: String,
    pub attempts: i64,
    pub next_retry_at: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingGenerationRow {
    pub id: String,
    pub provider_id: String,
    pub model_id: String,
    pub model_revision: Option<String>,
    pub dimensions: i64,
    pub distance_metric: String,
    pub normalized: bool,
    pub preprocess_version: String,
    pub index_path: String,
    pub status: String,
    pub total_documents: i64,
    pub indexed_documents: i64,
    pub failed_documents: i64,
    pub created_at: String,
    pub activated_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EmbeddingSyncOutcome {
    /// 文档未变化且已索引，无需任何动作。
    AlreadyIndexed,
    /// 创建/刷新了文档并入队新任务。
    Queued,
    /// 没有可用的 generation：只保存文档事实，不入队（design §7.3）。
    StoredWithoutGeneration,
}

static SYNC_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn content_hash_of(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().take(16).map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn document_id_for(source_type: &str, source_id: &str) -> String {
    format!("{source_type}:{source_id}")
}

impl Store {
    /// 共享记忆主库的文件路径（`agent-memory/memory.sqlite`）。
    pub fn memory_database_file(&self) -> std::path::PathBuf {
        self.memory_path.clone()
    }

    // ---------- document pipeline ----------

    /// 规范化可检索文本（design §7.5）。与 TypeScript 侧使用相同的默认
    /// 前缀 `passage: `，保证同一内容在两侧产生一致的 content_hash。
    pub fn build_embedding_text(
        title: &str,
        summary: &str,
        details: Option<&str>,
        tags: &[String],
        document_prefix: Option<&str>,
    ) -> String {
        let prefix = document_prefix.unwrap_or("passage: ");
        let parts: Vec<String> = [title, summary, details.unwrap_or(""), &tags.join(" ")]
            .iter()
            .map(|part| part.trim())
            .filter(|part| !part.is_empty())
            .map(|part| part.to_string())
            .collect();
        let body: String = parts
            .iter()
            .map(|part| part.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect::<Vec<_>>()
            .join("。");
        format!("{prefix}{body}")
    }

    /// 当前写入目标 generation：优先 building（重建中），否则 active。
    pub fn target_embedding_generation(&self) -> Result<Option<EmbeddingGenerationRow>> {
        let conn = self.memory_conn.lock().unwrap();
        let query = |status: &str| -> Result<Option<EmbeddingGenerationRow>> {
            let mut statement = conn.prepare(&format!(
                "SELECT * FROM embedding_generations WHERE status = '{status}'
                 ORDER BY created_at DESC LIMIT 1"
            ))?;
            let mut rows = statement.query([])?;
            Ok(match rows.next()? {
                Some(row) => Some(row_to_generation(row)?),
                None => None,
            })
        };
        if let Some(generation) = query("building")? {
            return Ok(Some(generation));
        }
        query("active")
    }

    /// 在同一事务内创建/刷新 embedding 文档并入队任务。
    pub(crate) fn sync_embedding_document_in_tx(
        conn: &Transaction<'_>,
        source_type: &str,
        source_id: &str,
        scope_type: &str,
        scope_id: &str,
        embedding_text: &str,
    ) -> Result<EmbeddingSyncOutcome> {
        let hash = content_hash_of(embedding_text);
        let existing: Option<(String, String, Option<String>, String)> = conn
            .query_row(
                "SELECT id, content_hash, active_generation_id, status
                 FROM embedding_documents WHERE source_type = ?1 AND source_id = ?2",
                params![source_type, source_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .ok();

        let generation: Option<String> = conn
            .query_row(
                "SELECT id FROM embedding_generations WHERE status = 'building'
                 ORDER BY created_at DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .ok()
            .or_else(|| {
                conn.query_row(
                    "SELECT id FROM embedding_generations WHERE status = 'active'
                     ORDER BY created_at DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .ok()
            });

        if let Some((id, existing_hash, active_generation, status)) = &existing {
            if *existing_hash == hash
                && status == "indexed"
                && generation
                    .as_deref()
                    .map(|target| Some(target) == active_generation.as_deref())
                    .unwrap_or(false)
            {
                return Ok(EmbeddingSyncOutcome::AlreadyIndexed);
            }
            let _ = id;
        }

        let document_id = existing
            .as_ref()
            .map(|(id, _, _, _)| id.clone())
            .unwrap_or_else(|| document_id_for(source_type, source_id));
        let now = now_iso();
        conn.execute(
            r#"
            INSERT INTO embedding_documents (
                id, source_type, source_id, scope_type, scope_id,
                embedding_text, content_hash, active_generation_id, status,
                retry_count, last_error, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', 0, NULL, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
                scope_type = excluded.scope_type,
                scope_id = excluded.scope_id,
                embedding_text = excluded.embedding_text,
                content_hash = excluded.content_hash,
                status = 'queued',
                retry_count = 0,
                last_error = NULL,
                updated_at = excluded.updated_at
            "#,
            params![
                document_id,
                source_type,
                source_id,
                scope_type,
                scope_id,
                embedding_text,
                hash,
                existing.as_ref().and_then(|(_, _, active, _)| active.clone()),
                now,
                now
            ],
        )?;

        match generation {
            Some(generation_id) => {
                conn.execute(
                    "INSERT INTO embedding_jobs
                        (document_id, generation_id, status, attempts, created_at, updated_at)
                     VALUES (?1, ?2, 'queued', 0, ?3, ?3)",
                    params![document_id, generation_id, now],
                )?;
                Ok(EmbeddingSyncOutcome::Queued)
            }
            None => Ok(EmbeddingSyncOutcome::StoredWithoutGeneration),
        }
    }

    /// 记录一条审计事件（design §5.1 `memory_events`）。
    pub fn record_memory_event(&self, event_type: &str, entry_id: Option<&str>, detail_json: &str) {
        let sequence = SYNC_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let id = format!(
            "evt_{}{:x}",
            now_iso(),
            sequence
        );
        let _ = self.memory_conn.lock().unwrap().execute(
            "INSERT INTO memory_events (id, entry_id, event_type, detail_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, entry_id, event_type, detail_json, now_iso()],
        );
    }

    // ---------- generation CRUD ----------

    pub fn insert_embedding_generation(&self, generation: &EmbeddingGenerationRow) -> Result<()> {
        self.memory_conn.lock().unwrap().execute(
            r#"
            INSERT INTO embedding_generations (
                id, provider_id, model_id, model_revision, dimensions, distance_metric,
                normalized, preprocess_version, index_path, status, total_documents,
                indexed_documents, failed_documents, created_at, activated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, 0, 0, ?11, ?12)
            "#,
            params![
                generation.id,
                generation.provider_id,
                generation.model_id,
                generation.model_revision,
                generation.dimensions,
                generation.distance_metric,
                if generation.normalized { 1i64 } else { 0i64 },
                generation.preprocess_version,
                generation.index_path,
                generation.status,
                generation.created_at,
                generation.activated_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_embedding_generation(&self, id: &str) -> Result<Option<EmbeddingGenerationRow>> {
        let conn = self.memory_conn.lock().unwrap();
        let mut statement = conn.prepare("SELECT * FROM embedding_generations WHERE id = ?1")?;
        let mut rows = statement.query(params![id])?;
        Ok(match rows.next()? {
            Some(row) => Some(row_to_generation(row)?),
            None => None,
        })
    }

    pub fn active_embedding_generation(&self) -> Result<Option<EmbeddingGenerationRow>> {
        let conn = self.memory_conn.lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT * FROM embedding_generations WHERE status = 'active'
             ORDER BY created_at DESC LIMIT 1",
        )?;
        let mut rows = statement.query([])?;
        Ok(match rows.next()? {
            Some(row) => Some(row_to_generation(row)?),
            None => None,
        })
    }

    pub fn list_embedding_generations(&self) -> Result<Vec<EmbeddingGenerationRow>> {
        let conn = self.memory_conn.lock().unwrap();
        let mut statement = conn
            .prepare("SELECT * FROM embedding_generations ORDER BY created_at DESC")?;
        let rows = statement.query_map([], row_to_generation)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn update_embedding_generation(
        &self,
        id: &str,
        patch: &EmbeddingGenerationPatch,
    ) -> Result<()> {
        let current = self
            .get_embedding_generation(id)?
            .ok_or_else(|| anyhow!("generation {id} not found"))?;
        self.memory_conn.lock().unwrap().execute(
            r#"
            UPDATE embedding_generations SET
                status = ?1, total_documents = ?2, indexed_documents = ?3,
                failed_documents = ?4, dimensions = ?5, activated_at = ?6
            WHERE id = ?7
            "#,
            params![
                patch.status.clone().unwrap_or(current.status),
                patch.total_documents.unwrap_or(current.total_documents),
                patch.indexed_documents.unwrap_or(current.indexed_documents),
                patch.failed_documents.unwrap_or(current.failed_documents),
                patch.dimensions.unwrap_or(current.dimensions),
                patch.activated_at.clone().or(current.activated_at),
                id
            ],
        )?;
        Ok(())
    }

    /// 后台任务结束后重算 generation 进度计数。
    pub fn refresh_embedding_generation_totals(&self, generation_id: &str) -> Result<()> {
        let conn = self.memory_conn.lock().unwrap();
        let total: i64 = conn.query_row(
            "SELECT COUNT(*) FROM embedding_documents",
            [],
            |row| row.get(0),
        )?;
        let indexed: i64 = conn.query_row(
            "SELECT COUNT(*) FROM embedding_documents
             WHERE status = 'indexed' AND active_generation_id = ?1",
            params![generation_id],
            |row| row.get(0),
        )?;
        let failed: i64 = conn.query_row(
            "SELECT COUNT(*) FROM embedding_documents WHERE status = 'failed'",
            [],
            |row| row.get(0),
        )?;
        conn.execute(
            "UPDATE embedding_generations
             SET total_documents = ?2, indexed_documents = ?3, failed_documents = ?4
             WHERE id = ?1",
            params![generation_id, total, indexed, failed],
        )?;
        Ok(())
    }

    // ---------- document/job reads ----------

    pub fn get_embedding_document(&self, source_type: &str, source_id: &str) -> Result<Option<EmbeddingDocumentRow>> {
        let conn = self.memory_conn.lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT * FROM embedding_documents WHERE source_type = ?1 AND source_id = ?2",
        )?;
        let mut rows = statement.query(params![source_type, source_id])?;
        Ok(match rows.next()? {
            Some(row) => Some(row_to_document(row)?),
            None => None,
        })
    }

    pub fn list_embedding_documents(&self) -> Result<Vec<EmbeddingDocumentRow>> {
        let conn = self.memory_conn.lock().unwrap();
        let mut statement =
            conn.prepare("SELECT * FROM embedding_documents ORDER BY updated_at ASC")?;
        let rows = statement.query_map([], row_to_document)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn get_embedding_documents_by_ids(&self, ids: &[String]) -> Result<Vec<EmbeddingDocumentRow>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = std::iter::repeat("?")
            .take(ids.len())
            .collect::<Vec<_>>()
            .join(", ");
        let conn = self.memory_conn.lock().unwrap();
        let mut statement = conn.prepare(&format!(
            "SELECT * FROM embedding_documents WHERE id IN ({placeholders})"
        ))?;
        let rows = statement.query_map(params_from_iter(ids.iter()), row_to_document)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn upsert_embedding_document(&self, document: &EmbeddingDocumentRow) -> Result<()> {
        self.memory_conn.lock().unwrap().execute(
            r#"
            INSERT INTO embedding_documents (
                id, source_type, source_id, scope_type, scope_id,
                embedding_text, content_hash, active_generation_id, status,
                retry_count, last_error, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(id) DO UPDATE SET
                scope_type = excluded.scope_type,
                scope_id = excluded.scope_id,
                embedding_text = excluded.embedding_text,
                content_hash = excluded.content_hash,
                active_generation_id = excluded.active_generation_id,
                status = excluded.status,
                retry_count = excluded.retry_count,
                last_error = excluded.last_error,
                updated_at = excluded.updated_at
            "#,
            params![
                document.id,
                document.source_type,
                document.source_id,
                document.scope_type,
                document.scope_id,
                document.embedding_text,
                document.content_hash,
                document.active_generation_id,
                document.status,
                document.retry_count,
                document.last_error,
                document.created_at,
                document.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn delete_embedding_document(&self, id: &str) -> Result<()> {
        let conn = self.memory_conn.lock().unwrap();
        conn.execute("DELETE FROM embedding_jobs WHERE document_id = ?1", params![id])?;
        conn.execute("DELETE FROM embedding_documents WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// 即时事务认领到期任务；跨进程（Electron/CLI 并存）时同一任务只会被
    /// 一个消费者取走。
    pub fn claim_due_embedding_jobs(&self, limit: u32) -> Result<Vec<EmbeddingJobRow>> {
        let mut conn = self.memory_conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let now = now_iso();
        let mut statement = tx.prepare(
            "SELECT * FROM embedding_jobs
             WHERE status IN ('queued', 'retry') AND (next_retry_at IS NULL OR next_retry_at <= ?1)
             ORDER BY id ASC LIMIT ?2",
        )?;
        let rows = statement
            .query_map(params![now, limit], row_to_job)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(statement);
        for job in &rows {
            tx.execute(
                "UPDATE embedding_jobs SET status = 'running', updated_at = ?2 WHERE id = ?1",
                params![job.id, now],
            )?;
        }
        tx.commit()?;
        Ok(rows.into_iter().map(|mut job| { job.status = "running".into(); job }).collect())
    }

    pub fn update_embedding_job_status(
        &self,
        id: i64,
        status: &str,
        attempts: i64,
        next_retry_at: Option<&str>,
        error_message: Option<&str>,
    ) -> Result<()> {
        self.memory_conn.lock().unwrap().execute(
            "UPDATE embedding_jobs
             SET status = ?2, attempts = ?3, next_retry_at = ?4, error_message = ?5, updated_at = ?6
             WHERE id = ?1",
            params![id, status, attempts, next_retry_at, error_message, now_iso()],
        )?;
        Ok(())
    }

    pub fn count_embedding_jobs_by_status(&self) -> Result<std::collections::HashMap<String, i64>> {
        let conn = self.memory_conn.lock().unwrap();
        let mut statement =
            conn.prepare("SELECT status, COUNT(*) FROM embedding_jobs GROUP BY status")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        Ok(rows.collect::<rusqlite::Result<std::collections::HashMap<_, _>>>()?)
    }

    /// 为目标 generation 补建缺失的任务（generation 引导创建、或文档先于
    /// generation 存在时）。幂等：已有未完成任务/已索引文档不会重复入队。
    pub fn backfill_embedding_jobs(&self, generation_id: &str) -> Result<u32> {
        let mut conn = self.memory_conn.lock().unwrap();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let documents: Vec<(String, String)> = {
            let mut statement =
                tx.prepare("SELECT id, status FROM embedding_documents")?;
            let rows = statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let now = now_iso();
        let mut enqueued = 0u32;
        for (document_id, status) in &documents {
            if status == "indexed" {
                let active: Option<String> = tx
                    .query_row(
                        "SELECT active_generation_id FROM embedding_documents WHERE id = ?1",
                        params![document_id],
                        |row| row.get(0),
                    )
                    .ok()
                    .flatten();
                if active.as_deref() == Some(generation_id) {
                    continue;
                }
            }
            let pending: i64 = tx.query_row(
                "SELECT COUNT(*) FROM embedding_jobs
                 WHERE document_id = ?1 AND generation_id = ?2
                   AND status IN ('queued', 'running', 'retry', 'succeeded')",
                params![document_id, generation_id],
                |row| row.get(0),
            )?;
            if pending == 0 {
                tx.execute(
                    "INSERT INTO embedding_jobs
                        (document_id, generation_id, status, attempts, created_at, updated_at)
                     VALUES (?1, ?2, 'queued', 0, ?3, ?3)",
                    params![document_id, generation_id, now],
                )?;
                enqueued += 1;
            }
        }
        tx.commit()?;
        Ok(enqueued)
    }

    // ---------- vector index ----------

    /// 按需打开派生向量库。只有当向量文件已存在（某 generation 曾被创建）
    /// 时才会成功；没有 embedding 配置时绝不创建该文件。
    pub fn open_vector_index(&self) -> Option<super::vector::VectorIndex> {
        if !self.memory_path.with_file_name("memory-vector.sqlite").exists() {
            return None;
        }
        super::vector::VectorIndex::open(&self.memory_path).ok()
    }

    /// 从所有 generation 的派生索引中删除一个文档的向量。失败时索引内部
    /// 会写墓碑，保证被遗忘的记忆不再被召回（design §10.3）。
    pub fn delete_document_vectors(&self, document_id: &str) {
        let Some(index) = self.open_vector_index() else {
            return;
        };
        let Ok(generations) = self.list_embedding_generations() else {
            return;
        };
        for generation in &generations {
            if let Err(error) =
                index.delete_documents(&generation.id, std::slice::from_ref(&document_id.to_string()))
            {
                tracing::warn!(document_id, %error, "vector delete failed");
            }
        }
    }

    /// 共享索引上的语义召回：query 向量 → 分区 KNN → 回读主库事实。
    /// 任一步失败都退化为关键词召回，绝不让 embedding 问题破坏聊天。
    pub async fn recall_semantic_entries(
        &self,
        provider: &dyn super::embedding::EmbeddingProvider,
        generation_id: &str,
        query: &str,
        scope_keys: &[String],
        limit: usize,
    ) -> Result<Vec<worldbase_protocol::types::WorkspaceMemoryEntry>> {
        let vector = provider.embed_query(query).await?;
        let index = self
            .open_vector_index()
            .ok_or_else(|| anyhow!("vector index unavailable"))?;
        let kinds = vec![EMBEDDING_SOURCE_MEMORY.to_string()];
        let hits = index.query(
            generation_id,
            &super::vector::VectorKnnQuery {
                vector: &vector,
                scope_keys,
                document_kinds: &kinds,
                limit,
            },
        )?;
        let mut entries = Vec::new();
        for hit in hits {
            let Some(source_id) = hit
                .document_id
                .strip_prefix(&format!("{EMBEDDING_SOURCE_MEMORY}:"))
            else {
                continue;
            };
            // Governance gate: only active, non-expired entries participate
            // in recall (design §6.1).
            let recallable: Option<i64> = {
                let conn = self.memory_conn.lock().unwrap();
                conn.query_row(
                    "SELECT 1 FROM memory_entries
                     WHERE id = ?1
                       AND COALESCE(status, 'active') = 'active'
                       AND (expires_at IS NULL OR expires_at > ?2)",
                    rusqlite::params![source_id, now_iso()],
                    |row| row.get(0),
                )
                .ok()
            };
            if recallable.is_none() {
                continue;
            }
            if let Some(entry) = self.get_workspace_memory(source_id)? {
                entries.push(entry);
            }
        }
        Ok(entries)
    }
}

#[derive(Debug, Clone, Default)]
pub struct EmbeddingGenerationPatch {
    pub status: Option<String>,
    pub total_documents: Option<i64>,
    pub indexed_documents: Option<i64>,
    pub failed_documents: Option<i64>,
    pub dimensions: Option<i64>,
    pub activated_at: Option<String>,
}

fn row_to_document(row: &rusqlite::Row<'_>) -> rusqlite::Result<EmbeddingDocumentRow> {
    Ok(EmbeddingDocumentRow {
        id: row.get("id")?,
        source_type: row.get("source_type")?,
        source_id: row.get("source_id")?,
        scope_type: row.get("scope_type")?,
        scope_id: row.get("scope_id")?,
        embedding_text: row.get("embedding_text")?,
        content_hash: row.get("content_hash")?,
        active_generation_id: row.get("active_generation_id")?,
        status: row.get("status")?,
        retry_count: row.get::<_, Option<i64>>("retry_count")?.unwrap_or(0),
        last_error: row.get("last_error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<EmbeddingJobRow> {
    Ok(EmbeddingJobRow {
        id: row.get("id")?,
        document_id: row.get("document_id")?,
        generation_id: row.get("generation_id")?,
        status: row.get("status")?,
        attempts: row.get("attempts")?,
        next_retry_at: row.get("next_retry_at")?,
        error_message: row.get("error_message")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_generation(row: &rusqlite::Row<'_>) -> rusqlite::Result<EmbeddingGenerationRow> {
    Ok(EmbeddingGenerationRow {
        id: row.get("id")?,
        provider_id: row.get("provider_id")?,
        model_id: row.get("model_id")?,
        model_revision: row.get("model_revision")?,
        dimensions: row.get("dimensions")?,
        distance_metric: row.get("distance_metric")?,
        normalized: row.get::<_, Option<i64>>("normalized")?.unwrap_or(0) != 0,
        preprocess_version: row.get("preprocess_version")?,
        index_path: row.get("index_path")?,
        status: row.get("status")?,
        total_documents: row.get::<_, Option<i64>>("total_documents")?.unwrap_or(0),
        indexed_documents: row.get::<_, Option<i64>>("indexed_documents")?.unwrap_or(0),
        failed_documents: row.get::<_, Option<i64>>("failed_documents")?.unwrap_or(0),
        created_at: row.get("created_at")?,
        activated_at: row.get("activated_at")?,
    })
}
