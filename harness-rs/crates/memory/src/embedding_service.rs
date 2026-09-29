//! Rust-owned background embedding queue. Durable facts/jobs live in the main
//! memory database; provider calls and the derived vector index are asynchronous.

use super::embedding::{
    EmbeddingProvider, FakeEmbeddingProvider, OpenAIEmbeddingProvider, EMBEDDING_PREPROCESS_VERSION,
};
use super::embedding_store::{
    embedding_config_fingerprint, EmbeddingGenerationPatch, EmbeddingGenerationRow, EmbeddingJobRow,
};
use super::vector::{VectorIndex, VectorUpsertItem};
use super::Store;
use anyhow::{anyhow, Result};
use std::sync::Arc;
use tokio::sync::{Mutex, Notify, RwLock};
use worldbase_protocol::types::MemoryEmbeddingRuntimeConfig;

// A claim controls queue throughput, not the provider's HTTP input limit.
// The embedding adapter splits this work into API-compatible requests.
const DEFAULT_JOB_BATCH_SIZE: u32 = 16;
const DEFAULT_MAX_ATTEMPTS: i64 = 5;
const RETRY_BASE_DELAY_MS: u64 = 30_000;
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

pub struct MemoryEmbeddingQueue {
    store: Arc<Store>,
    config: RwLock<Option<MemoryEmbeddingRuntimeConfig>>,
    last_error: RwLock<Option<String>>,
    notify: Notify,
    running: Mutex<bool>,
    draining: Mutex<()>,
}

impl MemoryEmbeddingQueue {
    pub fn new(store: Arc<Store>) -> Arc<Self> {
        Arc::new(Self {
            store,
            config: RwLock::new(None),
            last_error: RwLock::new(None),
            notify: Notify::new(),
            running: Mutex::new(false),
            draining: Mutex::new(()),
        })
    }

    /// None disables new network work. This is also used when a host clears
    /// the setting; merely omitting the next chat's config would not stop a queue.
    pub async fn set_config(&self, config: Option<MemoryEmbeddingRuntimeConfig>) {
        let mut current = self.config.write().await;
        if *current != config {
            *current = config;
            *self.last_error.write().await = None;
        }
        self.notify.notify_one();
    }

    pub async fn config(&self) -> Option<MemoryEmbeddingRuntimeConfig> {
        self.config.read().await.clone()
    }

    pub async fn start(self: &Arc<Self>) {
        let mut running = self.running.lock().await;
        if *running {
            return;
        }
        *running = true;
        let queue = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                if queue.drain_once().await == 0 {
                    tokio::select! {
                        _ = tokio::time::sleep(POLL_INTERVAL) => {}
                        _ = queue.notify.notified() => {}
                    }
                }
            }
        });
    }

    pub fn provider_for(
        &self,
        config: &MemoryEmbeddingRuntimeConfig,
    ) -> Arc<dyn EmbeddingProvider> {
        if std::env::var("WORLDBASE_FAKE_EMBEDDING").ok().as_deref() == Some("1") {
            return Arc::new(FakeEmbeddingProvider::new(config.dimensions.unwrap_or(64)));
        }
        Arc::new(OpenAIEmbeddingProvider::new(
            &config.provider_id,
            &config.base_url,
            &config.api_key,
            &config.model_id,
            config.dimensions,
            config.distance.as_deref(),
            config.normalized.unwrap_or(false),
            config.query_prefix.as_deref(),
            config.document_prefix.as_deref(),
        ))
    }

    pub async fn drain_once(&self) -> usize {
        let _draining = self.draining.lock().await;
        let Some(config) = self.config().await else {
            return 0;
        };
        match self.drain_batch(&config).await {
            Ok(count) => count,
            Err(error) => {
                tracing::warn!(%error, "memory embedding pipeline unavailable");
                if self.config().await.as_ref() == Some(&config) {
                    *self.last_error.write().await = Some(error.to_string());
                }
                0
            }
        }
    }

    async fn drain_batch(&self, config: &MemoryEmbeddingRuntimeConfig) -> Result<usize> {
        self.store.backfill_embedding_documents()?;
        if self.store.embedding_document_counts(None)?.0 == 0 {
            return Ok(0);
        }
        let generation = self.ensure_target_generation(config).await?;
        // Health probing may have awaited while the user disabled or changed
        // the setting. Do not send a document batch after that change.
        if self.config().await.as_ref() != Some(config) {
            return Ok(0);
        }
        self.store.backfill_embedding_jobs(&generation.id)?;
        let jobs = self
            .store
            .claim_due_embedding_jobs(&generation.id, DEFAULT_JOB_BATCH_SIZE)?;
        if jobs.is_empty() {
            self.promote_generation_if_ready(&generation.id).await;
            return Ok(0);
        }
        let documents = self.store.get_embedding_documents_by_ids(
            &jobs
                .iter()
                .map(|job| job.document_id.clone())
                .collect::<Vec<_>>(),
        )?;
        let by_id: std::collections::HashMap<_, _> = documents
            .into_iter()
            .map(|document| (document.id.clone(), document))
            .collect();
        let pending: Vec<_> = jobs
            .iter()
            .filter_map(|job| by_id.get(&job.document_id).map(|document| (job, document)))
            .collect();
        for job in jobs
            .iter()
            .filter(|job| !by_id.contains_key(&job.document_id))
        {
            self.store.update_embedding_job_status(
                job.id,
                "canceled",
                job.attempts,
                None,
                Some("memory was deleted"),
            )?;
        }
        if pending.is_empty() {
            return Ok(jobs.len());
        }
        let texts = pending
            .iter()
            .map(|(_, document)| document.embedding_text.clone())
            .collect::<Vec<_>>();
        let vectors = self.provider_for(config).embed_documents(&texts).await;
        // A model switch/disable during the API call must not activate or
        // write old-space vectors as if they belonged to the current setting.
        if self.config().await.as_ref() != Some(config) {
            for (job, _) in &pending {
                self.store.update_embedding_job_status(
                    job.id,
                    "queued",
                    job.attempts,
                    None,
                    None,
                )?;
            }
            return Ok(0);
        }
        let vectors = match vectors {
            Ok(vectors) => vectors,
            Err(error) => {
                for (job, _) in &pending {
                    self.fail_job(job, &error.to_string())?;
                }
                self.store
                    .refresh_embedding_generation_totals(&generation.id)?;
                return Ok(pending.len());
            }
        };
        let index = (|| -> Result<VectorIndex> {
            let mut index = VectorIndex::open(&self.store.memory_database_file())?;
            index.ensure_generation(
                &generation.id,
                generation.dimensions as u32,
                &generation.distance_metric,
            )?;
            Ok(index)
        })();
        let index = match index {
            Ok(index) => index,
            Err(error) => {
                for (job, _) in &pending {
                    self.fail_job(job, &error.to_string())?;
                }
                self.store
                    .refresh_embedding_generation_totals(&generation.id)?;
                return Ok(pending.len());
            }
        };
        for (position, (job, document)) in pending.iter().enumerate() {
            let Some(vector) = vectors.get(position).filter(|vector| {
                vector.len() == generation.dimensions as usize
                    && vector.iter().all(|v| v.is_finite())
            }) else {
                self.fail_job(
                    job,
                    "embedding dimensions/values do not match the generation",
                )?;
                continue;
            };
            let result = index.upsert(
                &generation.id,
                &VectorUpsertItem {
                    document_id: &document.id,
                    scope_key: &format!("{}:{}", document.scope_type, document.scope_id),
                    document_kind: &document.source_type,
                    vector,
                },
                &document.content_hash,
            );
            match result {
                Ok(()) => {
                    if !self.store.complete_embedding_job(job, document)? {
                        index
                            .delete_documents(&generation.id, std::slice::from_ref(&document.id))?;
                    }
                }
                Err(error) => self.fail_job(job, &error.to_string())?,
            }
        }
        *self.last_error.write().await = None;
        self.store
            .refresh_embedding_generation_totals(&generation.id)?;
        self.promote_generation_if_ready(&generation.id).await;
        Ok(pending.len())
    }

    pub async fn promote_generation_if_ready(&self, generation_id: &str) {
        let Ok(Some(generation)) = self.store.get_embedding_generation(generation_id) else {
            return;
        };
        let Some(config) = self.config().await else {
            return;
        };
        if !generation.matches_config(&config)
            || generation.status != "building"
            || generation.total_documents <= 0
            || generation.indexed_documents < generation.total_documents
            || generation.failed_documents > 0
        {
            return;
        }
        let previous = self.store.active_embedding_generation().ok().flatten();
        if self
            .store
            .update_embedding_generation(
                generation_id,
                &EmbeddingGenerationPatch {
                    status: Some("active".into()),
                    activated_at: Some(super::vector::now_iso()),
                    ..Default::default()
                },
            )
            .is_err()
        {
            return;
        }
        if let Some(previous) = previous.filter(|previous| previous.id != generation_id) {
            let _ = self.store.update_embedding_generation(
                &previous.id,
                &EmbeddingGenerationPatch {
                    status: Some("retired".into()),
                    ..Default::default()
                },
            );
            if let Ok(mut index) = VectorIndex::open(&self.store.memory_database_file()) {
                index.drop_generation(&previous.id);
            }
        }
    }

    async fn ensure_target_generation(
        &self,
        config: &MemoryEmbeddingRuntimeConfig,
    ) -> Result<EmbeddingGenerationRow> {
        if let Some(target) = self.store.target_embedding_generation()? {
            if target.matches_config(config)
                && (target.status != "active" || self.store.open_vector_index().is_some())
            {
                return Ok(target);
            }
        }
        let dimensions = match config.dimensions.filter(|value| *value > 0) {
            Some(value) => value,
            None => self.provider_for(config).health().await?,
        };
        if dimensions == 0 {
            return Err(anyhow!("embedding provider returned zero dimensions"));
        }
        let generation = EmbeddingGenerationRow {
            id: format!("gen_{}", uuid::Uuid::new_v4().simple()),
            provider_id: config.provider_id.clone(),
            model_id: config.model_id.clone(),
            model_revision: None,
            dimensions: dimensions as i64,
            distance_metric: config.distance.clone().unwrap_or_else(|| "cosine".into()),
            normalized: config.normalized.unwrap_or(false),
            preprocess_version: EMBEDDING_PREPROCESS_VERSION.into(),
            index_path: self
                .store
                .memory_database_file()
                .with_file_name("memory-vector.sqlite")
                .display()
                .to_string(),
            status: "building".into(),
            total_documents: 0,
            indexed_documents: 0,
            failed_documents: 0,
            created_at: super::vector::now_iso(),
            activated_at: None,
            config_fingerprint: embedding_config_fingerprint(config, dimensions),
        };
        self.store.insert_embedding_generation(&generation)?;
        self.store.cancel_other_embedding_jobs(&generation.id)?;
        Ok(generation)
    }

    fn fail_job(&self, job: &EmbeddingJobRow, error: &str) -> Result<()> {
        let terminal = job.attempts + 1 >= DEFAULT_MAX_ATTEMPTS;
        let retry_at = (!terminal).then(|| {
            super::vector::now_after_millis(
                RETRY_BASE_DELAY_MS * 2u64.pow(job.attempts.min(10) as u32),
            )
        });
        self.store
            .fail_embedding_job(job, error, terminal, retry_at.as_deref())
    }

    pub async fn retry_failed(&self) -> Result<()> {
        self.store.retry_failed_embedding_jobs()?;
        *self.last_error.write().await = None;
        self.notify.notify_one();
        Ok(())
    }

    /// An actual pipeline snapshot. A selected provider alone is not "ready".
    /// No credentials or user text are returned to the renderer.
    pub async fn index_status(&self) -> Result<serde_json::Value> {
        let config = self.config().await;
        let mut generation = self
            .store
            .target_embedding_generation()?
            .filter(|generation| {
                config
                    .as_ref()
                    .is_some_and(|config| generation.matches_config(config))
            });
        let (total, indexed, failed, document_error) = self
            .store
            .embedding_document_counts(generation.as_ref().map(|g| g.id.as_str()))?;
        if let Some(generation) = &mut generation {
            generation.total_documents = total as i64;
            generation.indexed_documents = indexed as i64;
            generation.failed_documents = failed as i64;
        }
        let counts = self
            .store
            .embedding_job_counts(generation.as_ref().map(|g| g.id.as_str()))?;
        let last_error = self.last_error.read().await.clone().or(document_error);
        let vector_available = self.store.open_vector_index().is_some();
        let state = if config.is_none() {
            "disabled"
        } else if last_error.is_some() {
            "failed"
        } else if total == 0 {
            "empty"
        } else if generation.as_ref().is_some_and(|g| g.status == "active")
            && vector_available
            && indexed == total
        {
            "ready"
        } else if generation.is_some() {
            "indexing"
        } else {
            "waiting"
        };
        Ok(serde_json::json!({
            "embeddingEnabled": config.is_some(), "configured": config.is_some(), "state": state,
            "vectorAvailable": vector_available,
            "providerId": config.as_ref().map(|c| &c.provider_id), "modelId": config.as_ref().map(|c| &c.model_id),
            "dimensions": generation.as_ref().map(|g| g.dimensions), "generation": generation,
            "documents": {"total": total, "indexed": indexed, "queued": total.saturating_sub(indexed + failed), "failed": failed},
            "queue": {"queued": counts.get("queued").copied().unwrap_or(0) + counts.get("retry").copied().unwrap_or(0), "running": counts.get("running").copied().unwrap_or(0), "failed": counts.get("failed").copied().unwrap_or(0)},
            "lastError": last_error,
            "vectorDbPath": self.store.memory_database_file().with_file_name("memory-vector.sqlite").to_string_lossy(),
        }))
    }
}
