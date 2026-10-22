use crate::model::{Diagnostic, DiagnosticSeverity};
use regex::Regex;
use std::path::PathBuf;
use std::sync::OnceLock;

const STRUCTURED_CONFIDENCE: f32 = 0.9;
const TEST_HEADER_CONFIDENCE: f32 = 0.6;

/// Parse one Go compiler/test/vet output line.
pub(crate) fn parse_line(text: &str, raw: &str) -> Option<Diagnostic> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }

    if let Some(captures) = file_diagnostic().captures(text) {
        let file = captures.name("file")?.as_str().trim();
        let line = captures.name("line")?.as_str().parse::<u32>().ok()?;
        let column = captures
            .name("column")
            .and_then(|column| column.as_str().parse::<u32>().ok());
        let message = captures.name("message")?.as_str().trim();
        let code = if captures.name("vet").is_some() {
            "GOVET"
        } else {
            "GO"
        };
        return Some(Diagnostic {
            severity: DiagnosticSeverity::Error,
            message: message.to_string(),
            code: Some(code.to_string()),
            file: Some(PathBuf::from(file)),
            line: Some(line),
            column,
            confidence: STRUCTURED_CONFIDENCE,
            raw: Some(raw.to_string()),
        });
    }

    if let Some(captures) = failing_test().captures(text) {
        let name = captures.name("name")?.as_str().trim();
        return Some(Diagnostic {
            severity: DiagnosticSeverity::Error,
            message: format!("Test failed: {name}"),
            code: Some("GOTEST".to_string()),
            file: None,
            line: None,
            column: None,
            confidence: TEST_HEADER_CONFIDENCE,
            raw: Some(raw.to_string()),
        });
    }

    if let Some(captures) = failing_package().captures(text) {
        let package = captures.name("package")?.as_str().trim();
        return Some(Diagnostic {
            severity: DiagnosticSeverity::Error,
            message: format!("Test failed: {package}"),
            code: Some("GOTEST".to_string()),
            file: None,
            line: None,
            column: None,
            confidence: TEST_HEADER_CONFIDENCE,
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
        Regex::new(r"^FAIL\s+(?P<package>\S+)(?:\s+.*)?$")
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
        let diagnostic = parse_line(
            "FAIL\texample.com/pkg\t0.123s",
            "FAIL\texample.com/pkg\t0.123s",
        )
        .expect("package failure header");
        assert_eq!(diagnostic.code.as_deref(), Some("GOTEST"));
        assert_eq!(diagnostic.message, "Test failed: example.com/pkg");
        assert_eq!(diagnostic.confidence, TEST_HEADER_CONFIDENCE);
    }
}
