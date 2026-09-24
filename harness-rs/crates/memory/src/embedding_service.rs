//! 异步 embedding 任务队列（design §6.4、§10.1）。
//!
//! 事实写入与任务入队在主库事务内完成；真正的供应商调用与向量写入由
//! 本队列后台执行。Electron 与 Rust 可能同时运行各自的队列——任务认领
//! 使用 SQLite 即时事务，同一任务只会被一个消费者处理。

use super::embedding::{
    EmbeddingProvider, FakeEmbeddingProvider, OpenAIEmbeddingProvider,
    EMBEDDING_PREPROCESS_VERSION,
};
use super::embedding_store::{
    EmbeddingDocumentRow, EmbeddingGenerationPatch, EmbeddingGenerationRow,
};
use super::vector::{VectorIndex, VectorUpsertItem};
use super::Store;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify, RwLock};
use worldbase_protocol::types::MemoryEmbeddingRuntimeConfig;

const DEFAULT_BATCH_SIZE: u32 = 16;
const DEFAULT_MAX_ATTEMPTS: i64 = 5;
const RETRY_BASE_DELAY_MS: u64 = 30_000;
const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(15);

/// 进程内共享记忆 embedding 服务：配置 + 后台队列 + 向量索引生命周期。
pub struct MemoryEmbeddingQueue {
    store: Arc<Store>,
    config: RwLock<Option<MemoryEmbeddingRuntimeConfig>>,
    notify: Notify,
    running: Mutex<bool>,
}

impl MemoryEmbeddingQueue {
    pub fn new(store: Arc<Store>) -> Arc<Self> {
        Arc::new(Self {
            store,
            config: RwLock::new(None),
            notify: Notify::new(),
            running: Mutex::new(false),
        })
    }

    /// 更新当前 embedding 模型配置；`None` 表示停用（不再调用 API）。
    pub async fn set_config(&self, config: Option<MemoryEmbeddingRuntimeConfig>) {
        *self.config.write().await = config;
        self.notify.notify_waiters();
    }

    pub async fn config(&self) -> Option<MemoryEmbeddingRuntimeConfig> {
        self.config.read().await.clone()
    }

    /// 启动后台循环（幂等）。测试可以不调用它，直接驱动 `drain_once`。
    pub async fn start(self: &Arc<Self>) {
        let mut running = self.running.lock().await;
        if *running {
            return;
        }
        *running = true;
        drop(running);
        let queue = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                let processed = queue.drain_once().await;
                if processed == 0 {
                    tokio::select! {
                        _ = tokio::time::sleep(POLL_INTERVAL) => {}
                        _ = queue.notify.notified() => {}
                    }
                }
            }
        });
    }

    /// 构造 provider。`WORLDBASE_FAKE_EMBEDDING=1` 时使用离线确定性实现，
    /// 供开发与测试环境使用，与 Electron 侧行为一致。
    pub fn provider_for(&self, config: &MemoryEmbeddingRuntimeConfig) -> Arc<dyn EmbeddingProvider> {
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

    /// 处理一批到期任务，返回处理数量。没有配置或没有可用 generation 时
    /// 返回 0，任务保持原状——未配置模型绝不产生 embedding 网络请求。
    pub async fn drain_once(&self) -> usize {
        let Some(config) = self.config().await else {
            return 0;
        };
        let Some(generation) = self.ensure_target_generation(&config).await else {
            return 0;
        };
        // Generation 引导或模型重建后，先补齐缺失任务再消费。
        let _ = self.store.backfill_embedding_jobs(&generation.id);
        let Ok(jobs) = self.store.claim_due_embedding_jobs(DEFAULT_BATCH_SIZE) else {
            return 0;
        };
        if jobs.is_empty() {
            self.promote_generation_if_ready(&generation.id).await;
            return 0;
        }

        let Ok(documents) = self.store.get_embedding_documents_by_ids(
            &jobs.iter().map(|job| job.document_id.clone()).collect::<Vec<_>>(),
        ) else {
            return jobs.len();
        };
        let by_id: std::collections::HashMap<String, EmbeddingDocumentRow> = documents
            .into_iter()
            .map(|document| (document.id.clone(), document))
            .collect();
        let pending: Vec<(&_, &EmbeddingDocumentRow)> = jobs
            .iter()
            .filter_map(|job| by_id.get(&job.document_id).map(|document| (job, document)))
            .collect();
        if pending.is_empty() {
            for job in &jobs {
                let _ = self.store.update_embedding_job_status(job.id, "failed", job.attempts + 1, None, Some("embedding document not found"));
            }
            return jobs.len();
        }

        let provider = self.provider_for(&config);
        let texts: Vec<String> = pending
            .iter()
            .map(|(_, document)| document.embedding_text.clone())
            .collect();
        let vectors = match provider.embed_documents(&texts).await {
            Ok(vectors) => vectors,
            Err(error) => {
                for (job, _) in &pending {
                    self.fail_job(job, &error.to_string());
                }
                return pending.len();
            }
        };

        let Ok(mut index) = VectorIndex::open(&self.store_memory_path()) else {
            let message = "vector index unavailable".to_string();
            for (job, _) in &pending {
                self.fail_job(job, &message);
            }
            return pending.len();
        };
        if let Err(error) = index.ensure_generation(&generation.id, generation.dimensions.max(1) as u32, &generation.distance_metric) {
            let message = error.to_string();
            for (job, _) in &pending {
                self.fail_job(job, &message);
            }
            return pending.len();
        }

        for (position, (job, document)) in pending.iter().enumerate() {
            let Some(vector) = vectors.get(position) else {
                self.fail_job(job, "empty embedding vector");
                continue;
            };
            let upsert = index.upsert(
                &generation.id,
                &VectorUpsertItem {
                    document_id: &document.id,
                    scope_key: &format!("{}:{}", document.scope_type, document.scope_id),
                    document_kind: &document.source_type,
                    vector,
                },
                &document.content_hash,
            );
            match upsert {
                Ok(()) => {
                    let mut indexed = (*document).clone();
                    indexed.status = "indexed".into();
                    indexed.active_generation_id = Some(generation.id.clone());
                    indexed.last_error = None;
                    indexed.updated_at = super::vector::now_iso();
                    let _ = self.store.upsert_embedding_document(&indexed);
                    let _ = self.store.update_embedding_job_status(job.id, "succeeded", job.attempts + 1, None, None);
                }
                Err(error) => self.fail_job(job, &error.to_string()),
            }
        }
        let _ = self.store.refresh_embedding_generation_totals(&generation.id);
        self.promote_generation_if_ready(&generation.id).await;
        pending.len()
    }

    /// generation 就绪（全部索引成功且队列无积压）后切换 active 并退役旧
    /// generation（design §9.3）。
    pub async fn promote_generation_if_ready(&self, generation_id: &str) {
        let Ok(Some(generation)) = self.store.get_embedding_generation(generation_id) else {
            return;
        };
        if generation.status != "building" || generation.total_documents <= 0 {
            return;
        }
        if generation.indexed_documents < generation.total_documents || generation.failed_documents > 0 {
            return;
        }
        let Ok(counts) = self.store.count_embedding_jobs_by_status() else {
            return;
        };
        if counts.get("queued").copied().unwrap_or(0) > 0
            || counts.get("retry").copied().unwrap_or(0) > 0
            || counts.get("running").copied().unwrap_or(0) > 0
        {
            return;
        }
        let previous = self.store.active_embedding_generation().ok().flatten();
        let _ = self.store.update_embedding_generation(
            generation_id,
            &EmbeddingGenerationPatch {
                status: Some("active".into()),
                activated_at: Some(super::vector::now_iso()),
                ..Default::default()
            },
        );
        if let Some(previous) = previous.filter(|previous| previous.id != generation_id) {
            let _ = self.store.update_embedding_generation(
                &previous.id,
                &EmbeddingGenerationPatch { status: Some("retired".into()), ..Default::default() },
            );
            if let Ok(mut index) = VectorIndex::open(&self.store_memory_path()) {
                index.drop_generation(&previous.id);
            }
        }
    }

    /// 无可用 generation 时按配置引导一个（CLI 全 Rust 模式下 Electron 不
    /// 存在，Rust 是唯一的 generation 管理者）。
    async fn ensure_target_generation(&self, config: &MemoryEmbeddingRuntimeConfig) -> Option<EmbeddingGenerationRow> {
        if let Ok(Some(target)) = self.store.target_embedding_generation() {
            return Some(target);
        }
        let provider = self.provider_for(config);
        let declared = config.dimensions.filter(|dimensions| *dimensions > 0);
        let dimensions = match declared {
            Some(dimensions) => Some(dimensions),
            None => provider.health().await.ok(),
        }
        .unwrap_or(0);
        if dimensions == 0 {
            return None;
        }
        let generation = EmbeddingGenerationRow {
            id: format!("gen_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_millis()),
            provider_id: config.provider_id.clone(),
            model_id: config.model_id.clone(),
            model_revision: None,
            dimensions: dimensions as i64,
            distance_metric: config.distance.clone().unwrap_or_else(|| "cosine".into()),
            normalized: config.normalized.unwrap_or(false),
            preprocess_version: EMBEDDING_PREPROCESS_VERSION.into(),
            index_path: self.store_memory_path().with_file_name("memory-vector.sqlite").display().to_string(),
            status: "building".into(),
            total_documents: 0,
            indexed_documents: 0,
            failed_documents: 0,
            created_at: super::vector::now_iso(),
            activated_at: None,
        };
        self.store.insert_embedding_generation(&generation).ok()?;
        Some(generation)
    }

    fn fail_job(&self, job: &super::embedding_store::EmbeddingJobRow, message: &str) {
        let attempts = job.attempts + 1;
        if attempts >= DEFAULT_MAX_ATTEMPTS {
            let _ = self.store.update_embedding_job_status(job.id, "failed", attempts, None, Some(message));
            return;
        }
        let delay = RETRY_BASE_DELAY_MS * 2u64.pow((attempts - 1).min(10) as u32);
        let next_retry_at = super::vector::now_after_millis(delay);
        let _ = self.store.update_embedding_job_status(job.id, "retry", attempts, Some(&next_retry_at), Some(message));
    }

    fn store_memory_path(&self) -> std::path::PathBuf {
        self.store.memory_database_file()
    }
}

