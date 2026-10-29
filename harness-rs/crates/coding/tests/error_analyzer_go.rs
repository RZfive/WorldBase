use worldbase_coding::{
    error_analyzer::normalize_outcome, CommandOutcome, Diagnostic, DiagnosticSeverity,
    VerificationCheckKind, VerificationCommand,
};

fn outcome(stdout: &str, exit_code: i32) -> CommandOutcome {
    CommandOutcome {
        command: VerificationCommand {
            kind: VerificationCheckKind::Test,
            program: "go".into(),
            args: vec!["test".into(), "./...".into()],
            required: true,
            description: "Go fixture".into(),
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

fn code(diagnostic: &Diagnostic) -> &str {
    diagnostic.code.as_deref().unwrap_or("")
}

#[test]
fn parses_go_file_positions_with_and_without_columns() {
    let parsed = diagnostics(
        "main.go:12:4: undefined: missing\n./pkg/file.go:10: cannot use x (type int) as type string\n",
    );

    assert_eq!(parsed.len(), 2);
    let positional = &parsed[0];
    assert_eq!(positional.severity, DiagnosticSeverity::Error);
    assert_eq!(code(positional), "GO");
    assert_eq!(
        positional.file.as_deref(),
        Some(std::path::Path::new("main.go"))
    );
    assert_eq!(positional.line, Some(12));
    assert_eq!(positional.column, Some(4));
    assert_eq!(positional.message, "undefined: missing");
    assert!(positional.confidence >= 0.9);

    let line_only = &parsed[1];
    assert_eq!(code(line_only), "GO");
    assert_eq!(
        line_only.file.as_deref(),
        Some(std::path::Path::new("./pkg/file.go"))
    );
    assert_eq!(line_only.line, Some(10));
    assert_eq!(line_only.column, None);
    assert_eq!(line_only.message, "cannot use x (type int) as type string");
}

#[test]
fn parses_vet_prefixed_file_diagnostics() {
    let parsed = diagnostics("vet: pkg/file.go:3:1: unreachable code\n");

    assert_eq!(parsed.len(), 1);
    assert_eq!(code(&parsed[0]), "GOVET");
    assert_eq!(
        parsed[0].file.as_deref(),
        Some(std::path::Path::new("pkg/file.go"))
    );
    assert_eq!(parsed[0].line, Some(3));
    assert_eq!(parsed[0].column, Some(1));
    assert_eq!(parsed[0].message, "unreachable code");
    assert!(parsed[0].confidence >= 0.9);
}

#[test]
fn parses_go_test_failure_headers() {
    let parsed = diagnostics("--- FAIL: TestAdd (0.00s)\n--- FAIL: TestDiv/subcase (0.12s)\n");

    assert_eq!(parsed.len(), 2);
    assert_eq!(code(&parsed[0]), "GOTEST");
    assert_eq!(parsed[0].message, "Test failed: TestAdd");
    assert_eq!(parsed[0].file, None);
    assert!(parsed[0].confidence <= 0.6);
    assert_eq!(code(&parsed[1]), "GOTEST");
    assert_eq!(parsed[1].message, "Test failed: TestDiv/subcase");
}

#[test]
fn parses_go_package_failure_header() {
    let parsed = diagnostics("FAIL\texample.com/pkg\t0.123s\n");

    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].severity, DiagnosticSeverity::Error);
    assert!(
        parsed[0].message.contains("example.com/pkg")
            || parsed[0]
                .raw
                .as_deref()
                .unwrap_or("")
                .contains("example.com/pkg")
    );
}

#[test]
fn parses_bare_compiler_messages_and_go_tool_errors() {
    let parsed = diagnostics(
        "undefined: missing\ncannot use x (type int) as type string\ngo: cannot find main module; see 'go help modules'\n",
    );

    assert_eq!(parsed.len(), 3);
    assert_eq!(code(&parsed[0]), "GO");
    assert_eq!(parsed[0].message, "undefined: missing");
    assert_eq!(code(&parsed[1]), "GO");
    assert!(parsed[1].message.starts_with("cannot use"));
    assert_eq!(code(&parsed[2]), "GO");
    assert_eq!(
        parsed[2].message,
        "cannot find main module; see 'go help modules'"
    );
    assert_eq!(parsed[2].file, None);
}

#[test]
fn ignores_malformed_and_successful_go_output() {
    let parsed = normalize_outcome(&outcome(
        "ok  \texample.com/pkg\t0.101s\n=== RUN   TestAdd\nPASS\nrandom output\n",
        0,
    ));
    assert!(parsed.is_empty());
}

#[test]
fn preserves_multiple_line_order_and_codes() {
    let parsed = diagnostics(
        "main.go:4:2: undefined: missing\nvet: main.go:8:1: unreachable code\n--- FAIL: TestAdd (0.01s)\ngo: updates to go.mod needed\n",
    );

    assert_eq!(parsed.len(), 4);
    assert_eq!(
        parsed.iter().map(code).collect::<Vec<_>>(),
        vec!["GO", "GOVET", "GOTEST", "GO"]
    );
    assert_eq!(
        parsed[0].file.as_deref(),
        Some(std::path::Path::new("main.go"))
    );
    assert_eq!(parsed[2].message, "Test failed: TestAdd");
}
