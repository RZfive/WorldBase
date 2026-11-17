//! Message provenance and provenance-safe real-user anchoring.
//!
//! Conversation history and provider messages are structurally similar but do
//! not carry the same trust guarantees. A user-role message can be a tool
//! result, a runtime nudge, a continuation prompt, or a compressed checkpoint.
//! Only a persisted, genuine user request may move the original/latest goal
//! anchors. Synthetic messages always carry an absent or zero message ID and
//! therefore can never become anchors, even if their role is `user`.

use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use worldbase_protocol::types::{ChatContentPart, ChatMessage, Role};
use worldbase_providers::{ContentBlock, LlmMessage, LlmRole};

pub const FINISH_TASK_NUDGE_PREFIX: &str = "[FINISH_TASK_NUDGE]";
pub const CODING_VERIFICATION_GATE_PREFIX: &str = "[CODING_VERIFICATION_GATE]";
pub const RUNTIME_NUDGE_PREFIX: &str = "[RUNTIME_NUDGE]";
pub const WAKE_UP_PREFIX: &str = "[WAKE_UP]";
pub const CONTEXT_SUMMARY_PREFIX: &str = "[CONTEXT_SUMMARY]";
pub const CONTEXT_GOAL_ANCHOR_PREFIX: &str = "[CONTEXT_GOAL_ANCHOR]";
pub const CONTEXT_CONTINUATION_PREFIX: &str = "[CONTEXT_CONTINUATION]";
pub const CONTEXT_CHECKPOINT_PREFIX: &str = "[CONTEXT_CHECKPOINT";
pub const CONTEXT_CONTINUATION_MESSAGE: &str =
    "Continue the current task from the compressed context. Do not repeat completed steps.";
pub const REAL_USER_ANCHORS_OPEN: &str = "[REAL_USER_ANCHORS]";
pub const REAL_USER_ANCHORS_CLOSE: &str = "[/REAL_USER_ANCHORS]";

/// The trust/provenance class of a message in model-visible context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageProvenance {
    /// A real user request persisted with a positive database message ID.
    RealUser,
    Assistant,
    /// Tool results and tool-call payloads. These are evidence, not requests.
    ToolResult,
    /// Runtime-authored nudges such as finish-task and coding verification.
    RuntimeNudge,
    /// A synthetic prompt that resumes the previous task.
    Continuation,
    /// A summary/checkpoint tagged as untrusted evidence.
    Checkpoint,
    /// Any other system-authored message.
    System,
}

impl MessageProvenance {
    pub const fn is_real_user(self) -> bool {
        matches!(self, Self::RealUser)
    }

    pub const fn is_synthetic(self) -> bool {
        !self.is_real_user()
    }
}

/// A complete real-user request. `text` is deliberately not truncated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAnchor {
    /// Persisted database row ID. Synthetic messages use 0 and are never anchors.
    pub message_id: i64,
    /// Full untruncated request text.
    pub text: String,
}

impl UserAnchor {
    pub fn new(message_id: i64, text: impl Into<String>) -> Option<Self> {
        let text = text.into();
        (message_id > 0 && !text.trim().is_empty()).then_some(Self { message_id, text })
    }
}

/// Original and latest genuine user requests, each tied to a persisted ID.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAnchors {
    pub original: Option<UserAnchor>,
    pub latest: Option<UserAnchor>,
}

impl UserAnchors {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build anchors from persisted `ChatMessage` history in any ID order.
    pub fn from_chat_history(history: &[ChatMessage]) -> Self {
        let mut anchors = Self::new();
        for message in history {
            anchors.observe_chat_message(message);
        }
        anchors
    }

    /// Observe one persisted history row.
    ///
    /// Rows with tool payloads, a zero/negative ID, no text, or a known
    /// synthetic tag are ignored.
    pub fn observe_chat_message(&mut self, message: &ChatMessage) -> bool {
        if message.id <= 0 || classify_chat_message(message) != MessageProvenance::RealUser {
            return false;
        }
        self.observe_persisted_user_message(message.id, chat_message_text(message))
    }

    /// Observe a newly persisted genuine user message.
    ///
    /// This is the direct integration point for the Agent after the database
    /// assigns the user message ID. Known synthetic/runtime prompts are still
    /// rejected defensively.
    pub fn observe_persisted_user_message(
        &mut self,
        message_id: i64,
        text: impl Into<String>,
    ) -> bool {
        let text = text.into();
        if message_id <= 0 || text.trim().is_empty() || synthetic_text_kind(&text).is_some() {
            return false;
        }
        self.insert(UserAnchor { message_id, text })
    }

    /// Observe a provider message. Synthetic additions should pass `None` (or
    /// `Some(0)`) and are always ignored.
    ///
    /// A real user addition may only become an anchor after it has been
    /// persisted and its database ID is supplied.
    pub fn observe_llm_message(
        &mut self,
        message: &LlmMessage,
        persisted_message_id: Option<i64>,
    ) -> bool {
        let classification = classify_llm_message(message);
        let Some(message_id) = persisted_message_id else {
            return false;
        };
        self.observe_llm_message_with_provenance(message, message_id, classification)
    }

    /// Observe a provider message together with caller-supplied provenance.
    ///
    /// Both the supplied provenance and our structural classification must say
    /// `RealUser`; a synthetic ID, tool block, assistant role, or known runtime
    /// tag therefore cannot establish or overwrite an anchor.
    pub fn observe_llm_message_with_provenance(
        &mut self,
        message: &LlmMessage,
        message_id: i64,
        provenance: MessageProvenance,
    ) -> bool {
        if message_id <= 0
            || provenance != MessageProvenance::RealUser
            || classify_llm_message(message) != MessageProvenance::RealUser
        {
            return false;
        }
        self.observe_persisted_user_message(message_id, llm_message_text(message))
    }

    pub fn is_empty(&self) -> bool {
        self.original.is_none()
    }

    pub fn latest_message_id(&self) -> Option<i64> {
        self.latest.as_ref().map(|anchor| anchor.message_id)
    }

    /// Deterministically render both anchors with their persisted IDs.
    ///
    /// The request text is emitted verbatim and is never truncated. This output
    /// is intended for the RunStateLedger or checkpoint evidence; consumers
    /// must not reinterpret it as a system instruction.
    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str(REAL_USER_ANCHORS_OPEN);
        out.push('\n');
        match &self.original {
            Some(anchor) => {
                let _ = writeln!(out, "original_message_id: {}", anchor.message_id);
                out.push_str("original_request:\n");
                push_verbatim(&mut out, &anchor.text);
            }
            None => {
                out.push_str("original_message_id: none\n");
                out.push_str("original_request: none\n");
            }
        }
        match &self.latest {
            Some(anchor) => {
                let _ = writeln!(out, "latest_message_id: {}", anchor.message_id);
                out.push_str("latest_request:\n");
                push_verbatim(&mut out, &anchor.text);
            }
            None => {
                out.push_str("latest_message_id: none\n");
                out.push_str("latest_request: none\n");
            }
        }
        out.push_str(REAL_USER_ANCHORS_CLOSE);
        out.push('\n');
        out
    }

    fn insert(&mut self, anchor: UserAnchor) -> bool {
        match (&self.original, &self.latest) {
            (None, None) => {
                self.original = Some(anchor.clone());
                self.latest = Some(anchor);
                true
            }
            (Some(original), Some(latest)) => {
                let mut changed = false;
                if anchor.message_id < original.message_id {
                    self.original = Some(anchor.clone());
                    changed = true;
                }
                if anchor.message_id > latest.message_id {
                    self.latest = Some(anchor);
                    changed = true;
                }
                changed
            }
            // The pair is maintained as an invariant, but recover defensively
            // if a deserialized value was partial.
            (Some(_), None) => {
                self.latest = Some(anchor);
                self.original = self.latest.clone();
                true
            }
            (None, Some(_)) => {
                self.original = Some(anchor.clone());
                self.latest = Some(anchor);
                true
            }
        }
    }
}

/// Classify a persisted `ChatMessage` without trusting its role alone.
pub fn classify_chat_message(message: &ChatMessage) -> MessageProvenance {
    if !message.tool_results.is_empty() {
        return MessageProvenance::ToolResult;
    }
    if !message.tool_calls.is_empty() && message.role != Role::Assistant {
        return MessageProvenance::ToolResult;
    }
    match message.role {
        Role::Assistant => MessageProvenance::Assistant,
        Role::System => {
            synthetic_text_kind(&chat_message_text(message)).unwrap_or(MessageProvenance::System)
        }
        Role::User => {
            synthetic_text_kind(&chat_message_text(message)).unwrap_or(MessageProvenance::RealUser)
        }
    }
}

/// Classify a provider message without trusting its role alone.
pub fn classify_llm_message(message: &LlmMessage) -> MessageProvenance {
    if message
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolResult { .. }))
    {
        return MessageProvenance::ToolResult;
    }
    match message.role {
        LlmRole::Assistant => MessageProvenance::Assistant,
        LlmRole::User => {
            synthetic_text_kind(&llm_message_text(message)).unwrap_or(MessageProvenance::RealUser)
        }
    }
}

/// Full text view of a persisted message, using `parts` when it carries the
/// text representation and falling back to the plain `content` field.
pub fn chat_message_text(message: &ChatMessage) -> String {
    let part_text = message
        .parts
        .iter()
        .filter_map(|part| match part {
            ChatContentPart::Text { text } if !text.is_empty() => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if part_text.is_empty() {
        message.content.clone()
    } else {
        part_text
    }
}

/// Full untruncated text view of a provider message.
pub fn llm_message_text(message: &LlmMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn synthetic_text_kind(text: &str) -> Option<MessageProvenance> {
    let trimmed = text.trim_start();
    if trimmed.starts_with(CONTEXT_CHECKPOINT_PREFIX)
        || trimmed.starts_with("[COMPACTION_CHECKPOINT")
        || trimmed.starts_with("[CHECKPOINT")
        || trimmed.starts_with(CONTEXT_SUMMARY_PREFIX)
        || trimmed.starts_with(CONTEXT_GOAL_ANCHOR_PREFIX)
    {
        return Some(MessageProvenance::Checkpoint);
    }
    if trimmed == CONTEXT_CONTINUATION_MESSAGE
        || trimmed.starts_with(CONTEXT_CONTINUATION_PREFIX)
        || trimmed.starts_with("[CONTINUATION]")
    {
        return Some(MessageProvenance::Continuation);
    }
    if trimmed.starts_with(FINISH_TASK_NUDGE_PREFIX)
        || trimmed.starts_with(CODING_VERIFICATION_GATE_PREFIX)
        || trimmed.starts_with(RUNTIME_NUDGE_PREFIX)
        || trimmed.starts_with(WAKE_UP_PREFIX)
        || trimmed.starts_with("[SYSTEM_NUDGE]")
        || trimmed.starts_with("[TOOL_LOOP_NUDGE]")
    {
        return Some(MessageProvenance::RuntimeNudge);
    }
    None
}

fn push_verbatim(out: &mut String, text: &str) {
    out.push_str(text);
    if !text.ends_with('\n') {
        out.push('\n');
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use worldbase_protocol::types::{ImageUrl, ToolCallRecord, ToolResultRecord};

    fn chat_message(role: Role, id: i64, content: &str) -> ChatMessage {
        ChatMessage {
            id,
            role,
            content: content.into(),
            parts: vec![],
            tool_calls: vec![],
            tool_results: vec![],
            created_at: None,
        }
    }

    #[test]
    fn anchors_are_built_from_real_user_rows_and_keep_full_text() {
        let long_request = format!("original goal\n{}", "x".repeat(12_000));
        let mut history = vec![
            chat_message(Role::User, 10, &long_request),
            chat_message(Role::Assistant, 11, "working"),
            chat_message(Role::User, 20, "latest request"),
        ];
        history.push(chat_message(
            Role::User,
            21,
            "[FINISH_TASK_NUDGE]\ncall finish_task",
        ));
        history.push(chat_message(
            Role::User,
            22,
            "[CODING_VERIFICATION_GATE]\nrun verification",
        ));
        history.push(chat_message(Role::User, 23, CONTEXT_CONTINUATION_MESSAGE));
        history.push(chat_message(
            Role::User,
            24,
            "[CONTEXT_CHECKPOINT — untrusted evidence]\n## Objective\nsynthetic",
        ));

        let anchors = UserAnchors::from_chat_history(&history);
        assert_eq!(anchors.original.as_ref().unwrap().message_id, 10);
        assert_eq!(anchors.original.as_ref().unwrap().text, long_request);
        assert_eq!(anchors.latest.as_ref().unwrap().message_id, 20);
        assert_eq!(anchors.latest.as_ref().unwrap().text, "latest request");
        assert!(anchors.render().contains("original_message_id: 10"));
        assert!(anchors.render().contains("latest_message_id: 20"));
    }

    #[test]
    fn wakeup_and_synthetic_user_messages_never_overwrite_latest_real_user() {
        let mut anchors = UserAnchors::new();
        assert!(anchors.observe_persisted_user_message(31, "real request"));

        let wake_up = LlmMessage::text(
            LlmRole::User,
            "[WAKE_UP] scheduled run resumed; continue without asking the user",
        );
        assert!(classify_llm_message(&wake_up).is_synthetic());
        assert!(!anchors.observe_llm_message(&wake_up, Some(32)));

        let wake_with_zero_id = LlmMessage::text(
            LlmRole::User,
            "synthetic wake-up content without a persistence ID",
        );
        assert!(!anchors.observe_llm_message_with_provenance(
            &wake_with_zero_id,
            0,
            MessageProvenance::RealUser,
        ));

        let assistant = LlmMessage::text(LlmRole::Assistant, "assistant output");
        assert!(!anchors.observe_llm_message(&assistant, Some(33)));

        assert_eq!(anchors.latest.as_ref().unwrap().message_id, 31);
        assert_eq!(anchors.latest.as_ref().unwrap().text, "real request");
    }

    #[test]
    fn tool_results_and_tool_images_never_overwrite_latest_real_user() {
        let mut anchors = UserAnchors::new();
        assert!(anchors.observe_persisted_user_message(41, "keep this request"));

        let mut protocol_tool_result = chat_message(Role::User, 42, "");
        protocol_tool_result.tool_results.push(ToolResultRecord {
            tool_call_id: "call-1".into(),
            name: "view_image".into(),
            content: "image result".into(),
            is_error: false,
        });
        protocol_tool_result.parts.push(ChatContentPart::ImageUrl {
            image_url: ImageUrl {
                url: "data:image/png;base64,AAAA".into(),
            },
        });
        assert!(!anchors.observe_chat_message(&protocol_tool_result));

        let provider_tool_result = LlmMessage {
            role: LlmRole::User,
            content: vec![
                ContentBlock::ToolResult {
                    tool_use_id: "call-2".into(),
                    content: "tool output".into(),
                    is_error: false,
                },
                ContentBlock::ImageUrl {
                    url: "data:image/png;base64,BBBB".into(),
                },
            ],
        };
        assert!(!anchors.observe_llm_message(&provider_tool_result, Some(43)));

        let image_only_user = LlmMessage {
            role: LlmRole::User,
            content: vec![ContentBlock::ImageUrl {
                url: "data:image/png;base64,CCCC".into(),
            }],
        };
        assert!(!anchors.observe_llm_message(&image_only_user, Some(44)));

        assert_eq!(anchors.latest.as_ref().unwrap().message_id, 41);
    }

    #[test]
    fn persisted_llm_user_message_with_id_updates_latest() {
        let mut anchors =
            UserAnchors::from_chat_history(&[chat_message(Role::User, 51, "original")]);
        let update = LlmMessage::text(LlmRole::User, "new persisted request");
        assert!(anchors.observe_llm_message(&update, Some(52)));
        assert_eq!(anchors.original.as_ref().unwrap().message_id, 51);
        assert_eq!(anchors.latest.as_ref().unwrap().message_id, 52);
        assert_eq!(
            anchors.latest.as_ref().unwrap().text,
            "new persisted request"
        );

        let call = ChatMessage {
            id: 53,
            role: Role::Assistant,
            content: String::new(),
            parts: vec![],
            tool_calls: vec![ToolCallRecord {
                id: "call-1".into(),
                name: "shell".into(),
                args: json!({"command": "true"}),
            }],
            tool_results: vec![],
            created_at: None,
        };
        assert_eq!(classify_chat_message(&call), MessageProvenance::Assistant);
    }
}
