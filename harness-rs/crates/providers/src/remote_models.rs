//! Remote model catalog discovery for OpenAI-compatible and Anthropic APIs.

use crate::api_protocol::ApiProtocol;
use anyhow::{bail, Context, Result};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde_json::Value;
use std::collections::BTreeSet;
use std::time::Duration;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub async fn fetch_remote_models(
    base_url: &str,
    api_key: &str,
    api_protocol: &str,
) -> Result<Vec<String>> {
    let base_url = base_url.trim();
    let api_key = api_key.trim();
    if base_url.is_empty() {
        bail!("base URL is required");
    }
    if api_key.is_empty() {
        bail!("API key is required");
    }

    let protocol = resolve_remote_protocol(api_protocol);
    let endpoint = remote_models_url(base_url, protocol)?;
    let mut headers = HeaderMap::new();
    if protocol == ApiProtocol::Anthropic {
        headers.insert(
            "x-api-key",
            HeaderValue::from_str(api_key).context("invalid API key")?,
        );
        headers.insert(
            "anthropic-version",
            HeaderValue::from_static(ANTHROPIC_VERSION),
        );
    } else {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {api_key}")).context("invalid API key")?,
        );
    }

    let client = crate::http::client();
    let response =
        crate::http::send_with_retry_timeout("provider model catalog", REQUEST_TIMEOUT, || {
            client
                .get(endpoint.clone())
                .headers(headers.clone())
                .timeout(REQUEST_TIMEOUT)
        })
        .await
        .context("failed to fetch provider models")?;
    let status = response.status();
    let body = response
        .text()
        .await
        .context("failed to read provider model response")?;
    if !status.is_success() {
        let detail = response_error_message(&body);
        if detail.is_empty() {
            bail!("provider model request failed with HTTP {status}");
        }
        bail!("provider model request failed with HTTP {status}: {detail}");
    }

    let payload: Value = serde_json::from_str(&body).context("provider returned invalid JSON")?;
    let models = parse_remote_models(&payload);
    if models.is_empty() {
        bail!("provider returned no models");
    }
    Ok(models)
}

/// 归一化存储的 apiProtocol：两个 OpenAI 协议共用 Bearer 鉴权的 /models，
/// 不做 base URL 猜测（自动探测在 detect.rs 完成后才落库）。
fn resolve_remote_protocol(explicit: &str) -> ApiProtocol {
    ApiProtocol::from_stored(explicit)
}

fn remote_models_url(base_url: &str, protocol: ApiProtocol) -> Result<String> {
    let mut url = reqwest::Url::parse(base_url).context("invalid base URL")?;
    if url.scheme() != "http" && url.scheme() != "https" {
        bail!("base URL must use http or https");
    }

    let path = url.path().trim_end_matches('/');
    let models_path = if protocol == ApiProtocol::Anthropic && !path.ends_with("/v1") {
        format!("{path}/v1/models")
    } else {
        format!("{path}/models")
    };
    url.set_path(&models_path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

fn parse_remote_models(payload: &Value) -> Vec<String> {
    let entries = payload
        .get("data")
        .or_else(|| payload.get("models"))
        .and_then(Value::as_array);
    let mut models = BTreeSet::new();
    for entry in entries.into_iter().flatten() {
        let id = entry
            .as_str()
            .or_else(|| entry.get("id").and_then(Value::as_str))
            .map(str::trim)
            .unwrap_or_default();
        if !id.is_empty() {
            models.insert(id.to_string());
        }
    }
    models.into_iter().collect()
}

pub(crate) fn response_error_message(body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
        })
        .unwrap_or(body)
        .trim();
    message.chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn serve_once(
        body: &'static str,
        status: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0u8; 8192];
            let size = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..size]).into_owned();
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            request
        });
        (format!("http://{address}"), server)
    }

    #[tokio::test]
    async fn fetches_openai_models_with_bearer_auth_and_normalizes_results() {
        let (base_url, server) = serve_once(
            r#"{"data":[{"id":"z-model"},{"id":"a-model"},{"id":"a-model"},{"id":" "}]}"#,
            "200 OK",
        )
        .await;
        let models = fetch_remote_models(&format!("{base_url}/v1"), "secret", "openai")
            .await
            .unwrap();
        let request = server.await.unwrap();

        assert!(request.starts_with("GET /v1/models HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer secret"));
        assert_eq!(models, vec!["a-model", "z-model"]);
    }

    #[tokio::test]
    async fn fetches_anthropic_models_without_duplicating_v1() {
        let (base_url, server) = serve_once(
            r#"{"data":[{"type":"model","id":"claude-sonnet"}]}"#,
            "200 OK",
        )
        .await;
        let models =
            fetch_remote_models(&format!("{base_url}/v1"), "anthropic-secret", "anthropic")
                .await
                .unwrap();
        let request = server.await.unwrap().to_ascii_lowercase();

        assert!(request.starts_with("get /v1/models http/1.1"));
        assert!(request.contains("x-api-key: anthropic-secret"));
        assert!(request.contains("anthropic-version: 2023-06-01"));
        assert_eq!(models, vec!["claude-sonnet"]);
    }

    #[tokio::test]
    async fn openai_responses_protocol_uses_bearer_model_catalog() {
        let (base_url, server) = serve_once(r#"{"data":[{"id":"gpt-5.1"}]}"#, "200 OK").await;
        let models = fetch_remote_models(&format!("{base_url}/v1"), "secret", "openai-responses")
            .await
            .unwrap();
        let request = server.await.unwrap();

        assert!(request.starts_with("GET /v1/models HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer secret"));
        assert_eq!(models, vec!["gpt-5.1"]);
    }

    #[tokio::test]
    async fn includes_provider_error_message() {
        let (base_url, server) = serve_once(
            r#"{"error":{"message":"invalid credentials"}}"#,
            "401 Unauthorized",
        )
        .await;
        let error = fetch_remote_models(&base_url, "bad-key", "openai")
            .await
            .unwrap_err()
            .to_string();
        server.await.unwrap();

        assert!(error.contains("401 Unauthorized"));
        assert!(error.contains("invalid credentials"));
        assert!(!error.contains("bad-key"));
    }
}
