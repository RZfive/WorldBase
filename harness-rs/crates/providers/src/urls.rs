use anyhow::{Context, Result};
use reqwest::Url;

use crate::openai::DEFAULT_BASE_URL as DEFAULT_OPENAI_BASE_URL;

fn parse_base_url(base_url: &str, default_url: &str) -> Result<Url> {
    let value = if base_url.trim().is_empty() {
        default_url
    } else {
        base_url.trim()
    };
    Url::parse(value).with_context(|| format!("invalid provider base URL: {value}"))
}

fn normalized_path(url: &Url) -> String {
    url.path().trim_end_matches('/').to_string()
}

fn replace_path(mut url: Url, path: String) -> Url {
    url.set_path(if path.is_empty() { "/" } else { &path });
    url
}

fn append_path(url: Url, suffix: &str) -> Url {
    let path = normalized_path(&url);
    replace_path(url, format!("{path}/{suffix}"))
}

pub(crate) fn chat_completions_url(base_url: &str) -> Result<Url> {
    let url = parse_base_url(base_url, DEFAULT_OPENAI_BASE_URL)?;
    let path = normalized_path(&url);
    if path.to_ascii_lowercase().ends_with("/chat/completions") {
        return Ok(replace_path(url, path));
    }
    Ok(append_path(url, "chat/completions"))
}

pub(crate) fn responses_url(base_url: &str) -> Result<Url> {
    let url = parse_base_url(base_url, DEFAULT_OPENAI_BASE_URL)?;
    let path = normalized_path(&url);
    let lower = path.to_ascii_lowercase();
    if lower.ends_with("/responses") {
        return Ok(replace_path(url, path));
    }
    if lower.ends_with("/chat/completions") {
        let prefix = &path[..path.len() - "/chat/completions".len()];
        return Ok(replace_path(url, format!("{prefix}/responses")));
    }
    Ok(append_path(url, "responses"))
}

pub(crate) fn anthropic_messages_url(base_url: &str, default_url: &str) -> Result<Url> {
    let url = parse_base_url(base_url, default_url)?;
    let path = normalized_path(&url);
    let lower = path.to_ascii_lowercase();
    if lower.ends_with("/messages") {
        return Ok(replace_path(url, path));
    }
    if lower.ends_with("/chat/completions") {
        let prefix = &path[..path.len() - "/chat/completions".len()];
        return Ok(replace_path(url, format!("{prefix}/messages")));
    }
    let final_segment = path.rsplit('/').next().unwrap_or_default();
    if final_segment.len() > 1
        && final_segment.starts_with('v')
        && final_segment[1..].chars().all(|ch| ch.is_ascii_digit())
    {
        return Ok(append_path(url, "messages"));
    }
    Ok(append_path(url, "v1/messages"))
}

pub(crate) fn image_generations_url(base_url: &str) -> Result<Url> {
    let url = parse_base_url(base_url, DEFAULT_OPENAI_BASE_URL)?;
    let path = normalized_path(&url);
    let lower = path.to_ascii_lowercase();
    if lower.ends_with("/images/generations") {
        return Ok(replace_path(url, path));
    }
    for endpoint in ["/chat/completions", "/responses"] {
        if lower.ends_with(endpoint) {
            let prefix = &path[..path.len() - endpoint.len()];
            return Ok(replace_path(url, format!("{prefix}/images/generations")));
        }
    }
    Ok(append_path(url, "images/generations"))
}

pub(crate) fn image_edits_url(base_url: &str) -> Result<Url> {
    let generations = image_generations_url(base_url)?;
    let path = normalized_path(&generations);
    let prefix = path
        .strip_suffix("/images/generations")
        .unwrap_or(path.as_str());
    Ok(replace_path(generations, format!("{prefix}/images/edits")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_endpoint_accepts_a_full_endpoint() {
        let url = chat_completions_url(" https://gateway.example/v1/chat/completions/ ").unwrap();
        assert_eq!(url.as_str(), "https://gateway.example/v1/chat/completions");
    }

    #[test]
    fn anthropic_endpoint_matches_electron_rules() {
        assert_eq!(
            anthropic_messages_url("https://api.anthropic.com/v1", "unused")
                .unwrap()
                .as_str(),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            anthropic_messages_url("https://gateway.example/v1/chat/completions", "unused")
                .unwrap()
                .as_str(),
            "https://gateway.example/v1/messages"
        );
        assert_eq!(
            anthropic_messages_url("https://gateway.example/api/anthropic", "unused")
                .unwrap()
                .as_str(),
            "https://gateway.example/api/anthropic/v1/messages"
        );
    }

    #[test]
    fn image_endpoint_replaces_a_full_chat_endpoint() {
        assert_eq!(
            image_generations_url("https://gateway.example/v1/chat/completions")
                .unwrap()
                .as_str(),
            "https://gateway.example/v1/images/generations"
        );
        assert_eq!(
            image_edits_url("https://gateway.example/v1/chat/completions")
                .unwrap()
                .as_str(),
            "https://gateway.example/v1/images/edits"
        );
        assert_eq!(
            responses_url("https://gateway.example/v1/chat/completions")
                .unwrap()
                .as_str(),
            "https://gateway.example/v1/responses"
        );
    }
}
