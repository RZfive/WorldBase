//! 远程 embedding 供应商适配（design §7）。
//!
//! 模型权重永不落盘、不进安装包：向量由供应商 API 生成，数据库只保存
//! 指纹（维度、距离、输入模板、预处理版本）。所有实现仅把文本转换为
//! `Vec<f32>`，供 `VectorIndex` 与召回流程使用。

use anyhow::{anyhow, Context as _, Result};
use async_trait::async_trait;
use serde_json::json;

/// 当前文本预处理契约；变更必须建立新 generation（design §7.5）。
pub const EMBEDDING_PREPROCESS_VERSION: &str = "pp-v1";

#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddingModelDescriptor {
    pub provider_id: String,
    pub model_id: String,
    pub dimensions: u32,
    pub distance: String,
    pub normalized: bool,
    pub preprocess_version: String,
}

/// 供应商 embedding 客户端的最小接口。
#[async_trait]
pub trait EmbeddingProvider: Send + Sync {
    fn descriptor(&self) -> EmbeddingModelDescriptor;
    async fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
    async fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        let vectors = self.embed_documents(std::slice::from_ref(&text.to_string())).await?;
        vectors.into_iter().next().ok_or_else(|| anyhow!("empty embedding response"))
    }
    async fn health(&self) -> Result<u32> {
        let vectors = self.embed_documents(&["health check".to_string()]).await?;
        let length = vectors.first().map(|vector| vector.len() as u32).unwrap_or(0);
        Ok(length)
    }
}

fn apply_prefix(text: &str, prefix: Option<&str>) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match prefix {
        Some(prefix) if !normalized.starts_with(prefix) => format!("{prefix}{normalized}"),
        _ => normalized,
    }
}

/// 离线开发与测试用确定性 embedding。与 TypeScript 侧的
/// `FakeEmbeddingService` 使用同一套分词 + FNV-1a 桶哈希 + L2 归一化，
/// 两端的测试数据行为一致。
pub struct FakeEmbeddingProvider {
    dimensions: u32,
}

impl FakeEmbeddingProvider {
    pub fn new(dimensions: u32) -> Self {
        Self { dimensions: dimensions.max(1) }
    }

    fn embed(&self, text: &str) -> Vec<f32> {
        let mut vector = vec![0f32; self.dimensions as usize];
        let normalized = text.to_lowercase();
        let mut tokens: Vec<String> = regex::Regex::new(r"[\p{L}\p{N}_-]+")
            .map(|expression| {
                expression
                    .find_iter(&normalized)
                    .map(|matched| matched.as_str().to_string())
                    .collect()
            })
            .unwrap_or_default();
        let compact: String = normalized
            .chars()
            .filter(|character| character.is_alphanumeric())
            .collect();
        let characters: Vec<char> = compact.chars().collect();
        if characters.iter().any(|c| ('\u{4e00}'..='\u{9fff}').contains(c)) {
            for window in characters.windows(2) {
                tokens.push(window.iter().collect());
            }
        }
        for token in &tokens {
            let bucket = fnv1a_hash(token) % self.dimensions as u64;
            vector[bucket as usize] += 1.0;
        }
        let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 0.0 {
            for value in &mut vector {
                *value /= norm;
            }
        }
        vector
    }
}

fn fnv1a_hash(token: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in token.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[async_trait]
impl EmbeddingProvider for FakeEmbeddingProvider {
    fn descriptor(&self) -> EmbeddingModelDescriptor {
        EmbeddingModelDescriptor {
            provider_id: "fake".into(),
            model_id: "fake-embedding".into(),
            dimensions: self.dimensions,
            distance: "cosine".into(),
            normalized: true,
            preprocess_version: EMBEDDING_PREPROCESS_VERSION.into(),
        }
    }

    async fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(texts.iter().map(|text| self.embed(text)).collect())
    }
}

fn normalize_embeddings_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.ends_with("/embeddings") {
        return trimmed.to_string();
    }
    if let Some(stripped) = trimmed.strip_suffix("/chat/completions") {
        return format!("{stripped}/embeddings");
    }
    format!("{trimmed}/embeddings")
}

/// OpenAI 兼容 `/embeddings` 客户端（design §7.2/§7.4）。
pub struct OpenAIEmbeddingProvider {
    pub provider_id: String,
    pub base_url: String,
    pub api_key: String,
    pub model_id: String,
    pub dimensions: Option<u32>,
    pub distance: String,
    pub normalized: bool,
    pub query_prefix: Option<String>,
    pub document_prefix: Option<String>,
    client: reqwest::Client,
}

impl OpenAIEmbeddingProvider {
    pub fn new(
        provider_id: &str,
        base_url: &str,
        api_key: &str,
        model_id: &str,
        dimensions: Option<u32>,
        distance: Option<&str>,
        normalized: bool,
        query_prefix: Option<&str>,
        document_prefix: Option<&str>,
    ) -> Self {
        Self {
            provider_id: provider_id.to_string(),
            base_url: base_url.to_string(),
            api_key: api_key.to_string(),
            model_id: model_id.to_string(),
            dimensions,
            distance: distance.unwrap_or("cosine").to_string(),
            normalized,
            query_prefix: query_prefix.map(str::to_string),
            document_prefix: document_prefix.map(str::to_string),
            client: reqwest::Client::new(),
        }
    }

    async fn request_embeddings(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>> {
        let url = normalize_embeddings_base_url(&self.base_url);
        if url.is_empty() {
            return Err(anyhow!("embedding base url is empty"));
        }
        let response = self
            .client
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&json!({ "model": self.model_id, "input": inputs }))
            .send()
            .await
            .context("embedding request failed")?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "embedding request failed ({}): {}",
                status,
                body.chars().take(300).collect::<String>()
            ));
        }
        let payload: serde_json::Value = response.json().await.context("embedding response is not JSON")?;
        let data = payload
            .get("data")
            .and_then(|value| value.as_array())
            .ok_or_else(|| anyhow!("embedding response has no data array"))?;
        if data.len() != inputs.len() {
            return Err(anyhow!(
                "embedding response count mismatch: expected {}, got {}",
                inputs.len(),
                data.len()
            ));
        }
        let mut indexed: Vec<(usize, Vec<f32>)> = data
            .iter()
            .enumerate()
            .map(|(position, item)| {
                let index = item
                    .get("index")
                    .and_then(|value| value.as_u64())
                    .unwrap_or(position as u64) as usize;
                let values = item
                    .get("embedding")
                    .and_then(|value| value.as_array())
                    .ok_or_else(|| anyhow!("embedding entry {index} has no array"))?;
                let mut vector = vec![0f32; values.len()];
                for (slot, value) in vector.iter_mut().zip(values) {
                    *slot = value.as_f64().unwrap_or(0.0) as f32;
                }
                Ok((index, vector))
            })
            .collect::<Result<Vec<_>>>()?;
        indexed.sort_by_key(|(index, _)| *index);
        Ok(indexed.into_iter().map(|(_, vector)| vector).collect())
    }
}

#[async_trait]
impl EmbeddingProvider for OpenAIEmbeddingProvider {
    fn descriptor(&self) -> EmbeddingModelDescriptor {
        EmbeddingModelDescriptor {
            provider_id: self.provider_id.clone(),
            model_id: self.model_id.clone(),
            dimensions: self.dimensions.unwrap_or(0),
            distance: self.distance.clone(),
            normalized: self.normalized,
            preprocess_version: EMBEDDING_PREPROCESS_VERSION.into(),
        }
    }

    async fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let inputs: Vec<String> = texts
            .iter()
            .map(|text| apply_prefix(text, self.document_prefix.as_deref()))
            .collect();
        let vectors = self.request_embeddings(&inputs).await?;
        Ok(vectors)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeddings_url_follows_chat_provider_conventions() {
        assert_eq!(
            normalize_embeddings_base_url("https://api.example.com/v1"),
            "https://api.example.com/v1/embeddings"
        );
        assert_eq!(
            normalize_embeddings_base_url("https://api.example.com/v1/"),
            "https://api.example.com/v1/embeddings"
        );
        assert_eq!(
            normalize_embeddings_base_url("https://api.example.com/v1/chat/completions"),
            "https://api.example.com/v1/embeddings"
        );
        assert_eq!(
            normalize_embeddings_base_url("https://api.example.com/v1/embeddings"),
            "https://api.example.com/v1/embeddings"
        );
    }

    #[tokio::test]
    async fn fake_embeddings_are_deterministic_and_normalized() {
        let provider = FakeEmbeddingProvider::new(64);
        let vectors = provider
            .embed_documents(&["用户喜欢先看到结论".into(), "用户喜欢先看到结论".into(), "SQLite 存储项目数据".into()])
            .await
            .unwrap();
        assert_eq!(vectors[0], vectors[1]);
        let norm: f32 = vectors[0].iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4);
        let query = provider.embed_query("用户喜欢先看到结论").await.unwrap();
        let same: f32 = query.iter().zip(&vectors[0]).map(|(a, b)| a * b).sum();
        let other: f32 = query.iter().zip(&vectors[2]).map(|(a, b)| a * b).sum();
        assert!(same > other, "similar text must score higher than unrelated text");
    }
}
