//! Classification for provider errors caused by an input exceeding the model's
//! context window.

/// Return whether `message` is a provider context-overflow error.
///
/// The matcher intentionally looks for explicit context-length language or
/// provider error codes. Token-related request parameters alone are not enough
/// to trigger context compaction.
pub fn is_context_overflow_error(message: &str) -> bool {
    if message.trim().is_empty() {
        return false;
    }

    let lower = message.to_ascii_lowercase();

    has_overflow_code(&lower)
        || has_openai_context_phrase(&lower)
        || has_anthropic_context_phrase(&lower)
        || has_context_window_overflow(&lower)
        || has_input_length_overflow(&lower)
        || has_compatible_token_overflow(&lower)
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn has_overflow_code(message: &str) -> bool {
    contains_any(
        message,
        &[
            "context_length_exceeded",
            "context_window_exceeded",
            "prompt_too_long",
        ],
    )
}

fn has_openai_context_phrase(message: &str) -> bool {
    contains_any(
        message,
        &[
            "maximum context length",
            "context length exceeded",
            "exceeded the context length",
            "exceeds the context length",
            "exceed the context length",
            "reduce the length of the messages",
            "reduce the messages length",
            "reduce your prompt",
            "reduce input length",
        ],
    )
}

fn has_anthropic_context_phrase(message: &str) -> bool {
    contains_any(
        message,
        &[
            "prompt is too long",
            "prompt too long",
            "input length and max_tokens exceed",
            "input and max_tokens exceed",
            "input plus max_tokens exceed",
            "input length plus max_tokens exceeds",
        ],
    )
}

fn has_context_window_overflow(message: &str) -> bool {
    let has_context_scope = contains_any(
        message,
        &["context window", "context limit", "context length"],
    );
    let has_overflow = contains_any(
        message,
        &[
            "exceed",
            "too long",
            "too large",
            "too many",
            "overflow",
            "reached",
            "run out",
        ],
    );

    has_context_scope && has_overflow
}

fn has_input_length_overflow(message: &str) -> bool {
    if has_rate_limit_or_quota_signal(message)
        || has_non_context_limit_signal(message)
        || has_tool_validation_signal(message)
    {
        return false;
    }

    let has_length_signal = contains_any(
        message,
        &[
            "input is too long",
            "input too long",
            "request is too long",
            "request too long",
            "input is too large",
            "input too large",
            "request is too large",
            "request too large",
            "input length exceeds",
            "request length exceeds",
        ],
    );
    let tied_to_context_or_model =
        contains_any(message, &["context", "model", "token", "prompt", "message"]);

    has_length_signal && tied_to_context_or_model
}

fn has_compatible_token_overflow(message: &str) -> bool {
    if has_rate_limit_or_quota_signal(message)
        || has_non_context_limit_signal(message)
        || has_tool_validation_signal(message)
        || has_output_token_limit_signal(message)
    {
        return false;
    }

    let prompt_length_overflow = contains_any(
        message,
        &[
            "prompt length exceeded",
            "prompt length exceeds",
            "prompt length is too long",
            "prompt exceeds the maximum length",
            "prompt exceeds its maximum length",
            "exceeds the maximum prompt length",
            "maximum prompt length exceeded",
        ],
    ) || (message.contains("maximum prompt length")
        && contains_any(
            message,
            &["but the request contains", "but this request contains"],
        )
        && message.contains("token"));
    if prompt_length_overflow {
        return true;
    }

    let has_token_limit_signal = contains_any(
        message,
        &[
            "maximum number of tokens",
            "number of tokens exceeds",
            "too many tokens",
            "token count exceeds",
            "input tokens exceed",
            "input token count exceeds",
        ],
    );

    if has_token_limit_signal {
        return true;
    }

    let input_token_limit_exceeded = message.contains("input token limit")
        && contains_any(
            message,
            &[
                "exceed",
                "too many",
                "too large",
                "reached",
                "over the limit",
            ],
        );
    if input_token_limit_exceeded {
        return true;
    }

    let request_too_large = contains_any(message, &["request too large", "request is too large"])
        && contains_any(
            message,
            &["context", "model", "prompt", "token", "input", "message"],
        );
    if request_too_large {
        return true;
    }

    contains_any(
        message,
        &[
            "prompt exceeds the context",
            "input exceeds the context",
            "request exceeds the context",
            "messages exceed the context",
        ],
    )
}

fn has_output_token_limit_signal(message: &str) -> bool {
    contains_any(
        message,
        &[
            "maximum output tokens",
            "max output tokens",
            "too many output tokens",
            "output token limit",
            "maximum completion tokens",
            "max completion tokens",
            "completion token limit",
            "tokens for output",
            "tokens for completion",
            "output token budget",
        ],
    )
}

fn has_rate_limit_or_quota_signal(message: &str) -> bool {
    contains_any(
        message,
        &[
            "rate limit",
            "rate_limit",
            "ratelimit",
            "per minute",
            "per min",
            "per second",
            "per sec",
            "requests per",
            "tokens per",
            "request rate",
            "quota",
            "billing",
            "credit balance",
            "insufficient credit",
            "your plan",
            "plan limit",
            " tpm",
            "(tpm",
            " rpm",
            "(rpm",
        ],
    )
}

fn has_tool_validation_signal(message: &str) -> bool {
    contains_any(
        message,
        &[
            "tool arguments",
            "tool argument",
            "function arguments",
            "tool input",
            "tool schema",
            "invalid tool",
        ],
    )
}

fn has_non_context_limit_signal(message: &str) -> bool {
    contains_any(
        message,
        &[
            "authentication",
            "authorization",
            "invalid api key",
            "401",
            "403",
            "429",
            "connection reset",
            "timed out",
            "timeout",
            "dns",
            "tls",
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_openai_context_overflow_variants() {
        let cases = [
            "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens. Please reduce the length of the messages.",
            r#"{"error":{"message":"Your input exceeds the context window of this model.","type":"invalid_request_error","code":"context_length_exceeded"}}"#,
            "openai stream error: Please reduce the length of the messages.",
            "The input is too long for the requested model's context window.",
            "Request is too long for this model's context window.",
        ];

        for case in cases {
            assert!(
                is_context_overflow_error(case),
                "should detect OpenAI overflow: {case}"
            );
        }
    }

    #[test]
    fn detects_anthropic_context_overflow_variants() {
        let cases = [
            r#"{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 213462 tokens > 200000 maximum"}}"#,
            "input length and max_tokens exceed context limit: 198000 + 8192 > 200000",
            "The prompt is too long for this model.",
            "context window exceeded while processing the input",
        ];

        for case in cases {
            assert!(
                is_context_overflow_error(case),
                "should detect Anthropic overflow: {case}"
            );
        }
    }

    #[test]
    fn detects_compatible_provider_context_overflow_variants() {
        let cases = [
            "compatible gateway: maximum number of tokens exceeded for this model",
            "Input token limit exceeded: 131072 tokens",
            "The request contains too many tokens for the selected model.",
            "Request too large for the model's context window.",
            "number of tokens exceeds the configured input limit",
            "maximum number of tokens exceeded",
            "The maximum prompt length is 131072 but the request contains 143680 tokens.",
            "Prompt length exceeded: 143680 tokens > 131072 maximum.",
        ];

        for case in cases {
            assert!(
                is_context_overflow_error(case),
                "should detect compatible-provider overflow: {case}"
            );
        }
    }

    #[test]
    fn rejects_network_auth_quota_and_rate_limit_errors() {
        let cases = [
            "connection reset by peer",
            "operation timed out while awaiting the response",
            "dns lookup failed for api.example.com",
            "TLS handshake failed",
            "401 Unauthorized: invalid api key",
            "You exceeded your current quota; please check your billing details.",
            "429 Too Many Requests",
            "Rate limit reached for requests; retry after 20 seconds.",
            "Too many tokens per minute for this model.",
            "maximum number of tokens per minute exceeded",
        ];

        for case in cases {
            assert!(
                !is_context_overflow_error(case),
                "non-context provider error must not match: {case}"
            );
        }
    }

    #[test]
    fn rejects_invalid_requests_and_tool_errors() {
        let cases = [
            "400 invalid request: unsupported parameter",
            "invalid tool arguments: expected a JSON object",
            "tool arguments contain an unexpected field",
            "input is too long for the tool schema",
            "Invalid request: input token limit exceeded for tool arguments",
            "413 Request Entity Too Large",
            "request too large for the HTTP body limit",
        ];

        for case in cases {
            assert!(
                !is_context_overflow_error(case),
                "generic invalid request must not match: {case}"
            );
        }
    }

    #[test]
    fn rejects_non_context_token_parameter_errors() {
        let cases = [
            "max_tokens must be a positive integer",
            "Unsupported parameter: max_tokens",
            "max_tokens is not supported for this model",
            "The maximum output tokens parameter is invalid",
            "maximum output tokens exceeded the configured generation budget",
            "maximum number of tokens for output is 4096",
            "The maximum prompt length is 131072 tokens.",
            "max completion tokens must be greater than zero",
        ];

        for case in cases {
            assert!(
                !is_context_overflow_error(case),
                "token parameter error must not match: {case}"
            );
        }
    }

    #[test]
    fn handles_empty_case_json_and_long_messages() {
        assert!(!is_context_overflow_error(""));
        assert!(!is_context_overflow_error(" \n\t "));
        assert!(is_context_overflow_error("PROMPT IS TOO LONG"));
        assert!(is_context_overflow_error(
            r#"{"ERROR":{"MESSAGE":"CONTEXT_LENGTH_EXCEEDED"}}"#
        ));

        let long_match = format!(
            "{} {}",
            "provider detail ".repeat(20_000),
            "CONTEXT_WINDOW_EXCEEDED"
        );
        assert!(is_context_overflow_error(&long_match));

        let long_non_match = format!(
            "{} {}",
            "connection reset by peer ".repeat(20_000),
            "401 invalid api key"
        );
        assert!(!is_context_overflow_error(&long_non_match));
    }
}
