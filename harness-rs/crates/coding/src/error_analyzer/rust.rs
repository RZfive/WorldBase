//! Rust compiler and test output parsing.
//!
//! Rustc splits one diagnostic across two lines: the header carries severity
//! and error code, while the following `--> file:line:column` carries the
//! span. `parse_line` receives one line at a time and the shared stream parser
//! has no continuation hook, so this module keeps a thread-local pending
//! header until its span line arrives. A pending header is flushed without a
//! location if any other line follows first.

use crate::model::{Diagnostic, DiagnosticSeverity};
use regex::Regex;
use std::{path::PathBuf, sync::OnceLock};

const STRUCTURED_CONFIDENCE: f32 = 0.95;
const RUNTIME_CONFIDENCE: f32 = 0.7;

/// Per-stream state for rustc diagnostics whose location arrives on a later
/// line. Keeping it in the caller avoids cross-outcome state leakage.
#[derive(Default)]
pub(crate) struct ParserState {
    pending: Option<Diagnostic>,
}

struct ParsedLine {
    diagnostic: Diagnostic,
    awaits_location: bool,
}

/// Parse one Rust compiler/test output line.
///
/// The boolean is true when this parser owns the line, even if the header is
/// still waiting for its `-->` location.
pub(crate) fn parse_line(
    state: &mut ParserState,
    text: &str,
    raw: &str,
) -> (Option<Diagnostic>, bool) {
    if let Some(captures) = location_regex().captures(text) {
        let Some(file) = captures
            .name("file")
            .map(|file| file.as_str().trim().to_string())
        else {
            return (None, true);
        };
        let Some(line) = captures
            .name("line")
            .and_then(|line| parse_u32(line.as_str()))
        else {
            return (None, true);
        };
        let Some(column) = captures
            .name("column")
            .and_then(|column| parse_u32(column.as_str()))
        else {
            return (None, true);
        };
        if let Some(mut diagnostic) = state.pending.take() {
            diagnostic.file = Some(PathBuf::from(file));
            diagnostic.line = Some(line);
            diagnostic.column = Some(column);
            return (Some(diagnostic), true);
        }
        return (None, true);
    }

    match parse_single_line(text, raw) {
        Some(ParsedLine {
            diagnostic,
            awaits_location: true,
        }) => {
            state.pending = Some(diagnostic);
            (None, true)
        }
        Some(ParsedLine {
            diagnostic,
            awaits_location: false,
        }) => (Some(diagnostic), true),
        None => (None, false),
    }
}

/// Flush a pending header when the current line can no longer be its location.
pub(crate) fn flush_if_boundary(state: &mut ParserState, text: &str, raw: &str) -> Vec<Diagnostic> {
    if state.pending.is_none() || location_regex().is_match(text) || is_location_context(text, raw)
    {
        return Vec::new();
    }
    state.pending.take().into_iter().collect()
}

/// Flush a header that never received a following `-->` location.
pub(crate) fn finish(state: &mut ParserState) -> Vec<Diagnostic> {
    state.pending.take().into_iter().collect()
}

fn is_location_context(text: &str, raw: &str) -> bool {
    raw.starts_with(' ')
        || raw.starts_with('\t')
        || text.starts_with('|')
        || text.starts_with('=')
        || text.starts_with("note:")
        || text.starts_with("help:")
        || text.starts_with("...")
}

fn parse_single_line(text: &str, raw: &str) -> Option<ParsedLine> {
    if let Some(diagnostic) = parse_could_not_compile(text, raw) {
        return Some(immediate(diagnostic));
    }
    if let Some(diagnostic) = parse_aborting(text, raw) {
        return Some(immediate(diagnostic));
    }
    if let Some(diagnostic) = parse_panic(text, raw) {
        return Some(immediate(diagnostic));
    }
    if let Some(diagnostic) = parse_test_failure(text, raw) {
        return Some(immediate(diagnostic));
    }
    if let Some(diagnostic) = parse_short_form(text, raw) {
        return Some(immediate(diagnostic));
    }
    parse_header(text, raw)
}

fn immediate(diagnostic: Diagnostic) -> ParsedLine {
    ParsedLine {
        diagnostic,
        awaits_location: false,
    }
}

fn parse_could_not_compile(text: &str, raw: &str) -> Option<Diagnostic> {
    let captures = could_not_compile_regex().captures(text)?;
    let rest = captures.name("rest").map_or("", |rest| rest.as_str());
    Some(structured(
        DiagnosticSeverity::Error,
        format!("could not compile{}", rest.trim_end()),
        "RUSTC".into(),
        None,
        None,
        None,
        raw,
    ))
}

fn parse_aborting(text: &str, raw: &str) -> Option<Diagnostic> {
    let captures = aborting_regex().captures(text)?;
    let message = captures.name("message")?.as_str().trim();
    Some(structured(
        DiagnosticSeverity::Error,
        message.to_string(),
        "RUSTC".into(),
        None,
        None,
        None,
        raw,
    ))
}

fn parse_panic(text: &str, raw: &str) -> Option<Diagnostic> {
    let captures = panic_regex().captures(text)?;
    let thread = captures.name("thread")?.as_str();
    let file = captures.name("file")?.as_str().trim();
    let line = parse_u32(captures.name("line")?.as_str())?;
    let column = parse_u32(captures.name("column")?.as_str())?;
    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message: format!("thread '{thread}' panicked"),
        code: Some("TEST".into()),
        file: Some(PathBuf::from(file)),
        line: Some(line),
        column: Some(column),
        confidence: RUNTIME_CONFIDENCE,
        raw: Some(raw.to_string()),
    })
}

fn parse_test_failure(text: &str, raw: &str) -> Option<Diagnostic> {
    let captures = test_failure_regex().captures(text)?;
    let name = captures.name("name")?.as_str();
    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message: format!("Test failed: {name}"),
        code: Some("TEST".into()),
        file: None,
        line: None,
        column: None,
        confidence: RUNTIME_CONFIDENCE,
        raw: Some(raw.to_string()),
    })
}

fn parse_short_form(text: &str, raw: &str) -> Option<Diagnostic> {
    let captures = short_form_regex().captures(text)?;
    let file = captures.name("file")?.as_str().trim();
    let line = parse_u32(captures.name("line")?.as_str())?;
    let column = parse_u32(captures.name("column")?.as_str())?;
    let severity = parse_severity(captures.name("severity")?.as_str());
    let code = captures
        .name("code")
        .map_or_else(|| "RUSTC".to_string(), |code| code.as_str().to_string());
    let message = captures.name("message")?.as_str().trim();
    Some(structured(
        severity,
        message.to_string(),
        code,
        Some(PathBuf::from(file)),
        Some(line),
        Some(column),
        raw,
    ))
}

fn parse_header(text: &str, raw: &str) -> Option<ParsedLine> {
    let captures = header_regex().captures(text)?;
    let severity = parse_severity(captures.name("severity")?.as_str());
    let code = captures
        .name("code")
        .map_or_else(|| "RUSTC".to_string(), |code| code.as_str().to_string());
    let message = captures.name("message")?.as_str().trim();
    Some(ParsedLine {
        diagnostic: structured(severity, message.to_string(), code, None, None, None, raw),
        awaits_location: true,
    })
}

fn structured(
    severity: DiagnosticSeverity,
    message: String,
    code: String,
    file: Option<PathBuf>,
    line: Option<u32>,
    column: Option<u32>,
    raw: &str,
) -> Diagnostic {
    Diagnostic {
        severity,
        message,
        code: Some(code),
        file,
        line,
        column,
        confidence: STRUCTURED_CONFIDENCE,
        raw: Some(raw.to_string()),
    }
}

fn parse_severity(value: &str) -> DiagnosticSeverity {
    if value.eq_ignore_ascii_case("warning") {
        DiagnosticSeverity::Warning
    } else {
        DiagnosticSeverity::Error
    }
}

fn parse_u32(value: &str) -> Option<u32> {
    value.parse().ok()
}

fn could_not_compile_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^(?:error:\s*)?could not compile(?P<rest>\b.*)$")
            .expect("valid rustc could-not-compile regex")
    })
}

fn aborting_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^error:\s*(?P<message>aborting due to .+)$")
            .expect("valid rustc aborting regex")
    })
}

fn panic_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"^thread '(?P<thread>[^']*)' panicked at (?P<file>.+?):(?P<line>\d+):(?P<column>\d+):?$",
        )
        .expect("valid rust panic regex")
    })
}

fn test_failure_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^test\s+(?P<name>\S+)\s+\.\.\.\s+FAILED$")
            .expect("valid cargo test failure regex")
    })
}

fn short_form_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(
            r"^(?P<file>.+?):(?P<line>\d+):(?P<column>\d+):\s*(?P<severity>error|warning)(?:\[(?P<code>E\d+)\])?:\s*(?P<message>.+)$",
        )
        .expect("valid rustc short-form regex")
    })
}

fn header_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^(?P<severity>error|warning)(?:\[(?P<code>E\d+)\])?:\s*(?P<message>.+)$")
            .expect("valid rustc header regex")
    })
}

fn location_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"^-->\s+(?P<file>.+?):(?P<line>\d+):(?P<column>\d+)$")
            .expect("valid rustc location regex")
    })
}
