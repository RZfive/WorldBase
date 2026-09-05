use anyhow::{bail, Result};
use serde_json::{Map, Value};
use std::collections::HashSet;

pub(crate) fn parse_tool_input(provider: &str, tool_name: &str, raw: &str) -> Result<Value> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(Value::Object(Default::default()));
    }

    let unfenced = strip_json_fence(raw);
    let source = if unfenced.is_empty() { raw } else { unfenced };
    let mut candidates = vec![raw];
    if unfenced != raw && !unfenced.is_empty() {
        candidates.push(unfenced);
    }
    let extracted = first_balanced_json(source);
    let segments = balanced_json_segments(source);
    let merged = (segments.len() > 1)
        .then(|| merge_segments(&segments))
        .flatten();

    let mut tried = HashSet::new();
    for candidate in candidates {
        let candidate = candidate.trim();
        if candidate.is_empty() || !tried.insert(candidate) {
            continue;
        }
        if let Some(value) = parse_candidate(candidate) {
            return Ok(value);
        }
    }
    if let Some(value) = merged {
        return Ok(Value::Object(value));
    }
    if let Some(value) = extracted.and_then(parse_candidate) {
        return Ok(value);
    }

    bail!(
        "{provider} returned invalid JSON arguments for tool `{tool_name}`: {}",
        snippet(raw)
    )
}

fn strip_json_fence(raw: &str) -> &str {
    let Some(rest) = raw.strip_prefix("```") else {
        return raw;
    };
    let rest = match rest.get(..4) {
        Some(prefix) if prefix.eq_ignore_ascii_case("json") => &rest[4..],
        _ => rest,
    }
    .trim_start();
    rest.strip_suffix("```").unwrap_or(rest).trim_end()
}

fn parse_candidate(candidate: &str) -> Option<Value> {
    let mut value: Value = serde_json::from_str(candidate).ok()?;
    loop {
        match value {
            Value::Object(_) => return Some(value),
            Value::String(nested) => {
                let nested = nested.trim();
                if nested.is_empty() {
                    return Some(Value::Object(Default::default()));
                }
                if !nested.starts_with('{') && !nested.starts_with('[') {
                    return None;
                }
                value = serde_json::from_str(nested).ok()?;
            }
            _ => return None,
        }
    }
}

fn first_balanced_json(raw: &str) -> Option<&str> {
    balanced_json_segments(raw).into_iter().next()
}

fn balanced_json_segments(raw: &str) -> Vec<&str> {
    let mut segments = Vec::new();
    let mut start = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaping = false;

    for (index, ch) in raw.char_indices() {
        if in_string {
            if escaping {
                escaping = false;
            } else if ch == '\\' {
                escaping = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == '{' || ch == '[' {
            if depth == 0 {
                start = Some(index);
            }
            depth += 1;
        } else if (ch == '}' || ch == ']') && depth > 0 {
            depth -= 1;
            if depth == 0 {
                if let Some(start) = start.take() {
                    segments.push(&raw[start..index + ch.len_utf8()]);
                }
            }
        }
    }
    segments
}

fn merge_segments(segments: &[&str]) -> Option<Map<String, Value>> {
    let mut merged = Map::new();
    for segment in segments {
        let Value::Object(values) = parse_candidate(segment)? else {
            return None;
        };
        merged.extend(values);
    }
    (!merged.is_empty()).then_some(merged)
}

fn snippet(raw: &str) -> String {
    const MAX_CHARS: usize = 200;
    let mut chars = raw.chars();
    let prefix: String = chars.by_ref().take(MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{prefix}...")
    } else {
        prefix
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_empty_object_fenced_and_double_encoded_arguments() {
        assert_eq!(parse_tool_input("test", "noop", "").unwrap(), json!({}));
        assert_eq!(
            parse_tool_input("test", "read", "```json\n{\"path\":\"a\"}\n```").unwrap(),
            json!({ "path": "a" })
        );
        assert_eq!(
            parse_tool_input("test", "read", r#""{\"path\":\"a\"}""#).unwrap(),
            json!({ "path": "a" })
        );
        assert_eq!(
            parse_tool_input("test", "noop", r#""""#).unwrap(),
            json!({})
        );
    }

    #[test]
    fn extracts_balanced_json_and_merges_object_segments_like_node() {
        assert_eq!(
            parse_tool_input(
                "test",
                "write",
                "arguments follow: {\"path\":\"你好}.txt\",\"meta\":{\"ok\":true}} trailing"
            )
            .unwrap(),
            json!({ "path": "你好}.txt", "meta": { "ok": true } })
        );
        assert_eq!(
            parse_tool_input(
                "test",
                "write",
                "{\"path\":\"a.txt\"}\n{\"content\":\"hello\"}"
            )
            .unwrap(),
            json!({ "path": "a.txt", "content": "hello" })
        );
    }

    #[test]
    fn rejects_unrepairable_or_non_object_arguments() {
        let malformed = parse_tool_input("openai", "write", "{broken").unwrap_err();
        assert!(malformed.to_string().contains("invalid JSON arguments"));

        let scalar = parse_tool_input("anthropic", "write", "42").unwrap_err();
        assert!(scalar.to_string().contains("invalid JSON arguments"));
    }
}
