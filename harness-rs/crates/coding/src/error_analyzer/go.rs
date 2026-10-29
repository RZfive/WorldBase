use crate::model::{Diagnostic, DiagnosticSeverity};
use regex::Regex;
use std::path::PathBuf;
use std::sync::OnceLock;

const STRUCTURED_CONFIDENCE: f32 = 0.9;
const TEST_HEADER_CONFIDENCE: f32 = 0.6;

/// Per-stream state for Go test failures whose detail lines follow the
/// `--- FAIL` header. Keeping it in the caller avoids cross-outcome state
/// leakage.
#[derive(Default)]
pub(crate) struct ParserState {
    pending_failure: Option<String>,
    pending_raw: String,
    pending_has_detail: bool,
}

/// Parse one Go compiler/test/vet output line.
pub(crate) fn parse_line(
    state: &mut ParserState,
    text: &str,
    raw: &str,
) -> (Option<Diagnostic>, bool) {
    let text = text.trim();
    if text.is_empty() {
        return (None, false);
    }

    if let Some(captures) = failing_test().captures(text) {
        let name = captures.name("name").map(|name| name.as_str().trim());
        if let Some(name) = name {
            state.pending_failure = Some(name.to_string());
            state.pending_raw = raw.to_string();
            state.pending_has_detail = false;
        }
        return (None, true);
    }

    if state.pending_failure.is_some() && is_indented(raw) {
        let test_name = state
            .pending_failure
            .clone()
            .expect("pending failure checked above");
        let diagnostic = file_diagnostic()
            .captures(text)
            .and_then(|captures| file_diagnostic_from_captures(&captures, raw, Some(&test_name)));
        if diagnostic.is_some() {
            state.pending_has_detail = true;
        }
        return (diagnostic, true);
    }

    if let Some(diagnostic) = parse_standard(text, raw) {
        return (Some(diagnostic), true);
    }
    (None, false)
}

/// Flush a pending `--- FAIL` header when the current line cannot be its
/// indented detail line.
pub(crate) fn flush_if_boundary(
    state: &mut ParserState,
    _text: &str,
    raw: &str,
) -> Vec<Diagnostic> {
    if state.pending_failure.is_none() || is_indented(raw) {
        return Vec::new();
    }
    let mut diagnostics = Vec::new();
    flush_failure(state, &mut diagnostics);
    diagnostics
}

/// Emit a failure header that never received an indented detail line.
pub(crate) fn finish(state: &mut ParserState) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    flush_failure(state, &mut diagnostics);
    diagnostics
}

fn flush_failure(state: &mut ParserState, diagnostics: &mut Vec<Diagnostic>) {
    if let Some(name) = state.pending_failure.take() {
        let raw = std::mem::take(&mut state.pending_raw);
        if !state.pending_has_detail {
            diagnostics.push(Diagnostic {
                severity: DiagnosticSeverity::Error,
                message: format!("Test failed: {name}"),
                code: Some("GOTEST".to_string()),
                file: None,
                line: None,
                column: None,
                confidence: TEST_HEADER_CONFIDENCE,
                raw: Some(raw),
            });
        }
        state.pending_has_detail = false;
    }
}

fn is_indented(raw: &str) -> bool {
    raw.starts_with(' ') || raw.starts_with('\t')
}

fn parse_standard(text: &str, raw: &str) -> Option<Diagnostic> {
    if let Some(captures) = file_diagnostic().captures(text) {
        return file_diagnostic_from_captures(&captures, raw, None);
    }

    if let Some(captures) = failing_package().captures(text) {
        let package = captures.name("package")?.as_str().trim();
        let rest = captures
            .name("rest")
            .map_or("", |rest| rest.as_str())
            .trim();
        let build_failed = rest.contains("[build failed]");
        let (code, message, confidence) = if build_failed {
            (
                "GO",
                format!("Build failed: {package}"),
                STRUCTURED_CONFIDENCE,
            )
        } else {
            (
                "GOTEST",
                format!("Test failed: {package}"),
                TEST_HEADER_CONFIDENCE,
            )
        };
        return Some(Diagnostic {
            severity: DiagnosticSeverity::Error,
            message,
            code: Some(code.to_string()),
            file: None,
            line: None,
            column: None,
            confidence,
            raw: Some(raw.to_string()),
        });
    }

    if undefined_identifier().is_match(text) {
        return Some(Diagnostic {
            severity: DiagnosticSeverity::Error,
            message: text.to_string(),
            code: Some("GO".to_string()),
            file: None,
            line: None,
            column: None,
            confidence: STRUCTURED_CONFIDENCE,
            raw: Some(raw.to_string()),
        });
    }

    if cannot_use().is_match(text) {
        return Some(Diagnostic {
            severity: DiagnosticSeverity::Error,
            message: text.to_string(),
            code: Some("GO".to_string()),
            file: None,
            line: None,
            column: None,
            confidence: STRUCTURED_CONFIDENCE,
            raw: Some(raw.to_string()),
        });
    }

    if let Some(captures) = vet_tool_error().captures(text) {
        let message = captures.name("message")?.as_str().trim();
        return Some(Diagnostic {
            severity: DiagnosticSeverity::Error,
            message: message.to_string(),
            code: Some("GOVET".to_string()),
            file: None,
            line: None,
            column: None,
            confidence: STRUCTURED_CONFIDENCE,
            raw: Some(raw.to_string()),
        });
    }

    if let Some(captures) = go_tool_error().captures(text) {
        let message = captures.name("message")?.as_str().trim();
        return Some(Diagnostic {
            severity: DiagnosticSeverity::Error,
            message: message.to_string(),
            code: Some("GO".to_string()),
            file: None,
            line: None,
            column: None,
            confidence: STRUCTURED_CONFIDENCE,
            raw: Some(raw.to_string()),
        });
    }

    None
}

fn file_diagnostic_from_captures(
    captures: &regex::Captures<'_>,
    raw: &str,
    test_name: Option<&str>,
) -> Option<Diagnostic> {
    let file = captures.name("file")?.as_str().trim();
    let line = captures.name("line")?.as_str().parse::<u32>().ok()?;
    let column = captures
        .name("column")
        .and_then(|column| column.as_str().parse::<u32>().ok());
    let message = captures.name("message")?.as_str().trim();
    let (code, message, confidence) = match test_name {
        Some(test_name) => (
            "GOTEST",
            format!("Test failed: {test_name}: {message}"),
            TEST_HEADER_CONFIDENCE,
        ),
        None => {
            let code = if captures.name("vet").is_some() {
                "GOVET"
            } else {
                "GO"
            };
            (code, message.to_string(), STRUCTURED_CONFIDENCE)
        }
    };
    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message,
        code: Some(code.to_string()),
        file: Some(PathBuf::from(file)),
        line: Some(line),
        column,
        confidence,
        raw: Some(raw.to_string()),
    })
}

fn file_diagnostic() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"^(?P<vet>vet:\s+)?(?P<file>.+?\.go):(?P<line>\d+)(?::(?P<column>\d+))?:\s*(?P<message>.+)$",
        )
        .expect("valid Go file diagnostic pattern")
    })
}

fn failing_test() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^--- FAIL:\s+(?P<name>\S+)(?:\s+\([^)]*\))?\s*$")
            .expect("valid Go test failure header pattern")
    })
}

fn failing_package() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^FAIL\s+(?P<package>\S+)(?P<rest>.*)$")
            .expect("valid Go package failure pattern")
    })
}

fn undefined_identifier() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^undefined:\s+(?P<name>\S.*)$").expect("valid Go undefined identifier pattern")
    })
}

fn cannot_use() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^cannot use\b").expect("valid Go cannot-use pattern"))
}

fn vet_tool_error() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^vet:\s+(?P<message>.+)$").expect("valid Go vet tool error pattern")
    })
}

fn go_tool_error() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"^go:\s+(?P<message>.+)$").expect("valid Go tool error pattern")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_package_failure_header_as_gotest() {
        let mut state = ParserState::default();
        let (diagnostic, consumed) = parse_line(
            &mut state,
            "FAIL\texample.com/pkg\t0.123s",
            "FAIL\texample.com/pkg\t0.123s",
        );
        assert!(consumed);
        let diagnostic = diagnostic.expect("package failure header");
        assert_eq!(diagnostic.code.as_deref(), Some("GOTEST"));
        assert_eq!(diagnostic.message, "Test failed: example.com/pkg");
        assert_eq!(diagnostic.confidence, TEST_HEADER_CONFIDENCE);
    }
}
