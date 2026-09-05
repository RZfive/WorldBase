//! 网络工具：web_search（DuckDuckGo Lite 抓取）与 web_fetch（URL 抓取）。

use super::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::net::IpAddr;

const MAX_FETCH_URLS: usize = 5;
const DEFAULT_FETCH_MAX_CHARS: usize = 12_000;
const ABSOLUTE_FETCH_MAX_CHARS: usize = 40_000;
const DEFAULT_FETCH_TIMEOUT_MS: u64 = 10_000;
const MAX_FETCH_TIMEOUT_MS: u64 = 30_000;
const MAX_FETCH_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

/// 剥离 HTML 标签为纯文本（足够 LLM 阅读的最小处理）。
pub fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut depth = 0usize;
    let mut in_script = false;
    let chars: Vec<char> = html.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '<' {
            let rest: String = chars[i..].iter().take(12).collect();
            if rest.to_lowercase().starts_with("<script") {
                in_script = true;
            }
            if rest.to_lowercase().starts_with("</script") {
                in_script = false;
            }
            depth += 1;
            i += 1;
            continue;
        }
        if chars[i] == '>' && depth > 0 {
            depth = depth.saturating_sub(1);
            if depth == 0 && !in_script {
                out.push(' ');
            }
            i += 1;
            continue;
        }
        if depth == 0 && !in_script {
            out.push(chars[i]);
        }
        i += 1;
    }
    // 折叠空白
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub struct WebSearchTool;

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "web_search"
    }
    fn description(&self) -> &str {
        "搜索网页并返回结果列表（标题/链接/摘要）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "query": { "type": "string" } },
            "required": ["query"]
        })
    }
    async fn execute(&self, input: Value, _services: &ToolServices) -> Result<Value> {
        let query = require_str(&input, "query")?;
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (compatible; WorldBaseHarness/1.0)")
            .build()?;
        let resp = client
            .post("https://lite.duckduckgo.com/lite/")
            .form(&[("q", query)])
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await?;
        let html = resp.text().await?;

        // 解析 lite 版结果：<a rel="nofollow" href="URL">TITLE</a>
        let mut results = Vec::new();
        let mut rest = html.as_str();
        while results.len() < 8 {
            let Some(start) = rest.find("<a rel=\"nofollow\" href=\"") else {
                break;
            };
            let after = &rest[start + "<a rel=\"nofollow\" href=\"".len()..];
            let Some(url_end) = after.find('"') else {
                break;
            };
            let url = &after[..url_end];
            let after_url = &after[url_end + 1..];
            let Some(title_start) = after_url.find('>') else {
                break;
            };
            let after_title = &after_url[title_start + 1..];
            let Some(title_end) = after_title.find("</a>") else {
                break;
            };
            let title = strip_html(&after_title[..title_end]);
            if url.starts_with("http") && !title.is_empty() {
                results.push(json!({ "title": title, "url": url }));
            }
            rest = &after_title[title_end + 4..];
        }

        if results.is_empty() {
            return Ok(
                json!({ "results": [], "note": "搜索无结果或被限流，可改用 web_fetch 抓取已知 URL" }),
            );
        }
        Ok(json!({ "results": results }))
    }
}

pub struct WebFetchTool;

#[async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> &str {
        "web_fetch"
    }
    fn description(&self) -> &str {
        "抓取 URL 内容并转为纯文本（HTML 自动去标签）"
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "url": { "type": "string" } },
            "required": ["url"]
        })
    }
    async fn execute(&self, input: Value, _services: &ToolServices) -> Result<Value> {
        let url = require_str(&input, "url")?;
        anyhow::ensure!(
            url.starts_with("http://") || url.starts_with("https://"),
            "only http(s) supported"
        );
        let client = reqwest::Client::builder()
            .user_agent("Mozilla/5.0 (compatible; WorldBaseHarness/1.0)")
            .build()?;
        let resp = client
            .get(url)
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .await?;
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let body = resp.text().await?;
        let text = if content_type.contains("html") {
            strip_html(&body)
        } else {
            body
        };
        let text: String = text.chars().take(50_000).collect();
        Ok(json!({ "url": url, "content_type": content_type, "text": text }))
    }
}

/// Electron-compatible batched webpage fetcher. This is intentionally a
/// separate tool instead of an alias to `web_fetch`: the public Electron
/// contract accepts `urls[]` and returns one independent result per URL.
pub struct FetchWebpageTool;

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.octets()[0] == 0
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

async fn validate_public_target(url: &reqwest::Url) -> Result<()> {
    anyhow::ensure!(
        matches!(url.scheme(), "http" | "https"),
        "Only http and https URLs are allowed"
    );
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("URL has no host"))?;
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    anyhow::ensure!(
        normalized != "localhost" && !normalized.ends_with(".localhost"),
        "Blocked target host"
    );
    if let Ok(ip) = normalized.parse::<IpAddr>() {
        anyhow::ensure!(!is_private_ip(ip), "Blocked target host");
        return Ok(());
    }

    let port = url.port_or_known_default().unwrap_or(80);
    let addresses = tokio::net::lookup_host((normalized.as_str(), port)).await?;
    for address in addresses {
        anyhow::ensure!(!is_private_ip(address.ip()), "Blocked target host");
    }
    Ok(())
}

fn char_count(value: &str) -> usize {
    value.chars().count()
}

fn truncate_chars(value: &str, limit: usize) -> (String, bool) {
    if char_count(value) <= limit {
        return (value.to_string(), false);
    }
    let mut text = value.chars().take(limit).collect::<String>();
    text.push_str("\n\n...[truncated]...");
    (text, true)
}

fn query_terms(query: Option<&str>) -> Vec<String> {
    let Some(query) = query.map(str::trim).filter(|query| !query.is_empty()) else {
        return Vec::new();
    };
    let lower = query.to_lowercase();
    if lower
        .chars()
        .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
        && !lower.chars().any(char::is_whitespace)
    {
        return vec![lower];
    }
    let mut terms = Vec::new();
    for term in lower
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| term.chars().count() >= 2)
    {
        if !terms.iter().any(|known| known == term) {
            terms.push(term.to_string());
        }
        if terms.len() == 8 {
            break;
        }
    }
    terms
}

fn format_fetched_content(
    source: &str,
    max_chars: usize,
    query: Option<&str>,
) -> (String, bool, &'static str, Vec<String>) {
    let terms = query_terms(query);
    let mut snippets = Vec::new();
    if !terms.is_empty() {
        for block in source
            .split(['\n', '.', '。', '!', '！', '?', '？'])
            .map(str::trim)
            .filter(|block| !block.is_empty())
        {
            let lower = block.to_lowercase();
            if terms.iter().any(|term| lower.contains(term)) {
                let (snippet, _) = truncate_chars(block, 500);
                if !snippets.contains(&snippet) {
                    snippets.push(snippet);
                }
            }
            if snippets.len() == 5 {
                break;
            }
        }
    }
    if !snippets.is_empty() {
        let merged = snippets.join("\n\n---\n\n");
        let (content, truncated) = truncate_chars(&merged, max_chars);
        return (content, truncated, "query_snippets", snippets);
    }
    let (content, truncated) = truncate_chars(source, max_chars);
    (content, truncated, "leading_text", Vec::new())
}

fn extract_html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let content_start = start + lower[start..].find('>')? + 1;
    let end = content_start + lower[content_start..].find("</title>")?;
    let title = strip_html(&html[content_start..end]);
    (!title.is_empty()).then_some(title)
}

async fn response_body_limited(response: &mut reqwest::Response) -> Result<Vec<u8>> {
    if let Some(content_length) = response.content_length() {
        anyhow::ensure!(
            content_length <= MAX_FETCH_RESPONSE_BYTES as u64,
            "Response too large: {content_length} bytes (max {MAX_FETCH_RESPONSE_BYTES})"
        );
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        anyhow::ensure!(
            body.len().saturating_add(chunk.len()) <= MAX_FETCH_RESPONSE_BYTES,
            "Response body exceeded {MAX_FETCH_RESPONSE_BYTES} bytes"
        );
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn fetch_public_webpage(
    client: &reqwest::Client,
    raw_url: &str,
    query: Option<&str>,
    max_chars: usize,
    timeout_ms: u64,
) -> Value {
    let fetched_at = worldbase_protocol::event::now_rfc3339();
    let failure = |error: String| {
        json!({
            "url": raw_url,
            "ok": false,
            "content": "",
            "truncated": false,
            "fetched_at": fetched_at,
            "error": error,
        })
    };
    let mut current = match reqwest::Url::parse(raw_url) {
        Ok(url) => url,
        Err(_) => return failure("Invalid URL".into()),
    };

    for redirect_count in 0..=MAX_REDIRECTS {
        if let Err(error) = validate_public_target(&current).await {
            return failure(error.to_string());
        }
        let request = client
            .get(current.clone())
            .header(
                reqwest::header::ACCEPT,
                "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,text/*;q=0.8,*/*;q=0.2",
            )
            .header(
                reqwest::header::ACCEPT_LANGUAGE,
                if query.is_some_and(|value| {
                    value
                        .chars()
                        .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
                }) {
                    "zh-CN,zh;q=0.9,en;q=0.7"
                } else {
                    "en-US,en;q=0.9"
                },
            );
        let mut response = match tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            request.send(),
        )
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => return failure(error.to_string()),
            Err(_) => return failure(format!("request timed out after {timeout_ms}ms")),
        };

        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return failure("Too many redirects".into());
            }
            let Some(location) = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
            else {
                return failure("Redirect response did not include a Location header".into());
            };
            current = match current.join(location) {
                Ok(url) => url,
                Err(error) => return failure(format!("Invalid redirect URL: {error}")),
            };
            continue;
        }

        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let body = match response_body_limited(&mut response).await {
            Ok(body) => body,
            Err(error) => return failure(error.to_string()),
        };
        let response_text = String::from_utf8_lossy(&body).into_owned();
        let (title, source_text) = if content_type.contains("html") || content_type.contains("xml")
        {
            (
                extract_html_title(&response_text),
                strip_html(&response_text),
            )
        } else if content_type.contains("json") {
            let pretty = serde_json::from_str::<Value>(&response_text)
                .ok()
                .and_then(|value| serde_json::to_string_pretty(&value).ok())
                .unwrap_or(response_text);
            (None, pretty)
        } else if content_type.contains("text") || content_type.is_empty() {
            (None, response_text)
        } else {
            return json!({
                "url": raw_url,
                "final_url": current.as_str(),
                "ok": false,
                "status": status.as_u16(),
                "status_text": status.canonical_reason().unwrap_or_default(),
                "content_type": content_type,
                "content": "",
                "truncated": false,
                "fetched_at": fetched_at,
                "error": format!("Unsupported content type: {content_type}"),
            });
        };
        let (content, truncated, strategy, snippets) =
            format_fetched_content(&source_text, max_chars, query);
        return json!({
            "url": raw_url,
            "final_url": current.as_str(),
            "ok": status.is_success(),
            "status": status.as_u16(),
            "status_text": status.canonical_reason().unwrap_or_default(),
            "content_type": if content_type.is_empty() { Value::Null } else { json!(content_type) },
            "title": title,
            "content": content,
            "excerpt_strategy": strategy,
            "query_snippets": if snippets.is_empty() { Value::Null } else { json!(snippets) },
            "query_match_count": if snippets.is_empty() { Value::Null } else { json!(snippets.len()) },
            "truncated": truncated,
            "fetched_at": fetched_at,
            "error": if status.is_success() {
                Value::Null
            } else {
                json!(format!("HTTP {} {}", status.as_u16(), status.canonical_reason().unwrap_or_default()))
            },
        });
    }
    failure("Too many redirects".into())
}

#[async_trait]
impl Tool for FetchWebpageTool {
    fn name(&self) -> &str {
        "fetch_webpage"
    }

    fn description(&self) -> &str {
        "Fetch public webpages in a bounded batch."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "urls": { "type": "array", "items": { "type": "string" } },
                "query": { "type": "string" },
                "max_chars": { "type": "integer" },
                "timeout_ms": { "type": "integer" }
            },
            "required": ["urls"]
        })
    }

    async fn execute(&self, input: Value, _services: &ToolServices) -> Result<Value> {
        let query = input
            .get("query")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let max_chars = input
            .get("max_chars")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_FETCH_MAX_CHARS as u64)
            .clamp(500, ABSOLUTE_FETCH_MAX_CHARS as u64) as usize;
        let timeout_ms = input
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_FETCH_TIMEOUT_MS)
            .clamp(1_000, MAX_FETCH_TIMEOUT_MS);
        let mut urls = input
            .get("urls")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .take(MAX_FETCH_URLS)
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        // Retain compatibility with persisted pre-migration Rust calls.
        if urls.is_empty() {
            if let Some(url) = input
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                urls.push(url.to_string());
            }
        }
        if urls.is_empty() {
            let result = json!({
                "url": "",
                "ok": false,
                "content": "",
                "truncated": false,
                "fetched_at": worldbase_protocol::event::now_rfc3339(),
                "error": "At least one URL is required",
            });
            return Ok(json!({
                "query": query,
                "results": [result],
                "success_count": 0,
                "failure_count": 1,
            }));
        }

        let client = reqwest::Client::builder()
            .user_agent("WorldBase AI Agent/1.0")
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let mut results = Vec::with_capacity(urls.len());
        for url in urls {
            results.push(fetch_public_webpage(&client, &url, query, max_chars, timeout_ms).await);
        }
        let success_count = results
            .iter()
            .filter(|result| result.get("ok").and_then(Value::as_bool) == Some(true))
            .count();
        Ok(json!({
            "query": query,
            "failure_count": results.len().saturating_sub(success_count),
            "success_count": success_count,
            "results": results,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_html() {
        let html = r#"<html><head><style>x{}</style></head><body><h1>标题</h1><p>正文 <b>加粗</b></p></body></html>"#;
        let text = strip_html(html);
        assert!(text.contains("标题"));
        assert!(text.contains("正文 加粗"));
        assert!(!text.contains('<'));
    }

    #[test]
    fn private_address_detection_covers_loopback_and_lan_ranges() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.1.1",
            "192.168.1.1",
            "::1",
            "fd00::1",
            "fe80::1",
        ] {
            assert!(is_private_ip(address.parse().unwrap()), "{address}");
        }
        assert!(!is_private_ip("8.8.8.8".parse().unwrap()));
        assert!(!is_private_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn query_excerpt_prefers_matching_snippets() {
        let (content, _, strategy, snippets) = format_fetched_content(
            "First unrelated sentence. Rust harness parameters are documented here. Last unrelated sentence.",
            12_000,
            Some("Rust parameters"),
        );
        assert_eq!(strategy, "query_snippets");
        assert_eq!(snippets.len(), 1);
        assert!(content.contains("Rust harness parameters"));
    }
}
