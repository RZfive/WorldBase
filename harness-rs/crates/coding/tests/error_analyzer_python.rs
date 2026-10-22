use worldbase_coding::{
    error_analyzer::normalize_outcome, CommandOutcome, Diagnostic, DiagnosticSeverity,
    VerificationCheckKind, VerificationCommand,
};

fn outcome(stdout: &str, exit_code: i32) -> CommandOutcome {
    CommandOutcome {
        command: VerificationCommand {
            kind: VerificationCheckKind::Test,
            program: "python".into(),
            args: vec!["-m".into(), "pytest".into()],
            required: true,
            description: "python fixture".into(),
        },
        exit_code: Some(exit_code),
        stdout: stdout.into(),
        stderr: String::new(),
        timed_out: false,
        cancelled: false,
        duration_ms: 10,
    }
}

fn diagnostics(stdout: &str) -> Vec<Diagnostic> {
    normalize_outcome(&outcome(stdout, 1))
}

#[test]
fn parses_ruff_and_flake8_lines() {
    let ruff = diagnostics("src/app.py:12:5: E501 line too long (100 > 88)\n");
    assert_eq!(ruff.len(), 1);
    assert_eq!(ruff[0].severity, DiagnosticSeverity::Error);
    assert_eq!(ruff[0].code.as_deref(), Some("E501"));
    assert_eq!(
        ruff[0].file.as_deref().unwrap().to_string_lossy(),
        "src/app.py"
    );
    assert_eq!(ruff[0].line, Some(12));
    assert_eq!(ruff[0].column, Some(5));
    assert_eq!(ruff[0].message, "line too long (100 > 88)");
    assert_eq!(ruff[0].confidence, 0.9);
    assert_eq!(
        ruff[0].raw.as_deref(),
        Some("src/app.py:12:5: E501 line too long (100 > 88)")
    );

    let flake8 = diagnostics("src/app.py:3:1: F401 'os' imported but unused\n");
    assert_eq!(flake8.len(), 1);
    assert_eq!(flake8[0].code.as_deref(), Some("F401"));
    assert_eq!(flake8[0].message, "'os' imported but unused");

    let warning = diagnostics("src/app.py:1:1: W291 trailing whitespace\n");
    assert_eq!(warning[0].severity, DiagnosticSeverity::Warning);
}

#[test]
fn parses_mypy_errors_warnings_notes_and_codes() {
    let parsed = diagnostics(
        "\
src/app.py:10: error: Incompatible types in assignment  [assignment]
src/app.py:11: warning: Unused ignore  [unused-ignore]
src/app.py:12:3: note: See https://mypy.rtfd.io  [misc]
",
    );
    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0].severity, DiagnosticSeverity::Error);
    assert_eq!(parsed[0].code.as_deref(), Some("assignment"));
    assert_eq!(parsed[0].message, "Incompatible types in assignment");
    assert_eq!(parsed[0].line, Some(10));
    assert_eq!(parsed[0].column, None);
    assert_eq!(parsed[0].confidence, 0.9);
    assert_eq!(parsed[1].severity, DiagnosticSeverity::Warning);
    assert_eq!(parsed[1].code.as_deref(), Some("unused-ignore"));
    assert_eq!(parsed[2].severity, DiagnosticSeverity::Info);
    assert_eq!(parsed[2].column, Some(3));
    assert_eq!(parsed[2].code.as_deref(), Some("misc"));
}

#[test]
fn parses_traceback_file_lines_and_syntax_errors() {
    let traceback = diagnostics("  File \"src/app.py\", line 42, in run\n");
    assert_eq!(traceback.len(), 1);
    assert_eq!(traceback[0].severity, DiagnosticSeverity::Error);
    assert_eq!(traceback[0].code.as_deref(), Some("PYTHON"));
    assert_eq!(
        traceback[0].file.as_deref().unwrap().to_string_lossy(),
        "src/app.py"
    );
    assert_eq!(traceback[0].line, Some(42));
    assert!(traceback[0].message.contains("run"));
    assert_eq!(traceback[0].confidence, 0.6);

    let syntax =
        diagnostics("SyntaxError: invalid syntax\nIndentationError: expected an indented block\n");
    assert_eq!(syntax.len(), 2);
    assert_eq!(syntax[0].code.as_deref(), Some("PYTHON"));
    assert_eq!(syntax[0].message, "invalid syntax");
    assert_eq!(syntax[0].confidence, 0.9);
    assert_eq!(syntax[1].message, "expected an indented block");
}

#[test]
fn parses_pytest_failure_headers_and_short_summary() {
    let failure =
        diagnostics("FAILED tests/test_app.py::test_add - AssertionError: assert 1 == 2\n");
    assert_eq!(failure.len(), 1);
    assert_eq!(failure[0].severity, DiagnosticSeverity::Error);
    assert_eq!(failure[0].code.as_deref(), Some("PYTEST"));
    assert_eq!(
        failure[0].file.as_deref().unwrap().to_string_lossy(),
        "tests/test_app.py"
    );
    assert_eq!(failure[0].message, "AssertionError: assert 1 == 2");
    assert_eq!(failure[0].confidence, 0.6);

    let short = diagnostics("E   AssertionError: assert 1 == 2\n");
    assert_eq!(short.len(), 1);
    assert_eq!(short[0].code.as_deref(), Some("PYTEST"));
    assert_eq!(short[0].message, "AssertionError: assert 1 == 2");
    assert!(short[0].file.is_none());
}

#[test]
fn parses_module_not_found_errors() {
    let parsed = diagnostics("ModuleNotFoundError: No module named 'requests'\n");
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].severity, DiagnosticSeverity::Error);
    assert_eq!(parsed[0].code.as_deref(), Some("PYTHON"));
    assert_eq!(parsed[0].message, "No module named 'requests'");
    assert_eq!(parsed[0].confidence, 0.9);
}

#[test]
fn ignores_malformed_lines_and_preserves_diagnostic_order() {
    let malformed = normalize_outcome(&outcome("not a python diagnostic\n", 0));
    assert!(malformed.is_empty());

    let parsed = diagnostics(
        "\
src/app.py:1:1: E501 first
src/app.py:2: error: second  [assignment]
FAILED tests/test_app.py::test_third - AssertionError: third
",
    );
    assert_eq!(parsed.len(), 3);
    assert_eq!(
        parsed
            .iter()
            .map(|diagnostic| diagnostic.code.as_deref().unwrap_or(""))
            .collect::<Vec<_>>(),
        vec!["E501", "assignment", "PYTEST"]
    );
    assert_eq!(
        parsed
            .iter()
            .map(|diagnostic| diagnostic.message.as_str())
            .collect::<Vec<_>>(),
        vec!["first", "second", "AssertionError: third"]
    );
}
