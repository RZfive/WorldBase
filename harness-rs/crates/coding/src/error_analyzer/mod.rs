//! Normalize compiler, typecheck, lint, and test output into diagnostics.
//!
//! The analyzer is deliberately pure: it never touches the filesystem,
//! network, providers, or command execution. Callers pass normalized
//! diagnostics or `CommandOutcome` values and receive deterministic reports.

pub mod patterns;

pub use patterns::{matching_pattern, ErrorCategory, ErrorPattern};

mod go;
mod java;
mod python;
mod rust;

use crate::model::{CommandOutcome, Diagnostic, DiagnosticSeverity};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet, HashSet},
    path::PathBuf,
    sync::OnceLock,
};

const STRUCTURED_CONFIDENCE: f32 = 0.95;
const TEST_HEADER_CONFIDENCE: f32 = 0.8;
const FALLBACK_CONFIDENCE: f32 = 0.1;

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// Parse common frontend diagnostics from both captured output streams.
///
/// Parsers are deliberately conservative: a fully structured TypeScript or
/// ESLint line gets high confidence, test headers get medium confidence, and
/// unrecognized failures retain their raw output at low confidence.
pub fn normalize_outcome(outcome: &CommandOutcome) -> Vec<Diagnostic> {
    let mut diagnostics = Vec::new();
    parse_stream(&outcome.stdout, &mut diagnostics);
    parse_stream(&outcome.stderr, &mut diagnostics);

    if diagnostics.is_empty() && !outcome.succeeded() {
        if let Some(diagnostic) = fallback_diagnostic(outcome) {
            diagnostics.push(diagnostic);
        }
    }

    diagnostics
}

/// Aggregated evidence for one matched error pattern.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternMatch {
    pub pattern_id: String,
    pub category: ErrorCategory,
    pub count: usize,
    pub files: Vec<PathBuf>,
    pub confidence: f32,
    pub fix_hint: String,
}

/// Deterministic diagnosis of a verification failure.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosisReport {
    pub matches: Vec<PatternMatch>,
    pub error_count: usize,
    pub warning_count: usize,
    pub primary_category: ErrorCategory,
    pub affected_files: Vec<PathBuf>,
    pub failure_signature: String,
    pub summary: String,
    pub repair_instructions: Vec<String>,
    pub has_repairable_issues: bool,
}

/// Match, de-duplicate, and rank normalized diagnostics.
pub fn analyze_diagnostics(diagnostics: &[Diagnostic]) -> DiagnosisReport {
    let unique = deduplicate(diagnostics);

    let mut error_count = 0;
    let mut warning_count = 0;
    let mut affected_files = BTreeSet::new();
    let mut accumulators: Vec<PatternAccumulator> = Vec::new();

    for diagnostic in &unique {
        if let Some(file) = &diagnostic.file {
            affected_files.insert(file.clone());
        }

        let pattern = matching_pattern(diagnostic);
        let severity = pattern
            .and_then(|pattern| pattern.severity)
            .unwrap_or(diagnostic.severity);
        match severity {
            DiagnosticSeverity::Error => error_count += 1,
            DiagnosticSeverity::Warning => warning_count += 1,
            DiagnosticSeverity::Info => {}
        }

        let Some(pattern) = pattern else {
            continue;
        };
        let severity_rank = severity_rank(severity);
        if let Some(accumulator) = accumulators
            .iter_mut()
            .find(|accumulator| accumulator.pattern.id == pattern.id)
        {
            accumulator.count += 1;
            accumulator.severity_rank = accumulator.severity_rank.min(severity_rank);
            if let Some(file) = &diagnostic.file {
                accumulator.files.insert(file.clone());
            }
        } else {
            let mut files = BTreeSet::new();
            if let Some(file) = &diagnostic.file {
                files.insert(file.clone());
            }
            accumulators.push(PatternAccumulator {
                pattern,
                count: 1,
                files,
                severity_rank,
            });
        }
    }

    accumulators.sort_by(|left, right| {
        left.severity_rank
            .cmp(&right.severity_rank)
            .then_with(|| right.count.cmp(&left.count))
            .then_with(|| left.pattern.priority.cmp(&right.pattern.priority))
            .then_with(|| left.pattern.id.cmp(right.pattern.id))
    });

    let matches = accumulators
        .into_iter()
        .map(|accumulator| PatternMatch {
            pattern_id: accumulator.pattern.id.to_string(),
            category: accumulator.pattern.category,
            count: accumulator.count,
            files: accumulator.files.into_iter().collect(),
            confidence: accumulator.pattern.confidence,
            fix_hint: accumulator.pattern.fix_hint.to_string(),
        })
        .collect::<Vec<_>>();

    let primary_category = matches
        .first()
        .map(|pattern_match| pattern_match.category)
        .unwrap_or(ErrorCategory::Unknown);
    let affected_files = affected_files.into_iter().collect::<Vec<_>>();
    let failure_signature = failure_signature(&unique);
    let repair_instructions = build_repair_instructions(&matches);
    let has_repairable_issues = error_count > 0 || !matches.is_empty();
    let summary = if unique.is_empty() {
        "No diagnostics; nothing to repair.".to_string()
    } else {
        format!(
            "{error_count} error(s), {warning_count} warning(s); {} matched pattern(s) across {} file(s); primary category: {primary_category}.",
            matches.len(),
            affected_files.len()
        )
    };

    DiagnosisReport {
        matches,
        error_count,
        warning_count,
        primary_category,
        affected_files,
        failure_signature,
        summary,
        repair_instructions,
        has_repairable_issues,
    }
}

/// Normalize every outcome first, then produce one combined diagnosis.
pub fn analyze_outcomes(outcomes: &[CommandOutcome]) -> DiagnosisReport {
    let diagnostics = outcomes
        .iter()
        .flat_map(normalize_outcome)
        .collect::<Vec<_>>();
    analyze_diagnostics(&diagnostics)
}

struct PatternAccumulator {
    pattern: &'static ErrorPattern,
    count: usize,
    files: BTreeSet<PathBuf>,
    severity_rank: u8,
}

type RepairGroups = BTreeMap<(ErrorCategory, Option<PathBuf>), BTreeSet<(String, String)>>;

fn deduplicate(diagnostics: &[Diagnostic]) -> Vec<&Diagnostic> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for diagnostic in diagnostics {
        let key = (
            diagnostic.code.clone(),
            diagnostic.file.clone(),
            diagnostic.line,
            diagnostic.column,
            diagnostic.message.clone(),
        );
        if seen.insert(key) {
            unique.push(diagnostic);
        }
    }
    unique
}

fn severity_rank(severity: DiagnosticSeverity) -> u8 {
    match severity {
        DiagnosticSeverity::Error => 0,
        DiagnosticSeverity::Warning => 1,
        DiagnosticSeverity::Info => 2,
    }
}

/// FNV-1a over sorted `(code, file, line, message)` tuples. This deliberately
/// avoids `DefaultHasher` so signatures stay stable across processes/toolchains.
fn failure_signature(diagnostics: &[&Diagnostic]) -> String {
    let mut records = diagnostics
        .iter()
        .map(|diagnostic| {
            format!(
                "code={}\u{1f}file={}\u{1f}line={}\u{1f}message={}",
                diagnostic.code.as_deref().unwrap_or(""),
                diagnostic
                    .file
                    .as_ref()
                    .map(|file| file.to_string_lossy())
                    .unwrap_or(Cow::Borrowed("")),
                diagnostic
                    .line
                    .map(|line| line.to_string())
                    .unwrap_or_default(),
                diagnostic.message
            )
        })
        .collect::<Vec<_>>();
    records.sort();

    let mut hash = FNV_OFFSET_BASIS;
    for (index, record) in records.iter().enumerate() {
        if index > 0 {
            hash = fnv1a_byte(hash, b'\n');
        }
        for byte in record.as_bytes() {
            hash = fnv1a_byte(hash, *byte);
        }
    }
    format!("fnv1a64:{hash:016x}")
}

fn fnv1a_byte(hash: u64, byte: u8) -> u64 {
    (hash ^ u64::from(byte)).wrapping_mul(FNV_PRIME)
}

fn build_repair_instructions(matches: &[PatternMatch]) -> Vec<String> {
    let mut grouped = RepairGroups::new();

    for pattern_match in matches {
        let targets = if pattern_match.files.is_empty() {
            vec![None]
        } else {
            pattern_match.files.iter().cloned().map(Some).collect()
        };
        for target in targets {
            grouped
                .entry((pattern_match.category, target))
                .or_default()
                .insert((
                    pattern_match.fix_hint.clone(),
                    pattern_match.pattern_id.clone(),
                ));
        }
    }

    grouped
        .into_iter()
        .map(|((category, file), hints)| {
            let target = file
                .map(|file| file.display().to_string())
                .unwrap_or_else(|| "reported output".to_string());
            let guidance = hints
                .into_iter()
                .map(|(hint, pattern_id)| format!("{hint} [{pattern_id}]"))
                .collect::<Vec<_>>()
                .join(" ");
            format!("{category}: {target}: {guidance}")
        })
        .collect()
}

fn parse_stream(stream: &str, diagnostics: &mut Vec<Diagnostic>) {
    for raw_line in stream.lines() {
        let raw = raw_line.trim_end_matches('\r');
        let text = strip_ansi(raw);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }

        if let Some(diagnostic) = parse_typescript(text, raw) {
            diagnostics.push(diagnostic);
            continue;
        }
        if let Some(diagnostic) = parse_eslint(text, raw) {
            diagnostics.push(diagnostic);
            continue;
        }
        if let Some(diagnostic) = parse_test_failure(text, raw) {
            diagnostics.push(diagnostic);
            continue;
        }
        for parser in [
            python::parse_line,
            go::parse_line,
            rust::parse_line,
            java::parse_line,
        ] {
            if let Some(diagnostic) = parser(text, raw) {
                diagnostics.push(diagnostic);
                break;
            }
        }
    }
}

fn parse_typescript(text: &str, raw: &str) -> Option<Diagnostic> {
    static PAREN_FORMAT: OnceLock<Regex> = OnceLock::new();
    static COLON_FORMAT: OnceLock<Regex> = OnceLock::new();
    static PAREN_WITHOUT_COLUMN: OnceLock<Regex> = OnceLock::new();

    let paren_format = PAREN_FORMAT.get_or_init(|| {
        Regex::new(
            r"^(?P<file>.+?)\((?P<line>\d+),(?P<column>\d+)\):\s*(?P<severity>error|warning)\s+(?P<code>TS\d+):\s*(?P<message>.+)$",
        )
        .expect("valid TypeScript parenthesized diagnostic regex")
    });
    let colon_format = COLON_FORMAT.get_or_init(|| {
        Regex::new(
            r"^(?P<file>.+?):(?P<line>\d+):(?P<column>\d+)\s+-\s+(?P<severity>error|warning)\s+(?P<code>TS\d+):\s*(?P<message>.+)$",
        )
        .expect("valid TypeScript colon diagnostic regex")
    });
    let paren_without_column = PAREN_WITHOUT_COLUMN.get_or_init(|| {
        Regex::new(
            r"^(?P<file>.+?)\((?P<line>\d+)\):\s*(?P<severity>error|warning)\s+(?P<code>TS\d+):\s*(?P<message>.+)$",
        )
        .expect("valid TypeScript line-only diagnostic regex")
    });

    if let Some(captures) = paren_format.captures(text) {
        return diagnostic_from_captures(&captures, raw, true);
    }
    if let Some(captures) = colon_format.captures(text) {
        return diagnostic_from_captures(&captures, raw, true);
    }
    paren_without_column
        .captures(text)
        .and_then(|captures| diagnostic_from_captures(&captures, raw, false))
}

fn parse_eslint(text: &str, raw: &str) -> Option<Diagnostic> {
    static ESLINT: OnceLock<Regex> = OnceLock::new();
    let eslint = ESLINT.get_or_init(|| {
        Regex::new(
            r"^(?P<file>.+?):(?P<line>\d+):(?P<column>\d+)\s+(?P<severity>error|warning)\s+(?P<message>.+?)(?:\s{2,}(?P<code>[@\w./-]+))?$",
        )
        .expect("valid ESLint diagnostic regex")
    });
    let captures = eslint.captures(text)?;
    let file = captures.name("file")?.as_str().trim();
    let line = parse_u32(captures.name("line")?.as_str())?;
    let column = parse_u32(captures.name("column")?.as_str())?;
    let severity = parse_severity(captures.name("severity")?.as_str());
    let message = captures.name("message")?.as_str().trim();
    let (message, code) = captures
        .name("code")
        .map(|code| (message.to_string(), Some(code.as_str().to_string())))
        .unwrap_or_else(|| split_eslint_rule_suffix(message));

    Some(Diagnostic {
        severity,
        message,
        code,
        file: Some(PathBuf::from(file)),
        line: Some(line),
        column: Some(column),
        confidence: STRUCTURED_CONFIDENCE,
        raw: Some(raw.to_string()),
    })
}

/// Compact/custom ESLint formatters may separate the rule with one space
/// instead of the stylish formatter's aligned columns. Only peel off a final
/// token that has a conventional rule-id shape, so ordinary messages keep
/// their final word.
fn split_eslint_rule_suffix(message: &str) -> (String, Option<String>) {
    let Some((head, suffix)) = message.rsplit_once(char::is_whitespace) else {
        return (message.to_string(), None);
    };
    let suffix = suffix.trim();
    let looks_like_rule = suffix.starts_with('@') || suffix.contains(['/', '-', '.', '_']);
    if suffix.is_empty() || !looks_like_rule {
        return (message.to_string(), None);
    }

    (head.trim_end().to_string(), Some(suffix.to_string()))
}

fn parse_test_failure(text: &str, raw: &str) -> Option<Diagnostic> {
    static TEST_FAILURE: OnceLock<Regex> = OnceLock::new();
    let test_failure = TEST_FAILURE.get_or_init(|| {
        Regex::new(r"^FAIL\s+(?P<body>.+?)\s*$").expect("valid Jest/Vitest failure header regex")
    });
    let captures = test_failure.captures(text)?;
    let body = captures.name("body")?.as_str().trim();
    // Go's `FAIL	pkg	0.123s` summary also starts with FAIL; leave it for the
    // Go parser instead of misclassifying it as a Jest/Vitest failure header.
    if body.contains('\t') {
        return None;
    }
    let (file, message) = match body.split_once(" > ") {
        Some((file, test_name)) => (file.trim(), format!("Test failed: {}", test_name.trim())),
        None => (body, format!("Test suite failed: {body}")),
    };
    if file.is_empty() {
        return None;
    }

    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message,
        code: Some("TEST_FAILURE".into()),
        file: Some(PathBuf::from(file)),
        line: None,
        column: None,
        confidence: TEST_HEADER_CONFIDENCE,
        raw: Some(raw.to_string()),
    })
}

fn diagnostic_from_captures(
    captures: &regex::Captures<'_>,
    raw: &str,
    has_column: bool,
) -> Option<Diagnostic> {
    let file = captures.name("file")?.as_str().trim();
    let line = parse_u32(captures.name("line")?.as_str())?;
    let column = if has_column {
        Some(parse_u32(captures.name("column")?.as_str())?)
    } else {
        None
    };
    let severity = parse_severity(captures.name("severity")?.as_str());
    let code = captures.name("code")?.as_str().to_string();
    let message = captures.name("message")?.as_str().trim();

    Some(Diagnostic {
        severity,
        message: message.to_string(),
        code: Some(code),
        file: Some(PathBuf::from(file)),
        line: Some(line),
        column,
        confidence: STRUCTURED_CONFIDENCE,
        raw: Some(raw.to_string()),
    })
}

fn fallback_diagnostic(outcome: &CommandOutcome) -> Option<Diagnostic> {
    let raw = [outcome.stdout.as_str(), outcome.stderr.as_str()]
        .into_iter()
        .filter(|stream| !stream.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if raw.trim().is_empty() {
        return None;
    }

    let message = if outcome.timed_out {
        "Verification command timed out without a recognized diagnostic."
    } else if outcome.cancelled {
        "Verification command was cancelled without a recognized diagnostic."
    } else {
        "Verification command failed without a recognized diagnostic."
    };

    Some(Diagnostic {
        severity: DiagnosticSeverity::Error,
        message: message.into(),
        code: None,
        file: None,
        line: None,
        column: None,
        confidence: FALLBACK_CONFIDENCE,
        raw: Some(raw),
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

fn strip_ansi(text: &str) -> Cow<'_, str> {
    static ANSI_ESCAPE: OnceLock<Regex> = OnceLock::new();
    let ansi_escape = ANSI_ESCAPE
        .get_or_init(|| Regex::new(r"\x1b\[[0-9;]*[A-Za-z]").expect("valid ANSI escape regex"));
    if text.contains('\x1b') {
        Cow::Owned(ansi_escape.replace_all(text, "").into_owned())
    } else {
        Cow::Borrowed(text)
    }
}
