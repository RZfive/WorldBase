//! OpenAI Responses API 流式 provider（/responses，官方原生协议）。
//!
//! 与 chat/completions 的关键差异：
//! - system 走 `instructions`，历史走 `input` items（easy message 或
//!   `function_call` / `function_call_output` 类型化条目）
//! - tools 为扁平结构（`{type, name, description, parameters}`）
//! - SSE 事件驱动：`response.output_text.delta`、
//!   `response.function_call_arguments.delta`、`response.completed` 等

use super::sse::SseParser;
use super::{
    ChatOptions, ChunkStream, ContentBlock, LlmMessage, LlmRole, LlmTool, Provider, StreamChunk,
    TokenUsage,
};
use anyhow::{bail, Result};
#[cfg(test)]
use futures::stream::StreamExt;
use reqwest::{Client, Response, StatusCode};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Mutex;

pub struct OpenAIResponsesProvider {
    client: Client,
    api_key: String,
    model: String,
    base_url: String,
    rejected_optional_parameters: Mutex<HashSet<&'static str>>,
}

/// Responses `input` items：普通轮次用 easy message（user 消息支持
/// input_text/input_image 多模态 parts），工具轮次用类型化条目。迭代顺序
/// 天然保证 `function_call_output` 紧随其 `function_call`。
fn to_wire_input(messages: &[LlmMessage]) -> Vec<Value> {
    let mut input = Vec::new();
    for message in messages {
        match message.role {
            LlmRole::User => {
                for block in &message.content {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        ..
                    } = block
                    {
                        input.push(json!({
                            "type": "function_call_output",
                            "call_id": tool_use_id,
                            "output": if content.is_empty() { "(empty result)" } else { content },
                        }));
                    }
                }
                let parts: Vec<Value> = message
                    .content
                    .iter()
                    .filter_map(|block| match block {
                        ContentBlock::Text { text } if !text.is_empty() => {
                            Some(json!({ "type": "input_text", "text": text }))
                        }
                        ContentBlock::ImageUrl { url } if !url.is_empty() => {
                            Some(json!({ "type": "input_image", "image_url": url }))
                        }
                        _ => None,
                    })
                    .collect();
                if !parts.is_empty() {
                    input.push(json!({ "role": "user", "content": parts }));
                }
            }
            LlmRole::Assistant => {
                let text = message.text_view();
                if !text.is_empty() {
                    input.push(json!({ "role": "assistant", "content": text }));
                }
                for block in &message.content {
                    if let ContentBlock::ToolUse {
                        id,
                        name,
                        input: tool_input,
                        raw_input,
                        ..
                    } = block
                    {
                        let arguments = raw_input.clone().unwrap_or_else(|| tool_input.to_string());
                        input.push(json!({
                            "type": "function_call",
                            "call_id": id,
                            "name": name,
                            "arguments": arguments,
                        }));
                    }
                }
            }
        }
    }
    if !input.iter().any(|item| item["role"] == "user") {
        input.push(json!({
            "role": "user",
            "content": "Continue the current task from the existing context. Do not repeat completed steps.",
        }));
    }
    input
}

// A successful minimal protocol probe does not establish support for every
// optional Responses field. Keep required input, tools and streaming intact;
// only remove one optional field at a time on a matching 400/422 error.
const OPTIONAL_COMPATIBILITY_PARAMETERS: [&str; 3] = ["temperature", "reasoning", "tool_choice"];

fn remove_rejected_optional_parameter(body: &mut Value, text: &str) -> Option<&'static str> {
    let lower = text.to_ascii_lowercase();
    for key in OPTIONAL_COMPATIBILITY_PARAMETERS {
        if body.get(key).is_some() && lower.contains(key) {
            body.as_object_mut()?.remove(key);
            return Some(key);
        }
    }
    None
}

fn is_generic_invalid_parameter_error(text: &str) -> bool {
    let Ok(response) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    let error = response.get("error").unwrap_or(&response);
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let parameter = error
        .get("param")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    code.eq_ignore_ascii_case("InvalidParameter")
        && parameter.is_empty()
        && message.contains("a parameter specified in the request is not valid")
}

fn remove_ambiguous_optional_parameter(body: &mut Value) -> Option<&'static str> {
    for key in OPTIONAL_COMPATIBILITY_PARAMETERS {
        if body.get(key).is_some() {
            body.as_object_mut()?.remove(key);
            return Some(key);
        }
    }
    None
}

fn suggests_unsupported_responses_endpoint(status: StatusCode, text: &str) -> bool {
    if status == StatusCode::NOT_FOUND {
        return true;
    }
    let lower = text.to_ascii_lowercase();
    lower.contains("not found") && lower.contains("responses")
}

impl OpenAIResponsesProvider {
    pub fn new(api_key: String, model: String, base_url: Option<String>) -> Self {
        Self {
            client: crate::http::client(),
            api_key,
            model,
            base_url: base_url.unwrap_or_else(|| crate::openai::DEFAULT_BASE_URL.into()),
            rejected_optional_parameters: Mutex::new(HashSet::new()),
        }
    }

    fn request_body(
        &self,
        system: Option<&str>,
        messages: &[LlmMessage],
        tools: &[LlmTool],
        options: &ChatOptions,
    ) -> Value {
        let mut body = json!({
            "model": self.model,
            "input": to_wire_input(messages),
            "stream": true,
        });
        if let Some(system) = system.filter(|text| !text.is_empty()) {
            body["instructions"] = json!(system);
        }
        if !crate::openai::model_rejects_custom_temperature(&self.base_url, &self.model) {
            let temperature = options
                .temperature
                .filter(|value| value.is_finite())
                .unwrap_or(crate::openai::CODING_TEMPERATURE)
                .clamp(0.0, 2.0);
            body["temperature"] = json!(temperature);
        }
        if let Some(effort) =
            crate::openai::resolve_reasoning_effort(&self.base_url, &self.model, options)
        {
            body["reasoning"] = json!({ "effort": effort });
        }
        if !tools.is_empty() {
            body["tools"] = json!(tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    })
                })
                .collect::<Vec<_>>());
            body["tool_choice"] = json!("auto");
        }
        body
    }

    async fn send_request(
        &self,
        url: reqwest::Url,
        mut body: Value,
        session_id: Option<&str>,
    ) -> Result<Response> {
        let headers = crate::http::session_headers(&url, session_id)?;
        let rejected = self.rejected_optional_parameters.lock().unwrap().clone();
        if let Some(object) = body.as_object_mut() {
            for key in rejected {
                object.remove(key);
            }
        }
        let mut removed = Vec::new();
        loop {
            let response = crate::http::send_with_retry("openai responses", || {
                self.client
                    .post(url.clone())
                    .bearer_auth(&self.api_key)
                    .headers(headers.clone())
                    .json(&body)
            })
            .await?;
            let status = response.status();
            if status.is_success() {
                // Cache only a *successful* downgrade. A vague 400 caused by
                // invalid tools must not disable reasoning in future requests.
                self.rejected_optional_parameters
                    .lock()
                    .unwrap()
                    .extend(removed);
                return Ok(response);
            }
            let text = response.text().await.unwrap_or_default();
            if matches!(
                status,
                StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY
            ) {
                let key = remove_rejected_optional_parameter(&mut body, &text).or_else(|| {
                    is_generic_invalid_parameter_error(&text)
                        .then(|| remove_ambiguous_optional_parameter(&mut body))
                        .flatten()
                });
                if let Some(key) = key {
                    removed.push(key);
                    continue;
                }
            }
            // An endpoint without Responses support must never silently switch
            // protocols; the user can choose Chat Completions explicitly.
            if suggests_unsupported_responses_endpoint(status, &text) {
                bail!(
                    "openai responses api error ({status}): {text}\n\
                     this endpoint does not support the Responses protocol; \
                     switch the provider protocol to OpenAI Chat Completions in settings"
                );
            }
            bail!("openai responses api error ({status}): {text}");
        }
    }
}

#[derive(Default)]
struct CallAcc {
    call_id: String,
    name: String,
    args: String,
    /// Set once a terminal event supplied a complete, valid argument payload.
    /// Late deltas from a misbehaving endpoint must not be appended to it.
    args_complete: bool,
}

/// Some compatible endpoints send `arguments` as a JSON object instead of a
/// string. Accept both shapes rather than silently dropping the payload.
fn function_arguments_string(value: &Value) -> Option<String> {
    match value {
        Value::String(args) => Some(args.clone()),
        Value::Object(_) | Value::Array(_) => Some(value.to_string()),
        _ => None,
    }
}

fn arguments_parse_as_object(tool_name: &str, args: &str) -> bool {
    let args = args.trim();
    !args.is_empty()
        && crate::tool_input::parse_tool_input("openai-responses", tool_name, args).is_ok()
}

/// Terminal events (`function_call_arguments.done`, `output_item.done`,
/// `response.completed`) carry the authoritative argument string. Providers
/// vary in which of them they emit; a partial `delta` must never win over a
/// complete payload, otherwise tool calls such as `finish_task` arrive with
/// empty arguments and their result is silently lost.
fn apply_complete_arguments(entry: &mut CallAcc, complete: &str) {
    let complete = complete.trim();
    if complete.is_empty() {
        return;
    }
    let accumulated_is_valid = arguments_parse_as_object(&entry.name, &entry.args);
    let complete_is_valid = arguments_parse_as_object(&entry.name, complete);
    if entry.args.trim().is_empty()
        || (complete_is_valid && (!accumulated_is_valid || entry.args.trim() != complete))
        || (!accumulated_is_valid && !complete_is_valid && entry.args.len() < complete.len())
    {
        entry.args = complete.to_string();
        entry.args_complete = complete_is_valid;
    }
}

/// Resolve an accumulator even when a compatible endpoint omits `item_id`
/// from a terminal event.
fn tool_call_entry<'a>(
    calls: &'a mut BTreeMap<String, CallAcc>,
    item_id: &str,
    call_id: Option<&str>,
) -> &'a mut CallAcc {
    let item_id = item_id.trim();
    // Prefer an existing accumulator with the same call_id even when the
    // terminal event uses a different item id. Creating a second entry would
    // execute the same tool call twice.
    if let Some(call_id) = call_id.map(str::trim).filter(|value| !value.is_empty()) {
        if item_id.is_empty() || !calls.contains_key(item_id) {
            if let Some(key) = calls
                .iter()
                .find(|(_, acc)| acc.call_id == call_id)
                .map(|(key, _)| key.clone())
            {
                return calls.get_mut(&key).expect("accumulator exists");
            }
        }
    }
    if !item_id.is_empty() {
        return calls.entry(item_id.to_string()).or_default();
    }
    if calls.len() == 1 {
        return calls.values_mut().next().expect("single accumulator");
    }
    calls.entry(String::new()).or_default()
}

#[async_trait::async_trait]
impl Provider for OpenAIResponsesProvider {
    fn name(&self) -> &str {
        "openai-responses"
    }

    fn model(&self) -> &str {
        &self.model
    }

    async fn chat_stream(
        &self,
        system: Option<&str>,
        messages: Vec<LlmMessage>,
        tools: Vec<LlmTool>,
        _max_tokens: u32,
        options: ChatOptions,
    ) -> Result<ChunkStream> {
        let body = self.request_body(system, &messages, &tools, &options);
        let url = crate::urls::responses_url(&self.base_url)?;
        let resp = self
            .send_request(url, body, options.session_id.as_deref())
            .await?;

        // 累积状态：output_text 增量 + 按 item_id 的 function_call 参数分片。
        struct StreamState {
            bytes: crate::http::ByteStream,
            parser: SseParser,
            text: String,
            tool_calls: BTreeMap<String, CallAcc>, // item_id → acc
            input_tokens: u64,
            output_tokens: u64,
            cache_read_tokens: u64,
            stop_reason: String,
            finished: bool,
            queue: VecDeque<Result<StreamChunk>>,
        }

        impl StreamState {
            fn finish(&mut self) {
                let content = std::mem::take(&mut self.text);
                let mut tool_blocks = Vec::new();
                for (index, acc) in std::mem::take(&mut self.tool_calls)
                    .into_values()
                    .enumerate()
                {
                    // Streaming function calls always carry call_id, but a
                    // non-streaming-shaped replay without one still needs a
                    // stable id for the matching function_call_output.
                    let id = if acc.call_id.trim().is_empty() {
                        format!("call_{}_{}", index, uuid::Uuid::new_v4().simple())
                    } else {
                        acc.call_id
                    };
                    let (input, raw_input, input_error) = match crate::tool_input::parse_tool_input(
                        "openai-responses",
                        &acc.name,
                        &acc.args,
                    ) {
                        Ok(input) => (input, None, None),
                        Err(error) => (
                            json!({ "_raw": acc.args }),
                            Some(acc.args),
                            Some(error.to_string()),
                        ),
                    };
                    tool_blocks.push(ContentBlock::ToolUse {
                        id,
                        name: acc.name,
                        input,
                        raw_input,
                        input_error,
                    });
                }
                let mut blocks = Vec::new();
                if !content.is_empty() {
                    blocks.push(ContentBlock::Text { text: content });
                }
                blocks.extend(tool_blocks);
                self.queue.push_back(Ok(StreamChunk::Completed {
                    stop_reason: if self.stop_reason.is_empty() {
                        "stop".into()
                    } else {
                        std::mem::take(&mut self.stop_reason)
                    },
                    assistant: LlmMessage {
                        role: LlmRole::Assistant,
                        content: blocks,
                    },
                    usage: TokenUsage {
                        input_tokens: self.input_tokens,
                        output_tokens: self.output_tokens,
                        cache_read_tokens: self.cache_read_tokens,
                        cache_creation_tokens: 0,
                    },
                }));
                self.finished = true;
            }

            fn fail(&mut self, error: String) {
                self.queue.push_back(Err(anyhow::anyhow!("{error}")));
                self.finished = true;
            }

            /// Some compatible endpoints only provide the final text/tool
            /// payload inside `response.completed.output` and never emit the
            /// incremental events. Recover it so a completed turn can never
            /// become empty (notably a `finish_task` call whose summary would
            /// otherwise disappear and end the run silently).
            fn apply_completed_output(&mut self, response: &Value) {
                let Some(output) = response["output"].as_array() else {
                    return;
                };
                let mut completed_text = String::new();
                for item in output {
                    if item["type"] != "message" {
                        continue;
                    }
                    let Some(parts) = item["content"].as_array() else {
                        continue;
                    };
                    for part in parts {
                        let kind = part["type"].as_str().unwrap_or_default();
                        if kind != "output_text" && kind != "text" {
                            continue;
                        }
                        if let Some(text) = part["text"].as_str() {
                            completed_text.push_str(text);
                        }
                    }
                }
                if !completed_text.is_empty()
                    && (self.text.is_empty()
                        || (completed_text.starts_with(&self.text)
                            && completed_text.len() > self.text.len()))
                {
                    self.text = completed_text;
                }
                for item in output {
                    if item["type"] != "function_call" {
                        continue;
                    }
                    let call_id = item["call_id"].as_str().unwrap_or_default();
                    let entry = tool_call_entry(
                        &mut self.tool_calls,
                        item["id"].as_str().unwrap_or_default(),
                        Some(call_id),
                    );
                    if entry.call_id.is_empty() && !call_id.is_empty() {
                        entry.call_id = call_id.to_string();
                    }
                    if entry.name.is_empty() {
                        entry
                            .name
                            .push_str(item["name"].as_str().unwrap_or_default());
                    }
                    if let Some(args) = function_arguments_string(&item["arguments"]) {
                        apply_complete_arguments(entry, &args);
                    }
                }
            }

            fn on_event(&mut self, ev: &super::sse::SseEvent) {
                let event = ev.event.as_deref().unwrap_or_default();
                // 部分兼容实现不带 event: 行，用 data.type 兜底。
                let payload = match serde_json::from_str::<Value>(&ev.data) {
                    Ok(payload) => payload,
                    Err(error) => {
                        self.fail(format!(
                            "openai responses stream event contains invalid JSON: {error}"
                        ));
                        return;
                    }
                };
                let event = payload["type"].as_str().unwrap_or(event);
                match event {
                    "response.output_text.delta" => {
                        if let Some(delta) = payload["delta"].as_str().filter(|d| !d.is_empty()) {
                            self.text.push_str(delta);
                            self.queue
                                .push_back(Ok(StreamChunk::TextDelta(delta.to_string())));
                        }
                    }
                    "response.reasoning_text.delta" | "response.reasoning_summary_text.delta" => {
                        if let Some(delta) = payload["delta"].as_str().filter(|d| !d.is_empty()) {
                            self.queue
                                .push_back(Ok(StreamChunk::ThinkingDelta(delta.to_string())));
                        }
                    }
                    "response.output_item.added" => {
                        let item = &payload["item"];
                        if item["type"] == "function_call" {
                            let call_id = item["call_id"].as_str().unwrap_or_default();
                            let entry = tool_call_entry(
                                &mut self.tool_calls,
                                item["id"].as_str().unwrap_or_default(),
                                Some(call_id),
                            );
                            if entry.call_id.is_empty() && !call_id.is_empty() {
                                entry.call_id = call_id.to_string();
                            }
                            if entry.name.is_empty() {
                                entry
                                    .name
                                    .push_str(item["name"].as_str().unwrap_or_default());
                            }
                            // Non-streaming-compatible endpoints may already
                            // include the full arguments here.
                            if let Some(args) = function_arguments_string(&item["arguments"]) {
                                apply_complete_arguments(entry, &args);
                            }
                        }
                    }
                    "response.output_item.done" => {
                        let item = &payload["item"];
                        if item["type"] == "function_call" {
                            let call_id = item["call_id"].as_str().unwrap_or_default();
                            let entry = tool_call_entry(
                                &mut self.tool_calls,
                                item["id"].as_str().unwrap_or_default(),
                                Some(call_id),
                            );
                            if entry.call_id.is_empty() && !call_id.is_empty() {
                                entry.call_id = call_id.to_string();
                            }
                            if entry.name.is_empty() {
                                entry
                                    .name
                                    .push_str(item["name"].as_str().unwrap_or_default());
                            }
                            // 无增量流，或增量只到达了一部分时，done 事件里的
                            // 完整参数是最终权威值。
                            if let Some(args) = function_arguments_string(&item["arguments"]) {
                                apply_complete_arguments(entry, &args);
                            }
                        }
                    }
                    "response.function_call_arguments.delta" => {
                        let item_id = payload["item_id"].as_str().unwrap_or_default();
                        let call_id = payload["call_id"].as_str();
                        if let Some(delta) =
                            payload["delta"].as_str().filter(|delta| !delta.is_empty())
                        {
                            let entry = tool_call_entry(&mut self.tool_calls, item_id, call_id);
                            if !entry.args_complete {
                                entry.args.push_str(delta);
                            }
                        }
                    }
                    "response.function_call_arguments.done" => {
                        // 标准 Responses 协议会用这个事件下发完整参数；
                        // 只监听 delta 的适配器会在端点跳过 delta 时拿到空参数。
                        let item_id = payload["item_id"].as_str().unwrap_or_default();
                        let call_id = payload["call_id"].as_str();
                        if let Some(args) = function_arguments_string(&payload["arguments"]) {
                            let entry = tool_call_entry(&mut self.tool_calls, item_id, call_id);
                            apply_complete_arguments(entry, &args);
                        }
                    }
                    "response.completed" | "response.incomplete" => {
                        let response = &payload["response"];
                        if let Some(usage) = response["usage"].as_object() {
                            self.input_tokens = usage
                                .get("input_tokens")
                                .and_then(Value::as_u64)
                                .unwrap_or(self.input_tokens);
                            self.output_tokens = usage
                                .get("output_tokens")
                                .and_then(Value::as_u64)
                                .unwrap_or(self.output_tokens);
                            self.cache_read_tokens = usage
                                .get("input_tokens_details")
                                .and_then(|details| details.get("cached_tokens"))
                                .and_then(Value::as_u64)
                                .unwrap_or(self.cache_read_tokens);
                        }
                        if event == "response.incomplete" {
                            self.stop_reason = "length".into();
                        }
                        self.apply_completed_output(response);
                        self.finish();
                    }
                    "response.failed" => {
                        let message = payload["response"]["error"]["message"]
                            .as_str()
                            .unwrap_or("response failed");
                        self.fail(format!("openai responses stream failed: {message}"));
                    }
                    "error" => {
                        let message = payload["message"]
                            .as_str()
                            .or_else(|| payload["error"]["message"].as_str())
                            .unwrap_or("unknown stream error");
                        self.fail(format!("openai responses stream error: {message}"));
                    }
                    _ => {}
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
            stop_reason: String::new(),
            finished: false,
            queue: VecDeque::new(),
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
                match crate::http::next_stream_chunk("openai responses", &mut st.bytes).await {
                    Err(error) => {
                        st.finished = true;
                        return Some((Err(error), st));
                    }
                    Ok(None) => {
                        // 兼容端点可能不发 terminal 事件直接关流。
                        if !st.finished && (!st.text.is_empty() || !st.tool_calls.is_empty()) {
                            st.finish();
                            continue;
                        }
                        return None;
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
                            st.fail(format!(
                                "openai responses stream is not valid UTF-8: {error}"
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
    #[tokio::test]
    async fn opencode_responses_sessions_survive_retries_and_turns() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let mut provider = OpenAIResponsesProvider::new(
            "test-key".into(),
            "test-model".into(),
            Some(format!("http://opencode.ai:{}/zen/go/v1", address.port())),
        );
        provider.client = crate::test_support::opencode_client(address);
        crate::test_support::assert_opencode_sessions(&provider, listener, "/zen/go/v1/responses", "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n").await;
    }
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn read_http_request(socket: &mut tokio::net::TcpStream) -> (String, String) {
        let mut buffer = Vec::new();
        let mut body_length = None;
        loop {
            let mut chunk = [0u8; 4096];
            let count = socket.read(&mut chunk).await.unwrap();
            assert!(count > 0, "client closed HTTP request before completing it");
            buffer.extend_from_slice(&chunk[..count]);
            if let Some(header_end) = buffer.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                if body_length.is_none() {
                    let headers = String::from_utf8_lossy(&buffer[..header_end]);
                    body_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .or(Some(0));
                }
                let expected = header_end + 4 + body_length.unwrap_or(0);
                if buffer.len() >= expected {
                    let text = String::from_utf8_lossy(&buffer).into_owned();
                    let (head, body) = text.split_once("\r\n\r\n").unwrap();
                    return (head.to_string(), body.to_string());
                }
            }
        }
    }

    async fn write_sse(
        socket: &mut tokio::net::TcpStream,
        events: &[(&'static str, &'static str)],
    ) {
        let mut payload = String::new();
        for (event, data) in events {
            payload.push_str(&format!("event: {event}\ndata: {data}\n\n"));
        }
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                    payload.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    }

    #[test]
    fn builds_flat_function_tools_and_typed_input_items() {
        let provider = OpenAIResponsesProvider::new(
            "key".into(),
            "gpt-5.1".into(),
            Some("https://api.openai.com/v1".into()),
        );
        let history = vec![
            LlmMessage::text(LlmRole::User, "list the file"),
            LlmMessage {
                role: LlmRole::Assistant,
                content: vec![ContentBlock::ToolUse {
                    id: "call_1".into(),
                    name: "read_file".into(),
                    input: json!({ "path": "a.txt" }),
                    raw_input: None,
                    input_error: None,
                }],
            },
            LlmMessage {
                role: LlmRole::User,
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "call_1".into(),
                    content: "hello".into(),
                    is_error: false,
                }],
            },
        ];
        let tools = vec![LlmTool {
            name: "read_file".into(),
            description: "read".into(),
            input_schema: json!({ "type": "object" }),
        }];
        let body =
            provider.request_body(Some("be terse"), &history, &tools, &ChatOptions::default());

        assert_eq!(body["model"], "gpt-5.1");
        assert_eq!(body["instructions"], "be terse");
        assert_eq!(body["stream"], true);
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(
            body["tools"][0],
            json!({
                "type": "function",
                "name": "read_file",
                "description": "read",
                "parameters": { "type": "object" },
            })
        );
        let input = body["input"].as_array().unwrap();
        assert_eq!(
            input[0],
            json!({ "role": "user", "content": [{ "type": "input_text", "text": "list the file" }] })
        );
        assert_eq!(
            input[1],
            json!({
                "type": "function_call",
                "call_id": "call_1",
                "name": "read_file",
                "arguments": "{\"path\":\"a.txt\"}",
            })
        );
        assert_eq!(
            input[2],
            json!({
                "type": "function_call_output",
                "call_id": "call_1",
                "output": "hello",
            })
        );
        // gpt-5 rejects custom temperature.
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn gpt_models_without_thinking_omit_reasoning() {
        let provider = OpenAIResponsesProvider::new("key".into(), "gpt-4.1".into(), None);
        let body = provider.request_body(
            None,
            &[LlmMessage::text(LlmRole::User, "hi")],
            &[],
            &ChatOptions::default(),
        );
        assert!((body["temperature"].as_f64().unwrap() - 0.3).abs() < 1e-6);
        assert!(body.get("reasoning").is_none());
        assert!(body.get("instructions").is_none());
    }

    #[tokio::test]
    async fn streams_text_reasoning_tool_calls_and_usage() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (head, body) = read_http_request(&mut socket).await;
            assert!(head.starts_with("POST /v1/responses HTTP/1.1"));
            assert!(head
                .to_lowercase()
                .contains("authorization: bearer test-key"));
            let payload: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(payload["stream"], true);

            write_sse(
                &mut socket,
                &[
                    ("response.created", r#"{"type":"response.created"}"#),
                    ("response.output_item.added", r#"{"type":"response.output_item.added","item":{"id":"msg_1","type":"message"}}"#),
                    ("response.reasoning_summary_text.delta", r#"{"type":"response.reasoning_summary_text.delta","delta":"thinking "}"#),
                    ("response.output_text.delta", r#"{"type":"response.output_text.delta","delta":"He"}"#),
                    ("response.output_text.delta", r#"{"type":"response.output_text.delta","delta":"llo"}"#),
                    ("response.output_item.added", r#"{"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_9","name":"read_file"}}"#),
                    ("response.function_call_arguments.delta", r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\"path\":"}"#),
                    ("response.function_call_arguments.delta", r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\"a.txt\"}"}"#),
                    (
                        "response.completed",
                        r#"{"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":11,"output_tokens":7,"input_tokens_details":{"cached_tokens":3}}}}"#,
                    ),
                ],
            )
            .await;
        });

        let provider = OpenAIResponsesProvider::new(
            "test-key".into(),
            "gpt-5.1".into(),
            Some(format!("http://{address}/v1")),
        );
        let mut stream = provider
            .chat_stream(
                Some("be terse"),
                vec![LlmMessage::text(LlmRole::User, "hi")],
                vec![],
                8192,
                ChatOptions::default(),
            )
            .await
            .unwrap();

        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            StreamChunk::ThinkingDelta(text) if text == "thinking "
        ));
        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            StreamChunk::TextDelta(text) if text == "He"
        ));
        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            StreamChunk::TextDelta(text) if text == "llo"
        ));
        let StreamChunk::Completed {
            assistant, usage, ..
        } = stream.next().await.unwrap().unwrap()
        else {
            panic!("expected completion");
        };
        assert!(matches!(
            &assistant.content[0],
            ContentBlock::Text { text } if text == "Hello"
        ));
        let ContentBlock::ToolUse {
            id,
            name,
            input,
            input_error,
            ..
        } = &assistant.content[1]
        else {
            panic!("expected tool use block");
        };
        assert_eq!(id, "call_9");
        assert_eq!(name, "read_file");
        assert_eq!(input, &json!({ "path": "a.txt" }));
        assert!(input_error.is_none());
        assert_eq!(usage.input_tokens, 11);
        assert_eq!(usage.output_tokens, 7);
        assert_eq!(usage.cache_read_tokens, 3);
        assert!(stream.next().await.is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn function_call_arguments_done_recovers_after_partial_deltas() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            write_sse(
                &mut socket,
                &[
                    ("response.output_item.added", r#"{"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_9","name":"read_file"}}"#),
                    ("response.function_call_arguments.delta", r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\"path\":"}"#),
                    ("response.function_call_arguments.done", r#"{"type":"response.function_call_arguments.done","item_id":"fc_1","arguments":"{\"path\":\"a.txt\"}"}"#),
                    ("response.completed", r#"{"type":"response.completed","response":{"status":"completed","usage":{}}}"#),
                ],
            )
            .await;
        });

        let provider = OpenAIResponsesProvider::new(
            "test-key".into(),
            "compatible-model".into(),
            Some(format!("http://{address}/v1")),
        );
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "hi")],
                vec![],
                8192,
                ChatOptions::default(),
            )
            .await
            .unwrap();
        let StreamChunk::Completed { assistant, .. } = stream.next().await.unwrap().unwrap() else {
            panic!("expected completion");
        };
        let ContentBlock::ToolUse {
            input, input_error, ..
        } = &assistant.content[0]
        else {
            panic!("expected tool use block");
        };
        assert_eq!(input, &json!({ "path": "a.txt" }));
        assert!(input_error.is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn terminal_arguments_match_call_id_when_item_id_is_missing() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            write_sse(
                &mut socket,
                &[
                    ("response.output_item.added", r#"{"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_9","name":"read_file"}}"#),
                    ("response.function_call_arguments.delta", r#"{"type":"response.function_call_arguments.delta","call_id":"call_9","delta":"{\"path\":"}"#),
                    ("response.function_call_arguments.done", r#"{"type":"response.function_call_arguments.done","call_id":"call_9","arguments":"{\"path\":\"a.txt\"}"}"#),
                    ("response.completed", r#"{"type":"response.completed","response":{"status":"completed","usage":{}}}"#),
                ],
            )
            .await;
        });

        let provider = OpenAIResponsesProvider::new(
            "test-key".into(),
            "compatible-model".into(),
            Some(format!("http://{address}/v1")),
        );
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "hi")],
                vec![],
                8192,
                ChatOptions::default(),
            )
            .await
            .unwrap();
        let StreamChunk::Completed { assistant, .. } = stream.next().await.unwrap().unwrap() else {
            panic!("expected completion");
        };
        assert_eq!(
            assistant.content.len(),
            1,
            "must not duplicate the tool call"
        );
        let ContentBlock::ToolUse {
            input, input_error, ..
        } = &assistant.content[0]
        else {
            panic!("expected tool use block");
        };
        assert_eq!(input, &json!({ "path": "a.txt" }));
        assert!(input_error.is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn output_item_done_full_arguments_override_partial_deltas() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            write_sse(
                &mut socket,
                &[
                    ("response.output_item.added", r#"{"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_9","name":"read_file"}}"#),
                    ("response.function_call_arguments.delta", r#"{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\"path\":"}"#),
                    ("response.output_item.done", r#"{"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","call_id":"call_9","name":"read_file","arguments":"{\"path\":\"a.txt\"}"}}"#),
                    ("response.completed", r#"{"type":"response.completed","response":{"status":"completed","usage":{}}}"#),
                ],
            )
            .await;
        });

        let provider = OpenAIResponsesProvider::new(
            "test-key".into(),
            "compatible-model".into(),
            Some(format!("http://{address}/v1")),
        );
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "hi")],
                vec![],
                8192,
                ChatOptions::default(),
            )
            .await
            .unwrap();
        let StreamChunk::Completed { assistant, .. } = stream.next().await.unwrap().unwrap() else {
            panic!("expected completion");
        };
        let ContentBlock::ToolUse {
            input, input_error, ..
        } = &assistant.content[0]
        else {
            panic!("expected tool use block");
        };
        assert_eq!(input, &json!({ "path": "a.txt" }));
        assert!(input_error.is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn response_completed_output_recovers_text_and_tool_calls() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            write_sse(
                &mut socket,
                &[(
                    "response.completed",
                    r#"{"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":5,"output_tokens":6},"output":[{"type":"message","id":"msg_1","content":[{"type":"output_text","text":"Hello"}]},{"type":"function_call","id":"fc_1","call_id":"call_9","name":"read_file","arguments":"{\"path\":\"a.txt\"}"}]}}"#,
                )],
            )
            .await;
        });

        let provider = OpenAIResponsesProvider::new(
            "test-key".into(),
            "compatible-model".into(),
            Some(format!("http://{address}/v1")),
        );
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "hi")],
                vec![],
                8192,
                ChatOptions::default(),
            )
            .await
            .unwrap();
        let StreamChunk::Completed {
            assistant, usage, ..
        } = stream.next().await.unwrap().unwrap()
        else {
            panic!("expected completion");
        };
        assert!(matches!(
            &assistant.content[0],
            ContentBlock::Text { text } if text == "Hello"
        ));
        let ContentBlock::ToolUse {
            id,
            name,
            input,
            input_error,
            ..
        } = &assistant.content[1]
        else {
            panic!("expected tool use block");
        };
        assert_eq!(id, "call_9");
        assert_eq!(name, "read_file");
        assert_eq!(input, &json!({ "path": "a.txt" }));
        assert!(input_error.is_none());
        assert_eq!(usage.output_tokens, 6);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn eof_without_terminal_event_finishes_partial_content() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            write_sse(
                &mut socket,
                &[(
                    "response.output_text.delta",
                    r#"{"type":"response.output_text.delta","delta":"partial"}"#,
                )],
            )
            .await;
        });

        let provider = OpenAIResponsesProvider::new(
            "test-key".into(),
            "gpt-4.1".into(),
            Some(format!("http://{address}/v1")),
        );
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "hi")],
                vec![],
                8192,
                ChatOptions::default(),
            )
            .await
            .unwrap();
        assert!(matches!(
            stream.next().await.unwrap().unwrap(),
            StreamChunk::TextDelta(text) if text == "partial"
        ));
        let StreamChunk::Completed { assistant, .. } = stream.next().await.unwrap().unwrap() else {
            panic!("expected completion");
        };
        assert!(matches!(
            &assistant.content[0],
            ContentBlock::Text { text } if text == "partial"
        ));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn generic_invalid_parameter_downgrades_optional_responses_fields() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for attempt in 0..4 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let (_, body) = read_http_request(&mut socket).await;
                let payload: Value = serde_json::from_str(&body).unwrap();
                match attempt {
                    0 => assert!(payload.get("temperature").is_some()),
                    1 => {
                        assert!(payload.get("temperature").is_none());
                        assert!(payload.get("reasoning").is_some());
                    }
                    2 => {
                        assert!(payload.get("temperature").is_none());
                        assert!(payload.get("reasoning").is_none());
                        assert!(payload.get("tool_choice").is_some());
                    }
                    3 => {
                        assert!(payload.get("temperature").is_none());
                        assert!(payload.get("reasoning").is_none());
                        assert!(payload.get("tool_choice").is_none());
                    }
                    _ => unreachable!(),
                }
                if attempt < 3 {
                    let error = r#"{"error":{"code":"InvalidParameter","message":"A parameter specified in the request is not valid","param":"","type":"BadRequest"}}"#;
                    socket
                        .write_all(
                            format!(
                                "HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{error}",
                                error.len()
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                } else {
                    write_sse(
                        &mut socket,
                        &[
                            (
                                "response.output_text.delta",
                                r#"{"type":"response.output_text.delta","delta":"ok"}"#,
                            ),
                            (
                                "response.completed",
                                r#"{"type":"response.completed","response":{"usage":{}}}"#,
                            ),
                        ],
                    )
                    .await;
                }
            }
        });

        let provider = OpenAIResponsesProvider::new(
            "test-key".into(),
            "compatible-model".into(),
            Some(format!("http://{address}/v1")),
        );
        let mut options = ChatOptions::default();
        options.enable_thinking = true;
        options.reasoning_effort = Some("medium".into());
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "hi")],
                vec![LlmTool {
                    name: "tool".into(),
                    description: "test".into(),
                    input_schema: json!({"type":"object"}),
                }],
                8192,
                options,
            )
            .await
            .unwrap();
        let mut text = String::new();
        while let Some(chunk) = stream.next().await {
            if let StreamChunk::TextDelta(delta) = chunk.unwrap() {
                text.push_str(&delta);
            }
        }
        assert_eq!(text, "ok");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn unsupported_endpoint_returns_actionable_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            let body = r#"{"error":{"message":"Not found: no route for /v1/responses"}}"#;
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 404 Not Found\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });

        let provider = OpenAIResponsesProvider::new(
            "test-key".into(),
            "gpt-4.1".into(),
            Some(format!("http://{address}/v1")),
        );
        let error = match provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "hi")],
                vec![],
                8192,
                ChatOptions::default(),
            )
            .await
        {
            Err(error) => error.to_string(),
            Ok(_) => panic!("expected the unsupported endpoint to fail the request"),
        };
        server.await.unwrap();
        assert!(error.contains("404"));
        assert!(error.contains("Chat Completions"));
    }

    #[tokio::test]
    async fn stream_error_event_fails_the_stream() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            write_sse(
                &mut socket,
                &[(
                    "error",
                    r#"{"type":"error","code":"server_error","message":"boom"}"#,
                )],
            )
            .await;
        });

        let provider = OpenAIResponsesProvider::new(
            "test-key".into(),
            "gpt-4.1".into(),
            Some(format!("http://{address}/v1")),
        );
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "hi")],
                vec![],
                8192,
                ChatOptions::default(),
            )
            .await
            .unwrap();
        let error = stream.next().await.unwrap().unwrap_err().to_string();
        assert!(error.contains("boom"));
        server.await.unwrap();
    }
}
