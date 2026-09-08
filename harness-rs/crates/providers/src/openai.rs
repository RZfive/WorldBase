//! OpenAI Chat Completions 流式 provider（含 tool_calls，支持 OpenAI 兼容端点）。

use super::sse::SseParser;
use super::{
    ChatOptions, ChunkStream, ContentBlock, LlmMessage, LlmRole, LlmTool, Provider, StreamChunk,
    TokenUsage,
};
use anyhow::{bail, Context, Result};
#[cfg(test)]
use futures::stream::StreamExt;
use reqwest::{Client, Response, StatusCode, Url};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const CODING_TEMPERATURE: f32 = 0.3;
const IMAGE_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);
const CONTINUATION_USER_MESSAGE: &str =
    "Continue the current task from the existing context. Do not repeat completed steps.";
const OPTIONAL_COMPATIBILITY_PARAMETERS: [&str; 4] = [
    "stream_options",
    "reasoning_effort",
    "temperature",
    "tool_choice",
];

pub struct OpenAIProvider {
    client: Client,
    api_key: String,
    model: String,
    base_url: String,
    image_generation: bool,
    image_editing: bool,
    rejected_optional_parameters: Mutex<HashSet<&'static str>>,
}

fn is_image_output_model(model: &str, image_generation: bool) -> bool {
    let normalized = model.to_ascii_lowercase();
    image_generation
        || normalized.contains("image-preview")
        || normalized.contains("gpt-image")
        || normalized.contains("imagen")
        || normalized.contains("-image")
        || normalized.contains("image-")
        || normalized.contains("flux")
}

fn is_dedicated_image_model(model: &str) -> bool {
    let normalized = model.to_ascii_lowercase();
    normalized.contains("dall-e")
        || normalized.contains("dalle")
        || normalized.contains("gpt-image")
}

fn is_gpt_image_model(model: &str) -> bool {
    model.to_ascii_lowercase().contains("gpt-image")
}

fn should_retry_image_response_without_tool(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("image_generation")
        || message.contains("unknown tool")
        || message.contains("invalid tool")
        || message.contains("unsupported tool")
}

fn should_fallback_from_responses(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("missing_required_parameter")
        || (message.contains("\"input\"") && message.contains("must be provided"))
        || message.contains("previous_response_id")
        || message.contains("conversation_id")
        || (message.contains("not found") && message.contains("/responses"))
}

fn response_usage(value: &Value) -> TokenUsage {
    let usage = &value["usage"];
    TokenUsage {
        input_tokens: usage["input_tokens"]
            .as_u64()
            .or_else(|| usage["prompt_tokens"].as_u64())
            .unwrap_or(0),
        output_tokens: usage["output_tokens"]
            .as_u64()
            .or_else(|| usage["completion_tokens"].as_u64())
            .unwrap_or(0),
        cache_read_tokens: usage["input_tokens_details"]["cached_tokens"]
            .as_u64()
            .or_else(|| usage["prompt_tokens_details"]["cached_tokens"].as_u64())
            .unwrap_or(0),
        cache_creation_tokens: 0,
    }
}

fn image_url_from_part(part: &Value) -> Option<String> {
    if let Some(url) = part["image_url"].as_str().filter(|url| !url.is_empty()) {
        return Some(url.to_string());
    }
    if let Some(url) = part["image_url"]["url"]
        .as_str()
        .filter(|url| !url.is_empty())
    {
        return Some(url.to_string());
    }
    if let Some(url) = part["imageUrl"]["url"]
        .as_str()
        .filter(|url| !url.is_empty())
    {
        return Some(url.to_string());
    }

    let inline = part.get("inline_data").or_else(|| part.get("inlineData"));
    if let Some(data) = inline
        .and_then(|value| value.get("data"))
        .and_then(Value::as_str)
        .filter(|data| !data.is_empty())
    {
        let mime = inline
            .and_then(|value| value.get("mime_type").or_else(|| value.get("mimeType")))
            .and_then(Value::as_str)
            .filter(|mime| !mime.trim().is_empty())
            .unwrap_or("image/png");
        return Some(format!("data:{mime};base64,{data}"));
    }

    let data = part["result"]
        .as_str()
        .or_else(|| part["b64_json"].as_str())
        .filter(|data| !data.is_empty())?;
    let mime = part["mime_type"]
        .as_str()
        .or_else(|| part["mimeType"].as_str())
        .filter(|mime| !mime.trim().is_empty())
        .unwrap_or("image/png");
    Some(format!("data:{mime};base64,{data}"))
}

fn push_image_response_part(blocks: &mut Vec<ContentBlock>, part: &Value) {
    if let Some(text) = part["text"].as_str().filter(|text| !text.is_empty()) {
        blocks.push(ContentBlock::Text {
            text: text.to_string(),
        });
    }
    if let Some(url) = image_url_from_part(part) {
        blocks.push(ContentBlock::ImageUrl { url });
    }
}

fn responses_message(value: &Value) -> LlmMessage {
    let mut blocks = Vec::new();
    if let Some(output) = value["output"].as_array() {
        for item in output {
            if let Some(content) = item["content"].as_array() {
                for part in content {
                    push_image_response_part(&mut blocks, part);
                }
            } else {
                push_image_response_part(&mut blocks, item);
            }
        }
    }
    if blocks.is_empty() {
        if let Some(text) = value["output_text"]
            .as_str()
            .filter(|text| !text.is_empty())
        {
            blocks.push(ContentBlock::Text {
                text: text.to_string(),
            });
        }
    }
    LlmMessage {
        role: LlmRole::Assistant,
        content: blocks,
    }
}

fn chat_image_message(value: &Value) -> LlmMessage {
    let message = &value["choices"][0]["message"];
    let mut blocks = Vec::new();

    if let Some(parts) = message["multi_mod_content"].as_array() {
        for part in parts {
            push_image_response_part(&mut blocks, part);
        }
    }
    if blocks.is_empty() {
        if let Some(parts) = message["content"].as_array() {
            for part in parts {
                push_image_response_part(&mut blocks, part);
            }
        } else if let Some(text) = message["content"].as_str().filter(|text| !text.is_empty()) {
            blocks.push(ContentBlock::Text {
                text: text.to_string(),
            });
        }
    }
    if let Some(images) = message["images"].as_array() {
        for image in images {
            if let Some(url) = image_url_from_part(image) {
                blocks.push(ContentBlock::ImageUrl { url });
            }
        }
    }

    LlmMessage {
        role: LlmRole::Assistant,
        content: blocks,
    }
}

fn generations_message(value: &Value) -> LlmMessage {
    let mut blocks = Vec::new();
    if let Some(images) = value["data"].as_array() {
        for image in images {
            if let Some(prompt) = image["revised_prompt"]
                .as_str()
                .filter(|prompt| !prompt.is_empty())
            {
                blocks.push(ContentBlock::Text {
                    text: prompt.to_string(),
                });
            }
            if let Some(url) = image_url_from_part(image) {
                blocks.push(ContentBlock::ImageUrl { url });
            } else if let Some(url) = image["url"].as_str().filter(|url| !url.is_empty()) {
                blocks.push(ContentBlock::ImageUrl {
                    url: url.to_string(),
                });
            }
        }
    }
    LlmMessage {
        role: LlmRole::Assistant,
        content: blocks,
    }
}

fn is_openai_provider(base_url: &str, model: &str) -> bool {
    let base_url = base_url.to_ascii_lowercase();
    let model = model.to_ascii_lowercase();
    base_url.contains("openai") || model.starts_with("gpt-") || is_o_series(&model)
}

fn is_anthropic_provider(base_url: &str, model: &str) -> bool {
    base_url.to_ascii_lowercase().contains("anthropic")
        || model.to_ascii_lowercase().contains("claude")
}

fn is_o_series(model: &str) -> bool {
    let bytes = model.as_bytes();
    bytes.len() >= 2 && bytes[0] == b'o' && matches!(bytes[1], b'1'..=b'9')
}

fn model_rejects_custom_temperature(base_url: &str, model: &str) -> bool {
    if !is_openai_provider(base_url, model) {
        return false;
    }
    let model = model.to_ascii_lowercase();
    model.starts_with("gpt-5") || is_o_series(&model)
}

fn resolve_reasoning_effort(base_url: &str, model: &str, options: &ChatOptions) -> Option<String> {
    if !options.enable_thinking {
        return None;
    }
    let effort = options.reasoning_effort.as_deref().unwrap_or("medium");
    let normalized =
        if is_openai_provider(base_url, model) && model.to_ascii_lowercase().starts_with("gpt-5") {
            match effort {
                "low" => "minimal",
                "medium" => "low",
                "high" => "medium",
                "max" => "high",
                "minimal" => "minimal",
                _ => return None,
            }
        } else {
            match effort {
                "minimal" | "low" | "medium" | "high" => effort,
                "max" => "high",
                _ => return None,
            }
        };
    Some(normalized.to_string())
}

fn remove_rejected_optional_parameter(body: &mut Value, error_text: &str) -> Option<&'static str> {
    let lower = error_text.to_ascii_lowercase();
    for key in OPTIONAL_COMPATIBILITY_PARAMETERS {
        let mentioned = lower.contains(key) || lower.contains(&key.replace('_', " "));
        if mentioned && body.get(key).is_some() {
            body.as_object_mut()?.remove(key);
            return Some(key);
        }
    }
    None
}

fn is_generic_invalid_parameter_error(error_text: &str) -> bool {
    let Ok(response) = serde_json::from_str::<Value>(error_text) else {
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

fn sanitize_tool_message_sequence(messages: Vec<Value>) -> Vec<Value> {
    let mut sanitized = Vec::new();
    let mut index = 0;
    while index < messages.len() {
        let message = &messages[index];
        if message["role"] == "tool" {
            index += 1;
            continue;
        }

        let Some(tool_calls) = (message["role"] == "assistant")
            .then(|| message["tool_calls"].as_array())
            .flatten()
            .filter(|calls| !calls.is_empty())
        else {
            sanitized.push(message.clone());
            index += 1;
            continue;
        };

        let expected_ids = tool_calls
            .iter()
            .filter_map(|call| call["id"].as_str().map(str::trim))
            .filter(|id| !id.is_empty())
            .collect::<HashSet<_>>();
        let valid_call_ids = expected_ids.len() == tool_calls.len();

        let first_result = index + 1;
        let mut next_index = first_result;
        while next_index < messages.len() && messages[next_index]["role"] == "tool" {
            next_index += 1;
        }
        let tool_messages = &messages[first_result..next_index];
        let mut matched_ids = HashSet::new();
        let valid_results = !tool_messages.is_empty()
            && tool_messages.iter().all(|result| {
                let Some(id) = result["tool_call_id"]
                    .as_str()
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                else {
                    return false;
                };
                expected_ids.contains(id) && matched_ids.insert(id)
            })
            && matched_ids.len() == expected_ids.len();

        if valid_call_ids && valid_results {
            sanitized.push(message.clone());
            sanitized.extend(tool_messages.iter().cloned());
        }
        index = next_index;
    }

    if !sanitized.iter().any(|message| message["role"] == "user") {
        sanitized.push(json!({
            "role": "user",
            "content": CONTINUATION_USER_MESSAGE,
        }));
    }
    sanitized
}

impl OpenAIProvider {
    pub fn new(api_key: String, model: String, base_url: Option<String>) -> Self {
        Self {
            client: crate::http::client(),
            api_key,
            model,
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.into()),
            image_generation: false,
            image_editing: false,
            rejected_optional_parameters: Mutex::new(HashSet::new()),
        }
    }

    pub fn with_image_capabilities(mut self, image_generation: bool, image_editing: bool) -> Self {
        self.image_generation = image_generation;
        self.image_editing = image_editing;
        self
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
                            ContentBlock::ImageUrl { .. } => {}
                            ContentBlock::Thinking { .. }
                            | ContentBlock::RedactedThinking { .. } => {}
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
                            ContentBlock::ToolUse {
                                id,
                                name,
                                input,
                                raw_input,
                                ..
                            } => {
                                let arguments =
                                    raw_input.clone().unwrap_or_else(|| input.to_string());
                                Some(json!({
                                    "id": id,
                                    "type": "function",
                                    "function": { "name": name, "arguments": arguments },
                                }))
                            }
                            _ => None,
                        })
                        .collect();
                    let text = m.text_view();
                    // Electron always emits an explicit content string. Some
                    // OpenAI-compatible gateways reject a tool-call assistant
                    // message when the otherwise optional field is omitted.
                    let mut msg = json!({ "role": "assistant", "content": text });
                    if !tool_calls.is_empty() {
                        msg["tool_calls"] = Value::Array(tool_calls);
                    }
                    out.push(msg);
                }
            }
        }
        out
    }

    fn wire_messages(&self, system: Option<&str>, messages: &[LlmMessage]) -> Vec<Value> {
        let mut wire = sanitize_tool_message_sequence(Self::to_wire_messages(messages));
        if let Some(system) = system {
            let content =
                if !system.is_empty() && is_anthropic_provider(&self.base_url, &self.model) {
                    json!([{
                        "type": "text",
                        "text": system,
                        "cache_control": { "type": "ephemeral" },
                    }])
                } else {
                    json!(system)
                };
            wire.insert(0, json!({ "role": "system", "content": content }));
        }
        wire
    }

    fn request_body(
        &self,
        system: Option<&str>,
        messages: &[LlmMessage],
        tools: &[LlmTool],
        options: &ChatOptions,
    ) -> Value {
        let wire = self.wire_messages(system, messages);

        let mut body = json!({
            "model": self.model,
            "messages": wire,
            "stream": true,
            "stream_options": { "include_usage": true },
        });
        if !model_rejects_custom_temperature(&self.base_url, &self.model) {
            let temperature = options
                .temperature
                .filter(|value| value.is_finite())
                .unwrap_or(CODING_TEMPERATURE)
                .clamp(0.0, 2.0);
            body["temperature"] = json!(temperature);
        }
        if let Some(reasoning_effort) =
            resolve_reasoning_effort(&self.base_url, &self.model, options)
        {
            body["reasoning_effort"] = json!(reasoning_effort);
        }
        if !tools.is_empty() {
            body["tools"] = json!(tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            // Keep the documented execution contract intact.
                            // Removing composition keywords such as `anyOf`
                            // makes the model-facing contract less restrictive
                            // than the handler and causes avoidable bad calls.
                            "parameters": tool.input_schema.clone(),
                        },
                    })
                })
                .collect::<Vec<_>>());
            body["tool_choice"] = json!("auto");
        }
        body
    }

    async fn send_compatible_request(&self, url: Url, mut body: Value) -> Result<Response> {
        // Compatibility gateways frequently reject one OpenAI extension while
        // supporting the rest of chat/completions. Prefer an explicitly named
        // optional field. Some gateways instead return the generic
        // InvalidParameter envelope with an empty `param`; for that exact
        // shape, try each known optional extension once in a fixed order.
        // Semantic errors and required request fields still surface directly.
        let rejected = self.rejected_optional_parameters.lock().unwrap().clone();
        if let Some(object) = body.as_object_mut() {
            for key in rejected {
                object.remove(key);
            }
        }
        loop {
            let response = crate::http::send_with_retry("openai", || {
                self.client
                    .post(url.clone())
                    .bearer_auth(&self.api_key)
                    .json(&body)
            })
            .await?;
            let status = response.status();
            if status.is_success() {
                return Ok(response);
            }

            let text = response.text().await.unwrap_or_default();
            let can_downgrade =
                status == StatusCode::BAD_REQUEST || status == StatusCode::UNPROCESSABLE_ENTITY;
            if can_downgrade {
                if let Some(key) = remove_rejected_optional_parameter(&mut body, &text) {
                    self.rejected_optional_parameters
                        .lock()
                        .unwrap()
                        .insert(key);
                    continue;
                }
                if is_generic_invalid_parameter_error(&text) {
                    if let Some(key) = remove_ambiguous_optional_parameter(&mut body) {
                        self.rejected_optional_parameters
                            .lock()
                            .unwrap()
                            .insert(key);
                        continue;
                    }
                }
            }
            bail!("openai api error ({status}): {text}");
        }
    }

    fn responses_input(&self, system: Option<&str>, messages: &[LlmMessage]) -> Result<Vec<Value>> {
        let mut input = Vec::new();
        if let Some(system) = system.filter(|text| !text.is_empty()) {
            input.push(json!({
                "role": "system",
                "content": [{ "type": "input_text", "text": system }],
            }));
        }

        for message in messages {
            let mut content = Vec::new();
            for block in &message.content {
                match block {
                    ContentBlock::Text { text } if !text.is_empty() => {
                        content.push(json!({ "type": "input_text", "text": text }));
                    }
                    ContentBlock::ImageUrl { url } if !url.is_empty() => {
                        if !self.image_editing {
                            bail!("provider image editing capability is disabled");
                        }
                        content.push(json!({ "type": "input_image", "image_url": url }));
                    }
                    _ => {}
                }
            }
            if content.is_empty() {
                continue;
            }
            input.push(json!({
                "role": match message.role {
                    LlmRole::User => "user",
                    LlmRole::Assistant => "assistant",
                },
                "content": content,
            }));
        }

        if input.iter().all(|message| message["role"] != "user") {
            input.push(json!({
                "role": "user",
                "content": [{
                    "type": "input_text",
                    "text": "Continue the current task from the existing context. Do not repeat completed steps.",
                }],
            }));
        }
        Ok(input)
    }

    async fn post_image_json(&self, label: &str, url: Url, body: &Value) -> Result<Value> {
        let response = crate::http::send_with_retry_timeout(label, IMAGE_REQUEST_TIMEOUT, || {
            self.client
                .post(url.clone())
                .bearer_auth(&self.api_key)
                .json(body)
                .timeout(IMAGE_REQUEST_TIMEOUT)
        })
        .await?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            bail!("{label} api error ({status}): {text}");
        }
        response
            .json::<Value>()
            .await
            .with_context(|| format!("parse {label} response"))
    }

    async fn responses_image_completion(
        &self,
        system: Option<&str>,
        messages: &[LlmMessage],
        include_tool: bool,
    ) -> Result<(LlmMessage, TokenUsage)> {
        let mut body = json!({
            "model": self.model,
            "input": self.responses_input(system, messages)?,
            "stream": false,
        });
        if include_tool {
            body["tools"] = json!([{ "type": "image_generation" }]);
        }
        let value = self
            .post_image_json(
                "openai image /responses",
                crate::urls::responses_url(&self.base_url)?,
                &body,
            )
            .await?;
        Ok((responses_message(&value), response_usage(&value)))
    }

    async fn generations_image_completion(
        &self,
        messages: &[LlmMessage],
    ) -> Result<(LlmMessage, TokenUsage)> {
        let prompt = messages
            .iter()
            .rev()
            .find(|message| message.role == LlmRole::User)
            .map(LlmMessage::text_view)
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| "Generate an image".to_string());
        let mut body = json!({
            "model": self.model,
            "prompt": prompt,
            "n": 1,
            "size": "1024x1024",
        });
        if !is_gpt_image_model(&self.model) {
            body["response_format"] = json!("b64_json");
        }
        let value = self
            .post_image_json(
                "openai image /images/generations",
                crate::urls::image_generations_url(&self.base_url)?,
                &body,
            )
            .await?;
        Ok((generations_message(&value), response_usage(&value)))
    }

    async fn chat_image_completion(
        &self,
        system: Option<&str>,
        messages: &[LlmMessage],
    ) -> Result<(LlmMessage, TokenUsage)> {
        let wire = self.wire_messages(system, messages);
        let mut body = json!({
            "model": self.model,
            "messages": wire,
            "stream": false,
            "modalities": ["text", "image"],
        });
        if !model_rejects_custom_temperature(&self.base_url, &self.model) {
            body["temperature"] = json!(CODING_TEMPERATURE);
        }
        let value = self
            .post_image_json(
                "openai image /chat/completions",
                crate::urls::chat_completions_url(&self.base_url)?,
                &body,
            )
            .await?;
        Ok((chat_image_message(&value), response_usage(&value)))
    }

    async fn image_response_completion(
        &self,
        system: Option<&str>,
        messages: &[LlmMessage],
    ) -> Result<(LlmMessage, TokenUsage)> {
        if is_dedicated_image_model(&self.model) {
            if let Ok(completion) = self.generations_image_completion(messages).await {
                return Ok(completion);
            }
        }

        let mut responses_error = match self
            .responses_image_completion(system, messages, true)
            .await
        {
            Ok(completion) => return Ok(completion),
            Err(error) => error,
        };
        if should_retry_image_response_without_tool(&responses_error.to_string()) {
            match self
                .responses_image_completion(system, messages, false)
                .await
            {
                Ok(completion) => return Ok(completion),
                Err(error) => responses_error = error,
            }
        }

        if should_fallback_from_responses(&responses_error.to_string()) {
            if let Ok(completion) = self.generations_image_completion(messages).await {
                return Ok(completion);
            }
            return self.chat_image_completion(system, messages).await;
        }

        if let Ok(completion) = self.generations_image_completion(messages).await {
            return Ok(completion);
        }
        Err(responses_error)
    }
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
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

    async fn write_response(
        socket: &mut tokio::net::TcpStream,
        status: &str,
        content_type: &str,
        body: &str,
    ) {
        let response = format!(
            "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    }

    #[test]
    fn tool_schemas_preserve_composition_and_nested_constraints() {
        let schema = serde_json::json!({
            "type": "object",
            "anyOf": [{ "required": ["prompt"] }, { "required": ["tasks"] }],
            "properties": {
                "nested": {
                    "type": "array",
                    "items": { "type": "object", "anyOf": [{ "required": ["id"] }] }
                }
            }
        });

        let tool = LlmTool {
            name: "batch".into(),
            description: "Run one or many prompts".into(),
            input_schema: schema.clone(),
        };
        let provider = OpenAIProvider::new("key".into(), "gpt-4.1".into(), None);
        let body = provider.request_body(
            None,
            &[LlmMessage::text(LlmRole::User, "hello")],
            &[tool],
            &ChatOptions::default(),
        );

        assert_eq!(body["tools"][0]["function"]["parameters"], schema);
    }

    #[test]
    fn request_options_are_model_aware_and_thinking_is_opt_in() {
        let compatible = OpenAIProvider::new(
            "key".into(),
            "deepseek-chat".into(),
            Some("https://api.deepseek.com/v1".into()),
        );
        let disabled = compatible.request_body(
            None,
            &[LlmMessage::text(LlmRole::User, "hello")],
            &[],
            &ChatOptions {
                temperature: None,
                enable_thinking: false,
                reasoning_effort: Some("max".into()),
            },
        );
        assert_eq!(disabled["temperature"], json!(CODING_TEMPERATURE));
        assert!(disabled.get("reasoning_effort").is_none());
        assert!(disabled.get("max_tokens").is_none());
        assert!(disabled.get("max_completion_tokens").is_none());

        let gpt5 = OpenAIProvider::new(
            "key".into(),
            "gpt-5.1".into(),
            Some("https://api.openai.com/v1".into()),
        );
        let enabled = gpt5.request_body(
            None,
            &[LlmMessage::text(LlmRole::User, "hello")],
            &[],
            &ChatOptions {
                temperature: Some(0.8),
                enable_thinking: true,
                reasoning_effort: Some("high".into()),
            },
        );
        assert_eq!(enabled["reasoning_effort"], "medium");
        assert!(enabled.get("temperature").is_none());
    }

    #[test]
    fn assistant_tool_calls_keep_the_explicit_empty_content_field() {
        let wire = OpenAIProvider::to_wire_messages(&[LlmMessage {
            role: LlmRole::Assistant,
            content: vec![ContentBlock::ToolUse {
                id: "call-1".into(),
                name: "read_file".into(),
                input: json!({ "path": "README.md" }),
                raw_input: None,
                input_error: None,
            }],
        }]);

        assert_eq!(wire[0]["content"], "");
        assert_eq!(wire[0]["tool_calls"][0]["id"], "call-1");
    }

    #[test]
    fn request_history_appends_a_user_after_leading_assistant_context() {
        let provider = OpenAIProvider::new("key".into(), "model".into(), None);
        let body = provider.request_body(
            None,
            &[LlmMessage::text(LlmRole::Assistant, "prior answer")],
            &[],
            &ChatOptions::default(),
        );

        assert_eq!(body["messages"][0]["role"], "assistant");
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"], CONTINUATION_USER_MESSAGE);
    }

    #[test]
    fn openai_protocol_claude_adds_a_system_prompt_cache_breakpoint() {
        for provider in [
            OpenAIProvider::new(
                "key".into(),
                "claude-sonnet-4".into(),
                Some("https://openrouter.example/v1".into()),
            ),
            OpenAIProvider::new(
                "key".into(),
                "gateway-model".into(),
                Some("https://proxy.example/anthropic/v1".into()),
            ),
        ] {
            let body = provider.request_body(
                Some("stable instructions"),
                &[LlmMessage::text(LlmRole::User, "hello")],
                &[],
                &ChatOptions::default(),
            );
            assert_eq!(
                body["messages"][0]["content"],
                json!([{
                    "type": "text",
                    "text": "stable instructions",
                    "cache_control": { "type": "ephemeral" },
                }])
            );
        }

        let openai = OpenAIProvider::new("key".into(), "gpt-4.1".into(), None);
        let body = openai.request_body(
            Some("plain instructions"),
            &[LlmMessage::text(LlmRole::User, "hello")],
            &[],
            &ChatOptions::default(),
        );
        assert_eq!(body["messages"][0]["content"], "plain instructions");
    }

    #[tokio::test]
    async fn image_chat_fallback_reuses_history_cleanup_and_prompt_caching() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = read_http_request(&mut socket).await;
            let body = String::from_utf8_lossy(&request)
                .split_once("\r\n\r\n")
                .map(|(_, body)| body.to_string())
                .unwrap();
            let body: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(body["stream"], false);
            assert_eq!(body["modalities"], json!(["text", "image"]));
            assert_eq!(body["messages"].as_array().unwrap().len(), 2);
            assert_eq!(
                body["messages"][0]["content"][0]["cache_control"]["type"],
                "ephemeral"
            );
            assert_eq!(body["messages"][1]["role"], "user");
            assert_eq!(body["messages"][1]["content"], CONTINUATION_USER_MESSAGE);
            write_response(
                &mut socket,
                "200 OK",
                "application/json",
                r#"{"choices":[{"message":{"role":"assistant","content":"done"}}]}"#,
            )
            .await;
        });

        let provider = OpenAIProvider::new(
            "key".into(),
            "claude-image-compatible".into(),
            Some(format!("http://{address}/v1")),
        );
        let incomplete = [LlmMessage {
            role: LlmRole::Assistant,
            content: vec![ContentBlock::ToolUse {
                id: "orphan-call".into(),
                name: "read_file".into(),
                input: json!({}),
                raw_input: None,
                input_error: None,
            }],
        }];
        let (message, _) = provider
            .chat_image_completion(Some("stable"), &incomplete)
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(message.text_view(), "done");
    }

    #[test]
    fn request_history_drops_orphan_tool_results_and_incomplete_tool_calls() {
        let provider = OpenAIProvider::new("key".into(), "model".into(), None);
        let body = provider.request_body(
            None,
            &[
                LlmMessage {
                    role: LlmRole::User,
                    content: vec![ContentBlock::ToolResult {
                        tool_use_id: "orphan".into(),
                        content: "unused".into(),
                        is_error: false,
                    }],
                },
                LlmMessage {
                    role: LlmRole::Assistant,
                    content: vec![ContentBlock::ToolUse {
                        id: "call-missing".into(),
                        name: "read_file".into(),
                        input: json!({}),
                        raw_input: None,
                        input_error: None,
                    }],
                },
                LlmMessage::text(LlmRole::User, "continue"),
            ],
            &[],
            &ChatOptions::default(),
        );

        assert_eq!(
            body["messages"],
            json!([{
                "role": "user",
                "content": "continue",
            }])
        );
    }

    #[test]
    fn request_history_keeps_only_complete_unique_tool_call_groups() {
        let provider = OpenAIProvider::new("key".into(), "model".into(), None);
        let valid = [
            LlmMessage {
                role: LlmRole::Assistant,
                content: vec![
                    ContentBlock::ToolUse {
                        id: "call-a".into(),
                        name: "read_file".into(),
                        input: json!({}),
                        raw_input: None,
                        input_error: None,
                    },
                    ContentBlock::ToolUse {
                        id: "call-b".into(),
                        name: "glob".into(),
                        input: json!({}),
                        raw_input: None,
                        input_error: None,
                    },
                ],
            },
            LlmMessage {
                role: LlmRole::User,
                content: vec![
                    ContentBlock::ToolResult {
                        tool_use_id: "call-a".into(),
                        content: "a".into(),
                        is_error: false,
                    },
                    ContentBlock::ToolResult {
                        tool_use_id: "call-b".into(),
                        content: "b".into(),
                        is_error: false,
                    },
                    ContentBlock::Text {
                        text: "next".into(),
                    },
                ],
            },
        ];
        let body = provider.request_body(None, &valid, &[], &ChatOptions::default());

        assert_eq!(body["messages"].as_array().unwrap().len(), 4);
        assert_eq!(body["messages"][0]["role"], "assistant");
        assert_eq!(body["messages"][1]["tool_call_id"], "call-a");
        assert_eq!(body["messages"][2]["tool_call_id"], "call-b");
        assert_eq!(body["messages"][3]["content"], "next");

        let duplicate_ids = [LlmMessage {
            role: LlmRole::Assistant,
            content: vec![
                ContentBlock::ToolUse {
                    id: "same".into(),
                    name: "one".into(),
                    input: json!({}),
                    raw_input: None,
                    input_error: None,
                },
                ContentBlock::ToolUse {
                    id: "same".into(),
                    name: "two".into(),
                    input: json!({}),
                    raw_input: None,
                    input_error: None,
                },
            ],
        }];
        let body = provider.request_body(None, &duplicate_ids, &[], &ChatOptions::default());
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["role"], "user");
    }

    #[tokio::test]
    async fn full_endpoint_and_optional_parameter_fallback_work_end_to_end() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for attempt in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut socket).await;
                let request = String::from_utf8_lossy(&request);
                assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
                assert!(request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer test-key"));
                let body = request.split_once("\r\n\r\n").unwrap().1;
                let body: Value = serde_json::from_str(body).unwrap();
                assert!(body.get("max_tokens").is_none());
                assert!(body.get("reasoning_effort").is_none());
                if attempt == 0 {
                    assert!(body.get("stream_options").is_some());
                    write_response(
                        &mut socket,
                        "400 Bad Request",
                        "application/json",
                        r#"{"error":{"message":"Unsupported parameter: stream_options"}}"#,
                    )
                    .await;
                } else {
                    assert!(body.get("stream_options").is_none());
                    write_response(
                        &mut socket,
                        "200 OK",
                        "text/event-stream",
                        "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n",
                    )
                    .await;
                }
            }
        });

        let provider = OpenAIProvider::new(
            "test-key".into(),
            "gpt-4.1".into(),
            Some(format!("http://{address}/v1/chat/completions")),
        );
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "hello")],
                vec![],
                8192,
                ChatOptions {
                    temperature: None,
                    enable_thinking: false,
                    reasoning_effort: Some("max".into()),
                },
            )
            .await
            .unwrap();
        let mut text = String::new();
        while let Some(chunk) = stream.next().await {
            if let StreamChunk::TextDelta(delta) = chunk.unwrap() {
                text.push_str(&delta);
            }
        }
        let mut second_stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "hello again")],
                vec![],
                8192,
                ChatOptions::default(),
            )
            .await
            .unwrap();
        while let Some(chunk) = second_stream.next().await {
            chunk.unwrap();
        }
        server.await.unwrap();
        assert_eq!(text, "ok");
    }

    #[tokio::test]
    async fn generic_invalid_parameter_falls_back_from_stream_options() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut socket).await;
                let request = String::from_utf8_lossy(&request);
                let body = request
                    .split_once("\r\n\r\n")
                    .unwrap()
                    .1;
                let body: Value = serde_json::from_str(body).unwrap();

                if attempt == 0 {
                    assert!(body.get("stream_options").is_some());
                    write_response(
                        &mut socket,
                        "400 Bad Request",
                        "application/json",
                        r#"{"error":{"code":"InvalidParameter","message":"A parameter specified in the request is not valid Request id: 021788703105809e1e6c18222198123b5b36a942a59f14aa8ab89","param":"","type":"BadRequest"}}"#,
                    )
                    .await;
                } else {
                    assert!(body.get("stream_options").is_none());
                    assert_eq!(body["temperature"], json!(CODING_TEMPERATURE));
                    write_response(
                        &mut socket,
                        "200 OK",
                        "text/event-stream",
                        "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n",
                    )
                    .await;
                }
            }
        });

        let provider = OpenAIProvider::new(
            "test-key".into(),
            "compatible-model".into(),
            Some(format!("http://{address}/v1/chat/completions")),
        );
        let mut stream = provider
            .chat_stream(
                None,
                vec![LlmMessage::text(LlmRole::User, "hello")],
                vec![],
                8192,
                ChatOptions::default(),
            )
            .await
            .unwrap();
        let mut text = String::new();
        while let Some(chunk) = stream.next().await {
            if let StreamChunk::TextDelta(delta) = chunk.unwrap() {
                text.push_str(&delta);
            }
        }

        server.await.unwrap();
        assert_eq!(text, "ok");
    }

    #[tokio::test]
    async fn malformed_streamed_tool_arguments_become_repairable_tool_errors() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            write_response(
                &mut socket,
                "200 OK",
                "text/event-stream",
                concat!(
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{broken\"}}]}}]}\n\n",
                    "data: [DONE]\n\n"
                ),
            )
            .await;
        });

        let provider = OpenAIProvider::new(
            "test-key".into(),
            "gpt-4.1".into(),
            Some(format!("http://{address}/v1/chat/completions")),
        );
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
    async fn streamed_tool_names_are_accumulated_across_deltas() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let _ = read_http_request(&mut socket).await;
            write_response(
                &mut socket,
                "200 OK",
                "text/event-stream",
                concat!(
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"write_\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n",
                    "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"file\",\"arguments\":\"\\\"notes.txt\\\"}\"}}]}}]}\n\n",
                    "data: [DONE]\n\n"
                ),
            )
            .await;
        });

        let provider = OpenAIProvider::new(
            "test-key".into(),
            "gpt-4.1".into(),
            Some(format!("http://{address}/v1/chat/completions")),
        );
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

        let StreamChunk::Completed { assistant, .. } = stream.next().await.unwrap().unwrap() else {
            panic!("expected completed tool call");
        };
        let ContentBlock::ToolUse {
            name,
            input,
            input_error,
            ..
        } = &assistant.content[0]
        else {
            panic!("expected tool call");
        };
        assert_eq!(name, "write_file");
        assert_eq!(input, &json!({ "path": "notes.txt" }));
        assert!(input_error.is_none());
        assert!(stream.next().await.is_none());
        server.await.unwrap();
    }

    #[test]
    fn image_response_parsers_keep_text_and_base64_images() {
        let responses = responses_message(&json!({
            "output": [{
                "type": "message",
                "content": [
                    { "type": "output_text", "text": "finished" },
                    { "type": "image_generation_call", "result": "aGVsbG8=", "mime_type": "image/webp" }
                ]
            }]
        }));
        assert!(matches!(
            &responses.content[0],
            ContentBlock::Text { text } if text == "finished"
        ));
        assert!(matches!(
            &responses.content[1],
            ContentBlock::ImageUrl { url } if url == "data:image/webp;base64,aGVsbG8="
        ));

        let chat = chat_image_message(&json!({
            "choices": [{
                "message": {
                    "multi_mod_content": [
                        { "text": "gemini" },
                        { "inline_data": { "mime_type": "image/png", "data": "aW1hZ2U=" } }
                    ]
                }
            }]
        }));
        assert!(matches!(
            &chat.content[1],
            ContentBlock::ImageUrl { url } if url == "data:image/png;base64,aW1hZ2U="
        ));
    }

    #[tokio::test]
    async fn image_preview_falls_back_to_non_streaming_multimodal_chat() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for attempt in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = read_http_request(&mut socket).await;
                let request = String::from_utf8_lossy(&request);
                let (head, body) = request.split_once("\r\n\r\n").unwrap();
                let body: Value = serde_json::from_str(body).unwrap();
                match attempt {
                    0 => {
                        assert!(head.starts_with("POST /v1/responses HTTP/1.1"));
                        assert_eq!(body["stream"], false);
                        assert_eq!(body["tools"][0]["type"], "image_generation");
                        write_response(
                            &mut socket,
                            "404 Not Found",
                            "application/json",
                            r#"{"error":{"message":"endpoint not found"}}"#,
                        )
                        .await;
                    }
                    1 => {
                        assert!(head.starts_with("POST /v1/images/generations HTTP/1.1"));
                        assert_eq!(body["prompt"], "draw a skyline");
                        write_response(
                            &mut socket,
                            "404 Not Found",
                            "application/json",
                            r#"{"error":{"message":"endpoint not found"}}"#,
                        )
                        .await;
                    }
                    _ => {
                        assert!(head.starts_with("POST /v1/chat/completions HTTP/1.1"));
                        assert_eq!(body["stream"], false);
                        assert_eq!(body["modalities"], json!(["text", "image"]));
                        write_response(
                            &mut socket,
                            "200 OK",
                            "application/json",
                            r#"{"choices":[{"message":{"role":"assistant","multi_mod_content":[{"text":"done"},{"inline_data":{"mime_type":"image/png","data":"aGVsbG8="}}]}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}"#,
                        )
                        .await;
                    }
                }
            }
        });

        let provider = OpenAIProvider::new(
            "test-key".into(),
            "gemini-2.5-flash-image-preview".into(),
            Some(format!("http://{address}/v1")),
        );
        let mut stream = provider
            .chat_stream(
                Some("draw safely"),
                vec![LlmMessage::text(LlmRole::User, "draw a skyline")],
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
            panic!("expected one completed image response");
        };
        assert!(matches!(
            &assistant.content[0],
            ContentBlock::Text { text } if text == "done"
        ));
        assert!(matches!(
            &assistant.content[1],
            ContentBlock::ImageUrl { url } if url == "data:image/png;base64,aGVsbG8="
        ));
        assert_eq!(usage.input_tokens, 7);
        assert_eq!(usage.output_tokens, 3);
        assert!(stream.next().await.is_none());
        server.await.unwrap();
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
        _max_tokens: u32,
        options: ChatOptions,
    ) -> Result<ChunkStream> {
        if is_image_output_model(&self.model, self.image_generation) {
            let (assistant, usage) = self.image_response_completion(system, &messages).await?;
            return Ok(Box::pin(futures::stream::iter([Ok(
                StreamChunk::Completed {
                    stop_reason: "stop".into(),
                    assistant,
                    usage,
                },
            )])));
        }
        let body = self.request_body(system, &messages, &tools, &options);
        let url = crate::urls::chat_completions_url(&self.base_url)?;
        let resp = self.send_compatible_request(url, body).await?;

        // 累积状态：content 文本 + 按 index 的 tool_calls 参数分片。
        struct StreamState {
            bytes: crate::http::ByteStream,
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
                let mut tool_blocks = Vec::new();
                for (index, (id, name, args)) in std::mem::take(&mut self.tool_calls)
                    .into_values()
                    .enumerate()
                {
                    // Some OpenAI-compatible gateways stream tool calls
                    // without an id. The next request would reject an
                    // assistant.tool_calls entry with an empty id.
                    let id = if id.trim().is_empty() {
                        format!("call_{}_{}", index, uuid::Uuid::new_v4().simple())
                    } else {
                        id
                    };
                    let (input, raw_input, input_error) =
                        match crate::tool_input::parse_tool_input("openai", &name, &args) {
                            Ok(input) => (input, None, None),
                            Err(error) => {
                                (json!({ "_raw": args }), Some(args), Some(error.to_string()))
                            }
                        };
                    tool_blocks.push(ContentBlock::ToolUse {
                        id,
                        name,
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
                let payload = match serde_json::from_str::<Value>(&ev.data) {
                    Ok(payload) => payload,
                    Err(error) => {
                        self.queue.push_back(Err(anyhow::anyhow!(
                            "openai stream event contains invalid JSON: {error}"
                        )));
                        self.finished = true;
                        return;
                    }
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
                if let Some(thinking) = delta["reasoning_content"].as_str() {
                    if !thinking.is_empty() {
                        self.queue
                            .push_back(Ok(StreamChunk::ThinkingDelta(thinking.to_string())));
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
                            entry.1.push_str(name);
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
                match crate::http::next_stream_chunk("openai", &mut st.bytes).await {
                    Err(error) => {
                        st.finished = true;
                        return Some((Err(error), st));
                    }
                    Ok(None) => {
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
                            st.finished = true;
                            return Some((
                                Err(anyhow::anyhow!("openai stream is not valid UTF-8: {error}")),
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
