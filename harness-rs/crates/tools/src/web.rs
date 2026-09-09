//! 网络工具：web_search（Bing、DuckDuckGo 与 GitHub）与 web_fetch（URL 抓取）。

use super::{require_str, Tool, ToolServices};
use anyhow::Result;
use async_trait::async_trait;
use futures::future::join_all;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::OnceLock;

const MAX_FETCH_URLS: usize = 5;
const DEFAULT_FETCH_MAX_CHARS: usize = 12_000;
const ABSOLUTE_FETCH_MAX_CHARS: usize = 40_000;
const DEFAULT_FETCH_TIMEOUT_MS: u64 = 10_000;
const MAX_FETCH_TIMEOUT_MS: u64 = 30_000;
const MAX_FETCH_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const DEFAULT_SEARCH_LIMIT: usize = 6;
const MAX_SEARCH_LIMIT: usize = 10;
const MAX_AUTO_FETCH: usize = 5;
const SEARCH_CANDIDATE_FACTOR: usize = 3;
const BING_SEARCH_ENDPOINT: &str = "https://www.bing.com/search";
const DUCKDUCKGO_SEARCH_ENDPOINT: &str = "https://html.duckduckgo.com/html/";
const GITHUB_REPOSITORY_SEARCH_ENDPOINT: &str = "https://api.github.com/search/repositories";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct SearchLocaleProfile {
    bing_language: &'static str,
    bing_country: &'static str,
    duckduckgo_region: &'static str,
    accept_language: &'static str,
}

const DEFAULT_SEARCH_LOCALE: SearchLocaleProfile = SearchLocaleProfile {
    bing_language: "en-US",
    bing_country: "us",
    duckduckgo_region: "us-en",
    accept_language: "en-US,en;q=0.9",
};

fn detect_search_locale(query: &str) -> SearchLocaleProfile {
    let sample = query.trim();
    if sample
        .chars()
        .any(|character| ('\u{4e00}'..='\u{9fff}').contains(&character))
    {
        return SearchLocaleProfile {
            bing_language: "zh-CN",
            bing_country: "cn",
            duckduckgo_region: "cn-zh",
            accept_language: "zh-CN,zh;q=0.9,en;q=0.7",
        };
    }
    if sample
        .chars()
        .any(|character| ('\u{3040}'..='\u{30ff}').contains(&character))
    {
        return SearchLocaleProfile {
            bing_language: "ja-JP",
            bing_country: "jp",
            duckduckgo_region: "jp-jp",
            accept_language: "ja-JP,ja;q=0.9,en;q=0.7",
        };
    }
    if sample
        .chars()
        .any(|character| ('\u{ac00}'..='\u{d7af}').contains(&character))
    {
        return SearchLocaleProfile {
            bing_language: "ko-KR",
            bing_country: "kr",
            duckduckgo_region: "kr-kr",
            accept_language: "ko-KR,ko;q=0.9,en;q=0.7",
        };
    }
    if sample
        .to_lowercase()
        .chars()
        .any(|character| ('\u{0430}'..='\u{044f}').contains(&character) || character == '\u{0451}')
    {
        return SearchLocaleProfile {
            bing_language: "ru-RU",
            bing_country: "ru",
            duckduckgo_region: "ru-ru",
            accept_language: "ru-RU,ru;q=0.9,en;q=0.7",
        };
    }
    DEFAULT_SEARCH_LOCALE
}

/// 剥离 HTML 标签为纯文本（足够 LLM 阅读的最小处理）。
pub fn strip_html(html: &str) -> String {
    let chars = html.chars().collect::<Vec<_>>();
    let mut out = String::with_capacity(html.len());
    let mut hidden_tag: Option<&'static str> = None;
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '<' {
            if hidden_tag.is_none() {
                out.push(chars[index]);
            }
            index += 1;
            continue;
        }

        let Some(relative_end) = chars[index..]
            .iter()
            .position(|character| *character == '>')
        else {
            if hidden_tag.is_none() {
                out.extend(chars[index..].iter());
            }
            break;
        };
        let end = index + relative_end;
        let tag = chars[index..=end]
            .iter()
            .collect::<String>()
            .to_ascii_lowercase();
        if tag.starts_with("<script") {
            hidden_tag = Some("script");
        } else if tag.starts_with("<style") {
            hidden_tag = Some("style");
        } else if tag.starts_with("</script") && hidden_tag == Some("script") {
            hidden_tag = None;
        } else if tag.starts_with("</style") && hidden_tag == Some("style") {
            hidden_tag = None;
        }
        if hidden_tag.is_none() {
            out.push(' ');
        }
        index = end + 1;
    }
    decode_html_entities(&out)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_html_entities(value: &str) -> String {
    let mut decoded = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('&') {
        decoded.push_str(&rest[..start]);
        let entity_start = start + 1;
        let Some(relative_end) = rest[entity_start..].find(';') else {
            decoded.push_str(&rest[start..]);
            return decoded;
        };
        let entity_end = entity_start + relative_end;
        if entity_end.saturating_sub(entity_start) > 12 {
            decoded.push('&');
            rest = &rest[entity_start..];
            continue;
        }
        let entity = &rest[entity_start..entity_end];
        let replacement = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                u32::from_str_radix(&entity[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            }
            _ if entity.starts_with('#') => {
                entity[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        if let Some(character) = replacement {
            decoded.push(character);
        } else {
            decoded.push_str(&rest[start..=entity_end]);
        }
        rest = &rest[entity_end + 1..];
    }
    decoded.push_str(rest);
    decoded
}

pub struct WebSearchTool;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum SearchSource {
    Bing,
    DuckDuckGo,
    GitHub,
}

impl SearchSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Bing => "bing",
            Self::DuckDuckGo => "duckduckgo",
            Self::GitHub => "github",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "bing" => Some(Self::Bing),
            "duckduckgo" => Some(Self::DuckDuckGo),
            "github" => Some(Self::GitHub),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
struct SearchResultItem {
    rank: usize,
    title: String,
    url: String,
    snippet: String,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_at: Option<String>,
}

#[derive(Clone, Debug)]
struct SearchCandidate {
    item: SearchResultItem,
    search_engine: SearchSource,
    score: i32,
    matched_terms: Vec<String>,
}

fn normalize_hostname(value: &str) -> String {
    let normalized = value.trim().trim_end_matches('.').to_ascii_lowercase();
    normalized
        .strip_prefix("www.")
        .unwrap_or(&normalized)
        .to_string()
}

fn normalize_domain_filters(value: Option<&Value>) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(normalize_hostname)
        .filter(|domain| !domain.is_empty() && seen.insert(domain.clone()))
        .collect()
}

fn matches_domain_filter(hostname: &str, domain: &str) -> bool {
    let hostname = normalize_hostname(hostname);
    let domain = normalize_hostname(domain);
    hostname == domain || hostname.ends_with(&format!(".{domain}"))
}

fn is_technical_query(query: &str) -> bool {
    static TECH_QUERY: OnceLock<Regex> = OnceLock::new();
    TECH_QUERY
        .get_or_init(|| {
            Regex::new(r"(?i)(\bmcp\b|model context protocol|github|repo|repository|package|sdk|api|docs?|documentation|server|protocol|typescript|javascript|node|python|java|go|rust|react|vue|release|changelog|library|tool)")
                .expect("technical query regex")
        })
        .is_match(query)
}

fn build_search_terms(query: &str) -> Vec<String> {
    const STOP_WORDS: &[&str] = &[
        "a",
        "an",
        "and",
        "the",
        "for",
        "with",
        "from",
        "into",
        "about",
        "that",
        "this",
        "those",
        "these",
        "public",
        "list",
        "testing",
        "test",
        "latest",
        "current",
        "official",
        "available",
    ];
    let lower = query.trim().to_lowercase();
    if lower.is_empty() {
        return Vec::new();
    }
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
        .filter(|term| term.chars().count() >= 2 && !STOP_WORDS.contains(term))
    {
        if !terms.iter().any(|known| known == term) {
            terms.push(term.to_string());
        }
        if terms.len() == 12 {
            break;
        }
    }
    terms
}

fn build_search_query_variants(query: &str) -> Vec<String> {
    static MCP: OnceLock<Regex> = OnceLock::new();
    let mut variants = vec![query.trim().to_string()];
    let mcp = MCP.get_or_init(|| Regex::new(r"(?i)\bmcp\b").expect("MCP regex"));
    if mcp.is_match(query)
        && !query
            .to_ascii_lowercase()
            .contains("model context protocol")
    {
        variants.push(
            mcp.replace_all(query, "Model Context Protocol")
                .into_owned(),
        );
    }
    variants.retain(|variant| !variant.is_empty());
    variants.dedup();
    variants.truncate(2);
    variants
}

fn resolve_search_sources(value: Option<&Value>, query: &str) -> Vec<SearchSource> {
    let mut sources = Vec::new();
    if let Some(requested) = value.and_then(Value::as_array) {
        for source in requested
            .iter()
            .filter_map(Value::as_str)
            .filter_map(SearchSource::from_str)
        {
            if !sources.contains(&source) {
                sources.push(source);
            }
        }
    }
    if !sources.is_empty() {
        return sources;
    }
    sources.extend([SearchSource::Bing, SearchSource::DuckDuckGo]);
    if is_technical_query(query) {
        sources.push(SearchSource::GitHub);
    }
    sources
}

fn unwrap_duckduckgo_url(raw_href: &str) -> String {
    let decoded = decode_html_entities(raw_href).trim().to_string();
    if decoded.is_empty() {
        return decoded;
    }
    let absolute = if decoded.starts_with("//") {
        format!("https:{decoded}")
    } else {
        decoded
    };
    let parsed = reqwest::Url::parse(&absolute)
        .or_else(|_| reqwest::Url::parse(DUCKDUCKGO_SEARCH_ENDPOINT)?.join(&absolute));
    match parsed {
        Ok(parsed) => parsed
            .query_pairs()
            .find(|(key, _)| key == "uddg")
            .map(|(_, value)| value.into_owned())
            .unwrap_or_else(|| parsed.to_string()),
        Err(_) => absolute,
    }
}

async fn validate_search_url(
    raw_url: &str,
    allowed_domains: &[String],
    blocked_domains: &[String],
) -> Option<reqwest::Url> {
    let parsed = reqwest::Url::parse(raw_url).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let hostname = parsed.host_str()?;
    if blocked_domains
        .iter()
        .any(|domain| matches_domain_filter(hostname, domain))
    {
        return None;
    }
    if !allowed_domains.is_empty()
        && !allowed_domains
            .iter()
            .any(|domain| matches_domain_filter(hostname, domain))
    {
        return None;
    }
    validate_public_target(&parsed).await.ok()?;
    Some(parsed)
}

fn extract_xml_tag(xml: &str, tag_name: &str) -> String {
    let lower = xml.to_ascii_lowercase();
    let opening = format!("<{tag_name}>");
    let closing = format!("</{tag_name}>");
    let Some(start) = lower.find(&opening) else {
        return String::new();
    };
    let value_start = start + opening.len();
    let Some(relative_end) = lower[value_start..].find(&closing) else {
        return String::new();
    };
    let value = xml[value_start..value_start + relative_end]
        .trim()
        .strip_prefix("<![CDATA[")
        .and_then(|value| value.strip_suffix("]]>"))
        .unwrap_or_else(|| xml[value_start..value_start + relative_end].trim());
    decode_html_entities(value)
}

fn normalize_snippet(raw: &str) -> String {
    strip_html(raw)
}

async fn search_bing(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
    allowed_domains: &[String],
    blocked_domains: &[String],
) -> Result<Vec<SearchResultItem>> {
    let locale = detect_search_locale(query);
    let mut url = reqwest::Url::parse(BING_SEARCH_ENDPOINT)?;
    url.query_pairs_mut()
        .append_pair("format", "rss")
        .append_pair("q", query)
        .append_pair("cc", locale.bing_country)
        .append_pair("setlang", locale.bing_language);
    let mut response = client
        .get(url)
        .header(
            reqwest::header::ACCEPT,
            "application/rss+xml,application/xml,text/xml;q=0.9,text/plain;q=0.5,*/*;q=0.1",
        )
        .header(reqwest::header::ACCEPT_LANGUAGE, locale.accept_language)
        .send()
        .await?;
    anyhow::ensure!(
        response.status().is_success(),
        "Bing search failed: HTTP {} {}",
        response.status().as_u16(),
        response.status().canonical_reason().unwrap_or_default()
    );
    let xml = String::from_utf8_lossy(&response_body_limited(&mut response).await?).into_owned();
    let item_regex = Regex::new(r"(?is)<item>.*?</item>").expect("Bing item regex");
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for item_match in item_regex
        .find_iter(&xml)
        .take(MAX_SEARCH_LIMIT * SEARCH_CANDIDATE_FACTOR)
    {
        let item = item_match.as_str();
        let link = extract_xml_tag(item, "link");
        let Some(parsed) = validate_search_url(&link, allowed_domains, blocked_domains).await
        else {
            continue;
        };
        let normalized_url = parsed.to_string();
        if !seen.insert(normalized_url.clone()) {
            continue;
        }
        let title = extract_xml_tag(item, "title");
        let published_raw = extract_xml_tag(item, "pubdate");
        let published_at = chrono::DateTime::parse_from_rfc2822(&published_raw)
            .or_else(|_| chrono::DateTime::parse_from_rfc3339(&published_raw))
            .ok()
            .map(|value| value.to_rfc3339());
        results.push(SearchResultItem {
            rank: results.len() + 1,
            title: if title.is_empty() {
                normalized_url.clone()
            } else {
                title
            },
            url: normalized_url,
            snippet: normalize_snippet(&extract_xml_tag(item, "description")),
            source: normalize_hostname(parsed.host_str().unwrap_or_default()),
            published_at,
        });
        if results.len() >= limit {
            break;
        }
    }
    Ok(results)
}

async fn search_duckduckgo(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
    allowed_domains: &[String],
    blocked_domains: &[String],
) -> Result<Vec<SearchResultItem>> {
    let locale = detect_search_locale(query);
    let mut url = reqwest::Url::parse(DUCKDUCKGO_SEARCH_ENDPOINT)?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("kl", locale.duckduckgo_region);
    let mut response = client
        .get(url)
        .header(
            reqwest::header::ACCEPT,
            "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        )
        .header(reqwest::header::ACCEPT_LANGUAGE, locale.accept_language)
        .send()
        .await?;
    anyhow::ensure!(
        response.status().is_success(),
        "DuckDuckGo search failed: HTTP {} {}",
        response.status().as_u16(),
        response.status().canonical_reason().unwrap_or_default()
    );
    let html = String::from_utf8_lossy(&response_body_limited(&mut response).await?).into_owned();
    let title_regex = Regex::new(r#"(?is)<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>(.*?)</a>"#)
        .expect("DuckDuckGo title regex");
    let snippet_regex = Regex::new(
        r#"(?is)<(?:a|div)[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>(.*?)</(?:a|div)>"#,
    )
    .expect("DuckDuckGo snippet regex");
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for captures in title_regex
        .captures_iter(&html)
        .take(limit * SEARCH_CANDIDATE_FACTOR)
    {
        let Some(whole_match) = captures.get(0) else {
            continue;
        };
        let resolved = unwrap_duckduckgo_url(
            captures
                .get(1)
                .map(|value| value.as_str())
                .unwrap_or_default(),
        );
        let Some(parsed) = validate_search_url(&resolved, allowed_domains, blocked_domains).await
        else {
            continue;
        };
        let normalized_url = parsed.to_string();
        if !seen.insert(normalized_url.clone()) {
            continue;
        }
        let snippet_end = (whole_match.start() + 2_500).min(html.len());
        let snippet = html
            .get(whole_match.start()..snippet_end)
            .and_then(|window| snippet_regex.captures(window))
            .and_then(|captures| captures.get(1))
            .map(|value| normalize_snippet(value.as_str()))
            .unwrap_or_default();
        let title = normalize_snippet(
            captures
                .get(2)
                .map(|value| value.as_str())
                .unwrap_or_default(),
        );
        results.push(SearchResultItem {
            rank: results.len() + 1,
            title: if title.is_empty() {
                normalized_url.clone()
            } else {
                title
            },
            url: normalized_url,
            snippet,
            source: normalize_hostname(parsed.host_str().unwrap_or_default()),
            published_at: None,
        });
        if results.len() >= limit {
            break;
        }
    }
    Ok(results)
}

async fn search_github(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
    allowed_domains: &[String],
    blocked_domains: &[String],
) -> Result<Vec<SearchResultItem>> {
    let mut url = reqwest::Url::parse(GITHUB_REPOSITORY_SEARCH_ENDPOINT)?;
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("sort", "stars")
        .append_pair("order", "desc")
        .append_pair(
            "per_page",
            &(limit * 2).min(MAX_SEARCH_LIMIT * 2).to_string(),
        );
    let mut response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await?;
    if matches!(response.status().as_u16(), 403 | 429) {
        anyhow::bail!("GitHub repository search is temporarily rate-limited");
    }
    anyhow::ensure!(
        response.status().is_success(),
        "GitHub repository search failed: HTTP {} {}",
        response.status().as_u16(),
        response.status().canonical_reason().unwrap_or_default()
    );
    let payload: Value = serde_json::from_slice(&response_body_limited(&mut response).await?)?;
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for item in payload
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let raw_url = item
            .get("html_url")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(parsed) = validate_search_url(raw_url, allowed_domains, blocked_domains).await
        else {
            continue;
        };
        let normalized_url = parsed.to_string();
        if !seen.insert(normalized_url.clone()) {
            continue;
        }
        let mut snippet_parts = Vec::new();
        if let Some(description) = item
            .get("description")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            snippet_parts.push(description.trim().to_string());
        }
        if let Some(language) = item
            .get("language")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            snippet_parts.push(format!("Language: {}", language.trim()));
        }
        if let Some(stars) = item.get("stargazers_count").and_then(Value::as_u64) {
            snippet_parts.push(format!("Stars: {stars}"));
        }
        if let Some(topics) = item.get("topics").and_then(Value::as_array) {
            let topics = topics
                .iter()
                .filter_map(Value::as_str)
                .take(6)
                .collect::<Vec<_>>();
            if !topics.is_empty() {
                snippet_parts.push(format!("Topics: {}", topics.join(", ")));
            }
        }
        results.push(SearchResultItem {
            rank: results.len() + 1,
            title: item
                .get("full_name")
                .and_then(Value::as_str)
                .unwrap_or(&normalized_url)
                .to_string(),
            url: normalized_url,
            snippet: snippet_parts.join(" · "),
            source: normalize_hostname(parsed.host_str().unwrap_or_default()),
            published_at: None,
        });
        if results.len() >= limit {
            break;
        }
    }
    Ok(results)
}

async fn search_by_source(
    client: &reqwest::Client,
    source: SearchSource,
    query: &str,
    limit: usize,
    allowed_domains: &[String],
    blocked_domains: &[String],
) -> Result<Vec<SearchResultItem>> {
    match source {
        SearchSource::Bing => {
            search_bing(client, query, limit, allowed_domains, blocked_domains).await
        }
        SearchSource::DuckDuckGo => {
            search_duckduckgo(client, query, limit, allowed_domains, blocked_domains).await
        }
        SearchSource::GitHub => {
            search_github(client, query, limit, allowed_domains, blocked_domains).await
        }
    }
}

fn source_priority(source: SearchSource, technical_query: bool) -> i32 {
    match (technical_query, source) {
        (true, SearchSource::GitHub) => 3,
        (_, SearchSource::DuckDuckGo) => 2,
        (_, SearchSource::Bing) => 1,
        _ => 0,
    }
}

fn score_search_candidate(
    item: &SearchResultItem,
    query: &str,
    terms: &[String],
    technical_query: bool,
) -> (i32, Vec<String>) {
    let title = item.title.to_lowercase();
    let snippet = item.snippet.to_lowercase();
    let url = item.url.to_lowercase();
    let source = item.source.to_lowercase();
    let normalized_query = query.trim().to_lowercase();
    let mut score = 0;
    let mut matched_terms = Vec::new();
    if !normalized_query.is_empty()
        && (title.contains(&normalized_query)
            || snippet.contains(&normalized_query)
            || url.contains(&normalized_query))
    {
        score += 14;
    }
    for term in terms {
        if title.contains(term) {
            score += 7;
            matched_terms.push(term.clone());
        } else if url.contains(term) {
            score += 5;
            matched_terms.push(term.clone());
        } else if snippet.contains(term) {
            score += 4;
            matched_terms.push(term.clone());
        }
    }
    const DOC_HINTS: &[&str] = &[
        "doc",
        "developer",
        "api",
        "reference",
        "guide",
        "readme",
        "github",
        "npmjs",
        "pypi",
        "modelcontextprotocol",
        "readthedocs",
        "mozilla",
        "microsoft",
        "openai",
        "anthropic",
    ];
    if DOC_HINTS
        .iter()
        .any(|hint| source.contains(hint) || url.contains(hint) || title.contains(hint))
    {
        score += 4;
    }
    if technical_query && source == "github.com" {
        score += 5;
    }
    const LOW_SIGNAL_HINTS: &[&str] = &[
        "sign in",
        "login",
        "store",
        "shop",
        "buy",
        "cart",
        "product",
        "iphone",
        "store locator",
        "training support",
        "certification",
        "account",
    ];
    if LOW_SIGNAL_HINTS
        .iter()
        .any(|hint| title.contains(hint) || url.contains(hint))
    {
        score -= 8;
    }
    if terms.len() >= 3 && matched_terms.len() <= 1 {
        score -= 6;
    }
    (score, matched_terms)
}

fn rerank_search_results(
    candidates: Vec<SearchCandidate>,
    query: &str,
    limit: usize,
) -> Vec<SearchResultItem> {
    let query_variants = build_search_query_variants(query);
    let mut terms = Vec::new();
    for term in query_variants
        .iter()
        .flat_map(|variant| build_search_terms(variant))
    {
        if !terms.contains(&term) {
            terms.push(term);
        }
    }
    let technical_query = is_technical_query(query);
    // Keep first-seen order while deduplicating. JavaScript's Map preserves
    // insertion order and its stable sort uses that order for complete ties;
    // using HashMap values directly would make equal-score results random.
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut deduped: Vec<SearchCandidate> = Vec::new();
    for mut candidate in candidates {
        let (score, matched_terms) =
            score_search_candidate(&candidate.item, query, &terms, technical_query);
        candidate.score = score + source_priority(candidate.search_engine, technical_query);
        candidate.matched_terms = matched_terms;
        let key = candidate.item.url.clone();
        if let Some(index) = positions.get(&key).copied() {
            if candidate.score > deduped[index].score {
                deduped[index] = candidate;
            }
        } else {
            positions.insert(key, deduped.len());
            deduped.push(candidate);
        }
    }
    let mut all = deduped;
    all.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| right.matched_terms.len().cmp(&left.matched_terms.len()))
            .then_with(|| left.item.rank.cmp(&right.item.rank))
    });
    let normalized_query = query.trim().to_lowercase();
    let mut ranked = all
        .iter()
        .filter(|candidate| {
            candidate.score > 0
                && (!candidate.matched_terms.is_empty()
                    || candidate
                        .item
                        .title
                        .to_lowercase()
                        .contains(&normalized_query)
                    || candidate
                        .item
                        .snippet
                        .to_lowercase()
                        .contains(&normalized_query))
        })
        .cloned()
        .take(limit)
        .collect::<Vec<_>>();
    if ranked.is_empty() {
        ranked = all.into_iter().take(limit).collect();
    }
    ranked
        .into_iter()
        .enumerate()
        .map(|(index, mut candidate)| {
            candidate.item.rank = index + 1;
            candidate.item
        })
        .collect()
}

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "web_search"
    }
    fn description(&self) -> &str {
        "Search the public web for external documentation, changelogs, registry pages, repositories, or other reference material when you do not yet know the exact URL. Uses multiple search sources, reranks results by query relevance, and supports domain allow/block filters similar to Claude Code web search."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Search query describing the topic you need to find." },
                "limit": { "type": "integer", "description": "Maximum number of search results to return. Default 6, maximum 10." },
                "sources": {
                    "type": "array",
                    "description": "Optional search sources to use. Supported: bing, duckduckgo, github. Defaults to multiple sources automatically chosen by the query.",
                    "items": { "type": "string", "enum": ["bing", "duckduckgo", "github"] }
                },
                "allowed_domains": {
                    "type": "array",
                    "description": "Optional allowlist of result domains. Only results from these domains or their subdomains will be returned.",
                    "items": { "type": "string" }
                },
                "blocked_domains": {
                    "type": "array",
                    "description": "Optional blocklist of result domains. Results from these domains or their subdomains will be excluded.",
                    "items": { "type": "string" }
                },
                "auto_fetch_top_n": {
                    "type": "integer",
                    "description": "Automatically fetch the top N result pages after searching. Optional. Maximum 5."
                },
                "fetch_max_chars": {
                    "type": "integer",
                    "description": "When auto_fetch_top_n is used, maximum characters to return per fetched page. Default 12000, maximum 40000."
                },
                "fetch_timeout_ms": {
                    "type": "integer",
                    "description": "When auto_fetch_top_n is used, per-page fetch timeout in milliseconds. Default 10000, maximum 30000."
                }
            },
            "required": ["query"]
        })
    }
    async fn execute(&self, input: Value, _services: &ToolServices) -> Result<Value> {
        let query = require_str(&input, "query")?.trim();
        anyhow::ensure!(!query.is_empty(), "web_search requires a non-empty query");
        let numeric_arg = |name: &str, default: f64| {
            input
                .get(name)
                .and_then(|value| {
                    value
                        .as_f64()
                        .or_else(|| value.as_str().and_then(|value| value.parse::<f64>().ok()))
                })
                .filter(|value| value.is_finite() && *value != 0.0)
                .unwrap_or(default)
        };
        let limit = numeric_arg("limit", DEFAULT_SEARCH_LIMIT as f64)
            .clamp(1.0, MAX_SEARCH_LIMIT as f64) as usize;
        let sources = resolve_search_sources(input.get("sources"), query);
        let allowed_domains = normalize_domain_filters(input.get("allowed_domains"));
        let blocked_domains = normalize_domain_filters(input.get("blocked_domains"));
        anyhow::ensure!(
            allowed_domains.is_empty() || blocked_domains.is_empty(),
            "web_search cannot use allowed_domains and blocked_domains in the same request"
        );
        let auto_fetch_top_n = numeric_arg("auto_fetch_top_n", 0.0)
            .clamp(0.0, MAX_AUTO_FETCH.min(limit) as f64) as usize;
        let fetch_max_chars = numeric_arg("fetch_max_chars", DEFAULT_FETCH_MAX_CHARS as f64)
            .clamp(500.0, ABSOLUTE_FETCH_MAX_CHARS as f64) as usize;
        let fetch_timeout_ms = numeric_arg("fetch_timeout_ms", DEFAULT_FETCH_TIMEOUT_MS as f64)
            .clamp(1_000.0, MAX_FETCH_TIMEOUT_MS as f64) as u64;
        let query_variants = build_search_query_variants(query);
        let candidate_limit =
            (limit * SEARCH_CANDIDATE_FACTOR).min(MAX_SEARCH_LIMIT * SEARCH_CANDIDATE_FACTOR);
        let client = reqwest::Client::builder()
            .user_agent("WorldBase AI Agent/1.0")
            .timeout(std::time::Duration::from_secs(15))
            .build()?;

        let mut tasks = Vec::new();
        for source in &sources {
            for query_variant in &query_variants {
                let client = client.clone();
                let source = *source;
                let query_variant = query_variant.clone();
                let allowed_domains = allowed_domains.clone();
                let blocked_domains = blocked_domains.clone();
                tasks.push(async move {
                    let result = search_by_source(
                        &client,
                        source,
                        &query_variant,
                        candidate_limit,
                        &allowed_domains,
                        &blocked_domains,
                    )
                    .await;
                    (source, result)
                });
            }
        }
        let mut candidates = Vec::new();
        let mut source_errors = Vec::new();
        for (source, result) in join_all(tasks).await {
            match result {
                Ok(items) => candidates.extend(items.into_iter().map(|item| SearchCandidate {
                    item,
                    search_engine: source,
                    score: 0,
                    matched_terms: Vec::new(),
                })),
                Err(error) => source_errors.push(json!({
                    "source": source.as_str(),
                    "error": error.to_string(),
                })),
            }
        }
        let results = rerank_search_results(candidates, query, limit);
        let mut fetched_results = Vec::new();
        if auto_fetch_top_n > 0 {
            let fetch_client = reqwest::Client::builder()
                .user_agent("WorldBase AI Agent/1.0")
                .redirect(reqwest::redirect::Policy::none())
                .build()?;
            for result in results.iter().take(auto_fetch_top_n) {
                fetched_results.push(
                    fetch_public_webpage(
                        &fetch_client,
                        &result.url,
                        Some(query),
                        fetch_max_chars,
                        fetch_timeout_ms,
                    )
                    .await,
                );
            }
        }

        let mut output = Map::new();
        output.insert("query".into(), json!(query));
        output.insert(
            "engine".into(),
            json!(sources
                .iter()
                .map(|source| source.as_str())
                .collect::<Vec<_>>()
                .join(" + ")),
        );
        output.insert(
            "sources_used".into(),
            json!(sources
                .iter()
                .map(|source| source.as_str())
                .collect::<Vec<_>>()),
        );
        if query_variants.len() > 1 {
            output.insert("query_variants".into(), json!(query_variants));
        }
        output.insert("results".into(), serde_json::to_value(&results)?);
        if !source_errors.is_empty() {
            output.insert("source_errors".into(), json!(source_errors));
        }
        if !fetched_results.is_empty() {
            output.insert("auto_fetched_count".into(), json!(fetched_results.len()));
            output.insert("fetched_results".into(), json!(fetched_results));
        }
        output.insert(
            "fetched_at".into(),
            json!(worldbase_protocol::event::now_rfc3339()),
        );
        Ok(Value::Object(output))
    }
}

pub struct WebFetchTool;

#[async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> &str {
        "web_fetch"
    }
    fn description(&self) -> &str {
        "Fetch a public webpage and extract readable text. Blocks localhost and private-network targets."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "One public http(s) URL to fetch." },
                "query": { "type": "string", "description": "Optional topic or text to focus on." },
                "max_chars": { "type": "integer", "description": "Maximum characters to return. Default 12000, maximum 40000." },
                "timeout_ms": { "type": "integer", "description": "Request timeout in milliseconds. Default 10000, maximum 30000." }
            },
            "required": ["url"]
        })
    }
    async fn execute(&self, input: Value, _services: &ToolServices) -> Result<Value> {
        let url = require_str(&input, "url")?.trim().to_string();
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

        let client = reqwest::Client::builder()
            .user_agent("WorldBase AI Agent/1.0")
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        let result = fetch_public_webpage(&client, &url, query, max_chars, timeout_ms).await;

        // `web_fetch` predates the Electron-compatible `fetch_webpage` tool.
        // Keep its compact fields for persisted/mobile callers while exposing
        // the complete result object for newer clients.
        let content_type = result
            .get("content_type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let text = result
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut output = result.as_object().cloned().unwrap_or_default();
        output.insert("url".into(), json!(url));
        output.insert("content_type".into(), json!(content_type));
        output.insert("text".into(), json!(text));
        Ok(Value::Object(output))
    }
}

/// Electron-compatible batched webpage fetcher. This is intentionally a
/// separate tool instead of an alias to `web_fetch`: the public Electron
/// contract accepts `urls[]` and returns one independent result per URL.
pub struct FetchWebpageTool;

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let octets = ip.octets();
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_unspecified()
                || ip.is_multicast()
                || octets[0] == 0
                // Carrier-grade NAT and benchmarking ranges are not public
                // destinations even though the standard private check excludes
                // them.
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 198 && (18..=19).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        }
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
                || ip
                    .to_ipv4()
                    .is_some_and(|mapped| is_private_ip(IpAddr::V4(mapped)))
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
    let normalized = host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
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

fn extract_html_description(html: &str) -> Option<String> {
    static DESCRIPTION_NAME: OnceLock<Regex> = OnceLock::new();
    static DESCRIPTION_PROPERTY: OnceLock<Regex> = OnceLock::new();
    static DESCRIPTION_NAME_REVERSED: OnceLock<Regex> = OnceLock::new();
    static DESCRIPTION_PROPERTY_REVERSED: OnceLock<Regex> = OnceLock::new();
    let patterns = [
        DESCRIPTION_NAME.get_or_init(|| {
            Regex::new(r#"(?is)<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*>"#)
                .expect("description meta regex")
        }),
        DESCRIPTION_PROPERTY.get_or_init(|| {
            Regex::new(r#"(?is)<meta\b[^>]*\bproperty\s*=\s*["']og:description["'][^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*>"#)
                .expect("og description meta regex")
        }),
        DESCRIPTION_NAME_REVERSED.get_or_init(|| {
            Regex::new(r#"(?is)<meta\b[^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*\bname\s*=\s*["']description["'][^>]*>"#)
                .expect("reversed description meta regex")
        }),
        DESCRIPTION_PROPERTY_REVERSED.get_or_init(|| {
            Regex::new(r#"(?is)<meta\b[^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*\bproperty\s*=\s*["']og:description["'][^>]*>"#)
                .expect("reversed og description meta regex")
        }),
    ];
    for pattern in patterns {
        if let Some(value) = pattern
            .captures(html)
            .and_then(|captures| captures.get(1))
            .map(|value| decode_html_entities(value.as_str()).trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return Some(value);
        }
    }
    None
}

fn extract_primary_html(html: &str, source_url: Option<&str>) -> String {
    let hostname = source_url
        .and_then(|url| reqwest::Url::parse(url).ok())
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default();
    if hostname == "github.com" {
        static GITHUB_ARTICLE: OnceLock<Regex> = OnceLock::new();
        if let Some(article) = GITHUB_ARTICLE
            .get_or_init(|| {
                Regex::new(r#"(?is)<article\b[^>]*\bclass\s*=\s*["'][^"']*markdown-body[^"']*["'][^>]*>.*?</article>"#)
                    .expect("github article regex")
            })
            .find(html)
        {
            return article.as_str().to_string();
        }
    }

    static FOCUSED_BLOCK: OnceLock<Regex> = OnceLock::new();
    FOCUSED_BLOCK
        .get_or_init(|| {
            Regex::new(r#"(?is)<(?:main|article)\b[^>]*>.*?</(?:main|article)>"#)
                .expect("focused HTML regex")
        })
        .find(html)
        .map(|value| value.as_str().to_string())
        .unwrap_or_else(|| html.to_string())
}

fn html_fragment_to_text(html: &str) -> String {
    static COMMENTS: OnceLock<Regex> = OnceLock::new();
    static NOISE: OnceLock<Regex> = OnceLock::new();
    static PRE: OnceLock<Regex> = OnceLock::new();
    static CODE: OnceLock<Regex> = OnceLock::new();
    static BLOCK_END: OnceLock<Regex> = OnceLock::new();
    static LIST_ITEM: OnceLock<Regex> = OnceLock::new();
    static TAGS: OnceLock<Regex> = OnceLock::new();

    let value = COMMENTS
        .get_or_init(|| Regex::new(r"(?is)<!--.*?-->").expect("HTML comment regex"))
        .replace_all(html, " ");
    let value = NOISE
        .get_or_init(|| {
            Regex::new(r"(?is)<(?:script|style|noscript|template|svg|canvas|nav|footer|header|aside|form|dialog)\b[^>]*>.*?</(?:script|style|noscript|template|svg|canvas|nav|footer|header|aside|form|dialog)>")
                .expect("HTML noise regex")
        })
        .replace_all(&value, " ");
    let value = PRE
        .get_or_init(|| Regex::new(r"(?is)<pre\b[^>]*>(.*?)</pre>").expect("HTML pre regex"))
        .replace_all(&value, |captures: &regex::Captures<'_>| {
            format!(
                "\n\n{}\n\n",
                strip_html(
                    captures
                        .get(1)
                        .map(|value| value.as_str())
                        .unwrap_or_default()
                )
            )
        });
    let value = CODE
        .get_or_init(|| Regex::new(r"(?is)<code\b[^>]*>(.*?)</code>").expect("HTML code regex"))
        .replace_all(&value, |captures: &regex::Captures<'_>| {
            format!(
                " {} ",
                strip_html(
                    captures
                        .get(1)
                        .map(|value| value.as_str())
                        .unwrap_or_default()
                )
            )
        });
    let value = BLOCK_END
        .get_or_init(|| {
            Regex::new(r"(?is)</(?:br|p|div|section|article|li|ul|ol|tr|table|h[1-6]|main|header|footer|aside)\s*>")
                .expect("HTML block-end regex")
        })
        .replace_all(&value, "\n");
    let value = LIST_ITEM
        .get_or_init(|| Regex::new(r"(?is)<li\b[^>]*>").expect("HTML list-item regex"))
        .replace_all(&value, "\n- ");
    let value = TAGS
        .get_or_init(|| Regex::new(r"(?is)<[^>]+>").expect("HTML tags regex"))
        .replace_all(&value, " ");

    decode_html_entities(&value)
        .replace('\r', "")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_readable_html(
    html: &str,
    source_url: Option<&str>,
) -> (Option<String>, Option<String>, String) {
    let focused_html = extract_primary_html(html, source_url);
    let focused_text = html_fragment_to_text(&focused_html);
    let fallback_text = if focused_html == html {
        focused_text.clone()
    } else {
        html_fragment_to_text(html)
    };
    let minimum = 400.min(fallback_text.chars().count());
    let text = if focused_text.chars().count() >= minimum {
        focused_text
    } else {
        fallback_text
    };
    (
        extract_html_title(html),
        extract_html_description(html),
        text,
    )
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
                query
                    .map(detect_search_locale)
                    .unwrap_or(DEFAULT_SEARCH_LOCALE)
                    .accept_language,
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
        let (title, description, source_text) =
            if content_type.contains("html") || content_type.contains("xml") {
                extract_readable_html(&response_text, Some(current.as_str()))
            } else if content_type.contains("json") {
                let pretty = serde_json::from_str::<Value>(&response_text)
                    .ok()
                    .and_then(|value| serde_json::to_string_pretty(&value).ok())
                    .unwrap_or(response_text);
                (None, None, pretty)
            } else if content_type.contains("text") || content_type.is_empty() {
                (None, None, response_text)
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
            "description": description,
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
        let html = r#"<html><head><style>x{}</style><script>alert('x')</script></head><body><h1>标题</h1><p>正文 &amp; <b>加粗</b></p></body></html>"#;
        let text = strip_html(html);
        assert!(text.contains("标题"));
        assert!(text.contains("正文 & 加粗"));
        assert!(!text.contains("alert"));
        assert!(!text.contains("x{}"));
        assert!(!text.contains('<'));
    }

    #[test]
    fn readable_html_extracts_primary_content_and_metadata() {
        let html = r#"
            <html><head>
              <title>Docs &amp; API</title>
              <meta name="description" content="Public API reference">
              <script>ignored()</script>
            </head><body>
              <nav>Navigation</nav>
              <main><h1>API</h1><p>Use the endpoint.</p><pre>curl https://example.com</pre></main>
              <footer>Footer</footer>
            </body></html>
        "#;
        let (title, description, text) =
            extract_readable_html(html, Some("https://example.com/docs"));
        assert_eq!(title.as_deref(), Some("Docs & API"));
        assert_eq!(description.as_deref(), Some("Public API reference"));
        assert!(text.contains("API"));
        assert!(text.contains("Use the endpoint."));
        assert!(text.contains("curl https://example.com"));
        assert!(!text.contains("Navigation"));
        assert!(!text.contains("ignored"));
        assert!(!text.contains("Footer"));
    }

    #[test]
    fn web_fetch_schema_retains_legacy_url_and_supports_fetch_options() {
        let schema = WebFetchTool.input_schema();
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .expect("web_fetch properties");
        assert!(properties.contains_key("url"));
        assert!(properties.contains_key("query"));
        assert!(properties.contains_key("max_chars"));
        assert!(properties.contains_key("timeout_ms"));
    }

    #[tokio::test]
    async fn public_fetch_rejects_private_targets_before_network_access() {
        for raw_url in [
            "http://127.0.0.1:1/",
            "http://10.0.0.1/",
            "http://[::1]/",
            "file:///etc/passwd",
        ] {
            let url = reqwest::Url::parse(raw_url).expect("test URL");
            assert!(
                validate_public_target(&url).await.is_err(),
                "target should be blocked: {raw_url}"
            );
        }
    }

    #[test]
    fn domain_filters_match_exact_hosts_and_subdomains() {
        assert!(matches_domain_filter("www.docs.example.com", "example.com"));
        assert!(matches_domain_filter("example.com", "www.example.com"));
        assert!(!matches_domain_filter("notexample.com", "example.com"));

        let filters = normalize_domain_filters(Some(&json!([
            "WWW.Example.com",
            "example.com",
            "docs.example.com"
        ])));
        assert_eq!(filters, vec!["example.com", "docs.example.com"]);
    }

    #[test]
    fn search_locale_matches_node_profiles() {
        let chinese = detect_search_locale("Rust 文档");
        assert_eq!(chinese.bing_language, "zh-CN");
        assert_eq!(chinese.bing_country, "cn");
        assert_eq!(chinese.duckduckgo_region, "cn-zh");
        assert_eq!(chinese.accept_language, "zh-CN,zh;q=0.9,en;q=0.7");

        let japanese = detect_search_locale("Rust ドキュメント");
        assert_eq!(japanese.bing_language, "ja-JP");
        assert_eq!(japanese.bing_country, "jp");
        assert_eq!(japanese.duckduckgo_region, "jp-jp");

        let korean = detect_search_locale("Rust 문서");
        assert_eq!(korean.bing_language, "ko-KR");
        assert_eq!(korean.bing_country, "kr");
        assert_eq!(korean.duckduckgo_region, "kr-kr");

        let russian = detect_search_locale("Rust документация");
        assert_eq!(russian.bing_language, "ru-RU");
        assert_eq!(russian.bing_country, "ru");
        assert_eq!(russian.duckduckgo_region, "ru-ru");

        assert_eq!(
            detect_search_locale("Rust documentation"),
            DEFAULT_SEARCH_LOCALE
        );
    }

    #[test]
    fn search_parsers_decode_rss_and_duckduckgo_redirect_urls() {
        let item = r#"<item>
            <title>Rust &amp; API</title>
            <link>https://docs.example.com/guide</link>
            <description><![CDATA[<b>Official</b> API reference]]></description>
            <pubDate>Tue, 02 Jan 2024 15:04:05 GMT</pubDate>
        </item>"#;
        assert_eq!(extract_xml_tag(item, "title"), "Rust & API");
        assert_eq!(
            extract_xml_tag(item, "description"),
            "<b>Official</b> API reference"
        );
        assert_eq!(
            extract_xml_tag(item, "pubdate"),
            "Tue, 02 Jan 2024 15:04:05 GMT"
        );
        assert_eq!(
            unwrap_duckduckgo_url(
                "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fguide&rut=abc"
            ),
            "https://docs.example.com/guide"
        );
    }

    #[tokio::test]
    async fn search_url_validation_applies_domain_filters_and_ssrf() {
        assert!(
            validate_search_url("https://8.8.8.8/docs", &["8.8.8.8".into()], &[])
                .await
                .is_some()
        );
        assert!(
            validate_search_url("https://8.8.8.8/docs", &[], &["8.8.8.8".into()])
                .await
                .is_none()
        );
        assert!(validate_search_url("http://127.0.0.1:8080/", &[], &[])
            .await
            .is_none());
        assert!(validate_search_url("file:///etc/passwd", &[], &[])
            .await
            .is_none());
    }

    #[test]
    fn reranking_preserves_first_seen_order_for_complete_ties() {
        let candidate = |url: &str| SearchCandidate {
            item: SearchResultItem {
                rank: 1,
                title: "Unrelated result".into(),
                url: url.into(),
                snippet: "No matching terms".into(),
                source: "example.com".into(),
                published_at: None,
            },
            search_engine: SearchSource::Bing,
            score: 0,
            matched_terms: Vec::new(),
        };
        let ranked = rerank_search_results(
            vec![
                candidate("https://example.com/first"),
                candidate("https://example.com/second"),
                candidate("https://example.com/third"),
            ],
            "different query",
            10,
        );
        assert_eq!(
            ranked
                .iter()
                .map(|item| item.url.as_str())
                .collect::<Vec<_>>(),
            vec![
                "https://example.com/first",
                "https://example.com/second",
                "https://example.com/third"
            ]
        );
    }

    #[test]
    fn technical_queries_add_github_and_expand_mcp() {
        let sources = resolve_search_sources(None, "Rust MCP server SDK");
        assert_eq!(
            sources,
            vec![
                SearchSource::Bing,
                SearchSource::DuckDuckGo,
                SearchSource::GitHub
            ]
        );
        assert_eq!(
            build_search_query_variants("Rust MCP server"),
            vec!["Rust MCP server", "Rust Model Context Protocol server"]
        );
    }

    #[test]
    fn reranking_deduplicates_and_prefers_relevant_documentation() {
        let candidates = vec![
            SearchCandidate {
                item: SearchResultItem {
                    rank: 1,
                    title: "Rust SDK shopping page".into(),
                    url: "https://shop.example.com/rust".into(),
                    snippet: "Buy a product".into(),
                    source: "shop.example.com".into(),
                    published_at: None,
                },
                search_engine: SearchSource::Bing,
                score: 0,
                matched_terms: Vec::new(),
            },
            SearchCandidate {
                item: SearchResultItem {
                    rank: 2,
                    title: "Rust SDK API documentation".into(),
                    url: "https://docs.example.com/rust-sdk".into(),
                    snippet: "Rust SDK API reference and guide".into(),
                    source: "docs.example.com".into(),
                    published_at: None,
                },
                search_engine: SearchSource::DuckDuckGo,
                score: 0,
                matched_terms: Vec::new(),
            },
            SearchCandidate {
                item: SearchResultItem {
                    rank: 1,
                    title: "Duplicate result".into(),
                    url: "https://docs.example.com/rust-sdk".into(),
                    snippet: "less relevant".into(),
                    source: "docs.example.com".into(),
                    published_at: None,
                },
                search_engine: SearchSource::Bing,
                score: 0,
                matched_terms: Vec::new(),
            },
        ];
        let ranked = rerank_search_results(candidates, "Rust SDK API", 10);
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].url, "https://docs.example.com/rust-sdk");
        assert_eq!(ranked[0].rank, 1);
    }

    #[test]
    fn web_search_schema_exposes_the_full_cross_platform_contract() {
        let schema = WebSearchTool.input_schema();
        let properties = schema["properties"].as_object().unwrap();
        for property in [
            "query",
            "limit",
            "sources",
            "allowed_domains",
            "blocked_domains",
            "auto_fetch_top_n",
            "fetch_max_chars",
            "fetch_timeout_ms",
        ] {
            assert!(properties.contains_key(property), "missing {property}");
        }
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
