use crate::model::{Diagnostic, DiagnosticSeverity};
use regex::Regex;
use std::path::PathBuf;
use std::sync::OnceLock;

const STRUCTURED_CONFIDENCE: f32 = 0.9;
const HEADER_CONFIDENCE: f32 = 0.6;

/// Per-stream state for javac/Maven diagnostics whose `symbol`, `location`,
/// `required`, or `found` details arrive on continuation lines.
#[derive(Default)]
pub(crate) struct ParserState {
    pending: Option<Diagnostic>,
}

/// Parse one Java compiler/Maven/Gradle/JUnit/JVM output line.
///
/// The boolean is true when this parser owns the line, even if a javac/Maven
/// diagnostic is still waiting for continuation details.
pub(crate) fn parse_line(
    state: &mut ParserState,
    text: &str,
    raw: &str,
) -> (Option<Diagnostic>, bool) {
    if let Some(detail) = continuation_detail(text) {
        if let Some(pending) = state.pending.as_mut() {
            if !pending.message.contains(detail) {
                if pending.message.is_empty() {
                    pending.message = detail.to_string();
                } else {
                    pending.message.push_str("; ");
                    pending.message.push_str(detail);
                }
            }
        }
        return (None, true);
    }

    if let Some(diagnostic) = parse_javac(text, raw).or_else(|| parse_maven_coordinate(text, raw)) {
        state.pending = Some(diagnostic);
        return (None, true);
    }

    let immediate = parse_junit_summary(text, raw)
        .or_else(|| parse_kotlin(text, raw))
        .or_else(|| parse_gradle_task(text, raw))
        .or_else(|| parse_build_header(text, raw))
        .or_else(|| parse_maven_goal(text, raw))
        .or_else(|| parse_stack_frame(text, raw))
        .or_else(|| parse_java_exception(text, raw));
    match immediate {
        Some(diagnostic) => (Some(diagnostic), true),
        None => (None, false),
    }
}

/// Flush a pending javac/Maven diagnostic when the current line is not one of
/// its continuation details.
pub(crate) fn flush_if_boundary(
    state: &mut ParserState,
    text: &str,
    _raw: &str,
) -> Vec<Diagnostic> {
    if state.pending.is_none() || continuation_detail(text).is_some() {
        return Vec::new();
    }
    state.pending.take().into_iter().collect()
}

/// Emit a javac/Maven diagnostic that had no continuation lines.
pub(crate) fn finish(state: &mut ParserState) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    flush_pending(state, &mut diagnostics);
    diagnostics
}

fn flush_pending(state: &mut ParserState, diagnostics: &mut Vec<Diagnostic>) {
    if let Some(pending) = state.pending.take() {
        diagnostics.push(pending);
    }
}

fn continuation_detail(text: &str) -> Option<&str> {
    let trimmed = text.trim();
    let detail = trimmed
        .strip_prefix("[ERROR]")
        .map(str::trim_start)
        .unwrap_or(trimmed);
    ["symbol:", "location:", "required:", "found:", "reason:"]
        .into_iter()
        .any(|prefix| detail.starts_with(prefix))
        .then_some(detail)
}

fn parse_javac(text: &str, raw: &str) -> Option<Diagnostic> {
    static JAVAC: OnceLock<Regex> = OnceLock::new();
    let javac = JAVAC.get_or_init(|| {
        Regex::new(
            r"^(?P<file>.+?\.java):(?P<line>\d+)(?::(?P<column>\d+))?:\s*(?P<severity>error|warning):\s*(?P<message>.+)$",
        )
        .expect("valid javac diagnostic regex")
    });
    let captures = javac.captures(text)?;
    let file = captures.name("file")?.as_str().trim();
    let line = parse_u32(captures.name("line")?.as_str())?;
    let column = captures
        .name("column")
        .and_then(|column| parse_u32(column.as_str()));
    let severity = parse_severity(captures.name("severity")?.as_str());
    let message = captures.name("message")?.as_str().trim();

    Some(Diagnostic {
        severity,
        message: message.to_string(),
        code: Some("JAVAC".into()),
        file: Some(PathBuf::from(file)),
        line: Some(line),
        column,
        confidence: STRUCTURED_CONFIDENCE,
        raw: Some(raw.to_string()),
    })
}

fn parse_maven_coordinate(text: &str, raw: &str) -> Option<Diagnostic> {
    static MAVEN_COORDINATE: OnceLock<Regex> = OnceLock::new();
    let coordinate = MAVEN_COORDINATE.get_or_init(|| {
        Regex::new(
            r"^\[(?P<severity>ERROR|WARNING)\]\s+(?P<file>.+?\.java):\[(?P<line>\d+)(?:,(?P<column>\d+))?\]\s*(?P<message>.*)$",
        )
        .expect("valid Maven coordinate diagnostic regex")
    });
    let captures = coordinate.captures(text)?;
    let file = captures.name("file")?.as_str().trim();
    let line = parse_u32(captures.name("line")?.as_str())?;
    let column = captures
        .name("column")
        .and_then(|column| parse_u32(column.as_str()));
    let severity = parse_severity(captures.name("severity")?.as_str());
    let message = captures
        .name("message")
        .map_or("", |value| value.as_str())
        .trim();

    Some(Diagnostic {
        severity,
        message: message.to_string(),
        code: Some("MAVEN".into()),
        file: Some(PathBuf::from(file)),
        line: Some(line),
        column,
        confidence: STRUCTURED_CONFIDENCE,
        raw: Some(raw.to_string()),
    })
}

fn parse_junit_summary(text: &str, raw: &str) -> Option<Diagnostic> {
    static JUNIT: OnceLock<Regex> = OnceLock::new();
    let junit = JUNIT.get_or_init(|| {
        Regex::new(
            r"^(?:\[ERROR\]\s+)?Tests run:\s*(?P<run>\d+),\s*Failures:\s*(?P<failures>\d+),\s*Errors:\s*(?P<errors>\d+).*$",
        )
        .expect("valid JUnit summary regex")
    });
    let captures = junit.captures(text)?;
    let failures = parse_u32(captures.name("failures")?.as_str())?;
    let errors = parse_u32(captures.name("errors")?.as_str())?;
    if failures == 0 && errors == 0 {
        return None;
    }
    let run = parse_u32(captures.name("run")?.as_str())?;
    let message = text
        .strip_prefix("[ERROR]")
        .map(str::trim)
        .unwrap_or(text)
        .to_string();

    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message: format!("{message} ({failures} failure(s), {errors} error(s) in {run} test(s))"),
        code: Some("JUNIT".into()),
        file: None,
        line: None,
        column: None,
        confidence: HEADER_CONFIDENCE,
        raw: Some(raw.to_string()),
    })
}

fn parse_kotlin(text: &str, raw: &str) -> Option<Diagnostic> {
    static KOTLIN: OnceLock<Regex> = OnceLock::new();
    let kotlin = KOTLIN.get_or_init(|| {
        Regex::new(
            r"^(?P<severity>e|w):\s+(?:file://)?(?P<file>.+?):(?P<line>\d+):(?P<column>\d+):?\s+(?P<message>.+)$",
        )
        .expect("valid Kotlin diagnostic regex")
    });
    let captures = kotlin.captures(text)?;
    let file = captures.name("file")?.as_str().trim();
    let line = parse_u32(captures.name("line")?.as_str())?;
    let column = parse_u32(captures.name("column")?.as_str())?;
    let severity = match captures.name("severity")?.as_str() {
        "w" => DiagnosticSeverity::Warning,
        _ => DiagnosticSeverity::Error,
    };
    let message = captures.name("message")?.as_str().trim();

    Some(Diagnostic {
        severity,
        message: message.to_string(),
        code: Some("GRADLE".into()),
        file: Some(PathBuf::from(file)),
        line: Some(line),
        column: Some(column),
        confidence: STRUCTURED_CONFIDENCE,
        raw: Some(raw.to_string()),
    })
}

fn parse_gradle_task(text: &str, raw: &str) -> Option<Diagnostic> {
    static GRADLE_TASK: OnceLock<Regex> = OnceLock::new();
    let task = GRADLE_TASK.get_or_init(|| {
        Regex::new(r"^>\s*Task\s+(?P<task>\S+)\s+FAILED$").expect("valid Gradle failed-task regex")
    });
    let captures = task.captures(text)?;
    let task_name = captures.name("task")?.as_str();

    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message: format!("Gradle task {task_name} failed"),
        code: Some("GRADLE".into()),
        file: None,
        line: None,
        column: None,
        confidence: HEADER_CONFIDENCE,
        raw: Some(raw.to_string()),
    })
}

fn parse_build_header(text: &str, raw: &str) -> Option<Diagnostic> {
    let code = match text {
        "BUILD FAILURE" => "MAVEN",
        "BUILD FAILED" | "FAILURE: Build failed with an exception." => "GRADLE",
        _ => return None,
    };

    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message: text.to_string(),
        code: Some(code.into()),
        file: None,
        line: None,
        column: None,
        confidence: HEADER_CONFIDENCE,
        raw: Some(raw.to_string()),
    })
}

fn parse_maven_goal(text: &str, raw: &str) -> Option<Diagnostic> {
    let message = text.strip_prefix("[ERROR]")?.trim();
    if !message.starts_with("Failed to execute goal") {
        return None;
    }

    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message: message.to_string(),
        code: Some("MAVEN".into()),
        file: None,
        line: None,
        column: None,
        confidence: HEADER_CONFIDENCE,
        raw: Some(raw.to_string()),
    })
}

fn parse_stack_frame(text: &str, raw: &str) -> Option<Diagnostic> {
    static STACK_FRAME: OnceLock<Regex> = OnceLock::new();
    let frame = STACK_FRAME.get_or_init(|| {
        Regex::new(r"^\s*at\s+.+?\((?P<location>[^()]*)\)\s*$")
            .expect("valid Java stack-frame regex")
    });
    let captures = frame.captures(text)?;
    let location = captures.name("location")?.as_str().trim();
    let (file, line, column) = parse_stack_location(location);

    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message: text.trim().to_string(),
        code: Some("JAVA".into()),
        file,
        line,
        column,
        confidence: STRUCTURED_CONFIDENCE,
        raw: Some(raw.to_string()),
    })
}

fn parse_stack_location(location: &str) -> (Option<PathBuf>, Option<u32>, Option<u32>) {
    static FRAME_LOCATION: OnceLock<Regex> = OnceLock::new();
    let frame_location = FRAME_LOCATION.get_or_init(|| {
        Regex::new(r"^(?:file://)?(?P<file>[^:]+):(?P<line>\d+)(?::(?P<column>\d+))?$")
            .expect("valid Java stack-frame location regex")
    });
    let Some(captures) = frame_location.captures(location) else {
        return (None, None, None);
    };
    let file = captures
        .name("file")
        .map(|file| PathBuf::from(file.as_str().trim()));
    let line = captures
        .name("line")
        .and_then(|line| parse_u32(line.as_str()));
    let column = captures
        .name("column")
        .and_then(|column| parse_u32(column.as_str()));
    (file, line, column)
}

fn parse_java_exception(text: &str, raw: &str) -> Option<Diagnostic> {
    static EXCEPTION: OnceLock<Regex> = OnceLock::new();
    let exception = EXCEPTION.get_or_init(|| {
        Regex::new(
            r#"^(?:Caused by:\s+|Exception in thread "[^"]*"\s+)?(?P<exception>(?:[A-Za-z_$][\w$]*\.)+[A-Za-z_$][\w$]*(?:Exception|Error|Throwable))(?::\s*.*)?$"#,
        )
        .expect("valid Java exception-header regex")
    });
    let captures = exception.captures(text)?;
    captures.name("exception")?;

    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message: text.trim().to_string(),
        code: Some("JAVA".into()),
        file: None,
        line: None,
        column: None,
        confidence: STRUCTURED_CONFIDENCE,
        raw: Some(raw.to_string()),
    })
}

fn parse_u32(value: &str) -> Option<u32> {
    value.parse().ok()
}

fn parse_severity(value: &str) -> DiagnosticSeverity {
    if value.eq_ignore_ascii_case("warning") {
        DiagnosticSeverity::Warning
    } else {
        DiagnosticSeverity::Error
    }
}
