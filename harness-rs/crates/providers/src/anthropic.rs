//! Anthropic Messages API 流式 provider。

use super::sse::SseParser;
use super::{
    ChatOptions, ChunkStream, ContentBlock, LlmMessage, LlmRole, LlmTool, Provider, StreamChunk,
};
use anyhow::{bail, Result};
#[cfg(test)]
use futures::stream::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
pub const API_VERSION: &str = "2023-06-01";
const DEFAULT_MAX_TOKENS: u32 = 8192;
const CODING_TEMPERATURE: f32 = 0.3;

fn thinking_budget(effort: Option<&str>) -> u32 {
    match effort.unwrap_or("medium") {
        "low" => 2048,
        "high" => 16_384,
        "max" => 32_000,
        _ => 4096,
    }
}

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
            client: crate::http::client(),
            api_key,
            model,
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.into()),
        })
    }

    fn to_wire_content(msg: &LlmMessage) -> Vec<Value> {
        msg.content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } if !text.is_empty() => {
                    Some(json!({ "type": "text", "text": text }))
                }
                ContentBlock::Text { .. } => None,
                ContentBlock::ImageUrl { url } => {
                    if let Some((media_type, data)) = url
                        .strip_prefix("data:")
                        .and_then(|value| value.split_once(";base64,"))
                    {
                        Some(json!({
                            "type": "image",
                            "source": { "type": "base64", "media_type": media_type, "data": data }
                        }))
                    } else if !url.is_empty() {
                        // The Messages API's URL image source is distinct from
                        // OpenAI's image_url content part.
                        Some(json!({
                            "type": "image",
                            "source": { "type": "url", "url": url }
                        }))
                    } else {
                        None
                    }
                }
                ContentBlock::Thinking {
                    thinking,
                    signature,
                } => Some(json!({
                    "type": "thinking",
                    "thinking": thinking,
                    "signature": signature,
                })),
                ContentBlock::RedactedThinking { data } => Some(json!({
                    "type": "redacted_thinking",
                    "data": data,
                })),
                ContentBlock::ToolUse {
                    id,
                    name,
                    input,
                    raw_input,
                    ..
                } => {
                    let input = raw_input
                        .as_ref()
                        .map(|raw| json!({ "raw_arguments": raw }))
                        .unwrap_or_else(|| input.clone());
                    Some(json!({ "type": "tool_use", "id": id, "name": name, "input": input }))
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => {
                    let content = if content.is_empty() {
                        "(empty result)"
                    } else {
                        content
                    };
                    Some(json!({
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": content,
                        "is_error": is_error,
                    }))
                }
            })
            .collect()
    }

    fn to_wire_messages(messages: &[LlmMessage]) -> Vec<Value> {
        let mut turns: Vec<(LlmRole, Vec<Value>)> = Vec::new();
        for message in messages {
            let blocks = Self::to_wire_content(message);
            if blocks.is_empty() {
                continue;
            }
            if let Some((last_role, last_blocks)) = turns.last_mut() {
                if *last_role == message.role {
                    last_blocks.extend(blocks);
                    continue;
                }
            }
            turns.push((message.role, blocks));
        }

        if turns.first().is_none_or(|(role, _)| *role != LlmRole::User) {
            turns.insert(
                0,
                (
                    LlmRole::User,
                    vec![json!({
                        "type": "text",
                        "text": "Continue the current task from the existing context. Do not repeat completed steps."
                    })],
                ),
            );
        }

        turns
            .into_iter()
            .map(|(role, content)| {
                json!({
                    "role": match role {
                        LlmRole::User => "user",
                        LlmRole::Assistant => "assistant",
                    },
                    "content": content,
                })
            })
            .collect()
    }

    fn request_body(
        &self,
        system: Option<&str>,
        messages: &[LlmMessage],
        tools: &[LlmTool],
        max_tokens: u32,
        options: &ChatOptions,
    ) -> Value {
        let thinking = options.enable_thinking.then(|| {
            let budget_tokens = thinking_budget(options.reasoning_effort.as_deref());
            json!({ "type": "enabled", "budget_tokens": budget_tokens })
        });
        let max_tokens = thinking
            .as_ref()
            .and_then(|value| value["budget_tokens"].as_u64())
            .map(|budget| (budget as u32).saturating_add(4096))
            .unwrap_or_else(|| max_tokens.max(DEFAULT_MAX_TOKENS));
        let mut body = json!({
            "model": self.model,
            "max_tokens": max_tokens,
            "stream": true,
            "messages": Self::to_wire_messages(messages),
        });
        if let Some(system) = system.filter(|value| !value.is_empty()) {
            body["system"] = json!([{
                "type": "text",
                "text": system,
                "cache_control": { "type": "ephemeral" },
            }]);
        }
        if let Some(thinking) = thinking {
            body["thinking"] = thinking;
        } else {
            let temperature = options
                .temperature
                .filter(|value| value.is_finite())
                .unwrap_or(CODING_TEMPERATURE)
                .clamp(0.0, 1.0);
            body["temperature"] = json!(temperature);
        }
        if !tools.is_empty() {
            body["tools"] = json!(tools
                .iter()
                .map(|tool| json!({
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                }))
                .collect::<Vec<_>>());
            body["tool_choice"] = json!({ "type": "auto" });
        }
        body
    }
}

enum BlockAcc {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        initial_input: Option<Value>,
        json_acc: String,
    },
    Thinking {
        thinking: String,
        signature: String,
    },
    RedactedThinking {
        data: String,
    },
}

struct StreamState {
    bytes: crate::http::ByteStream,
    parser: SseParser,
    blocks: BTreeMap<usize, BlockAcc>,
    queue: VecDeque<Result<StreamChunk>>,
    stop_reason: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_creation_tokens: u64,
    finished: bool,
}

impl StreamState {
    fn has_partial_response(&self) -> bool {
        self.blocks.values().any(|block| match block {
            BlockAcc::Text { text } => !text.is_empty(),
            BlockAcc::ToolUse {
                id,
                name,
                initial_input,
                json_acc,
            } => {
                !id.is_empty()
                    || !name.is_empty()
                    || initial_input.as_ref().is_some_and(|input| !input.is_null())
                    || !json_acc.trim().is_empty()
            }
            BlockAcc::Thinking {
                thinking,
                signature,
            } => !thinking.is_empty() || !signature.is_empty(),
            BlockAcc::RedactedThinking { data } => !data.is_empty(),
        })
    }

    fn finish(&mut self) {
        let mut content = Vec::new();
        for block in std::mem::take(&mut self.blocks).into_values() {
            let block = match block {
                BlockAcc::Text { text } => ContentBlock::Text { text },
                BlockAcc::ToolUse {
                    id,
                    name,
                    initial_input,
                    json_acc,
                } => {
                    let raw_input_text = if json_acc.trim().is_empty() {
                        initial_input
                            .as_ref()
                            .map(Value::to_string)
                            .unwrap_or_default()
                    } else {
                        json_acc.clone()
                    };
                    let parsed = if json_acc.trim().is_empty() {
                        match initial_input {
                            Some(input) if input.is_object() => Ok(input),
                            Some(Value::Null) | None => {
                                crate::tool_input::parse_tool_input("anthropic", &name, "")
                            }
                            Some(input) => crate::tool_input::parse_tool_input(
                                "anthropic",
                                &name,
                                &input.to_string(),
                            ),
                        }
                    } else {
                        crate::tool_input::parse_tool_input("anthropic", &name, &json_acc)
                    };
                    let (input, raw_input, input_error) = match parsed {
                        Ok(input) => (input, None, None),
                        Err(error) => (
                            json!({ "_raw": raw_input_text }),
                            Some(raw_input_text),
                            Some(error.to_string()),
                        ),
                    };
                    ContentBlock::ToolUse {
                        id,
                        name,
                        input,
                        raw_input,
                        input_error,
                    }
                }
                BlockAcc::Thinking {
                    thinking,
                    signature,
                } => ContentBlock::Thinking {
                    thinking,
                    signature,
                },
                BlockAcc::RedactedThinking { data } => ContentBlock::RedactedThinking { data },
            };
            content.push(block);
        }
        self.queue.push_back(Ok(StreamChunk::Completed {
            stop_reason: std::mem::take(&mut self.stop_reason),
            assistant: LlmMessage {
                role: LlmRole::Assistant,
                content,
            },
            usage: super::TokenUsage {
                input_tokens: self.input_tokens,
                output_tokens: self.output_tokens,
                cache_read_tokens: self.cache_read_tokens,
                cache_creation_tokens: self.cache_creation_tokens,
            },
        }));
        self.finished = true;
    }

    fn on_event(&mut self, ev: &super::sse::SseEvent) {
        let payload = match serde_json::from_str::<Value>(&ev.data) {
            Ok(payload) => payload,
            Err(error) => {
                self.queue.push_back(Err(anyhow::anyhow!(
                    "anthropic stream event contains invalid JSON: {error}"
                )));
                self.finished = true;
                return;
            }
        };
        match payload["type"].as_str().unwrap_or("") {
            "content_block_start" => {
                let Some(index) = payload["index"]
                    .as_u64()
                    .and_then(|index| usize::try_from(index).ok())
                else {
                    return;
                };
                let block = &payload["content_block"];
                let block = match block["type"].as_str().unwrap_or("") {
                    "tool_use" => Some(BlockAcc::ToolUse {
                        id: block["id"].as_str().unwrap_or_default().into(),
                        name: block["name"].as_str().unwrap_or_default().into(),
                        initial_input: block.get("input").cloned(),
                        json_acc: String::new(),
                    }),
                    "thinking" => Some(BlockAcc::Thinking {
                        thinking: block["thinking"].as_str().unwrap_or_default().into(),
                        signature: block["signature"].as_str().unwrap_or_default().into(),
                    }),
                    "redacted_thinking" => Some(BlockAcc::RedactedThinking {
                        data: block["data"].as_str().unwrap_or_default().into(),
                    }),
                    "text" => Some(BlockAcc::Text {
                        text: block["text"].as_str().unwrap_or_default().into(),
                    }),
                    _ => None,
                };
                if let Some(block) = block {
                    self.blocks.insert(index, block);
                }
            }
            "content_block_delta" => {
                let Some(index) = payload["index"]
                    .as_u64()
                    .and_then(|index| usize::try_from(index).ok())
                else {
                    return;
                };
                let delta = &payload["delta"];
                match delta["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        let t = delta["text"].as_str().unwrap_or_default().to_string();
                        if let Some(BlockAcc::Text { text }) = self.blocks.get_mut(&index) {
                            text.push_str(&t);
                        }
                        if !t.is_empty() {
                            self.queue.push_back(Ok(StreamChunk::TextDelta(t)));
                        }
                    }
                    "input_json_delta" => {
                        if let Some(BlockAcc::ToolUse { json_acc, .. }) =
                            self.blocks.get_mut(&index)
                        {
                            json_acc.push_str(delta["partial_json"].as_str().unwrap_or_default());
                        }
                    }
                    "thinking_delta" => {
                        let thinking = delta["thinking"].as_str().unwrap_or_default().to_string();
                        if let Some(BlockAcc::Thinking { thinking: full, .. }) =
                            self.blocks.get_mut(&index)
                        {
                            full.push_str(&thinking);
                        }
                        if !thinking.is_empty() {
                            self.queue
                                .push_back(Ok(StreamChunk::ThinkingDelta(thinking)));
                        }
                    }
                    "signature_delta" => {
                        if let Some(BlockAcc::Thinking { signature, .. }) =
                            self.blocks.get_mut(&index)
                        {
                            signature.push_str(delta["signature"].as_str().unwrap_or_default());
                        }
                    }
                    _ => {}
                }
            }
            "message_start" => {
                self.input_tokens = payload["message"]["usage"]["input_tokens"]
                    .as_u64()
                    .unwrap_or(0);
                self.cache_read_tokens = payload["message"]["usage"]["cache_read_input_tokens"]
                    .as_u64()
                    .unwrap_or(0);
                self.cache_creation_tokens = payload["message"]["usage"]
                    ["cache_creation_input_tokens"]
                    .as_u64()
                    .unwrap_or(0);
            }
            "message_delta" => {
                if let Some(reason) = payload["delta"]["stop_reason"].as_str() {
                    self.stop_reason = reason.to_string();
                }
                self.output_tokens = payload["usage"]["output_tokens"]
                    .as_u64()
                    .unwrap_or(self.output_tokens);
            }
            "message_stop" => {
                self.finish();
            }
            "error" => {
                let msg = payload["error"]["message"]
                    .as_str()
                    .unwrap_or("unknown")
                    .to_string();
                self.queue
                    .push_back(Err(anyhow::anyhow!("anthropic stream error: {msg}")));
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
        options: ChatOptions,
    ) -> Result<ChunkStream> {
        let body = self.request_body(system, &messages, &tools, max_tokens, &options);
        let url = crate::urls::anthropic_messages_url(&self.base_url, DEFAULT_BASE_URL)?;
        let resp = crate::http::send_with_retry("anthropic", || {
            self.client
                .post(url.clone())
                .header("x-api-key", &self.api_key)
                .bearer_auth(&self.api_key)
                .header("anthropic-version", API_VERSION)
                .json(&body)
        })
        .await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            bail!("anthropic api error ({status}): {text}");
        }

        let state = StreamState {
            bytes: Box::pin(resp.bytes_stream()),
            parser: SseParser::new(),
            blocks: BTreeMap::new(),
            queue: VecDeque::new(),
            stop_reason: "end_turn".into(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
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
                match crate::http::next_stream_chunk("anthropic", &mut st.bytes).await {
                    Err(error) => {
                        st.finished = true;
                        return Some((Err(error), st));
                    }
                    Ok(None) => {
                        if st.has_partial_response() {
                            st.finish();
                            continue;
                        }
                        st.finished = true;
                        return Some((
                            Err(anyhow::anyhow!(
                                "anthropic stream ended without response content"
                            )),
                            st,
                        ));
                    }
                    Ok(Some(chunk)) => match st.parser.feed(&chunk) {
                        Ok(events) => {
                            for event in events {
                                st.on_event(&event);
                                if st.finished {
                                    break;
                                }
                            }
                        }
                        Err(error) => {
                            st.finished = true;
                            return Some((
                                Err(anyhow::anyhow!(
                                    "anthropic stream is not valid UTF-8: {error}"
                                )),
                                st,
                            ));
                        }
                    },
                }
            }
        });

        Ok(Box::pin(stream))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let read = socket.read(&mut buffer).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            let Some(headers_end) = request.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..headers_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())?
                })
                .unwrap_or(0);
            if request.len() >= headers_end + 4 + content_length {
                break;
            }
        }
        request
    }

    async fn write_sse_response(socket: &mut tokio::net::TcpStream, payload: &str) {
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
            payload.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    }

    #[test]
    fn thinking_budget_controls_tokens_and_temperature() {
        let provider = AnthropicProvider::new(
            "key".into(),
            "claude-sonnet-4-5".into(),
            Some("https://api.anthropic.com/v1".into()),
        )
        .unwrap();
        let body = provider.request_body(
            Some("system"),
            &[LlmMessage::text(LlmRole::User, "hello")],
            &[],
            1024,
            &ChatOptions {
                temperature: Some(0.2),
                enable_thinking: true,
                reasoning_effort: Some("high".into()),
            },
        );
        assert_eq!(body["thinking"]["budget_tokens"], 16_384);
        assert_eq!(body["max_tokens"], 20_480);
        assert!(body.get("temperature").is_none());
        assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");

        let normal = provider.request_body(
            None,
            &[LlmMessage::text(LlmRole::User, "hello")],
            &[],
            1024,
            &ChatOptions::default(),
        );
        assert_eq!(normal["max_tokens"], DEFAULT_MAX_TOKENS);
        assert_eq!(normal["temperature"], json!(CODING_TEMPERATURE));
        assert!(normal.get("thinking").is_none());
    }

    #[test]
    fn request_messages_merge_roles_and_always_start_with_user() {
        let provider = AnthropicProvider::new(
            "key".into(),
            "claude-sonnet-4-5".into(),
            Some("https://api.anthropic.com/v1".into()),
        )
        .unwrap();
        let body = provider.request_body(
            None,
            &[
                LlmMessage::text(LlmRole::Assistant, "restored answer"),
                LlmMessage::text(LlmRole::Assistant, "continued answer"),
                LlmMessage::text(LlmRole::User, "new question"),
                LlmMessage::text(LlmRole::User, "more context"),
            ],
            &[],
            8192,
            &ChatOptions::default(),
        );

        assert_eq!(body["messages"].as_array().unwrap().len(), 3);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][1]["role"], "assistant");
        assert_eq!(body["messages"][1]["content"].as_array().unwrap().len(), 2);
        assert_eq!(body["messages"][2]["role"], "user");
        assert_eq!(body["messages"][2]["content"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn request_messages_normalize_repairable_tool_calls_and_empty_results() {
        let wire = AnthropicProvider::to_wire_messages(&[
            LlmMessage {
                role: LlmRole::Assistant,
                content: vec![ContentBlock::ToolUse {
                    id: "toolu_1".into(),
                    name: "write_file".into(),
                    input: json!({ "_raw": "{broken" }),
                    raw_input: Some("{broken".into()),
                    input_error: Some("invalid JSON".into()),
                }],
            },
            LlmMessage {
                role: LlmRole::User,
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "toolu_1".into(),
                    content: String::new(),
                    is_error: true,
                }],
            },
        ]);

        assert_eq!(
            wire[1]["content"][0]["input"],
            json!({ "raw_arguments": "{broken" })
        );
        assert_eq!(wire[2]["content"][0]["content"], "(empty result)");
        assert_eq!(wire[2]["content"][0]["is_error"], true);
    }

    #[test]
    fn image_urls_use_anthropic_base64_and_remote_url_sources() {
        let blocks = AnthropicProvider::to_wire_content(&LlmMessage {
            role: LlmRole::User,
            content: vec![
                ContentBlock::ImageUrl {
                    url: "data:image/png;base64,aGVsbG8=".into(),
                },
                ContentBlock::ImageUrl {
                    url: "https://cdn.example.test/reference.webp".into(),
                },
            ],
        });

        assert_eq!(
            blocks[0],
            json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": "aGVsbG8=",
                },
            })
        );
        assert_eq!(
            blocks[1],
            json!({
                "type": "image",
                "source": {
                    "type": "url",
                    "url": "https://cdn.example.test/reference.webp",
                },
            })
        );
    }

    #[tokio::test]
    async fn malformed_streamed_tool_input_becomes_a_repairable_tool_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            write_sse_response(
                &mut socket,
                concat!(
                    "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"write_file\",\"input\":{}}}\n\n",
                    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{broken\"}}\n\n",
                    "data: {\"type\":\"message_stop\"}\n\n"
                ),
            )
            .await;
        });

        let provider = AnthropicProvider::new(
            "test-key".into(),
            "claude-sonnet-4-5".into(),
            Some(format!("http://{address}/v1/messages")),
        )
        .unwrap();
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "write")],
                vec![],
                8192,
                ChatOptions::default(),
            )
            .await
            .unwrap();

        let completed = stream.next().await.unwrap().unwrap();
        let StreamChunk::Completed { assistant, .. } = completed else {
            panic!("expected completed tool call");
        };
        let ContentBlock::ToolUse {
            input,
            raw_input,
            input_error,
            ..
        } = &assistant.content[0]
        else {
            panic!("expected malformed tool call metadata");
        };
        assert_eq!(input, &json!({ "_raw": "{broken" }));
        assert_eq!(raw_input.as_deref(), Some("{broken"));
        assert!(input_error
            .as_deref()
            .unwrap()
            .contains("invalid JSON arguments for tool `write_file`"));
        assert!(stream.next().await.is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn eof_without_message_stop_completes_accumulated_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            write_sse_response(
                &mut socket,
                concat!(
                    "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3}}}\n\n",
                    "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"working\"}}\n\n",
                    "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"read_file\",\"input\":{}}}\n\n",
                    "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\"}}\n\n",
                    "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"README.md\\\"}\"}}\n\n",
                    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":7}}\n\n"
                ),
            )
            .await;
        });

        let provider = AnthropicProvider::new(
            "test-key".into(),
            "claude-sonnet-4-5".into(),
            Some(format!("http://{address}/v1/messages")),
        )
        .unwrap();
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "continue")],
                vec![],
                8192,
                ChatOptions::default(),
            )
            .await
            .unwrap();

        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            StreamChunk::TextDelta(ref text) if text == "working"
        ));
        let completed = stream.next().await.unwrap().unwrap();
        let StreamChunk::Completed {
            stop_reason,
            assistant,
            usage,
        } = completed
        else {
            panic!("expected completion assembled at EOF");
        };
        assert_eq!(stop_reason, "tool_use");
        assert_eq!(usage.input_tokens, 3);
        assert_eq!(usage.output_tokens, 7);
        assert!(matches!(
            &assistant.content[0],
            ContentBlock::Text { text } if text == "working"
        ));
        assert!(matches!(
            &assistant.content[1],
            ContentBlock::ToolUse {
                id,
                name,
                input,
                raw_input: None,
                input_error: None,
            } if id == "toolu_1"
                && name == "read_file"
                && input == &json!({ "path": "README.md" })
        ));
        assert!(stream.next().await.is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn empty_successful_stream_returns_an_explicit_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            write_sse_response(&mut socket, "").await;
        });

        let provider = AnthropicProvider::new(
            "test-key".into(),
            "claude-sonnet-4-5".into(),
            Some(format!("http://{address}/v1/messages")),
        )
        .unwrap();
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "continue")],
                vec![],
                8192,
                ChatOptions::default(),
            )
            .await
            .unwrap();

        let error = stream.next().await.unwrap().unwrap_err();
        assert_eq!(
            error.to_string(),
            "anthropic stream ended without response content"
        );
        assert!(stream.next().await.is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn usage_only_truncated_stream_returns_an_explicit_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            write_sse_response(
                &mut socket,
                "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3}}}\n\n",
            )
            .await;
        });

        let provider = AnthropicProvider::new(
            "test-key".into(),
            "claude-sonnet-4-5".into(),
            Some(format!("http://{address}/v1/messages")),
        )
        .unwrap();
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "continue")],
                vec![],
                8192,
                ChatOptions::default(),
            )
            .await
            .unwrap();

        let error = stream.next().await.unwrap().unwrap_err();
        assert_eq!(
            error.to_string(),
            "anthropic stream ended without response content"
        );
        assert!(stream.next().await.is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn full_endpoint_dual_auth_and_thinking_stream_work_end_to_end() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            let request = String::from_utf8_lossy(&request);
            assert!(request.starts_with("POST /v1/messages HTTP/1.1"));
            let lower = request.to_ascii_lowercase();
            assert!(lower.contains("x-api-key: test-key"));
            assert!(lower.contains("authorization: bearer test-key"));
            assert!(lower.contains("anthropic-version: 2023-06-01"));
            let body: Value =
                serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(body["thinking"]["budget_tokens"], 2048);
            assert_eq!(body["max_tokens"], 6144);
            assert!(body.get("temperature").is_none());

            let payload = concat!(
                "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":2}}}\n\n",
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\"}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"consider\"}}\n\n",
                "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\"}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"done\"}}\n\n",
                "data: {\"type\":\"message_stop\"}\n\n"
            );
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                payload.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        let provider = AnthropicProvider::new(
            "test-key".into(),
            "claude-sonnet-4-5".into(),
            Some(format!("http://{address}/v1/messages")),
        )
        .unwrap();
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "hello")],
                vec![],
                1024,
                ChatOptions {
                    temperature: Some(0.9),
                    enable_thinking: true,
                    reasoning_effort: Some("low".into()),
                },
            )
            .await
            .unwrap();
        let mut thinking = String::new();
        let mut answer = String::new();
        while let Some(chunk) = stream.next().await {
            match chunk.unwrap() {
                StreamChunk::ThinkingDelta(delta) => thinking.push_str(&delta),
                StreamChunk::TextDelta(delta) => answer.push_str(&delta),
                StreamChunk::Completed { .. } => {}
            }
        }
        server.await.unwrap();
        assert_eq!(thinking, "consider");
        assert_eq!(answer, "done");
    }

    #[tokio::test]
    async fn signed_thinking_is_replayed_unchanged_with_tool_results() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut first_socket, _) = listener.accept().await.unwrap();
            let first_request = read_http_request(&mut first_socket).await;
            let first_request = String::from_utf8_lossy(&first_request);
            let first_body: Value =
                serde_json::from_str(first_request.split_once("\r\n\r\n").unwrap().1).unwrap();
            assert_eq!(
                first_body["messages"][0]["content"][0]["text"],
                "find weather"
            );

            let first_payload = concat!(
                "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":2}}}\n\n",
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Use lookup\"}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig-\"}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"value\"}}\n\n",
                "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"redacted_thinking\",\"data\":\"opaque-data\"}}\n\n",
                "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
                "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"lookup\",\"input\":{}}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"city\\\":\\\"Shanghai\\\"}\"}}\n\n",
                "data: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":12}}\n\n",
                "data: {\"type\":\"message_stop\"}\n\n"
            );
            write_sse_response(&mut first_socket, first_payload).await;

            let (mut second_socket, _) = listener.accept().await.unwrap();
            let second_request = read_http_request(&mut second_socket).await;
            let second_request = String::from_utf8_lossy(&second_request);
            let second_body: Value =
                serde_json::from_str(second_request.split_once("\r\n\r\n").unwrap().1).unwrap();
            let assistant_blocks = second_body["messages"][1]["content"].as_array().unwrap();
            assert_eq!(
                assistant_blocks[0],
                json!({
                    "type": "thinking",
                    "thinking": "Use lookup",
                    "signature": "sig-value",
                })
            );
            assert_eq!(
                assistant_blocks[1],
                json!({ "type": "redacted_thinking", "data": "opaque-data" })
            );
            assert_eq!(
                assistant_blocks[2],
                json!({
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "lookup",
                    "input": { "city": "Shanghai" },
                })
            );
            assert_eq!(
                second_body["messages"][2]["content"][0],
                json!({
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "sunny",
                    "is_error": false,
                })
            );

            let second_payload = concat!(
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"sunny\"}}\n\n",
                "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n",
                "data: {\"type\":\"message_stop\"}\n\n"
            );
            write_sse_response(&mut second_socket, second_payload).await;
        });

        let provider = AnthropicProvider::new(
            "test-key".into(),
            "claude-sonnet-4-5".into(),
            Some(format!("http://{address}/v1/messages")),
        )
        .unwrap();
        let tools = vec![LlmTool {
            name: "lookup".into(),
            description: "Lookup weather".into(),
            input_schema: json!({
                "type": "object",
                "properties": { "city": { "type": "string" } },
                "required": ["city"],
            }),
        }];
        let options = ChatOptions {
            enable_thinking: true,
            reasoning_effort: Some("low".into()),
            ..ChatOptions::default()
        };
        let mut messages = vec![LlmMessage::text(LlmRole::User, "find weather")];
        let mut first_stream = provider
            .chat_stream(None, messages.clone(), tools.clone(), 8192, options.clone())
            .await
            .unwrap();
        let mut assistant = None;
        while let Some(chunk) = first_stream.next().await {
            if let StreamChunk::Completed {
                assistant: message, ..
            } = chunk.unwrap()
            {
                assistant = Some(message);
            }
        }

        let assistant = assistant.expect("first response must complete");
        assert!(matches!(
            &assistant.content[0],
            ContentBlock::Thinking {
                thinking,
                signature,
            } if thinking == "Use lookup" && signature == "sig-value"
        ));
        assert!(matches!(
            &assistant.content[1],
            ContentBlock::RedactedThinking { data } if data == "opaque-data"
        ));
        messages.push(assistant);
        messages.push(LlmMessage {
            role: LlmRole::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "toolu_1".into(),
                content: "sunny".into(),
                is_error: false,
            }],
        });

        let mut second_stream = provider
            .chat_stream(None, messages, tools, 8192, options)
            .await
            .unwrap();
        while let Some(chunk) = second_stream.next().await {
            chunk.unwrap();
        }
        server.await.unwrap();
    }
}
