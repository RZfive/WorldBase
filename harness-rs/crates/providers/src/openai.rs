//! OpenAI Chat Completions 流式 provider（含 tool_calls，支持 OpenAI 兼容端点）。

use super::sse::SseParser;
use super::{
    ChatOptions, ChunkStream, ContentBlock, LlmMessage, LlmRole, LlmTool, Provider, StreamChunk,
};
use anyhow::{bail, Context, Result};
use futures::stream::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::pin::Pin;

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

pub struct OpenAIProvider {
    client: Client,
    api_key: String,
    model: String,
    base_url: String,
}

impl OpenAIProvider {
    pub fn new(api_key: String, model: String, base_url: Option<String>) -> Self {
        Self {
            client: Client::new(),
            api_key,
            model,
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.into()),
        }
    }

    /// OpenAI 消息格式：tool_use → assistant.tool_calls；tool_result → role=tool。
    fn to_wire_messages(messages: &[LlmMessage]) -> Vec<Value> {
        let mut out = Vec::new();
        for m in messages {
            match m.role {
                LlmRole::User => {
                    let mut tool_results = Vec::new();
                    let mut text_parts = Vec::new();
                    for b in &m.content {
                        match b {
                            ContentBlock::Text { text } => text_parts.push(text.clone()),
                            ContentBlock::ImageUrl { url } => text_parts.push(String::new()),
                            ContentBlock::ToolResult { .. } => tool_results.push(b),
                            ContentBlock::ToolUse { .. } => {}
                        }
                    }
                    for tr in tool_results {
                        if let ContentBlock::ToolResult {
                            tool_use_id,
                            content,
                            ..
                        } = tr
                        {
                            out.push(json!({ "role": "tool", "tool_call_id": tool_use_id, "content": content }));
                        }
                    }
                    let multimodal: Vec<Value> = m
                        .content
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::Text { text } if !text.is_empty() => {
                                Some(json!({ "type": "text", "text": text }))
                            }
                            ContentBlock::ImageUrl { url } if !url.is_empty() => {
                                Some(json!({ "type": "image_url", "image_url": { "url": url } }))
                            }
                            _ => None,
                        })
                        .collect();
                    if !multimodal.is_empty() {
                        let content = if multimodal.iter().any(|part| part["type"] == "image_url") {
                            Value::Array(multimodal)
                        } else {
                            json!(text_parts.join("\n"))
                        };
                        out.push(json!({ "role": "user", "content": content }));
                    }
                }
                LlmRole::Assistant => {
                    let tool_calls: Vec<Value> = m
                        .content
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::ToolUse { id, name, input } => Some(json!({
                                "id": id,
                                "type": "function",
                                "function": { "name": name, "arguments": input.to_string() },
                            })),
                            _ => None,
                        })
                        .collect();
                    let text = m.text_view();
                    let mut msg = json!({ "role": "assistant" });
                    if !text.is_empty() {
                        msg["content"] = json!(text);
                    }
                    if !tool_calls.is_empty() {
                        msg["tool_calls"] = Value::Array(tool_calls);
                    }
                    out.push(msg);
                }
            }
        }
        out
    }
}

#[async_trait::async_trait]
impl Provider for OpenAIProvider {
    fn name(&self) -> &str {
        "openai"
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
        options: ChatOptions,
    ) -> Result<ChunkStream> {
        let mut wire = Self::to_wire_messages(&messages);
        if let Some(sys) = system {
            wire.insert(0, json!({ "role": "system", "content": sys }));
        }

        let mut body = json!({
            "model": self.model,
            "messages": wire,
            "stream": true,
            "stream_options": { "include_usage": true },
        });
        // 部分兼容端点不识别 max_tokens → max_completion_tokens 变更，这里用旧字段并容忍失败。
        body["max_tokens"] = json!(max_tokens);
        if let Some(temperature) = options.temperature.filter(|value| value.is_finite()) {
            body["temperature"] = json!(temperature.clamp(0.0, 2.0));
        }
        if let Some(reasoning_effort) = options.reasoning_effort {
            let normalized = match reasoning_effort.as_str() {
                "low" | "medium" | "high" | "minimal" => reasoning_effort,
                "max" => "high".to_string(),
                _ => String::new(),
            };
            if !normalized.is_empty() {
                body["reasoning_effort"] = json!(normalized);
            }
        }
        if !tools.is_empty() {
            body["tools"] = json!(tools
                .iter()
                .map(|t| json!({
                    "type": "function",
                    "function": { "name": t.name, "description": t.description, "parameters": t.input_schema },
                }))
                .collect::<Vec<_>>());
        }

        let resp = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .context("openai request failed")?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            bail!("openai api error ({status}): {text}");
        }

        // 累积状态：content 文本 + 按 index 的 tool_calls 参数分片。
        struct StreamState {
            bytes: Pin<Box<dyn futures::Stream<Item = reqwest::Result<bytes::Bytes>> + Send>>,
            parser: SseParser,
            text: String,
            tool_calls: BTreeMap<usize, (String, String, String)>, // index → (id, name, args_acc)
            input_tokens: u64,
            output_tokens: u64,
            cache_read_tokens: u64,
            finished: bool,
            queue: std::collections::VecDeque<Result<StreamChunk>>,
        }

        impl StreamState {
            fn finish(&mut self) {
                let content = std::mem::take(&mut self.text);
                let tool_blocks: Vec<ContentBlock> = std::mem::take(&mut self.tool_calls)
                    .into_values()
                    .map(|(id, name, args)| ContentBlock::ToolUse {
                        id,
                        name,
                        input: if args.trim().is_empty() {
                            json!({})
                        } else {
                            serde_json::from_str(&args).unwrap_or(json!({}))
                        },
                    })
                    .collect();
                let mut blocks = Vec::new();
                if !content.is_empty() {
                    blocks.push(ContentBlock::Text { text: content });
                }
                blocks.extend(tool_blocks);
                self.queue.push_back(Ok(StreamChunk::Completed {
                    stop_reason: "stop".into(),
                    assistant: LlmMessage {
                        role: LlmRole::Assistant,
                        content: blocks,
                    },
                    usage: super::TokenUsage {
                        input_tokens: self.input_tokens,
                        output_tokens: self.output_tokens,
                        cache_read_tokens: self.cache_read_tokens,
                        cache_creation_tokens: 0,
                    },
                }));
                self.finished = true;
            }

            fn on_event(&mut self, ev: &super::sse::SseEvent) {
                if ev.data == "[DONE]" {
                    self.finish();
                    return;
                }
                let Ok(payload) = serde_json::from_str::<Value>(&ev.data) else {
                    return;
                };
                if let Some(u) = payload.get("usage") {
                    self.input_tokens = u["prompt_tokens"].as_u64().unwrap_or(self.input_tokens);
                    self.output_tokens = u["completion_tokens"]
                        .as_u64()
                        .unwrap_or(self.output_tokens);
                    self.cache_read_tokens = u["prompt_tokens_details"]["cached_tokens"]
                        .as_u64()
                        .unwrap_or(self.cache_read_tokens);
                }
                let delta = &payload["choices"][0]["delta"];
                if let Some(t) = delta["content"].as_str() {
                    if !t.is_empty() {
                        self.text.push_str(t);
                        self.queue
                            .push_back(Ok(StreamChunk::TextDelta(t.to_string())));
                    }
                }
                if let Some(tcs) = delta["tool_calls"].as_array() {
                    for tc in tcs {
                        let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                        let entry = self.tool_calls.entry(idx).or_default();
                        if let Some(id) = tc["id"].as_str() {
                            entry.0 = id.to_string();
                        }
                        if let Some(name) = tc["function"]["name"].as_str() {
                            entry.1 = name.to_string();
                        }
                        if let Some(args) = tc["function"]["arguments"].as_str() {
                            entry.2.push_str(args);
                        }
                    }
                }
            }
        }

        let state = StreamState {
            bytes: Box::pin(resp.bytes_stream()),
            parser: SseParser::new(),
            text: String::new(),
            tool_calls: BTreeMap::new(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            finished: false,
            queue: std::collections::VecDeque::new(),
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
                    None => {
                        if !st.finished && (!st.text.is_empty() || !st.tool_calls.is_empty()) {
                            st.finish();
                            continue;
                        }
                        return None;
                    }
                    Some(Err(e)) => {
                        return Some((Err(anyhow::anyhow!("stream read error: {e}")), st))
                    }
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
