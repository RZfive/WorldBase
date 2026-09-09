//! LLM provider 抽象与实现。
//!
//! - `AnthropicProvider`: Messages API SSE 流式（含 tool_use 块）
//! - `OpenAIProvider`: Chat Completions SSE 流式（含 tool_calls，支持 base_url
//!   覆盖以兼容 OpenAI 兼容端点）
//! - `MockProvider`: 脚本化回复，供测试与无 key 演示
//!
//! SSE 解析使用跨网络 chunk 的缓冲行解析器，修复 P0 版本按 chunk 边界
//! 截断事件的问题。

use anyhow::Result;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use worldbase_protocol::types::ProviderConfig;

pub mod anthropic;
pub mod entry;
mod http;
pub mod mock;
pub mod openai;
mod remote_models;
pub mod sse;
mod tool_input;
mod urls;

pub use anthropic::AnthropicProvider;
pub use entry::{
    create_provider_from_entry, generate_images, pixel_size, resolve_protocol, size_for,
    GeneratedImage, ImageParams,
};
pub use mock::{MockProvider, MockTurn};
pub use openai::OpenAIProvider;
pub use remote_models::fetch_remote_models;

/// 消息内容块（对齐 Anthropic content blocks / OpenAI tool 消息）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    /// A data URL or remote URL supplied by the host as a user image part.
    /// OpenAI-compatible endpoints accept this directly; Anthropic maps data
    /// URLs to base64 sources and remote URLs to URL sources.
    ImageUrl {
        url: String,
    },
    /// Anthropic extended-thinking content. The signature is opaque and must
    /// be replayed byte-for-byte when a tool result continues the response.
    Thinking {
        thinking: String,
        signature: String,
    },
    /// Anthropic may encrypt thinking that trips a safety classifier. This
    /// opaque payload must also be replayed unchanged on continuation.
    RedactedThinking {
        data: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
        /// Original provider text when arguments could not be parsed. OpenAI
        /// can replay it verbatim; object-only protocols use `input` instead.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        raw_input: Option<String>,
        /// Parsing failures remain a tool-level error so the model can repair
        /// its next call instead of terminating the entire response stream.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_error: Option<String>,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

/// LLM 层消息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmMessage {
    pub role: LlmRole,
    pub content: Vec<ContentBlock>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LlmRole {
    User,
    Assistant,
}

impl LlmMessage {
    pub fn text(role: LlmRole, text: impl Into<String>) -> Self {
        Self {
            role,
            content: vec![ContentBlock::Text { text: text.into() }],
        }
    }

    /// 提取纯文本视图。
    pub fn text_view(&self) -> String {
        let mut out = String::new();
        for block in &self.content {
            if let ContentBlock::Text { text } = block {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text);
            }
        }
        out
    }

    pub fn tool_uses(&self) -> Vec<(String, String, Value)> {
        self.content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ToolUse {
                    id, name, input, ..
                } => Some((id.clone(), name.clone(), input.clone())),
                _ => None,
            })
            .collect()
    }
}

/// 提供给模型的工具定义。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// Provider-native controls supplied for a single run. Keeping this separate
/// from a saved provider entry prevents a temporary Electron slider change
/// from leaking into another conversation.
#[derive(Debug, Clone, Default)]
pub struct ChatOptions {
    pub temperature: Option<f32>,
    /// Reasoning controls are opt-in. An effort value can remain selected in
    /// the UI while thinking is disabled, so providers must check this flag
    /// before adding any provider-specific reasoning parameter.
    pub enable_thinking: bool,
    pub reasoning_effort: Option<String>,
}

/// token 用量（对齐供应商回传）。
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: u64,
    #[serde(default)]
    pub cache_creation_tokens: u64,
}

/// 流式输出块。provider 内部累积，`Completed` 携带完整助手消息与用量。
#[derive(Debug, Clone)]
pub enum StreamChunk {
    TextDelta(String),
    ThinkingDelta(String),
    Completed {
        stop_reason: String,
        assistant: LlmMessage,
        #[allow(dead_code)]
        usage: TokenUsage,
    },
}

pub type ChunkStream = BoxStream<'static, Result<StreamChunk>>;

#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &str;
    fn model(&self) -> &str;

    /// system 为系统提示词；messages 为 user/assistant 交替历史。
    async fn chat_stream(
        &self,
        system: Option<&str>,
        messages: Vec<LlmMessage>,
        tools: Vec<LlmTool>,
        max_tokens: u32,
        options: ChatOptions,
    ) -> Result<ChunkStream>;
}

/// 按 ProviderConfig 构建 provider 实例。
pub fn create_provider(cfg: &ProviderConfig) -> Result<std::sync::Arc<dyn Provider>> {
    match cfg.kind.as_str() {
        "anthropic" => Ok(std::sync::Arc::new(AnthropicProvider::new(
            cfg.api_key.clone(),
            cfg.model.clone(),
            cfg.base_url.clone(),
        )?)),
        "openai" | "openai-compatible" => Ok(std::sync::Arc::new(OpenAIProvider::new(
            cfg.api_key.clone(),
            cfg.model.clone(),
            cfg.base_url.clone(),
        ))),
        "mock" => Ok(std::sync::Arc::new(MockProvider::default_script(
            cfg.model.clone(),
        ))),
        other => anyhow::bail!("unknown provider kind: {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_text_view() {
        let m = LlmMessage {
            role: LlmRole::Assistant,
            content: vec![
                ContentBlock::Text {
                    text: "hello".into(),
                },
                ContentBlock::ToolUse {
                    id: "t1".into(),
                    name: "read_file".into(),
                    input: serde_json::json!({}),
                    raw_input: None,
                    input_error: None,
                },
                ContentBlock::Text {
                    text: "world".into(),
                },
            ],
        };
        assert_eq!(m.text_view(), "hello\nworld");
        assert_eq!(m.tool_uses().len(), 1);
    }
}
