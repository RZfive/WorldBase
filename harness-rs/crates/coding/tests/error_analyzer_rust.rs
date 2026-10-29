use std::path::PathBuf;
use worldbase_coding::{
    error_analyzer::normalize_outcome, CommandOutcome, DiagnosticSeverity, VerificationCheckKind,
    VerificationCommand,
};

fn outcome(stdout: &str, stderr: &str, exit_code: i32) -> CommandOutcome {
    CommandOutcome {
        command: VerificationCommand {
            kind: VerificationCheckKind::Test,
            program: "cargo".into(),
            args: vec!["test".into()],
            required: true,
            description: "fixture".into(),
        },
        exit_code: Some(exit_code),
        stdout: stdout.into(),
        stderr: stderr.into(),
        timed_out: false,
        cancelled: false,
        duration_ms: 10,
    }
}

#[test]
fn pairs_error_header_with_following_location() {
    let stderr = "\
error[E0308]: mismatched types
  --> src/main.rs:10:5
   |
10 |     let x: u32 = \"text\";
   |                  ^^^^^^ expected `u32`, found `&str`";

    let diagnostics = normalize_outcome(&outcome("", stderr, 1));
    assert_eq!(diagnostics.len(), 1, "{diagnostics:#?}");

    let diagnostic = &diagnostics[0];
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Error);
    assert_eq!(diagnostic.code.as_deref(), Some("E0308"));
    assert_eq!(diagnostic.message, "mismatched types");
    assert_eq!(
        diagnostic.file.as_deref(),
        Some(PathBuf::from("src/main.rs").as_path())
    );
    assert_eq!(diagnostic.line, Some(10));
    assert_eq!(diagnostic.column, Some(5));
    assert_eq!(diagnostic.confidence, 0.95);
    assert_eq!(
        diagnostic.raw.as_deref(),
        Some("error[E0308]: mismatched types")
    );
}

#[test]
fn parses_warning_header_with_location() {
    let stderr = "\
warning: unused variable: x
  --> src/lib.rs:3:9
  |
3 |     let x = 1;
  |         ^ help: if this is intentional, prefix it with an underscore";

    let diagnostics = normalize_outcome(&outcome("", stderr, 0));
    assert_eq!(diagnostics.len(), 1, "{diagnostics:#?}");

    let diagnostic = &diagnostics[0];
    assert_eq!(diagnostic.severity, DiagnosticSeverity::Warning);
    assert_eq!(diagnostic.code.as_deref(), Some("RUSTC"));
    assert_eq!(diagnostic.message, "unused variable: x");
    assert_eq!(
        diagnostic.file.as_deref(),
        Some(PathBuf::from("src/lib.rs").as_path())
    );
    assert_eq!(diagnostic.line, Some(3));
    assert_eq!(diagnostic.column, Some(9));
    assert_eq!(diagnostic.confidence, 0.95);
    assert_eq!(
        diagnostic.raw.as_deref(),
        Some("warning: unused variable: x")
    );
}

#[test]
fn parses_rustc_short_form_and_compile_summary() {
    let stderr = "\
src/main.rs:10:5: error[E0308]: mismatched types
error: could not compile `demo` due to 1 previous error";

    let diagnostics = normalize_outcome(&outcome("", stderr, 1));
    assert_eq!(diagnostics.len(), 2, "{diagnostics:#?}");

    let short = &diagnostics[0];
    assert_eq!(short.severity, DiagnosticSeverity::Error);
    assert_eq!(short.code.as_deref(), Some("E0308"));
    assert_eq!(short.message, "mismatched types");
    assert_eq!(
        short.file.as_deref(),
        Some(PathBuf::from("src/main.rs").as_path())
    );
    assert_eq!(short.line, Some(10));
    assert_eq!(short.column, Some(5));
    assert_eq!(short.confidence, 0.95);

    let summary = &diagnostics[1];
    assert_eq!(summary.severity, DiagnosticSeverity::Error);
    assert_eq!(summary.code.as_deref(), Some("RUSTC"));
    assert_eq!(
        summary.message,
        "could not compile `demo` due to 1 previous error"
    );
    assert_eq!(summary.confidence, 0.95);
}

#[test]
fn parses_cargo_test_failures_and_panics_with_lower_confidence() {
    let stdout = "\
running 2 tests
test tests::pass ... ok
test tests::foo ... FAILED";

    let stderr = "\
thread 'tests::foo' panicked at src/lib.rs:10:5:
assertion `left == right` failed";
    let diagnostics = normalize_outcome(&outcome(stdout, stderr, 1));
    assert_eq!(diagnostics.len(), 2, "{diagnostics:#?}");

    let failure = &diagnostics[0];
    assert_eq!(failure.severity, DiagnosticSeverity::Error);
    assert_eq!(failure.code.as_deref(), Some("TEST"));
    assert_eq!(failure.message, "Test failed: tests::foo");
    assert_eq!(failure.file, None);
    assert_eq!(failure.line, None);
    assert_eq!(failure.confidence, 0.7);
    assert_eq!(failure.raw.as_deref(), Some("test tests::foo ... FAILED"));

    let panic = &diagnostics[1];
    assert_eq!(panic.severity, DiagnosticSeverity::Error);
    assert_eq!(panic.code.as_deref(), Some("TEST"));
    assert_eq!(panic.message, "thread 'tests::foo' panicked");
    assert_eq!(
        panic.file.as_deref(),
        Some(PathBuf::from("src/lib.rs").as_path())
    );
    assert_eq!(panic.line, Some(10));
    assert_eq!(panic.column, Some(5));
    assert_eq!(panic.confidence, 0.7);
    assert_eq!(
        panic.raw.as_deref(),
        Some("thread 'tests::foo' panicked at src/lib.rs:10:5:")
    );
}

#[test]
fn preserves_output_order_across_mixed_rust_diagnostics() {
    let stderr = "\
src/short.rs:1:2: warning: short form
error[E0308]: mismatched types
  --> src/main.rs:10:5
warning: unused variable: `x`
  --> src/lib.rs:3:9
test tests::foo ... FAILED
thread 'main' panicked at src/main.rs:4:7:
error: could not compile `demo` due to 1 previous error";

    let diagnostics = normalize_outcome(&outcome("", stderr, 1));
    assert_eq!(
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.code.as_deref())
            .collect::<Vec<_>>(),
        vec![
            Some("RUSTC"),
            Some("E0308"),
            Some("RUSTC"),
            Some("TEST"),
            Some("TEST"),
            Some("RUSTC"),
        ]
    );
    assert_eq!(
        diagnostics
            .iter()
            .map(|diagnostic| diagnostic.message.as_str())
            .collect::<Vec<_>>(),
        vec![
            "short form",
            "mismatched types",
            "unused variable: `x`",
            "Test failed: tests::foo",
            "thread 'main' panicked",
            "could not compile `demo` due to 1 previous error",
        ]
    );
}

#[test]
fn ignores_malformed_lines_and_non_diagnostics() {
    let stderr = "\
     |
note: expected one of `;` or `,`
help: consider adding a semicolon
not a diagnostic
thread 'main' panicked at not-a-location";

    let diagnostics = normalize_outcome(&outcome("", stderr, 0));
    assert!(diagnostics.is_empty(), "{diagnostics:#?}");
}
