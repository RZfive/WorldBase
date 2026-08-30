//! Anthropic Messages API 流式 provider。

use super::sse::SseParser;
use super::{ChunkStream, ContentBlock, LlmMessage, LlmRole, LlmTool, Provider, StreamChunk};
use anyhow::{bail, Context, Result};
use futures::stream::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::pin::Pin;

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
pub const API_VERSION: &str = "2023-06-01";

pub struct AnthropicProvider {
    client: Client,
    api_key: String,
    model: String,
    base_url: String,
}

impl AnthropicProvider {
    pub fn new(api_key: String, model: String, base_url: Option<String>) -> Result<Self> {
        if api_key.is_empty() {
            bail!("anthropic provider requires an api key");
        }
        Ok(Self {
            client: Client::new(),
            api_key,
            model,
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.into()),
        })
    }

    fn to_wire_content(msg: &LlmMessage) -> Value {
        let blocks: Vec<Value> = msg
            .content
            .iter()
            .map(|b| match b {
                ContentBlock::Text { text } => json!({ "type": "text", "text": text }),
                ContentBlock::ToolUse { id, name, input } => {
                    json!({ "type": "tool_use", "id": id, "name": name, "input": input })
                }
                ContentBlock::ToolResult { tool_use_id, content, is_error } => json!({
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content,
                    "is_error": is_error,
                }),
            })
            .collect();
        Value::Array(blocks)
    }
}

enum BlockAcc {
    Text { text: String },
    ToolUse { id: String, name: String, json_acc: String },
}

struct StreamState {
    bytes: Pin<Box<dyn futures::Stream<Item = reqwest::Result<bytes::Bytes>> + Send>>,
    parser: SseParser,
    blocks: VecDeque<BlockAcc>,
    queue: VecDeque<Result<StreamChunk>>,
    stop_reason: String,
    input_tokens: u64,
    output_tokens: u64,
    finished: bool,
}

impl StreamState {
    fn on_event(&mut self, ev: &super::sse::SseEvent) {
        let Ok(payload) = serde_json::from_str::<Value>(&ev.data) else {
            return;
        };
        match payload["type"].as_str().unwrap_or("") {
            "content_block_start" => {
                let block = &payload["content_block"];
                match block["type"].as_str().unwrap_or("") {
                    "tool_use" => self.blocks.push_back(BlockAcc::ToolUse {
                        id: block["id"].as_str().unwrap_or_default().into(),
                        name: block["name"].as_str().unwrap_or_default().into(),
                        json_acc: String::new(),
                    }),
                    _ => self.blocks.push_back(BlockAcc::Text { text: String::new() }),
                }
            }
            "content_block_delta" => {
                let delta = &payload["delta"];
                match delta["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        let t = delta["text"].as_str().unwrap_or_default().to_string();
                        if let Some(BlockAcc::Text { text }) = self.blocks.back_mut() {
                            text.push_str(&t);
                        }
                        self.queue.push_back(Ok(StreamChunk::TextDelta(t)));
                    }
                    "input_json_delta" => {
                        if let Some(BlockAcc::ToolUse { json_acc, .. }) = self.blocks.back_mut() {
                            json_acc.push_str(delta["partial_json"].as_str().unwrap_or_default());
                        }
                    }
                    _ => {}
                }
            }
            "message_start" => {
                self.input_tokens = payload["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0);
            }
            "message_delta" => {
                if let Some(reason) = payload["delta"]["stop_reason"].as_str() {
                    self.stop_reason = reason.to_string();
                }
                self.output_tokens = payload["usage"]["output_tokens"].as_u64().unwrap_or(self.output_tokens);
            }
            "message_stop" => {
                let content: Vec<ContentBlock> = self
                    .blocks
                    .drain(..)
                    .map(|b| match b {
                        BlockAcc::Text { text } => ContentBlock::Text { text },
                        BlockAcc::ToolUse { id, name, json_acc } => ContentBlock::ToolUse {
                            id,
                            name,
                            input: if json_acc.trim().is_empty() {
                                json!({})
                            } else {
                                serde_json::from_str(&json_acc).unwrap_or(json!({}))
                            },
                        },
                    })
                    .collect();
                self.queue.push_back(Ok(StreamChunk::Completed {
                    stop_reason: std::mem::take(&mut self.stop_reason),
                    assistant: LlmMessage { role: LlmRole::Assistant, content },
                    usage: super::TokenUsage {
                        input_tokens: self.input_tokens,
                        output_tokens: self.output_tokens,
                    },
                }));
                self.finished = true;
            }
            "error" => {
                let msg = payload["error"]["message"].as_str().unwrap_or("unknown").to_string();
                self.queue.push_back(Err(anyhow::anyhow!("anthropic stream error: {msg}")));
                self.finished = true;
            }
            _ => {}
        }
    }
}

#[async_trait::async_trait]
impl Provider for AnthropicProvider {
    fn name(&self) -> &str {
        "anthropic"
    }

    fn model(&self) -> &str {
        &self.model
    }

    async fn chat_stream(
        &self,
        system: Option<&str>,
        messages: Vec<LlmMessage>,
        tools: Vec<LlmTool>,
        max_tokens: u32,
    ) -> Result<ChunkStream> {
        let mut body = json!({
            "model": self.model,
            "max_tokens": max_tokens,
            "stream": true,
            "messages": messages.iter().map(|m| json!({
                "role": match m.role { LlmRole::User => "user", LlmRole::Assistant => "assistant" },
                "content": Self::to_wire_content(m),
            })).collect::<Vec<_>>(),
        });
        if let Some(sys) = system {
            body["system"] = json!(sys);
        }
        if !tools.is_empty() {
            body["tools"] = json!(tools
                .iter()
                .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.input_schema }))
                .collect::<Vec<_>>());
        }

        let resp = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", API_VERSION)
            .json(&body)
            .send()
            .await
            .context("anthropic request failed")?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            bail!("anthropic api error ({status}): {text}");
        }

        let state = StreamState {
            bytes: Box::pin(resp.bytes_stream()),
            parser: SseParser::new(),
            blocks: VecDeque::new(),
            queue: VecDeque::new(),
            stop_reason: "end_turn".into(),
            input_tokens: 0,
            output_tokens: 0,
            finished: false,
        };

        let stream = futures::stream::unfold(state, |mut st| async move {
            loop {
                if st.finished {
                    if let Some(ev) = st.queue.pop_front() {
                        return Some((ev, st));
                    }
                    return None;
                }
                if let Some(ev) = st.queue.pop_front() {
                    return Some((ev, st));
                }
                match st.bytes.next().await {
                    None => return None,
                    Some(Err(e)) => return Some((Err(anyhow::anyhow!("stream read error: {e}")), st)),
                    Some(Ok(chunk)) => {
                        let text = String::from_utf8_lossy(&chunk);
                        for ev in st.parser.feed(&text) {
                            st.on_event(&ev);
                        }
                    }
                }
            }
        });

        Ok(Box::pin(stream))
    }
}
