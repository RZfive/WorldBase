//! Token estimation, context-window budgets, and token-aware recent-window selection.
//!
//! The estimator uses `cl100k_base` when it can be initialized once, but never
//! makes the agent path depend on tokenizer availability. Its calibrated value
//! is a small deterministic multiplier over a tokenizer count or a conservative
//! language/code-aware fallback.

use std::collections::{BTreeSet, HashSet};
use std::sync::OnceLock;

use tiktoken_rs::CoreBPE;
use worldbase_providers::{ContentBlock, LlmMessage, LlmRole, LlmTool};

static TOKENIZER: OnceLock<Option<CoreBPE>> = OnceLock::new();

const MESSAGE_OVERHEAD_TOKENS: usize = 8;
const BLOCK_OVERHEAD_TOKENS: usize = 3;
const TOOL_OVERHEAD_TOKENS: usize = 16;
const REQUEST_OVERHEAD_TOKENS: usize = 16;
const IMAGE_ESTIMATE_TOKENS: usize = 1_600;

const CALIBRATION_MIN: f64 = 0.5;
const CALIBRATION_MAX: f64 = 2.0;
const CALIBRATION_SMOOTHING: f64 = 0.15;
const CALIBRATION_SAMPLE_MIN: f64 = 0.5;
const CALIBRATION_SAMPLE_MAX: f64 = 2.0;

const BACKGROUND_THRESHOLD_PERCENT: usize = 62;
const COMPACTION_THRESHOLD_PERCENT: usize = 82;
const SUMMARY_BUDGET_PERCENT: usize = 20;
const SAFETY_MARGIN_DIVISOR: usize = 32;
const MIN_SAFETY_MARGIN_TOKENS: usize = 256;
const MAX_SAFETY_MARGIN_TOKENS: usize = 8_192;

fn tokenizer() -> Option<&'static CoreBPE> {
    match TOKENIZER.get_or_init(|| tiktoken_rs::cl100k_base().ok()) {
        Some(tokenizer) => Some(tokenizer),
        None => None,
    }
}

/// Cheap, deterministic token estimator.
///
/// `Clone` and `Copy` are intentional: callers may retain calibrated instances
/// without cloning tokenizer tables or allocating on every estimate.
#[derive(Debug, Clone, Copy)]
pub struct TokenEstimator {
    calibration: f64,
}

impl Default for TokenEstimator {
    fn default() -> Self {
        Self::new()
    }
}

impl TokenEstimator {
    /// Create an uncalibrated estimator.
    pub const fn new() -> Self {
        Self { calibration: 1.0 }
    }

    /// Current bounded multiplier applied to raw tokenizer/fallback counts.
    pub fn calibration(&self) -> f64 {
        self.calibration
    }

    /// Estimate raw text. Tokens are counted with `cl100k_base` when available
    /// and with a conservative heuristic otherwise.
    pub fn estimate_text(&self, text: &str) -> usize {
        let raw = match tokenizer() {
            Some(tokenizer) => tokenizer.encode_ordinary(text).len(),
            None => heuristic_text_tokens(text),
        };
        self.apply_calibration(raw)
    }

    /// Estimate raw text using only the language/code-aware fallback heuristic.
    /// This is public so callers can budget even before an estimator is built.
    pub fn estimate_text_heuristic(&self, text: &str) -> usize {
        self.apply_calibration(heuristic_text_tokens(text))
    }

    /// Estimate one content block, excluding message envelope overhead.
    pub fn estimate_block(&self, block: &ContentBlock) -> usize {
        let raw = match block {
            ContentBlock::Text { text } => self.estimate_text(text),
            ContentBlock::ImageUrl { .. } => self.apply_calibration(IMAGE_ESTIMATE_TOKENS),
            ContentBlock::Thinking {
                thinking,
                signature,
            } => self
                .estimate_text(thinking)
                .saturating_add(self.estimate_text(signature)),
            ContentBlock::RedactedThinking { data } => self.estimate_text(data),
            ContentBlock::ToolUse {
                id,
                name,
                input,
                raw_input,
                input_error,
            } => self
                .estimate_text(id)
                .saturating_add(self.estimate_text(name))
                .saturating_add(self.estimate_json(input))
                .saturating_add(
                    raw_input
                        .as_deref()
                        .map_or(0, |input| self.estimate_text(input)),
                )
                .saturating_add(
                    input_error
                        .as_deref()
                        .map_or(0, |error| self.estimate_text(error)),
                )
                .saturating_add(BLOCK_OVERHEAD_TOKENS),
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                ..
            } => self
                .estimate_text(tool_use_id)
                .saturating_add(self.estimate_text(content))
                .saturating_add(BLOCK_OVERHEAD_TOKENS),
        };
        raw.saturating_add(BLOCK_OVERHEAD_TOKENS)
    }

    /// Estimate a message including role/protocol envelope overhead.
    pub fn estimate_message(&self, message: &LlmMessage) -> usize {
        message
            .content
            .iter()
            .fold(MESSAGE_OVERHEAD_TOKENS, |total, block| {
                total.saturating_add(self.estimate_block(block))
            })
    }

    /// Estimate a message list including every message envelope.
    pub fn estimate_messages(&self, messages: &[LlmMessage]) -> usize {
        messages.iter().fold(0usize, |total, message| {
            total.saturating_add(self.estimate_message(message))
        })
    }

    /// Estimate one provider tool definition.
    pub fn estimate_tool(&self, tool: &LlmTool) -> usize {
        TOOL_OVERHEAD_TOKENS
            .saturating_add(self.estimate_text(&tool.name))
            .saturating_add(self.estimate_text(&tool.description))
            .saturating_add(self.estimate_json(&tool.input_schema))
    }

    /// Estimate all provider tool definitions.
    pub fn estimate_tools(&self, tools: &[LlmTool]) -> usize {
        tools.iter().fold(0usize, |total, tool| {
            total.saturating_add(self.estimate_tool(tool))
        })
    }

    /// Estimate a complete request body.
    ///
    /// Provider-specific framing differs, so the result is a stable common
    /// baseline. Provider usage calibration should be applied after the first
    /// completed request.
    pub fn estimate_request(
        &self,
        system: &str,
        messages: &[LlmMessage],
        tools: &[LlmTool],
    ) -> usize {
        REQUEST_OVERHEAD_TOKENS
            .saturating_add(self.estimate_text(system))
            .saturating_add(self.estimate_messages(messages))
            .saturating_add(self.estimate_tools(tools))
    }

    /// Update calibration from provider-reported input usage.
    ///
    /// The observed ratio is clamped and blended with bounded exponential
    /// smoothing, so a single malformed or extreme usage report cannot collapse
    /// or explode future estimates.
    pub fn calibrate_from_actual(&mut self, estimated_tokens: usize, actual_input_tokens: u64) {
        if estimated_tokens == 0 || actual_input_tokens == 0 {
            return;
        }

        let sample_ratio = actual_input_tokens as f64 / estimated_tokens as f64;
        let bounded_sample = sample_ratio.clamp(CALIBRATION_SAMPLE_MIN, CALIBRATION_SAMPLE_MAX);
        let next = self.calibration * (1.0 - CALIBRATION_SMOOTHING)
            + bounded_sample * CALIBRATION_SMOOTHING;
        self.calibration = next.clamp(CALIBRATION_MIN, CALIBRATION_MAX);
    }

    /// Convenience variant with provider usage first.
    pub fn observe_actual_input(&mut self, actual_input_tokens: u64, estimated_tokens: usize) {
        self.calibrate_from_actual(estimated_tokens, actual_input_tokens);
    }

    /// Estimate and calibrate a complete request from provider-reported usage.
    pub fn calibrate_request(
        &mut self,
        system: &str,
        messages: &[LlmMessage],
        tools: &[LlmTool],
        actual_input_tokens: u64,
    ) {
        let estimated = self.estimate_request(system, messages, tools);
        self.calibrate_from_actual(estimated, actual_input_tokens);
    }

    fn estimate_json(&self, value: &serde_json::Value) -> usize {
        match serde_json::to_string(value) {
            Ok(serialized) => self.estimate_text(&serialized),
            Err(_) => self.estimate_text_heuristic(&value.to_string()),
        }
    }

    fn apply_calibration(&self, raw_tokens: usize) -> usize {
        if raw_tokens == 0 {
            return 0;
        }
        ((raw_tokens as f64) * self.calibration).ceil() as usize
    }
}

/// Input/output allocation for one provider request.
///
/// The three reserved quantities always fit inside the context window:
/// `available_input_tokens + actual_max_output_tokens + safety_margin_tokens
/// <= context_window_tokens`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenBudget {
    pub context_window_tokens: usize,
    /// Output reservation, clamped to the context window for pathological
    /// configurations. For normal inputs this equals the requested max output.
    pub actual_max_output_tokens: usize,
    pub safety_margin_tokens: usize,
    pub available_input_tokens: usize,
    pub background_threshold_tokens: usize,
    pub compaction_threshold_tokens: usize,
    pub summary_budget_tokens: usize,
    pub recent_raw_budget_tokens: usize,
}

impl TokenBudget {
    pub const DEFAULT_CONTEXT_WINDOW_TOKENS: usize = 32_000;
    pub const DEFAULT_MAX_OUTPUT_TOKENS: usize = 8_192;

    /// Allocate the context window using the request's real output maximum and
    /// a modest proportional safety margin, capped so tiny windows remain
    /// usable.
    pub fn new(context_window_tokens: usize, actual_max_output_tokens: usize) -> Self {
        let context_window_tokens = context_window_tokens.max(1);
        let actual_max_output_tokens = actual_max_output_tokens.min(context_window_tokens);
        let output_and_remaining = context_window_tokens.saturating_sub(actual_max_output_tokens);
        let margin_target = (context_window_tokens / SAFETY_MARGIN_DIVISOR)
            .clamp(MIN_SAFETY_MARGIN_TOKENS, MAX_SAFETY_MARGIN_TOKENS);
        let safety_margin_tokens = margin_target.min(output_and_remaining);
        let available_input_tokens = output_and_remaining.saturating_sub(safety_margin_tokens);

        Self {
            context_window_tokens,
            actual_max_output_tokens,
            safety_margin_tokens,
            available_input_tokens,
            background_threshold_tokens: percentage(
                available_input_tokens,
                BACKGROUND_THRESHOLD_PERCENT,
            ),
            compaction_threshold_tokens: percentage(
                available_input_tokens,
                COMPACTION_THRESHOLD_PERCENT,
            ),
            summary_budget_tokens: percentage(available_input_tokens, SUMMARY_BUDGET_PERCENT),
            recent_raw_budget_tokens: available_input_tokens.div_ceil(8),
        }
    }

    /// The 32k fallback budget with WorldBase's normal 8,192-token output cap.
    pub fn fallback_32k() -> Self {
        Self::new(
            Self::DEFAULT_CONTEXT_WINDOW_TOKENS,
            Self::DEFAULT_MAX_OUTPUT_TOKENS,
        )
    }

    pub fn should_start_background(&self, estimated_input_tokens: usize) -> bool {
        self.available_input_tokens > 0
            && estimated_input_tokens >= self.background_threshold_tokens
    }

    pub fn should_compact(&self, estimated_input_tokens: usize) -> bool {
        self.available_input_tokens > 0
            && estimated_input_tokens >= self.compaction_threshold_tokens
    }

    pub fn remaining_input_tokens(&self, estimated_input_tokens: usize) -> usize {
        self.available_input_tokens
            .saturating_sub(estimated_input_tokens)
    }
}

impl Default for TokenBudget {
    fn default() -> Self {
        Self::fallback_32k()
    }
}

/// Result of selecting a token-bounded recent raw window.
#[derive(Debug, Clone)]
pub struct RecentWindow {
    /// Selected messages in chronological order.
    pub messages: Vec<LlmMessage>,
    /// Original indices matching `messages`, sorted ascending. This is the
    /// authoritative mapping when preserving the latest user request creates a
    /// safe non-contiguous window.
    pub selected_indices: Vec<usize>,
    /// Index of the first selected message, or `messages.len()` when empty.
    /// A Manager can subtract one to derive the last summarized message.
    pub boundary_index: usize,
    pub token_count: usize,
    pub newest_real_user_index: Option<usize>,
    pub includes_newest_real_user: bool,
}

impl RecentWindow {
    pub fn is_contiguous(&self) -> bool {
        self.selected_indices
            .windows(2)
            .all(|pair| pair[1] == pair[0].saturating_add(1))
    }

    pub fn end_index(&self) -> usize {
        self.selected_indices
            .last()
            .map_or(self.boundary_index, |index| index.saturating_add(1))
    }

    /// Index immediately before the earliest kept message. This is meaningful
    /// as a contiguous summary boundary; `selected_indices` remains
    /// authoritative if `is_contiguous` is false.
    pub fn last_summarized_index(&self) -> Option<usize> {
        self.boundary_index.checked_sub(1)
    }
}

/// Alias retained for call sites that use the architecture's full name.
pub type RecentRawWindow = RecentWindow;

#[derive(Debug)]
struct MessageUnit {
    indices: Vec<usize>,
    token_count: usize,
    has_unpaired_tool_result: bool,
}

/// Select the newest protocol-safe messages that fit `max_tokens`.
///
/// Tool-call/result exchanges are grouped before budgeting. Orphan tool results
/// are never selected. The newest user-authored request is reserved first when
/// it fits, so a long tool tail cannot silently evict the in-flight request.
pub fn recent_window(
    messages: &[LlmMessage],
    max_tokens: usize,
    estimator: &TokenEstimator,
) -> RecentWindow {
    select_recent_window(messages, max_tokens, estimator)
}

/// Full-name alias for `recent_window`.
pub fn select_recent_window(
    messages: &[LlmMessage],
    max_tokens: usize,
    estimator: &TokenEstimator,
) -> RecentWindow {
    let newest_real_user_index = messages
        .iter()
        .enumerate()
        .rev()
        .find(|(_, message)| is_real_user_message(message))
        .map(|(index, _)| index);

    let units = build_message_units(messages, estimator);
    let mut selected = BTreeSet::new();
    let mut remaining = max_tokens;

    if let Some(index) = newest_real_user_index {
        let cost = estimator.estimate_message(&messages[index]);
        if cost <= remaining {
            selected.insert(index);
            remaining = remaining.saturating_sub(cost);
        }
    }

    for unit in units.iter().rev() {
        if unit.has_unpaired_tool_result {
            continue;
        }
        if unit.indices.iter().all(|index| selected.contains(index)) {
            continue;
        }
        if unit.indices.iter().any(|index| selected.contains(index)) {
            // A reservation should always be a standalone user message. If a
            // malformed unit overlaps it, avoid partially duplicating a batch.
            continue;
        }
        if unit.token_count > remaining {
            // The newest complete unit is too large. Stopping here prevents an
            // older, non-contiguous message from masquerading as the recent
            // window tail.
            break;
        }
        for index in &unit.indices {
            selected.insert(*index);
        }
        remaining = remaining.saturating_sub(unit.token_count);
    }

    let selected_indices: Vec<usize> = selected.iter().copied().collect();
    let boundary_index = selected_indices.first().copied().unwrap_or(messages.len());
    let token_count = selected_indices.iter().fold(0usize, |total, index| {
        total.saturating_add(estimator.estimate_message(&messages[*index]))
    });
    let includes_newest_real_user =
        newest_real_user_index.is_some_and(|index| selected.contains(&index));
    let selected_messages = selected_indices
        .iter()
        .map(|index| messages[*index].clone())
        .collect();

    RecentWindow {
        messages: selected_messages,
        selected_indices,
        boundary_index,
        token_count,
        newest_real_user_index,
        includes_newest_real_user,
    }
}

fn build_message_units(messages: &[LlmMessage], estimator: &TokenEstimator) -> Vec<MessageUnit> {
    let mut units = Vec::new();
    let mut index = 0usize;

    while index < messages.len() {
        let mut end = index + 1;
        if has_tool_use(&messages[index]) {
            let use_ids = tool_use_ids(&messages[index]);
            while end < messages.len()
                && messages[end].role == LlmRole::User
                && has_tool_result(&messages[end])
            {
                let result_ids = tool_result_ids(&messages[end]);
                if result_ids.is_empty() || !result_ids.iter().all(|id| use_ids.contains(*id)) {
                    break;
                }
                end += 1;
            }
        }

        let indices: Vec<usize> = (index..end).collect();
        let token_count = indices.iter().fold(0usize, |total, message_index| {
            total.saturating_add(estimator.estimate_message(&messages[*message_index]))
        });
        let has_unpaired_tool_result = unit_has_unpaired_tool_result(messages, &indices);
        units.push(MessageUnit {
            indices,
            token_count,
            has_unpaired_tool_result,
        });
        index = end;
    }

    units
}

fn unit_has_unpaired_tool_result(messages: &[LlmMessage], indices: &[usize]) -> bool {
    let mut tool_uses = HashSet::new();
    let mut tool_results = Vec::new();
    for index in indices {
        for block in &messages[*index].content {
            match block {
                ContentBlock::ToolUse { id, .. } => {
                    tool_uses.insert(id.as_str());
                }
                ContentBlock::ToolResult { tool_use_id, .. } => {
                    tool_results.push(tool_use_id.as_str());
                }
                _ => {}
            }
        }
    }
    tool_results
        .into_iter()
        .any(|tool_use_id| !tool_uses.contains(tool_use_id))
}

fn is_real_user_message(message: &LlmMessage) -> bool {
    message.role == LlmRole::User
        && !message.content.is_empty()
        && !message
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolResult { .. }))
}

fn has_tool_use(message: &LlmMessage) -> bool {
    message
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolUse { .. }))
}

fn has_tool_result(message: &LlmMessage) -> bool {
    message
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolResult { .. }))
}

fn tool_use_ids(message: &LlmMessage) -> HashSet<&str> {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse { id, .. } => Some(id.as_str()),
            _ => None,
        })
        .collect()
}

fn tool_result_ids(message: &LlmMessage) -> Vec<&str> {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolResult { tool_use_id, .. } => Some(tool_use_id.as_str()),
            _ => None,
        })
        .collect()
}

fn percentage(value: usize, percent: usize) -> usize {
    value.saturating_mul(percent) / 100
}

fn heuristic_text_tokens(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }

    fn flush_ascii_run(total: &mut usize, chars: &mut usize) {
        if *chars > 0 {
            *total = total.saturating_add((*chars).div_ceil(4));
            *chars = 0;
        }
    }

    let mut total = 0usize;
    let mut ascii_word_chars = 0usize;
    let mut ascii_space_chars = 0usize;

    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            flush_ascii_run(&mut total, &mut ascii_space_chars);
            ascii_word_chars = ascii_word_chars.saturating_add(1);
        } else if ch.is_ascii_whitespace() {
            flush_ascii_run(&mut total, &mut ascii_word_chars);
            ascii_space_chars = ascii_space_chars.saturating_add(1);
        } else {
            flush_ascii_run(&mut total, &mut ascii_word_chars);
            flush_ascii_run(&mut total, &mut ascii_space_chars);
            // Dense code/punctuation and CJK are deliberately more expensive
            // than the old chars/4 assumption. Other Unicode is treated with
            // the same conservative one-token floor.
            total = total.saturating_add(1);
        }
    }
    flush_ascii_run(&mut total, &mut ascii_word_chars);
    flush_ascii_run(&mut total, &mut ascii_space_chars);
    total.max(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool_use(id: &str, name: &str) -> LlmMessage {
        LlmMessage {
            role: LlmRole::Assistant,
            content: vec![ContentBlock::ToolUse {
                id: id.into(),
                name: name.into(),
                input: json!({"path": "src/lib.rs"}),
                raw_input: None,
                input_error: None,
            }],
        }
    }

    fn tool_result(id: &str, content: &str) -> LlmMessage {
        LlmMessage {
            role: LlmRole::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: id.into(),
                content: content.into(),
                is_error: false,
            }],
        }
    }

    #[test]
    fn fallback_32k_budget_reserves_output_and_safety() {
        let budget = TokenBudget::new(32_000, 8_192);
        assert_eq!(
            budget.available_input_tokens
                + budget.actual_max_output_tokens
                + budget.safety_margin_tokens,
            32_000
        );
        assert!(budget.safety_margin_tokens > 0);
        assert!(budget.background_threshold_tokens * 100 >= budget.available_input_tokens * 60);
        assert!(budget.background_threshold_tokens * 100 <= budget.available_input_tokens * 65);
        assert!(budget.compaction_threshold_tokens * 100 >= budget.available_input_tokens * 80);
        assert!(budget.compaction_threshold_tokens * 100 <= budget.available_input_tokens * 85);
        assert!(budget.recent_raw_budget_tokens < 12_000);
        assert!(budget.summary_budget_tokens > 0);
    }

    #[test]
    fn cjk_and_dense_code_fallback_is_more_conservative_than_prose() {
        let estimator = TokenEstimator::new();
        let prose = "a".repeat(160);
        let cjk = "漢".repeat(160);
        let code = "{}".repeat(80);

        let prose_tokens = estimator.estimate_text_heuristic(&prose);
        let cjk_tokens = estimator.estimate_text_heuristic(&cjk);
        let code_tokens = estimator.estimate_text_heuristic(&code);

        assert!(cjk_tokens > prose_tokens);
        assert!(code_tokens > prose_tokens);
        assert!(cjk_tokens >= 160);
        assert!(code_tokens >= 160);
    }

    #[test]
    fn calibration_moves_toward_actual_usage_without_single_outlier_runaway() {
        let mut estimator = TokenEstimator::new();
        let initial = estimator.calibration();

        estimator.calibrate_from_actual(100, 200);
        let after_high = estimator.calibration();
        assert!(after_high > initial);
        assert!(after_high < 1.5);

        estimator.calibrate_from_actual(100, 100_000);
        let after_outlier = estimator.calibration();
        assert!(after_outlier >= after_high);
        assert!(after_outlier <= CALIBRATION_MAX);
        assert!(after_outlier - after_high < 0.15);

        estimator.calibrate_from_actual(100, 20);
        assert!(estimator.calibration() < after_outlier);
        assert!(estimator.calibration() >= CALIBRATION_MIN);
    }

    #[test]
    fn recent_window_does_not_split_tool_call_and_result_pair() {
        let estimator = TokenEstimator::new();
        let messages = vec![
            LlmMessage::text(LlmRole::User, "old request ".repeat(2_000)),
            tool_use("call-1", "read_file"),
            tool_result("call-1", &"file contents ".repeat(200)),
        ];
        let pair_cost =
            estimator.estimate_message(&messages[1]) + estimator.estimate_message(&messages[2]);

        let window = select_recent_window(&messages, pair_cost, &estimator);

        assert_eq!(window.selected_indices, vec![1, 2]);
        assert_eq!(window.boundary_index, 1);
        assert!(window.messages[0]
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolUse { id, .. } if id == "call-1")));
        assert!(window.messages[1].content.iter().any(
            |block| matches!(block, ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == "call-1")
        ));
    }

    #[test]
    fn recent_window_keeps_latest_user_request_when_it_fits() {
        let estimator = TokenEstimator::new();
        let messages = vec![
            LlmMessage::text(LlmRole::User, "older request"),
            LlmMessage::text(LlmRole::Assistant, "older answer ".repeat(2_000)),
            LlmMessage::text(LlmRole::User, "current in-flight request"),
        ];
        let user_cost = estimator.estimate_message(&messages[2]);

        let window = select_recent_window(&messages, user_cost, &estimator);

        assert!(window.includes_newest_real_user);
        assert_eq!(window.newest_real_user_index, Some(2));
        assert_eq!(window.selected_indices, vec![2]);
        assert_eq!(window.messages[0].text_view(), "current in-flight request");
    }

    #[test]
    fn recent_window_never_starts_with_an_orphan_tool_result() {
        let estimator = TokenEstimator::new();
        let messages = vec![
            LlmMessage::text(LlmRole::User, "request"),
            tool_result("orphan", "result"),
        ];

        let window = select_recent_window(&messages, 10_000, &estimator);

        assert_eq!(window.selected_indices, vec![0]);
        assert!(!window.messages.first().is_some_and(|message| message
            .content
            .iter()
            .any(|block| matches!(block, ContentBlock::ToolResult { .. }))));
    }
}
