//! 网络工具：web_search（DuckDuckGo Lite 抓取）与 web_fetch（URL 抓取）。

use super::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use serde_json::{json, Value};

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
}
