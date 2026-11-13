//! Deterministic microcompaction for low-value tool-result payloads.
//!
//! Microcompaction runs before full summarization. It only rewrites the
//! `content` field of selected `ToolResult` blocks: message roles, tool-use IDs,
//! block ordering, and call/result structure are never removed.

use std::collections::{HashMap, HashSet};

use sha2::{Digest, Sha256};
use worldbase_providers::{ContentBlock, LlmMessage};

use super::budget::TokenEstimator;

/// Tunable limits for one microcompaction pass.
#[derive(Debug, Clone)]
pub struct MicrocompactionPolicy {
    /// Exact newest result blocks to keep untouched.
    pub keep_newest_results: usize,
    /// Successful low-value results above this character count may be trimmed.
    pub max_result_chars: usize,
    /// Characters retained from the beginning of a trimmed result.
    pub head_chars: usize,
    /// Characters retained from the end of a trimmed result.
    pub tail_chars: usize,
    /// Replace older exact duplicate file reads/build logs with a reference to
    /// the newest identical result.
    pub deduplicate_exact_reads_and_logs: bool,
}

impl Default for MicrocompactionPolicy {
    fn default() -> Self {
        Self {
            keep_newest_results: 4,
            max_result_chars: 4_000,
            head_chars: 1_600,
            tail_chars: 1_200,
            deduplicate_exact_reads_and_logs: true,
        }
    }
}

/// Result metrics for a microcompaction pass.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MicrocompactionReport {
    pub results_seen: usize,
    pub results_compacted: usize,
    pub results_preserved: usize,
    pub duplicate_results_trimmed: usize,
    pub bytes_saved: usize,
    pub estimated_tokens_saved: usize,
}

/// Compatibility alias for the architecture's policy-oriented name.
pub type MicrocompactOptions = MicrocompactionPolicy;

/// Compatibility alias for the architecture's report-oriented name.
pub type MicrocompactReport = MicrocompactionReport;

/// Compact old successful tool results in place.
pub fn microcompact_messages(
    messages: &mut Vec<LlmMessage>,
    policy: &MicrocompactionPolicy,
    estimator: &TokenEstimator,
) -> MicrocompactionReport {
    microcompact_inner(messages, policy, estimator)
}

/// Alias for `microcompact_messages`.
pub fn microcompact(
    messages: &mut Vec<LlmMessage>,
    policy: &MicrocompactionPolicy,
    estimator: &TokenEstimator,
) -> MicrocompactionReport {
    microcompact_messages(messages, policy, estimator)
}

/// Convenience entry point using the default limits and an uncalibrated
/// estimator. Runtime callers should prefer `microcompact` with the calibrated
/// estimator used by their context engine.
pub fn microcompact_with_defaults(
    messages: &mut Vec<LlmMessage>,
    estimator: &TokenEstimator,
) -> MicrocompactionReport {
    microcompact(messages, &MicrocompactionPolicy::default(), estimator)
}

#[derive(Debug, Clone)]
struct ResultLocation {
    message_index: usize,
    block_index: usize,
    tool_use_id: String,
    tool_name: Option<String>,
    original_bytes: usize,
    original_chars: usize,
    digest: [u8; 32],
    protected: bool,
    low_value: bool,
    duplicate_eligible: bool,
}

fn microcompact_inner(
    messages: &mut Vec<LlmMessage>,
    options: &MicrocompactionPolicy,
    estimator: &TokenEstimator,
) -> MicrocompactionReport {
    let tool_names = collect_tool_names(messages);
    let locations = collect_result_locations(messages, &tool_names);
    let results_seen = locations.len();
    let before_bytes = total_result_bytes(messages);
    let before_tokens = estimator.estimate_messages(messages);
    let mut compacted = HashSet::new();
    let mut duplicate_results_trimmed = 0usize;

    if options.deduplicate_exact_reads_and_logs {
        let mut newest_by_content: HashMap<(String, [u8; 32]), String> = HashMap::new();
        let mut replacements = Vec::new();

        for (position, location) in locations.iter().enumerate().rev() {
            if !location.duplicate_eligible {
                continue;
            }
            let key = (
                location.tool_name.clone().unwrap_or_default(),
                location.digest,
            );
            if let Some(canonical_tool_use_id) = newest_by_content.get(&key) {
                if !is_in_newest_window(position, results_seen, options.keep_newest_results) {
                    replacements
                        .push((position, duplicate_marker(location, canonical_tool_use_id)));
                }
            } else {
                newest_by_content.insert(key, location.tool_use_id.clone());
            }
        }

        for (position, marker) in replacements {
            let location = &locations[position];
            if let Some(ContentBlock::ToolResult { content, .. }) = messages[location.message_index]
                .content
                .get_mut(location.block_index)
            {
                *content = marker;
                compacted.insert((location.message_index, location.block_index));
                duplicate_results_trimmed = duplicate_results_trimmed.saturating_add(1);
            }
        }
    }

    let (head_chars, tail_chars) = retained_edges(options);
    for (position, location) in locations.iter().enumerate() {
        if compacted.contains(&(location.message_index, location.block_index)) {
            continue;
        }
        if is_in_newest_window(position, results_seen, options.keep_newest_results)
            || location.protected
            || !location.low_value
            || location.original_chars <= options.max_result_chars
        {
            continue;
        }

        if let Some(ContentBlock::ToolResult { content, .. }) = messages[location.message_index]
            .content
            .get_mut(location.block_index)
        {
            *content = truncated_marker(location, content, head_chars, tail_chars);
            compacted.insert((location.message_index, location.block_index));
        }
    }

    let after_bytes = total_result_bytes(messages);
    let after_tokens = estimator.estimate_messages(messages);
    let results_compacted = compacted.len();

    MicrocompactionReport {
        results_seen,
        results_compacted,
        results_preserved: results_seen.saturating_sub(results_compacted),
        duplicate_results_trimmed,
        bytes_saved: before_bytes.saturating_sub(after_bytes),
        estimated_tokens_saved: before_tokens.saturating_sub(after_tokens),
    }
}

fn collect_tool_names(messages: &[LlmMessage]) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for message in messages {
        for block in &message.content {
            if let ContentBlock::ToolUse { id, name, .. } = block {
                names.insert(id.clone(), name.clone());
            }
        }
    }
    names
}

fn collect_result_locations(
    messages: &[LlmMessage],
    tool_names: &HashMap<String, String>,
) -> Vec<ResultLocation> {
    let mut locations = Vec::new();
    for (message_index, message) in messages.iter().enumerate() {
        for (block_index, block) in message.content.iter().enumerate() {
            let ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } = block
            else {
                continue;
            };
            let tool_name = tool_names.get(tool_use_id).cloned();
            let protected = is_protected_result(content, *is_error);
            locations.push(ResultLocation {
                message_index,
                block_index,
                tool_use_id: tool_use_id.clone(),
                tool_name: tool_name.clone(),
                original_bytes: content.len(),
                original_chars: content.chars().count(),
                digest: digest(content),
                protected,
                low_value: is_low_value_result(tool_name.as_deref(), content),
                duplicate_eligible: !protected
                    && is_duplicate_eligible(tool_name.as_deref(), content),
            });
        }
    }
    locations
}

fn total_result_bytes(messages: &[LlmMessage]) -> usize {
    messages.iter().fold(0usize, |total, message| {
        message.content.iter().fold(total, |total, block| {
            if let ContentBlock::ToolResult { content, .. } = block {
                total.saturating_add(content.len())
            } else {
                total
            }
        })
    })
}

fn is_in_newest_window(position: usize, total: usize, keep_newest: usize) -> bool {
    position >= total.saturating_sub(keep_newest)
}

fn retained_edges(options: &MicrocompactionPolicy) -> (usize, usize) {
    let head = options.head_chars.min(options.max_result_chars);
    let tail = options
        .tail_chars
        .min(options.max_result_chars.saturating_sub(head));
    (head, tail)
}

fn truncated_marker(
    location: &ResultLocation,
    content: &str,
    head_chars: usize,
    tail_chars: usize,
) -> String {
    let head = take_chars(content, head_chars);
    let tail = take_last_chars(content, tail_chars);
    let omitted_chars = location
        .original_chars
        .saturating_sub(head_chars.saturating_add(tail_chars));
    let tool = location.tool_name.as_deref().unwrap_or("unknown tool");
    format!(
        "[microcompact: old successful {tool} result trimmed; original {} bytes / {} chars; {} chars omitted from middle]\n{head}\n...[microcompact omitted {omitted_chars} chars]...\n{tail}",
        location.original_bytes, location.original_chars, omitted_chars
    )
}

fn duplicate_marker(location: &ResultLocation, canonical_tool_use_id: &str) -> String {
    let tool = location.tool_name.as_deref().unwrap_or("unknown tool");
    format!(
        "[microcompact: repeated successful {tool} result; identical to newer tool_use_id={canonical_tool_use_id}; original {} bytes / {} chars]",
        location.original_bytes, location.original_chars
    )
}

fn digest(content: &str) -> [u8; 32] {
    let digest = Sha256::digest(content.as_bytes());
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&digest);
    bytes
}

fn is_protected_result(content: &str, is_error: bool) -> bool {
    is_error
        || contains_diff(content)
        || contains_test_failure(content)
        || contains_schema_or_manifest_error(content)
        || contains_exact_error_signal(content)
}

fn contains_diff(content: &str) -> bool {
    if content.contains("diff --git ")
        || content.contains("*** Begin Patch")
        || content.contains("*** Update File:")
    {
        return true;
    }

    let mut has_old_file_header = false;
    let mut has_new_file_header = false;
    for line in content.lines() {
        has_old_file_header |= line.starts_with("--- ");
        has_new_file_header |= line.starts_with("+++ ");
        if line.starts_with("@@ ") && (has_old_file_header || has_new_file_header) {
            return true;
        }
    }
    has_old_file_header && has_new_file_header
}

fn contains_test_failure(content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    lower.contains("test failed")
        || lower.contains("tests failed")
        || lower.contains("test result: failed")
        || lower.contains("assertion failed")
        || lower.contains("panicked at")
        || lower.contains("panicked:")
        || lower.contains("\nfailures:")
        || lower.starts_with("failures:")
        || content.lines().any(|line| {
            let line = line.trim_start();
            line.starts_with("FAIL\t") || line.starts_with("FAILED")
        })
}

fn contains_schema_or_manifest_error(content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    lower.contains("manifest_invalid:")
        || lower.contains("invalid manifest")
        || lower.contains("manifest validation failed")
        || lower.contains("schema validation failed")
        || lower.contains("invalid schema")
        || (lower.contains("schema") && lower.contains("does not match"))
}

fn contains_exact_error_signal(content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    content.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with("error:")
            || trimmed.starts_with("error[")
            || trimmed.starts_with("error ")
            || trimmed.starts_with("fatal:")
            || trimmed.starts_with("panic:")
            || trimmed.starts_with("exception:")
            || trimmed.starts_with("traceback (most recent call last)")
            || trimmed.starts_with("could not compile")
    }) || lower.contains("manifest_invalid:")
        || lower.contains("\"error\":")
}

fn is_duplicate_eligible(tool_name: Option<&str>, content: &str) -> bool {
    is_file_read_tool(tool_name) || is_build_or_install_tool(tool_name) || looks_like_log(content)
}

fn is_low_value_result(tool_name: Option<&str>, content: &str) -> bool {
    // A unique file read can still be the only copy of the current file body;
    // exact repeats are handled by deduplication above instead.
    if is_file_read_tool(tool_name) {
        return false;
    }
    is_build_or_install_tool(tool_name)
        || is_command_or_search_tool(tool_name)
        || looks_like_log(content)
}

fn normalized_tool_name(tool_name: Option<&str>) -> String {
    tool_name
        .unwrap_or_default()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

fn is_file_read_tool(tool_name: Option<&str>) -> bool {
    let name = normalized_tool_name(tool_name);
    name.contains("read_file")
        || name == "read"
        || name.contains("view_file")
        || name.contains("open_file")
        || name.contains("cat_file")
}

fn is_build_or_install_tool(tool_name: Option<&str>) -> bool {
    let name = normalized_tool_name(tool_name);
    [
        "build", "install", "cargo", "npm", "pnpm", "yarn", "make", "gradle", "maven", "webpack",
        "vite", "turbo",
    ]
    .iter()
    .any(|marker| name.contains(marker))
}

fn is_command_or_search_tool(tool_name: Option<&str>) -> bool {
    let name = normalized_tool_name(tool_name);
    [
        "shell", "bash", "exec", "command", "terminal", "run", "search", "grep", "fetch",
        "browser", "web", "curl", "wget",
    ]
    .iter()
    .any(|marker| name.contains(marker))
}

fn looks_like_log(content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    [
        "compiling ",
        "finished dev",
        "finished release",
        "build succeeded",
        "build complete",
        "installing ",
        "installed ",
        "added ",
        "packages in",
        "npm warn",
        "npm notice",
        "pnpm install",
        "yarn install",
        "cargo build",
        "cargo test",
        "npm run build",
        "vite v",
        "webpack compiled",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn take_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn take_last_chars(value: &str, max_chars: usize) -> String {
    let total = value.chars().count();
    value
        .chars()
        .skip(total.saturating_sub(max_chars))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use worldbase_providers::LlmRole;

    fn options(max_result_chars: usize, keep_newest_results: usize) -> MicrocompactionPolicy {
        MicrocompactionPolicy {
            keep_newest_results,
            max_result_chars,
            head_chars: 20,
            tail_chars: 20,
            deduplicate_exact_reads_and_logs: true,
        }
    }

    fn push_exchange(
        messages: &mut Vec<LlmMessage>,
        id: &str,
        tool_name: &str,
        content: String,
        is_error: bool,
    ) {
        messages.push(LlmMessage {
            role: LlmRole::Assistant,
            content: vec![ContentBlock::ToolUse {
                id: id.into(),
                name: tool_name.into(),
                input: json!({}),
                raw_input: None,
                input_error: None,
            }],
        });
        messages.push(LlmMessage {
            role: LlmRole::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: id.into(),
                content,
                is_error,
            }],
        });
    }

    fn result_content(messages: &[LlmMessage], id: &str) -> String {
        messages
            .iter()
            .flat_map(|message| &message.content)
            .find_map(|block| match block {
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    ..
                } if tool_use_id == id => Some(content.clone()),
                _ => None,
            })
            .unwrap()
    }

    #[test]
    fn old_successful_build_log_is_compacted() {
        let estimator = TokenEstimator::new();
        let mut messages = Vec::new();
        for index in 0..6 {
            push_exchange(
                &mut messages,
                &format!("build-{index}"),
                "run_command",
                format!(
                    "Compiling worldbase batch {index}\n{}\nFinished dev profile {index}",
                    "compiler output line\n".repeat(80)
                ),
                false,
            );
        }

        let report = microcompact(&mut messages, &options(200, 2), &estimator);
        let old_content = result_content(&messages, "build-0");

        assert_eq!(messages.len(), 12);
        assert_eq!(report.results_compacted, 4);
        assert!(report.bytes_saved > 0);
        assert!(old_content.starts_with("[microcompact: old successful run_command"));
        assert!(old_content.contains("original"));
        assert!(old_content.contains("bytes"));
        assert!(!result_content(&messages, "build-5").contains("[microcompact"));
    }

    #[test]
    fn exact_error_is_kept_verbatim() {
        let estimator = TokenEstimator::new();
        let mut messages = vec![LlmMessage::text(
            LlmRole::User,
            "Fix the manifest validation failure",
        )];
        let error = format!(
            "manifest_invalid: version must be semver\n{}",
            "schema stack line\n".repeat(100)
        );
        push_exchange(
            &mut messages,
            "error-1",
            "run_command",
            error.clone(),
            false,
        );

        let report = microcompact(&mut messages, &options(20, 0), &estimator);

        assert_eq!(result_content(&messages, "error-1"), error);
        assert_eq!(report.results_compacted, 0);
        assert_eq!(report.results_preserved, 1);
        assert_eq!(
            messages.first().unwrap().text_view(),
            "Fix the manifest validation failure"
        );
    }

    #[test]
    fn diff_is_kept_verbatim() {
        let estimator = TokenEstimator::new();
        let mut messages = Vec::new();
        let diff = format!(
            "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1 @@\n{}\n+fn fixed() {{}}",
            "-old\n".repeat(100)
        );
        push_exchange(&mut messages, "diff-1", "apply_patch", diff.clone(), false);

        let report = microcompact(&mut messages, &options(20, 0), &estimator);

        assert_eq!(result_content(&messages, "diff-1"), diff);
        assert_eq!(report.results_compacted, 0);
    }

    #[test]
    fn newest_tool_result_is_always_kept() {
        let estimator = TokenEstimator::new();
        let mut messages = Vec::new();
        let old_content = "Compiling old\n".repeat(100);
        let newest_content = "Compiling newest\n".repeat(100);
        push_exchange(&mut messages, "old-1", "run_command", old_content, false);
        push_exchange(
            &mut messages,
            "new-1",
            "run_command",
            newest_content.clone(),
            false,
        );

        let report = microcompact(&mut messages, &options(20, 1), &estimator);

        assert!(result_content(&messages, "old-1").contains("[microcompact"));
        assert_eq!(result_content(&messages, "new-1"), newest_content);
        assert_eq!(report.results_compacted, 1);
        assert_eq!(report.results_preserved, 1);
    }

    #[test]
    fn repeated_file_read_is_replaced_without_removing_pairing() {
        let estimator = TokenEstimator::new();
        let mut messages = Vec::new();
        let repeated = "line one\nline two\n".repeat(100);
        push_exchange(
            &mut messages,
            "read-1",
            "read_file",
            repeated.clone(),
            false,
        );
        push_exchange(
            &mut messages,
            "read-2",
            "read_file",
            repeated.clone(),
            false,
        );

        let report = microcompact(&mut messages, &options(10_000, 1), &estimator);
        let first = result_content(&messages, "read-1");

        assert!(first.contains("identical to newer tool_use_id=read-2"));
        assert_eq!(result_content(&messages, "read-2"), repeated);
        assert_eq!(report.duplicate_results_trimmed, 1);
        assert_eq!(messages.len(), 4);

        let tool_use_ids: HashSet<_> = messages
            .iter()
            .flat_map(|message| &message.content)
            .filter_map(|block| match block {
                ContentBlock::ToolUse { id, .. } => Some(id.as_str()),
                _ => None,
            })
            .collect();
        let result_ids: HashSet<_> = messages
            .iter()
            .flat_map(|message| &message.content)
            .filter_map(|block| match block {
                ContentBlock::ToolResult { tool_use_id, .. } => Some(tool_use_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(tool_use_ids, result_ids);
    }
}
