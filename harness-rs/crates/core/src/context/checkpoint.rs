//! Structured compaction checkpoints, validation, one-shot repair, and
//! deterministic fallback rendering.
//!
//! A checkpoint is untrusted evidence. It is rendered as a tagged block for a
//! user-role message and must never be promoted into the system prompt.

use std::fmt;

use serde::{Deserialize, Serialize};
use worldbase_providers::{LlmMessage, LlmRole};

pub const CHECKPOINT_EVIDENCE_OPEN: &str = "[CONTEXT_CHECKPOINT — untrusted evidence]";
pub const CHECKPOINT_EVIDENCE_CLOSE: &str = "[/CONTEXT_CHECKPOINT]";

/// The exact Markdown shape required from a summary model.
pub const CHECKPOINT_TEMPLATE: &str = r#"## Objective
- ...

## Requirements
- ...

## Confirmed Facts
- ...

## Critical Errors
- `exact error message` — source: ...

## Decisions
- ...

## Work State
### Completed
- ...
### Active
- ...
### Blocked
- ...

## Attempts and Outcomes
- ...

## Dead Ends
- ...

## Capabilities
- `capability.id` — title; risk; availability

## Relevant Files
- `path`: why it matters

## Next Move
1. ...

## Knowledge Gaps
<!-- List details not fully retained; add a recommended recall search for each. -->
- turn N–M output (search: "keywords")
"#;

/// Alias for callers that prefer the more explicit template name.
pub const CHECKPOINT_MARKDOWN_TEMPLATE: &str = CHECKPOINT_TEMPLATE;

/// Issued at most once per checkpoint attempt. The model must return a complete
/// replacement checkpoint, not a patch or an explanation.
pub const CHECKPOINT_REPAIR_NUDGE: &str = "The context checkpoint is invalid. Repair it exactly once: return one complete replacement checkpoint using the required Markdown template. Include every required section with non-empty content, preserve exact error strings and dead ends, and return no explanation or partial patch. This is the only repair attempt.";

/// A searchable gap left by compaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeGap {
    /// What was compressed or omitted, such as a turn range or full file body.
    pub description: String,
    /// A concrete query for `recall_context`/transcript search.
    pub recommended_search: String,
}

impl KnowledgeGap {
    pub fn new(description: impl Into<String>, recommended_search: impl Into<String>) -> Self {
        Self {
            description: description.into(),
            recommended_search: recommended_search.into(),
        }
    }
}

/// Required top-level checkpoint sections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointSection {
    Objective,
    Requirements,
    ConfirmedFacts,
    CriticalErrors,
    Decisions,
    WorkState,
    AttemptsAndOutcomes,
    DeadEnds,
    Capabilities,
    RelevantFiles,
    NextMove,
    KnowledgeGaps,
}

impl CheckpointSection {
    pub const ALL: [Self; 12] = [
        Self::Objective,
        Self::Requirements,
        Self::ConfirmedFacts,
        Self::CriticalErrors,
        Self::Decisions,
        Self::WorkState,
        Self::AttemptsAndOutcomes,
        Self::DeadEnds,
        Self::Capabilities,
        Self::RelevantFiles,
        Self::NextMove,
        Self::KnowledgeGaps,
    ];

    pub const fn heading(self) -> &'static str {
        match self {
            Self::Objective => "Objective",
            Self::Requirements => "Requirements",
            Self::ConfirmedFacts => "Confirmed Facts",
            Self::CriticalErrors => "Critical Errors",
            Self::Decisions => "Decisions",
            Self::WorkState => "Work State",
            Self::AttemptsAndOutcomes => "Attempts and Outcomes",
            Self::DeadEnds => "Dead Ends",
            Self::Capabilities => "Capabilities",
            Self::RelevantFiles => "Relevant Files",
            Self::NextMove => "Next Move",
            Self::KnowledgeGaps => "Knowledge Gaps",
        }
    }

    const fn index(self) -> usize {
        match self {
            Self::Objective => 0,
            Self::Requirements => 1,
            Self::ConfirmedFacts => 2,
            Self::CriticalErrors => 3,
            Self::Decisions => 4,
            Self::WorkState => 5,
            Self::AttemptsAndOutcomes => 6,
            Self::DeadEnds => 7,
            Self::Capabilities => 8,
            Self::RelevantFiles => 9,
            Self::NextMove => 10,
            Self::KnowledgeGaps => 11,
        }
    }
}

impl fmt::Display for CheckpointSection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.heading())
    }
}

/// Structured validation failure. It reports both absent headings and headings
/// whose bodies contain no real content.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CheckpointValidationError {
    pub empty_summary: bool,
    pub missing_sections: Vec<CheckpointSection>,
    pub empty_sections: Vec<CheckpointSection>,
}

impl CheckpointValidationError {
    pub fn has_problems(&self) -> bool {
        self.empty_summary || !self.missing_sections.is_empty() || !self.empty_sections.is_empty()
    }

    /// The one and only structural-repair request for this validation error.
    pub fn nudge_message(&self) -> String {
        let mut message = CHECKPOINT_REPAIR_NUDGE.to_string();
        if !self.missing_sections.is_empty() {
            message.push_str("\nMissing sections: ");
            push_section_names(&mut message, &self.missing_sections);
            message.push('.');
        }
        if !self.empty_sections.is_empty() {
            message.push_str("\nEmpty sections: ");
            push_section_names(&mut message, &self.empty_sections);
            message.push('.');
        }
        message
    }
}

impl fmt::Display for CheckpointValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.empty_summary {
            formatter.write_str("checkpoint summary is empty")?;
        } else {
            formatter.write_str("checkpoint does not match the required schema")?;
        }
        if !self.missing_sections.is_empty() {
            formatter.write_str("; missing: ")?;
            for (index, section) in self.missing_sections.iter().enumerate() {
                if index > 0 {
                    formatter.write_str(", ")?;
                }
                write!(formatter, "{section}")?;
            }
        }
        if !self.empty_sections.is_empty() {
            formatter.write_str("; empty: ")?;
            for (index, section) in self.empty_sections.iter().enumerate() {
                if index > 0 {
                    formatter.write_str(", ")?;
                }
                write!(formatter, "{section}")?;
            }
        }
        Ok(())
    }
}

impl std::error::Error for CheckpointValidationError {}

/// Validate the full required template.
pub fn validate_checkpoint(markdown: &str) -> Result<(), CheckpointValidationError> {
    let mut found = [false; 12];
    let mut bodies: [Vec<&str>; 12] = std::array::from_fn(|_| Vec::new());
    let mut current: Option<usize> = None;

    for line in markdown.lines() {
        if let Some(raw_heading) = line.strip_prefix("## ") {
            let normalized = normalize_heading(raw_heading);
            current = CheckpointSection::ALL
                .iter()
                .copied()
                .find(|section| normalize_heading(section.heading()) == normalized)
                .map(|section| {
                    let index = section.index();
                    found[index] = true;
                    index
                });
            continue;
        }
        if let Some(index) = current {
            bodies[index].push(line);
        }
    }

    let missing_sections = CheckpointSection::ALL
        .iter()
        .copied()
        .filter(|section| !found[section.index()])
        .collect::<Vec<_>>();
    let empty_sections = CheckpointSection::ALL
        .iter()
        .copied()
        .filter(|section| found[section.index()] && !body_has_content(&bodies[section.index()]))
        .collect::<Vec<_>>();
    let error = CheckpointValidationError {
        empty_summary: markdown.trim().is_empty(),
        missing_sections,
        empty_sections,
    };
    if error.has_problems() {
        Err(error)
    } else {
        Ok(())
    }
}

/// A persisted checkpoint envelope. `summary` is the checkpoint Markdown; it is
/// wrapped in untrusted-evidence tags whenever it is rendered for the model.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionCheckpoint {
    pub id: String,
    pub conversation_id: String,
    pub summary: String,
    pub knowledge_gaps: Vec<KnowledgeGap>,
    /// Serialized RunStateLedger. Stored as JSON to keep this type independent
    /// of the ledger implementation while still preserving a single envelope.
    #[serde(default)]
    pub ledger_json: String,
    pub first_kept_message_id: i64,
    pub last_summarized_message_id: i64,
    #[serde(default)]
    pub transcript_id: String,
    pub history_version: u64,
    pub model_slug: String,
    pub prompt_hash: String,
    pub tool_catalog_version: u64,
    pub created_at: String,
    #[serde(default)]
    pub fallback_used: bool,
}

impl CompactionCheckpoint {
    pub fn from_fallback(
        id: impl Into<String>,
        conversation_id: impl Into<String>,
        checkpoint: &CheckpointFallback,
    ) -> Self {
        Self {
            id: id.into(),
            conversation_id: conversation_id.into(),
            summary: checkpoint.render_markdown_body(),
            knowledge_gaps: checkpoint.knowledge_gaps.clone(),
            fallback_used: true,
            ..Self::default()
        }
    }

    pub fn tagged_summary(&self) -> String {
        render_tagged_checkpoint(&self.summary)
    }

    pub fn user_message(&self) -> LlmMessage {
        tagged_checkpoint_user_message(&self.summary)
    }

    pub fn validate(&self) -> Result<(), CheckpointValidationError> {
        validate_checkpoint(&self.summary)
    }
}

/// Caller-provided deterministic fallback inputs. No summary-model prose is
/// needed (or invented) when validation fails twice.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFallback {
    pub objective: String,
    pub requirements: Vec<String>,
    #[serde(default)]
    pub confirmed_facts: Vec<String>,
    /// Render each string byte-for-byte.
    pub critical_errors: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default)]
    pub completed: Vec<String>,
    #[serde(default)]
    pub active: Vec<String>,
    #[serde(default)]
    pub blocked: Vec<String>,
    #[serde(default)]
    pub attempts_and_outcomes: Vec<String>,
    pub dead_ends: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub relevant_files: Vec<String>,
    pub next_move: Vec<String>,
    pub knowledge_gaps: Vec<KnowledgeGap>,
}

impl CheckpointFallback {
    /// Render the required Markdown without an evidence wrapper.
    pub fn render_markdown_body(&self) -> String {
        let mut out = String::new();

        out.push_str("## Objective\n");
        push_one(&mut out, &self.objective);

        out.push_str("\n## Requirements\n");
        push_list(&mut out, &self.requirements);

        out.push_str("\n## Confirmed Facts\n");
        push_list(&mut out, &self.confirmed_facts);

        out.push_str("\n## Critical Errors\n");
        push_exact_list(&mut out, &self.critical_errors);

        out.push_str("\n## Decisions\n");
        push_list(&mut out, &self.decisions);

        out.push_str("\n## Work State\n### Completed\n");
        push_list(&mut out, &self.completed);
        out.push_str("### Active\n");
        push_list(&mut out, &self.active);
        out.push_str("### Blocked\n");
        push_list(&mut out, &self.blocked);

        out.push_str("\n## Attempts and Outcomes\n");
        push_list(&mut out, &self.attempts_and_outcomes);

        out.push_str("\n## Dead Ends\n");
        push_list(&mut out, &self.dead_ends);

        out.push_str("\n## Capabilities\n");
        push_list(&mut out, &self.capabilities);

        out.push_str("\n## Relevant Files\n");
        push_list(&mut out, &self.relevant_files);

        out.push_str("\n## Next Move\n");
        push_numbered(&mut out, &self.next_move);

        out.push_str("\n## Knowledge Gaps\n");
        push_knowledge_gaps(&mut out, &self.knowledge_gaps);

        out
    }

    /// Render the deterministic fallback as tagged untrusted evidence.
    pub fn render(&self) -> String {
        render_tagged_checkpoint(&self.render_markdown_body())
    }
}

/// One checkpoint validation lifecycle. The first invalid result returns a
/// repair request; every later invalid result uses the deterministic fallback.
#[derive(Debug, Clone, Default)]
pub struct CheckpointRepairGate {
    repair_issued: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckpointGateDecision {
    Accepted {
        /// Tagged untrusted evidence, ready for a user-role message.
        markdown: String,
    },
    RepairRequested {
        validation: CheckpointValidationError,
        nudge: String,
    },
    Fallback {
        /// Tagged untrusted evidence assembled deterministically.
        markdown: String,
        validation: CheckpointValidationError,
    },
}

impl CheckpointRepairGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn repair_issued(&self) -> bool {
        self.repair_issued
    }

    pub fn evaluate(
        &mut self,
        candidate: &str,
        fallback: &CheckpointFallback,
    ) -> CheckpointGateDecision {
        match validate_checkpoint(candidate) {
            Ok(()) => CheckpointGateDecision::Accepted {
                markdown: render_tagged_checkpoint(candidate),
            },
            Err(validation) if !self.repair_issued => {
                self.repair_issued = true;
                CheckpointGateDecision::RepairRequested {
                    nudge: validation.nudge_message(),
                    validation,
                }
            }
            Err(validation) => CheckpointGateDecision::Fallback {
                markdown: fallback.render(),
                validation,
            },
        }
    }
}

/// Wrap checkpoint Markdown in untrusted-evidence tags, without double wrapping.
pub fn render_tagged_checkpoint(markdown: &str) -> String {
    if markdown.contains(CHECKPOINT_EVIDENCE_OPEN) {
        return markdown.to_string();
    }
    let mut rendered = String::from(CHECKPOINT_EVIDENCE_OPEN);
    rendered.push('\n');
    rendered.push_str(markdown);
    if !markdown.ends_with('\n') {
        rendered.push('\n');
    }
    rendered.push_str(CHECKPOINT_EVIDENCE_CLOSE);
    rendered.push('\n');
    rendered
}

/// A checkpoint is always injected as user-role evidence, never as a system
/// prompt section.
pub fn tagged_checkpoint_user_message(markdown: &str) -> LlmMessage {
    LlmMessage::text(LlmRole::User, render_tagged_checkpoint(markdown))
}

fn push_section_names(output: &mut String, sections: &[CheckpointSection]) {
    for (index, section) in sections.iter().enumerate() {
        if index > 0 {
            output.push_str(", ");
        }
        output.push_str(section.heading());
    }
}

fn push_one(output: &mut String, value: &str) {
    if value.trim().is_empty() {
        output.push_str("- No caller-provided value.\n");
    } else {
        push_exact_item(output, value);
    }
}

fn push_list(output: &mut String, values: &[String]) {
    if values.is_empty() {
        output.push_str("- None recorded.\n");
        return;
    }
    for value in values {
        push_exact_item(output, value);
    }
}

fn push_exact_list(output: &mut String, values: &[String]) {
    if values.is_empty() {
        output.push_str("- None recorded.\n");
        return;
    }
    // Prefix only the first line. The exact caller-provided error text remains
    // a contiguous byte-for-byte substring, including embedded newlines.
    for value in values {
        push_exact_item(output, value);
    }
}

fn push_exact_item(output: &mut String, value: &str) {
    output.push_str("- ");
    output.push_str(value);
    if !value.ends_with('\n') {
        output.push('\n');
    }
}

fn push_numbered(output: &mut String, values: &[String]) {
    if values.is_empty() {
        output.push_str("1. None recorded.\n");
        return;
    }
    for (index, value) in values.iter().enumerate() {
        output.push_str(&format!("{}. ", index + 1));
        output.push_str(value);
        if !value.ends_with('\n') {
            output.push('\n');
        }
    }
}

fn push_knowledge_gaps(output: &mut String, gaps: &[KnowledgeGap]) {
    if gaps.is_empty() {
        output.push_str("- None identified; the full transcript remains searchable.\n");
        return;
    }
    for gap in gaps {
        output.push_str("- ");
        output.push_str(&gap.description);
        output.push_str(" (search: ");
        output.push_str(
            &serde_json::to_string(&gap.recommended_search).unwrap_or_else(|_| "\"\"".into()),
        );
        output.push_str(")\n");
    }
}

fn normalize_heading(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches('#')
        .trim()
        .to_ascii_lowercase()
}

fn body_has_content(lines: &[&str]) -> bool {
    let joined = lines.join("\n");
    let without_comments = strip_html_comments(&joined);
    without_comments.lines().any(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("### ")
            || trimmed.starts_with("<!--")
            || trimmed.starts_with("-->")
            || trimmed
                .chars()
                .all(|ch| ch == '-' || ch == '=' || ch == ' ')
        {
            return false;
        }
        let item = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .unwrap_or(trimmed)
            .trim();
        !item.is_empty() && !matches!(item, "..." | "…" | "TODO" | "TBD" | "<...>")
    })
}

fn strip_html_comments(input: &str) -> String {
    let mut output = String::new();
    let mut rest = input;
    while let Some(start) = rest.find("<!--") {
        output.push_str(&rest[..start]);
        let after_start = &rest[start + 4..];
        let Some(end) = after_start.find("-->") else {
            return output;
        };
        rest = &after_start[end + 3..];
    }
    output.push_str(rest);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_checkpoint() -> String {
        r#"## Objective
- Implement the context checkpoint.

## Requirements
- Preserve exact errors.

## Confirmed Facts
- Validation is deterministic.

## Critical Errors
- `manifest_invalid: capability id is required` — source: manifest.rs

## Decisions
- Use one repair attempt.

## Work State
### Completed
- Added the template.
### Active
- Integrating the checkpoint.
### Blocked
- None.

## Attempts and Outcomes
- cargo test: success

## Dead Ends
- Do not retry the old prompt.

## Capabilities
- `project.write` — risky; available

## Relevant Files
- `harness-rs/crates/core/src/context/checkpoint.rs`: checkpoint logic

## Next Move
1. Run focused tests.

## Knowledge Gaps
- turn 4 full shell output (search: "cargo test checkpoint")
"#
        .into()
    }

    fn fallback() -> CheckpointFallback {
        CheckpointFallback {
            objective: "Implement provenance-safe checkpoints".into(),
            requirements: vec!["Preserve manifest_invalid: route is required".into()],
            critical_errors: vec!["manifest_invalid: route is required\nexact second line".into()],
            dead_ends: vec!["Do not retry the removed JSON-only prompt".into()],
            relevant_files: vec!["harness-rs/crates/core/src/context/checkpoint.rs".into()],
            next_move: vec!["Run the focused checkpoint tests".into()],
            knowledge_gaps: vec![KnowledgeGap::new(
                "turn 7 complete shell output",
                "manifest_invalid route is required",
            )],
            ..CheckpointFallback::default()
        }
    }

    #[test]
    fn valid_checkpoint_is_accepted_and_tagged_as_untrusted_evidence() {
        let candidate = valid_checkpoint();
        validate_checkpoint(&candidate).expect("valid template");
        let mut gate = CheckpointRepairGate::new();
        let decision = gate.evaluate(&candidate, &fallback());
        match decision {
            CheckpointGateDecision::Accepted { markdown } => {
                assert!(markdown.contains(CHECKPOINT_EVIDENCE_OPEN));
                assert!(markdown.contains("untrusted evidence"));
                assert!(markdown.contains(CHECKPOINT_EVIDENCE_CLOSE));
                assert!(!gate.repair_issued());
            }
            other => panic!("expected accepted checkpoint, got {other:?}"),
        }
    }

    #[test]
    fn missing_and_empty_sections_are_identified() {
        let missing =
            valid_checkpoint().replace("## Dead Ends\n- Do not retry the old prompt.\n\n", "");
        let error = validate_checkpoint(&missing).expect_err("missing Dead Ends must fail");
        assert_eq!(error.missing_sections, vec![CheckpointSection::DeadEnds]);
        assert!(error.empty_sections.is_empty());

        let empty = valid_checkpoint().replace(
            "## Requirements\n- Preserve exact errors.",
            "## Requirements\n\n",
        );
        let error = validate_checkpoint(&empty).expect_err("empty Requirements must fail");
        assert_eq!(error.empty_sections, vec![CheckpointSection::Requirements]);
    }

    #[test]
    fn empty_summary_is_rejected() {
        let error = validate_checkpoint("   \n").expect_err("empty summary must fail");
        assert!(error.empty_summary);
        assert_eq!(error.missing_sections.len(), CheckpointSection::ALL.len());
    }

    #[test]
    fn exactly_one_nudge_then_deterministic_fallback() {
        let invalid = "## Objective\n- incomplete";
        let mut gate = CheckpointRepairGate::new();
        let fallback = fallback();

        let first = gate.evaluate(invalid, &fallback);
        match first {
            CheckpointGateDecision::RepairRequested { validation, nudge } => {
                assert!(!validation.missing_sections.is_empty());
                assert!(nudge.starts_with(CHECKPOINT_REPAIR_NUDGE));
                assert!(nudge.contains("Missing sections"));
                assert!(gate.repair_issued());
            }
            other => panic!("first failure must request one repair, got {other:?}"),
        }

        let second = gate.evaluate(invalid, &fallback);
        let fallback_markdown = match second {
            CheckpointGateDecision::Fallback {
                markdown,
                validation,
            } => {
                assert!(!validation.missing_sections.is_empty());
                markdown
            }
            other => panic!("second failure must fall back, got {other:?}"),
        };
        validate_checkpoint(&fallback_markdown).expect("fallback must satisfy the schema");

        let third = gate.evaluate(invalid, &fallback);
        match third {
            CheckpointGateDecision::Fallback { markdown, .. } => {
                assert_eq!(markdown, fallback_markdown);
            }
            other => panic!("repair gate must not issue another nudge, got {other:?}"),
        }
    }

    #[test]
    fn fallback_preserves_exact_errors_and_dead_ends_verbatim() {
        let fallback = fallback();
        let rendered = fallback.render();
        assert!(rendered.contains("manifest_invalid: route is required\nexact second line"));
        assert!(rendered.contains("Do not retry the removed JSON-only prompt"));
        assert!(rendered.contains("(search: \"manifest_invalid route is required\")"));
        assert!(rendered.starts_with(CHECKPOINT_EVIDENCE_OPEN));
        assert!(rendered.contains(CHECKPOINT_EVIDENCE_CLOSE));
    }

    #[test]
    fn checkpoint_rendering_is_user_role_evidence_not_system_prompt() {
        let message = tagged_checkpoint_user_message(&valid_checkpoint());
        assert_eq!(message.role, LlmRole::User);
        let text = message.text_view();
        assert!(text.starts_with(CHECKPOINT_EVIDENCE_OPEN));
        assert!(text.contains("untrusted evidence"));
        assert!(!text.starts_with("system"));
    }

    #[test]
    fn knowledge_gap_uses_camel_case_recommended_search() {
        let gap = KnowledgeGap::new("turn 1 output", "manifest_invalid");
        let json = serde_json::to_value(gap).unwrap();
        assert_eq!(json["description"], "turn 1 output");
        assert_eq!(json["recommendedSearch"], "manifest_invalid");
    }
}
