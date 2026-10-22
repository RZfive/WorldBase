use crate::model::{Diagnostic, DiagnosticSeverity};
use regex::Regex;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Parse one Python compiler/test/linter output line.
pub(crate) fn parse_line(text: &str, raw: &str) -> Option<Diagnostic> {
    if let Some(diagnostic) = parse_ruff_or_flake8(text, raw) {
        return Some(diagnostic);
    }
    if let Some(diagnostic) = parse_mypy(text, raw) {
        return Some(diagnostic);
    }
    if let Some(diagnostic) = parse_traceback_file(text, raw) {
        return Some(diagnostic);
    }
    if let Some(diagnostic) = parse_pytest_failure(text, raw) {
        return Some(diagnostic);
    }
    if let Some(diagnostic) = parse_module_not_found(text, raw) {
        return Some(diagnostic);
    }
    if let Some(diagnostic) = parse_syntax_error(text, raw) {
        return Some(diagnostic);
    }
    if let Some(diagnostic) = parse_pytest_short_summary(text, raw) {
        return Some(diagnostic);
    }
    None
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
