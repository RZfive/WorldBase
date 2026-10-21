use std::path::PathBuf;
use worldbase_coding::{
    analyze_diagnostics, analyze_outcomes,
    error_analyzer::{normalize_outcome, patterns::patterns},
    CommandOutcome, Diagnostic, DiagnosticSeverity, ErrorCategory, VerificationCheckKind,
    VerificationCommand,
};

fn outcome(stdout: &str, stderr: &str, exit_code: i32) -> CommandOutcome {
    CommandOutcome {
        command: VerificationCommand {
            kind: VerificationCheckKind::Test,
            program: "npm".into(),
            args: vec!["run".into(), "test".into()],
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
fn parses_typescript_and_eslint_diagnostics_with_structured_fields() {
    let stdout = "\
src/components/App.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.\n\
src/components/App.ts(19,3): warning TS6133: 'unused' is declared but its value is never read.";
    let stderr = "\
src/app.ts:4:11  error  Unexpected console statement  no-console\n\
src/lib.ts:8:2 warning Missing return type @typescript-eslint/explicit-function-return-type";

    let diagnostics = normalize_outcome(&outcome(stdout, stderr, 1));
    assert_eq!(diagnostics.len(), 4);

    let typescript_error = &diagnostics[0];
    assert_eq!(typescript_error.severity, DiagnosticSeverity::Error);
    assert_eq!(typescript_error.code.as_deref(), Some("TS2322"));
    assert_eq!(
        typescript_error.file.as_deref().unwrap().to_string_lossy(),
        "src/components/App.ts"
    );
    assert_eq!(typescript_error.line, Some(12));
    assert_eq!(typescript_error.column, Some(7));
    assert_eq!(
        typescript_error.message,
        "Type 'string' is not assignable to type 'number'."
    );
    assert_eq!(
        typescript_error.raw.as_deref(),
        Some("src/components/App.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.")
    );
    assert!(typescript_error.confidence <= 0.95);

    let typescript_warning = &diagnostics[1];
    assert_eq!(typescript_warning.severity, DiagnosticSeverity::Warning);
    assert_eq!(typescript_warning.code.as_deref(), Some("TS6133"));

    let eslint_error = &diagnostics[2];
    assert_eq!(eslint_error.severity, DiagnosticSeverity::Error);
    assert_eq!(eslint_error.code.as_deref(), Some("no-console"));
    assert_eq!(eslint_error.line, Some(4));
    assert_eq!(eslint_error.column, Some(11));
    assert_eq!(eslint_error.message, "Unexpected console statement");

    let eslint_warning = &diagnostics[3];
    assert_eq!(eslint_warning.severity, DiagnosticSeverity::Warning);
    assert_eq!(
        eslint_warning.code.as_deref(),
        Some("@typescript-eslint/explicit-function-return-type")
    );
    assert_eq!(eslint_warning.line, Some(8));
    assert_eq!(eslint_warning.column, Some(2));
}

#[test]
fn parses_jest_and_vitest_failure_headers() {
    let stdout = "\
PASS src/passing.test.ts\n\
FAIL src/user.test.ts\n\
  ● user service › returns a user\n\
 FAIL  tests/math.test.ts > math > adds numbers\n\
AssertionError: expected 3 to be 4";

    let diagnostics = normalize_outcome(&outcome(stdout, "", 1));
    assert_eq!(diagnostics.len(), 2);

    let jest = &diagnostics[0];
    assert_eq!(jest.severity, DiagnosticSeverity::Error);
    assert_eq!(jest.code.as_deref(), Some("TEST_FAILURE"));
    assert_eq!(
        jest.file.as_deref().unwrap().to_string_lossy(),
        "src/user.test.ts"
    );
    assert_eq!(jest.message, "Test suite failed: src/user.test.ts");
    assert_eq!(jest.raw.as_deref(), Some("FAIL src/user.test.ts"));
    assert!(jest.confidence <= 0.8);

    let vitest = &diagnostics[1];
    assert_eq!(
        vitest.file.as_deref().unwrap().to_string_lossy(),
        "tests/math.test.ts"
    );
    assert_eq!(vitest.message, "Test failed: math > adds numbers");
    assert_eq!(
        vitest.raw.as_deref(),
        Some("FAIL  tests/math.test.ts > math > adds numbers")
    );
}

#[test]
fn strips_ansi_for_parsing_but_preserves_raw_evidence() {
    let stdout = "\u{1b}[31mFAIL\u{1b}[39m src/colored.test.ts > colored output";
    let diagnostics = normalize_outcome(&outcome(stdout, "", 1));

    assert_eq!(diagnostics.len(), 1);
    assert_eq!(
        diagnostics[0].file.as_deref().unwrap().to_string_lossy(),
        "src/colored.test.ts"
    );
    assert_eq!(diagnostics[0].raw.as_deref(), Some(stdout));
}

#[test]
fn preserves_unrecognized_failure_output_with_low_confidence() {
    let stderr = "npm ERR! command failed\nnpm ERR! lifecycle script exited 1";
    let diagnostics = normalize_outcome(&outcome("", stderr, 1));

    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].severity, DiagnosticSeverity::Error);
    assert_eq!(diagnostics[0].file, None);
    assert_eq!(diagnostics[0].line, None);
    assert_eq!(diagnostics[0].code, None);
    assert_eq!(diagnostics[0].raw.as_deref(), Some(stderr));
    assert!(diagnostics[0].confidence <= 0.1);
}

#[test]
fn successful_unrecognized_output_does_not_create_a_failure_diagnostic() {
    assert!(normalize_outcome(&outcome("All checks passed", "", 0)).is_empty());
}

fn diagnostic(
    message: &str,
    code: Option<&str>,
    file: Option<&str>,
    line: Option<u32>,
    severity: DiagnosticSeverity,
) -> Diagnostic {
    Diagnostic {
        severity,
        message: message.into(),
        code: code.map(str::to_string),
        file: file.map(PathBuf::from),
        line,
        column: None,
        confidence: 0.95,
        raw: None,
    }
}

fn analyze_single(code: &str, message: &str) -> worldbase_coding::DiagnosisReport {
    analyze_diagnostics(&[diagnostic(
        message,
        Some(code),
        Some("src/file.ts"),
        Some(1),
        DiagnosticSeverity::Error,
    )])
}

#[test]
fn pattern_library_covers_all_categories_with_unique_priority_order() {
    let patterns = patterns();
    assert!(patterns.len() >= 20);

    let ids = patterns
        .iter()
        .map(|pattern| pattern.id)
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(ids.len(), patterns.len());
    assert!(patterns
        .windows(2)
        .all(|window| window[0].priority <= window[1].priority));

    let categories = patterns
        .iter()
        .map(|pattern| pattern.category)
        .collect::<std::collections::HashSet<_>>();
    for category in [
        ErrorCategory::Syntax,
        ErrorCategory::Type,
        ErrorCategory::Import,
        ErrorCategory::Lint,
        ErrorCategory::Test,
        ErrorCategory::Build,
        ErrorCategory::Runtime,
        ErrorCategory::Dependency,
        ErrorCategory::Unknown,
    ] {
        assert!(categories.contains(&category), "missing {category:?}");
    }
}

#[test]
fn matches_every_typescript_pattern() {
    let cases = [
        (
            "TS2304",
            "Cannot find name 'missing'.",
            "ts-2304",
            ErrorCategory::Type,
        ),
        (
            "TS2339",
            "Property 'name' does not exist on type 'User'.",
            "ts-2339",
            ErrorCategory::Type,
        ),
        (
            "TS2345",
            "Argument of type 'string' is not assignable to parameter of type 'number'.",
            "ts-2345",
            ErrorCategory::Type,
        ),
        (
            "TS2322",
            "Type 'string' is not assignable to type 'number'.",
            "ts-2322",
            ErrorCategory::Type,
        ),
        (
            "TS2307",
            "Cannot find module './missing' or its corresponding type declarations.",
            "ts-2307",
            ErrorCategory::Import,
        ),
        (
            "TS7006",
            "Parameter 'value' implicitly has an 'any' type.",
            "ts-7006",
            ErrorCategory::Type,
        ),
        (
            "TS2554",
            "Expected 2 arguments, but got 1.",
            "ts-2554",
            ErrorCategory::Type,
        ),
        (
            "TS2741",
            "Property 'id' is missing in type '{}' but required in type 'User'.",
            "ts-2741",
            ErrorCategory::Type,
        ),
        ("TS1005", "';' expected.", "ts-1005", ErrorCategory::Syntax),
        (
            "TS1109",
            "Expression expected.",
            "ts-1109",
            ErrorCategory::Syntax,
        ),
    ];

    for (code, message, expected_id, expected_category) in cases {
        let report = analyze_single(code, message);
        assert_eq!(report.matches.len(), 1, "{code}");
        assert_eq!(report.matches[0].pattern_id, expected_id, "{code}");
        assert_eq!(report.matches[0].category, expected_category, "{code}");
    }
}

#[test]
fn matches_every_eslint_rule_and_applies_warning_overrides() {
    let cases = [
        (
            "no-unused-vars",
            "'value' is defined but never used.",
            "eslint-no-unused-vars",
            ErrorCategory::Lint,
        ),
        (
            "no-undef",
            "'value' is not defined.",
            "eslint-no-undef",
            ErrorCategory::Lint,
        ),
        (
            "react-hooks/exhaustive-deps",
            "React Hook useEffect has a missing dependency: 'value'.",
            "eslint-react-hooks-exhaustive-deps",
            ErrorCategory::Lint,
        ),
        (
            "import/no-unresolved",
            "Unable to resolve path to module './missing'.",
            "eslint-import-no-unresolved",
            ErrorCategory::Import,
        ),
        (
            "@typescript-eslint/no-explicit-any",
            "Unexpected any. Specify a different type.",
            "eslint-typescript-no-explicit-any",
            ErrorCategory::Lint,
        ),
        (
            "no-empty",
            "Empty block statement.",
            "eslint-no-empty",
            ErrorCategory::Lint,
        ),
        (
            "no-console",
            "Unexpected console statement.",
            "eslint-no-console",
            ErrorCategory::Lint,
        ),
    ];

    for (code, message, expected_id, expected_category) in cases {
        let report = analyze_single(code, message);
        assert_eq!(report.matches.len(), 1, "{code}");
        assert_eq!(report.matches[0].pattern_id, expected_id, "{code}");
        assert_eq!(report.matches[0].category, expected_category, "{code}");
    }

    let console = analyze_single("no-console", "Unexpected console statement.");
    assert_eq!(console.error_count, 0);
    assert_eq!(console.warning_count, 1);

    let hooks = analyze_single(
        "react-hooks/exhaustive-deps",
        "React Hook useEffect has a missing dependency: 'value'.",
    );
    assert_eq!(hooks.error_count, 0);
    assert_eq!(hooks.warning_count, 1);
}

#[test]
fn matches_test_build_runtime_dependency_and_unknown_patterns() {
    let cases = [
        (
            None,
            "AssertionError: expected 3 to be 4",
            "test-assertion-failure",
            ErrorCategory::Test,
        ),
        (
            None,
            "Exceeded timeout of 5000 ms for a test.",
            "test-timeout",
            ErrorCategory::Test,
        ),
        (
            None,
            "Cannot find module './user' from 'src/user.test.ts'",
            "test-module-not-found",
            ErrorCategory::Import,
        ),
        (
            Some("TEST_FAILURE"),
            "Test suite failed: src/user.test.ts",
            "test-suite-failed",
            ErrorCategory::Test,
        ),
        (
            None,
            "ERR_MODULE_NOT_FOUND: Cannot find package 'left-pad'",
            "dependency-err-module-not-found",
            ErrorCategory::Dependency,
        ),
        (
            None,
            "Failed to resolve import './missing' from 'src/main.ts'. Does the file exist?",
            "build-failed-to-resolve-import",
            ErrorCategory::Build,
        ),
        (
            None,
            "Cannot find module './missing'",
            "build-cannot-find-module",
            ErrorCategory::Build,
        ),
        (
            None,
            "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
            "build-out-of-memory",
            ErrorCategory::Build,
        ),
        (
            None,
            "Verification command timed out without a recognized diagnostic.",
            "runtime-command-timed-out",
            ErrorCategory::Runtime,
        ),
        (
            None,
            "Verification command was cancelled without a recognized diagnostic.",
            "runtime-command-cancelled",
            ErrorCategory::Runtime,
        ),
        (
            None,
            "Verification command failed without a recognized diagnostic.",
            "generic-non-zero-exit",
            ErrorCategory::Unknown,
        ),
    ];

    for (code, message, expected_id, expected_category) in cases {
        let report = analyze_diagnostics(&[diagnostic(
            message,
            code,
            Some("src/file.ts"),
            Some(1),
            DiagnosticSeverity::Error,
        )]);
        assert_eq!(report.matches.len(), 1, "{message}");
        assert_eq!(report.matches[0].pattern_id, expected_id, "{message}");
        assert_eq!(report.matches[0].category, expected_category, "{message}");
    }
}

#[test]
fn first_match_wins_and_matches_sort_by_severity_count_then_priority() {
    let report = analyze_diagnostics(&[
        diagnostic(
            "Unexpected console statement.",
            Some("no-console"),
            Some("src/b.ts"),
            Some(1),
            DiagnosticSeverity::Warning,
        ),
        diagnostic(
            "Cannot find name 'alpha'.",
            Some("TS2304"),
            Some("src/a.ts"),
            Some(1),
            DiagnosticSeverity::Error,
        ),
        diagnostic(
            "Property 'beta' does not exist on type 'Model'.",
            Some("TS2339"),
            Some("src/a.ts"),
            Some(2),
            DiagnosticSeverity::Error,
        ),
        diagnostic(
            "Property 'gamma' does not exist on type 'Model'.",
            Some("TS2339"),
            Some("src/a.ts"),
            Some(3),
            DiagnosticSeverity::Error,
        ),
    ]);

    assert_eq!(
        report
            .matches
            .iter()
            .map(|pattern_match| pattern_match.pattern_id.as_str())
            .collect::<Vec<_>>(),
        vec!["ts-2339", "ts-2304", "eslint-no-console"]
    );
    assert_eq!(report.matches[0].count, 2);
    assert_eq!(report.primary_category, ErrorCategory::Type);

    let ambiguous = analyze_single(
        "TS2307",
        "Cannot find module './missing' or its corresponding type declarations.",
    );
    assert_eq!(ambiguous.matches[0].pattern_id, "ts-2307");
}

#[test]
fn deduplicates_identical_diagnostics_and_keeps_distinct_locations() {
    let first = diagnostic(
        "Type 'string' is not assignable to type 'number'.",
        Some("TS2322"),
        Some("src/a.ts"),
        Some(3),
        DiagnosticSeverity::Error,
    );
    let mut same_again = first.clone();
    same_again.confidence = 0.1;
    same_again.raw = Some("different raw evidence".into());
    let mut different_line = first.clone();
    different_line.line = Some(4);

    let report = analyze_diagnostics(&[first.clone(), same_again, different_line]);
    assert_eq!(report.error_count, 2);
    assert_eq!(report.matches.len(), 1);
    assert_eq!(report.matches[0].count, 2);
    assert_eq!(report.matches[0].files, vec![PathBuf::from("src/a.ts")]);

    let duplicated = analyze_diagnostics(&[first.clone(), first.clone()]);
    let single = analyze_diagnostics(&[first]);
    assert_eq!(duplicated.failure_signature, single.failure_signature);
    assert_eq!(duplicated.error_count, 1);
}

#[test]
fn failure_signature_is_stable_across_ordering_and_sensitive_to_content() {
    let name = diagnostic(
        "Cannot find name 'alpha'.",
        Some("TS2304"),
        Some("src/a.ts"),
        Some(2),
        DiagnosticSeverity::Error,
    );
    let property = diagnostic(
        "Property 'beta' does not exist on type 'Model'.",
        Some("TS2339"),
        Some("src/b.ts"),
        Some(5),
        DiagnosticSeverity::Error,
    );

    let forward = analyze_diagnostics(&[name.clone(), property.clone()]);
    let reverse = analyze_diagnostics(&[property, name.clone()]);
    assert_eq!(forward.failure_signature, reverse.failure_signature);
    assert!(forward.failure_signature.starts_with("fnv1a64:"));
    assert_eq!(forward.failure_signature.len(), "fnv1a64:".len() + 16);

    let changed = analyze_diagnostics(&[
        name,
        diagnostic(
            "Property 'gamma' does not exist on type 'Model'.",
            Some("TS2339"),
            Some("src/b.ts"),
            Some(5),
            DiagnosticSeverity::Error,
        ),
    ]);
    assert_ne!(forward.failure_signature, changed.failure_signature);
}

#[test]
fn empty_input_produces_an_empty_stable_report() {
    let report = analyze_diagnostics(&[]);
    assert!(report.matches.is_empty());
    assert_eq!(report.error_count, 0);
    assert_eq!(report.warning_count, 0);
    assert_eq!(report.primary_category, ErrorCategory::Unknown);
    assert!(report.affected_files.is_empty());
    assert!(!report.has_repairable_issues);
    assert!(report.repair_instructions.is_empty());
    assert_eq!(report.failure_signature, "fnv1a64:cbf29ce484222325");
    assert_eq!(report.summary, "No diagnostics; nothing to repair.");
}

#[test]
fn analyze_outcomes_normalizes_and_deduplicates_across_streams() {
    let line = "src/app.ts(1,2): error TS2304: Cannot find name 'missing'.";
    let report = analyze_outcomes(&[outcome(line, line, 1)]);
    assert_eq!(report.error_count, 1);
    assert_eq!(report.matches[0].pattern_id, "ts-2304");
    assert_eq!(report.matches[0].count, 1);

    let mut timed_out = outcome("", "partial output", 0);
    timed_out.timed_out = true;
    let report = analyze_outcomes(&[timed_out]);
    assert_eq!(report.matches[0].pattern_id, "runtime-command-timed-out");
    assert_eq!(report.primary_category, ErrorCategory::Runtime);
}
