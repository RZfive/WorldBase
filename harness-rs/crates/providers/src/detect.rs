//! 协议自动探测：用最简消息 `hi` 逐个尝试所有 chat 协议，第一个成功者
//! 即为检测结果。顺序 Responses → Chat Completions → Anthropic，使 OpenAI
//! 官方端点优先命中更新的 Responses 协议。

use crate::api_protocol::ApiProtocol;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

/// The entire probe message: nothing else is sent to the model.
const PROBE_MESSAGE: &str = "hi";
/// Anthropic Messages requires max_tokens; keep the probe reply minimal.
const PROBE_MAX_TOKENS: u32 = 16;
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// 单个协议的探测结果（error 为 None 表示成功）。
pub struct ProtocolProbe {
    pub protocol: ApiProtocol,
    pub error: Option<String>,
}

/// 探测总结果：detected 为 None 表示全部协议失败（保留逐项错误供 UI 展示）。
pub struct DetectProtocolResult {
    pub detected: Option<ApiProtocol>,
    pub probes: Vec<ProtocolProbe>,
}

pub async fn detect_protocol(base_url: &str, api_key: &str, model: &str) -> DetectProtocolResult {
    let order = [
        ApiProtocol::OpenAiResponses,
        ApiProtocol::OpenAiChat,
        ApiProtocol::Anthropic,
    ];
    let mut probes = Vec::new();
    for protocol in order {
        match probe_protocol(protocol, base_url, api_key, model).await {
            Ok(()) => {
                probes.push(ProtocolProbe {
                    protocol,
                    error: None,
                });
                return DetectProtocolResult {
                    detected: Some(protocol),
                    probes,
                };
            }
            Err(error) => probes.push(ProtocolProbe {
                protocol,
                error: Some(error.to_string()),
            }),
        }
    }
    DetectProtocolResult {
        detected: None,
        probes,
    }
}

async fn probe_protocol(
    protocol: ApiProtocol,
    base_url: &str,
    api_key: &str,
    model: &str,
) -> Result<()> {
    let base_url = base_url.trim();
    let api_key = api_key.trim();
    let model = model.trim();
    if base_url.is_empty() {
        bail!("base URL is required");
    }
    if api_key.is_empty() {
        bail!("API key is required");
    }
    if model.is_empty() {
        bail!("a model id is required to probe the chat protocol");
    }

    let (url, body) = match protocol {
        ApiProtocol::OpenAiResponses => (
            crate::urls::responses_url(base_url)?,
            json!({ "model": model, "input": PROBE_MESSAGE }),
        ),
        ApiProtocol::OpenAiChat => (
            crate::urls::chat_completions_url(base_url)?,
            json!({ "model": model, "messages": [{ "role": "user", "content": PROBE_MESSAGE }] }),
        ),
        ApiProtocol::Anthropic => (
            crate::urls::anthropic_messages_url(base_url, crate::anthropic::DEFAULT_BASE_URL)?,
            json!({
                "model": model,
                "messages": [{ "role": "user", "content": PROBE_MESSAGE }],
                "max_tokens": PROBE_MAX_TOKENS,
            }),
        ),
    };

    let client = crate::http::client();
    // A probe is a single best-effort attempt: no retry loop, so a dead
    // endpoint costs at most one timeout instead of three retries × three
    // protocols.
    let mut request = client.post(url).timeout(PROBE_TIMEOUT).json(&body);
    request = match protocol {
        ApiProtocol::Anthropic => request
            .header("x-api-key", api_key)
            .header("anthropic-version", crate::anthropic::API_VERSION),
        ApiProtocol::OpenAiChat | ApiProtocol::OpenAiResponses => request.bearer_auth(api_key),
    };
    let response = request.send().await.context("probe request failed")?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        let detail = crate::remote_models::response_error_message(&text);
        if detail.is_empty() {
            bail!("HTTP {status}");
        }
        bail!("HTTP {status}: {detail}");
    }
    if !probe_response_matches(protocol, &text) {
        bail!("endpoint returned 200 but the response shape does not match this protocol");
    }
    Ok(())
}

/// 成功判定必须校验响应形状：部分网关对任意路径都回 200 + HTML 登录页，
/// 只看状态码会产生假阳性。
fn probe_response_matches(protocol: ApiProtocol, body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    match protocol {
        ApiProtocol::OpenAiResponses => {
            value.get("id").is_some() && value.get("output").and_then(Value::as_array).is_some()
        }
        ApiProtocol::OpenAiChat => value.get("choices").and_then(Value::as_array).is_some(),
        ApiProtocol::Anthropic => value.get("content").and_then(Value::as_array).is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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

    async fn write_response(socket: &mut tokio::net::TcpStream, status: &str, body: &'static str) {
        socket
            .write_all(
                format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn prefers_responses_and_sends_only_hi() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let (head, body) = read_http_request(&mut socket).await;
            assert!(head.starts_with("POST /v1/responses HTTP/1.1"));
            assert!(head
                .to_lowercase()
                .contains("authorization: bearer probe-key"));
            let payload: Value = serde_json::from_str(&body).unwrap();
            assert_eq!(payload["input"], "hi");
            assert_eq!(payload["model"], "gpt-test");
            // The probe body stays minimal — nothing beyond model + "hi".
            assert_eq!(payload.as_object().unwrap().len(), 2);
            write_response(
                &mut socket,
                "200 OK",
                r#"{"id":"resp_1","output":[{"type":"message","content":[]}]}"#,
            )
            .await;
        });

        let result =
            detect_protocol(&format!("http://{address}/v1"), "probe-key", "gpt-test").await;
        server.await.unwrap();
        assert_eq!(result.detected, Some(ApiProtocol::OpenAiResponses));
        assert_eq!(
            result.probes.len(),
            1,
            "later protocols are not probed after a hit"
        );
        assert!(result.probes[0].error.is_none());
    }

    #[tokio::test]
    async fn falls_through_to_anthropic_with_minimal_bodies() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut seen: Vec<(String, Value)> = Vec::new();
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let (head, body) = read_http_request(&mut socket).await;
                let path = head.split_whitespace().nth(1).unwrap().to_string();
                let payload: Value = serde_json::from_str(&body).unwrap();
                seen.push((path, payload));
                if head.starts_with("POST /v1/messages") {
                    assert!(head.to_lowercase().contains("x-api-key: probe-key"));
                    assert!(head
                        .to_lowercase()
                        .contains("anthropic-version: 2023-06-01"));
                    write_response(
                        &mut socket,
                        "200 OK",
                        r#"{"id":"msg_1","content":[{"type":"text","text":"Hello"}]}"#,
                    )
                    .await;
                } else {
                    write_response(
                        &mut socket,
                        "404 Not Found",
                        r#"{"error":{"message":"no such endpoint"}}"#,
                    )
                    .await;
                }
            }
            seen
        });

        let result =
            detect_protocol(&format!("http://{address}/v1"), "probe-key", "claude-test").await;
        let seen = server.await.unwrap();
        assert_eq!(result.detected, Some(ApiProtocol::Anthropic));
        assert_eq!(result.probes.len(), 3);
        assert!(result.probes[0].error.as_deref().unwrap().contains("404"));
        assert!(result.probes[1].error.as_deref().unwrap().contains("404"));
        assert!(result.probes[2].error.is_none());

        // Probe order and per-protocol minimal bodies.
        assert_eq!(seen[0].0, "/v1/responses");
        assert_eq!(seen[0].1["input"], "hi");
        assert_eq!(seen[1].0, "/v1/chat/completions");
        assert_eq!(seen[1].1["messages"][0]["content"], "hi");
        assert_eq!(seen[1].1.as_object().unwrap().len(), 2);
        assert_eq!(seen[2].0, "/v1/messages");
        assert_eq!(seen[2].1["messages"][0]["content"], "hi");
        assert_eq!(seen[2].1["max_tokens"], 16);
        assert_eq!(seen[2].1.as_object().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn http_200_with_wrong_shape_counts_as_failure() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let _ = read_http_request(&mut socket).await;
                // A gateway answering 200 with an HTML login page must not be
                // mistaken for a working chat protocol.
                write_response(&mut socket, "200 OK", r#"{"html":"<login/>"}"#).await;
            }
        });

        let result =
            detect_protocol(&format!("http://{address}/v1"), "probe-key", "any-model").await;
        server.await.unwrap();
        assert_eq!(result.detected, None);
        assert_eq!(result.probes.len(), 3);
        assert!(result.probes.iter().all(|probe| probe.error.is_some()));
    }

    #[test]
    fn shape_validation_covers_each_protocol() {
        assert!(probe_response_matches(
            ApiProtocol::OpenAiResponses,
            r#"{"id":"resp_1","output":[]}"#
        ));
        assert!(!probe_response_matches(
            ApiProtocol::OpenAiResponses,
            r#"{"id":"resp_1"}"#
        ));
        assert!(probe_response_matches(
            ApiProtocol::OpenAiChat,
            r#"{"choices":[{"message":{"content":"hi there"}}]}"#
        ));
        assert!(!probe_response_matches(
            ApiProtocol::OpenAiChat,
            "<html>login</html>"
        ));
        assert!(probe_response_matches(
            ApiProtocol::Anthropic,
            r#"{"content":[{"type":"text","text":"Hello"}]}"#
        ));
        assert!(!probe_response_matches(
            ApiProtocol::Anthropic,
            r#"{"choices":[]}"#
        ));
    }
}
