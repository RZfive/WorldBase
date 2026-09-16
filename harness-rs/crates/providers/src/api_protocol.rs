//! Chat wire-protocol selection shared by provider dispatch, the remote model
//! catalog, and auto-detection.

/// Normalized runtime form of a provider entry's stored `apiProtocol` string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiProtocol {
    /// Anthropic Messages (`/v1/messages`).
    Anthropic,
    /// OpenAI Chat Completions (`/chat/completions`) — the de-facto standard
    /// for every OpenAI-compatible gateway.
    OpenAiChat,
    /// OpenAI Responses (`/responses`) — OpenAI's newer native protocol.
    OpenAiResponses,
}

impl ApiProtocol {
    /// Normalize a stored `apiProtocol` value. Legacy `"openai"` and the auto
    /// sentinel `""` resolve to Chat Completions: the desktop settings page
    /// pins auto entries through probe-based detection before syncing them
    /// here, so runtime resolution never guesses from the base URL. Unknown
    /// values also fall back to Chat Completions as the safest default.
    pub fn from_stored(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "anthropic" => ApiProtocol::Anthropic,
            "openai-responses" | "openai_responses" | "responses" => ApiProtocol::OpenAiResponses,
            _ => ApiProtocol::OpenAiChat,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ApiProtocol::Anthropic => "anthropic",
            ApiProtocol::OpenAiChat => "openai-chat",
            ApiProtocol::OpenAiResponses => "openai-responses",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_stored_values() {
        assert_eq!(
            ApiProtocol::from_stored("anthropic"),
            ApiProtocol::Anthropic
        );
        assert_eq!(
            ApiProtocol::from_stored(" Anthropic "),
            ApiProtocol::Anthropic
        );
        assert_eq!(
            ApiProtocol::from_stored("openai-responses"),
            ApiProtocol::OpenAiResponses
        );
        assert_eq!(
            ApiProtocol::from_stored("openai_responses"),
            ApiProtocol::OpenAiResponses
        );
        // Legacy value and the auto sentinel both mean Chat Completions.
        assert_eq!(ApiProtocol::from_stored("openai"), ApiProtocol::OpenAiChat);
        assert_eq!(
            ApiProtocol::from_stored("openai-chat"),
            ApiProtocol::OpenAiChat
        );
        assert_eq!(ApiProtocol::from_stored(""), ApiProtocol::OpenAiChat);
        assert_eq!(
            ApiProtocol::from_stored("future-protocol"),
            ApiProtocol::OpenAiChat
        );
    }
}
