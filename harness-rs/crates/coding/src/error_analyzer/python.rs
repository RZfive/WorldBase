use crate::model::{Diagnostic, DiagnosticSeverity};
use regex::Regex;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Per-stream state for Python tracebacks. A frame is held until the following
/// exception line arrives, so one traceback yields one diagnostic instead of
/// one duplicate per stack frame.
#[derive(Default)]
pub(crate) struct ParserState {
    traceback: Option<Diagnostic>,
}

/// Parse one Python compiler/test/linter output line.
///
/// The boolean is true when this parser owns the line, even if a traceback
/// frame is still waiting for its exception line.
pub(crate) fn parse_line(
    state: &mut ParserState,
    text: &str,
    raw: &str,
) -> (Option<Diagnostic>, bool) {
    if let Some(diagnostic) = parse_traceback_file(text, raw) {
        state.traceback = Some(diagnostic);
        return (None, true);
    }

    if let Some(mut diagnostic) = state.traceback.take() {
        if let Some(exception) = parse_traceback_exception(text) {
            diagnostic.message = exception;
            diagnostic.raw = Some(raw.to_string());
            return (Some(diagnostic), true);
        }
        if is_traceback_followup(text, raw) {
            state.traceback = Some(diagnostic);
            return (None, true);
        }
        // A new unrelated line: release the frame and let the caller parse the
        // current line normally.
        return (Some(diagnostic), false);
    }

    let diagnostic = parse_ruff_or_flake8(text, raw)
        .or_else(|| parse_mypy(text, raw))
        .or_else(|| parse_pytest_failure(text, raw))
        .or_else(|| parse_module_not_found(text, raw))
        .or_else(|| parse_syntax_error(text, raw))
        .or_else(|| parse_pytest_short_summary(text, raw));
    match diagnostic {
        Some(diagnostic) => (Some(diagnostic), true),
        None => (None, false),
    }
}

/// Flush a held traceback frame when the current line cannot extend it.
pub(crate) fn flush_if_boundary(state: &mut ParserState, text: &str, raw: &str) -> Vec<Diagnostic> {
    if state.traceback.is_none()
        || parse_traceback_file(text, raw).is_some()
        || parse_traceback_exception(text).is_some()
        || is_traceback_followup(text, raw)
    {
        return Vec::new();
    }
    state.traceback.take().into_iter().collect()
}

/// Emit the last traceback frame when no exception line follows it.
pub(crate) fn finish(state: &mut ParserState) -> Vec<Diagnostic> {
    state.traceback.take().into_iter().collect()
}

fn is_traceback_followup(text: &str, raw: &str) -> bool {
    raw.starts_with(' ')
        || raw.starts_with('\t')
        || text.starts_with("Traceback (most recent call last):")
        || text.starts_with("During handling of the above exception")
        || text.starts_with("The above exception was the direct cause")
}

fn parse_traceback_exception(text: &str) -> Option<String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r"^(?P<name>[A-Za-z_][A-Za-z0-9_.]*)(?::\s*(?P<message>.*))?$")
            .expect("valid Python traceback exception regex")
    });
    let captures = pattern.captures(text)?;
    let name = captures.name("name")?.as_str();
    if !name.chars().next().is_some_and(char::is_uppercase) {
        return None;
    }
    let has_message = captures.name("message").is_some();
    let known = [
        "Error",
        "Exception",
        "Warning",
        "Interrupt",
        "Exit",
        "Stop",
        "Iteration",
    ]
    .iter()
    .any(|suffix| name.ends_with(suffix));
    if !has_message && !known {
        return None;
    }
    Some(text.trim().to_string())
}

fn parse_ruff_or_flake8(text: &str, raw: &str) -> Option<Diagnostic> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(
            r"^(?P<file>.+?\.pyi?):(?P<line>\d+):(?P<column>\d+):\s*(?P<code>[A-Za-z]+\d+)\s+(?P<message>.+)$",
        )
        .expect("valid Ruff/Flake8 diagnostic regex")
    });
    let captures = pattern.captures(text)?;
    let code = captures.name("code")?.as_str().to_string();
    let severity = if code.starts_with('W') {
        DiagnosticSeverity::Warning
    } else {
        DiagnosticSeverity::Error
    };
    Some(Diagnostic {
        severity,
        message: captures.name("message")?.as_str().trim().to_string(),
        code: Some(code),
        file: Some(PathBuf::from(captures.name("file")?.as_str())),
        line: parse_u32(captures.name("line")?),
        column: parse_u32(captures.name("column")?),
        confidence: 0.9,
        raw: Some(raw.to_string()),
    })
}

fn parse_mypy(text: &str, raw: &str) -> Option<Diagnostic> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(
            r"^(?P<file>.+?\.pyi?):(?P<line>\d+)(?::(?P<column>\d+))?:\s*(?P<severity>error|warning|note):\s*(?P<message>.+?)(?:\s+\[(?P<code>[A-Za-z0-9_-]+)\])?$",
        )
        .expect("valid mypy diagnostic regex")
    });
    let captures = pattern.captures(text)?;
    let severity = match captures.name("severity")?.as_str() {
        "warning" => DiagnosticSeverity::Warning,
        "note" => DiagnosticSeverity::Info,
        _ => DiagnosticSeverity::Error,
    };
    Some(Diagnostic {
        severity,
        message: captures.name("message")?.as_str().trim().to_string(),
        code: captures.name("code").map(|code| code.as_str().to_string()),
        file: Some(PathBuf::from(captures.name("file")?.as_str())),
        line: parse_u32(captures.name("line")?),
        column: captures.name("column").and_then(parse_u32),
        confidence: 0.9,
        raw: Some(raw.to_string()),
    })
}

fn parse_traceback_file(text: &str, raw: &str) -> Option<Diagnostic> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(
            r#"^\s*File\s+"(?P<file>.+?\.pyi?)",\s*line\s+(?P<line>\d+)(?:,\s*in\s+(?P<context>.+))?$"#,
        )
        .expect("valid Python traceback file regex")
    });
    let captures = pattern.captures(text)?;
    let message = captures
        .name("context")
        .map(|context| format!("Traceback in {}", context.as_str().trim()))
        .unwrap_or_else(|| "Python traceback".to_string());
    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message,
        code: Some("PYTHON".into()),
        file: Some(PathBuf::from(captures.name("file")?.as_str())),
        line: parse_u32(captures.name("line")?),
        column: None,
        confidence: 0.6,
        raw: Some(raw.to_string()),
    })
}

fn parse_pytest_failure(text: &str, raw: &str) -> Option<Diagnostic> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r"^FAILED\s+(?P<file>.+?\.pyi?)::(?P<test>\S+)(?:\s+-\s+(?P<message>.*))?$")
            .expect("valid pytest failure regex")
    });
    let captures = pattern.captures(text)?;
    let test = captures.name("test")?.as_str();
    let message = captures
        .name("message")
        .map(|message| message.as_str().trim().to_string())
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| format!("Test failed: {test}"));
    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message,
        code: Some("PYTEST".into()),
        file: Some(PathBuf::from(captures.name("file")?.as_str())),
        line: None,
        column: None,
        confidence: 0.6,
        raw: Some(raw.to_string()),
    })
}

fn parse_pytest_short_summary(text: &str, raw: &str) -> Option<Diagnostic> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r"^E\s+(?P<message>.+)$").expect("valid pytest short summary regex")
    });
    let captures = pattern.captures(text)?;
    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message: captures.name("message")?.as_str().trim().to_string(),
        code: Some("PYTEST".into()),
        file: None,
        line: None,
        column: None,
        confidence: 0.6,
        raw: Some(raw.to_string()),
    })
}

fn parse_module_not_found(text: &str, raw: &str) -> Option<Diagnostic> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r"^(?:E\s+)?ModuleNotFoundError:\s*(?P<message>No module named .+)$")
            .expect("valid ModuleNotFoundError regex")
    });
    let captures = pattern.captures(text)?;
    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message: captures.name("message")?.as_str().trim().to_string(),
        code: Some("PYTHON".into()),
        file: None,
        line: None,
        column: None,
        confidence: 0.9,
        raw: Some(raw.to_string()),
    })
}

fn parse_syntax_error(text: &str, raw: &str) -> Option<Diagnostic> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r"^(?:E\s+)?(?P<kind>SyntaxError|IndentationError|TabError):\s*(?P<message>.+)$")
            .expect("valid Python syntax error regex")
    });
    let captures = pattern.captures(text)?;
    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message: captures.name("message")?.as_str().trim().to_string(),
        code: Some("PYTHON".into()),
        file: None,
        line: None,
        column: None,
        confidence: 0.9,
        raw: Some(raw.to_string()),
    })
}

fn parse_u32(capture: regex::Match<'_>) -> Option<u32> {
    capture.as_str().parse().ok()
}
